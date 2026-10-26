/**
 * 余额取数的内部工具（host 半侧）：网络策略、响应校验与金额处理。
 *
 * 只给 ./providers/* 使用，不含服务商知识，也不负责注册与路由。
 * 统一 20s 超时加 3 次重试：目标端点多为境外，实测会间歇性超时。
 * 依赖全局 fetch；始终成立：必填字段缺失或非法一律抛错，绝不静默当 0。
 *
 * @module dsh-pet/src/host/balance/internal
 */
/** 带重试地抓取；全部失败时抛出最后一次错误。extraHeaders 里的键会覆盖默认 Authorization。 */
export declare function fetchWithRetry(url: string, key: string, extraHeaders?: Record<string, string>): Promise<Response>;
/** 必填数值：无法数值化或非有限数时抛错，不静默当 0。 */
export declare function num(value: unknown, what: string): number;
/** 必填字符串：非空才通过，否则抛错。 */
export declare function str(value: unknown, what: string): string;
/** 可选数值：缺失、空或非法时返回 undefined（必填字段用 num）。 */
export declare function looseNum(value: unknown): number | undefined;
/** 取普通对象：非对象、数组或 null 返回 undefined。 */
export declare function obj(value: unknown): Record<string, unknown> | undefined;
/** 解析限额窗口；形态不认识时返回 undefined，该窗口按不存在处理。 */
export declare function readWindow(value: unknown): {
    percent: number;
    capUsd: number;
    resetsAt?: string;
} | undefined;
/** 拼查询串：跳过未定义参数（如取不到的 orgId 不硬塞空值）。 */
export declare function queryString(params: Record<string, string | undefined>): string;
/**
 * 账号金额收敛为两位小数字符串：平台回传保留服务端精度的原始串（如 `9.9902690000000000`），
 * 直接展示会与官方路由的 `¥8.79` 风格不一致；非法值仍抛错，不伪造 0。
 */
export declare function money(value: unknown, what: string): string;
/**
 * 两个金额串相加，按整数分计算后保留两位小数，避免二进制浮点误差在金额上显形。
 */
export declare function sumMoney(a: string, b: string): string;
