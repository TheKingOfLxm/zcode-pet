/**
 * points 形态：积分或点数余额（非货币）的已用百分比与气泡文案。
 *
 * 与 money 的区别只在语义：单位是数据带出的后缀，绝不套货币符号；数学是同一套，单位在比值里
 * 被约掉，同样没有汇率问题。
 *
 * @module dsh-pet/src/shared/balance/handlers/points
 */
import type { ShapeHandler } from './shape';
/** points 形态的展示规则：百分比按积分基准折算，气泡只拼数字与单位。 */
export declare const pointsHandler: ShapeHandler;
