/**
 * 气泡行数据的主出口：把余额状态转成气泡行，浏览器与桌面共用同一份内容与文案。
 *
 * 纯函数，不碰 DOM 与 React；形态相关的文案也不在这里，本模块只负责不可用状态的说明行，
 * 其余按形态查分发表。必须始终成立：不可用时绝不伪造数字。
 *
 * @module dsh-pet/src/shared/balance/view
 */
import type { BalanceBubbleRow, BalanceState, CustomNode } from './types';
/**
 * 把余额状态渲染成气泡行数据。
 *
 * 形态文案由各 handler 提供；custom 形态返回空数组——它走节点树这条并行通道（见下方 customViews），
 * 空数组只在误用行数据时兜底成空气泡。不可用时显式展示原因，绝不伪造数字。
 */
export declare function balanceBubbleView(state: BalanceState): BalanceBubbleRow[];
/**
 * 展开态的气泡行，点开余额气泡后显示。
 *
 * 只有 windows 有三窗口读数可展开，每个存在的窗口一行；money 与 points 没有窗口概念，
 * 回落到收起态视图，避免点了一下却什么都没变的空交互。
 */
export declare function balanceDetailView(state: BalanceState): BalanceBubbleRow[];
/**
 * 多页节点树：只对 custom 形态有值，其余形态返回 undefined，调用方据此回落行数据。
 * 第一项是初始页；多于一项时气泡可点，点一下切下一页，末页回第一页。
 */
export declare function customViews(state: BalanceState): CustomNode[] | undefined;
/**
 * custom 气泡是否可点切页，两端据此决定气泡可不可点。
 *
 * 只有一页时点开也没有别的内容，保持不可点，气泡继续不挡页面。
 */
export declare function customClickable(state: BalanceState): boolean;
