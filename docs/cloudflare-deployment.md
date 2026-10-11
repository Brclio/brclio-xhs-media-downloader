# Cloudflare 部署与迁移核验

## Cloudflare-only 维护边界

正式托管方案仅使用 Pages、主 Worker、私有 Python Worker 与现有服务绑定，不依赖 Vercel。当前来源 `5fc80e3` 已部署，主 Worker 版本为 `8f8236dc-2558-4dcf-bbc4-125b8af21405`，`BROWSER` 与人工接管流程已启用；真实笔记解析、人工验证及下载成功仍待验收，网页故障提示在验收完成前保留。原生引擎失败后，可信小红书验证码、登录或站内访问错误页可交给用户本人处理，恢复时仍需确认原笔记的有效媒体。不能把部署完成、打开了窗口或自动测试通过当成解析已恢复。当前结果见[人工验证核验记录](releases/v2.0.15-cloudflare-manual-verification.json)。

Node.js 与 Python 原生解析共用 `fetchNotePage` 抓取策略；Node.js 运行自己的解析器，Python 仅接收经同笔记身份校验的 HTML，经 `PYTHON_API` 调用独立 Python 解析器，不复用 Node.js 的媒体或解析结果。明确的上游登录／限流错误在 Cloudflare 适配层归为 422，可进入受限浏览器流程；普通 400 不触发浏览器。

人工入口的继续／取消请求先经 `parsing-v1` 有效会话目录，未知 token 不创建 owner 对象；目录最多三条，保存 token SHA256、引擎、期限、数字并发状态及新预留的数字 `day`／`startedAt`，不保存原 token、URL 或 Cookie。会话绝对期限仍为 180 秒，提供方关闭未确认时只保留过期资源标识并按 10 秒、60 秒至 5 分钟退避清理，不允许继续、不宣称关闭或退款；已知会话的过期记录清除来源 URL 与笔记标识。完整当前实现边界见[Cloudflare 说明](../cloudflare/README.md)。下方实验、停用及媒体结果均保留为历史证据。

## 2026-10-11：网页弹窗后续修正

来源 `5fc80e36bc083c85484feccd4c0ffe7f550fb980`，主 Worker 版本 `8f8236dc-2558-4dcf-bbc4-125b8af21405`，Pages 部署 `0f56abc3-f026-4a18-aa7b-539467d7fd19`。Python 源码未变，保留版本 `6d84f091-8d1c-426d-9eb6-5aa53cf06dd3`。修复表单等待网络响应后才打开窗口、已有窗口继续时未更新 Live View 地址两处代码问题；预开窗口在无验证、错误和结束时关闭，桌面客户端不预开网页验证窗口。

209 项相关回归全部通过（0 失败、0 跳过）；北京时间 15:56 的正式域名、Worker、Pages 主入口及该次部署入口核对中，两个脚本共 8 次 SHA-256 比对及 4 项健康检查全部通过。用户反馈未见窗口且无法刷新，内置浏览器页面／截图／CDP 读取持续超时；可见性请求确认和新页面 queued 均不是实际显示证明。直接新建内置浏览器标签也超时，不能确认标签是否创建。每次普通网页解析也会短暂出现等待窗口，原生成功后关闭。本次没有再启动消耗额度的笔记会话，尚未完成实际人工验证或媒体解析下载。此前有效 Live View 的生产响应属于旧的已过期会话，不可重新使用。

## 2026-10-11：Browser Run 实验与停用（历史）

