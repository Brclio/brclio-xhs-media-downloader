# v1.7.0 账号系统验证记录

日期：2026-09-20。当前交付来自本机工作树，不能把基础 Git HEAD 当成本次已发布提交。安装包的应用源码和授权地址已与工作树逐字节比较；本次没有发布 GitHub Release。

## 本地自动测试：已通过

`npm test`：**209 项 Node 测试、19 项 Python 测试全部通过**，无跳过。账号业务测试使用模拟 GitHub HTTP / 邮件、真实业务服务和 SHA 存储适配器；不等同于真实 GitHub 多实例压力验收。

覆盖内容：

- 新用户创建、已有用户登录；验证码错误、过期、失败锁定、重复/并发消费；邮箱/IP/全局限流、Gmail 别名共享限流和 SMTP 收件人输入限制。
- 随机会话摘要存储、不固定到期、主动退出后拒绝旧令牌；普通用户调用管理员接口被拒绝；Cookie、来源及请求体边界。
- 管理员天数/到期日开通、延长、缩短、永久与取消会员，审计和操作请求幂等。
- 单次激活码兑换、两用户竞争、响应丢失重试、永久会员不消耗时长码、截止时间与作废。
- 单设备名额竞争、设备签名校验、解绑后旧设备在线/重登/刷新均不能抢回；重装密钥丢失后仅管理员批准指定新密钥；满额、退出会话、并发恢复及重试。
- 多个独立服务/存储实例并发更新、SHA 冲突后重新执行业务校验、GitHub 超时/限流/写入失败/确认不完整时不报假成功；只读授权与粗粒度设备时间记录。
- 主进程与真实任务入口拒绝无授权开始/继续/重试、途中权限撤销后暂停并保留文件；Node/Python 下载解析、归档、任务恢复、重试、更新功能原有回归测试。
- 网站公开目录白名单及安装包排除后端/管理员文件；操作系统加密存储不可用时不降级为明文。

## 本地真实运行环境：已通过

| 验证 | 结果及边界 |
| --- | --- |
| `npm run desktop:verify` | 本机 macOS arm64 的真实 Electron 主进程、隔离预加载桥、界面和内置 Python 解析启动成功；使用可控解析输入 |
| `npm run desktop:verify:account` | 真实 macOS Keychain / Electron safeStorage；两个独立 Electron 进程重开后令牌和设备身份保持；服务器为模拟服务 |
| `npm run admin:verify` | 真实 Electron 渲染器、本地 HTTPS、实际 HTTP handler / 业务服务 / GitHub 存储适配器，36 次请求与 12 次状态写入；GitHub HTTP 和 SMTP 为模拟服务。包含安全 Cookie、刷新保持登录、会员变更、解绑、新密钥恢复、发码/作废、审计与退出 |
| Mac 安装包 | DMG 校验、ZIP 完整性、arm64 架构、32 个应用源码文件及授权地址字节比较、包内 Python 真实启动和解析通过 |
| Windows 安装包 | NSIS 安装/便携 EXE 及内嵌 7z 完整性通过；两包应用内容一致；实际内嵌 ASAR 的 32 个源码文件、授权地址和 4 个 Python 源文件比较通过；Electron/Python PE 为 AMD64 |

Windows 检查是 Mac 上的静态校验，不能替代 Windows 原生启动、安装或 DPAPI 验证。安装包不含后端、管理员页面、Nodemailer、环境文件；源码和包内容的已知密钥格式扫描没有发现部署凭据。生产敏感值保存在 Vercel 平台，未通过拉取环境文件写回本地。

## 真实远端服务：已验证

沿用既有 Vercel 项目，Node.js 22；绑定 `xhs.download.brclio.com`，TXT 验证通过，CNAME 配置正确。业务仓库 `Brclio/brclio-xhs-media-downloader-data` 经 API 确认为私有；`state/accounts.json` 已由实际后端首次写入。初始化开关随后关闭，防止文件丢失时自动生成空数据。

- 真实 Gmail SMTP 连接与身份验证通过，验证码实际投递，用户提供收到的验证码完成管理员账号创建与登录。
- 管理员角色、用户查询、指定 7 天会员、增加 2 天、减少 1 天、开通永久、取消会员均由 Vercel 实际调用 GitHub 成功提交。
- 生成一个测试时长码并立即作废，操作审计可读，管理员退出成功。最终管理员测试账号为普通会员状态，测试码已作废，测试会话已撤销。
- 已消费验证码在正式域名重放返回 `CODE_USED`；未登录调用管理员 API 返回 401；畸形邮件收件人返回 `INVALID_EMAIL`。
- 正式域名 Node 与 Python 单篇解析 API 均对可控媒体 URL 返回一项解析结果。这不是新一轮真实小红书登录后全量主页抓取验收。
- 正式网站对 `/desktop/main.js`、`/server/auth/service.js`、`/.env`、`/.env.example`、`/package.json`、`/test/auth-backend.test.js`、`/dist-desktop/`、`/lib/membership-policy.js` 均返回 404。
- 公网验收发现并修正了管理员路径末尾斜线的响应头匹配问题。`/admin`、`/admin/`、`/admin/index.html` 和管理员脚本均确认返回 CSP、`no-store`、`X-Frame-Options: DENY`；跨来源管理员请求返回 403。最终 Vercel 部署 `dpl_6vfad8TdBKpCfqFvgrq7f9tEe4gB` 为 READY，正式域名已指向该部署。
- 直接检查真实权威状态：1 个管理员自有账号、会员类型 `none`、活跃会话 0、测试码状态 `void`、7 条管理操作审计；会话键均为摘要。

## 尚未验收的项目

- Windows 原生安装、启动、真实 DPAPI、系统重启和覆盖升级；Mac 操作系统重启及正式签名安装包覆盖升级。
- Apple Developer ID 签名/公证和 Windows 发布者代码签名。本次包不能宣称已经签名或免系统安全提示。
- Intel Mac 本轮安装包；仓库保留原生 CI 矩阵，本次本机生成的是 Apple Silicon arm64 和 Windows x64 包。
- 桌面安装包与真实服务的完整邮箱登录、真实激活码兑换/设备撤销整条人工交互验收；当前这些业务并发及组合场景通过模拟测试，实际远端只验收了上述管理员与存储/邮件路径。
- 真实 GitHub 高并发压力、实际限流与灾难恢复演练；自动测试已注入相应故障，不能代替生产演练。
- 新一轮真实小红书账号的完整主页下载；既有本地任务和原下载实现保留，相关回归通过。
- GitHub 自动部署：关联尝试被 Vercel 拒绝，要求账号先添加 GitHub Login Connection。连接后还需关联代码仓库并验证一次推送触发。当前部署由本地源码通过 Vercel API 完成。

## 交付文件与复验

安装包位于 `dist-desktop/`：

- `XHS-Downloader-1.7.0-mac-arm64.dmg` / `.zip`
- `XHS-Downloader-1.7.0-windows-x64-setup.exe`
- `XHS-Downloader-1.7.0-windows-x64-portable.exe`
- `release-proof-mac-arm64.json`、`release-proof-windows-x64-static.json`：文件大小、SHA-256、校验范围。

```bash
npm ci
npm test
npm run build:web
npm run desktop:verify
npm run desktop:verify:account
npm run admin:verify
node scripts/verify-built-installers.mjs
```

最后一项按当前原生平台验证该平台安装包；Windows 原生应在 Windows 上运行。管理员 UI 测试需要 OpenSSL 生成临时本地证书，仅在测试脚本内信任本机地址，测试结束清除证书和会话。
