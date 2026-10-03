# 更新代理内核与发行包

桌面和 Android 的更新代理使用固定版本的官方 Mihomo 内核。版本、来源、下载文件及 SHA256 位于 `desktop/resources/update-proxy/runtime.lock.json`，构建前按照锁定值验证官方文件。发行包随附 GPL 许可证、来源声明及对应版本的源码归档；内核仅作为独立进程执行。

首次运行 `npm run desktop:prepare:proxy` 或 `npm run android:prepare:proxy` 会下载当前平台或 Android 三种 ABI 的内核，后续构建复用经过 SHA256 校验的忽略目录缓存。桌面 `beforePack` 和 Android `preBuild` 自动准备内核，正式发行包不允许缺少内核。

客户端只使用管理后台提供的订阅列表，发行包不携带预设链接。构建脚本不读取旧订阅环境变量或私有本地配置文件；即使开发机留有这些配置，也不会写入软件资源。为兼容原有资源布局，生成的 `subscription.json` 仅包含 `{"subscriptionUrls":[],"subscriptionUrl":""}`，客户端不将它作为订阅来源。

GitHub Actions 桌面和 Android 工作流不注入订阅 Secret，正式构建也不要求订阅配置。订阅的增加、修改、删除和启停均在管理后台完成，最多支持 8 个来源；客户端需要内置代理时获取最新配置，并保存后台配置缓存以便配置接口暂时不可达时使用。明确禁用的新版配置优先于旧缓存，无后台配置时不启用内置代理。已有系统代理或 Android 应用 VPN 时，更新直接沿用系统网络，跳过内核准备；手动停用且尚无新的明确用户操作时同样跳过内核准备。其它情况下配置接口及订阅抓取直连，更新任务使用自己的本地代理连接。系统代理、VPN 和普通业务连接不变。

