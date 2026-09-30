# Brclio 小红书下载器 · Android

Android 客户端版本独立编号，当前为 `1.0.7`，`versionCode` 为 `10007`（首版为 `1.0.0 / 10000`），支持 Android 8.0（API 26）及以上。安装 APK 后可粘贴小红书单篇笔记链接或分享文案，也可以在其他应用中通过系统「分享」将文字交给 Brclio。

本版聚焦单篇笔记：标题与正文、原图、实况静态图与动态片段、视频清晰度选择、勾选图片与 ZIP、图片复制及系统分享。保存文件时使用 Android 系统文件选择器，由用户选择位置；无需「所有文件访问权限」或相册读取权限。不同目标应用对多图剪贴板支持不同，可改用系统分享或 ZIP。

解析需要联网，使用项目现有 HTTPS 解析服务。应用包含本地界面，Android 原生层负责网络请求、保存文件与系统分享；安装者无需安装 Node.js、Python 或其他运行时。笔记是否能解析取决于公开可见性、原链接和上游访问限制。主页批量下载、小红书登录、软件账号及会员功能不在当前 Android 版本范围内，原网页与桌面版继续独立使用。

下载在当前应用进程中进行，界面显示进度并允许取消。下载期间请保持应用打开；不承诺后台续传或被系统终止后的自动恢复。实况 ZIP 保存配对 JPG 与 MP4 素材，不包含 Apple Photos 原生 Live Photo 元数据。

## iPhone 快捷指令福利

首页解析框下方提供「小红书无水印下载快捷指令」福利入口，可点击系统浏览器查看 iCloud 页面，或复制完整链接发送到 iPhone。复制成功或失败会在福利区就地提示，不会覆盖笔记解析、保存进度。快捷指令需在 iPhone 上按页面提示添加；Android 客户端本身继续提供单篇笔记下载。

## 书籍与编程私教

首页的「了解书籍与编程私教」打开应用内的独立本地页面，介绍《编程启蒙：思维与代码》与小学至大学、留学生的一对一编程教学。页面与二维码随安装包提供，无需等待网页部署，查看时也无需联网；返回后保留下载页原有的输入、解析结果与当前任务。二维码可以点击放大，或通过 Android 系统文件选择器保存 PNG 到所选位置。

Gradle 在构建时将根目录的 `learn.html`、`learn.css`、`learn.js`、`vip.html`、`vip.css`、`vip.js` 与所需图片同步至生成的 assets 目录，网页和 Android 复用同一份内容。推广页面的原生接口只支持保存固定二维码，不提供下载器的解析或媒体访问接口。

## VIP 付费交流群

首页向所有用户展示「VIP 付费交流群」入口，无需登录或软件会员资格。入群费用为 99.99 元；群友的问题和需求会结合预算与可行性优先挑选解决，并可抢先体验后续产品。点击入口打开随安装包提供的独立本地页面，查看并放大个人微信二维码，添加微信时备注「VIP 交流群」，联系确认付费入群。页面不提供在线支付，也不会自动加入群。

二维码与书籍咨询使用同一张个人微信二维码；通过系统文件选择器保存时使用文件名 `Brclio-VIP-微信.png`。离线可查看页面与二维码，返回后保留下载页输入、解析结果与当前任务。

## 在线更新

应用启动后自动检查更新，也可在「软件更新」区手动检查。应用从本仓库公开 Releases 中查找 `android-v主版本.次版本.修订版本`，忽略草稿、预发布和桌面版标签。发现新版后由用户选择下载安装；APK 下载完成后核对 SHA256、应用 ID、版本名、递增的 `versionCode` 与当前安装应用的签名证书，然后打开 Android 系统安装器。首次安装更新时可能需要按系统提示允许 Brclio 安装应用，最后的安装确认由系统显示。

正式应用 ID 为 `com.brclio.xhs`，更新必须继续使用同一签名密钥。debug 包为 `com.brclio.xhs.debug`，不能直接升级为正式应用；首次使用正式版请从下载页面或 Android Release 单独安装。

已经下载并校验完成的 APK 在当前进程中继续保留。断网导致检查更新失败，或系统安装器未能启动后，仍可直接重试安装，无需重新下载。

安装失败、取消或未完成时，也可点击「浏览器下载最新版 APK」。应用会重新读取官方 Android 正式发布信息，校验安装包地址与对应校验文件，再交给浏览器下载。下载后直接打开 APK 覆盖安装，不要卸载当前应用，以保留应用数据；已有的应用内安装重试入口继续保留。系统明确返回失败时会显示失败提示；取消或未知结果分别说明，不将未回传的安装结果当作已知失败。

