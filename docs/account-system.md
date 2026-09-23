# 软件账号、会员与人工发码

## 目录和部署边界

本项目支持 **Vercel 或 Cloudflare Pages + Workers，以及 Electron**。代码继续放在当前仓库，业务数据放在另一个不关联自动部署的 GitHub 私有仓库。不接入支付系统，GitHub 仍是唯一业务存储，不迁入 D1 或 Redis。Cloudflare 的部署、原环境迁移和切换核验见 [Cloudflare 部署说明](cloudflare-deployment.md)；原 Vercel 部署流程保留，笔记解析还可能使用原 Vercel 的同引擎 JSON 回退。

| 文件或目录 | 用途 | 发布到 |
| --- | --- | --- |
| `api/account.js`、`server/auth/` | 邮箱登录、会员、设备、激活码、管理员权限、GitHub 存储 | Vercel 服务端函数，或主 Worker 私有 `AccountRuntime` 执行环境 |
| `cloudflare/account-runtime.js` | 私有账号 Durable Object，不使用其存储 | 主 Worker 的 `ACCOUNT_RUNTIME` 绑定 |
| `admin/` | 管理网页 | Vercel 静态目录，或经 Pages 网关与主 Worker 提供；保留后台安全响应头 |
| `cloudflare/pages/` | 自定义域名入口 | Pages；API 与后台请求通过 `APP` 服务绑定交给主 Worker，不持有账号 Secrets |
| `desktop/`、`account-ui.*` | 本地安全存储、软件账号界面、实际业务授权检查 | Electron 安装包 |
| `lib/membership-policy.js` | 集中配置会员保护范围 | 后端与桌面共用 |
| `deploy/build-web.mjs` | 将允许公开的网页文件复制到 `dist-web/` | 构建工具 |
| `docs/`、`test/`、`dist-desktop/`、`desktop-runtime/` | 文档、测试、安装包与内置运行环境 | 不作为网站文件发布 |

`vercel.json` 指定 `dist-web/` 为静态输出目录，根目录 `api/` 由 Vercel 单独构建函数并追踪服务端依赖。`.vercelignore` 排除桌面代码、运行环境、安装包、测试、文档与环境文件；安装时 `npm ci --omit=dev --ignore-scripts` 不下载 Electron。Electron `build.files` 使用独立白名单，不包含授权后端、管理员页面、环境文件或数据仓库。

Cloudflare 使用同一 `dist-web/` 白名单和账号处理器，主 Worker 注入请求自己的 `env`，并使用平台覆盖的 `cf-connecting-ip`。Pages 可接收外部 DNS 的子域名 CNAME，先在 Pages 注册自定义域名，再指向实际 `pages.dev` 主机；网关保留 Origin、Cookie、签名请求字节和响应头，不放宽账号同源校验。现有 Vercel 的环境读取与可信 IP 路径不变。迁移时保持原 `AUTH_SECRET_PEPPER`、GitHub 数据文件、管理员名单和准确的 `AUTH_SITE_ORIGIN`；已有账号不能重新生成 pepper 或初始化空库。正式域名不变时，原客户端授权地址与管理员 Cookie 可以继续使用，仍需线上核验旧会话与设备授权。

SQLite 类型 Durable Object `AccountRuntime` 已部署，用于账号和完整反馈校验的独立执行环境；主 Worker 通过 `ACCOUNT_RUNTIME` 调用固定对象 `accounts-v1`。代码不读写 Durable Object 存储，账号和反馈仍使用同一 GitHub 权威文件。解析另由 `ParseRuntime` 处理，不与账号接口混用。超过 8 MB、接近 8 MiB 的 64 分片反馈已在真实 workerd 中通过完整校验，GitHub GraphQL 分 4 次查询读取，未缩减日志内容。

