/**
 * DeepSeek 两条路由共用的业务口径：档位基准与峰谷计价。
 *
 * 不负责取数，也不属于展示层——展示层只认数据里带出的档位与基准。
 * 两条路由（官方 API Key 与 DSH 账号）必须使用同一套基准，否则气泡档位会不一致。
 *
 * @module dsh-pet/src/host/balance/deepseek-common
 */
import type { PricingTier } from './types';
/**
 * 余额档位基准（按币种）：余额 ≥ 该值视为未消耗，据此折算已用百分比。
 * CNY 20 / USD 5 是余量充足的参照（DeepSeek 充值以 10 元为最小档）；币种不同不能换算。
 */
export declare const DEEPSEEK_FULL_BALANCE: Record<string, string>;
/** 取某币种的档位基准；没有基准时返回 undefined，不替它猜一个。 */
export declare function deepseekFullBalance(currency: string): string | undefined;
/**
 * DeepSeek 峰谷计价（北京时间）：工作日 9:00–12:00、14:00–18:00 为高峰，其余为空闲；
 * 周末全天按低谷计费（2026-08-23 起）。
 * 在取数时刻算好随数据带出，展示层因此不需要知道任何计价规则。
 */
export declare function deepseekPricingTier(now?: Date): PricingTier;
