# Brclio 小红书下载器

v2.0.6 已发布，为 Mac / Windows 桌面更新增加内置代理自动续传重试：下载中断或超时后自动重新连接，实时显示连续失败次数；连续失败 10 次后暂停自动重试，点击“继续下载”或“重试下载”开始新一轮。暂停、退出和手动关闭代理保留已下载进度。三平台构建、公开附件与官网已核验，正式 Mac arm64 包启动和联网检查通过。详见[版本说明](docs/releases/v2.0.6.md)、[公开发布核验](docs/releases/v2.0.6-publication-verification.json)、[官网验收](docs/releases/v2.0.6-web-verification.json)与[更新网络配置](docs/update-proxy-config.md)。Android 保持 v1.0.11。

v2.0.5 已发布，新增本地[实况制作](docs/live-photo-maker.md)：网页和桌面支持将单张图片、图片组或视频制作成 0.5–3 秒 Live Photo，调整图片顺序、视频片段、封面和声音，导出配对 JPG + MOV ZIP。素材在本机处理，无需会员。Mac arm64、Mac x64、Windows x64 的原生编码验证与安装包构建通过，生产网页已验证图片、视频、声音及实际 ZIP 导出。详见[版本说明与发布附件](docs/releases/v2.0.5.md)、[三平台 CI](https://github.com/Brclio/brclio-xhs-media-downloader/actions/runs/37176396468)、[网页验证](docs/releases/v2.0.5-web-verification.json)与[公开发布核验](docs/releases/v2.0.5-publication-verification.json)。Android 仍为 v1.0.11，本次不更新 Android 安装包。

桌面 v2.0.4 与 Android v1.0.11 新增系统代理优先和「关闭软件内置代理」控制：手动关闭状态持续保存，下次明确检查或下载时自动恢复，任务结束后自动关闭。Mac 同时修复同版本重装的临时旧版清理及无法关闭的安装提示。详见 [桌面说明](docs/releases/v2.0.4.md) 与 [Android 说明](docs/releases/android-v1.0.11.md)。

v2.0.1 新增「清除登录记录」按钮：确认后暂停主页任务，清空下载器保存的小红书登录、Cookie、网站存储与缓存，方便重新登录其它账号。已有下载文件、任务记录和软件会员账号保留。详见 [版本说明](docs/releases/v2.0.1.md)。

v2.0.0 更新软件会员套餐：日会员 3 元 / 1 天、月会员 19.9 元 / 30 天、年会员 69.9 元 / 365 天。付款请备注软件账号邮箱，由人工核实，24 小时内尽快处理并通过邮箱发送激活码；会员时长从兑换成功起计算。随着功能持续完善，价格将适时上调，以购买时页面展示为准。已有下载与会员功能继续沿用。详见 [版本说明](docs/releases/v2.0.0.md)。

v1.8.30 改进视频下载进度：点击下载立即显示状态，进度条紧邻下载按钮，按实际接收字节显示百分比、已下载量、速度与耗时；读取原视频、检查完整性和交给浏览器保存分别提示。完成或失败结果保留在下载区，普通播放视频与会员原视频都适用。详见 [版本说明](docs/releases/v1.8.30.md)。

v1.8.26 新增会员专享「下载无水印视频」：从当前笔记公开的原文件字段取得平台原视频，网页和桌面均需验证有效软件会员。普通播放视频继续按原入口下载；作者自行写入画面的水印可能保留。Android v1.0.8 提供系统浏览器入口，带完整笔记链接进入网页版登录并下载。详见 [原视频来源核验](docs/watermark-free-video.md)、[桌面版说明](docs/releases/v1.8.26.md) 与 [Android 版说明](docs/releases/android-v1.0.8.md)。

新增[独立服务器部署与 SQLite 存储](docs/server-deployment.md)：`npm run start:server` 提供完整网站、账号后台和 Node / Python 双引擎，首次启动自动创建 SQLite 数据库，支持 Docker 持久卷。`npm run migrate:storage -- --from github --to sqlite` 可预览 GitHub → SQLite 迁移，反向交换参数可迁回 GitHub；执行需加 `--apply`，覆盖已有目标需显式 `--replace` 并自动备份。原 Vercel、Cloudflare 和客户端部署流程及默认 GitHub 存储不变。已有数据切换时必须保留原 pepper，并按文档暂停源端写入。

网页新增「问题广场」：公开查看已提交的问题、处理状态与评论，支持搜索、分类及状态筛选。任何软件账号登录后都能发表评论，无需会员；评论是独立的平铺讨论。管理员和提交者之间的回复仍为私密对话，提交者也可在网页查看和继续回复。问题、回复与评论原文继续保存到 GitHub 私有业务仓库，公开页面仅返回脱敏内容，不公开诊断日志或账号信息。详见 [反馈及日志说明](docs/feedback-diagnostics.md)。

v1.8.26 同时修复启动页面仍在加载时正常退出被误报为启动失败的问题，并确保 SMTP 连接超时后及时关闭连接；桌面 v1.8.24、v1.8.25 安装包未公开发布，相关改进纳入 v1.8.26。

v1.8.23 新增「VIP 交流群」公开入口，未登录用户、普通用户和软件会员均可查看。入群费用 99.99 元，添加个人微信并备注「VIP 交流群」；问题与需求在预算和可行性范围内择优推进，提供后续产品抢先体验机会。Android v1.0.7 同步内置离线页面与二维码，支持系统保存。详见 [桌面版说明](docs/releases/v1.8.23.md) 与 [Android 版说明](docs/releases/android-v1.0.7.md)。

v1.8.18 与 Android v1.0.2 新增「编程私教与书籍」页面，提供书籍介绍、长期一对一招生与微信二维码放大/保存。客户端内置页面，返回后保留下载状态；网页版同步增加入口。详见 [桌面版说明](docs/releases/v1.8.18.md) 与 [Android 版说明](docs/releases/android-v1.0.2.md)。

v1.8.17 支持问题反馈双向回复：管理员可在后台直接答复，Mac / Windows 用户在「我的反馈」中查看完整对话并继续回复，网络失败可重试同一条消息。详见 [v1.8.17 版本说明](docs/releases/v1.8.17.md)。

v1.8.16 与 Android v1.0.1 在 Mac、Windows 和 Android 客户端中新增「iPhone 小红书无水印下载快捷指令」福利入口，可点击访问或复制完整链接，方便在 iPhone 上添加使用。详见 [桌面版说明](docs/releases/v1.8.16.md) 与 [Android 版说明](docs/releases/android-v1.0.1.md)。

请在 Mac、Windows 或 Android 客户端内打开福利入口，复制快捷指令链接后可发送到自己的 iPhone 使用。

v1.8.15 为主页批量失败记录增加完整链接展示、「复制链接」和「去单篇下载」。转入单篇后自动填入链接，点击「开始解析」即可继续下载；原有批量进度与重试功能保留。详见 [v1.8.15 版本说明](docs/releases/v1.8.15.md)。

v1.8.14 将主安装包名称简化为 `Brclio-XHS-版本号-系统-架构`，去掉 `Downloader`。官网下载与新版应用内更新优先使用新名称，旧版通过兼容附件继续升级。详见 [v1.8.14 版本说明](docs/releases/v1.8.14.md)。

v1.8.13 改进客户端多图复制：勾选后通过系统剪贴板一次复制独立原图文件，保留内容与顺序，可在支持多文件粘贴的应用中一次粘贴。Mac 已用实际 10 图笔记核对一次复制、一次粘贴、全部图片内容和顺序。网页版保持原有行为，详见 [v1.8.13 版本说明](docs/releases/v1.8.13.md)。

客户端“开通会员”自 v1.8.11 起提供微信与支付宝扫码付款，当前套餐为日付 3 元 / 1 天、月付 19.9 元 / 30 天、年付 69.9 元 / 365 天。**付款务必备注软件账号邮箱，由人工核实，24 小时内尽快处理并发送激活码，收到后兑换开通。** 随着功能持续完善，会员价格将适时上调，具体以购买时页面展示为准。管理员可选择客户邮箱与套餐，生成并发送绑定该账号的激活码，失败可重试原码。详见 [v1.8.11 版本说明](docs/releases/v1.8.11.md) 与 [会员开通操作说明](docs/membership-purchase.md)。

v1.8.8 将上次安装的结果移到“关于软件”页提示，注明对应版本、当前运行版本和记录时间；历史清理问题不会再突然弹窗遮挡新版下载。关闭提示后记住已读状态，安装记录、恢复备份和安全清理重试继续保留。**Mac v1.8.3–v1.8.6 首次升级请使用完整 DMG 覆盖并手动打开；v1.8.7 可正常使用应用内更新。** 详见 [v1.8.8 版本说明](docs/releases/v1.8.8.md)。

v1.8.7 修复 Mac 更新后新版或恢复的旧版直接退出的问题，补全慢启动、页面重载后的就绪确认，并在安装助手暂时持锁时有限重试清理；同时改进独立安装进度窗口的关闭处理。**从 v1.8.5 / v1.8.6 首次升级，推荐下载完整 DMG，退出旧版后覆盖安装，再手动打开新版。** 原网页、单篇下载、账号和任务数据继续兼容，详见 [v1.8.7 版本说明](docs/releases/v1.8.7.md)。

v1.8.6 汇总已有的 Mac 启动、临时旧版清理和 `Brclio-` 激活码兼容修复，客户端操作延续 v1.8.5。补丁同时修正发布流水线的 Electron 初始化，并在创建发布与公开附件前核对远端版本标签和构建提交。详见 [v1.8.6 版本说明](docs/releases/v1.8.6.md)。

v1.8.5 修复 Mac 钥匙串等待时窗口不显示、打包应用临时旧版清理失败，以及未确认新版真正启动就报告安装成功的问题。先显示窗口再异步读取安全存储，拒绝后可重试；新版启动确认后清理备份，超时尝试恢复旧版。新激活码以 `Brclio-` 开头，旧 `XHS-` 码继续有效。旧版首次升级仍可能需要手动打开新版；钥匙串系统授权和未取得 Developer ID 的限制仍保留。详见 [v1.8.5 版本说明](docs/releases/v1.8.5.md)。

v1.8.4 修复已发现新版本后，再次检查失败会挡住下载的问题。版本查询受限时仍可直接下载或继续下载已发现的版本；文件下载错误与查询错误分别提示。详见 [v1.8.4 版本说明](docs/releases/v1.8.4.md)。

v1.8.3 改进安装确认弹窗；Mac 更新成功并启动新版后，自动清理旧客户端临时备份。保留断点续传、安装进度与自动重开。详见 [v1.8.3 版本说明](docs/releases/v1.8.3.md)。

v1.8.1 重新发布品牌安装包，应用内更新优先选择 `Brclio-XHS-Downloader` 文件并保留旧版更新兼容。注册／登录邮件新增编程私教、微信、新书推荐与中英文收件提示。详见 [v1.8.1 版本说明](docs/releases/v1.8.1.md)。

v1.8.0 改为桌面五页导航，增加问题反馈与脱敏诊断日志、后台复制/下载日志，改进自动检查更新和 Mac 原位覆盖安装，并修复部分笔记读取失败、普通视频缺音轨的问题。详见 [版本说明](docs/releases/v1.8.0.md) 与 [反馈及日志说明](docs/feedback-diagnostics.md)。

v1.7.1 修补 Mac 应用包的签名完整性：完整应用使用 ad hoc 签名，发布验证分别检查最终 ZIP 与 DMG 内的应用。ad hoc 不是 Apple Developer ID 签名或公证，具体产物验证以发布工作流和 `build-evidence.json` 为准，详见 [v1.7.1 说明](docs/releases/v1.7.1.md)。

v1.7.0 新增软件账号、会员授权、设备绑定和人工发码管理。后端沿用 Vercel，业务状态存入独立 GitHub 私有仓库，详见 [账号系统部署与配置](docs/account-system.md)。软件账号与小红书登录独立；上线需先配置平台 Secrets 与授权地址，再打包正式客户端。默认会员范围为主页批量下载，原单篇功能保留。

[项目仓库](https://github.com/Brclio/brclio-xhs-media-downloader) · [下载最新版安装包](https://github.com/Brclio/brclio-xhs-media-downloader/releases/latest)

产品介绍页位于 [`product.html`](product.html)，可从下载工具顶部的「产品介绍」打开，适合录屏介绍功能。该页面与配套资源随网站、Cloudflare Pages 和桌面安装包一同构建。 点击右上角「演示模式」可逐幕讲解，使用左右方向键或空格切换，Esc 退出；也可用 `product.html?present=1` 直接进入。支持可选全屏，1920×1080 画幅下六幕完整展示。页面内界面与素材为功能示意，实际下载请进入下载工具。

已部署 **Cloudflare Pages + Workers 双引擎**，正式入口为 [xhs.download.brclio.com](https://xhs.download.brclio.com)，另有 [Pages 入口](https://brclio-xhs-pages.pages.dev)。正式域名与证书已激活，HTTPS 健康检查确认请求到达 Cloudflare。网页和图片、视频下载由 Cloudflare 承载；账号与解析使用私有 Durable Object 执行环境，账号沿用原 `AUTH_*` 配置和 GitHub 唯一业务存储。真实双引擎解析、图片字节、验证码收件、管理员登录及跨后端会话已验证；各项验收范围和正式域名回归结果见迁移记录。

笔记解析先使用 Cloudflare；遇上游限制或解析失败时，仅回退到原 Vercel 的同引擎 JSON 解析接口。**目前仍保留这部分 Vercel 依赖，不能停用原项目。** Pages 支持外部 DNS 子域名，无需迁移整个根域 DNS。部署版本、核验证据、免费额度和回滚步骤见 [Cloudflare 迁移说明](docs/cloudflare-deployment.md)。已有 Secrets 时，`npm run cloudflare:deploy` 依次发布 Python、主 Worker 与 Pages；仅构建网站使用 `npm run build:cloudflare`。

## Android 客户端

新增独立 Android 客户端工程，面向 Android 8.0 及以上，聚焦单篇笔记的原图、实况、视频、文案、ZIP、图片复制与系统分享。可粘贴分享文案，也可从其他应用分享文字进入；文件由 Android 系统文件选择器保存。解析沿用在线服务，安装者无需 Python 或 Node.js。检测到平台原视频后，可通过「下载无水印视频 · 会员」在系统浏览器打开网页版，登录软件账号并验证会员后下载；Android 原生层不保存该账号会话。当前不包含主页批量或小红书登录。

前往 [软件下载页](https://xhs.download.brclio.com/download.html#android-download) 下载正式 APK；客户端启动时自动检查新版，也可在「软件更新」中手动检查，由用户确认下载和安装。Android 独立编号为 `1.0.11`，使用固定签名支持后续覆盖升级。

开发者配置 JDK 与 Android SDK 后运行 `npm run android:build` 生成 debug APK。构建、正式签名、安装与设备验证说明见 [Android 客户端说明](android/README.md)。Mac / Windows 使用独立的桌面版本与更新通道。

## Mac / Windows 本地版与主页批量下载

桌面版使用 Electron，将浏览器、Node.js 和独立 Python 引擎一起打包。**安装包的使用者不需要安装 Python、Node.js 或 Vercel CLI。** 网页版继续按原方式部署，桌面功能只在本地应用中显示。

桌面版保留下方单篇解析、文案复制、实况 ZIP、视频清晰度选择和 ZIP 下载功能；图片复制使用系统剪贴板，并提供：

- 「制作实况」独立页面：从本地选择一段视频或 1–12 张图片，预览并制作 0.5–3 秒实况照片，支持选择视频起点、封面、声音及单图推进或静止效果；可以取消并调整后重做。
- 单篇勾选多张图片后，一次复制独立原图文件到系统剪贴板；可粘贴到支持多图片或多文件粘贴的应用。一次最多 50 张、单张 30 MiB、总量 120 MiB，完整准备后才写入。
- 粘贴完整的 `/user/profile/用户 ID` 主页链接，读取该主页当前账号可见的笔记列表。
- 内置小红书登录 / 验证窗口，登录后显示当前账号昵称；登录状态保留在应用独立的本地会话中，不需要手动复制 Cookie。
- 抓取间隔可配置，默认 10 秒，最短 3 秒；可增加随机等待，任务串行执行。
- 将帖子按 `001-帖子名称`、`002-帖子名称` 分别保存，包含原图、实况动态片段、视频和文案；继续和重试保持原序号。
- 暂停、继续、取消、单条或全部失败重试、重启恢复；已成功保存并通过文件检查的内容自动跳过。
- 单篇下载、主页批量、软件账号、问题反馈和关于软件独立切换；网页版维持原布局。
- “关于软件”检查更新，启动后及使用期间自动检查并提示；下载校验后 Mac 可在可写目录原位覆盖，Windows 打开安装向导，保留本机登录和任务记录。
- 反馈附带当前完整保留日志（轮转上限 8MiB），可复制/导出；后台可查看问题、复制完整报告和下载日志。日志从安装本版本后开始，不包含 Cookie、会话密钥或下载内容。
- 管理员可在后台回复问题，用户在“我的反馈”查看答复并继续交流。新问题与双方回复完整原文存入 GitHub 私有仓库，诊断日志继续脱敏；私密对话仅管理员和提交者可访问。网页「问题广场」公开脱敏的问题、状态及评论。
- 只有拿到明确的列表结束标记才标记列表完整；验证码、登录限制、网络中断或连续空加载不会被误报为“全部完成”。

使用步骤、保存规则、打包方式和平台验证情况见 [桌面版说明](desktop/README.md)。主页下载受实际登录状态、作者可见范围和平台访问限制影响；间隔只能降低请求频率，不能保证不触发限制。私密、已删除或当前账号不可见的内容无法下载。

实况制作导出的 ZIP 包含同名 JPG、MOV 和 `README.txt`。解压后一起导入 Mac「照片」，确认 LIVE 标记，再通过同一账号的 iCloud 照片同步到 iPhone；将 ZIP 下载到手机文件夹不会自动存入相册。网页需要设备支持相应的视频编码能力，保留声音还需要音频编码支持，页面会先检查并提示。GIF 以静态图片处理；本轮已验证真实配对文件的 Apple 实况识别，手机原生导入、iCloud 同步全流程及 Windows 设备上的相册识别仍需对应设备验证。制作与原有小红书 JPG + MP4 素材下载分别使用各自入口，详见[实况制作说明](docs/live-photo-maker.md)。

**从旧版升级：** v1.5.0 没有内置更新入口，需要从 Releases 手动安装一次。v1.6.1–v1.7.1 可检查并下载安装包，Mac 仍需把 DMG 内应用拖入“应用程序”；安装 v1.8.0 后，后续更新支持原位覆盖。Windows 沿用安装向导；便携版更新为安装版。v1.6.3 首次更名升级可能保留旧名称应用，确认新版正常后可移除旧应用，数据目录继续沿用。Mac 完整包使用 ad hoc 签名，尚无 Apple Developer ID 签名或公证；Windows 尚无发布者代码签名。外部 Mac 的系统安全提示与 Windows 安装向导仍需在对应用户机器验收。

**Mac 旧版升级提醒：** v1.8.18 及更早版本若提示“无法确认应用处理器架构”，或 v1.8.3–v1.8.6 出现安装后退出，请下载 [最新版完整 DMG](docs/releases/v2.0.0.md)，等待现有安装结束，完全退出旧版后拖入原安装位置并选择替换，再手动打开。发布新版不会改写旧版内置更新助手，因此这些情况需手动覆盖一次；无需安装 Xcode、删除账号、任务记录或已下载文件。

### Mac 安装后无法打开

先确认 macOS 13+，从本项目 Releases 下载与 Apple 芯片 / Intel 芯片匹配的新版，并对照 `SHA256SUMS.txt` 检查文件。v1.7.0 出现签名资源不一致时，优先安装 v1.7.1 或后续修复版；只修改系统安全设置不能修复损坏的应用签名。

若提示无法验证开发者，且确认来源和校验值可信，可依照 [Apple 官方说明](https://support.apple.com/zh-cn/102445)，尝试打开后到“系统设置 → 隐私与安全性”为该应用单独选择“仍要打开”。不要关闭系统范围的 Gatekeeper。若提示应用已损坏或仍打不开，请反馈 macOS 版本、芯片类型、安装包文件名及完整错误；可附上以下只读检查结果：

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Brclio 小红书下载器.app"
```

签名完整性通过不代表已公证，也不能替代在受影响的那台 Mac 上实际打开验证；该远端设备仍待用户确认。

这是一个支持 Vercel 和 Cloudflare Workers 部署的小红书公开笔记媒体下载网站。访问者只需要粘贴分享文案或链接，即可解析当前笔记中的：

- 无水印原图
- 实况图片的静态原图与配对动态 MP4
- 视频流与多个可用清晰度
- 电脑端 `xiaohongshu.com` 长链与手机端 `xhslink.cn` 短链自动识别
- 当前笔记标题与正文文案
- 文案复制、逐张图片复制，以及支持平台上的多图剪贴板写入尝试
- 图片单张下载、实况 JPG + MP4 素材 ZIP、实况 MP4 单独下载，以及勾选批量 ZIP（自动附带 `文案.txt`）
- 视频浏览器分段下载、本地合并并保存为 MP4
- Node.js / Python 双后台自由切换

## 待发布功能

- Node.js 与 Python 两套解析器同步读取当前 `noteId` 对应的 `desc / description`，不从相关推荐兜底。
- 结果区可复制“标题 + 正文”的完整笔记文案。
- 每张图片提供独立“复制图片”按钮；支持多项剪贴板的平台可对勾选图片发起一次写入。
- 图片 ZIP 固定加入 UTF-8 BOM 编码的 `文案.txt`，包含标题、正文、来源、生成时间与解析引擎。
- 图片剪贴板只在 HTTPS 或 localhost 可用；Chrome / Chromium 当前会拒绝多个 `ClipboardItem`，页面会区分该限制与权限错误，并提供复制首张、逐张复制、复制链接与 ZIP 回退。

## v1.4 更新

- Node.js 与 Python 两套解析器会按 `imageList` 顺序识别 `livePhoto`，并把同一项 `stream` 中的动态 MP4 与静态原图一一配对。
- 实况卡片提供两个独立入口：“下载实况 ZIP”保存配对素材，“下载实况 MP4”只保存动态片段；原有“下载原图”保持不变。
- 单张实况素材包命名为 `NN-live-photo.zip`，内部包含 `NN.jpg` 与 `NN-live.mp4`。
- 勾选下载会把每张原图及其对应 `NN-live.mp4` 一并放入批量 ZIP，并继续附带 `文案.txt`。
- 实况素材 ZIP 是 JPG + MP4 素材包，不会自动写入 Apple Photos 所需的原生 Live Photo 元数据。
- 归档设置浏览器内存保护：桌面端上限 256 MiB，移动端或低内存设备上限 128 MiB；下载、备用线路、文案和最终 ZIP 共用同一预算。
- ZIP 生成前会精确核对 UTF-8 文件名、目录开销、ZIP32 边界与最终体积，超限时提示减少勾选或分批下载。

## v1.3 更新

- 新增视频笔记识别和视频下载。
- 支持新版 `video.media.stream.h264 / h265 / av1` 数据结构。
- 兼容旧版 `video.consumer.originVideoKey`。
- 视频有多个流时可在页面选择分辨率和编码。
- 新增 Node.js 视频分段接口：`/api/video`。
- 新增 Python 视频分段接口：`/api/python_video`。
- 每个视频分段小于 Vercel 单次响应限制，最终文件在浏览器中合并。
- 只读取当前 `noteId` 对应的视频对象，不会抓取相关推荐中的视频。
- 原有图片解析、无水印转换、单张下载、复制链接和 ZIP 功能保持不变。

## 项目结构

```text
.
├── api/
│   ├── parse.js            # Node.js 笔记抓取与图片/视频解析
│   ├── image.js            # Node.js 图片代理下载
│   ├── video.js            # Node.js 视频元数据与分段下载
│   ├── python_parse.py     # Python 笔记抓取与图片/视频解析
│   ├── python_image.py     # Python 图片代理下载
│   └── python_video.py     # Python 视频元数据与分段下载
├── lib/
│   ├── archive.js          # 浏览器 ZIP Store 与文案 TXT 生成
│   └── xhs.js              # Node.js 解析核心
├── test/
│   ├── archive.test.js
│   ├── xhs.test.js
│   └── test_python_backend.py
├── app.js
├── visit-counter.js       # 独立加载 BornForThis 访问统计 SDK
├── visit-counter.css      # 访问统计专用液态玻璃浮层样式
├── changelog.html
├── changelog.css
├── index.html
├── style.css
├── package.json
├── vercel.json
└── .python-version
```

## 更新现有 Vercel 部署

继续使用 Vercel 时，部署方式不变，不需要创建第二个 Vercel 项目，也不需要把 Python 单独部署。迁移 Cloudflare 时使用 [Pages 与双 Worker 部署流程](docs/cloudflare-deployment.md)，不要套用本节 Vercel 设置。当前的笔记解析回退仍需要原 `.vercel.app` 服务；正式域名切换后也应保留其代码、部署和解析接口。

将新版文件覆盖到原仓库后提交：

```bash
git add .
git commit -m "feat: add Xiaohongshu live photo downloads"
git push
```

已经关联 GitHub 的 Vercel 项目会自动重新部署，原域名和项目设置不需要修改。

部署配置由仓库 `vercel.json` 管理，Vercel 项目中不要保留冲突的手工覆盖值：

```text
Framework Preset：Other
Build Command：node deploy/build-web.mjs
Output Directory：dist-web
Install Command：npm ci --omit=dev --ignore-scripts
```

网站仅发布白名单中的静态资源和 `api/` 函数。Mac / Windows 代码、内置运行环境、安装包、测试、文档和环境文件由 `.vercelignore` 排除。业务数据存入独立私有仓库，因此更新业务数据不会触发代码仓库部署。配置与管理员初始化见 [账号系统部署](docs/account-system.md)，数据字段见 [数据结构](docs/account-data.md)，本轮验证范围见 [测试结果](docs/account-validation.md)。

## 本地运行

Cloudflare 本地运行使用 `npm run cloudflare:dev:python` 与 `npm run cloudflare:dev`。干净检出需先运行 `uv sync --directory cloudflare/python --frozen` 和 `uv run --directory cloudflare/python pywrangler sync`，再执行 Python workerd 测试。Pages 网关联调及完整核验命令见 [Cloudflare 说明](docs/cloudflare-deployment.md#安装与本地核验)。

按原 Vercel 方式运行时，需要安装 Node.js、Python 和 Vercel CLI：

```bash
npm run dev:vercel
```

不能只用普通静态服务器运行，因为图片和视频下载都依赖 `/api` Functions。

这里特意不使用 `dev` 作为脚本名：`vercel dev` 会自动读取并执行
`package.json` 中的 `dev`，如果该脚本再次调用 `vercel dev`，就会形成递归。
`dev:vercel` 只用于本地运行，不影响 Git push 后的 Vercel 自动部署，发布前无需修改或撤回。

## 网站访问统计

首页和更新记录页已接入 [domain-visit-counter](https://github.com/AndersonHJB/domain-visit-counter)，使用已部署的 HTTPS 服务：`https://counter.bornforthis.cn`。

桌面统计以左下角液态玻璃浮层展示，沿用页面暖白、蓝黄配色。手机端默认是右下角紧凑的访问数胶囊，整个胶囊均可点击；点按展开完整统计，滚动、点击外部或按 Escape 自动收起。胶囊对较大数字使用“万 / 亿”等单位，展开后显示完整计数；横屏触控设备沿用手机模式。胶囊与输入框、引擎选项、下载按钮等操作控件重叠时自动隐藏，滚动、视口或内容布局变化后重新检查，避免遮住操作。专用 `visit-counter.css` 只影响统计模块；支持收起 / 展开、手机安全区、减少透明度和减少动态效果偏好，不支持背景模糊时使用暖白底色。桌面展示区域允许点击穿透，仅收起 / 展开按钮接收点击；手机展开面板内不会点击穿透，面板之外保持页面原有操作；输入框或选择框聚焦、现有提示条显示时，统计浮层暂时隐藏。

- **展示口径**：当前域名的累计页面浏览次数（PV），不是独立访客人数或下载次数；接入前的访问不会自动补录。
- **域名识别**：`visit-counter.js` 将当前 `location.hostname` 显式传给官方 SDK 的 `data-domain`。同一域名的首页和更新记录页共用总量，不设置 `data-project`；不同域名（包括 Vercel 预览域名）各自统计。
- **上报方式**：每次打开页面，异步加载一次 `/counter.js`，由 SDK 自动上报一次 `/hit?d=当前域名` 并读取 `/stats?d=当前域名`；不额外调用 `hit()`，也不轮询。上报与读取并行，数值可能短暂滞后一次访问。
- **数据显示**：通过 `bftcounter:update` 事件显示带千分位的真实 `total`；等待期间用 `—` 占位，脚本加载失败或 8 秒未获得有效结果时显示“访问统计暂时不可用”。失败不显示为 0，稍后返回的有效数据仍会更新。
- **本地调试**：`file://`、localhost、本地 IP 以及 `.local` / `.test` 等本地域名不加载远程 SDK、不上报。正式站点只需正常部署这些静态文件，无需新增 Vercel 环境变量。
- **独立运行**：统计代码与媒体解析、复制、ZIP 打包及下载逻辑分离；不把分享链接或笔记内容作为统计参数发送，也不请求 `includeIps`。

如统计服务启用了域名白名单，需要在计数器服务的 `allowedRootDomains` 中允许实际部署域名。可用 `https://counter.bornforthis.cn/stats?d=实际域名` 只读核对数据；页面里的访问统计模块和请求状态也可用于排查。

## 自动测试

```bash
npm test
```

测试覆盖：

- 当前帖子图片不会混入其他帖子图片。
- 当前帖子文案不会混入相关推荐或页面通用描述。
- 当前帖子视频不会混入相关推荐视频。
- 图文笔记原有解析结果保持不变。
- 纯视频笔记即使没有 `imageList` 也可以解析。
- H.264、H.265、AV1 多流提取与默认选择。
- 实况图片与同项 H.264 / H.265 / H.266 / AV1 动态流保持一一配对。
- 视频备用 CDN 地址保留。
- Node.js 与 Python 两套解析逻辑结果一致。
- 电脑长链、手机短链、Markdown 包裹链接与安全重定向边界。
- ZIP 可解出 UTF-8 中文文件名的 `文案.txt`，且正文元数据完整。
- ZIP 预估尺寸、中央目录、CRC、ZIP32 边界与不安全输入拒绝逻辑。

## 接口

### 解析笔记

```text
POST /api/parse
POST /api/python_parse
```

请求：

```json
{
  "text": "小红书分享文案或链接"
}
```

返回值中保留原有 `images` 字段，并新增正文、实况与视频字段：

```json
{
  "title": "笔记标题",
  "content": "笔记正文文案",
  "type": "mixed",
  "livePhotoCount": 1,
  "videoCount": 2,
  "images": [
    {
      "index": 1,
      "token": "...",
      "url": "https://...xhscdn.com/...",
      "livePhoto": true,
      "liveVideo": {
        "url": "https://...xhscdn.com/...",
        "backupUrls": [],
        "codec": "h264",
        "size": 6800000
      }
    }
  ],
  "videos": [
    {
      "index": 1,
      "url": "https://...xhscdn.com/...",
      "backupUrls": [],
      "codec": "h264",
      "width": 1920,
      "height": 1080,
      "size": 18000000,
      "label": "1920×1080 · H264 · 线路 1",
      "isDefault": true
    }
  ]
}
```

### 图片下载

```text
GET /api/image?token=...&name=01.jpg
GET /api/python_image?token=...&name=01.jpg
```

### 视频信息与分段

```text
GET /api/video?action=meta&url=...
GET /api/video?action=chunk&url=...&start=0&end=3499999

GET /api/python_video?action=meta&url=...
GET /api/python_video?action=chunk&url=...&start=0&end=3499999
```

前端会自动调用这些接口，不需要访问者手动操作。

## 视频与实况动态片段下载方式

视频通常大于 Vercel Function 的单次响应大小，因此项目不会让一个 Function 一次返回整个视频。流程是：

```text
浏览器获取视频总大小
        ↓
通过所选 Node.js / Python 后台逐段读取
        ↓
每段不超过 3.5 MB
        ↓
浏览器本地合并为 Blob
        ↓
保存为 MP4
```

如果媒体源不支持分段，页面会尝试备用 CDN 与浏览器直连；普通视频仍失败时会打开原地址供用户保存。

## 安全与限制

- 只允许 HTTPS 的小红书页面和 `xhscdn.com` 媒体地址。
- 分享链接和视频 CDN 跳转目标都会校验；页面分享链每一跳都必须使用 HTTPS、无凭证且仅使用安全端口。
- 只解析当前 `noteId` 的媒体对象，不全局扫描推荐内容。
- 文案只读取当前 `noteId` 已锁定笔记对象的直属字段；降级解析宁可返回空文案，也不会猜测推荐内容。
- 单个视频限制为 512 MB，避免浏览器本地合并占用过多内存。
- 实况单项 ZIP、批量 ZIP 和单独 MP4 会先检查已知大小，再对实际响应逐段限流；归档超限时不会生成截断 ZIP。
- 网页多图复制依赖标准 Async Clipboard API、HTTPS 与目标系统的多项剪贴板能力；不支持时请逐张复制或使用 ZIP。客户端使用系统文件剪贴板，接收应用需要支持多图片或多文件粘贴。
- 图片与视频不会在服务器持久化。
- 临时签名的视频链接可能过期，解析后应及时下载。
- 仅处理公开可访问内容，请只保存自己拥有或已获授权的作品。
