/**
 * 五个 mock 余额服务商：三种内置形态（windows / money / points）+ 两种**自定义多页**（custom）。
 * 只验证展示层与第三方注册入口，不发任何网络请求。
 *
 * 自定义形态的要点（这是本文件后两个 provider 的意义）：
 * - 气泡内容是一棵**节点树**（tag + camelCase 内联样式 + 文本/子节点），由插件端白名单校验、
 *   两端渲染器按树画；第三方想怎么排就怎么排，不必等插件为某个服务商加一种形态；
 * - `views` 的第 1 项是初始页，**点击气泡循环切页**（末页回第一页）；只有一页时不可点；
 * - 尺寸一律用 `em`：相对气泡字号，宠物调大字号时会跟着缩放（写死 px 就不会跟）。
 *
 * @module dsh-cordis-probe/mock-balance
 */

/** 相对当前时间的时间戳（ISO）：保证气泡里的「N 小时/天重置」每次都是未来时间。 */
const inHours = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

// ---- 画布局用的小工具（自定义气泡的节点树是纯数据，几个原语就够拼出任意排版） ----

/** 主文字色 / 次要文字色 / 底槽色（与 dsh-pet 气泡主题同一套取值）。 */
const INK = '#1f1f1f';
const MUTED = 'rgba(43,43,43,.6)';
const TRACK = 'rgba(43,43,43,.12)';

/** 一段文本节点；style 可覆盖字号/颜色/字重（空对象会在解析层被丢掉，不会留下空 style）。 */
const text = (value, style = {}) => ({ tag: 'span', text: value, style });

/** 一行（flex，默认两端对齐）。 */
const row = (children, style = {}) => ({ tag: 'div', style: { display: 'flex', ...style }, children });

/** 进度条：外框 + 内条，内条宽度 = 已用百分比（夹到 0-100）。 */
const bar = (percent, color) => ({
  tag: 'div',
  style: { flex: '1 1 auto', height: '0.28em', borderRadius: '0.14em', background: TRACK, overflow: 'hidden' },
  children: [
    {
      tag: 'i',
      style: {
        display: 'block',
        height: '100%',
        width: Math.max(0, Math.min(100, percent)) + '%',
        background: color,
      },
    },
  ],
});

/** 角标（如 PRO）：小字 + 细边框。 */
const badge = (label) => text(label, { fontSize: '0.6em', color: '#2e9e4f', border: '1px solid rgba(46,158,79,.5)', borderRadius: '0.25em', padding: '0 0.2em' });

/** 汇总行：名称 + 迷你条 + 百分比（自定义形态第 4 页用）。 */
const summaryRow = (name, percent, color) =>
  row(
    [
      text(name, { width: '2.4em', color: MUTED, fontSize: '0.77em', whiteSpace: 'nowrap' }),
      bar(percent, color),
      text(percent + '%', { width: '2.6em', textAlign: 'right', fontSize: '0.77em', color: MUTED }),
    ],
    { alignItems: 'center', gap: '0.3em' },
  );

/** 模型余量行：模型名 + 条 + 百分比 + 剩余（自定义形态第 1 页用）。 */
const modelRow = (name, percent, left, color) =>
  row(
    [
      text(name, { width: '4.6em', color: INK, fontSize: '0.85em', whiteSpace: 'nowrap' }),
      bar(percent, color),
      text(percent + '%', { width: '2.4em', textAlign: 'right', color: INK, fontSize: '0.8em', fontWeight: '650' }),
      text(left, { width: '3.6em', textAlign: 'right', color: MUTED, fontSize: '0.72em', whiteSpace: 'nowrap' }),
    ],
    { alignItems: 'center', gap: '0.25em', padding: '0.08em 0' },
  );

/** 钱包分类列：上方名称、下方金额（自定义形态第 2 页用）。 */
const walletColumn = (name, value, color) => ({
  tag: 'div',
  style: { display: 'flex', flexDirection: 'column', gap: '0.05em' },
  children: [text(name, { fontSize: '0.72em', color: MUTED }), text(value, { fontSize: '1.05em', fontWeight: '650', color })],
});

