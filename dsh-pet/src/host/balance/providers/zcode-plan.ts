/**
 * ZCode BigModel 编码套餐（provider id standalone）：ZCode 部署下的余额/用量路由。
 *
 * ZCode 独立引擎的 agentDefaultModel 报告 provider id「standalone」，本 provider 借第三方
 * 注册通道（registerBalanceProvider）顶上这个 id：凭证不走向宿主 credentialRef（独立模式的
 * credentials.resolve 恒为空），而是自读本机 ZCode 的 ~/.zcode/v2/config.json，取
 * builtin:bigmodel-coding-plan 的 API Key，再查 BigModel 套餐用量接口。
 *
 * 接口 GET https://open.bigmodel.cn/api/monitor/usage/quota/limit，Authorization 直接放
 * API Key（无 Bearer 前缀）。data.limits 里按 type/unit 识别窗口：
 *   TOKENS_LIMIT + unit 3（小时×number，如 5）→ 滚动窗；TOKENS_LIMIT + unit 6（周×1）→ 周窗
 *   （智谱套餐没有月窗）；TIME_LIMIT（工具调用次数）不进 windows 展示。
 *   percentage 即已用百分比，nextResetTime 为毫秒时间戳。
 *
 * @module dsh-pet/src/host/balance/providers/zcode-plan
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { fetchWithRetry, looseNum, num, obj } from '../internal';
import type { PluginProvider, WindowsUsage } from '../types';

/** BigModel 套餐用量接口（与 ZCode 官方用量查询插件同源）。 */
const USAGE_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';

/** 依次尝试的 ZCode 配置条目：个人编码套餐在前，起步套餐兜底。 */
const PLAN_ENTRIES = ['builtin:bigmodel-coding-plan', 'builtin:bigmodel-start-plan'] as const;

/** unit=3 是小时窗（number 为小时数）；滚动窗展示名由此拼出（如 5h）。 */
const UNIT_HOUR = 3;
/** unit=6 是周窗（×1）。智谱套餐只有滚动窗与周窗，没有月窗。 */
const UNIT_WEEK = 6;

/** ZCode 的配置文件路径：ZCODE_CONFIG_FILE 覆盖，否则默认 ~/.zcode/v2/config.json。 */
function zcodeConfigFile(): string {
  if (process.env.ZCODE_CONFIG_FILE) return process.env.ZCODE_CONFIG_FILE;
  const home = process.env.ZCODE_PET_HOME || process.env.DSH_HOME || join(homedir(), '.zcode');
  return join(home, 'v2', 'config.json');
}

/** ZCode 编码套餐的连接凭据：密钥、Anthropic 兼容端点与套餐内优先级最高的模型。 */
export interface ZcodePlanCredential {
  key: string;
  baseUrl: string;
  model: string;
}

/** 套餐端点的缺省值（与 ZCode 内置 bigmodel-coding-plan 条目一致）。 */
const DEFAULT_PLAN_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
/** 配置条目没写模型表时的兜底（套餐内当前默认模型）。 */
const DEFAULT_PLAN_MODEL = 'GLM-5.3-Flash';

/**
 * 从 ZCode 配置取编码套餐凭据；取不到即抛错（显式失败，绝不伪造数字）。
 * 模型取条目 models 表里 zcode.priority 最高的一项（如 GLM-5.3-Flash 优先于 GLM-5.3）。
 */
