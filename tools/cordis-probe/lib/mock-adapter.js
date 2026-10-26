/**
 * 极简 LLM 适配器：只为让五个 mock 服务商出现在 DSH 的模型选择器里，不参与真实对话。
 *
 * 走鸭子类型而非继承 `LlmAdapter`：探针不声明对 `@deepseek-ai/dsh-llm` 的依赖，
 * `ctx.llm.registerAdapter()` 运行时也不做 instanceof 校验。各方法的默认值照抄基类。
 * @module dsh-cordis-probe/mock-adapter
 */

/** 每个 mock 服务商都只广告这一个模型（GUI 只列有模型的适配器）。 */
const MODEL = { id: 'mock', name: 'Mock（不参与对话）' };

/** 对话不可用：被选中后调模型会拿到这个错误，提示它只是余额测试桩。 */
async function* unavailable() {
  throw new Error('cordis-probe: mock 服务商只用于测试余额气泡，不参与对话');
}

/**
 * 造一个 mock 适配器。
 *
 * @param names - provider id → 选择器里显示的名字。
 * @returns 实现 `ctx.llm.registerAdapter()` 所需全部方法的普通对象。
 */
export function createMockAdapter(names) {
  const resolve = (provider, model) => ({ provider, id: model, name: MODEL.name });
  return {
    providerInfo: (provider) => ({ id: provider, name: names[provider] ?? provider }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({
      width: image.width,
      height: image.height,
      maxBytes: image.bytes,
    }),
    // 模型元数据必须带上 provider 且与注册的 id 一致，否则 DSH 判 INVALID_CATALOG
    listModels: async (provider) => [{ provider, id: MODEL.id, name: MODEL.name }],
    resolveModel: async (provider, model) => resolve(provider, model),
    prepareCall: async (provider, model) => ({ model: resolve(provider, model), stream: unavailable }),
    stream: unavailable,
  };
}
