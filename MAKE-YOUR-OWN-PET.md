# 从零生成你自己的宠物（完整流程）

> 返回 [README](README.md) ｜ 全流程：AI 提示词 → 绿幕视频 → 透明动画 → 插件 → 发布。换角色、换动作、换风格，均可复现。

## ① 提示词 → 源视频

用 AI 视频生成工具（如可灵、Runway、豆包等，本项目素材即由豆包生成），按 `prompts/桌面宠物 10 秒动作提示词.md` 的配方，一个动作生成一段 10 秒绿幕视频：

- 视频比例 16:9，背景纯绿幕（#00FF00）
- 人物位置/大小固定（头顶 ~20% 高度、脚底 ~85% 高度）
- 动作全程在画幅内，首尾帧为标准正面站立
- 每段动画按秒分解（0-10s 各阶段动作）

生成结果按动作各存一个 mp4，放入 `video/`。

> **源视频获取**：为控制仓库体积，`video/` 源视频不入 git。Releases 提供**打包压缩包**，浏览器直接下载即可：
>
> - `assets-videos.zip` —— 全部源视频压缩包（中文名 mp4，解压后放入 `video/`）
>
> 解压：`Expand-Archive assets-videos.zip`（Windows）或 `unzip assets-videos.zip`，把 mp4 放回 `video/` 即可运行素材链。

## ② 源视频 → 透明动画（素材链）

step02（透明视频）有**两条路线，按需二选一**（默认自动、人人可复现；效果不佳可用 PR 手工抠像覆盖）：

```sh
cd scripts
# 路线 A（默认）：自动绿幕抠像（HSV 色相，无需人工）
python watermark_step01.py   # 水印遮罩填充 → step01/
python chroma_step02.py      # 绿幕抠像转透明 → step02/

# 路线 B（可选）：PR 手工抠像覆盖（针对含第三方物品/自动抠像效果不佳的动作）
#   1. 在 PR 里手工抠像，导出带 alpha 的透明 .mov（如 ProRes 4444 with Alpha）
#   2. 放入 pr/，文件名与动作名一致（如 吃白饭.mov）
python pr_import_step02.py   # pr/*.mov → step02/（透明 webm，覆盖该动作自动抠像结果）

# 后续步骤两条路线共用：
python normalize_step03.py   # 归一化 2160×1215 统一站立居中 → step03/
python encode_thumbs.py      # 转码 640×360 播放变体 → step04/
```

**依赖**：Python 3 + ffmpeg + numpy + scipy（素材链脚本自动用工作区 `.tools/` 下的 ffmpeg）。

> **本项目全部采用路线 B**（全部动作均为 PR 手工抠像）：对"含第三方物品/透明边缘复杂"的动作，自动 HSV 抠像易残边或误抠，PR 手动遮罩更精细。两条路线产出同一级 `step02/`，后续步骤完全一致；`chroma_step02.py` 保留为自动化兜底，任何动作仍可一键自动生成。

## ②.5 🍎 Safari/HEVC 兼容素材（macOS 专用 mov）

插件默认只发布 `.webm`（VP9-alpha），Safari/WKWebView 不认 webm alpha（黑底），macOS 需要在 GitHub Release 下载官方转码的 **HEVC-with-Alpha `.mov`** 素材使用，两步：

1. **下载**：<https://github.com/PC2005-cloud/dsh-pet/releases/tag/assets-mov>（固定 tag，保持最新；zip 解压后文件名与 webm 一一对应）
2. **放入**：`.mov` 文件放进 `$DSH_HOME/dsh-pet/main-animation/mov/`（pet pack 宠物则是 `pet/<种类名>-animation/mov/`）

## ③ 动画 → 插件

```sh
# 把 step04 的播放变体同步进插件包（webm 直接 cp）
cp step04/*.webm dsh-pet/assets/webm/   # 播放格式（VP9-alpha）

# 本地安装插件（--profile 填实际在用的那个：dsh web → web；
# 桌面应用（Electron 版）改用应用内「插件管理」，见「快速开始（安装插件）」；
# file: 指向插件目录 dsh-pet/dsh-pet）
dsh plugin --profile web add file:D:/path/to/dsh-pet/dsh-pet
```

> 中间产物（step01-04）由脚本生成、不入仓库；`video/` 源视频和脚本是成果、入库维护。

## 🎯 发布（单一 webm 格式）

插件只发布一个 npm 包、一个素材格式（webm）；`files` 收敛为固定清单（lib / src / assets/webm / runtime/electron-helper / assets/fonts / assets/pic / assets/config.jsonc / scripts/ensure-electron.mjs / cordis.patch.yml，见 `prepare.js`；浏览器与桌面模式共用，包体最小）：

```sh
cd dsh-pet
npm publish --tag latest   # prepack 自动执行构建（完整产物 + 收敛 files），无需手动构建
```

- client 端按运行时判断播放扩展名：macOS WebKit（Safari/WKWebView）自动用 `.mov`，其余用 `.webm`
- 需要 Safari/HEVC 版（macOS）：mov 素材官方发布在 GitHub Release `assets-mov`，下载解压进 `main-animation/mov/` 即可
