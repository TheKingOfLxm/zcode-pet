# zcode-pet —— ZCode 桌面宠物（dsh-pet 改造版）

把 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DeepSeek Harness 桌宠，原作者 **[PC2005-cloud](https://github.com/PC2005-cloud)**）改造成 **ZCode** 用的桌面宠物。

> **署名**：桌宠形象、全部动画素材与渲染/物理实现均来自原项目
> [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，版权归原作者所有、**禁商用**（形象 CC BY-NC-SA 4.0）。
> 本仓库只改了事件接入层，详细署名见 [CREDITS.md](CREDITS.md)。喜欢的话请去原项目点 Star。

**素材、动画、物理交互完全沿用原项目**（640×360 VP9-alpha webm「大肥鱼」建模，未做任何改动）；改造只动了「事件接入层」：原来的 DSH 会话事件监听，换成了 **ZCode hooks → 本地 HTTP API**。

```
┌─────────┐   hooks 事件     ┌──────────────────┐  POST /work-status  ┌────────────────────┐
│  ZCode  │ ───────────────▶ │ zcode-pet 插件    │ ──────────────────▶ │ zcode-pet 桌宠引擎  │
│ (CLI)   │  7 个生命周期    │ pet-hook.mjs     │  六档状态 + 气泡     │ (原 standalone 模式) │
└─────────┘                  └──────────────────┘                     └────────────────────┘
                                                                      ├─ 浏览器 overlay 渲染
                                                                      └─ Electron 透明置顶小窗
```

## 与上游的差异

| 部分 | 处理 |
| --- | --- |
| `assets/webm/` 素材、`src/client/` 渲染、`src/shared/` 物理 | **原样保留，未动** |
| 运行形态 | 以原项目的 **standalone 模式**（伪 ctx，本机 HTTP 服务 + 可选 Electron 小窗）作为唯一引擎形态 |
| 事件接入 | 新增 ZCode 插件 `plugins/zcode-pet`：hooks 把会话事件翻译成 `POST /work-status`（外部 `api` 槽） |
| 余额/用量 | 新增 `balance/providers/zcode-plan.ts`（provider id `standalone`，独立模式 CLI 自动注册）：读本机 ZCode 配置的 BigModel 编码套餐 Key，查 `open.bigmodel.cn/api/monitor/usage/quota/limit`，按 windows 形态展示 **5h 滚动窗 + 周窗**（周窗数据放 monthly 槽并以 `monthlyLabel: "周"` 标注——智谱套餐没有月窗；`TIME_LIMIT` 工具次数窗不进展示），已用百分比驱动六档余额动画 |
| 数据目录 | `~/.dsh` → `~/.zcode/zcode-pet/`（可用 `ZCODE_PET_HOME` 覆盖，兼容旧 `DSH_HOME`） |
| 对话/碎碎念 | **自动接入 ZCode 的 BigModel 编码套餐**：本机没有已保存的 AI 设置时，从 `~/.zcode/v2/config.json` 取编码套餐的端点（anthropic 兼容）+ Key + 模型（`models` 表里 `zcode.priority` 最高者，当前为 GLM-5.3-Flash）直接启用，无需手填；派生结果不落盘，ZCode 换 key 自动跟随。一旦在设置页保存过自己的配置，就以保存的为准 |
| HTTP 前缀 | 保留上游 `/dsh-pet-7340` 字面量（散布 20+ 文件，改名风险大于收益） |
| 余额/DSH 系统通知 | 余额已接 ZCode 套餐（见下）；DSH 系统通知不可用 |

## 工作状态映射（六档）

| ZCode 事件 | 桌宠状态 | 气泡 task |
| --- | --- | --- |
| `UserPromptSubmit` | thinking 思考 | — |
| `PreToolUse` | working 工作 | 工具名 + 命令/文件摘要（≤40 字） |
| `PostToolUse` | result 整理 | — |
| `Notification` | waiting 等待 | 通知内容 |
| `Stop` | success 完成 | —（气泡 10 秒自动收） |
| `SessionStart` / `SessionEnd` | 清空 → 空闲 | SessionStart 还会投喂一句上线问候 |

引擎侧外部槽与内部状态共用优先级：waiting > error > working > thinking > result > success。

## 余额/用量查询（ZCode BigModel 编码套餐）

独立模式下引擎上报的服务商是 `standalone`，构建时已把 BigModel 套餐用量注册到这个 id 上：

- **凭证**：自动读本机 ZCode 配置 `~/.zcode/v2/config.json`（`ZCODE_CONFIG_FILE` 可覆盖），取启用的 `builtin:bigmodel-coding-plan`（缺失时回退 `builtin:bigmodel-start-plan`）的 API Key；不落盘、不经手第三方
- **接口**：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（与 ZCode 官方用量查询插件同源）
- **展示**：windows 形态——`TOKENS_LIMIT` 的 5 小时窗（rolling）与周窗（以 monthly 槽 + `monthlyLabel: "周"` 承载，智谱套餐没有月窗），气泡收起态显示最紧迫窗口（如「5h额度已用 N% / X 后重置」），点开看逐窗口进度条；已用百分比取两窗最大值驱动六档余额动画；`TIME_LIMIT`（工具调用次数）不参与
- **刷新**：周期默认 1800 秒（配置 `eventsRefreshSec.balance`），右键宠物菜单「查看余额」立即手动刷新

## 对话 / 碎碎念（直用 ZCode 编码套餐）

右键宠物「对话」聊天、手动「碎碎念」**开箱即用**，直接走你 ZCode 的 BigModel 编码套餐：

- **来源**：`~/.zcode/v2/config.json` 的 `builtin:bigmodel-coding-plan` 条目——anthropic 兼容端点 + API Key + 模型（`models` 表 `zcode.priority` 最高者，当前 GLM-5.3-Flash）
- **生效条件**：本机没有已保存的 AI 设置时自动派生启用；一旦在设置页（右键「打开 AI 设置」或 `http://127.0.0.1:3080/standalone-ai/`）保存过自己的配置，以保存的为准（删掉 `~/.zcode/zcode-pet/standalone-ai.json` 可回到自动跟随）
- **自动碎碎念**默认关（避免意外消耗），设置页里按需打开
- 保护上限沿上游：6 次/分钟限流、输入 32k / 输出 16k 字符、单次超时 30 秒

## 安装

### 1. 构建并试跑引擎（本目录 `dsh-pet/`）

```bash
cd dsh-pet
pnpm install        # 或 npm install
pnpm run build      # 产出 lib/（含 lib/standalone.js 与全部类型）
node lib/standalone.js
```

看到 `独立模式服务已监听 http://127.0.0.1:3080/` 与宠物列表即成功（端口占用自动顺延）。
首次以 `display: "both"`（默认）运行会自动下载 Electron 到 `~/.zcode/electron` 弹出透明小窗。

### 2. 安装 ZCode 插件（`plugins/` 目录）

1. 打开 ZCode：**插件市场 → 添加 → 添加插件市场**，粘贴本仓库 `plugins/` 目录的绝对路径（例如 `E:\dsh-pet-main\plugins`）。
2. 在该市场（`dev-zcode-pet`）里安装 **ZCode 桌宠桥 / zcode-pet**。
3. 新开一个 ZCode 会话即可看到效果。

### 3. 告诉插件引擎在哪（一次性）

插件需要知道引擎源码根目录才能在引擎未运行时自动拉起。写一份 `~/.zcode/zcode-pet/bridge.json`：

```json
{ "engineRoot": "E:\\dsh-pet-main\\dsh-pet" }
```

可选字段：`petId`（问候/投喂目标，默认 `"main"`）、`greetText`（上线问候语）、`greetOnStart`（默认 `true`）。
也可以用环境变量 `ZCODE_PET_ROOT` 代替。若引擎已在运行（runtime 文件有效），本步骤可跳过。

## 手动控制（彩蛋）

引擎起来后，任何脚本都能指挥桌宠（写操作需带 `standalone-runtime.json` 里的 token）：

```bash
TOKEN=$(node -e "console.log(require(process.env.USERPROFILE+'/.zcode/zcode-pet/standalone-runtime.json').token)")
BASE=http://127.0.0.1:3080/dsh-pet-7340

curl -X POST $BASE/work-status -H "content-type: application/json" -H "x-dsh-pet-token: $TOKEN" \
     -d '{"state":"error","task":"演示一次出错"}'     # 六档：thinking/working/result/waiting/success/error
curl -X DELETE $BASE/work-status -H "x-dsh-pet-token: $TOKEN"   # 回空闲
```

完整 API 见 `openapi.yaml`（说话 `/broadcast`、点播动画 `/anim`、抛掷 `/throw`、对话 `/chat` 等）。

## 日志与排查

- 桥接日志：`~/.zcode/zcode-pet/bridge.log`
- 引擎日志：`~/.zcode/zcode-pet/logs.txt`
- 引擎运行时（端口/令牌）：`~/.zcode/zcode-pet/standalone-runtime.json`

## 许可

代码 MIT（沿上游）；**动画素材、提示词与形象禁商用**（形象 CC BY-NC-SA 4.0），详见上游 LICENSE 与 README。