/** 统计格：名称 + 数值，带细边框（自定义形态第 3 页用）。 */
const statCell = (name, value, color) => ({
  tag: 'div',
  style: {
    flex: '1 1 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.05em',
    padding: '0.15em 0',
    border: '1px solid rgba(43,43,43,.12)',
    borderRadius: '0.3em',
  },
  children: [text(name, { fontSize: '0.68em', color: MUTED }), text(value, { fontSize: '0.95em', fontWeight: '650', color })],
});

// ---- 三种内置形态（原样保留：它们验证"行数据"这条通道） ----

/** 三窗口用量：滚动 31% / 周 8% / 月 72%，最紧迫的是月窗口。 */
export const mockWindows = {
  id: 'mock-windows',
  async fetch({ provider }) {
    return {
      ok: true,
      provider,
      shape: 'windows',
      data: {
        rolling: 31,
        weekly: 8,
        monthly: 72,
        rollingCapUsd: 12,
        weeklyCapUsd: 30,
        monthlyCapUsd: 60,
        rollingLabel: '5h',
        rollingResetsAt: inHours(3),
        weeklyResetsAt: inHours(50),
        monthlyResetsAt: inHours(300),
      },
    };
  },
};

/** 双币种余额 + 峰谷装饰：CNY 有余、USD 少量。 */
export const mockMoney = {
  id: 'mock-money',
  async fetch({ provider }) {
    return {
      ok: true,
      provider,
      shape: 'money',
      data: {
        wallets: [
          { currency: 'CNY', total: '8.79', granted: '1.00', toppedUp: '7.79', fullBalance: '20' },
          { currency: 'USD', total: '2.40', granted: '0.00', toppedUp: '2.40', fullBalance: '5' },
        ],
        tier: 'peak',
      },
    };
  },
};

/** 积分余额：800 / 1000（基准由数据带出，驱动档位）。 */
export const mockPoints = {
  id: 'mock-points',
  async fetch({ provider }) {
    return {
      ok: true,
      provider,
      shape: 'points',
      data: { unit: '积分', total: '800', full: '1000' },
    };
  },
};

// ---- 自定义形态 ①：把已有三种形态用节点树复刻成 4 页（第 4 页是三者汇总） ----
//
// 意义：证明"第三方用 custom 能自己排出内置形态的等价物"，而不必等插件加形态。

/** 第 1 页：windows 的等价物 —— 最紧迫窗口 + 进度条 + 重置倒计时。 */
const kindsPageWindows = {
  tag: 'div',
  children: [
    row([text('月额度已用', { color: MUTED, fontSize: '0.85em' }), text('72%', { color: INK, fontWeight: '650' })], {
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: '0.3em',
    }),
    row([bar(72, '#e8952f'), text('12.5 天重置', { color: MUTED, fontSize: '0.77em', whiteSpace: 'nowrap' })], {
      alignItems: 'center',
      gap: '0.3em',
      marginTop: '0.15em',
    }),
  ],
};

/** 第 2 页：money 的等价物 —— 「余额（峰）¥8.79/$2.40」三段混排 + 储值/赠送副行。 */
const kindsPageMoney = {
  tag: 'div',
  children: [
    row(
      [
        text('余额（', { color: MUTED }),
        text('峰', { color: '#e53935', fontWeight: '700' }),
        text('）¥8.79/$2.40', { color: INK, fontWeight: '650' }),
      ],
      { alignItems: 'baseline', flexWrap: 'wrap', gap: '0.1em' },
    ),
    { tag: 'div', style: { fontSize: '0.77em', color: MUTED, marginTop: '0.1em' }, text: '储值 7.79 · 赠送 1.00' },
  ],
};

/** 第 3 页：points 的等价物 —— 「积分 800 / 1000」+ 按基准折算的进度条。 */
const kindsPagePoints = {
  tag: 'div',
  children: [
    row([text('积分', { color: MUTED, fontSize: '0.85em' }), text('800 / 1000', { color: INK, fontWeight: '650' })], {
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: '0.3em',
    }),
    row([bar(80, '#2e9e4f')], { alignItems: 'center', marginTop: '0.15em' }),
  ],
};

