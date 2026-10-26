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
import { type MemeEntry } from './memes';
import { type ModelRef } from './model-selection';
/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构）。 */
export type ChatGenerateResult = {
    ok: true;
    text: string;
    image?: string;
} | {
    ok: false;
    reason: 'provider-missing' | 'generate-error';
    message?: string;
};
/** 记忆中的一条消息（与 shared/chat.ts 的 ChatMessage 同构）。 */
export interface ChatMemoryMessage {
    role: 'user' | 'assistant';
    content: string;
    ts: number;
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
export declare function generateChat(ctx: {
    agentDefaultModel: {
        currentSelection(): {
            provider: string;
            model: string;
        };
    };
    llm?: unknown;
}, system: string, history: ChatMemoryMessage[], userText: string, pool?: MemeEntry[], preferred?: ModelRef): Promise<ChatGenerateResult>;
