# 本地实况制作

v2.0.7 新增默认 HEIC + MOV、可选 JPEG + MOV，以及照片与 MOV 的分别下载入口。版本附件与发布核验见[版本说明](releases/v2.0.7.md)。v2.0.5 的实况功能使用 JPG + MOV ZIP，v2.0.6 是桌面更新代理改进。

v2.0.12 改进：默认下载改为含完整 `.pvt` 实况包的 ZIP，以解决两个散件通过隔空投送后在 iPhone 上分开的问题。参考 [write-then-publish 的交接方式](https://github.com/fxyadela/write-then-publish#live-photo)，使用本项目独立实现的封装，保留既有 HEIC 编码和真实封面定时轨道。同时增加 0.5–8 秒成片与视频 1 / 1.5 / 2 / 3 倍速。用户已在本次对话实测确认：HEIC 和 JPEG 两种完整 PVT 包隔空投送到其 iPhone 后均能作为实况接收并播放。8 秒是本工具支持上限；Apple 未公布适用于所有自制实况导入方式的统一最长时长。默认仍为 3 秒。

网页首页的「制作实况」及桌面工作台同名入口打开 `live.html`。无需登录或会员。选择一个本地视频，或最多 12 张图片；混合素材和多个视频会提示重新选择。文件在浏览器或 Electron 渲染进程中读取与处理，不发送至账号服务、解析 API 或第三方转换服务。

## 使用

1. 选择图片或视频。图片组可调整顺序、移除图片；单张图片可选择轻微推近或静止效果。支持浏览器可解码的 JPG、PNG、WebP、GIF；GIF 按静态图片处理，原动画可先另存为视频。本次增加 HEIC 输出，不承诺 HEIC 源图片的读取。
2. 设置 0.5–8 秒的成片，提供 3 / 5 / 8 秒快捷选择；推荐先用 3 秒检查手机接收。视频可设置起点与 1 / 1.5 / 2 / 3 倍速，取用的原视频长度为「成片时长 × 倍速」。不足的档位禁用，片段与封面预览按同一倍速映射。封面位置对齐实际编码的 30 fps 帧，包括不足一帧的片段末尾。
3. 原速视频可保留所选片段的声音或静音。倍速成片统一静音，切回原速恢复声音选项。浏览器不具备 AAC 编码能力时，选择静音，或换用新版 Chrome / Edge、桌面客户端。
4. 选择导出格式。默认 HEIC + MOV，也可选 JPEG + MOV；设备不能进行本地 HEIC 编码时会明确提示，由用户选择 JPEG，不会自动切换格式。
5. 制作完成后预览，默认「下载实况包 ZIP」。在 Mac 解压后得到 `Brclio-Live-<UUID>.pvt`；包内为同名 `.HEIC`（或 `.JPG`）、`.MOV` 和 `metadata.plist`，导入说明 `README.txt` 在包外。不要更改包内名称或拆开发送。
6. 在 Finder 中选中整个 `.pvt` → 共享 → 隔空投送 → iPhone，接收后在「照片」检查 LIVE / 实况标记和长按播放。直接发送 ZIP 或两个散件不等于传输完整实况。HEIC 2 秒与 JPEG 3 秒样本均获用户实机确认；其他设备与系统版本仍应检查接收结果。
7. 「散件备份与其他导入方式」中保留原散件 ZIP、照片和 MOV 的直接下载。可在 Mac「照片」同时导入配对资源，再通过同一账号的 iCloud 照片同步；散件下载仅供备份与支持配对导入的应用。

完整实况需要照片与视频两个配对文件，只保存 HEIC / JPG 或 MOV 中一个会丢失其中一部分。[Apple「照片」使用手册](https://support.apple.com/zh-cn/guide/photos/pht6e157c5f/mac)说明，在「文件 → 导出 → 导出未修改的原片」中导出实况，会分别得到静态图片和视频；原片使用导入图库时的格式。这不代表所有实况的静态部分都必须是 HEIC。

网页版视频素材与各端图片素材总大小上限 150 MB；Mac / Windows 桌面版视频素材不设固定文件大小上限，仅对选中的短片段编码。图片组总像素上限 6400 万；画面最长边最多 1440 像素，保持横竖方向，不放大小图，统一为偶数尺寸。MOV 视频输出为 30 fps H.264，保留声音时编码为 AAC；HEIC 静态照片使用 HEVC 编码。小于 0.5 秒的原视频需要先制作更长片段。不支持的图片或视频编码会明确报错。

## 文件格式与本地处理

`lib/live-photo-maker.js` 用 Canvas 生成封面和画面，再用 WebCodecs 编码 MOV 的视频与音频。视频通过本地 blob URL 定位选定片段；声音仅录取该短片段，经 WebAudio / MediaRecorder 解码、AAC 编码，避免解码整段长视频的 PCM。

`lib/live-photo-heic-encoder.js` 将封面的 Canvas 像素交给独立的 `lib/live-photo-heic-worker.js`。Worker 加载随项目提供的 WebAssembly 版 libheif / Kvazaar，在本机进行 HEVC 编码并封装真实 HEIC 文件。该流程使用 Canvas 的 8 位 RGBA 像素，不保留源素材的 HDR 或 10 位信息；不能因扩展名为 HEIC 就视为 HDR 输出。HEIC 不依赖浏览器提供原生 HEVC 编码器，但需要 Worker、WebAssembly 及编码器资源可用；MOV 仍需要 WebCodecs H.264 支持。

`lib/live-photo-heic.js` 将 UUID 写入 HEIC 的 EXIF Apple MakerNote，JPEG 选项则由 `lib/live-photo-format.js` 写入同一格式的 Apple MakerNote 十进制键 17。QuickTime MOV 的 `com.apple.quicktime.content.identifier` 使用相同 UUID；独立 `mebx` 定时元数据轨道以 int8 样本标记 `com.apple.quicktime.still-image-time`。封面捕获在对应的输出帧，静态照片与动态视频对应；共同的 UUID 文件名方便保留配对，实际配对信息也写入文件内部。

`lib/live-photo-package.js` 在配对资源外包装 `.pvt` 目录，不转码或修改媒体字节。`metadata.plist` 的 `PFVideoComplementMetadataVersionKey` 为字符串 `1`。macOS 已注册该扩展名为 `com.apple.private.live-photo-bundle`；浏览器提供 ZIP 是为了完整保存目录结构，解压后才是用于隔空投送的包。默认实况包 ZIP 与备用散件 ZIP 共用同一组媒体数据。

取消会中止定位、关闭编码器及音频上下文，并终止 HEIC Worker，释放其 WebAssembly 内存。修改素材、设置或导出格式后会清除上一次结果；照片、MOV、两个 ZIP 和预览的临时 blob URL 一并回收。

格式参考：[Apple QuickTime 定时元数据样本描述](https://developer.apple.com/documentation/quicktime-file-format/timed_metadata_sample_descriptions)、[Apple Live Photo 资源加载接口](https://developer.apple.com/documentation/photos/phlivephoto/request(withresourcefileurls:placeholderimage:targetsize:contentmode:resulthandler:))、[WebCodecs](https://www.w3.org/TR/webcodecs/)、[Apple 实况拍摄说明](https://support.apple.com/en-ie/104966)。

## 验证

2026-10-10 PVT 改进：1,128 项 Node 测试与 27 项 Python 测试通过，12 项 Node 测试按既有条件跳过；网页与 Cloudflare Pages 构建成功。8 项真实引擎案例及网页、桌面协议、桌面侧栏嵌入验证通过，`rendererErrors=[]`。独立 FFmpeg 解码验证 2× 源画面映射、0.51 秒片段的末帧封面；8 秒成片及配对资源被原生 Photos 框架识别。实际下载的 PVT ZIP 经 `unzip` / `plutil` 检查；HEIC 和 JPEG 目录包被系统识别为 `com.apple.private.live-photo-bundle`。最后由用户将两个样本整包隔空投送到 iPhone，并明确反馈「两种格式都能作为实况接收并播放」。该反馈为用户实机确认，未采集设备型号或 iOS 版本；不能扩展为所有设备或平台的兼容保证。详见[本次 PVT 验证记录](live-photo-pvt-verification.json)。

以下记录对应已发布的 JPG + MOV 实况功能，不能作为本次 HEIC 更新的验收记录。2026-10-04 本机验证：978 项 Node 测试、27 项 Python 测试通过，12 项 Node 测试按既有条件跳过。最终改动的 39 项专项与打包检查通过；网页和 Cloudflare Pages 构建成功。实图、图片组、带声视频截取、竖屏视频与静音视频共 5 组 JPG + MOV 配对资源，以及网页和桌面实际下载 ZIP 中的资源，均被 macOS `PHLivePhoto.request` 最终非降级回调识别。390 / 768 / 1440 像素页面、取消后重试、桌面切页保留结果和返回下载工具通过；验证使用隔离的账号桥，不读取用户账号。详见 [本机验证记录](live-photo-verification.json)。

本次 HEIC 编码、配对识别、格式切换及分别下载已通过独立本机验收：1,010 项 Node 和 27 项 Python 测试通过；实际网页、桌面私有协议与沙箱内嵌页面导出通过；直接下载与 ZIP 文件逐字节一致；ImageIO 解码 HEIC、读取配对标识，`PHLivePhoto.request` 最终回调识别 HEIC + MOV 与 JPEG + MOV。1440 × 960 软件编码后的红蓝像素也已独立解码验证。见[本次 HEIC 验收记录](live-photo-heic-verification.json)与[样本分析](heic-live-photo-format.md)。

`node --test test/live-photo-maker.test.js test/live-photo-format.test.js test/live-photo-heic.test.js test/live-photo-package.test.js` 校验输入限制、倍速裁剪边界、横竖尺寸、封面帧、JPEG / HEIC 标识、MOV 样本表、8 秒时间轴与真实定时轨道、PVT ZIP 结构；安装了 ffmpeg / ffprobe 时还会独立解码实际 H.264 / AAC 输出。macOS 下用 `unzip`、`plutil`、Swift 检查解压包的 `isPackage` 与实际 UTI。

`npm run desktop:verify:live-photo` 在隔离的 Electron 渲染环境中执行本地图片、图片组和视频转换，核验播放、音轨、裁剪、取消及响应式界面。macOS 下还使用 `PHLivePhoto.request` 验证生成的资源可被原生框架识别，不导入或更改用户照片图库。该验证需要开发机器上的 ffmpeg、ffprobe；macOS 原生校验需要 Swift。最终安装包不依赖这些工具。

网站和 Cloudflare Pages 的公开资源清单、桌面协议清单及 Electron 打包清单包含实况页面与编码、PVT 打包模块。历史 JPG + MOV 发布记录见[版本说明](releases/v2.0.5.md)，HEIC 发布记录见[版本说明](releases/v2.0.7.md)。本次 PVT 与倍速改进仍是工作区代码。Android 原生客户端的实况制作入口不在本次实现范围内。iPhone 的整包隔空投送已获用户确认；iCloud 同步全流程、壁纸及 Windows 相册识别和各品牌 Android 动态照片格式需另行验证。