## 本地构建测试包

需要 Node.js 22+、JDK 17 或 21，以及 Android SDK。可通过 Android Studio 的 SDK Manager 安装：

- Android SDK Platform 35
- Android SDK Build-Tools 35.0.0
- Android SDK Platform-Tools（安装及设备测试需要）

设置 `JAVA_HOME` 指向 JDK，设置 `ANDROID_HOME` 指向 SDK。macOS 常见 SDK 路径为 `$HOME/Library/Android/sdk`。也可以在未纳入版本控制的 `android/local.properties` 中写入 `sdk.dir=/绝对路径/Android/sdk`；Windows 路径使用正斜线。

在仓库根目录运行：

```bash
npm run android:check
npm run android:build
```

构建脚本只使用 Node.js 内置模块，不要求安装桌面版依赖。首次构建需要联网下载 Gradle 和 Android 依赖。脚本先核对完整 JDK（包含 `javac`、`jlink`）、SDK 与 Gradle Wrapper 校验值，再运行 Android 前端 Node.js 测试、Java 单元测试、Android lint 和 APK 构建。成功后才导出：

```text
dist-android/Brclio-XHS-Android-1.0.7-debug.apk
dist-android/Brclio-XHS-Android-1.0.7-debug.apk.sha256
```

`debug` 包使用构建机的调试密钥，应用 ID 为 `com.brclio.xhs.debug`；正式包应用 ID 为 `com.brclio.xhs`，可并存。不同构建机产生的调试密钥可能不同，因此来自不同构建机的 debug 包不一定能覆盖安装。

连接已开启 USB 调试的设备后，可安装测试包：

```bash
adb install -r dist-android/Brclio-XHS-Android-1.0.7-debug.apk
```

也可用 Android Studio 打开 `android/` 目录构建及运行。构建成功仅说明代码、资源与静态检查通过，不等于完成真机解析、文件保存或图片粘贴验证。

## GitHub Actions 测试包

`.github/workflows/android-build.yml` 在相关 PR、main 分支变更或手动运行时构建 debug APK，并上传 APK、SHA256 和检查报告到该次 Actions 的 Artifacts。工作流只上传构建附件，不创建 GitHub Release、不推送标签，也不自动上架。

## 手动构建正式签名包

准备由维护者持有的 Android 签名密钥库，在当前终端或受控 CI 环境设置以下变量。密钥库和密码不要提交到 Git：

| 变量 | 用途 |
| --- | --- |
| `ANDROID_SIGNING_STORE_FILE` | 密钥库绝对路径（相对路径以 `android/` 为基准） |
| `ANDROID_SIGNING_STORE_PASSWORD` | 密钥库密码 |
| `ANDROID_SIGNING_KEY_ALIAS` | 签名密钥别名 |
| `ANDROID_SIGNING_KEY_PASSWORD` | 签名密钥密码 |
| `ANDROID_SIGNING_CERT_SHA256` | 可选的预期签名证书 SHA256；正式 CI 发布时必须提供 |

```bash
npm run android:build:release
```

成功后输出 `dist-android/Brclio-XHS-Android-1.0.7-release.apk`、同名 `.apk.sha256`、`SHA256SUMS.txt` 与 `android-update.json`。APK 使用 Android SDK 的 `apksigner` 校验真实签名，并以 `aapt` 读取并核对包名与版本；缺少签名配置、使用 Android Debug 证书、证书不符或 APK 版本不符都会失败。JSON 记录源码提交、工作区是否干净、版本、APK 字节数、校验值与签名证书指纹，供发布前核对。

后续升级继续使用同一签名密钥，并提高 `android/app/build.gradle` 中的 `versionCode` 与 `versionName`。`versionCode` 只要求严格递增，不根据版本名硬编码推算；Android 版本独立于根目录的桌面版版本号。

## 正式发布工作流

`.github/workflows/android-release.yml` 仅由 `android-v*` 标签或手动输入已有 Android 标签触发。它从标签指向的提交重新完成前端测试、Java 测试、lint、签名构建和签名核验，然后在 Android 15 模拟器上安装已公开的 `1.0.2`，通过系统界面允许本应用安装更新，再以 `adb install -r` 覆盖为新签名包。测试要求旧版与新版都能启动、更新检查界面可用，并保留应用 UID、首次安装时间与上述用户设置。失败会阻止发布。