内置代理的手动关闭涵盖配置获取、订阅下载、内核启动、测速与更新传输阶段，只取消软件拥有的内置代理会话。关闭偏好持久保存，重启和后台自动检查保持停用；下次已接受的明确检查更新、下载更新或下载安装包地址请求自动恢复资格，任务完成、失败或取消后自动关闭代理。本地安装无需启动代理。网络传输实现参考 [Electron 会话代理 API](https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig) 和 [Android 默认 HTTP 代理 API](https://developer.android.com/reference/android/net/ConnectivityManager#getDefaultProxy())；检测或停止不会写入用户的系统代理设置。

桌面内核资源位于 `Resources/proxy/`，包含 `mihomo`（Windows 为 `mihomo.exe`）、空的兼容 `subscription.json`、`build-info.json`、`LICENSE`、`NOTICE` 和 `corresponding-source.tar.gz`。Android 的三种 ABI 为 `arm64-v8a`、`armeabi-v7a` 和 `x86_64`，内核由 Android 安装器解压到 nativeLibraryDir，其名称为 `libbrclio_update_proxy.so`，空的兼容文件及声明位于应用 assets 的 `update-proxy/`。

Android 构建还需要官方 NDK **27.2.12479018**，CI 已通过 `sdkmanager 'ndk;27.2.12479018'` 安装。它将已提交的 `android-parent-launcher.c` 编译为三种 ABI 的 `libbrclio_update_proxy_launcher.so`；启动器先设置 `PR_SET_PDEATHSIG`，再用同一进程执行代理内核，使应用进程崩溃或被系统结束时内核也随之终止。启动器按照 Android API 26 和 16 KB 页面对齐要求编译，代码及其构建摘要一同分发。本地可通过 `ANDROID_NDK_HOME` 指定该 NDK，或通过 `ANDROID_HOME` 的 `ndk/27.2.12479018` 自动查找。

`scripts/verify-packaged-update-proxy.mjs` 可只读验证已打包桌面软件的 Resources 目录；它核对固定版本与源归档、许可证和元数据，执行内核 `-v` 原生启动检查，并在 macOS 验证 Mach-O 架构和严格代码签名。兼容文件可不存在或为空，任何嵌入的订阅链接都会导致验证失败，且错误不会打印文件内容。`-v` 立即退出，不启动代理或访问订阅网络。macOS 的打包签名可能改变二进制字节，因此不会把签名前 SHA256 当作签后字节的校验值。

正式安装包验证流程在 ZIP 和 DMG 等实际发行内容上执行该验证，并在 release proof 中记录 `bundledUpdateProxyVerified: true`、`bundledSubscriptionsAbsent: true` 及 `configurationSource: "management-api"`。Windows 与 macOS 的完整安装包和更新验证仍在各自原生 CI 机器执行；本地跨架构准备成功并不代表其它系统的原生运行验证完成。

Android 的 `scripts/verify-packaged-android-proxy.mjs <APK path>` 直接读取 APK ZIP，不解压到磁盘，也不需要第三方 Node 依赖。它强制检查空订阅资源、三个 ABI 的全部六个 ELF 文件、官方内核的固定原始 SHA256、当前编译的父进程启动器、固定版本元数据、许可证、声明和对应源码。Android 的资产合并会将 `.tar.gz` 解压为 `.tar`；两种布局都使用从官方归档推导的固定校验值。启动器与本次构建生成目录比较，因此独立检查也需保留本次 `prepareUpdateProxy` 产物。此检查验证包内容，实际执行和更新安装仍由设备验收负责。

`scripts/build-android.mjs` 在 APK 签名验证后自动执行该门槛，失败则不导出发行包。正式版的 `android-update.json` 写入 `bundledUpdateProxyVerified`、`bundledSubscriptionsAbsent` 和详细报告，包括 APK 校验值、三个 ABI 的内核及启动器校验值；发行流程须同时验证这些证据与最终 APK 一致。

## 本地联网验证

`electron scripts/verify-update-proxy.mjs --live` 实际刷新管理后台配置和订阅、测量节点延迟并检查 GitHub 最新版本；加 `--download` 下载完整安装包并校验 SHA256，不安装软件。整个验证使用临时应用资料目录，并检查默认 Electron 会话的代理设置未被改动。报告在被忽略的 `dist-desktop/proxy-validation/`，不包含订阅地址或节点凭据。

隔离测试可以通过临时配置接口模拟后台提供订阅，报告必须记录 `configurationFixture`，不能将此结果当作真实后台配置修改的证明。测试配置不进入发行资源。

2026-10-02 的 Mac arm64 本地验收：两个来源合并 78 个节点，实际签名应用的更新检查通过，并观察到节点出口受限后的自动切换；完成及退出后代理进程均为零。第一来源单独完成 141,990,196 字节安装包下载及校验。双来源的完整下载验收选中了第二来源的低延迟节点，但仅在五分钟测试时限内传输约 10 MB，因此没有完整下载成功的结论；低延迟不保证大文件吞吐量。该时限属于验证脚本，客户端保留原有下载进度及断点续传行为。

Android API 35 arm64 调试模拟器也完成 78 个节点的测量，66 个可用；实际内核及独立认证客户端访问 GitHub 的更新检查通过。控制接口和代理接口分别拒绝未认证请求（401 / 407），正常结束、取消、应用进程被 SIGKILL 后内核均退出，系统代理和 VPN 接口保持不变。由于模拟器直连订阅网络不稳定，该次订阅抓取使用隔离的主机传输测试环境，报告明确标记 `bootstrapTransportFixture: true`；没有 Android 生产网络直连成功的结论。该次构建、lint 和 30 个 Java 测试通过。后续按管理后台唯一来源要求刷新生产资源，兼容文件不含订阅链接；不应将此前的联网报告当作新版生产 APK 的完整验收。尚未验证实体 Android 设备或发布签名安装。

发布前须基于最终提交重新完成原生构建、实际安装包、后台配置及各客户端更新验收，以上记录本身不证明上线或覆盖用户已安装客户端。
