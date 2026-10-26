/**
 * dsh-cordis-probe 的宿主半侧：注册五个 mock 服务商，验证第三方注册入口与展示层。
 *
 * 三件事，缺一不可：
 * - `ctx.llm.registerConfigurableProviders(...)` —— 让它们进入设置页的「模型」目录；
 * - `ctx.llm.registerAdapter(...)` —— 注册路由，选择器里才能选中并列出模型；
 * - `petApi7340.balance.register(...)` —— 选中后能查到余额、弹出对应气泡。
 *
 * 服务商里有两个是**自定义多页气泡**（`shape: 'custom'`）：一个把内置三种形态复刻成 4 页、
 * 一个自设计 3 页，用来验证"第三方自己决定气泡长什么样 + 点击循环切页"这条能力。
 *
 * @module dsh-cordis-probe
 */
import { MOCK_BALANCE_PROVIDERS } from './mock-balance.js';
import { createMockAdapter } from './mock-adapter.js';

/** Cordis 插件名（诊断与日志里显示）。 */
export const name = 'cordis-probe';

/**
 * 依赖声明：Cordis 会等这些服务就绪后再执行 `apply`。
 * 缺少 `inject` 时 `apply` 会在服务提供之前跑，`ctx.get` 全部拿不到（已实测）。
 */
export const inject = ['llm', 'petApi7340'];

/** 模型选择器与设置页里显示的名字。 */
const DISPLAY_NAMES = {
  'mock-windows': 'Mock 三窗口额度',
  'mock-money': 'Mock 账户余额',
  'mock-points': 'Mock 积分',
  'mock-custom-kinds': 'Mock 自定义（4 页复刻三种形态）',
  'mock-custom-fancy': 'Mock 自定义（3 页复杂布局）',
};

/** 设置页里这几个 mock 服务商所属的命名空间（没有配置项，只用于渲染卡片）。 */
const SETTINGS_NS = 'llm-cordis-probe';

/**
 * 注册 mock 服务商。
 *
 * @param ctx - 宿主 Cordis 上下文；服务由 inject 保证在场，`petApi7340` 缺失时只跳过余额注册。
 */
export function apply(ctx) {
  const ids = MOCK_BALANCE_PROVIDERS.map((p) => p.id);

  // 1) 设置页的模型目录
  try {
    ctx.effect(() =>
      ctx.llm.registerConfigurableProviders(
        MOCK_BALANCE_PROVIDERS.map((p) => ({
          provider: p.id,
          displayName: DISPLAY_NAMES[p.id] ?? p.id,
          settingsNs: SETTINGS_NS,
          settingsPath: [],
        })),
      ),
    );
  } catch (e) {
    warn('模型目录', e);
  }

  // 2) 模型路由：让这些 id 能在选择器里选中，并广告一个模型
  try {
    ctx.effect(() => ctx.llm.registerAdapter(ids, createMockAdapter(DISPLAY_NAMES)));
  } catch (e) {
    warn('模型路由', e);
  }

  // 3) 余额注册表：选中之后能查到余额
  const balance = ctx.get('petApi7340', false)?.balance;
  if (!balance) return;
  for (const def of MOCK_BALANCE_PROVIDERS) {
    try {
      ctx.effect(() => balance.register(def));
    } catch (e) {
      warn('余额服务商 ' + def.id, e);
    }
  }
}

/** 注册失败不该让整个探针起不来：记一行日志即可。 */
function warn(what, e) {
  console.warn('[cordis-probe] 注册失败 ' + what + '：' + (e instanceof Error ? e.message : String(e)));
}