export function resolvePlanCredential(configFile = zcodeConfigFile()): ZcodePlanCredential {
  let raw: string;
  try {
    raw = readFileSync(configFile, 'utf8');
  } catch (error) {
    throw new Error('找不到 ZCode 配置（' + configFile + '）', { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('ZCode 配置不是合法 JSON（' + configFile + '）', { cause: error });
  }
  const providers = obj((parsed as Record<string, unknown>)?.provider);
  if (!providers) throw new Error('ZCode 配置缺少 provider 段（' + configFile + '）');
  for (const id of PLAN_ENTRIES) {
    const entry = obj(providers[id]);
    const options = obj(entry?.options);
    const key = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
    if (!entry || !options || entry.enabled === false || !key) continue;
    // 模型表形如 { "GLM-5.3-Flash": { zcode: { priority: 100 } }, ... }；缺表用兜底模型。
    let model = '';
    let best = -Infinity;
    for (const [modelId, meta] of Object.entries(obj(entry.models) ?? {})) {
      const priority = looseNum(obj(obj(meta)?.zcode)?.priority) ?? 0;
      if (priority > best) {
        best = priority;
        model = modelId;
      }
    }
    return {
      key,
      baseUrl: typeof options.baseURL === 'string' && options.baseURL.trim() ? options.baseURL.trim() : DEFAULT_PLAN_BASE_URL,
      model: model || DEFAULT_PLAN_MODEL,
    };
  }
  throw new Error('ZCode 配置里没有启用的 BigModel 编码套餐 API Key（' + PLAN_ENTRIES.join(' / ') + '）');
}

/** 从 ZCode 配置取编码套餐 API Key（余额查询只需密钥）。 */
export function resolvePlanKey(configFile = zcodeConfigFile()): string {
  return resolvePlanCredential(configFile).key;
}

/** 毫秒时间戳 → ISO；非法值返回 undefined（缺重置时间按「已重置」展示，不算致命）。 */
function resetIso(value: unknown): string | undefined {
  const ms = looseNum(value);
  if (ms === undefined || ms <= 0) return undefined;
  const t = ms < 1_000_000_000_000 ? ms * 1000 : ms;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * 解析套餐用量响应的 data 段：识别滚动窗与月窗（unit 明确匹配；否则按 TOKENS_LIMIT 顺序兜底）。
 * 没有 TOKENS_LIMIT 视为响应变形并抛错；percentage 是已用百分比，原样透传（windows 口径一致）。
 */
export function parsePlanUsage(data: unknown): WindowsUsage {
  const root = obj(data);
  const limits = Array.isArray(root?.limits) ? root.limits : undefined;
  if (!limits) throw new Error('dsh-pet: bigmodel 用量响应缺少 limits');

  const tokenLimits: { unit: number; number: number; percentage: number; resetsAt?: string }[] = [];
  for (const item of limits) {
    const l = obj(item);
    if (!l || l.type !== 'TOKENS_LIMIT') continue;
    const percentage = num(l.percentage, 'percentage');
    const unit = looseNum(l.unit);
    const count = looseNum(l.number);
    if (unit === undefined || count === undefined) {
      // 无 unit/number 的 TOKENS_LIMIT：只有一个时按滚动窗兜底，多个则顺序兜底
      tokenLimits.push({ unit: -1, number: 1, percentage, resetsAt: resetIso(l.nextResetTime) });
      continue;
    }
    tokenLimits.push({ unit, number: count, percentage, resetsAt: resetIso(l.nextResetTime) });
  }
  if (tokenLimits.length === 0) throw new Error('dsh-pet: bigmodel 用量响应没有 TOKENS_LIMIT 窗口');

  const byUnit = (unit: number): (typeof tokenLimits)[number] | undefined =>
    tokenLimits.find((l) => l.unit === unit);
  const rolling = byUnit(UNIT_HOUR) ?? tokenLimits[0];
  // 智谱套餐没有月窗：第二条 TOKENS_LIMIT 是周窗（unit 6 × 1 周）。数据放进 monthly 槽
  // （parse 的必填底线），并以 monthlyLabel 标「周」，避免气泡出现假「月」行。
  const weeklyCandidate = byUnit(UNIT_WEEK) ?? tokenLimits.find((l) => l !== rolling);
  const weekly = weeklyCandidate && weeklyCandidate !== rolling ? weeklyCandidate : undefined;

  const usage: WindowsUsage = {
    monthly: (weekly ?? rolling).percentage,
    monthlyLabel: weekly ? '周' : rolling.unit === UNIT_HOUR ? `${rolling.number}h` : undefined,
    monthlyResetsAt: (weekly ?? rolling).resetsAt,
    rolling: rolling.percentage,
    rollingLabel: rolling.unit === UNIT_HOUR ? `${rolling.number}h` : undefined,
    rollingResetsAt: rolling.resetsAt,
  };
  return usage;
}

/** ZCode BigModel 编码套餐的第三方注册定义：id 必须与独立引擎上报的「standalone」一致。 */
export const zcodePlanProvider: PluginProvider = {
  id: 'standalone',
  async fetch({ provider }) {
    const key = resolvePlanKey();
    const res = await fetchWithRetry(USAGE_URL, key, { Authorization: key, 'Accept-Language': 'en-US,en' });
    if (!res.ok) throw new Error('bigmodel usage HTTP ' + res.status);
    const body: unknown = await res.json();
    const root = obj(body);
    if (!root || root.success !== true) {
      const msg = obj(root)?.msg;
      throw new Error('bigmodel 用量接口返回失败' + (typeof msg === 'string' && msg ? '：' + msg : ''));
    }
    return { ok: true, provider, shape: 'windows', data: parsePlanUsage(root.data) };
  },
};
