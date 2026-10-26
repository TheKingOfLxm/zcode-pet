/**
 * 探测当前模型是否支持 reasoning effort（含 "off"），宿主半侧共用。
 *
 * 不负责缓存与重试：每次调用都向 dsh-llm 问一次，拿不到能力就保守当作不支持。
 * 必须始终成立：只有模型确实声明支持时才传 reasoningEffort: 'off'——dsh-llm 对
 * 「无 reasoning 元数据 + 显式传 effort」直接判 UNSUPPORTED_REASONING_EFFORT，请求发不出去，
 * 只会被适配器折叠成空流，表现为「模型未返回文本」。
 * @module dsh-pet/src/host/llm-reasoning
 */
/**
 * 当前 provider/model 是否声明支持 reasoning effort（含 "off"）。
 * 能力缺失或查询失败一律保守返回 false（= 不传，等价于模型默认行为，避免请求失败）。
 */
export declare function supportsReasoningOff(ctx: {
    llm?: unknown;
}, provider: string, model: string): Promise<boolean>;
