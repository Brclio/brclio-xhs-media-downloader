# Android v1.0.11：系统代理优先与升级代理关闭

版本记录日期：2026 年 10 月 3 日（北京时间）。

- 已开启系统 HTTP/PAC 代理或应用 VPN 时，更新请求沿用系统网络，不启动内置代理，不修改系统设置。
- 默认仅在检查更新、应用内下载安装包或获取可信下载地址时使用内置升级代理。订阅来自管理后台，不预设默认地址，需要时刷新订阅并选择实测延迟最低的可用节点。
- 升级区域新增「关闭软件内置代理」按钮，可停止代理准备和传输。手动关闭状态持续保存，重新打开软件和后台自动检查保持停用；下次明确点击检查或下载时，已接受的新操作自动恢复资格。
- 重复点击和被拒绝的请求不恢复代理。操作完成、失败、取消或退出后自动关闭内置代理；本地 APK 安装不启动代理。
- 外部浏览器下载使用浏览器自己的网络设置。未完成的应用内 APK 取消后需重新下载，已校验的安装包仍可直接重试安装。

支持 Android 8.0 及以上，正式应用 ID 为 `com.brclio.xhs`，`versionCode` 为 `10011`。正式包继续使用固定签名，请覆盖安装并保留原应用，不要先卸载。

[下载正式 APK](https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.11/Brclio-XHS-Android-1.0.11-release.apk) · [SHA256 校验](https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.11/Brclio-XHS-Android-1.0.11-release.apk.sha256)
