# Cloudflare 托管

正式站点使用 Pages、主 Worker、私有 Python Worker 和免费私有订阅代理 Worker，不调用 Vercel。网页版选择「浏览器 Python」后，Pyodide 在用户浏览器的独立 Web Worker 中运行 Python；后台只抓取并重建所需的安全来源数据。代理直接实现 VLESS/WebSocket 与严格 TLS，无需 Mihomo 或付费容器。订阅在使用时刷新，对兼容线路测速后选取最低延迟；管理员可在后台维护加密订阅配置。代理失败补一次直连，仍失败才沿用受限人工验证。

新版主 Worker 为 `7845e346-84a9-41dd-9dcb-a4645dcc53f0`，免费私有代理为 `159a718d-155d-44a6-8da0-fe215377c855`，Pages 发布入口为 [2336b302](https://2336b302.brclio-xhs-pages.pages.dev)。旧 `/api/python_*` 接口继续使用原私有 Python Worker，兼容已安装客户端；其版本与安装包没有更换。代理入口和管理配置说明见[免费代理说明](subscription-proxy/README.md)，核验结果见[本次发布记录](../docs/releases/v2.0.15-browser-python-free-proxy-verification.json)。两条实测笔记成功不代表上游永不验证；人工完成及真实实况帖的验收须单独记录。

下方原生接口和人工接管记录保留原流程及历史验收边界，新网页 Python 来源、媒体接口分别为 `/api/browser_python_source`、`/api/browser_python_image`、`/api/browser_python_video`。来源只返回同笔记的安全数据，会员原视频地址、上游执行脚本、订阅凭据均不发送给浏览器。

## 人工接管流程

当前网页在有效表单提交的首个异步请求前预开空白窗口，解析不需要验证时关闭；需要验证时导航到已校验的官方 Live View。继续请求取得新入口时，已打开的窗口也必须更新地址；导航失败时重开，被拦截时保留可信点击入口。相关回归 209/209 和四入口脚本／健康检查通过，但内置浏览器实际弹窗仍未取得可见证据，人工完成与媒体下载未验收。

同源网页的 `/api/parse` 与 `/api/python_parse` 先经共享 `fetchNotePage` 抓取策略取得笔记页，再运行所选引擎的独立解析器；Python 不复用 Node.js 的解析结果或媒体列表。符合请求、来源和笔记 URL 限制的指定失败（422、502、504）才尝试独立 Browser Run 会话；上游明确的登录／限流错误由 Cloudflare 适配层归为 422，普通 400 不触发浏览器。可读取目标笔记媒体时交给所选解析器。可信的小红书验证码、登录页或站内访问错误页返回 `VERIFICATION_REQUIRED` 和固定原因，网页尝试打开官方 Live View；被浏览器拦截时保留用户点击的打开按钮。用户自行按页面提示处理，再点「已完成，继续解析」。此流程不自动解题、不共享登录 Cookie，恢复后仍须核对原笔记及有效媒体。

每次尝试使用独立随机 bearer token 和 `browser:<token>` 对象。公开继续／取消请求先经固定 `parsing-v1` 的最多三条有效会话目录验证，未知 token 不创建会话对象。目录仅保存 token SHA256、引擎、固定期限、数字并发状态，以及新会话预留预算的数字 `day`／`startedAt`，不保存原 token、URL 或 Cookie。

会话期限 180 秒，不因重试或刷新 Live View 延长。成功、失败、取消及到期触发关闭；提供方关闭未确认时保留已过期资源标识并退避清理，禁止恢复，不宣称已关闭或退回预算。过期清理无需保留分享查询参数。独立会话短期保存会话／页面标识、期限、引擎、笔记标识及来源 URL；HTML、Cookie 和 Live View URL 不持久保存。`AccountRuntime` 不读写 Durable Object 存储，账号与反馈数据继续以原 GitHub 状态为准。

渲染后的 HTML 最多 6 MiB。Node.js 使用自己的解析器；Python 经私有服务绑定调用 `/__internal/parse-rendered-note`，使用独立 Python 解析器及原有普通播放资源脱敏。主 Worker 对公网 `/__internal/*` 一律返回 404，请求头不能开启私有入口。公开解析接口仍使用分享文本和原 16 KiB 请求限制。

## 此前实验与停用记录（历史）

2026-10-11 浏览器实验来源为 `9fdae65898cd67be0edc6f7e0f96b2cd35eb25d1`，Python 版本 `6d84f091-8d1c-426d-9eb6-5aa53cf06dd3`，Pages 部署 `0ff2c350`，公开文件共 90 个。分类和安全诊断补丁来源为 `a592e8969614d076d94cb6de599afbe8aef4b7e1`，实验主 Worker 版本 `c26e3784-dd84-492f-a506-8b85f75cbd16`。最终停用与门禁版本来源为 `aced84ecd75d1bcf9e0d922498e2fc9b6e4ebd70`，已移除 `BROWSER`，当时主 Worker 版本为 `8443f3c1-c8af-4ee8-91bf-397e73e149d6`，静态资源更新为 0；主 Worker 恢复 24 项绑定，19 个 Secret 名称和两个 Durable Object namespace 保留，Python 与 Pages 不变。

Python 相关 59 项、主流程 91 项和补充 47 项专项测试通过；最终停用与接口门禁 32 项专项测试也通过，覆盖无绑定时验证请求不分派会话对象。真实视频两次 Node Browser Run canary 均返回 422、无验证入口，并记录 `BROWSER_PAGE_REJECTED` 且会话已关闭。随后 Python 视频测试也是 422、无验证入口，安全摘要同为上游错误页且已关闭；Node 图文测试同样 422、无验证入口，但不在 tail 窗口内，不能指定浏览器失败原因。该轮实验无正向结果，当时已停用；不能称为解析已修复或用户手动验证成功。结果见 [Browser Run 后续核验](../docs/releases/v2.0.15-cloudflare-browser-followup.json)；此前原生 CAPTCHA 失败和旧回退记录继续保留在[部署历史](../docs/cloudflare-deployment.md)。模块、测试、Python helper 和交互准备代码保留，没有重新发布桌面安装包。

## 原生客户端边界

原生客户端边界（`269693b`）：共享 Node 抓取和 Browser Run 人工接管仅适用于带精确同源 `Origin` 的网页 POST。Android 当前无 `Origin` 的请求保留 Python 独立公开原生入口，Node 原生失败保留原响应，不进入网页会话、冷却或预算路径。桌面解析和普通媒体处理在本地；其账号、会员和更新代理的线上实现未改。现有桌面 11 个、Android 4 个附件按 ID、名称、大小与 digest 实时比对不变，未构建、启动、替换或发布客户端。源码另补桌面静态模块白名单供未来打包兼容。相关 227 项回归与四入口健康检查通过；两套无 Origin 视频接口实测仍返回 422，仅确认未进入网页验证，不能宣称 Android 下载已恢复。

## 本地检查与额度

在仓库根目录执行 `npm test`、`npm run build:cloudflare` 和 `npm run cloudflare:check`；Python 的同步、真实 workerd 测试与 dry-run 见 [Python Worker 说明](python/README.md)。本地固定响应和会话模拟测试不能替代真实网页验证。

Browser Run 会产生用量。应用按 UTC 日设置 600,000 毫秒数字预算，每次预留 180,000 毫秒，新会话至少间隔 30 秒。`cooldown` 表示尚未满足启动间隔；`daily-limit` 表示剩余预算不足以预留一次会话，响应分别提供 `Retry-After`，日限额还提供 `resetsAt`。每天 UTC 00:00（北京时间 08:00）进入新预算日，等待 30 秒不会解除当日额度限制。

人工会话只有在提供方确认关闭后，才按从预留 `startedAt` 到关闭确认的整段生命周期加 5 秒结算，退回其余预留；退款与会话目录移除在同一事务中执行一次，启动间隔仍保留。旧记录缺少预留信息、跨 UTC 日、关闭超时或未确认关闭等情形不退款。没有重置或清空历史预算。该保护不等于 Cloudflare 账号免费额度或计费上限，发布验收仍须观察实际额度与并发。本次没有自动升级套餐或增加外部解析服务。
