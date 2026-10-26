import type { AccountBalanceSnapshot, BalanceResult } from './types';
export { BUILTIN_PROVIDERS, listBalanceProviders, matchBalanceProvider, registerBalanceProvider } from './registry';
/** 内置服务商名录；沿用此导出名，避免既有调用方改动。 */
export declare const BALANCE_PROVIDERS: import("./types").BalanceProvider[];
/**
 * 按当前服务商查询余额。
 * @param provider - 当前服务商 id（agentDefaultModel.currentSelection().provider）。
 * @param resolveKey - 凭证解析：ref 名 → key。
 * @param resolveAccount - 账号余额查询；仅 deepseek-account 使用，缺省时该路由报 credential-missing。
 * @returns 成功、不支持、缺凭证或抓取失败；失败绝不返回伪造数字。
 */
export declare function queryBalance(provider: string, resolveKey: (ref: string) => Promise<string | undefined>, resolveAccount?: () => Promise<AccountBalanceSnapshot | null | undefined>): Promise<BalanceResult>;
/** 对外再导出：调用方（宿主与测试）只需认这一个入口。 */
export { parseAccountBalance } from './providers/deepseek-account';
export { parseCommandCode } from './providers/commandcode';
export type { AccountBalanceSnapshot, BalanceFetchContext, BalanceProvider, BalanceResult, BalanceShape, BalanceSuccess, CredentialSpec, CustomBalance, CustomNode, CustomTag, MoneyBalance, PluginFetchContext, PluginProvider, PointsBalance, PricingTier, WindowsUsage, } from './types';
