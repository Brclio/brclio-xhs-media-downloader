# HEIC 实况样本与导出格式

2026 年 10 月 4 日检查用户提供的 HEIC 样本。没有修改原文件，也没有导入用户照片图库。

## 样本结果

- 文件大小 904,157 字节；ImageIO 识别为 `public.heic`，单张可显示图片，7680 × 4320 像素、10 位 HEVC。
- 容器顶层是 `ftyp`、`meta`、`mdat`，没有电影时间轴 `moov` / `trak`。
- 93 个 HEIF item 包括 90 个 `hvc1` 图块、2 个 `grid` 和 1 个 `Exif`。主图由 45 个静态图块拼接，辅助透明度图由另 45 个图块拼接；这些图块不是视频帧。
- Apple MakerNote 键 17 含实况配对标识。原生接口能解码照片；文件内部没有动态视频资源。

这份 HEIC 是实况的照片部分。保留完整实况还需要其配对 MOV；仅凭 HEIC 不能恢复原来的动态内容。[Apple「照片」说明](https://support.apple.com/zh-cn/guide/photos/pht6e157c5f/mac)也将实况原片导出为静态图片和视频两个独立文件。

## 制作器输出

默认生成真正使用 HEVC 编码的 `.HEIC` 和 H.264 / 可选 AAC 的 `.MOV`。照片 Apple MakerNote 17 与视频 `com.apple.quicktime.content.identifier` 写入相同 UUID，MOV 同时包含 `com.apple.quicktime.still-image-time` 定时标记。文件名共用 UUID。v2.0.12 将默认 ZIP 改为含照片、MOV、`metadata.plist` 的完整 `.pvt` 包；在 Mac 解压后隔空投送整个包，避免两个散件在手机分开。散件 ZIP 和分别下载仍保留为备用；HEIC 和 JPEG 两种 PVT 已由用户在其 iPhone 实测确认实况接收及播放，见[PVT 验证记录](live-photo-pvt-verification.json)。0.5–8 秒为本工具的成片范围，默认 3 秒。

输出封面来自 8 位 Canvas，最长边最多 1440 像素；这次兼容 HEIC 文件格式，不保留样本的 10 位或源 HDR 信息。完整流程和验证范围见[实况制作说明](live-photo-maker.md)。
