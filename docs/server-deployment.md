# 独立服务器部署与 GitHub / SQLite 迁移

本项目新增独立服务器入口，提供网站、管理员后台、问题广场、账号接口和 Node / Python 两套媒体 API。默认将业务状态和反馈日志保存在本机 SQLite，第一次启动自动创建目录、数据库和表；也可以继续使用 GitHub 私有业务仓库。

现有 Vercel、Cloudflare Pages / Workers 和客户端部署流程保持原样，仍使用现有 GitHub 存储。新入口不会修改线上环境、域名、客户端授权地址或 GitHub 数据；只有管理员执行迁移命令的 `--apply` 才写迁移目标。

## 环境和首次启动

服务器需要 Node.js **22.13 或更新版**（推荐 Node.js 24 LTS）和 Python 3.10+。SQLite 使用 Node 内建模块，不需要安装数据库服务或编译原生 npm 扩展。[Node SQLite 文档](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)说明了所需版本。

```sh
npm ci --omit=dev --ignore-scripts
npm run build:web
cp .env.example .env
chmod 600 .env
# 编辑 .env，填入下面列出的服务端配置
npm run start:server
```

`start:server` 和 `migrate:storage` 自动读取当前目录的 `.env`；进程已有的环境变量优先。不修改原来的 Node engine 要求和 Vercel 安装命令。媒体文件仍按请求代理，不会作为下载结果保存在 SQLite。

最小配置示例：

```dotenv
HOST=127.0.0.1
PORT=3000
AUTH_STORAGE_DRIVER=sqlite
AUTH_SQLITE_PATH=./data/accounts.sqlite
AUTH_SECRET_PEPPER=替换为至少32字节的服务端随机密钥
AUTH_SITE_ORIGIN=https://download.example.com
AUTH_ADMIN_EMAILS=admin@example.com
AUTH_MAIL_PROVIDER=resend
AUTH_MAIL_FROM=Brclio <accounts@example.com>
AUTH_MAIL_API_KEY=替换为邮件服务密钥
```

- **全新服务**可以用 `openssl rand -hex 32` 生成 pepper；**迁移旧服务必须使用原 `AUTH_SECRET_PEPPER`**，否则已有会话、验证码和激活码摘要无法验证。
- SQLite 模式不需要 GitHub 凭据，也不需要 `AUTH_ALLOW_INITIALIZE=true`。损坏或格式不兼容的数据库会报错，不会被自动重置为空库。
- 管理员和网页账号登录沿用 HTTPS Origin、Secure Cookie 和来源校验，`AUTH_SITE_ORIGIN` 必须与访问域名完全一致，不带路径或末尾斜线。
- 邮件配置与原部署完全相同，SMTP / Resend / 邮件网关均可；详见[账号系统](account-system.md#邮件服务)。未配置邮件时不能完成验证码登录。
- `AUTH_STORAGE_DRIVER=github` 只改变独立服务器的存储选择，还需原来的 `AUTH_GITHUB_*`。默认 Vercel / Cloudflare 入口不读取这个开关。

## HTTPS 与反向代理

Node 服务默认只监听 `127.0.0.1:3000`。生产环境在前方配置 Nginx 或 Caddy 的 HTTPS；不要直接向公网暴露本地 HTTP 端口。以下是 Nginx 已配置证书的 `server` 内反代示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 此示例为单层公网反代，覆盖外部传入的转发头。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 70s;
    client_max_body_size 2m;
}
```

如需用访客 IP 进行验证码限流，设置 `SERVER_TRUST_PROXY=127.0.0.1,::1`，或填入实际代理的 IP / CIDR。默认忽略转发头，使用连接来源 IP。容器网络下应填真实且固定的代理网段；不要配置全网信任。网站仅从 `dist-web` 提供静态文件，数据库、备份、服务端代码和 `.env` 均不可通过 HTTP 下载。

启动时检查 Python 能否加载解析、图片、视频 API 模块，失败则拒绝启动。健康探针：`GET /healthz` 检查进程存活，`GET /readyz` 检查当前存储是否可读。上线后还应使用测试账号检查收件、登录、会员授权、后台状态及两套解析引擎；探针不代表邮件投递或小红书上游访问成功。

可选运行参数：`PYTHON_BIN` 指定解释器；`SERVER_MEDIA_TIMEOUT_MS` 默认 25000、`SERVER_REQUEST_TIMEOUT_MS` 默认 60000；Node / Python 同时运行的媒体请求分别由 `SERVER_NODE_CONCURRENCY=4`、`SERVER_PYTHON_CONCURRENCY=2` 限制，总请求并发由 `SERVER_MAX_REQUESTS=32` 限制。媒体超时会终止对应工作线程或子进程，账号事务超时可能已经提交，按原请求 ID 重试确认。

## Docker Compose

仓库提供 `Dockerfile` 和 `compose.yaml`。镜像安装 Python 和生产 Node 依赖、构建静态白名单，使用非 root 用户运行，并将 SQLite 数据保存到持久卷。

```sh
cp .env.example .env
chmod 600 .env
# 编辑 .env：配置 pepper、站点 HTTPS Origin、管理员、邮件
# 首次迁移已有账号时，先按下文停写并迁移，再开放新入口。
docker compose up -d --build
docker compose logs --tail=100 web
```

容器重建不会清空 `account-data` 持久卷。不要执行 `docker compose down -v` 来更新应用，这会删除数据库卷。容器内固定数据库路径为 `/app/data/accounts.sqlite`，主机上的 `./data` 不是这个命名卷。

迁移时使用相同镜像和卷，先停止服务器，再用临时容器执行命令；新部署执行 `docker compose build` 后即可迁移，无需提前启动空库服务器：

```sh
docker compose stop web
# 先不加 --apply 预览，再执行。反向迁移交换 from/to 即可。
docker compose run --rm --no-deps web node scripts/migrate-account-storage.mjs --from github --to sqlite
docker compose run --rm --no-deps web node scripts/migrate-account-storage.mjs --from github --to sqlite --apply
docker compose up -d web
```

迁移备份默认同样保存在该卷的 `/app/data/migration-backups/`。已有 GitHub 服务也必须暂停写入，`docker compose stop web` 只停止这个 Compose 项目的服务。

## 双向迁移

迁移内容包括用户、会员、会话摘要、设备、验证码记录、激活码、幂等回执、限流、审计、反馈原文、回复、公开评论，以及反馈日志分块。进行中的反馈已经上传的分块也会保留；已完成反馈缺片、字节数不符或校验失败时拒绝迁移。业务 `schemaVersion: 1` 和未知扩展字段保留，不重新计算账号标识或密钥摘要。

配置 GitHub 凭据时复用原 `AUTH_GITHUB_OWNER`、`AUTH_GITHUB_REPO`、`AUTH_GITHUB_BRANCH`、`AUTH_GITHUB_PATH` 和 `AUTH_GITHUB_TOKEN`。目标必须为私有业务仓库，分支已存在；令牌只需指定仓库的 Contents 读写和 Metadata 只读权限。不要使用关联网站自动部署的代码仓库。

### GitHub → SQLite

```sh
# 只读预览，不创建 SQLite 数据库或写 GitHub
npm run migrate:storage -- --from github --to sqlite --sqlite-path ./data/accounts.sqlite

