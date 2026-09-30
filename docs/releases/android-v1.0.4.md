# Android v1.0.4：更新失败可用浏览器下载并覆盖安装

2026 年 9 月 30 日更新，适用于 Android 8.0 及以上。独立版本号 `1.0.4`，内部版本号 `10004`。

## 本次更新

- 软件更新区新增「浏览器下载最新版 APK」按钮。安装失败或未完成时，显示直接覆盖安装、不要卸载旧版的提示，并保留已下载 APK 的安装重试入口。
- 点击按钮重新查询官方最新 Android 正式版，核对安装包地址与校验文件，再交由浏览器下载；不允许打开低于当前版本的安装包。
- 分别说明系统安装器返回的失败、取消和未知结果。系统没有回传结果时仍可使用浏览器下载入口。
- 下载地址查询或浏览器打开失败不会删除已下载的安装包。

## 安装与校验

下载 [Brclio-XHS-Android-1.0.4-release.apk](https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.4/Brclio-XHS-Android-1.0.4-release.apk)，直接覆盖原正式版，不要先卸载。正式包沿用固定签名；按系统提示完成安装。

同名 `.apk.sha256` 与 `SHA256SUMS.txt` 提供校验值，`android-update.json` 记录源码提交、版本和签名证书指纹。debug 包使用独立应用 ID。
