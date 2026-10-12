# 头像与原图收藏存储

内置头像选择只在现有账号数据中保存 `kind` 和 `id`。所有自定义头像原图、压缩图、收藏清单和清理进度都保存在**现有 GitHub 私有数据仓库**的独立 `avatars/` 前缀，复用账号服务的 `AUTH_GITHUB_OWNER`、`AUTH_GITHUB_REPO`、`AUTH_GITHUB_TOKEN`、`AUTH_GITHUB_BRANCH`（默认 `main`）。不创建新的存储服务、桶、数据库或 Durable Object 存储。

存储适配器位于 `server/auth/github-avatar-storage.js`，每个请求先核实仓库仍为私有，凭据只发送到固定 `api.github.com`，禁止自动跟随重定向。账号 API 与 Pages 的现有服务绑定保持不变。`GET /api/health` 的 `avatars.customUploads` 表示 GitHub 凭据是否已配置；真实可读性由 `/api/account_avatar` 路由验证。缺少配置时自定义上传明确报 `AVATAR_STORAGE_UNAVAILABLE`；内置头像和原有账号、会员、下载功能仍正常。

## 上传和显示

- 原图最大 **104857600 字节（100 MiB），包含边界值**，支持 JPEG、PNG、WebP、GIF；服务端同时验证图片魔数与声明格式。
- 客户端生成独立的 256 × 256 静态 WebP（必要时 PNG）。服务端限制衍生图最大 512 × 512、256 KiB，并校验格式、容器、静态帧和尺寸；PNG 另校验 CRC 和有界解压结果。
- 原图以不超过 3 MiB 的不可变分块上传，最大原图共 34 块，不进入账号 JSON。开始上传时一次 Git tree commit 原子创建临时清单与空分块占位；实际上传只允许用空 blob 的 SHA 条件替换。重复上传同一分块只允许相同字节。
- GitHub Contents 对超过 1 MiB 的普通 JSON 读取可能返回 `encoding: none`；本适配器在固定 API 地址使用 `Accept: application/vnd.github.raw+json`，单次准确读取完整 3 MiB，避免额外下载链接和二次 Git Blob 请求。
- 完成前服务端顺序读取分块，核对总长度并计算完整原图 SHA-256。收藏的原图字节不经过 Canvas、重新编码或元数据转换。
- 账号记录只保存当前头像指针、版本号及有界的上传配额。原图、压缩图和收藏清单都在 GitHub；界面取压缩图，桌面桥将其转换为 Blob URL，原图不参与界面显示。
- 同账号最多 3 个未完成上传、每小时 6 次和每天 10 次自定义上传。内置头像选择不受该配额影响。

## 私有原图收藏

完成的收藏不会因用户更换头像、选择内置头像或退出登录而删除。仓库的 `avatars/collection/` 保存私有清单，`avatars/originals/` 保存原始分块，`avatars/thumbnails/` 保存压缩图；只有压缩图路由可以不带账号凭据访问。收藏和待上传清单按头像 UUID 的前四位分成两级目录（256 × 256 分片），列表只读取目录元数据和当前页清单，绝不读取原图。目录到 GitHub 的 1,000 项边界时明确报安全容量错误，禁止将可能截断的结果误认为完整列表。

账号 HTTP API 保持原有 `POST /api/account` 认证方式。浏览器使用安全 Cookie 和准确 Origin，桌面使用 Bearer 会话和设备签名。

| action | input | result |
| --- | --- | --- |
| `avatar-select` | `expectedUserId, builtinId` | `profile.avatar` |
| `avatar-begin` | `expectedUserId, name, contentType, bytes` | `upload: {id,url,partBytes,partCount,maxBytes,expiresAt}` |
| `avatar-complete` | `expectedUserId, uploadId` | `profile.avatar` |
| `avatar-cancel` | `expectedUserId, uploadId` | `cancelled` |
| `avatar-original` | `expectedUserId` | 当前头像原图的 `url,name,bytes,contentType,sha256` |
| `avatar-capabilities` | `expectedUserId` | `builtinCount,customUploads,maxOriginalBytes` |
| `admin-avatar-list` | `limit`（1–50，可省略，默认20）、`cursor`（可省略） | `avatars,cursor` |
| `admin-avatar-original` | `avatarId` | 收藏原图的 `url,name,bytes,contentType,sha256` |

