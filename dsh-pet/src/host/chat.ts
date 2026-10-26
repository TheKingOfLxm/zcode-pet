/**
 * 对话生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）生成一句回复。
 *
 * 负责把历史记忆、用户输入与人设拼成一次生成请求，并解析可选的配图标记。
 * 不负责记忆读写与落盘，也不负责写气泡——那些在路由层与两端消费侧。
 * 依赖 ctx.llm、agentDefaultModel（与碎碎念同源）与调用方给的表情包池。
 * 始终成立：候选模型失败要显式回落并留痕；生成失败返回结构化原因，不伪造文案。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/chat
 */

import { BlockAssembler, createAssistantMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { PET_CALL_IDENTITY, noTextReason } from './llm-call';
import { supportsReasoningOff } from './llm-reasoning';
import { defaultLog } from './log-file';
import { extractChatImage, memeCatalog, type MemeEntry } from './memes';
import { modelCandidates, modelLabel, type ModelRef } from './model-selection';

/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构）。 */
export type ChatGenerateResult =
  | { ok: true; text: string; image?: string }
  | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 记忆中的一条消息（与 shared/chat.ts 的 ChatMessage 同构）。 */
export interface ChatMemoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够。 */
const TIMEOUT_MS = 60_000;

/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守）。
 *  交给模型选而不是随机抽：对话有真实上下文（用户输入 + 历史），按语境挑才贴合。 */
function imageInstruction(pool: MemeEntry[]): string {
  return (
    '\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n' +
    memeCatalog(pool) +
    '\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。'
  );
}

/**
 * 生成一句对话回复。
 * @param ctx - 宿主上下文（注入 agentDefaultModel / llm）。
 * @param system - 人设提示词（whisperPrompt，与碎碎念共用同一人设）。
 * @param history - 最近记忆（按时间正序，user / assistant 交替）。
 * @param userText - 用户刚输入的话。
 * @param pool - 表情包候选池；空 / 缺省 = 纯文本（指令与解析都不介入）。
 * @param preferred - 条目单独指定的模型（chatModel）；缺省 / 留空 = 只用当前对话的模型。
 * @returns 回复文本（+ 命中池内的配图名），或结构化失败（provider 缺失 / 生成错误）。
 */
export async function generateChat(
  ctx: { agentDefaultModel: { currentSelection(): { provider: string; model: string } }; llm?: unknown },
  system: string,
  history: ChatMemoryMessage[],
  userText: string,
  pool: MemeEntry[] = [],
  preferred?: ModelRef,
): Promise<ChatGenerateResult> {
  // 候选链：配置的模型优先 → 当前对话的模型兜底（chatModel 留空时链上只有后者）
  const candidates = modelCandidates(ctx, preferred);
  if (candidates.length === 0) {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  const llm = (ctx as { llm?: { stream(o: unknown): AsyncIterable<unknown> } }).llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'generate-error', message: 'LLM 服务不可用' };
  }
  // 依次尝试：配置的模型失败（凭据被删 / 模型下架 / 该服务商没配 key）时回落到当前对话的模型
  // 重试一次——那才是用户当前真正在用的模型，报错更有意义。
  // 兜底文案与失败分支同源，避免两处字面量漂移
  let last: ChatGenerateResult = { ok: false, reason: 'generate-error', message: noTextReason(undefined) };
  for (const [i, sel] of candidates.entries()) {
    const result = await generateWith(ctx, llm, sel, system, history, userText, pool);
    if (result.ok) return result;
    last = result;
    // 回落要留痕：配的模型没生效时能在日志里看到原因（否则「我明明配了 A，怎么还是用 B」没法查）
    if (i + 1 < candidates.length) {
      defaultLog(
        'warn',
        `dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`,
      );
    }
  }
  return last;
}

/** 用一个确定的 provider/model 跑一次对话生成（候选链的一环；失败原样返回结构化原因，不吞）。 */
async function generateWith(
  ctx: { llm?: unknown },
  llm: { stream(o: unknown): AsyncIterable<unknown> },
  sel: ModelRef,
  system: string,
  history: ChatMemoryMessage[],
  userText: string,
  pool: MemeEntry[],
): Promise<ChatGenerateResult> {
  // 历史 → dsh-llm 消息：user 经 createUserMessage（plugin 来源），assistant 经 createAssistantMessage
  // （provider/model 只是消息的角色载体，不涉及适配器回放）
  const historyMessages = history.map((m) =>
    m.role === 'user'
      ? createUserMessage({
          content: [{ type: 'text', text: m.content }],
          source: { kind: 'user' },
        })
      : createAssistantMessage({
          content: [{ type: 'text', text: m.content }],
          source: { provider: sel.provider, model: sel.model },
        }),
  );

  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  // 仅当模型声明支持 reasoning effort（含 "off"）时才传，否则省略：
  // 无 reasoning 元数据的模型显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT，
  // 折叠成空流（表现为「模型未返回文本」）。
  const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
  // 配图：池非空才把清单与指令附进 user 正文（空池 = 关闭配图）
  const wantImage = pool.length > 0;
  const options = {
    provider: sel.provider,
    model: sel.model,
    // 调用身份（见 llm-call.ts）：缺它时 opencode-go 回 400
    sessionId: PET_CALL_IDENTITY,
    messages: [
      ...historyMessages,
      createUserMessage({
        content: [{ type: 'text', text: wantImage ? userText + imageInstruction(pool) : userText }],
        source: { kind: 'user' },
      }),
    ],
    system,
    // 不显式限 maxTokens：与碎碎念同因——推理模型把思考计入预算，显式小上限会截断正文；
    // 不传由 dsh-llm 按适配器 defaultMaxTokens 兜底，对话短回复输出仍短。
    temperature: 1,
    // 统一关闭深度思考：闲聊对话不需要推理（与碎碎念同一约束；仅模型声明支持时传）
    ...(supportsOff ? { reasoningEffort: ReasoningEffortId('off') } : {}),
    signal: deadline,
  };

  const assembler = new BlockAssembler();
  try {
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk as Parameters<BlockAssembler['push']>[0]);
    }
  } catch (e) {
    return {
      ok: false,
      reason: 'generate-error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const text = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? (b as { text: string }).text : ''))
    .join('')
    .trim();
  if (!text) return { ok: false, reason: 'generate-error', message: noTextReason(assembler.finish) };
  // 配图解析：命中池内才采纳并剥离标记；未选 / 幻觉名称 → 原样返回纯文本
  if (!wantImage) return { ok: true, text };
  const picked = extractChatImage(text, pool);
  return picked.image ? { ok: true, text: picked.text, image: picked.image } : { ok: true, text: picked.text };
}
