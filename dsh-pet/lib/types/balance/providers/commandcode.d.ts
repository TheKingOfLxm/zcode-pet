import type { BalanceProvider, BalanceSuccess } from '../types';
/**
 * 解析额度、订阅与用量三份响应（纯函数，测试直接喂真实报文）。
 * 月度百分比 = 当期消耗 /（消耗 + 剩余）；剩余 = monthlyCredits + purchasedCredits + freeCredits。
 * 窗口只在 limited 为真时读取；订阅只提供月度重置时间。
 * @throws 必填字段缺失或非法时，不伪造 0 余额
 */
export declare function parseCommandCode(creditsBody: unknown, subscriptionBody: unknown, summaryBody: unknown, provider: string): BalanceSuccess;
/** Command Code 的内置定义。 */
export declare const commandCode: BalanceProvider;
