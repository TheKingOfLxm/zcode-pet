/**
 * 独立模式的 AI 服务：把成品配置、请求校验、限流与 SDK 流式调用组装成门面。
 *
 * 对外形状对齐宿主侧的 ctx.llm 与 agentDefaultModel，供插件路由无差别调用；
 * 不负责设置持久化（见 ai-config），也不负责协议细节与鉴权头（见 ai-transport）。
 * 必须始终成立：只有成品配置完整且未被暂停时才发起请求；对外只抛固定文案的错误。
 * @module dsh-pet/src/standalone/ai-provider
 */
import { z } from 'zod';
import type { StandaloneLogger } from './context';
import { createAiConfig } from './ai-config';
import type { StandaloneAiPublicSettings } from './ai-config';
import { isAuthenticationFailure, isRateLimitFailure, sdkTextStream } from './ai-transport';
import type { AiFetch, AiRequest, AiTransportEvent } from './ai-transport';

/** 伪 ctx 与模型选择器里的服务商标识。 */
const PROVIDER = 'standalone';
/** 单次输入的总字符上限。 */
const MAX_INPUT_CHARS = 32_768;
/** 单次输出的总字符上限。 */
const MAX_OUTPUT_CHARS = 16_384;
/** 单次响应的流事件上限。 */
const MAX_EVENTS = 4096;
/** 每分钟允许的请求数。 */
const REQUESTS_PER_MINUTE = 6;
/** 限流窗口长度，单位毫秒。 */
const RATE_WINDOW_MS = 60_000;
/** 文本块契约。 */
const textBlock = z.object({ type: z.literal('text'), text: z.string().max(MAX_INPUT_CHARS) });
/** 消息契约：只保留角色与受限内容。 */
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(MAX_INPUT_CHARS), z.array(z.unknown()).max(128)]),
});
/** 请求契约：服务商固定，模型必须与当前选择一致。 */
const inputSchema = z.object({
  provider: z.literal(PROVIDER),
  model: z.string().max(200),
  system: z.string().max(MAX_INPUT_CHARS).optional(),
  messages: z.array(messageSchema).min(1).max(64),
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
});

/** 独立模式 AI 服务的对外形状。 */
export interface StandaloneAiService {
  /** 当前选中的服务商与模型；未就绪时模型为空。 */
  currentSelection(): { provider: string; model: string };
  /** 就绪时返回唯一的 standalone 服务商。 */
  listProviders(): Array<{ id: string; name: string }>;
  /** 就绪时返回当前模型，否则为空。 */
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  /** 校验请求的模型是否就是当前配置的那个。 */
  resolveModelInfo(
    provider?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<undefined | { id: string; name: string }>;
  /** 以异步序列返回文本增量。 */
  stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }>;
  /** 取脱敏后的当前设置。 */
  getSettings(): StandaloneAiPublicSettings;
  /** 校验并保存设置，成功后解除认证失败造成的暂停。 */
  saveSettings(input: unknown): Promise<StandaloneAiPublicSettings>;
  /** 用一次最小请求验证地址、模型与密钥。 */
  testConnection(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string; reply?: string }>;
  /** 是否满足发起请求的全部条件。 */
  isReady(): boolean;
  /** 是否允许按间隔自动碎碎念。 */
  canWhisper(): boolean;
  /** 终止在途请求并释放服务。 */
  dispose(): void;
}
/** 可注入的传输与时钟，仅供测试替换；生产使用官方 SDK 与真实时间。 */
export interface StandaloneAiDependencies {
  /** 替换 fetch 以隔离网络。 */
  fetch?: AiFetch;
  /** 替换时钟以控制限流窗口。 */
  now?: () => number;
}

/**
 * 把调用方输入收敛为纯文本消息。
 * @param options - 调用方请求。
 * @param model - 当前选中的模型。
 * @returns 规范化请求与可选的取消信号。
 * @throws 输入越界、角色顺序不合法或模型不匹配时抛出。
 */