# 校验后执行，自动创建 SQLite 目录、数据库和表
npm run migrate:storage -- --from github --to sqlite --sqlite-path ./data/accounts.sqlite --apply
```

### SQLite → GitHub

```sh
npm run migrate:storage -- --from sqlite --to github --sqlite-path ./data/accounts.sqlite
npm run migrate:storage -- --from sqlite --to github --sqlite-path ./data/accounts.sqlite --apply
```

默认拒绝非空目标，防止把现有账号覆盖掉。确需完整替换时，先停止目标和源端业务写入，再加 `--replace`；覆盖前自动生成目标的完整 JSON 快照，默认放在 `data/migration-backups/`，也可用 `--backup-dir` 指定。新目录权限 0700，快照权限 0600；已有备份目录必须先设为 0700，否则拒绝覆盖。备份包含私人业务信息，只能保存在服务器私有目录。迁移是**完整快照替换**，不会自动合并两个系统的账号或持续同步。

覆盖前先将备份文件刷入磁盘；支持目录同步的平台还会同步备份目录和本次新建的上级目录，确保目录项在替换前持久化。Windows 下 Node 不支持目录句柄同步，仅执行文件同步，仍应保留独立的服务器备份。

```sh
npm run migrate:storage -- --from sqlite --to github --apply --replace --backup-dir ./data/migration-backups
```

GitHub 导出锁定同一个提交读取。SQLite 导入在单次数据库事务中提交；GitHub 导入将业务 JSON 与全部日志放入同一个 Git 提交，再以 `force:false` 更新分支。目标发生并发写入时拒绝覆盖，不会逐个业务文件发布半份数据。[GitHub 引用更新文档](https://docs.github.com/en/rest/git/refs#update-a-reference)说明了非强制更新的保护行为。

预览和备份完成后、目标写入前还会复查源版本；源在此期间有新提交或 SQLite 写入时，命令拒绝迁移并保留目标，已生成的备份仍可用于核对。这项检查不能锁定后续源写入，仍必须暂停源端全部写入入口。GitHub 导出会按不可变 blob SHA 复用相同内容，保留所有原分块路径；大量不同日志仍会占用 API 请求额度，额度或网络错误会停止命令，不会截断日志后继续迁移。

GitHub 的原业务 JSON 上限仍为 **900,000 字节**；SQLite 允许更大的状态，但超过 GitHub 上限时不能迁回 GitHub，命令会拒绝并保留目标。先根据预览处理容量问题，不能通过截断账号、会话或审计来迁移。

## 现有服务切换步骤

1. 提前构建新服务器，保留原密钥、管理员名单、邮件配置和准确的站点 Origin；先使用空测试库完成独立联调。
2. 正式迁移前暂停**所有共用源数据的写入入口**。原 Vercel 和 Cloudflare 可能共用一个 GitHub 数据仓库，仅停网页不足以阻止旧客户端继续写入。
3. 预览并执行迁移，检查数量和最终成功结果。不要在迁移后让 GitHub 与 SQLite 两份库分别接收新业务写入。
4. 只将需要切换的访问入口指向新服务器，验证原会话、设备绑定、会员、反馈全文和完整日志。切换域名时另行处理客户端授权地址；相同域名仍需核验 Cookie 与 Origin。
5. 保留原部署作为回退程序。若 SQLite 已接收新数据，回退前必须停写并将**最新 SQLite 状态迁回 GitHub**，再恢复旧入口；直接启用旧快照会丢失新兑换、撤销和会话状态。

新增服务器支持本身无需停用原部署。只有实际把同一套业务从 GitHub 切到 SQLite 时需要上述维护窗口，以保持单一业务数据来源。

## 备份与运行限制

SQLite 应放在服务器本地持久磁盘，不放临时目录、网站静态目录或跨机器共享网络文件系统。支持同一本机多连接并发，写事务按版本校验并重试，仍应采用单服务实例配持久卷的部署方式。

数据库使用 WAL；运行时不能只复制 `.sqlite` 主文件作为完整备份。最简单的文件备份方式是停止服务，完整备份数据目录后再启动；也可以使用 SQLite 官方在线备份工具。恢复时停写并保留当前副本，再验证账号、兑换与撤销记录，不应将过期备份当作当前状态。

任何迁移错误都应先检查预览和目标状态，再决定是否重试。写入响应中断时不要仅凭网络错误认定没有写入；重新只读预览或比较当前提交，确认已提交结果后再切换流量。

## 本地验证记录

2026-09-29 的历史验证记录：

- `npm test`：690 项 Node 测试、21 项 Python 测试通过；7 项原有 macOS / Electron 原生安装测试按条件跳过。
- 新增 SQLite、账号集成、服务器 HTTP 与迁移测试在 Node 22.13.1 下通过，覆盖持久化、并发兑换、故障回滚、双向迁移、分块完整性、覆盖备份、私有路径和媒体二进制。
- `npm run build:web`、`npm run build:cloudflare`、`npm run cloudflare:check` 通过；后者为 dry-run，没有发布。
- 实际启动独立 SQLite 服务器，浏览器确认首页、问题广场及管理后台正常渲染、导航可用，无脚本错误。账号事务另由真实服务 + SQLite 集成测试验证；未执行真实邮件发送。
- GitHub 迁移使用模拟 GitHub API 与真实 SQLite 验证，没有读写生产业务仓库；本机没有 Docker，镜像尚未实构建或运行。

2026-10-02 提交前复核：

- 在隔离源码副本中执行 `npm test`，846 项 Node 测试和 27 项 Python 测试通过；8 项 macOS / Electron / Windows 原生测试按条件跳过。副本只包含本次后端改动，未混入另一个任务正在修改的桌面登录清理功能。
- 在最低支持版本 Node 22.13.1 中执行 SQLite、账号、迁移、独立服务器、会员视频和部署边界专项测试，76 项全部通过，无跳过。
- `npm ci --omit=dev --ignore-scripts` 安装成功；仅使用生产依赖构建网站并启动真实 SQLite 服务器，HTTP 联调通过：首页、会员介绍、问题广场、管理页、健康与就绪检查、公开账号接口、Node / Python 解析、访客会员权限拒绝、数据库重启持久化及私有文件权限。
- `npm run build:web`、`npm run build:cloudflare` 与 `npm run cloudflare:check` 通过。Cloudflare 检查为 dry-run。
- 修复并回归验证会员视频上游停滞时的超时终止、断连释放和并发上限；账号事务在关闭服务时仍等待安全完成。迁移增加源版本复查和备份目录同步，保留未知业务字段与完整日志；所有迁移检查均使用合成数据、模拟 GitHub API 与真实临时 SQLite。
- 用 Git 的实际忽略检查与 Docker 官方 `moby/patternmatcher` 验证嵌套数据库、WAL、私有配置和备份排除规则。当前机器仍未安装 Docker，未构建或运行容器镜像。

本次未执行独立服务器生产部署或真实业务数据迁移。
