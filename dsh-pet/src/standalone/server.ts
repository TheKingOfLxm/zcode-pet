/**
 * 独立模式的回环 HTTP 边界：静态设置页、设置读写、停机与插件路由分发。
 *
 * 不实现插件业务路由，只按前缀把请求交给 apply 注册的 handler；桌面桥请求不经过这里。
 * 依赖 ./request-security 的访问校验与 ./request-body 的正文边界。
 * 必须始终成立：只监听 127.0.0.1，任何错误响应都不回显服务商细节。
 * @module dsh-pet/src/standalone/server
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { RegisteredRoute, StandaloneLogger } from './context';
import { createRequestSecurity, rejectRequest, secureResponse } from './request-security';
import type { RequestSecurity } from './request-security';
import { boundedRequest, MAX_REQUEST_BYTES, MAX_SETTINGS_BYTES } from './request-body';
import { publicSettings, validateSettings } from './settings';
import type { StandaloneSettingsService } from './settings';
import { settingsPage, settingsScript, settingsStyle } from './settings-page';

/** 默认监听端口。 */
export const DEFAULT_STANDALONE_PORT = 3080;
/** 端口被占用时最多向后顺延的次数。 */
export const PORT_SCAN_LIMIT = 25;
/** 启动选项。 */
export interface StandaloneServerOptions {
  /** 插件注册的路由。 */
  routes: RegisteredRoute[];
  /** 日志出口。 */
  logger: StandaloneLogger;
  /** 首选端口。 */
  port?: number;
  /** 健康检查返回的状态。 */
  status?: () => unknown;
  /** 停机回调。 */
  onShutdown?: () => void;
  /** 访问校验门面。 */
  security?: RequestSecurity;
  /** 设置服务。 */
  ai?: StandaloneSettingsService;
  /** 正文读取时限，仅供超时测试覆盖。 */
  bodyTimeoutMs?: number;
}
/** 已启动的服务。 */
export interface StandaloneServer {
  /** 实际监听端口。 */
  port: number;
  /** 本次运行的访问校验门面。 */
  security: RequestSecurity;
  /** 关闭监听并断开在途连接。 */
  close(): Promise<void>;
}

/** 前缀路由匹配：exact 只比全等，prefix 允许后接子路径。 */
function matches(route: RegisteredRoute, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}
/** 回 JSON；探针允许跨域读取。 */
function sendJson(res: ServerResponse, status: number, body: unknown, cors = false): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...(cors ? { 'access-control-allow-origin': '*' } : {}),
  });
  res.end(payload);
}
/** 回静态资源，附带只允许同源脚本与样式的 CSP。 */
function sendAsset(res: ServerResponse, body: string, type: string): void {
  res.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  res.end(body);
}
/** 记录并回一个不含细节的 500。 */
function fail(res: ServerResponse, _error: unknown, logger: StandaloneLogger): void {
  // 绝不回显或记录服务商错误：其中可能有 API 密钥或带凭据的地址。
  logger.error('独立模式路由处理失败（详细内容已省略以保护凭据）');
  if (res.headersSent) res.destroy();
  else sendJson(res, 500, { error: '本机服务暂时无法处理请求' });
}

/**
 * 创建设置读写处理器（GET 读，POST 存）。
 * @param ai - 设置服务。
 * @returns 处理请求的异步函数。
 */
export function settingsHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let windowStart = Date.now();
  let count = 0;
  return async (req, res) => {
    if (!ai) {
      rejectRequest(res, 503, '本机 AI 设置尚未就绪');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, publicSettings(ai.getSettings()));
      return;
    }
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 GET 或 POST');
      return;
    }
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    count += 1;
    // 保存是重操作，按一分钟窗口限流，避免设置页反复重试打爆磁盘。
    if (count > 20) {
      rejectRequest(res, 429, '保存过于频繁，请稍后再试');
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      rejectRequest(res, 415, '请使用 JSON 保存设置');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const input = validateSettings(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      sendJson(res, 200, publicSettings(await ai.saveSettings(input)));
    } catch {
      rejectRequest(res, 400, '设置未保存：请检查接口地址、模型名称、密钥和数值范围');
    }
  };
}

/**
 * 创建连通性测试处理器（POST）。
 * @param ai - 设置服务。
 * @returns 处理请求的异步函数。
 */
