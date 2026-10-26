# 署名 / Credits

## 原作

本项目基于 **PC2005-cloud** 的 **dsh-pet** 改造而来，桌宠形象、全部动画素材（VP9-Alpha webm）、
渲染与物理交互实现均来自原项目：

- 原项目地址：<https://github.com/PC2005-cloud/dsh-pet>
- 原作者 GitHub：<https://github.com/PC2005-cloud>

本仓库（ZCode 改造版）只做了接入层的适配：

1. 以原项目的 standalone 模式作为桌宠引擎（品牌与数据目录改为 zcode-pet / `~/.zcode/zcode-pet/`）；
2. 新增 ZCode 插件（`plugins/zcode-pet`），把 ZCode 会话事件翻译成引擎的 `POST /work-status` 接口；
3. 余额/用量接入 ZCode 的 BigModel 编码套餐（`dsh-pet/src/host/balance/providers/zcode-plan.ts`）；
4. 对话/碎碎念自动复用本机 ZCode 编码套餐凭据（`dsh-pet/src/standalone/ai-config.ts`）。

## 许可

- 代码：MIT（沿上游 `dsh-pet/LICENSE`）。
- **动画素材、提示词与桌宠形象：版权归原作者所有，禁止商用**；形象为 CC BY-NC-SA 4.0。
  使用本项目时请同样遵守上游许可，并保留本署名与原项目链接。

如果你觉得这个桌宠可爱，请去原项目给 PC2005-cloud 点个 Star：
<https://github.com/PC2005-cloud/dsh-pet>
