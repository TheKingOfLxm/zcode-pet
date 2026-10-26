/**
 * 解析层：把 host 写进 /state 叶子的原始响应裁成客户端视图。
 *
 * 白名单透传——字段逐个挑选，没写进来的静默丢弃（新增字段必须在这里补上）；形状不认识或字段
 * 非法返回 null，让调用方跳过这一拍。绝不抛异常：1s 轮询里抛一次会打断整拍，其余叶子也不渲染。
 *
 * @module dsh-pet/src/shared/balance/parse
 */
import type { BalanceState, CustomTag } from './types';
/** 合法 tag：只开放排版布局需要的几个；`script`、`style`、`iframe`、`svg` 之类一律不认，非法 tag 整树作废。 */
export declare const CUSTOM_TAGS: readonly CustomTag[];
/**
 * 合法内联样式键（camelCase，与 React style 对象同形）：覆盖 flex 布局、盒模型、文字、圆角与背景。
 *
 * 刻意不含 position、zIndex、transform 与 inset：气泡悬在宠物头顶，那几样会让内容跑出气泡、
 * 盖住宠物本体或宿主页面。
 */
export declare const CUSTOM_STYLE_KEYS: ReadonlySet<string>;
/**
 * 节点树的容量上限：气泡宽度只有约 155px，且悬在宠物头顶。
 *
 * 超限分两种处理：文本截断（内容还能看）与整树作废（少画一块会得到一棵骗人的树，不如这一拍不显示）。
 */
export declare const CUSTOM_LIMITS: {
    /** 深度上限，根为 0，超出整树作废 */
    readonly maxDepth: 6;
    /** 全树节点数上限，超出整树作废 */
    readonly maxNodes: 200;
    /** 单节点子节点数上限，超出整树作废 */
    readonly maxChildren: 24;
    /** 单段文本上限，超出截断 */
    readonly maxText: 120;
    /** 单条样式值上限，超出只丢该属性 */
    readonly maxStyleValue: 64;
    /** img 地址上限，含 scheme */
    readonly maxSrc: 512;
    /** 多页页数上限：页多了点不过来，也容易撑破气泡容量 */
    readonly maxViews: 4;
};
/**
 * 把 host 的余额原始响应（`sections.balance` 叶子）转成客户端视图。
 *
 * 形状非法或 shape 不认识返回 null，消费端据此跳过这一拍；这里不抛异常，理由见模块头。
 * 取数失败不在这里发生：host 取数失败会以 `ok:false` 写进状态，这里正常映射成不可用视图。
 */
export declare function toBalanceState(raw: unknown): BalanceState | null;