模拟器成功后才导出供发布使用的正式附件，并将绑定源码提交和 APK SHA256 的验证结果写入 `android-update.json`。从 `1.0.3` 起，发布脚本拒绝缺少这项证明的正式包。完整界面截图、UI XML 和日志另存为工作流附件；这项测试验证 Android 包管理器的实际覆盖安装，不代表已自动确认应用内下载后弹出的系统安装器，也不代替真机验证。

从 `1.0.4` 起，还在模拟器中安装临时源码副本生成的独立 debug 夹具：仅该副本的版本设为 `0.0.0-debug`，通过既有 debug WebView 调试能力注入标记清楚的失败界面状态，再真实点击手动下载按钮。原生代码联网校验最新公开 APK 与校验文件，并将官方 APK 地址交给实际浏览器；验收记录浏览器收到的 Intent。正式 APK 不开启调试或注入接口。这项检查不冒称触发了真实安装器失败，也不将浏览器地址跳转当作文件下载完成。

从 `1.0.7` 起，模拟器发布门槛还要求正式签名包展示公开的 VIP 入口与价格，在飞行模式下打开本地群说明、放大二维码，通过系统文件选择器保存 PNG 并核对与仓库二维码的完整字节，返回后保留系统分享填入的文本与单篇解析入口。缺少这项与 APK 及源码绑定的证明时，发布脚本拒绝公开 Release。截图、界面 XML 与二维码保存校验记录随该次模拟器检查输出。

维护者首次准备并妥善保管固定签名密钥后，在 GitHub 仓库配置以下 Secrets：

- `ANDROID_SIGNING_KEYSTORE_BASE64`：完整密钥库文件的 Base64。
- `ANDROID_SIGNING_STORE_PASSWORD`：密钥库密码。
- `ANDROID_SIGNING_KEY_ALIAS`：签名密钥别名。
- `ANDROID_SIGNING_KEY_PASSWORD`：签名密钥密码。

另配置公开仓库变量 `ANDROID_SIGNING_CERT_SHA256` 为正式签名证书的 SHA256 指纹。工作流把密钥解码到临时目录，以 `ANDROID_SIGNING_STORE_FILE` 传给构建，完成后清除临时文件。发布升级所需的原始密钥和密码应另行备份，不要为每个版本重新生成密钥。

发布前先提交最终代码与该版本说明，例如 `docs/releases/android-v1.0.7.md`，再把 `android-v1.0.7` 标签推送到同一提交。发布脚本要求构建时工作区干净，且 APK 记录的提交与本地标签、远端标签及当前检出提交完全相同。它先创建草稿，上传并重新下载全部四个附件核对字节，再以 `--latest=false` 公开；Android 不占用桌面版的 GitHub Latest，原 Mac / Windows 自动更新仍使用桌面发布。

同一标签的发布作业串行执行。已公开的 Android Release 不覆盖；失败留下的草稿只有在提交和附件名称一致时才可由同一标签重试。若正式版本需要修复，请增加版本名和 `versionCode` 后发布新标签。手动运行同一发布流程可用：

```bash
ANDROID_RELEASE_TAG=android-v1.0.7 node scripts/publish-android-release.mjs
```

此命令需要已通过完整构建的正式附件、公开证书变量和已登录的 GitHub CLI；它会实际发布 Release。普通本地构建与 debug CI 均不会发布。

## 验证范围

本轮构建、Android 15 模拟器实测与待验证项目见 [本地验证记录](VALIDATION.md)。

发布前在 Android 8 和较新 Android 设备上分别核对冷启动、旋转屏幕、分享文字进入应用、长短链接解析、图文与普通视频、实况素材配对、文案复制、勾选 ZIP、图片复制/分享、文件选择取消、下载取消及断网错误。含多条媒体的归档应检查文件数量、顺序与字节内容；播放视频时应检查画面和声音。当前工具运行的实际验证结果由该次构建或测试记录说明，不能用本节操作说明代替。

## 构建工具来源

- Android Gradle Plugin `8.9.2`、SDK `35`：[官方兼容说明](https://developer.android.com/build/releases/agp-8-9-0-release-notes)。
- Gradle `8.11.1`：`gradlew`、`gradlew.bat`、Wrapper JAR 来自 [Gradle 官方 v8.11.1 源码](https://github.com/gradle/gradle/tree/v8.11.1)。
- Wrapper JAR SHA256：`2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`，与 [Gradle 官方校验值](https://services.gradle.org/distributions/gradle-8.11.1-wrapper.jar.sha256) 一致。
- Gradle 分发 ZIP 的官方 SHA256 已固定在 `gradle/wrapper/gradle-wrapper.properties`，Wrapper 下载时自动校验。
- 启动图标复用仓库 `desktop/resources/icon.png`。
