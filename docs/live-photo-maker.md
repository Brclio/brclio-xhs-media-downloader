# 本地实况制作

v2.0.7 新增默认 HEIC + MOV、可选 JPEG + MOV，以及照片与 MOV 的分别下载入口；完整 ZIP 继续提供。版本附件与发布核验见[版本说明](releases/v2.0.7.md)。v2.0.5 的实况功能使用 JPG + MOV ZIP，v2.0.6 是桌面更新代理改进。

网页首页的「制作实况」及桌面工作台同名入口打开 `live.html`。无需登录或会员。选择一个本地视频，或最多 12 张图片；混合素材和多个视频会提示重新选择。文件在浏览器或 Electron 渲染进程中读取与处理，不发送至账号服务、解析 API 或第三方转换服务。

## 使用

1. 选择图片或视频。图片组可调整顺序、移除图片；单张图片可选择轻微推近或静止效果。支持浏览器可解码的 JPG、PNG、WebP、GIF；GIF 按静态图片处理，原动画可先另存为视频。本次增加 HEIC 输出，不承诺 HEIC 源图片的读取。
2. 设置 0.5–3 秒的输出片段。视频可设置起点，所选片段必须在原视频范围内；设置片段内的封面位置。3 秒是本工具的兼容性选择，对应 iPhone 常见的拍摄时长，并非所有实况格式的统一硬上限。
3. 视频可保留所选片段的声音或静音。浏览器不具备 AAC 编码能力时，选择静音，或换用新版 Chrome / Edge、桌面客户端。
4. 选择导出格式。默认 HEIC + MOV，也可选 JPEG + MOV；设备不能进行本地 HEIC 编码时会明确提示，由用户选择 JPEG，不会自动切换格式。
5. 制作完成后预览，可分别下载 HEIC 照片与 MOV，也可下载包含两者及 `README.txt` 的完整 ZIP。JPEG 选项的照片下载为 JPG。文件名分别为 `Brclio-Live-<UUID>.HEIC`（或 `.JPG`）和 `Brclio-Live-<UUID>.MOV`，保留共同的 UUID 名称和两个文件。
6. 将配对照片与 MOV 同时导入 macOS「照片」，检查 LIVE 标记及动态播放；需要同步到 iPhone 时开启同一账号的 iCloud 照片并等待同步。手机「文件」中解压或普通视频保存不会自动创建照片图库里的 Live Photo；具体导入与识别由接收应用处理。

