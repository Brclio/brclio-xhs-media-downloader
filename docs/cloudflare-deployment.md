# Cloudflare 部署与迁移核验

Cloudflare 服务已部署，正式站点为 [xhs.download.brclio.com](https://xhs.download.brclio.com)，另有 [Pages 入口](https://brclio-xhs-pages.pages.dev)。Pages 自定义域名和证书验证均已激活，正式域名 `/api/health` 返回 200，并确认由本轮 Cloudflare 主 Worker 提供服务。真实笔记解析、图片下载、账号登录、后台读取和 SMTP 收件已有核验证据，正式域名完整回归的结果继续记录在本文末尾。这次迁移保留 Vercel 的笔记解析回退，并非完全停止使用 Vercel：网页和图片、视频下载在 Cloudflare 处理，当原生笔记解析受到上游限制或失败时，仅交给原 Vercel 服务返回解析 JSON。

本轮已配置的 DNS 记录如下；原目标保留用于必要时回滚：

| 项目 | 值 |
| --- | --- |
| 类型 / 名称 | `CNAME` / `xhs.download`（位于 `brclio.com` 区域） |
| 新目标 | `brclio-xhs-pages.pages.dev` |
| 代理 / TTL | 仅 DNS（灰云）/ 自动 |
| 原目标，供回滚 | `fc70642ae54d213b.vercel-dns-017.com` |

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
| `ParseRuntime` | 主 Worker 的 `PARSE_RUNTIME` 私有 Durable Object 绑定；执行 Node.js 解析或调用 Python 服务，并编排必要的同引擎解析回退，不读写 Durable Object 存储 |
| Python 解析核心 | 从 `api/python_parse.py` 生成 `cloudflare/python/src/parser_core.py`；只维护原始解析器，使用 `sync_core.py` 同步 |
| 笔记解析回退 | `cloudflare/parse-fallback.js`；原生解析优先，必要时只调用原 Vercel 的 `/api/parse` 或 `/api/python_parse`，保留所选引擎及响应格式 |
| 账号业务数据 | 继续使用同一 GitHub 私有仓库和权威状态文件，无新增数据库或数据复制流程 |
| 桌面主页批量与更新 | 继续在本地 Electron、登录浏览器和内置 Python 中运行；安装包仍由原发布流程提供 |

公开 Python 接口保留 `/api/python_parse`、`/api/python_image`、`/api/python_video`。主 Worker 首先通过私有服务绑定调用 Python；图片和视频始终在 Cloudflare 下载，只有失败的笔记解析可使用同引擎 Vercel 回退。网页与已安装客户端继续使用原有接口路径；保留同一生产域名时，无需仅为换托管平台重打包客户端。

Pages 网关保留原始请求和响应，包括 Origin、Cookie、请求字节、客户端 IP 与视频 Range 头。所有账号 Secrets、私有 Python 绑定和业务处理仍留在主 Worker，Pages 不配置账号密钥。普通静态资源通过 `_routes.json` 排除在 Functions 调用之外；后台资源经过主 Worker，以保留安全响应头。Pages 的构建、绑定和本地联调命令见 [网关说明](../cloudflare/pages/README.md)。

账号后端通过请求自己的 `env` 读取 Cloudflare 绑定，不修改全局 `process.env`；Vercel 继续使用原环境读取方式。客户端 IP 在 Cloudflare 仅取平台覆盖的 `cf-connecting-ip`，原 Vercel 路径继续取其可信 IP 来源。后台 CSP、禁止嵌入、禁止缓存及同源校验保留。

主 Worker 已部署两个 SQLite 类型的 Durable Object：`ACCOUNT_RUNTIME → AccountRuntime` 与 `PARSE_RUNTIME → ParseRuntime`，对应 `account-runtime-v1` 和 `parse-runtime-v1` 类迁移。它们提供独立执行环境，避免较复杂的账号 JSON、完整反馈校验和解析流程受主 Worker 的短 CPU 配额限制；代码不使用 Durable Object 存储，GitHub 仍是唯一账号和反馈数据源。固定对象名称分别为 `accounts-v1`、`parsing-v1`，并不把业务一致性改为依赖内存锁。

反馈最终校验通过 GitHub GraphQL 批量读取分片，64 个分片使用 4 次查询；超过 8 MB、接近 8 MiB 的完整反馈在真实 workerd 与 SQLite Durable Object 中通过校验测试。写入仍使用原 GitHub SHA 冲突校验，不截断或缩减反馈内容。

## 笔记解析回退的原因与边界

本轮使用仓库已有公开样本实测：Vercel 的 Node.js 与 Python 都解析出 6 张图片；Cloudflare 出站请求先解析出正确笔记地址，随后被小红书重定向到 CAPTCHA 页面，原生接口因此返回 422。图片下载未受影响，两边的两个引擎均获得完全相同的 112,906 字节 JPEG。回退用于保留这一现有解析能力，不尝试自动绕过验证码。

`XHS_PARSE_FALLBACK_ORIGIN` 是新增的公开运行配置，当前固定允许 `https://xhs-images-video-vercel-downloader.vercel.app`；不能填写生产自定义域名，否则会产生递归，也不能换成任意代理。省略该变量即关闭回退。只有有效的 JSON 笔记链接，在原生解析发生指定的上游或解析错误后才重试；成功的原生请求不调用 Vercel。

请求最多 16 KiB，回退 JSON 响应最多 512 KiB，超时 18 秒。只转发提取后的分享链接，不转发账号凭证、Cookie、授权头、额外 JSON 字段或剪贴板中的其他文案；拒绝重定向与非 JSON 响应。回退成功响应包含 `X-XHS-Parse-Backend: vercel-fallback`，引擎仍为用户选中的 Node.js 或 Python；回退失败保留原生错误。账号、图片、视频、ZIP 与桌面主页批量不经过此回退。

在此配置仍启用时，必须保留原 Vercel 项目与该公开解析地址。Vercel 的函数请求和解析计算仍会计入原平台额度；迁移减少静态与媒体流量，不保证其使用量降为零。

## 沿用环境变量

变量名称见 [`.env.example`](../.env.example)，全部 `AUTH_*` 配置只给主 Worker。Python Worker 不需要账号或 SMTP 密钥。

迁移现有生产服务时，以下值必须从原部署原样迁入：

- `AUTH_SECRET_PEPPER`：不可重新生成。它参与现有会话、验证码、激活码和设备标识的摘要；换值会破坏旧数据的验证。
- `AUTH_GITHUB_OWNER`、`AUTH_GITHUB_REPO`、`AUTH_GITHUB_BRANCH`、`AUTH_GITHUB_PATH`：保持同一权威数据文件。`AUTH_GITHUB_TOKEN` 需要该私有仓库 Contents 读写权限。
- `AUTH_SITE_ORIGIN`：保持 `https://xhs.download.brclio.com`，无路径或末尾斜线；这也是管理员 Cookie 的生产访问来源。
- `AUTH_ADMIN_EMAILS`、设备上限、邮件与发送限额：迁移原值，避免改变管理员权限或现有使用规则。
- `AUTH_ALLOW_INITIALIZE`：已有数据时保持 `false`，不能通过初始化新空库来绕过读取失败。

SMTP 继续使用原来的 `AUTH_MAIL_PROVIDER`、`AUTH_SMTP_HOST`、`AUTH_SMTP_PORT`、`AUTH_SMTP_USER`、`AUTH_SMTP_PASS` 和 `AUTH_MAIL_FROM`。465 使用 TLS，587 强制 STARTTLS。Cloudflare 支持 [Node.js TLS 客户端](https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/)，[TCP 文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)说明 SMTP 25 端口受限；这不能代替真实部署的 SMTP 认证与收件验收。

本轮已实测 Cloudflare 原生 SMTP 的 465 TLS 与 587 STARTTLS。正式账号流程的 `send-code` 返回 200，对应测试邮件确实进入指定测试收件箱 INBOX；该验证码随后成功登录管理员并生成 Secure、HttpOnly Cookie。没有为邮件增加 Vercel 回退或更换原 SMTP 凭据。

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

`pywrangler sync` 为干净检出安装 Python Worker 的 `python_modules`，须先于 `runtime_test.py`。`npm run cloudflare:check` 检查主 Worker 构建；Python dry-run 独立检查 Python 部署包。`npm test` 包含原 Node.js / Python 用例、主 Worker 的接口与环境注入，以及解析回退的来源限制、凭据隔离、大小限制和超时测试。Python `runtime_test.py` 启动隔离的真实 workerd，使用生产入口与解析器，仅替换出站网络为固定测试响应；覆盖图文、实况、音轨元数据、重定向、图片字节、视频分段和响应限额。测试入口不会加入生产包。

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

`cloudflare:verify` 运行 [匿名检查脚本](../scripts/verify-cloudflare.mjs)，默认包含 44 项：页面与资源、后台安全头、两套解析器纯计算路径、错误输入、媒体范围限制、账号 HTTP 门禁。默认不会发送验证码、读取账号存储或修改业务数据；它也不能证明登录、会员或邮件投递正常。

可选参数 `--note-url`、`--image-token`、`--video-url` 指定允许访问的真实小红书素材。每种素材同时验证 Node.js / Python；视频只读取元数据和前 4096 字节，图片读取受大小限制。报告只输出检查名称、状态码与固定失败原因，不输出素材链接、请求体、响应正文或密钥。完整 MP4 音画、浏览器复制与 ZIP 下载仍需真实浏览器验收。

## 部署、切换与回滚

先在正确的 Cloudflare 账号完成 Wrangler 登录并核对账号。保留当前 Vercel 项目、域名绑定和部署，记录切换前的 DNS 记录、代理状态及 Workers 路由。迁移不需要更改数据仓库的 Git 历史。

1. 完成本地测试和两个 dry-run；确认原生产变量能够完整迁入，尤其是 pepper。
2. 先部署 Python，再部署带 Secrets 的主 Worker：

   ```sh
   npm run cloudflare:deploy:python
   npx wrangler deploy --secrets-file "$HOME/.config/brclio/cloudflare-production.env"
   ```

   后续 Secrets 已配置时，`npm run cloudflare:deploy` 会依次部署 Python Worker、主 Worker，并重新构建和部署 Pages。需要同步更新完整 Secrets 时，单独运行上面的 `npx wrangler deploy --secrets-file ...`，再运行 `npm run cloudflare:deploy:pages`；不要向包含多个子命令的 npm 发布脚本透传该选项。

3. 记录两个部署结果和主 Worker 的 `workers.dev` 地址。在该地址执行 `npm run cloudflare:verify -- https://实际主Worker地址 --json`，检查 `/api/health` 返回的平台、版本及 Python 绑定。绑定存在只证明配置已连接，实际 Python 路由仍须通过检查。确认解析回退变量指向原 `.vercel.app` 地址，并通过真实样本核对回退响应和下载字节。
4. 首次创建 Pages 时按 [网关说明](../cloudflare/pages/README.md) 操作；已有项目使用 `npm run cloudflare:deploy:pages` 构建并发布。仅构建使用 `npm run build:cloudflare`。Pages 的 `APP` 必须绑定已部署主 Worker。在实际 `pages.dev` 地址重复匿名与媒体检查；Direct Upload 不会自动配置 Git 推送部署。
5. 核验 SMTP 连接、GitHub 私有仓库读取、真实图文／实况／视频。使用正式 `AUTH_SITE_ORIGIN` 时，其他预览域名的管理员请求应被拒绝；不能为预览方便修改生产 Origin 或弱化来源校验。本轮已完成真实验证码发送、收件、管理员登录和跨后端会话核验，正式域名切换后仍需重验。
6. 先在 Pages 项目添加 `xhs.download.brclio.com` 自定义域名，再在其实际权威 DNS 提供商处把该子域名 CNAME 指向项目返回的 `pages.dev` 主机名；无需为子域名迁移整个根域 DNS。只创建 CNAME 而未在 Pages 注册域名可能返回 522。只修改目标主机名，保留原 DNS/路由记录供回滚；等待 Pages 域名状态、证书与真实 HTTPS 请求均正常。见 [Pages 自定义域名说明](https://developers.cloudflare.com/pages/configuration/custom-domains/)。Python Worker 继续无公开域名。
7. 从正式域名重新运行 44 项检查与真实媒体检查。验证原管理员会话、已安装客户端的现有登录与会员、设备授权、激活码、反馈上传及后台日志查看，并确认测试邮件实际到达。记录有意产生的测试业务操作，避免重复兑换或撤销真实用户设备。
8. 记录正式域名响应、Pages 部署、两个 Worker 版本、SMTP/账号/媒体验收结果与尚未完成项。解析回退仍在使用时保留 Vercel；只有替代路径经过验收且关闭回退后，才可讨论停用。网站迁移完成不等于新桌面安装包发布。

若切换后出现影响使用的问题，按记录恢复原 DNS 与 Workers 路由，使正式域名重新到达保留的 Vercel 部署，并重跑匿名与账号检查。应用回滚仍使用同一最新业务数据；**不得把数据仓库恢复到切换前快照**，否则可能重新启用已消费激活码、旧会话或已撤销设备。两套后端在切换传播期必须使用同一数据文件与原 pepper。

## 成本与免费额度

通过 Pages 正式入口时，普通静态资源由 Pages 提供，`/api/*` 与 `/admin*` 会调用网关和主 Worker；使用主 Worker 的 `workers.dev` 入口时，则由 Static Assets 提供公开静态资源，`run_worker_first` 将 API 和后台请求送入 Worker。后台经过主 Worker 是为了保持安全响应头。Cloudflare 当前说明 Static Assets 静态请求免费且不限量；动态请求、服务绑定和 Pages Functions 应按各自现行计量规则评估，不能把网关视为免费无限后端。`run_worker_first` 匹配的请求超过免费配额时不会回退到静态文件，而会被拒绝。见 [Static Assets 计费说明](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)。

截至 2026-09-23，普通 Workers Free 文档列出的账户请求上限为每日 100,000，单次 CPU 时间为 10 ms。主 Worker 的媒体接口和网关仍受其对应额度约束；账号执行与解析编排已放入 Durable Objects，不能再把普通 Worker 的 10 ms 直接当作这两个运行时的 CPU 上限。应分别观察主 Worker、Python Worker、Pages Functions 与 Durable Objects 的 CPU、错误率和调用量。参见 [当前平台限额](https://developers.cloudflare.com/workers/platform/limits/) 与 [定价](https://developers.cloudflare.com/workers/platform/pricing/)。迁移可减少原 Vercel 的使用量，但不承诺无限免费后端。

GitHub API 与 SMTP 服务原有的限流、容量和发送限制仍存在。访问统计继续使用原独立统计服务，网站托管迁移不修改其部署。

SQLite 类型 Durable Objects 可用于 Workers Free，当前文档默认每次调用最多 30 秒 CPU，但有独立请求、持续时间和存储额度；没有使用 SQL 存储也不代表调用与运行时间不计量。本次已通过账号、完整反馈和解析用例，仍须按真实负载监测两个固定对象的并发及额度。详见 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/) 与 [限额](https://developers.cloudflare.com/durable-objects/platform/limits/)。

## 已有验证记录

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
| 当前主 Worker 部署 | `06db7233-a9b9-4f10-baf2-cbc2d4dd8131` | 已包含 `AccountRuntime`、`ParseRuntime` 和解析回退 |
| Pages 部署 | `c3119c79`（部署标识前缀） | [正式 Pages 入口](https://brclio-xhs-pages.pages.dev)；通过 `APP` 调用主 Worker |
| Pages 线上匿名检查 | 最新版本 44/44 | 已在最终两个 Durable Object 与解析回退部署后复验 |
| Durable Object 完整反馈测试 | 超过 8 MB，64 分片、4 次 GraphQL 查询 | 真实 workerd 中校验全部分片与总摘要，保留同一 GitHub 状态提交 |
| Cloudflare 原生 SMTP | 465 TLS、587 STARTTLS 均通过 | 正式 `send-code` 200，对应测试邮件已在 Gmail INBOX 确认 |
| 管理员验证码登录 | `verify-code` 200，Secure / HttpOnly Cookie | 使用实际收到的测试验证码完成，未记录验证码或 Cookie 值 |
| 同一测试会话跨后端读取 | Cloudflare 与 Vercel 均成功 | `me`、3 用户、4 激活码、1 反馈及管理员状态读取一致；GitHub / SMTP 状态正常 |
| 正式域名切换 | 域名与证书 ACTIVE，HTTPS 健康检查 200 | `/api/health` 确认 Cloudflare 及主 Worker 版本 `06db7233-a9b9-4f10-baf2-cbc2d4dd8131`；正式域名 48/48 检查通过，包含真实笔记与图片；[完整结果](cloudflare-validation.json) |
| 切换后正式域名账号 | 全部 200 | 原测试会话可读取用户、激活码、反馈；GitHub 与 SMTP 均正常 |
| 浏览器实际 ZIP 下载 | 837,420 字节，CRC 全部有效 | 6 张 JPEG 的文件签名完整，另含 1 份文案 TXT |

本轮未获取真实视频／实况样本；视频分段、范围、音轨和实况结构使用运行时固定样例验证，未把它写成真实 MP4 音画验收。桌面安装包版本不变，本轮不重新发布客户端。
