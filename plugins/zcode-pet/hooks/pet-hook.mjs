#!/usr/bin/env node
/**
 * zcode-pet 桥接钩子：把 ZCode 会话事件翻译成桌宠引擎的工作状态。
 *
 * 事件（argv[2]）→ 引擎 API（POST /dsh-pet-7340/work-status，外部槽 `api`）：
 *   session-start  引擎没起就拉起；清空外部槽回空闲；可选投喂一句上线问候
 *   prompt-submit  thinking（收到新指令）
 *   pre-tool       working（task = 工具名 + 参数摘要）
 *   post-tool      result（整理）
 *   post-fail      error（工具执行失败；task = 工具名 + 错误摘要）
 *   permission-request / notification
 *                  waiting（task = 通知/授权内容）
 *   stop           success（本轮完成）
 *   session-end    清空外部槽回空闲（ZCode 无此事件，保留给手动/其他宿主调用）
 *
 * 铁律：绝不向 stdout/stderr 输出（不污染 ZCode）、任何失败静默退出 0、
 *       单次 HTTP 1.5s 超时、诊断只写 ~/.zcode/zcode-pet/bridge.log。
 * 端口与令牌从引擎落盘的 standalone-runtime.json 读取（引擎改端口顺延时照样可用）。
 */
import { spawn } from 'node:child_process';
import { existsSync, appendFileSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** 与引擎保持一致的 HTTP 前缀（沿用上游字面量，改动需两端同步）。 */
const PREFIX = '/dsh-pet-7340';
/** 写操作超时（毫秒）。 */
const HTTP_TIMEOUT = 1500;

const HOME =
  process.env.ZCODE_PET_HOME || process.env.DSH_HOME || join(homedir(), '.zcode');
const DATA_DIR = join(HOME, 'zcode-pet');
const RUNTIME_FILE = join(DATA_DIR, 'standalone-runtime.json');
const BRIDGE_FILE = join(DATA_DIR, 'bridge.json');
const LOG_FILE = join(DATA_DIR, 'bridge.log');

function log(message) {
  try {
    try {
      if (statSync(LOG_FILE).size > 64 * 1024) truncateSync(LOG_FILE, 0);
    } catch {
      /* 文件还不存在，直接创建 */
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.argv[2] ?? '?'}] ${message}\n`);
  } catch {
    /* 日志不可写就放弃 */
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 读取 stdin 的 hook JSON；800ms 内没结束就用已收到的部分（可能为空）。 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, 800);
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.resume();
  });
}

/** 引擎健康探测（/health 是免令牌的公共只读路径）。 */
async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 调引擎 API；写操作需要令牌（standalone 模式只放行 GET 公共读）。 */
async function api(runtime, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${runtime.port}${PREFIX}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-dsh-pet-token': runtime.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  return res.status;
}

/** 引擎进程是否还活着（Windows 没有 process.kill(pid,0) 的可靠语义，用 health 判定）。 */
async function engineAlive(runtime) {
  return Boolean(runtime && runtime.port && (await healthy(runtime.port)));
}

/** 从 bridge.json / 环境变量找引擎源码根；找不到返回 null。 */
function engineRoot(cfg) {
  const candidates = [cfg.engineRoot, process.env.ZCODE_PET_ROOT].filter(Boolean);
  for (const root of candidates) {
    if (existsSync(join(root, 'lib', 'standalone.js'))) return root;
  }
  return null;
}

/** 拉起引擎（分离进程），最多等 waitMs 毫秒直到 health 通过。 */
async function ensureEngine(cfg, waitMs) {
  let runtime = readJson(RUNTIME_FILE);
  if (await engineAlive(runtime)) return runtime;
  const root = engineRoot(cfg);
  if (!root) {
    log('引擎未运行且找不到 engineRoot（bridge.json 或 ZCODE_PET_ROOT），跳过');
    return null;
  }
  log(`拉起引擎：${root}`);
  try {
    const child = spawn(process.execPath, [join(root, 'lib', 'standalone.js')], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => log(`拉起失败：${error.message}`));
    child.unref();
  } catch (error) {
    log(`拉起异常：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    runtime = readJson(RUNTIME_FILE);
    if (await engineAlive(runtime)) return runtime;
  }
  log('引擎在时限内未就绪');
  return null;
}

