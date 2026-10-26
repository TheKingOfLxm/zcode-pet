/**
 * money 形态：账户金额的已用百分比与气泡文案。
 *
 * 不同币种不能相加金额，但比例是无量纲的，所以不需要汇率——各币种按自己的基准算剩余比例后叠加。
 *
 * @module dsh-pet/src/shared/balance/handlers/money
 */
import type { ShapeHandler } from './shape';
/** money 形态的展示规则：百分比按币种基准折算，收成一行业务气泡。 */
export declare const moneyHandler: ShapeHandler;