管理员列表项包含 `id,userId,ownerEmail,name,contentType,bytes,sha256,collectedAt,thumbnailUrl`。每页最多读取 30 条清单、8 个目录；请求 `limit: 50` 仍返回安全范围的一页与继续游标。目录扫描预算耗尽时也返回可继续游标，可能出现空中间页。普通用户、未登录访客及桌面会员会话均不能调用管理员收藏接口。

原图下载 URL 是通过认证后签发的 120 秒单文件能力凭据，不能列举其他文件，也不是固定公开原图地址。服务端以附件和 `application/octet-stream` 返回原图，禁止缓存并设置 `Referrer-Policy: no-referrer`。GitHub 数据仓库、token、原始 Contents URL 都不会返回客户端。

## 中断和清理

上传能力凭据两小时过期。取消上传会撤销未完成状态；过期对象保留至少五分钟宽限。每小时第 17 分钟的 Worker 定时任务扫描一页、最多两条待上传记录，并将继续游标保存在 `avatars/system/cleanup.json`；游标不变时不创建新 commit。清理在同一 Git commit 快照检查收藏清单，然后用 Git Trees 批量删除未完成分块并以非强制分支更新提交；并发收藏会使分支 CAS 失败，重试重新检查收藏并保留原图。迟到上传仅能替换先前空占位 SHA，文件已清理后无法重新创建无清单的原图分块。清理只移除当前分支上的未完成文件；Git 历史仍由私有仓库保留。

完成上传在同一个 Git tree commit 中写入收藏清单并移除临时清单，随后更新账号头像指针。即使账号提交失败，原图与完整 SHA-256 已保存在收藏中；同一上传编号重试会直接恢复头像指针，无需重新传输或重新读取 34 块原图。

头像版本号阻止旧上传覆盖用户刚在其他页面选择的新头像；已通过验证的原图仍进入私有收藏。客户端切换/退出账号会阻止继续发送旧上传和应用旧响应。

## 请求预算与验证

生产二进制上传、压缩图、原图流和清理都复用既有 `ACCOUNT_RUNTIME` 的计算通路，避免普通 Worker 的 CPU 限额；该路径不写入 Durable Object storage。账号与头像适配器共享每次 HTTP 请求最多 48 次 GitHub 调用的硬预算；超过预算、分支冲突或 GitHub 主/次级限流会明确失败，保留可重试的原记录，内置头像仍可选择。

`test/cloudflare-avatars.test.js` 在真实 Miniflare/workerd 执行生产 Worker、既有 AccountRuntime 与 GitHub HTTP 协议 fixture，完整上传 104857600 字节，验证 34 个私有分块、压缩图独立显示、SHA-256 一致、账号提交失败后的恢复与原图流式下载。实测首次完成 47 次 GitHub 调用、原图下载 36 次，均低于 50 次外部请求边界。fixture 不向真实用户账号或仓库写入测试数据。

GitHub Contents 与 Git Blobs 的格式限制参考 [GitHub Contents API](https://docs.github.com/en/rest/repos/contents)、[GitHub Git Blobs API](https://docs.github.com/en/rest/git/blobs)。生产仓库应持续保持私有，并保留现有 Contents 写权限。

当前自定义头像的部署入口为 Cloudflare Worker + 既有 AccountRuntime。Standalone/Vercel 的默认账号 handler 未启用二进制头像路由，会明确返回 `customUploads: false`，尝试上传时报告未配置；内置头像仍可选择。