/** 气泡 task 文案上限 40 码点（引擎 API 的硬限制）。 */
function cap40(text) {
  return Array.from(String(text ?? '').trim()).slice(0, 40).join('');
}

/** 工具摘要：Bash 取命令、文件类取文件名，其余用工具名。 */
function toolDigest(name, input) {
  if (!input || typeof input !== 'object') return cap40(name);
  if (typeof input.command === 'string' && input.command.trim()) {
    return cap40(`${name}: ${input.command.trim().replace(/\s+/g, ' ')}`);
  }
  const file = typeof input.file_path === 'string' ? basename(input.file_path) : '';
  return cap40(file ? `${name}: ${file}` : name);
}

/** 上线问候：取锁 → 投喂一句 → 放锁，全程尽力而为（petId 走 query，与引擎 /lock、/broadcast 口径一致）。 */
async function greet(runtime, cfg) {
  const petId = String(cfg.petId ?? 'main');
  const text = String(
    cfg.greetText ?? 'ZCode 已上线，本鱼已就位，开工吧～',
  );
  try {
    const lockRes = await fetch(
      `http://127.0.0.1:${runtime.port}${PREFIX}/lock?pet=${encodeURIComponent(petId)}&surface=desktop`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-pet-token': runtime.token },
        body: JSON.stringify({ ttl: 8000 }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT),
      },
    );
    const lock = await lockRes.json().catch(() => null);
    if (!lock?.ok || !lock.lockId) {
      log(`取锁失败：${JSON.stringify(lock)}`);
      return;
    }
    await api(
      runtime,
      'POST',
      `/broadcast?pet=${encodeURIComponent(petId)}&lock=${encodeURIComponent(lock.lockId)}&surface=desktop`,
      {
        text,
        anim: true,
        duration: 6000,
      },
    );
    await api(runtime, 'POST', `/lock/release?pet=${encodeURIComponent(petId)}`, { lockId: lock.lockId });
  } catch (error) {
    log(`问候失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const event = process.argv[2] ?? '';
  const hook = await readStdin();
  const cfg = readJson(BRIDGE_FILE) ?? {};

  let runtime = readJson(RUNTIME_FILE);
  if (!(await engineAlive(runtime))) {
    // 只有会话开始时才负责拉起引擎；中途掉线不拉（避免拖慢当次钩子）。
    if (event !== 'session-start') {
      log(`引擎未运行，忽略事件 ${event}`);
      return;
    }
    runtime = await ensureEngine(cfg, 8000);
    if (!runtime) return;
  }

  switch (event) {
    case 'session-start': {
      await api(runtime, 'DELETE', '/work-status').catch(() => {});
      if (cfg.greetOnStart !== false) await greet(runtime, cfg);
      break;
    }
    case 'prompt-submit':
      await api(runtime, 'POST', '/work-status', { state: 'thinking', task: null });
      break;
    case 'pre-tool':
      await api(runtime, 'POST', '/work-status', {
        state: 'working',
        task: toolDigest(hook.tool_name, hook.tool_input),
      });
      break;
    case 'post-tool':
      await api(runtime, 'POST', '/work-status', { state: 'result' });
      break;
    case 'post-fail':
      await api(runtime, 'POST', '/work-status', {
        state: 'error',
        task: cap40(
          (hook.tool_name ?? hook.toolName ?? '工具') +
            ' 失败: ' +
            (hook.error?.message ?? hook.error_message ?? hook.error ?? ''),
        ),
      });
      break;
    case 'permission-request':
    case 'notification':
      await api(runtime, 'POST', '/work-status', {
        state: 'waiting',
        task: cap40(hook.message ?? '等待你的确认'),
      });
      break;
    case 'stop':
      await api(runtime, 'POST', '/work-status', { state: 'success', task: null });
      break;
    case 'session-end':
      await api(runtime, 'DELETE', '/work-status').catch(() => {});
      break;
    default:
      log(`未知事件：${event}`);
  }
}

main()
  .catch((error) => log(`未捕获异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`))
  .then(() => {
    // Windows 上 process.exit 与 stdin 句柄关闭竞态会触发 libuv 断言（async.c）：
    // 先暂停 stdin，留一个 tick 让句柄收干净，再显式退出。
    try {
      process.stdin.pause();
    } catch {
      /* 忽略 */
    }
    setTimeout(() => process.exit(0), 50);
  });
