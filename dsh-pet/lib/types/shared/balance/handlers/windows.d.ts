/**
 * windows 形态：三窗口用量的百分比口径、气泡文案与最紧迫窗口判定。
 *
 * 与服务商无关——各窗口满额度与滚动窗时长都由数据带出，这里不写死任何服务商的额度。
 *
 * @module dsh-pet/src/shared/balance/handlers/windows
 */
import type { BalanceView, WindowUsage } from '../types';
import type { ShapeHandler } from './shape';
/**
 * 周与月的窗口展示名，供气泡与联想框文案使用。
 *
 * 滚动窗的时长是服务商自己的业务事实（如 5 小时），不走这张表，见 DEFAULT_ROLLING_LABEL。
 */
export declare const WINDOW_LABELS: {
    readonly weekly: "周";
    readonly monthly: "月";
};
/**
 * 滚动窗展示名的兜底，服务商应随数据带 rollingLabel，缺省时才用它。
 *
 * 缺一个标签会让气泡出现空档，而 5h 是当前两个滚动窗口服务商的共同取值。
 */
export declare const DEFAULT_ROLLING_LABEL = "5h";
/**
 * 取最先告急的一个窗口，所有 windows 形态的服务商共用同一套判定。
 *
 * 满额度齐全时按绝对口径比剩余额度（USD）；有窗口给不出满额度时退化为比已用百分比——
 * 两窗额度量级不同，缺一个还硬比绝对剩余会反直觉。不存在的窗口直接跳过，不补 0。
 *
 * 绝对口径的副作用是滚动窗通常先报（额度最小），这一行为刻意保留，两端一致。
 */
export declare function urgentWindow(v: BalanceView): WindowUsage | undefined;
/**
 * 把重置时间转成一句相对文案，保留一位小数。
 *
 * 四天及以上报「N.x 天」，不足四天报「N.x 小时」；已过重置点报「已重置」，时间未知返回空串。
 */
export declare function resetInText(iso?: string): string;
/** windows 形态的展示规则：百分比取三窗口最大，展开态逐窗口一行。 */
export declare const windowsHandler: ShapeHandler;
