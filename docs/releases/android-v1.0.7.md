# Android v1.0.7：新增 VIP 付费交流群

2026 年 9 月 30 日更新。

## 本次更新

- 首页新增「VIP 交流群」入口，所有用户均可查看，无需登录或开通软件会员。
- 入群费用 **99.99 元**，添加 AI悦创 / Brclio 个人微信并备注「VIP 交流群」，确认付费后邀请入群。
- 在预算与可行性范围内，优先从群友提交的问题、需求中择优推进解决；提供后续产品抢先体验机会。
- 页面与二维码随 APK 内置，离线可查看，支持二维码放大和通过系统文件窗口保存。
- 交流群费用与软件会员分别办理；保留单篇笔记下载与现有更新功能。

## 安装与校验

下载 [Brclio-XHS-Android-1.0.7-release.apk](https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.7/Brclio-XHS-Android-1.0.7-release.apk)，直接覆盖原正式版，不要先卸载。正式包沿用固定签名；按系统提示完成安装。

同名 `.apk.sha256` 与 `SHA256SUMS.txt` 提供校验值，`android-update.json` 记录源码提交、版本和签名证书指纹。debug 包使用独立应用 ID。

## 发布核验

正式 APK、校验文件和源码证明均已公开，匿名下载、SHA256、固定签名及 14 个打包页面资源核对通过。Android API 35 模拟器已验证旧正式版覆盖升级、数据保留、无需登录的 VIP 入口、飞行模式离线浏览、二维码系统文件保存以及返回下载页后保留输入。详见 [发布核验记录](android-v1.0.7-publication-verification.json)。

覆盖升级通过系统 Package Manager 测试；应用内下载安装确认未自动化。手动下载回退通过 debug 页面故障夹具验证，不代表真实生产安装器故障或浏览器下载完成。