function parseRequest(options: unknown, model: string): { request: AiRequest; signal?: AbortSignal } {
  const parsed = inputSchema.safeParse(options);
  if (!parsed.success || parsed.data.model !== model)
    throw new Error('Invalid standalone AI model selection or input.');
  const { data } = parsed;
  const messages = data.messages
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => {
                // 非文本块与 DSH 来源元数据不进入请求：服务商只该看到文本。
                if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text')
                  return '';
                const result = textBlock.safeParse(block);
                if (!result.success) throw new Error('Invalid standalone AI text input.');
                return result.data.text;
              })
              .join(''),
    }))
    .filter((message) => message.content.trim().length > 0);
  const system = data.system ?? '';
  const size = system.length + messages.reduce((sum, message) => sum + message.content.length, 0);
  if (
    size > MAX_INPUT_CHARS ||
    messages.length === 0 ||
    messages[0].role !== 'user' ||
    messages[messages.length - 1]?.role !== 'user'
  ) {
    throw new Error('Standalone AI input is empty or exceeds limits.');
  }
  return { request: { system, messages }, signal: data.signal };
}

/** 让等待中的读取也能响应取消。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Standalone AI request cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Standalone AI request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * 创建独立模式 AI 服务。
 * @param home - DSH_HOME。
 * @param logger - 日志出口。
 * @param dependencies - 测试注入的传输与时钟。
 * @returns AI 服务。
 * @throws 设置无法安全读取时抛出。
 */
