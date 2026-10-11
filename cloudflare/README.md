# Cloudflare 托管

正式站点使用 Pages、主 Worker 和私有 Python Worker。Pages 的 `APP` 绑定把 API 与后台请求交给主 Worker；主 Worker 通过 `PYTHON_API` 调用独立 Python 引擎。生产解析不再调用 Vercel。Browser Run 实验真实样本均失败，现已移除 `BROWSER` 绑定、停用自动重试，停止无效浏览器开销与延迟。完整部署命令、迁移历史和核验范围见[部署说明](../docs/cloudflare-deployment.md)，Pages 配置见[网关说明](pages/README.md)。

## 保留但停用的浏览器流程

当前 `/api/parse` 与 `/api/python_parse` 运行原生解析，失败时保留所选引擎的错误，不开启浏览器或验证码入口。无 `BROWSER` 绑定时，合法 `/api/parse_verification` 请求也返回 503，不查询或分派会话 Durable Object。源码仍保留此前实验：符合请求、来源和输入限制的指定失败才尝试独立 Browser Run 会话；普通页面可读取时交给所选解析器，确认需要 CAPTCHA 时以 `VERIFICATION_REQUIRED` 提供官方 Live View，供用户本人完成验证后继续。该流程不自动解题、不共享登录 Cookie，登录页会被拒绝；真实实验未取得可用验证入口。

实验每次尝试由独立随机 bearer token 绑定到 `browser:<token>` Durable Object。网页通过同源 `POST /api/parse_verification` 继续或取消，不能访问其他会话；token 和 Live View URL 均须保密。会话期限 180 秒，成功、失败、取消及到期均触发关闭。提供方关闭失败时，已过期的生命周期信息仅用于有界清理重试，不能继续解析。已记录的实验会话均已关闭。

`ParseRuntime` 的固定 `parsing-v1` 对象留存历史数字预算；实验独立浏览器对象只暂存会话／页面标识、期限、所选引擎、笔记标识及来源 URL。来源 URL 可能带分享查询参数，仅供该私有临时流程，关闭后删除；HTML、Cookie 和 Live View URL 不持久保存。无绑定时不开启新会话或写入新预算。`AccountRuntime` 不读写 Durable Object 存储，账号与反馈数据仍以原 GitHub 状态为准。

渲染后的 HTML 最多 6 MiB。Node.js 使用自己的解析器；Python 经私有服务绑定调用 `/__internal/parse-rendered-note`，使用独立 Python 解析器及原有普通播放资源脱敏。主 Worker 对公网 `/__internal/*` 一律返回 404，请求头不能开启私有入口。公开解析接口仍使用分享文本和原 16 KiB 请求限制。

## 发布与实际验收

2026-10-11 浏览器实验来源为 `9fdae65898cd67be0edc6f7e0f96b2cd35eb25d1`，Python 版本 `6d84f091-8d1c-426d-9eb6-5aa53cf06dd3`，Pages 部署 `0ff2c350`，公开文件共 90 个。分类和安全诊断补丁来源为 `a592e8969614d076d94cb6de599afbe8aef4b7e1`，实验主 Worker 版本 `c26e3784-dd84-492f-a506-8b85f75cbd16`。最终停用与门禁版本来源为 `aced84ecd75d1bcf9e0d922498e2fc9b6e4ebd70`，已移除 `BROWSER`，当前主 Worker 版本为 `8443f3c1-c8af-4ee8-91bf-397e73e149d6`，静态资源更新为 0；主 Worker 恢复 24 项绑定，19 个 Secret 名称和两个 Durable Object namespace 保留，Python 与 Pages 不变。

Python 相关 59 项、主流程 91 项和补充 47 项专项测试通过；最终停用与接口门禁 32 项专项测试也通过，覆盖无绑定时验证请求不分派会话对象。真实视频两次 Node Browser Run canary 均返回 422、无验证入口，并记录 `BROWSER_PAGE_REJECTED` 且会话已关闭。随后 Python 视频测试也是 422、无验证入口，安全摘要同为上游错误页且已关闭；Node 图文测试同样 422、无验证入口，但不在 tail 窗口内，不能指定浏览器失败原因。实验无正向结果，已停用；不能称为解析已修复或用户手动验证成功。结果见 [Browser Run 后续核验](../docs/releases/v2.0.15-cloudflare-browser-followup.json)；此前原生 CAPTCHA 失败和旧回退记录继续保留在[部署历史](../docs/cloudflare-deployment.md)。模块、测试、Python helper 和交互准备代码保留，没有重新发布桌面安装包。

## 本地检查与额度

在仓库根目录执行 `npm test`、`npm run build:cloudflare` 和 `npm run cloudflare:check`；Python 的同步、真实 workerd 测试与 dry-run 见 [Python Worker 说明](python/README.md)。本地固定响应和会话模拟测试不能替代真实网页验证。

停用后解析失败不再产生新的 Browser Run 会话用量。保留的实验代码设置 UTC 日 600,000 毫秒数字预算、每次 180,000 毫秒预留以及 30 秒启动间隔；只有确认关闭才按实际时间退回部分预留。该保护不等于 Cloudflare 计费上限，未来重新启用前仍须核对实际额度与并发。本次没有自动升级套餐或增加外部解析服务。
