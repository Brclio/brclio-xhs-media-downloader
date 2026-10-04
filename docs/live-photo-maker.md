# 本地实况制作

网页首页的「制作实况」及桌面工作台同名入口打开 `live.html`。无需登录或会员。选择一个本地视频，或最多 12 张图片；混合素材和多个视频会提示重新选择。文件在浏览器或 Electron 渲染进程中读取与处理，不发送至账号服务、解析 API 或第三方转换服务。

## 使用

1. 选择图片或视频。图片组可调整顺序、移除图片；单张图片可选择轻微推近或静止效果。GIF 按静态图片处理，原动画可先另存为视频。
2. 设置 0.5–3 秒的输出片段。视频可设置起点，所选片段必须在原视频范围内；设置片段内的封面位置。3 秒是本工具的兼容性选择，对应 iPhone 常见的拍摄时长，并非所有实况格式的统一硬上限。
3. 视频可保留所选片段的声音或静音。浏览器不具备 AAC 编码能力时，选择静音，或换用新版 Chrome / Edge、桌面客户端。
4. 制作完成后预览、下载 ZIP。解压后保持 JPG 和 MOV 同名，将二者同时导入 macOS「照片」，可经 iCloud 照片同步至 iPhone。手机「文件」中解压或普通视频保存不会自动创建照片图库里的 Live Photo；具体导入由接收应用处理。

素材总大小上限 150 MB；图片组总像素上限 6400 万；画面最长边最多 1440 像素，保持横竖方向，不放大小图，统一为偶数尺寸。输出为 30 fps H.264，保留声音时编码为 AAC。小于 0.5 秒的原视频需要先制作更长片段。不支持的图片或视频编码会明确报错。

## 文件格式与本地处理

`lib/live-photo-maker.js` 用 Canvas 生成封面和画面，再用 WebCodecs 编码。视频通过本地 blob URL 定位选定片段；声音仅录取该短片段，经 WebAudio / MediaRecorder 解码、AAC 编码，避免解码整段长视频的 PCM。取消会中止定位、关闭编码器及音频上下文，移除媒体源和临时 blob URL。

`lib/live-photo-format.js` 输出真正的配对结构：JPEG EXIF 的 Apple MakerNote 十进制键 17 保存 UUID；QuickTime MOV 的 `com.apple.quicktime.content.identifier` 使用同一 UUID；独立 `mebx` 定时元数据轨道以 int8 样本标记 `com.apple.quicktime.still-image-time`。封面捕获在对应的输出帧，静态照片与动态视频对应。与原有下载入口的 JPG + MP4 素材包不同。

格式参考：[Apple QuickTime 定时元数据样本描述](https://developer.apple.com/documentation/quicktime-file-format/timed_metadata_sample_descriptions)、[Apple Live Photo 资源加载接口](https://developer.apple.com/documentation/photos/phlivephoto/request(withresourcefileurls:placeholderimage:targetsize:contentmode:resulthandler:))、[WebCodecs](https://www.w3.org/TR/webcodecs/)、[Apple 实况拍摄说明](https://support.apple.com/en-ie/104966)。

## 验证

2026-10-04 本机验证：978 项 Node 测试、27 项 Python 测试通过，12 项 Node 测试按既有条件跳过。最终改动的 39 项专项与打包检查通过；网页和 Cloudflare Pages 构建成功。实图、图片组、带声视频截取、竖屏视频与静音视频共 5 组配对资源，以及网页和桌面实际下载 ZIP 中的资源，均被 macOS `PHLivePhoto.request` 最终非降级回调识别。390 / 768 / 1440 像素页面、取消后重试、桌面切页保留结果和返回下载工具通过；验证使用隔离的账号桥，不读取用户账号。详见 [本机验证记录](live-photo-verification.json)。

`node --test test/live-photo-maker.test.js test/live-photo-format.test.js` 校验输入限制、裁剪边界、横竖尺寸、JPEG 标识、MOV 样本表与真实定时轨道；安装了 ffmpeg / ffprobe 时还会独立解码实际 H.264 / AAC 输出。

`npm run desktop:verify:live-photo` 在隔离的 Electron 渲染环境中执行本地图片、图片组和视频转换，核验播放、音轨、裁剪、取消及响应式界面。macOS 下还使用 `PHLivePhoto.request` 验证生成的资源可被原生框架识别，不导入或更改用户照片图库。该验证需要开发机器上的 ffmpeg、ffprobe；macOS 原生校验需要 Swift。最终安装包不依赖这些工具。

网站和 Cloudflare Pages 的公开资源清单、桌面协议清单及 Electron 打包清单均包含新页面与编码模块。此功能纳入 v2.0.5，公开安装包与构建核验记录见[版本说明](releases/v2.0.5.md)；Android 原生客户端的实况制作入口不在本次实现范围内。iPhone 实机导入、壁纸与各品牌 Android 动态照片格式需另行验证。
