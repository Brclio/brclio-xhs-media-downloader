# Android v1.0.15：版本检测优先直连

发布于 2026 年 10 月 10 日（北京时间）。Android 正式客户端版本为 1.0.15，versionCode 为 10015。

## 本次更新

- 启动自动检查及手动检查最新版先直连，首轮请求最多等待 8 秒。成功时不读取代理配置、不获取订阅、不测速，也不启动内置代理。
- 连接故障、超时、HTTP 403 / 429 或 5xx 服务器故障时，按现有系统代理、VPN、手动停用与后台配置规则回退。取消、无效版本信息、地址校验和 TLS 安全错误不启动代理回退。
- 内置代理启动后，等待已配置节点与更新分组全部加载，再开始测速，避免控制接口先就绪、节点尚未加载导致误报不可用。等待有总时限，取消仍会结束内核并清理临时配置。
- APK 下载、SHA-256 校验、稳定签名核验及系统安装器确认沿用原有流程；浏览器下载继续使用浏览器自己的网络。

同期桌面版本为 [v2.0.15](https://github.com/Brclio/brclio-xhs-media-downloader/blob/main/docs/releases/v2.0.15.md)，两个客户端分别维护版本号和发布通道。旧版需升级后才会采用直连优先策略。

## 安装与核验

[官方正式签名 APK](https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.15/Brclio-XHS-Android-1.0.15-release.apk)与[SHA-256 校验文件](https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.15/Brclio-XHS-Android-1.0.15-release.apk.sha256)已公开发布。覆盖安装旧正式版，不要先卸载。

公开附件已核对版本、稳定签名、大小、SHA-256 和来源提交 [`4ebf40f`](https://github.com/Brclio/brclio-xhs-media-downloader/commit/4ebf40f544f9a931c73261f74f4c52186f6790b4)。[发布 CI](https://github.com/Brclio/brclio-xhs-media-downloader/actions/runs/38064825374)通过 81 项 Release Java 测试（零失败、零跳过）、Node 测试、lint，以及三种 ABI 的代理运行时、启动器和对应源码核验。

- Android 15 / API 35 x86_64：正式签名 1.0.2 → 1.0.15 覆盖升级，保留应用 UID、首次安装时间和安装来源许可；启动与检查更新界面通过。CI 另通过离线 VIP 页面、二维码系统保存、返回与输入保留，以及隔离夹具中的真实浏览器 APK 跳转。
- Android 15 / API 35 arm64-v8a：下载公开正式 APK，从正式签名 1.0.0 覆盖升级至 1.0.15，保留 UID 与首次安装时间；启动、显示当前版本 1.0.15、检查更新和代理退出清理通过。

两次覆盖升级均使用 `adb install -r`；未自动化应用内 APK 下载与系统安装器确认，也未测试实体手机。浏览器跳转验收在独立 debug 夹具中注入安装失败，不代表正式包实际安装失败或浏览器文件已下载完成。本机正式版检查观察到内置代理回退，不声称本机 GitHub 直连已成功。详见[公开构建与 CI 验收证明](https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.15/android-update.json)和[完整验收记录](https://github.com/Brclio/brclio-xhs-media-downloader/blob/main/docs/releases/android-v1.0.15-final-verification.json)。