来源提交 `9fdae65898cd67be0edc6f7e0f96b2cd35eb25d1` 部署了 Python 版本 `6d84f091-8d1c-426d-9eb6-5aa53cf06dd3`、首个实验主 Worker 版本 `98c5601c-c604-4099-927f-b5b8d57579da`，以及 [Pages 部署 0ff2c350](https://0ff2c350.brclio-xhs-pages.pages.dev)。公开文件共 90 个，涉及网页脚本、样式和新增验证模块三项静态变更。随后提交 `a592e8969614d076d94cb6de599afbe8aef4b7e1` 调整嵌套 CAPTCHA 分类优先级并补充安全失败摘要，实验主 Worker 更新为 `c26e3784-dd84-492f-a506-8b85f75cbd16`；该补丁未更换上述 Python 和 Pages 发布。最终停用与门禁版本来源为 `aced84ecd75d1bcf9e0d922498e2fc9b6e4ebd70`，已移除主 Worker 的 `BROWSER` 绑定，当时主 Worker 版本为 `8443f3c1-c8af-4ee8-91bf-397e73e149d6`，自动浏览器重试已停用；此次静态资源更新为 0。

实验期间只新增 `BROWSER` 绑定；停用后恢复原有 24 项绑定，19 个 Secret 名称、两个 Durable Object namespace 和 Python 服务绑定保留。Python 私有页面解析路径的 59 项测试、主流程 91 项测试及补充 47 项专项测试通过；最终停用与接口门禁的 32 项专项测试也通过，包括无绑定时验证请求不分派会话对象。这些是本地边界与回归证据，不代替真实上游验收。模块、测试、Python 私有 helper 和网页交互准备代码保留，但无绑定时不启动浏览器会话，也不为该重试产生新的 Browser Run 用量。发布、资源和真实样本结果统一记录在 [Browser Run 后续核验](releases/v2.0.15-cloudflare-browser-followup.json)。

该轮停用前的实验实现如下，仅描述当时行为；当前人工接管流程见上方维护边界：

1. `/api/parse` 与 `/api/python_parse` 先执行原生抓取和所选解析器。仅符合来源、输入和请求限制的指定失败（422、502、504）才尝试独立 Browser Run 会话，普通页面可读取时直接交给所选引擎解析。
2. 如果确认需要 CAPTCHA，返回 `VERIFICATION_REQUIRED`，网页显示官方 Live View 入口。用户本人完成验证后点击继续，服务端读取同一临时会话的 HTML；不自动解题，不导入或共享登录 Cookie，当时登录页会被拒绝。
3. Node.js 和 Python 分别使用自己的解析器。Python HTML 仅经 `PYTHON_API` 私有服务绑定发送到 `/__internal/parse-rendered-note`，该路径不发起额外网络请求。公网主 Worker 对 `/__internal/*` 一律返回 404，不能通过请求头切换为私有入口；公开解析请求仍限 16 KiB，不接受外部 HTML 替代分享文本。
4. 每次尝试使用独立随机 bearer token 和对应的 `browser:<token>` 对象。继续、取消通过同源 `/api/parse_verification` 路由；token 和 Live View URL 都具有临时访问权限，不能写入公开日志或分享。会话期限 180 秒，成功、失败、取消和到期均触发关闭；提供方关闭失败时仅保留已过期生命周期信息用于有界重试，不再允许继续解析。

实验实现使用 Durable Object 存储保存每日数字预算，以及单个临时会话的 `sessionId`、`targetId`、期限、引擎、笔记标识和来源 URL。来源 URL 可能带分享查询参数，只用于该私有短期会话，关闭后删除；HTML、Cookie 和 Live View URL 不持久保存。当时停用后历史数字预算记录留存，已记录的实验会话均已关闭；当时无绑定时不会开启新会话或写入新预算。该存储不是账号或业务数据库，GitHub 继续是账号与反馈的权威数据源。

**该轮真实结果全部未通过：**同一真实视频的两次 Node Browser Run canary 均返回 422，未出现可用验证入口。首次安全诊断为 `BROWSER_PAGE_REJECTED`、`closed: true`；分类补丁后仍是该错误且会话已关闭，安全摘要显示上游 `www` 主机的 `error` 路径、12,644 字节 HTML，明确 CAPTCHA／登录标记均为 false。UTC 05:25:09 的 Python 视频测试也返回 422、无验证入口，安全摘要同样为该错误页且已关闭；UTC 05:25:43 的 Node 图文测试返回 422、无验证入口，但在 tail 窗口之外，只能确认 API 失败，不能给它指定浏览器失败原因。没有完成用户手动验证或两引擎浏览器解析成功验收，该轮实验当时已停用。此前原生抓取确实遇到 CAPTCHA 的记录保留在下方。

## 2026-10-11：移除外部回退与原生诊断（前一轮）

10 月 11 日已发布移除外部解析回退与新增原生诊断的两套 Worker，来源提交为 `76c0b02e59c82c6f63db658bc8d5b3121a451ddf`：主 Worker 版本 ID 为 `3f03b7ee-7261-4ce4-a4eb-636d94ac2298`，部署 ID 为 `4d2923cb-2085-4ade-82a2-9b29b5cca8b4`，流量为 100%；Python 版本 ID 为 `ed93abf4-e2a2-4111-b7ca-6eeaf7b81c88`，部署 ID 为 `23850dae-c0d1-4d41-a5dd-3a5f21162e76`，发布于 UTC 04:37:22。此次静态资源更新为 0，无需新发 Pages；24 项绑定和 19 个 Secret 名称保留，仅移除旧外部解析回退的普通变量，没有读取 Secret 值。

该轮生产匿名检查 58/58 通过，正式域名与 Worker 健康检查均返回 200 并确认新主 Worker 版本。对同一真实视频笔记，各引擎仅执行一次匿名解析：两者都由笔记页 302 跳到验证码页 200，获得 10,358 字节 HTML，缺少初始状态和当前笔记对象，媒体数量为 0，API 仍返回 422。问题已定位为该次上游安全验证拦截；当时尚未采用浏览器读取或人机协作流程。后续 Browser Run 发布仍未取得真实成功结果，且没有采用自动解题方案。证据见[Cloudflare-only 安全诊断](releases/v2.0.15-cloudflare-only-diagnostics.json)。匿名检查与单篇诊断不等同于全部会员、邮件和媒体业务均通过。

以下前一轮发布的 Python 未重发、健康检查和媒体结果均为当时记录，不代表此次诊断更新后的状态。

9 月 23 日曾启用外部解析回退，10 月 11 日又观测到真实视频解析 422 与旧回退不可用；这些事实保留为历史证据，不作为继续依赖外部后端的要求。

## 2026-10-11：v2.0.15 前一轮发布复核

本次重新通过认证身份、账号 ID 和实时资源核对生产归属：账号 `c8b059429c868f6d0e528f9e10325f46`，主 Worker `brclio-xhs-downloader`，Pages `brclio-xhs-pages`。该轮主 Worker 版本 ID 为 `3259261c-bdbd-41e7-914a-3eb6c333fd87`，该轮 Pages 发布入口为 [04eb6ac5.brclio-xhs-pages.pages.dev](https://04eb6ac5.brclio-xhs-pages.pages.dev)。主 Worker 来源为 `217efb27344ce34b98b03bc2f4d0d1dec441b3fd`，Pages 来源为 `4bc023484c39b365c122d92b450d9c04a18f62e6`；后者仅移除了 Pages 不支持的配置字段，89 个公开文件内容相同。

该轮生产匿名接口 58/58、正式域名与 Worker 的文件比对 178/178、Pages 两入口关键页面比对 6/6 通过，四入口健康检查均为 v2.0.15 且 Python 绑定存在。真实公开笔记在两套原生解析引擎均返回 6 张图片，首图下载均为 310,278 字节 JPEG，SHA-256 一致。现有正式桌面客户端的账号权益刷新也返回 HTTP 200；该轮没有发送验证码或重测 SMTP 投递，没有创建新资源或重发 Python Worker。详细证据与该轮视频、浏览器交互等范围限制见 [网页验收记录](releases/v2.0.15-web-verification.json)。

公开构建现排除嵌套 `.DS_Store` 和 `._*` 文件，已核对原元数据不再提供。主 Worker 和 Python Worker 配置固定上述账号 ID；Pages 配置不接受 `account_id`，发布必须通过 `CLOUDFLARE_ACCOUNT_ID` 明确选择账号，不能依赖缓存推断。Pages 独立配置校验命令见[网关说明](../cloudflare/pages/README.md)。

## 2026-09-23：迁移记录

Cloudflare 服务已部署，正式站点为 [xhs.download.brclio.com](https://xhs.download.brclio.com)，另有 [Pages 入口](https://brclio-xhs-pages.pages.dev)。Pages 自定义域名和证书验证均已激活，正式域名 `/api/health` 返回 200，并确认由本轮 Cloudflare 主 Worker 提供服务。真实笔记解析、图片下载、账号登录、后台读取和 SMTP 收件已有核验证据，正式域名完整回归的结果继续记录在本文末尾。当时迁移保留了 Vercel 笔记解析回退：网页和媒体下载在 Cloudflare 处理，原生笔记解析失败时可交给原 Vercel 服务返回解析 JSON。该段记载迁移当时的设计，不是当前 Cloudflare-only 部署要求。

当时配置的 DNS 记录如下；旧目标仅作为迁移历史保留，当前回滚使用 Cloudflare 构建与部署记录：

| 项目 | 值 |
| --- | --- |
| 类型 / 名称 | `CNAME` / `xhs.download`（位于 `brclio.com` 区域） |
| 新目标 | `brclio-xhs-pages.pages.dev` |
| 代理 / TTL | 仅 DNS（灰云）/ 自动 |
| 迁移前目标（历史） | `fc70642ae54d213b.vercel-dns-017.com` |

本轮已确认 Cloudflare / Google DNS 均返回新目标，Pages 域名与证书状态为 ACTIVE，正式域名 HTTPS 健康检查通过。账号同源策略、媒体与已安装客户端仍按各自验收范围记录；不能仅凭 `pages.dev` 正常访问替代正式域名核验。

## Pages 入口、两个 Worker 与共享代码

| 部分 | 实现与职责 |
| --- | --- |
| `brclio-xhs-pages` | `cloudflare/pages/`；为外部 DNS 托管的子域名提供 Pages 自定义域名入口，静态资源直接提供，`/api/*` 与 `/admin*` 经 `APP` 服务绑定送往主 Worker |
| `brclio-xhs-downloader` | `wrangler.jsonc` + `cloudflare/worker.js`；提供网页、`/api/parse`、`/api/image`、`/api/video`、`/api/account` 和 `/api/health` |
| `brclio-xhs-python` | `cloudflare/python/wrangler.jsonc` + `src/entry.py`；独立 Python 引擎，由主 Worker 的 `PYTHON_API` 服务绑定调用，不开放公开域名 |
| 网页与后台 | 沿用 `deploy/build-web.mjs` 的公开文件白名单，构建到 `dist-web/`；主 Worker 使用 Static Assets，Pages 构建另复制到 `cloudflare/pages/dist/` |
| Node.js 下载逻辑 | 主 Worker 调用现有图片、视频处理器；Fetch 适配层保持响应字节、下载文件名与视频分段头 |
| `AccountRuntime` | 主 Worker 的 `ACCOUNT_RUNTIME` 私有 Durable Object 绑定；执行现有账号处理器、GitHub 状态验证和 SMTP，不读写 Durable Object 存储 |
| `ParseRuntime` | 主 Worker 的 `PARSE_RUNTIME` 私有 Durable Object 绑定；编排共享抓取与所选独立解析器、数字预算、人工会话目录及短期浏览器生命周期 |
| Browser Run / 人工接管 | `BROWSER` 已启用；指定原生失败后独立读取目标笔记，可信验证／登录／访问错误页提供官方 Live View，真实成功仍待验收 |
| Python 解析核心 | 从 `api/python_parse.py` 生成 `cloudflare/python/src/parser_core.py`；只维护原始解析器，使用 `sync_core.py` 同步 |
| 账号业务数据 | 继续使用同一 GitHub 私有仓库和权威状态文件，无新增数据库或数据复制流程 |
| 桌面主页批量与更新 | 继续在本地 Electron、登录浏览器和内置 Python 中运行；安装包仍由原发布流程提供 |

公开 Python 接口保留 `/api/python_parse`、`/api/python_image`、`/api/python_video`。原生笔记解析由主 Worker 共用 `fetchNotePage` 抓取，分别交给 Node.js 解析核心或经私有 `PYTHON_API` 的 `/__internal/parse-rendered-note` 交给 Python；Python 仍独立解析 HTML，不复用 Node.js 的媒体列表。图片与视频接口保留所选引擎原有处理器，全部由 Cloudflare 提供，不调用 Vercel。符合输入、来源、笔记身份和额度限制的指定原生失败（422、502、504）可进入独立 Browser Run 与人工接管；普通 400 不进入该流程。网页与已安装客户端继续使用原有接口路径，人工交互代码已部署，但真实成功尚未验收，也没有重新发布桌面安装包。

Pages 网关保留原始请求和响应，包括 Origin、Cookie、请求字节、客户端 IP 与视频 Range 头。所有账号 Secrets、私有 Python 绑定和业务处理仍留在主 Worker，Pages 不配置账号密钥。普通静态资源通过 `_routes.json` 排除在 Functions 调用之外；后台资源经过主 Worker，以保留安全响应头。Pages 的构建、绑定和本地联调命令见 [网关说明](../cloudflare/pages/README.md)。

账号后端通过请求自己的 `env` 读取 Cloudflare 绑定，不修改全局 `process.env`。客户端 IP 在 Cloudflare 仅取平台覆盖的 `cf-connecting-ip`。后台 CSP、禁止嵌入、禁止缓存及同源校验保留。

主 Worker 已部署两个 SQLite 类型的 Durable Object：`ACCOUNT_RUNTIME → AccountRuntime` 与 `PARSE_RUNTIME → ParseRuntime`，对应 `account-runtime-v1` 和 `parse-runtime-v1` 类迁移。它们提供独立执行环境，避免较复杂的账号 JSON、完整反馈校验和解析流程受主 Worker 的短 CPU 配额限制。`AccountRuntime` 不读写 Durable Object 存储；`ParseRuntime` 的存储仅涉及数字预算、有效人工会话目录和上述临时浏览器生命周期，不保存账号、反馈或页面 HTML；历史数字预算保留，没有更换预算键或清空记录。GitHub 仍是唯一账号和反馈数据源。固定对象名称分别为 `accounts-v1`、`parsing-v1`，独立浏览器会话按 `browser:<token>` 隔离，并不把业务一致性改为依赖内存锁。

反馈最终校验通过 GitHub GraphQL 批量读取分片，64 个分片使用 4 次查询；超过 8 MB、接近 8 MiB 的完整反馈在真实 workerd 与 SQLite Durable Object 中通过校验测试。写入仍使用原 GitHub SHA 冲突校验，不截断或缩减反馈内容。

## 2026-09-23：旧解析回退的原因与边界（历史）

迁移时使用仓库已有公开样本实测：Vercel 的 Node.js 与 Python 都解析出 6 张图片；Cloudflare 出站请求先解析出正确笔记地址，随后被小红书重定向到 CAPTCHA 页面，原生接口因此返回 422。图片下载未受影响，两边的两个引擎均获得完全相同的 112,906 字节 JPEG。当时回退用于保留现有解析能力，没有尝试自动绕过验证码。

旧实现通过 `XHS_PARSE_FALLBACK_ORIGIN` 固定允许一个原 `.vercel.app` 来源，只在指定的原生解析错误后调用同引擎接口；请求最多 16 KiB、响应最多 512 KiB、超时 18 秒，拒绝重定向和非 JSON 响应，不转发账号凭证、Cookie 或授权头。成功响应曾带有 `X-XHS-Parse-Backend: vercel-fallback`。账号、图片、视频、ZIP 与桌面主页批量不经过此回退。

这些描述与下方 9 月 23 日测试表用于解释历史结果。它们不要求当前保留、恢复或重新配置 Vercel；Cloudflare-only 方案移除这条解析调用路径，后续实际发布与解析复验另记。

## 沿用环境变量

变量名称见 [`.env.example`](../.env.example)，全部 `AUTH_*` 配置只给主 Worker。Python Worker 不需要账号或 SMTP 密钥。

迁移现有生产服务时，以下值必须从原部署原样迁入：

- `AUTH_SECRET_PEPPER`：不可重新生成。它参与现有会话、验证码、激活码和设备标识的摘要；换值会破坏旧数据的验证。
- `AUTH_GITHUB_OWNER`、`AUTH_GITHUB_REPO`、`AUTH_GITHUB_BRANCH`、`AUTH_GITHUB_PATH`：保持同一权威数据文件。`AUTH_GITHUB_TOKEN` 需要该私有仓库 Contents 读写权限。
- `AUTH_SITE_ORIGIN`：保持 `https://xhs.download.brclio.com`，无路径或末尾斜线；这也是管理员 Cookie 的生产访问来源。
- `AUTH_ADMIN_EMAILS`、设备上限、邮件与发送限额：迁移原值，避免改变管理员权限或现有使用规则。
- `AUTH_ALLOW_INITIALIZE`：已有数据时保持 `false`，不能通过初始化新空库来绕过读取失败。

SMTP 继续使用原来的 `AUTH_MAIL_PROVIDER`、`AUTH_SMTP_HOST`、`AUTH_SMTP_PORT`、`AUTH_SMTP_USER`、`AUTH_SMTP_PASS` 和 `AUTH_MAIL_FROM`。465 使用 TLS，587 强制 STARTTLS。Cloudflare 支持 [Node.js TLS 客户端](https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/)，[TCP 文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)说明 SMTP 25 端口受限；这不能代替真实部署的 SMTP 认证与收件验收。

本轮已实测 Cloudflare 原生 SMTP 的 465 TLS 与 587 STARTTLS。9 月 23 日正式账号流程的 `send-code` 返回 200，对应测试邮件确实进入指定测试收件箱 INBOX；该验证码随后成功登录管理员并生成 Secure、HttpOnly Cookie。没有为邮件增加 Vercel 回退或更换原 SMTP 凭据。

将实际配置保存在仓库外的专用文件，例如 `$HOME/.config/brclio/cloudflare-production.env`，目录权限设为 `700`，文件设为 `600`。创建文件前使用 `umask 077`。不要把值放进命令参数、聊天输出、`wrangler.jsonc`、示例文件或 Git 提交。仓库也已忽略 `.env*`（保留 `.env.example`）和 `.dev.vars*`，但仓库外保存仍能降低误提交风险。

Wrangler 支持在部署时以 `--secrets-file` 读取 dotenv 或 JSON 文件，或在已有 Worker 上运行 `npx wrangler secret bulk /安全路径/配置文件`。`npx wrangler secret list` 仅用于核对名称；不要输出实际值。参见 [Cloudflare Secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)。

本地匿名测试无需生产 Secrets。需要测试账号流程时使用独立测试数据与密钥；可将本地配置放进主 Wrangler 配置旁的 `.dev.vars`，并设为 `600`。不要同时依赖 `.dev.vars` 和 `.env`，前者存在时 Wrangler 不加载后者。

## 安装与本地核验

开发机需要 Node.js 22+、Python 和 `uv`。这些工具只用于开发与发布，安装包用户无需安装。

```sh
npm ci
uv sync --directory cloudflare/python --frozen
uv run --directory cloudflare/python pywrangler sync
npm test
npm run build:cloudflare
npm run cloudflare:check
python3 cloudflare/python/sync_core.py --check
uv run --directory cloudflare/python python tests/runtime_test.py
uv run --directory cloudflare/python pywrangler deploy --dry-run
```

`pywrangler sync` 为干净检出安装 Python Worker 的 `python_modules`，须先于 `runtime_test.py`。`npm run cloudflare:check` 检查主 Worker 构建；Python dry-run 独立检查 Python 部署包。`npm test` 包含原 Node.js / Python 用例、主 Worker 的接口与环境注入。Cloudflare-only 改动应另验共享抓取后仍由所选引擎独立解析、最终页面笔记身份一致、凭据隔离与无外部后端请求；明确登录／限流错误应归为 422，普通 400 不启动浏览器。还需核对私有路径公网 404、会话所有权、同源门禁、取消与到期关闭、整段人工生命周期加 5 秒的单次退款，以及启动冷却与日限额的不同重试时间。模拟 Browser Run 与弹窗的回归通过不代表真实上游或用户手动验证成功。Python `runtime_test.py` 启动隔离的真实 workerd，使用生产入口与解析器，仅替换出站网络为固定测试响应；覆盖图文、实况、音轨元数据、重定向、图片字节、视频分段、响应限额及私有 HTML 解析边界。测试入口不会加入生产包。

在两个终端分别启动服务：

```sh
# 终端 1：Python Worker（npm 脚本默认端口 8788）
npm run cloudflare:dev:python
```

```sh
# 终端 2：主 Worker（默认端口 8787）
npm run cloudflare:dev
```

Wrangler 按 Worker 名称连接本地 `PYTHON_API` 服务。需更换 Python 端口时，可使用 `uv run --directory cloudflare/python pywrangler dev --port 8790`，Worker 名称不变。两边完成启动后运行：

```sh
npm run cloudflare:verify -- http://127.0.0.1:8787 --json
```

`cloudflare:verify` 运行 [匿名检查脚本](../scripts/verify-cloudflare.mjs)，默认包含 58 项：页面与资源、后台安全头、两套解析器纯计算路径、错误输入、媒体范围限制、账号 HTTP 门禁。默认不会发送验证码、读取账号存储或修改业务数据；它也不能证明登录、会员或邮件投递正常。

可选参数 `--note-url`、`--image-token`、`--video-url` 指定允许访问的真实小红书素材。每种素材同时验证 Node.js / Python；视频只读取元数据和前 4096 字节，图片读取受大小限制。报告只输出检查名称、状态码与固定失败原因，不输出素材链接、请求体、响应正文或密钥。完整 MP4 音画、浏览器复制与 ZIP 下载仍需真实浏览器验收。

## 部署、切换与回滚

先在正确的 Cloudflare 账号完成 Wrangler 登录并核对账号。记录当前 Pages、两个 Worker 的部署与服务绑定、DNS 记录和代理状态；更新现有资源，不创建替代项目。迁移不需要更改数据仓库的 Git 历史。

1. 完成本地测试和两个 dry-run；确认原生产变量能够完整迁入，尤其是 pepper。
2. 先部署 Python，再部署带 Secrets 的主 Worker：

   ```sh
   npm run cloudflare:deploy:python
   npx wrangler deploy --secrets-file "$HOME/.config/brclio/cloudflare-production.env"
   ```

   后续 Secrets 已配置时，`npm run cloudflare:deploy` 会依次部署 Python Worker、主 Worker，并重新构建和部署 Pages。定向维护只发布实际变更的部分：Python 源码与配置未变时保留其现有部署，仍核对绑定与实际 Python 响应；公开文件或网关未变时也无需只为更新主 Worker 重发 Pages。需要同步更新完整 Secrets 时，单独运行上面的 `npx wrangler deploy --secrets-file ...`，再运行 `npm run cloudflare:deploy:pages`；不要向包含多个子命令的 npm 发布脚本透传该选项。

3. 记录两个部署结果和主 Worker 的 `workers.dev` 地址。在该地址执行 `npm run cloudflare:verify -- https://实际主Worker地址 --json`，检查 `/api/health` 返回的平台、版本及 Python 绑定。绑定存在只证明配置已连接，实际 Python 路由仍须通过检查。通过授权真实样本核对两套原生解析与下载字节，确认没有外部解析回退；指定原生失败进入浏览器后，还须验证官方 Live View 弹窗、用户本人处理、继续后原笔记解析与实际下载。分别核对 `cooldown`、`daily-limit` 的 `Retry-After` 与日重置时间，并观察实际账号额度及会话关闭；额度阻塞时按响应等待，不清空历史预算。失败时如实保留状态、安全分类和未验收项，不记录分享链接、HTML 或验证凭据，不把窗口打开或本地测试通过视为成功验收。
4. 首次创建 Pages 时按 [网关说明](../cloudflare/pages/README.md) 操作；已有项目使用 `npm run cloudflare:deploy:pages` 构建并发布。仅构建使用 `npm run build:cloudflare`。Pages 的 `APP` 必须绑定已部署主 Worker。在实际 `pages.dev` 地址重复匿名与媒体检查；Direct Upload 不会自动配置 Git 推送部署。
5. 核验 SMTP 连接、GitHub 私有仓库读取、真实图文／实况／视频。使用正式 `AUTH_SITE_ORIGIN` 时，其他预览域名的管理员请求应被拒绝；不能为预览方便修改生产 Origin 或弱化来源校验。9 月 23 日曾完成真实验证码发送、收件、管理员登录和跨后端会话核验；历史证据不替代本轮验收。发验证码、兑换、撤销等业务写入须有明确授权，不作为默认匿名检查。
6. 先在 Pages 项目添加 `xhs.download.brclio.com` 自定义域名，再在其实际权威 DNS 提供商处把该子域名 CNAME 指向项目返回的 `pages.dev` 主机名；无需为子域名迁移整个根域 DNS。只创建 CNAME 而未在 Pages 注册域名可能返回 522。只修改目标主机名，保留原 DNS/路由记录供回滚；等待 Pages 域名状态、证书与真实 HTTPS 请求均正常。见 [Pages 自定义域名说明](https://developers.cloudflare.com/pages/configuration/custom-domains/)。Python Worker 继续无公开域名。
7. 从正式域名重新运行 58 项检查与真实媒体检查。验证原管理员会话、已安装客户端的现有登录与会员、设备授权、激活码、反馈上传及后台日志查看，并确认测试邮件实际到达。记录有意产生的测试业务操作，避免重复兑换或撤销真实用户设备。
8. 记录正式域名响应、Pages 部署、两个 Worker 版本、SMTP/账号/媒体验收结果与尚未完成项。生产仅使用 Cloudflare；不要把恢复旧 Vercel 回退作为发布完成条件。网站部署完成不等于新桌面安装包发布。

若更新后出现影响使用的问题，使用已保留的 Cloudflare 构建、部署和绑定记录恢复服务，并重跑匿名与授权范围内的账号检查；回滚前确认不会重新引入已移除的外部解析调用。应用回滚仍使用同一最新业务数据；**不得把数据仓库恢复到发布前快照**，否则可能重新启用已消费激活码、旧会话或已撤销设备。各部署始终使用同一数据文件与原 pepper。

## 成本与免费额度

通过 Pages 正式入口时，普通静态资源由 Pages 提供，`/api/*` 与 `/admin*` 会调用网关和主 Worker；使用主 Worker 的 `workers.dev` 入口时，则由 Static Assets 提供公开静态资源，`run_worker_first` 将 API 和后台请求送入 Worker。后台经过主 Worker 是为了保持安全响应头。Cloudflare 当前说明 Static Assets 静态请求免费且不限量；动态请求、服务绑定和 Pages Functions 应按各自现行计量规则评估，不能把网关视为免费无限后端。`run_worker_first` 匹配的请求超过免费配额时不会回退到静态文件，而会被拒绝。见 [Static Assets 计费说明](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)。

截至 2026-09-23，普通 Workers Free 文档列出的账户请求上限为每日 100,000，单次 CPU 时间为 10 ms。主 Worker 的媒体接口和网关仍受其对应额度约束；账号执行与解析编排已放入 Durable Objects，不能再把普通 Worker 的 10 ms 直接当作这两个运行时的 CPU 上限。应分别观察主 Worker、Python Worker、Pages Functions 与 Durable Objects 的 CPU、错误率和调用量。参见 [当前平台限额](https://developers.cloudflare.com/workers/platform/limits/) 与 [定价](https://developers.cloudflare.com/workers/platform/pricing/)。Cloudflare-only 方案也不承诺无限免费后端。

GitHub API 与 SMTP 服务原有的限流、容量和发送限制仍存在。访问统计继续使用原独立统计服务，网站托管迁移不修改其部署。

SQLite 类型 Durable Objects 可用于 Workers Free，当前文档默认每次调用最多 30 秒 CPU，但有独立请求、持续时间和存储额度。`ParseRuntime` 保存数字预算、有效人工会话目录与短期浏览器生命周期，因此需同时监测调用、持续时间和存储；历史账号与反馈用例通过不等于人工验证已通过。详见 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/) 与 [限额](https://developers.cloudflare.com/durable-objects/platform/limits/)。

当前 Browser Run 与人工接管按 UTC 日使用 600,000 毫秒本地数字预算，每次预留 180,000 毫秒，新会话至少间隔 30 秒。`cooldown` 表示未满足启动间隔，`daily-limit` 表示当日剩余预算不足以预留一次会话；两者分别返回 `Retry-After`，日限额还返回 ISO 时间 `resetsAt`。每天 UTC 00:00（北京时间 08:00）进入新预算日，日限额不会因等待 30 秒解除。

人工会话只有在提供方确认关闭后，才按从预留 `startedAt` 到关闭确认的整段生命周期加 5 秒结算，最多扣除该次 180,000 毫秒预留，再退回其余部分；不能按一次继续请求的耗时退款。预算退款与会话目录移除在同一事务中执行一次，30 秒启动间隔不因退款取消。旧记录缺少预留信息、跨 UTC 日、未知或超时关闭、关闭未确认等情况保守不退款；过期资源继续清理，不恢复解析。新实现不重置或清空历史预算，也不为旧会话补做退款。

这些应用保护不是 Cloudflare 账号免费额度或计费上限保证，其他项目用量和未确认关闭的资源也可能占用提供方额度；不代表所有访问都可成功，本次没有自动升级套餐。发布和验收仍须观察实际账号的 [Browser Run 限额](https://developers.cloudflare.com/browser-run/limits/) 与 [计费规则](https://developers.cloudflare.com/browser-run/pricing/)。

<a id="已有验证记录"></a>

## 2026-09-23：已有验证记录（历史）

2026-09-23 本轮记录：

| 环境或检查 | 结果 | 范围与限制 |
| --- | --- | --- |
| 切换前正式域名 | 42/44 | [保留基线](cloudflare-baseline.json)；Node 解析畸形 JSON 返回 500，账号畸形 JSON 返回 503，预期均为 400 |
| 本地主 Worker + Python 服务绑定 | 44/44 | 两个畸形 JSON 场景均正确返回 400；未调用生产账号流程 |
| 原账号／存储／视频与适配器集中回归 | 90/90 | 包含身份、会员、设备、幂等、反馈、Cookie、环境注入、二进制与范围校验 |
| 本轮完整 `npm test` | Node.js 407 通过、3 跳过；Python 21 通过 | 跳过项不计为通过；范围不等同于原生 Windows 安装验收 |
| Python 真实 workerd 测试 | 8/8 组 | 固定上游响应，包括实际 HTML 解码、实况及音轨、二进制、重定向与 Range |
| 解析回退专项及真实 workerd 测试 | 10/10 | 同引擎、固定来源、凭据隔离、请求/响应上限、超时、失败保留；真实运行时验证 `redirect: manual` 并拒绝 3xx |
| 回退与主 Worker 集成回归 | 19/19 | 集成后的本地测试；不替代真实回退请求 |
| Pages 网关本地验证 | 4 项专项测试及 44/44 匿名检查 | 公开文件边界、静态路由、Cookie、二进制与两套引擎；域名激活另验 |
| 原 Vercel 真实公开笔记 | 两引擎均成功，6 张图片 | 用作迁移前功能基线，不包含真实视频 |
| Cloudflare 原生公开笔记 | 两引擎均遇上游 CAPTCHA | 保留此原生失败证据，是启用解析回退的依据 |
| Cloudflare 实际笔记接口 | Node.js / Python 均 200，6 张图片 | 经 `vercel-fallback` 成功，未宣称 Cloudflare 原生抓取绕过 CAPTCHA |
| Vercel / Cloudflare 真实图片 | 两平台、两引擎的 JPEG 字节一致 | 112,906 字节；SHA-256 `ea3276c15494859a5d92d092ab30c60917d5abff1851ccd38b08b3d4efc582e4` |
| Python 首次线上部署 | `ac434dc5-9896-4b09-9b75-98b7f3f08805` | 历史部署记录；非声明当前最新版本 |
| 主 Worker 首次线上部署 | `66f5273d-4953-444a-ba6b-02533c91253c` | 历史部署记录；此版本早于解析回退上线 |
| 当时主 Worker 部署 | `06db7233-a9b9-4f10-baf2-cbc2d4dd8131` | 已包含 `AccountRuntime`、`ParseRuntime` 和解析回退 |
| Pages 部署 | `c3119c79`（部署标识前缀） | [正式 Pages 入口](https://brclio-xhs-pages.pages.dev)；通过 `APP` 调用主 Worker |
| Pages 线上匿名检查 | 当时版本 44/44 | 已在最终两个 Durable Object 与解析回退部署后复验 |
| Durable Object 完整反馈测试 | 超过 8 MB，64 分片、4 次 GraphQL 查询 | 真实 workerd 中校验全部分片与总摘要，保留同一 GitHub 状态提交 |
| Cloudflare 原生 SMTP | 465 TLS、587 STARTTLS 均通过 | 正式 `send-code` 200，对应测试邮件已在 Gmail INBOX 确认 |
| 管理员验证码登录 | `verify-code` 200，Secure / HttpOnly Cookie | 使用实际收到的测试验证码完成，未记录验证码或 Cookie 值 |
| 同一测试会话跨后端读取 | Cloudflare 与 Vercel 均成功 | `me`、3 用户、4 激活码、1 反馈及管理员状态读取一致；GitHub / SMTP 状态正常 |
| 正式域名切换 | 域名与证书 ACTIVE，HTTPS 健康检查 200 | `/api/health` 确认 Cloudflare 及主 Worker 版本 `06db7233-a9b9-4f10-baf2-cbc2d4dd8131`；正式域名 48/48 检查通过，包含真实笔记与图片；[完整结果](cloudflare-validation.json) |
| 切换后正式域名账号 | 全部 200 | 原测试会话可读取用户、激活码、反馈；GitHub 与 SMTP 均正常 |
| 浏览器实际 ZIP 下载 | 837,420 字节，CRC 全部有效 | 6 张 JPEG 的文件签名完整，另含 1 份文案 TXT |

本轮未获取真实视频／实况样本；视频分段、范围、音轨和实况结构使用运行时固定样例验证，未把它写成真实 MP4 音画验收。桌面安装包版本不变，本轮不重新发布客户端。
