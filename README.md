# zcode-pet 🐟

一只住在 **ZCode** 里的桌面宠物：ZCode 忙起来它跟着思考、干活、等确认、庆祝完成；
闲下来会碎碎念、陪你聊天，还能查看智谱编码套餐的用量余量。透明置顶小窗 + 浏览器 overlay，
可拖拽、可甩抛、可多开。

> **改编声明**：本项目改编自 **[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)**
> （原作者 GitHub：<https://github.com/PC2005-cloud>）。桌宠形象、全部动画素材与渲染/物理实现
> 均来自原项目，版权归原作者所有、**禁止商用**（形象 CC BY-NC-SA 4.0）。完整署名见
> [CREDITS.md](CREDITS.md)，原项目文档存档于 [UPSTREAM-README.md](UPSTREAM-README.md)。
> 喜欢这只宠物的话，请去原项目点个 Star ⭐

## 与原作的关系

素材、动画、物理交互**一行未改**，改的只是「事件接入层」：
原项目监听 DeepSeek Harness（DSH）的会话事件，本仓库把事件源换成了 **ZCode hooks → 本地 HTTP API**。

```
┌─────────┐   hooks 事件     ┌──────────────────┐  POST /work-status  ┌────────────────────┐
│  ZCode  │ ───────────────▶ │ zcode-pet 插件    │ ──────────────────▶ │ zcode-pet 桌宠引擎  │
│ (CLI)   │  7 个生命周期    │ pet-hook.mjs     │  六档状态 + 气泡     │ (原 standalone 模式) │
└─────────┘                  └──────────────────┘                     └────────────────────┘
                                                                      ├─ 浏览器 overlay 渲染
                                                                      └─ Electron 透明置顶小窗
```

## 功能

- **工作状态联动**：发消息 → 思考，调工具 → 干活（气泡显示工具名 + 命令摘要），等确认 → 等待，
  完成 → 庆祝，会话结束 → 回空闲；非终态循环播放，成功/出错播一遍后气泡自动收起
- **余额/用量**：直读本机 ZCode 的 BigModel 编码套餐，展示 **5h 滚动窗 + 周窗** 已用百分比
  （智谱套餐没有月窗），按用量分六档播动画 + 头顶进度条气泡
- **对话 & 碎碎念**：开箱即用，直接走你的智谱编码套餐（GLM-5.3-Flash），带女仆人设与表情包配图
- **保留原作全部交互**：点击 Q 弹、拖拽跟手、甩抛飞行反弹、右键菜单、多实例多开、双屏异构 DPI

## 快速开始

### 1. 安装 ZCode 插件

打开 ZCode：**插件市场 → 添加 → 添加插件市场**，二选一：

- 粘贴本仓库地址：`https://github.com/TheKingOfLxm/zcode-pet`（支持远程源时）
- 或 `git clone` 本仓库后粘贴克隆目录的绝对路径（保底方式）

然后在该市场里安装 **ZCode 桌宠桥 / zcode-pet** 插件。

### 2. 运行桌宠引擎

```bash
git clone https://github.com/TheKingOfLxm/zcode-pet
cd zcode-pet/dsh-pet
pnpm install          # 或 npm install
node lib/standalone.js   # 仓库已含构建产物，无需再 build；改了源码才需要 pnpm run build
```

看到 `独立模式服务已监听 http://127.0.0.1:3080/` 即成功（端口占用自动顺延）。
首次运行会自动下载 Electron 到 `~/.zcode/electron` 并弹出透明小窗。

### 3. 让插件能拉起引擎（一次性）

写一份 `~/.zcode/zcode-pet/bridge.json`（Windows 注意路径转义，推荐正斜杠）：

```json
{ "engineRoot": "C:/path/to/zcode-pet/dsh-pet" }
```

新开一个 ZCode 会话：插件会在引擎没运行时自动拉起它，宠物打招呼后随你的工作节奏动起来。

## 工作状态映射

| ZCode 事件 | 桌宠状态 | 气泡 |
| --- | --- | --- |
| `UserPromptSubmit` | thinking 思考 | 档位文案 |
| `PreToolUse` | working 工作 | 工具名 + 命令/文件摘要（≤40 字） |
| `PostToolUse` | result 整理 | 5 秒防抖（工具秒回不闪切，沿上游设计） |
| `Notification` | waiting 等待 | 通知内容 |
| `Stop` | success 完成 | 10 秒后自动收起 |
| `SessionStart` / `SessionEnd` | 空闲 | SessionStart 投喂一句上线问候 |

## 余额 / 对话的套餐接入

两者都自动读本机 ZCode 配置 `~/.zcode/v2/config.json` 的
`builtin:bigmodel-coding-plan` 条目（缺失时回退 start-plan）：

- **余额**：查 `open.bigmodel.cn/api/monitor/usage/quota/limit`，5h 滚动窗 + 周窗，
  周期默认 1800 秒，右键宠物「查看余额」立即刷新
- **对话/碎碎念**：anthropic 兼容端点 + Key + 模型（`models` 表里 `zcode.priority` 最高者），
  派生设置不落盘，ZCode 换 key 自动跟随；你在设置页保存过自己的配置则以保存的为准
  （删 `~/.zcode/zcode-pet/standalone-ai.json` 回到自动跟随）
- 密钥只在本机内存与 ZCode 自己的配置目录里流转，不经手任何第三方

## 目录结构

```
├── marketplace.json        # ZCode 插件市场清单（本仓库即一个市场）
├── plugins/zcode-pet/      # ZCode 插件：hooks 桥接脚本（零依赖、静默失败）
├── dsh-pet/                # 桌宠引擎（上游 standalone 模式，含构建产物 lib/）
│   ├── src/host/           # 宿主半侧：路由/配置/余额/工作状态
│   ├── src/client/         # 浏览器半侧：渲染/动画链/设置页
│   ├── src/shared/         # 双端共用纯逻辑（物理/菜单/取数）
│   ├── assets/webm/        # 动画素材（上游原样，未动）
│   └── lib/                # 构建产物（已入库，克隆即用）
├── CREDITS.md              # 署名与许可
└── UPSTREAM-README.md      # 原项目 README 存档
```

## 排查

- 桥接日志：`~/.zcode/zcode-pet/bridge.log`；引擎日志：`~/.zcode/zcode-pet/logs.txt`
- 引擎运行时（端口/令牌）：`~/.zcode/zcode-pet/standalone-runtime.json`
- 手动指挥桌宠（写操作带 token，完整 API 见仓库根目录 `openapi.yaml`）：

```bash
TOKEN=$(node -e "console.log(require(process.env.USERPROFILE+'/.zcode/zcode-pet/standalone-runtime.json').token)")
curl -X POST http://127.0.0.1:3080/dsh-pet-7340/work-status \
     -H "content-type: application/json" -H "x-dsh-pet-token: $TOKEN" \
     -d '{"state":"working","task":"摸鱼中"}'
```

## 许可与署名

- 代码：MIT（沿上游）；**动画素材、提示词与桌宠形象：版权归原作者所有、禁商用**
  （形象 CC BY-NC-SA 4.0）
- 原项目：**[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)** ·
  原作者：<https://github.com/PC2005-cloud>
