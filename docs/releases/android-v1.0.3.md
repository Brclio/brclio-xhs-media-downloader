# Android v1.0.3：保留已下载更新，失败后直接重试

2026 年 9 月 30 日更新，适用于 Android 8.0 及以上。Android 独立编号为 `1.0.3`，内部版本号为 `10003`；Mac / Windows 对应版本为 [v1.8.19](https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v1.8.19)。

## 本次修复

已下载并校验的更新安装包，在重新检查版本时断网，或系统安装器暂时无法打开后，仍可再次点击「安装更新」。之前这些错误会隐藏安装按钮，即使安装包还在缓存中，也需要重新下载或重新检查版本才能继续。

本版独立记录安装包是否就绪，在错误提示后保留直接重试入口。缓存丢失、大小不符或校验失败时继续要求重新下载；检查、下载和校验进行中不能重复发起安装。每次安装前仍重新核对文件哈希、包名、递增版本与当前应用签名。

书籍与编程私教页面、二维码保存、小红书单篇解析、原图、实况素材、视频、文案、ZIP 和系统分享均继续提供。

## 安装与校验

下载 [Brclio-XHS-Android-1.0.3-release.apk](https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.3/Brclio-XHS-Android-1.0.3-release.apk) 安装，或在应用内「软件更新」检查新版。正式包沿用固定 Android 签名，可覆盖升级 v1.0.0、v1.0.1 和 v1.0.2；首次通过应用安装更新时，需在系统设置中允许 Brclio 安装应用，再返回点击「安装更新」。

同名 `.apk.sha256` 与 `SHA256SUMS.txt` 提供文件校验值，`android-update.json` 记录版本、源码提交与签名证书指纹。debug 测试包使用独立应用 ID，不会被正式包覆盖。
