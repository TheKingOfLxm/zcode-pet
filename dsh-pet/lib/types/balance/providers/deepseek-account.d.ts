import type { AccountBalanceSnapshot, BalanceProvider, BalanceSuccess } from '../types';
/**
 * 账号余额快照 → 成功结果（纯函数，测试可直接喂真实结构）。
 * @param snapshot - 账号服务返回的快照；未登录时为 null 或 undefined。
 * @param provider - 回填结果的 provider id。
 * @returns money 形态，每个币种一条钱包。
 * @throws 未登录、查询失败、无充值钱包或金额非法时，不伪造 0 余额
 */
export declare function parseAccountBalance(snapshot: AccountBalanceSnapshot | null | undefined, provider: string): BalanceSuccess;
/** DSH 账号路由的内置定义。 */
export declare const deepseekAccount: BalanceProvider;