完整实况需要照片与视频两个配对文件，只保存 HEIC / JPG 或 MOV 中一个会丢失其中一部分。[Apple「照片」使用手册](https://support.apple.com/zh-cn/guide/photos/pht6e157c5f/mac)说明，在「文件 → 导出 → 导出未修改的原片」中导出实况，会分别得到静态图片和视频；原片使用导入图库时的格式。这不代表所有实况的静态部分都必须是 HEIC。

素材总大小上限 150 MB；图片组总像素上限 6400 万；画面最长边最多 1440 像素，保持横竖方向，不放大小图，统一为偶数尺寸。MOV 视频输出为 30 fps H.264，保留声音时编码为 AAC；HEIC 静态照片使用 HEVC 编码。小于 0.5 秒的原视频需要先制作更长片段。不支持的图片或视频编码会明确报错。

## 文件格式与本地处理

`lib/live-photo-maker.js` 用 Canvas 生成封面和画面，再用 WebCodecs 编码 MOV 的视频与音频。视频通过本地 blob URL 定位选定片段；声音仅录取该短片段，经 WebAudio / MediaRecorder 解码、AAC 编码，避免解码整段长视频的 PCM。

`lib/live-photo-heic-encoder.js` 将封面的 Canvas 像素交给独立的 `lib/live-photo-heic-worker.js`。Worker 加载随项目提供的 WebAssembly 版 libheif / Kvazaar，在本机进行 HEVC 编码并封装真实 HEIC 文件。该流程使用 Canvas 的 8 位 RGBA 像素，不保留源素材的 HDR 或 10 位信息；不能因扩展名为 HEIC 就视为 HDR 输出。HEIC 不依赖浏览器提供原生 HEVC 编码器，但需要 Worker、WebAssembly 及编码器资源可用；MOV 仍需要 WebCodecs H.264 支持。

`lib/live-photo-heic.js` 将 UUID 写入 HEIC 的 EXIF Apple MakerNote，JPEG 选项则由 `lib/live-photo-format.js` 写入同一格式的 Apple MakerNote 十进制键 17。QuickTime MOV 的 `com.apple.quicktime.content.identifier` 使用相同 UUID；独立 `mebx` 定时元数据轨道以 int8 样本标记 `com.apple.quicktime.still-image-time`。封面捕获在对应的输出帧，静态照片与动态视频对应；共同的 UUID 文件名方便保留配对，实际配对信息也写入文件内部。

取消会中止定位、关闭编码器及音频上下文，并终止 HEIC Worker，释放其 WebAssembly 内存。修改素材、设置或导出格式后会清除上一次结果；照片、MOV、ZIP 和预览的临时 blob URL 一并回收。

格式参考：[Apple QuickTime 定时元数据样本描述](https://developer.apple.com/documentation/quicktime-file-format/timed_metadata_sample_descriptions)、[Apple Live Photo 资源加载接口](https://developer.apple.com/documentation/photos/phlivephoto/request(withresourcefileurls:placeholderimage:targetsize:contentmode:resulthandler:))、[WebCodecs](https://www.w3.org/TR/webcodecs/)、[Apple 实况拍摄说明](https://support.apple.com/en-ie/104966)。

## 验证

以下记录对应已发布的 JPG + MOV 实况功能，不能作为本次 HEIC 更新的验收记录。2026-10-04 本机验证：978 项 Node 测试、27 项 Python 测试通过，12 项 Node 测试按既有条件跳过。最终改动的 39 项专项与打包检查通过；网页和 Cloudflare Pages 构建成功。实图、图片组、带声视频截取、竖屏视频与静音视频共 5 组 JPG + MOV 配对资源，以及网页和桌面实际下载 ZIP 中的资源，均被 macOS `PHLivePhoto.request` 最终非降级回调识别。390 / 768 / 1440 像素页面、取消后重试、桌面切页保留结果和返回下载工具通过；验证使用隔离的账号桥，不读取用户账号。详见 [本机验证记录](live-photo-verification.json)。

本次 HEIC 编码、配对识别、格式切换及分别下载已通过独立本机验收：1,010 项 Node 和 27 项 Python 测试通过；实际网页、桌面私有协议与沙箱内嵌页面导出通过；直接下载与 ZIP 文件逐字节一致；ImageIO 解码 HEIC、读取配对标识，`PHLivePhoto.request` 最终回调识别 HEIC + MOV 与 JPEG + MOV。1440 × 960 软件编码后的红蓝像素也已独立解码验证。见[本次 HEIC 验收记录](live-photo-heic-verification.json)与[样本分析](heic-live-photo-format.md)。

`node --test test/live-photo-maker.test.js test/live-photo-format.test.js` 校验输入限制、裁剪边界、横竖尺寸、JPEG 标识、MOV 样本表与真实定时轨道；安装了 ffmpeg / ffprobe 时还会独立解码实际 H.264 / AAC 输出。

`npm run desktop:verify:live-photo` 在隔离的 Electron 渲染环境中执行本地图片、图片组和视频转换，核验播放、音轨、裁剪、取消及响应式界面。macOS 下还使用 `PHLivePhoto.request` 验证生成的资源可被原生框架识别，不导入或更改用户照片图库。该验证需要开发机器上的 ffmpeg、ffprobe；macOS 原生校验需要 Swift。最终安装包不依赖这些工具。

网站和 Cloudflare Pages 的公开资源清单、桌面协议清单及 Electron 打包清单包含实况页面与编码模块。已发布的 JPG + MOV 功能纳入 v2.0.5，公开安装包与构建核验记录见[版本说明](releases/v2.0.5.md)；本次 HEIC 更新尚未发布。Android 原生客户端的实况制作入口不在本次实现范围内。iPhone 实机导入、iCloud 同步全流程、壁纸及 Windows 相册识别和各品牌 Android 动态照片格式需另行验证。