/** 第 4 页：三者汇总 —— 一页里塞三条不同口径的进度条（内置形态做不到这种混排）。 */
const kindsPageSummary = {
  tag: 'div',
  style: { display: 'flex', flexDirection: 'column', gap: '0.18em' },
  children: [
    summaryRow('额度', 72, '#e8952f'),
    summaryRow('余额', 56, '#2e9e4f'),
    summaryRow('积分', 80, '#3b7ddd'),
  ],
};

/** 4 页自定义：三种内置形态各复刻一页 + 一页汇总。percent 驱动档位动画（月窗口 72%）。 */
export const mockCustomKinds = {
  id: 'mock-custom-kinds',
  async fetch({ provider }) {
    return {
      ok: true,
      provider,
      shape: 'custom',
      data: {
        views: [kindsPageWindows, kindsPageMoney, kindsPagePoints, kindsPageSummary],
        percent: 72,
      },
    };
  },
};

// ---- 自定义形态 ②：完全自设计的 3 页（多模型余量 / 钱包构成 / 用量统计） ----
//
// 意义：内置三种形态装不下的结构（多行、多列、角标、分隔线、统计格）在这里一次表达完。

/** 第 1 页：多模型余量 —— 三行，各自一条按模型额度算的进度条。 */
const fancyPageModels = {
  tag: 'div',
  style: { display: 'flex', flexDirection: 'column', gap: '0.1em' },
  children: [
    modelRow('GPT-5', 78, '余 22%', '#e53935'),
    modelRow('Claude', 41, '余 59%', '#e8952f'),
    modelRow('本地网关', 12, '余 88%', '#2e9e4f'),
  ],
};

/** 第 2 页：钱包构成 —— 标题 + PRO 角标 + 分隔线 + 储值/赠送两列 + 底部小字。 */
const fancyPageWallet = {
  tag: 'div',
  children: [
    row(
      [text('钱包构成', { color: INK, fontSize: '0.9em', fontWeight: '650' }), badge('PRO')],
      { justifyContent: 'space-between', alignItems: 'center' },
    ),
    { tag: 'div', style: { height: '1px', background: TRACK, margin: '0.15em 0' } },
    {
      tag: 'div',
      style: { display: 'flex', gap: '0.6em' },
      children: [walletColumn('储值', '¥7.79', INK), walletColumn('赠送', '¥1.00', '#2e9e4f')],
    },
    { tag: 'div', style: { fontSize: '0.72em', color: MUTED, marginTop: '0.15em' }, text: '总额 ¥8.79 · 基准 ¥20.00' },
  ],
};

/** 第 3 页：用量统计 —— 三个带边框的统计格 + 页脚提示（提示页是可循环的）。 */
const fancyPageStats = {
  tag: 'div',
  children: [
    row([text('用量统计', { color: INK, fontSize: '0.9em', fontWeight: '650' }), text('近 30 天', { color: MUTED, fontSize: '0.7em' })], {
      justifyContent: 'space-between',
      alignItems: 'center',
    }),
    {
      tag: 'div',
      style: { display: 'flex', gap: '0.3em', marginTop: '0.15em' },
      children: [statCell('今日', '128', INK), statCell('本月', '3,204', INK), statCell('限额', '5,000', '#e8952f')],
    },
    { tag: 'div', style: { fontSize: '0.7em', color: MUTED, marginTop: '0.2em', textAlign: 'center' }, text: '点一下回到第一页' },
  ],
};

/** 3 页自定义：结构最复杂的一组，用来压"任意布局"这条能力。percent 驱动档位动画（余额已用 65%）。 */
export const mockCustomFancy = {
  id: 'mock-custom-fancy',
  async fetch({ provider }) {
    return {
      ok: true,
      provider,
      shape: 'custom',
      data: {
        views: [fancyPageModels, fancyPageWallet, fancyPageStats],
        percent: 65,
      },
    };
  },
};

/** 注册顺序即 id 顺序；三种内置形态各一个 + 两个自定义多页。 */
export const MOCK_BALANCE_PROVIDERS = [mockWindows, mockMoney, mockPoints, mockCustomKinds, mockCustomFancy];