export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: ReturnType<typeof createAiConfig>;
  try {
    store = createAiConfig(home);
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // 持久化损坏或权限不安全时不能顺势启用环境里的旧凭据，宁可整体失败。
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? Date.now;
  let disposed = false;
  let paused = false;
  let saving = false;
  let requests: ReadonlyArray<number> = [];
  let active: AbortController | undefined;
  const ready = () =>
    !disposed &&
    !paused &&
    !saving &&
    store.current().enabled &&
    !!store.current().model &&
    !!store.current().baseUrl &&
    !!store.current().apiKey;
  const selection = () => ({ provider: PROVIDER, model: ready() ? store.current().model : '' });

  async function* stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }> {
    if (!ready()) throw new Error('Standalone AI is not ready. Configure and enable the model first.');
    const settings = store.current();
    const { request, signal: callerSignal } = parseRequest(options, settings.model);
    if (callerSignal?.aborted) throw new Error('Standalone AI request cancelled.');
    if (active) throw new Error('Standalone AI is busy. Please wait.');
    const recent = requests.filter((time) => now() - time < RATE_WINDOW_MS);
    if (recent.length >= REQUESTS_PER_MINUTE) throw new Error('Standalone AI rate limit reached. Please wait.');
    requests = [...recent, now()];
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const iterator = sdkTextStream(settings, request, controller.signal, fetcher)[Symbol.asyncIterator]();
    let emitted = 0;
    let events = 0;
    try {
      while (true) {
        const part: IteratorResult<AiTransportEvent> = await abortable(iterator.next(), controller.signal);
        // 流式过程中设置可能被保存、服务也可能被释放，每次都重新确认。
        if (controller.signal.aborted || !ready()) throw new Error('Standalone AI request cancelled.');
        if (part.done) break;
        // 事件数也要有上限，防止对端用大量空块拖住进程。
        if (++events > MAX_EVENTS) throw new Error('Standalone AI response exceeds limits.');
        if (part.value.refusal) throw new Error('Standalone AI could not answer this request.');
        const text = part.value.text;
        if (!text) continue;
        emitted += text.length;
        if (emitted > MAX_OUTPUT_CHARS) throw new Error('Standalone AI response exceeds limits.');
        yield { type: 'text', text };
      }
      if (emitted === 0) throw new Error('Standalone AI returned no text.');
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        paused = true;
        logger.warn('Standalone AI authentication failed; save settings again to resume.');
        throw new Error('Standalone AI authentication failed. Check credentials and save settings again.', {
          cause: error,
        });
      }
      if (controller.signal.aborted) {
        throw new Error('Standalone AI request cancelled or timed out.', { cause: error });
      }
      if (isRateLimitFailure(error)) {
        throw new Error('Standalone AI provider rate limit reached. Please wait.', { cause: error });
      }
      // 只放行本层写的固定文案；SDK 错误可能带地址、请求头或正文。
      if (
        error instanceof Error &&
        [
          'Standalone AI could not answer this request.',
          'Standalone AI returned no text.',
          'Standalone AI response exceeds limits.',
        ].includes(error.message)
      )
        throw error;
      logger.warn('Standalone AI request failed.');
      throw new Error('Standalone AI request failed. Check the endpoint and model settings.', { cause: error });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      controller.abort();
      if (active === controller) active = undefined;
      // return() 可能等待挂起的读取；只观察结果，绝不阻塞取消。
      void iterator.return?.().catch(() => logger.debug('Standalone AI transport closed.'));
    }
  }

  return {
    currentSelection: selection,
    listProviders: () => (ready() ? [{ id: PROVIDER, name: 'Standalone AI' }] : []),
    listModels: async (provider) =>
      ready() && provider === PROVIDER ? [{ id: settingsModel(), name: settingsModel() }] : [],
    resolveModelInfo: async (provider = PROVIDER, model = settingsModel(), signal) =>
      ready() && !signal?.aborted && provider === PROVIDER && model === settingsModel()
        ? { id: model, name: model }
        : undefined,
    stream,
    getSettings: () => store.publicSettings(),
    async saveSettings(input) {
      if (disposed) throw new Error('Standalone AI is disposed.');
      if (saving) throw new Error('Standalone AI settings are being saved.');
      saving = true;
      // 保存期间先中止在途请求，避免旧设置继续产生输出。
      active?.abort();
      try {
        const result = await store.save(input);
        if (!disposed) paused = false;
        return result;
      } catch (error) {
        paused = true;
        throw error;
      } finally {
        saving = false;
      }
    },
    isReady: ready,
    async testConnection(input: { protocol?: string; baseUrl?: string; model?: string; apiKey?: string }) {
      if (disposed) return { ok: false, message: '服务已关闭' };
      const current = store.current();
      const protocol = input.protocol === 'anthropic' ? 'anthropic' : (input.protocol ?? current.protocol);
      const baseUrl = (input.baseUrl !== undefined ? input.baseUrl : current.baseUrl).trim();
      const model = (input.model !== undefined ? input.model : current.model).trim();
      const apiKey = (input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : current.apiKey).trim();

      if (!baseUrl) {
        return { ok: false, message: '请先填写接口地址（Base URL）' };
      }
      if (!model) {
        return { ok: false, message: '请先填写模型名称' };
      }
      if (!apiKey) {
        return { ok: false, message: '请先填写 API 密钥' };
      }

      const testSettings = {
        protocol: protocol as 'openai-compatible' | 'anthropic',
        baseUrl,
        model,
        apiKey,
        enabled: true,
        automaticWhispers: false,
        whisperIntervalSec: 300,
        maxTokens: 32,
        timeoutMs: 15_000,
      };

      const controller = new AbortController();
      // 测试连接不复用正式通道：不污染限流、忙状态与暂停标记。
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const testStream = sdkTextStream(
          testSettings,
          { system: '', messages: [{ role: 'user', content: 'hi' }] },
          controller.signal,
          fetcher,
        );
        let reply = '';
        for await (const chunk of testStream) {
          if (chunk.refusal) {
            return { ok: false, message: '模型拒绝回答该测试请求' };
          }
          if (chunk.text) {
            reply += chunk.text;
            if (reply.length >= 40) break;
          }
        }
        if (!reply.trim()) {
          return { ok: true, message: '连接成功！接口已成功响应。', reply: '(模型返回了空白内容)' };
        }
        return { ok: true, message: '连接成功！模型响应正常。', reply: reply.trim() };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, message: '连接超时（15 秒未响应）：请检查网络连通性或服务器状态' };
        }
        if (isAuthenticationFailure(error)) {
          return { ok: false, message: '身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确' };
        }
        if (isRateLimitFailure(error)) {
          return { ok: false, message: '请求受限或配额超限 (HTTP 429)：请检查 API 账户余额或调用频率' };
        }
        const rawMsg = error instanceof Error ? error.message : String(error);
        if (rawMsg.includes('404')) {
          return { ok: false, message: '接口路径或模型不存在 (HTTP 404)：请检查接口地址（通常以 /v1 结尾）与模型名称' };
        }
        if (rawMsg.includes('ECONNREFUSED') || rawMsg.includes('fetch failed')) {
          return { ok: false, message: '无法连接到目标服务器：请检查地址与端口是否正确、服务器是否正在运行' };
        }
        return { ok: false, message: `连接失败：${rawMsg}` };
      } finally {
        clearTimeout(timer);
      }
    },
    canWhisper: () => ready() && store.current().automaticWhispers,
    dispose() {
      disposed = true;
      active?.abort();
    },
  };
  function settingsModel(): string {
    return store.current().model;
  }
}
