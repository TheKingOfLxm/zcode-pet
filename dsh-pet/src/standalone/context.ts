/**
 * 独立模式的伪 ctx：让插件的宿主半侧在 DSH 之外运行。
 *
 * 负责补齐 apply 需要的 Cordis 语义与降级替身，路由表仍由插件宿主半侧提供；
 * 不实现窗口逻辑，HTTP 边界由 ./server 提供。
 * 必须始终成立：替身只显式失败，effect 单项失败不拖垮整个插件。
 * @module dsh-pet/src/standalone/context
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createFileLogger } from '../host/log-file';

/** 独立模式下余额路由报出的未登记服务商 id。 */
export const STANDALONE_PROVIDER = 'standalone';

/** 独立模式的日志接口，与插件对 ctx.logger 的使用面一致。 */
export interface StandaloneLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** 插件注册到 ctx.webServer 的一条路由。 */
export interface RegisteredRoute {
  /** prefix 或 exact，原样透传。 */
  kind: string;
  /** 路由路径；独立模式按它匹配，不硬编码前缀。 */
  path: string;
  /** 真实 Node HTTP handler，自行写响应头与正文。 */
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
}

/** ctx.llm 替身的契约，形状必须与 DSH 一致。 */
export interface StandaloneModelService {
  currentSelection(): { provider: string; model: string };
  listProviders(): unknown[];
  listModels(provider: string): Promise<unknown[]>;
  resolveModelInfo(provider?: string, model?: string, signal?: AbortSignal): Promise<unknown>;
  stream(options: unknown): AsyncIterable<unknown>;
  isReady(): boolean;
  canWhisper(): boolean;
  getSettings(): { whisperIntervalSec: number };
  dispose(): void;
}

/** 创建伪 ctx 的选项。 */
export interface StandaloneContextOptions {
  /** 端口或端口取值函数，用于拼桌面 Helper 的配置地址。 */
  port: number | (() => number);
  /** 日志出口。 */
  logger: StandaloneLogger;
  /** 路由收集数组；服务与 apply 共用同一个数组。 */
  routes?: RegisteredRoute[];
  /** 可选的 AI 服务，缺失时模型能力明确不可用。 */
  ai?: StandaloneModelService;
  /** 给地址附加访问凭据的包装。 */
  authenticatedUrl?: (baseUrl: string) => string;
  /**
   * 关掉整个独立模式进程的能力（桌面 Helper 托盘的「退出」）。
   *
   * 只有独立模式提供：DSH 内的桌面模式不挂这个字段，关掉整个 DSH 不该由一只宠物决定。
   */
  shutdown?: (reason: string) => void;
}

/** 伪 ctx 与它的生命周期。 */
export interface StandaloneContext {
  /** 交给 apply 的伪 ctx。 */
  ctx: Record<string, unknown>;
  /** apply 期间注册的路由，按注册顺序。 */
  routes: RegisteredRoute[];
  /** 初始化期间被记录下来的异常，每项都已打日志。 */
  failures: string[];
  /** 释放全部 effect：停桌面 Helper、清周期定时器。 */
  dispose(): Promise<void>;
}

/** 创建独立模式日志器的选项。 */
export interface StandaloneLoggerOptions {
  /** 落盘文件；不给则只写控制台。 */
  file?: string;
}

/** 创建独立模式日志器：给了文件就落盘，否则只写控制台。 */
export function createStandaloneLogger(options: StandaloneLoggerOptions = {}): StandaloneLogger {
  if (options.file) {
    // 这个 logger 会挂到伪 ctx.logger 上：插件据此复用同一个文件出口，
    // 不再自建第二个写同一文件的 logger，避免两份缓冲互相踩。
    return createFileLogger({
      file: options.file,
      base: console,
      debugEnabled: process.env.DSH_PET_LOG_DEBUG === '1',
    });
  }
  const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const write = (level: string, message: string): void => {
    console.log(`[dsh-pet-standalone ${stamp()}] ${level} ${message}`);
  };
  return {
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    debug: (message) => {
      if (process.env.DSH_PET_STANDALONE_DEBUG === '1') write('DEBUG', message);
    },
  };
}

/**
 * 创建独立模式的伪 ctx。
 * @param options - 端口、日志器与可选的路由收集数组。
 * @returns 伪 ctx、路由列表、初始化失败记录与释放函数。
 */