export function testHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const input = bodyStr ? JSON.parse(bodyStr) : {};
      if (ai?.testConnection) {
        const result = await ai.testConnection(input);
        sendJson(res, 200, result);
      } else {
        sendJson(res, 200, { ok: false, message: '当前环境未配置测试能力' });
      }
    } catch {
      sendJson(res, 400, { ok: false, message: '请求格式无效' });
    }
  };
}

/** 组装请求分发器：先处理探针、设置页与停机，再交给插件路由。 */
function dispatch(
  options: StandaloneServerOptions,
  shutdownSecurity?: RequestSecurity,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => void {
  const settings = settingsHandler(options.ai);
  const tester = testHandler(options.ai);
  return (req, res, pathname) => {
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === '/' || pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendJson(res, 200, options.status?.() ?? { name: 'dsh-pet-standalone' }, true);
      return;
    }
    if (pathname === '/shutdown') {
      if (method !== 'POST') {
        rejectRequest(res, 405, '停机请使用 POST');
        return;
      }
      if (shutdownSecurity) {
        const supplied = req.headers['x-dsh-pet-token'];
        if (
          typeof supplied !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(shutdownSecurity.token))
        ) {
          rejectRequest(res, 403, '停机需要提供令牌');
          return;
        }
      }
      sendJson(res, 200, { ok: true, stopping: true });
      queueMicrotask(() => options.onShutdown?.());
      return;
    }
    const assets: Record<string, readonly [string, string]> = {
      '/standalone-ai/': [settingsPage, 'text/html'],
      '/standalone-ai/settings.js': [settingsScript, 'text/javascript'],
      '/standalone-ai/settings.css': [settingsStyle, 'text/css'],
    };
    const asset = assets[pathname];
    if (asset) {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendAsset(res, asset[0], asset[1]);
      return;
    }
    if (pathname === '/standalone-ai/settings') {
      void settings(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/test') {
      void tester(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    const route = options.routes.find((candidate) => matches(candidate, pathname));
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        `dsh-pet-standalone: 没有匹配的路由（已注册：${options.routes.map((item) => item.path).join(', ') || '无'}）`,
      );
      return;
    }
    try {
      void Promise.resolve(route.handler(req, res)).catch((error: unknown) => fail(res, error, options.logger));
    } catch (error) {
      fail(res, error, options.logger);
    }
  };
}

/**
 * 创建 HTTP 请求监听器。
 * @param options - 启动选项。
 * @param injectedSecurity - 注入的访问校验。
 * @returns 监听器。
 */
export function createRequestListener(
  options: StandaloneServerOptions,
  injectedSecurity?: RequestSecurity,
): (req: IncomingMessage, res: ServerResponse) => void {
  const security = options.security ?? injectedSecurity;
  const route = dispatch(options, security);
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      rejectRequest(res, 400, '请求地址无效');
      return;
    }
    secureResponse(res, pathname);
    if (security && !security.authorize(req, res)) return;
    // 不记录路径、片段、查询、正文与鉴权头，避免把令牌写进日志。
    options.logger.debug('收到本机 HTTP 请求');
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
    const bodyMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '');
    // 有正文或写方法都要先走有界读取，避免插件自己无限读。
    if ((hasBody || bodyMethod) && typeof req.on === 'function') {
      const limit = pathname === '/standalone-ai/settings' ? MAX_SETTINGS_BYTES : MAX_REQUEST_BYTES;
      void boundedRequest(req, res, limit, options.bodyTimeoutMs)
        .then((bounded) => {
          if (bounded) route(bounded, res, pathname);
        })
        .catch((error: unknown) => fail(res, error, options.logger));
    } else route(req, res, pathname);
  };
}

/** 从首选端口起逐个尝试，只接受 EADDRINUSE 后继续。 */
async function bindFirstFree(server: HttpServer, preferred: number, logger: StandaloneLogger): Promise<number> {
  for (let port = preferred; port < preferred + PORT_SCAN_LIMIT; port += 1) {
    try {
      await new Promise<void>((accept, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          accept();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      // 端口顺延时提示一次，读者才知道最终地址与请求的不同。
      if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
      return bound;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}
/**
 * 创建并启动本机服务。
 * @param options - 启动选项。
 * @returns 已监听的服务。
 * @throws 连续多个端口都被占用时抛出。
 */
export async function listenStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServer> {
  const security = options.security;
  const server = createServer(createRequestListener(options, security));
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const port = await bindFirstFree(server, options.port ?? DEFAULT_STANDALONE_PORT, options.logger);
  options.logger.info(`独立模式服务已监听 http://127.0.0.1:${port}/`);
  return {
    port,
    security: security ?? createRequestSecurity(),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