本轮主 Worker 版本 `06db7233-a9b9-4f10-baf2-cbc2d4dd8131` 已完成真实验证码发送、收件与管理员登录；同一测试会话在 Cloudflare 和 Vercel 均成功读取账号与后台数据。正式域名已切到 Pages，域名和证书状态为 ACTIVE，HTTPS 健康检查确认该 Cloudflare 版本。正式域名账号同源策略与已安装客户端的切换后验证，继续按 [迁移验收记录](cloudflare-deployment.md#已有验证记录) 标明范围。

笔记解析回退只允许原 Vercel 的 `/api/parse` 和 `/api/python_parse`，**不包含 `/api/account`**，也不转发 Cookie、账号授权头或业务数据。该回退不能作为账号或邮件故障的替代路径；账号迁移必须单独验收。

默认 **主页批量下载需要会员及已绑定设备，单篇下载免费**。修改 `lib/membership-policy.js` 后须同步部署后端并重新打包客户端。原下载功能实现保留；权限不通过删除功能来实现。已安装旧版本无法被新代码远程改变。

## GitHub 数据仓库与最小权限

1. 新建独立私有仓库，例如 `xhs-account-data`，用 README 初始化，确保目标分支存在。不要将它连接 Vercel、开启 Pages 或公开可读权限。
2. 创建 fine-grained PAT，仅选择该数据仓库，授予 **Contents: Read and write**。Metadata 只读由 GitHub自动提供。不需要代码仓库、Actions、Issues、Pull requests 或 Administration 写权限。
3. 将令牌仅保存到所用服务端平台的 `AUTH_GITHUB_TOKEN`（Vercel 环境变量或 Cloudflare 主 Worker Secret）。后端使用它访问 GitHub，桌面和网页不直接访问数据仓库。
4. 设置 `AUTH_GITHUB_OWNER`、`AUTH_GITHUB_REPO`、`AUTH_GITHUB_BRANCH`（默认 `main`）、`AUTH_GITHUB_PATH`（默认 `state/accounts.json`）。后端检查仓库确为私有，否则拒绝读取和写入业务数据。
5. 首次初始化将 `AUTH_ALLOW_INITIALIZE` 设为 `true`。首次成功业务写入创建状态文件。确认创建后设回 `false` 并重新部署；之后文件丢失报错，不会静默创建空库。

不能手工回滚数据分支或用旧快照覆盖当前状态，这会重新启用旧会话、已使用激活码或已撤销设备。数据恢复应先暂停服务，审计并合并最新兑换与撤销记录。Git 历史中保留业务数据，删除工作树里的记录不等于删除 Git 历史。

## Vercel 与管理员初始化

1. 继续使用原 Vercel 项目和当前代码仓库，Node.js 22 或更新版，仓库 `vercel.json` 提供安装、构建、输出目录、函数及安全响应头配置。
2. 按 `.env.example` 在 Vercel 项目中配置环境变量。Production / Preview 使用不同数据仓库与密钥。不要将实际 Secret 填进示例文件、网页或安装包。
3. `AUTH_SITE_ORIGIN` 设置为管理员页面准确的 HTTPS Origin，如 `https://download.example.com`，不带路径或结尾斜线。管理员 cookie 使用 HttpOnly、Secure、SameSite；写接口校验来源。
4. **全新账号服务**的 `AUTH_SECRET_PEPPER` 使用至少 32 字节的高熵随机值。可在安全终端生成 `openssl rand -hex 32` 并直接配置到平台。迁移现有服务须原样保留旧值；此值用于验证码、会话和激活码摘要，变更会使旧摘要无法验证，需要计划维护。
5. `AUTH_ADMIN_EMAILS` 填写管理员邮箱，多个用逗号分隔。角色由服务端配置决定，每次管理员操作重新检查，前端没有提升角色接口。空名单不允许任何管理员。
6. 执行 `npm test`、`npm run build:web`，按原项目流程部署。访问 `/admin/`，管理员通过邮箱验证码登录后，可以搜索用户、开通会员、生成激活码。
7. 验证真实邮件、GitHub 写入、管理员操作、兑换和解绑后，执行 `node scripts/configure-account-endpoint.mjs https://实际域名/api/account`，再重新打包客户端。配置文件只包含公开服务地址。地址尚未配置时会员功能拒绝运行，免费单篇下载可用。

部署说明：[Vercel 输出目录](https://vercel.com/docs/builds/configure-a-build#output-directory)、[GitHub Contents API](https://docs.github.com/en/rest/repos/contents)、[Cloudflare 部署与核验](cloudflare-deployment.md)。Cloudflare 已有共享账号后端的适配入口；切换整个授权域名时保持单一权威存储，不复制或回滚业务状态。

GitHub 自动部署需在 Vercel 账号中连接有权限的 GitHub 身份，再在现有项目 Settings → Git 中关联**代码仓库**，生产分支设为 `main`。之后推送 `main` 才会触发生产构建；本机仅修改文件不会触发。业务数据仓库不关联 Vercel。`.vercelignore` 控制部署上传内容，本身不负责阻止代码仓库某次推送触发构建。桌面安装包仍需单独打包，网站自动部署不会自动替换用户已安装的客户端。

## 邮件服务

支持 SMTP、Resend 和自有邮件网关。使用 Gmail SMTP 时设置 `AUTH_MAIL_PROVIDER=smtp`、`AUTH_SMTP_HOST=smtp.gmail.com`、`AUTH_SMTP_PORT=465`、`AUTH_SMTP_USER` 为发信邮箱、`AUTH_SMTP_PASS` 为启用两步验证后生成的应用专用密码，`AUTH_MAIL_FROM` 使用相同邮箱。仅在服务端平台 Secrets 保存应用密码。端口 465 使用 TLS，587 强制 STARTTLS，保持证书验证；SMTP 日志关闭。Cloudflare 沿用同名配置，不使用 Vercel 邮件回退。

本轮真实 Cloudflare 运行时中，465 TLS 和 587 STARTTLS 均验证成功。正式账号接口 `send-code` 返回 200，对应测试邮件在 Gmail INBOX 中确认收到；使用该验证码调用 `verify-code` 返回 200，获得 Secure、HttpOnly 管理员 Cookie。同一 Cookie 在两套后端均可读取 `me`、管理员用户、激活码、反馈和服务状态；本次读到 3 个用户、4 个激活码、1 条反馈，GitHub 与 SMTP 状态正常。以上仅记录数量与状态，不在文档保存邮箱、验证码、会话或凭据。

使用 Resend 时先验证发信域名，设置 `AUTH_MAIL_PROVIDER=resend`、`AUTH_MAIL_FROM`、`AUTH_MAIL_API_KEY`，密钥只需邮件发送权限。服务商接收不代表收件箱投递成功，正式验收必须使用真实邮箱。

注册与登录使用统一验证码邮件正文：首段保留验证码、有效期、仅能使用一次、首次验证创建账号及非本人操作可忽略的说明；底部依次增加编程私教咨询（微信 `Jiabcdefh`）、新书推荐《编程启蒙：思维与代码》，以及中英文“这不是垃圾邮件 / Not spam”提示。SMTP 与 Resend 直接发送同一正文。

替换邮件供应商可使用自有 HTTPS 网关：设置 `AUTH_MAIL_PROVIDER=webhook`、`AUTH_MAIL_WEBHOOK_URL`、`AUTH_MAIL_WEBHOOK_SECRET`。网关接收 Bearer 认证和 `Idempotency-Key` 头，请求体保留 `email`、`code`、`expiresInMinutes`、`deliveryId`、`template: account-login`，另提供与 SMTP、Resend 一致的 `subject` 和完整 `text`；网关应直接复用这两个字段以保持统一模板，接受发送后返回成功状态。网关不要记录邮件正文、验证码或认证头。

默认验证码有效 5 分钟，发送间隔 60 秒，每邮箱每小时最多 6 次、每 IP 每小时最多 20 次、全局每小时最多 200 次。单次验证码最多 5 次校验失败。限制保存在 GitHub 中，多个后端实例共享；IP 仅存服务端摘要。平台 WAF 可额外限制请求量，不代替业务限制。邮件发送失败有明确提示，验证码不以明文保存在 GitHub，也不返回客户端。

## 永久会话与设备绑定

软件账号与本机小红书登录完全独立。授权服务不接收小红书 Cookie、下载内容、任务路径或其他无关本机数据。

服务器生成高熵随机会话令牌，不设置固定到期时间，只保存安全摘要。桌面主进程用 Electron `safeStorage` 加密保存令牌与设备 Ed25519 私钥；渲染层只接收展示状态。Mac 使用 Keychain，Windows 使用 DPAPI；安全存储不可用时拒绝保存，不退回明文。会员时间始终由服务器判断，身份保持登录不会使会员永久有效。

设备使用本地持久密钥及应用域隔离后的稳定机器标识散列。Mac 读取 IOPlatformUUID，Windows 读取 MachineGuid，仅发送处理后的摘要、公钥、系统类型及必要设备名称，不上传原始硬件标识。稳定标识不是远程硬件认证，不能保证阻止恶意修改客户端的人伪造硬件信息。

保持原 `appId`、内部应用名称与用户数据目录不变，正常重开和覆盖安装沿用加密凭据。清空数据、重装系统或系统凭据丢失可能要求重新登录，但后台设备名额不会因此释放。正式 macOS 发布应使用稳定 Developer ID 签名；[Electron 官方说明](https://www.electronjs.org/docs/latest/api/safe-storage)指出代码签名影响 macOS 安全存储的一致性，未签名包不作为跨升级 Keychain 完整验收结论。

默认一账号一设备，可用 `AUTH_DEVICE_LIMIT` 配置。检查名额、建立绑定与消费登录验证码在一次状态提交中完成。名额满时新设备可以查看账号和会员、兑换激活码，但授权被拒绝。退出登录不会释放设备名额；普通用户没有解绑或抢占接口。

管理员解绑记录原因和撤销标记。旧设备保留身份也不能继续取得设备授权，自动刷新不会申请绑定。换机设备必须主动完成邮箱登录才会申请空出名额，旧设备凭原密钥或原稳定标识重登不会抢回名额。重新安装丢失设备私钥时，需要管理员处理，不能仅凭声称同一机器绕过校验。

同一台机器重装后丢失密钥的恢复流程：用户在新安装中完成邮箱登录，管理员在用户详情核对待授权设备名称、系统和申请时间，先解绑占用名额的旧设备，再选择该待授权会话进行“授权新设备密钥”，填写原因并确认。服务端只恢复选定的新密钥会话，拒绝任何已经绑定过或撤销过的旧密钥；检查空位与恢复在同一次 SHA 更新中完成。原在线会话、原密钥重登、其他待处理会话均不会随之获权。管理员不需要删除撤销记录。

受保护操作在主进程、下载任务入口及运行检查点检查服务端；持续任务定期复查授权，防止长时间离线使用旧权限。已经发送的媒体字节不会被追溯收回，后续受保护操作在检查失败后停止，已存文件和进度保留。离线点击退出会立即停止本机授权；远程撤销未确认时保留加密待撤销记录并提示，恢复联网后重试。

运行中的任务每 30 秒重新校验，网络请求超时为 15 秒；正常撤销传播最多约 45 秒，若需要一次服务器时钟校准重试则最多约 60 秒。新任务、继续、失败重试以及媒体下载入口另行检查。设备列表的最近校验时间最多每 24 小时写入一次，属于粗粒度记录，不应当作每次心跳的实时日志。

## 会员和激活码

管理员可按邮箱或用户 ID 搜索，查看注册时间、会员与设备。会员可设为永久、指定天数、指定到期时间，支持延长、缩短、取消。变更原因必填，取消、缩短与解绑需确认；审计记录管理员、时间、原因、前后内容。

激活码支持密码学随机生成，单个或批量。新生成的激活码统一以 `Brclio-` 开头，已发放的 `XHS-` 旧码仍可兑换；兑换不区分大小写，并忽略首尾空白。原码只在本次生成时展示、复制和导出；数据库只保存摘要和元数据。刷新页面无法找回原码。生成响应丢失时按相同请求 ID 重试不会重复生成一批码；若原码无法恢复，查询该批元数据、作废未使用码后重新生成。

“兑换截止时间”是激活码自身的使用期限，与兑换后的会员有效期分开。时长码从成功兑换开始计时，续期从服务器当前时间与原到期时间较晚者开始。永久会员兑换时长码会明确拒绝并不消耗。激活码不改变设备上限，也不解除设备撤销。

兑换使用持久 `requestId` 实现网络重试幂等。相同账号、相同请求 ID 返回之前已提交结果，不重复续期；其他账号、另一次请求均不能重新消费已用码。仅未使用码可以作废，已用码不能恢复。激活码消耗与权益增加在同一原子提交中完成。

## 一致性、故障与容量

所有需要跨记录一致的数据位于一个权威 JSON 文件。读取文件及 SHA → 重新校验业务条件 → 一次带 SHA 更新提交。冲突后有上限地重新读取并重做全部校验，不能重用旧状态覆盖。验证码消费、设备名额和激活码兑换都以这个提交为事务边界，不依赖进程内存锁。

授权状态读取不缓存会员权益或设备授权。最近校验时间粗粒度持久化，普通心跳只读，避免每次心跳都提交 Git。超时、限流、写入失败或重试耗尽时返回错误，不返回虚假成功。写入响应丢失可能意味着提交已落盘；客户端须保留原请求 ID重试或刷新状态。

当前适合低写入量的人工会员管理。单状态文件、GitHub API 配额、写入冲突和 Git 历史增长构成容量限制；状态文件设安全容量上限，超限拒绝新增写入并报错，绝不清空或截断业务记录。需监控文件体积和剩余 API 配额，提前处理历史数据治理，不能随意删去已用码或撤销记录。故障不改变会员类型，不把异常用户设为永久会员。

## 验证与打包

```bash
npm test
npm run build:web
npm run desktop:verify
node scripts/configure-account-endpoint.mjs https://实际域名/api/account
npm run desktop:build:mac
npm run desktop:build:win
```

Mac / Windows 安装包内置 Electron、Node 和 Python，用户无需安装开发环境。Windows 跨打包只能证明文件生成和静态检查，不能代替 Windows 原生启动、DPAPI、重启和覆盖升级验收。实际本轮结果见 `docs/account-validation.md`；状态结构见 `docs/account-data.md`。
