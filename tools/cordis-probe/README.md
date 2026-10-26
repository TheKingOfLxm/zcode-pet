# dsh-cordis-probe

仓库级测试插件：模拟第三方消费者。

| 半侧 | 职责 |
|---|---|
| 客户端 | 页面右下角面板，列出 dsh-pet 的服务并调用（`ctx.get`，零请求） |
| 宿主 | 注册五个 mock 服务商，让模型选择器里能选到它们，用来验证余额气泡（含两种自定义多页） |

## 安装

DSH 设置 →「添加插件」→ 填本目录绝对路径，重启 `dsh web`。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/client.js` | 服务清单面板 |
| `lib/index.js` | 宿主半侧：注册模型路由与余额服务商 |
| `lib/mock-balance.js` | 五个 mock 服务商的数据：3 种内置形态 + 2 个自定义多页（4 页 / 3 页） |
| `lib/mock-adapter.js` | 让 mock 服务商出现在模型选择器里 |

## 余额 mock 一览

| provider id | 形态 | 气泡内容 |
|---|---|---|
| `mock-windows` | windows | 三窗口用量（5h / 周 / 月），最紧迫的是月窗口 |
| `mock-money` | money | 双币种余额 + 峰谷装饰 |
| `mock-points` | points | 积分 800 / 1000 |
| `mock-custom-kinds` | custom（4 页） | 用节点树复刻「窗口 / 金额 / 积分」三页 + 一页三者汇总 |
| `mock-custom-fancy` | custom（3 页） | 多模型余量、钱包构成（含 PRO 角标）、用量统计格 |

自定义服务商的气泡**点击循环切页**（末页回第一页），`percent` 字段驱动档位动画。