export function createStandaloneContext(options: StandaloneContextOptions): StandaloneContext {
  const { logger, ai } = options;
  const routes = options.routes ?? [];
  const failures: string[] = [];
  /** effect 释放函数，后注册先释放。 */
  const disposers: Array<() => unknown> = [];
  /** 通过 provide 挂出去的服务。 */
  const services = new Map<string, unknown>();
  let disposed = false;

  const portOf = (): number => (typeof options.port === 'function' ? options.port() : options.port);

  const webServer = {
    /** 读取时取值：服务先监听、端口确定后才 apply。 */
    get port(): number {
      return portOf();
    },
    register(spec: RegisteredRoute): () => void {
      routes.push({ kind: spec.kind, path: spec.path, handler: spec.handler });
      return () => {
        const index = routes.findIndex((route) => route.handler === spec.handler);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const context: Record<string, unknown> = {
    /**
     * 与 Cordis 同语义：跑一次注册函数并收集它返回的释放函数。
     * 单项失败只记录并打日志，不让整个插件起不来。
     */
    effect(fn: () => unknown): unknown {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose as () => unknown);
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        logger.error(`初始化某项失败（已跳过）：${message}`);
        return undefined;
      }
    },
    /** 对外服务注册（Cordis 的 provide 语义），返回释放函数。 */
    provide(name: string, value: unknown): () => void {
      services.set(name, value);
      return () => {
        if (services.get(name) === value) services.delete(name);
      };
    },
    /**
     * 服务查找：先查注册表，再回落到 ctx 自身的属性。
     * 独立模式把可选能力直接挂在伪 ctx 上，不回落会把本来就有的能力判成没有。
     */
    get(name: string): unknown {
      const registered = services.get(name);
      if (registered !== undefined) return registered;
      return (this as unknown as Record<string, unknown>)[name];
    },
    /** 独立模式没有 DSH 会话事件：不订阅，工作状态保持空闲。 */
    on(): () => void {
      return () => {};
    },
    logger,
    webServer,
    connection: { authenticatedUrl: options.authenticatedUrl ?? ((baseUrl: string): string => baseUrl) },
    ...(ai
      ? {
          standaloneAi: {
            isReady: () => ai.isReady(),
            canWhisper: () => ai.canWhisper(),
            whisperIntervalSec: () => ai.getSettings().whisperIntervalSec,
          },
        }
      : {}),
    // 托盘退出的能力开关：宿主路由只看这个字段在不在，停机实现由 cli.ts 提供。
    ...(options.shutdown ? { shutdownApp: options.shutdown } : {}),
    commands: { register: (): (() => void) => () => {} },
    agentDefaultModel: {
      currentSelection: (): { provider: string; model: string } =>
        ai?.currentSelection() ?? { provider: STANDALONE_PROVIDER, model: '' },
    },
    credentials: { resolve: async (): Promise<undefined> => undefined },
    llm: ai
      ? {
          listProviders: () => ai.listProviders(),
          listModels: (provider: string) => ai.listModels(provider),
          resolveModelInfo: (provider?: string, model?: string, signal?: AbortSignal) =>
            ai.resolveModelInfo(provider, model, signal),
          stream: (request: unknown) => ai.stream(request),
        }
      : {
          listProviders: (): unknown[] => [],
          listModels: async (): Promise<unknown[]> => [],
          /**
           * 模型元数据查询：契约是异步的，替身也必须返回 Promise。
           * 同步返回 undefined 时，任何 .then() 都会立刻炸。
           */
          resolveModelInfo: async (): Promise<undefined> => undefined,
          // 契约要求 AsyncIterable：写成 async 函数会让 for await 立刻抛 TypeError，
          // 且被拒的 Promise 无人接管，可能直接终止进程。
          // 不用 async function*：只抛错不 yield 会被 require-yield 拦下。
          stream: (): AsyncIterable<never> => ({
            [Symbol.asyncIterator](): AsyncIterator<never> {
              return {
                next: async (): Promise<IteratorResult<never>> => {
                  throw new Error('dsh-pet standalone: 独立模式未接入模型（碎碎念/对话不可用）');
                },
              };
            },
          }),
        },
  };

  return {
    ctx: context,
    routes,
    failures,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      ai?.dispose();
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          logger.warn(`释放某项失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
