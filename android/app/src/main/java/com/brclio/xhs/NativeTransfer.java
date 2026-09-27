package com.brclio.xhs;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.HashMap;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/** Network and disk work; never called on the UI thread. */
final class NativeTransfer {
    private static final String USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
    private static final int BUFFER_SIZE = 64 * 1024;
    private static final long DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000L;
    private static final long JOB_TIMEOUT_MS = 30 * 60 * 1000L;

    interface Progress { void update(long bytes); }

    static final class Cancellation {
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        private volatile HttpURLConnection connection;
        final long startedAt = System.nanoTime();

        void cancel() {
            cancelled.set(true);
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
        }

        boolean isCancelled() { return cancelled.get(); }

        void check() throws IOException {
            if (isCancelled() || Thread.currentThread().isInterrupted()) throw new IOException("操作已取消。");
            if ((System.nanoTime() - startedAt) / 1_000_000 > JOB_TIMEOUT_MS) {
                throw new IOException("操作超时，请减少文件数量后重试。");
            }
        }

        void attach(HttpURLConnection value) throws IOException {
            connection = value;
            try { check(); } catch (IOException error) { value.disconnect(); throw error; }
        }

        void detach(HttpURLConnection value) {
            if (connection == value) connection = null;
            value.disconnect();
        }
    }

    static final class Entry {
        final String name;
        final String kind;
        final String text;
        final List<URI> urls;
        final boolean requireAudio;

        Entry(String name, String kind, String text, List<URI> urls, boolean requireAudio) {
            this.name = name;
            this.kind = kind;
            this.text = text;
            this.urls = urls;
            this.requireAudio = requireAudio;
        }
    }

    static final class Media {
        final File file;
        final String mime;
        Media(File file, String mime) { this.file = file; this.mime = mime; }
    }

    static final class Preview {
        final InputStream stream;
        final String mime;
        final int status;
        final Map<String, String> headers;
        Preview(InputStream stream, String mime, int status, Map<String, String> headers) {
            this.stream = stream;
            this.mime = mime;
            this.status = status;
            this.headers = headers;
        }
    }

    static Preview preview(URI initial, String range, Cancellation cancellation, Runnable closed) throws IOException {
        URI current = initial;
        for (int redirect = 0; redirect <= 5; redirect++) {
            NativePolicy.mediaUri(current.toString());
            HttpURLConnection connection = connection(current, cancellation);
            boolean streaming = false;
            try {
                if (range != null && range.matches("bytes=\\d+-\\d*")) connection.setRequestProperty("Range", range);
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || redirect == 5) throw new IOException("媒体预览重定向异常。");
                    current = NativePolicy.mediaUri(current.resolve(location).toString());
                    continue;
                }
                if (status != 200 && status != 206) throw new IOException("媒体预览暂不可用。");
                long expected = connection.getContentLengthLong();
                if (expected > NativePolicy.MAX_MEDIA_BYTES) throw new IOException("预览文件过大。");
                String mime = connection.getContentType();
                mime = mime == null ? "" : mime.toLowerCase(Locale.ROOT).split(";", 2)[0].trim();
                PushbackInputStream input = new PushbackInputStream(connection.getInputStream(), 64);
                if (status == 200 || (range != null && range.startsWith("bytes=0-"))) {
                    byte[] prefix = new byte[64];
                    int length = 0;
                    while (length < prefix.length) {
                        int read = input.read(prefix, length, prefix.length - length);
                        if (read < 0) break;
                        length += read;
                    }
                    String detected = NativePolicy.sniffMime(prefix, length);
                    if (detected == null) throw new IOException("媒体预览内容无效。");
                    NativePolicy.validateMime(mime, detected, detected.startsWith("image/") ? "image" : "video");
                    mime = detected;
                    input.unread(prefix, 0, length);
                }
                if (!(mime.startsWith("image/") || mime.startsWith("video/"))) {
                    // Range responses can use a generic MIME; they cannot execute inside img/video elements.
                    if (status == 206 && mime.equals("application/octet-stream")) mime = "video/mp4";
                    else throw new IOException("媒体预览类型无效。");
                }
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                headers.put("Access-Control-Allow-Origin", "https://appassets.androidplatform.net");
                headers.put("X-Content-Type-Options", "nosniff");
                if (expected >= 0) headers.put("Content-Length", Long.toString(expected));
                String contentRange = connection.getHeaderField("Content-Range");
                if (contentRange != null) headers.put("Content-Range", contentRange);
                headers.put("Accept-Ranges", "bytes");
                FilterInputStream bounded = new FilterInputStream(input) {
                    private long count;
                    @Override public int read() throws IOException {
                        cancellation.check();
                        int value = super.read();
                        if (value >= 0) checkCount(1);
                        return value;
                    }
                    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                        cancellation.check();
                        int value = in.read(bytes, offset, length);
                        if (value > 0) checkCount(value);
                        return value;
                    }
                    private void checkCount(int read) throws IOException {
                        count += read;
                        if (count > NativePolicy.MAX_MEDIA_BYTES) throw new IOException("预览文件过大。");
                    }
                    @Override public void close() throws IOException {
                        try { super.close(); } finally { cancellation.detach(connection); closed.run(); }
                    }
                };
                streaming = true;
                return new Preview(bounded, mime, status, headers);
            } finally { if (!streaming) cancellation.detach(connection); }
        }
        throw new IOException("媒体预览重定向异常。");
    }

    static List<Entry> entries(JSONArray array, boolean imagesOnly) throws JSONException {
        if (array == null || array.length() < 1 || array.length() > NativePolicy.MAX_ENTRIES) {
            throw new IllegalArgumentException("每次请选择 1 至 101 个文件。");
        }
        List<Entry> entries = new ArrayList<>();
        Set<String> names = new HashSet<>();
        long textBytes = 0;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.getJSONObject(i);
            String originalName = NativePolicy.filename(item.optString("name", ""), "文件_" + (i + 1));
            String name = originalName;
            for (int suffix = 2; !names.add(name.toLowerCase(Locale.ROOT)); suffix++) {
                name = NativePolicy.numberedFilename(originalName, suffix);
            }
            if (item.has("text") && !imagesOnly) {
                if (item.has("url") || !(item.get("text") instanceof String)) {
                    throw new IllegalArgumentException("文本文件参数无效。");
                }
                String value = item.getString("text");
                textBytes += value.getBytes(StandardCharsets.UTF_8).length;
                if (textBytes > NativePolicy.MAX_TEXT_BYTES) throw new IllegalArgumentException("文案内容过长。");
                entries.add(new Entry(name, "text", value, new ArrayList<>(), false));
                continue;
            }
            String kind = imagesOnly ? "image" : item.getString("kind");
            if (!(kind.equals("image") || kind.equals("video"))) {
                throw new IllegalArgumentException("不支持的媒体类型。");
            }
            List<URI> urls = new ArrayList<>();
            urls.add(NativePolicy.mediaUri(item.getString("url")));
            JSONArray backups = item.optJSONArray("backupUrls");
            if (backups != null) {
                if (backups.length() > 8) throw new IllegalArgumentException("备用地址数量过多。");
                for (int j = 0; j < backups.length(); j++) {
                    URI uri = NativePolicy.mediaUri(backups.getString(j));
                    if (!urls.contains(uri)) urls.add(uri);
                }
            }
            entries.add(new Entry(name, kind, null, urls,
                    kind.equals("video") && item.optBoolean("requireAudio", true)));
        }
        return entries;
    }

    static JSONObject parse(String text, String engine, Cancellation cancellation) throws IOException, JSONException {
        if (text == null || text.trim().isEmpty() || text.length() > 3000) {
            throw new IllegalArgumentException("请粘贴 3000 字以内的小红书链接或分享文案。");
        }
        if (!(engine.equals("node") || engine.equals("python"))) {
            throw new IllegalArgumentException("不支持的解析引擎。");
        }
        URI uri = URI.create("https://xhs.download.brclio.com/api/" + (engine.equals("python") ? "python_parse" : "parse"));
        HttpURLConnection connection = connection(uri, cancellation);
        try {
            connection.setRequestMethod("POST");
            connection.setReadTimeout(60_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            byte[] payload = new JSONObject().put("text", text.trim()).toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(payload); }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new IOException("解析服务地址发生变化，请更新客户端。");
            InputStream source = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (source == null) throw new IOException("解析服务暂时不可用，请稍后重试。");
            byte[] body;
            try (InputStream input = source) { body = readLimited(input, 8 * 1024 * 1024, cancellation); }
            JSONObject result;
            try { result = new JSONObject(new String(body, StandardCharsets.UTF_8)); }
            catch (JSONException error) { throw new IOException("解析服务返回了无效内容，请稍后重试。"); }
            if (status < 200 || status >= 300 || !result.optBoolean("success", false)) {
                String message = result.optString("message", "解析失败，请检查链接后重试。");
                throw new IOException(message.length() <= 500 ? message : "解析失败，请检查链接后重试。");
            }
            return result;
        } finally { cancellation.detach(connection); }
    }

    static Media download(Entry entry, File directory, long completedBytes,
                          Cancellation cancellation, Progress progress) throws IOException {
        IOException lastError = null;
        for (URI uri : entry.urls) {
            cancellation.check();
            File file = File.createTempFile("media-", ".part", directory);
            boolean complete = false;
            try {
                Media media = downloadOne(uri, entry.kind, file, completedBytes, cancellation, progress);
                if (entry.kind.equals("video")) validateTracks(file, entry.requireAudio);
                else validateImage(file, media.mime);
                cancellation.check();
                complete = true;
                return media;
            } catch (IllegalArgumentException error) {
                lastError = new IOException(error.getMessage());
            } catch (IOException error) {
                lastError = error;
            } finally {
                if (!complete) file.delete();
            }
        }
        cancellation.check();
        throw lastError == null ? new IOException("没有可用的媒体地址。"): lastError;
    }

    private static Media downloadOne(URI initial, String kind, File file, long completedBytes,
                                     Cancellation cancellation, Progress progress) throws IOException {
        URI current = initial;
        long startedAt = System.nanoTime();
        for (int redirect = 0; redirect <= 5; redirect++) {
            NativePolicy.mediaUri(current.toString());
            cancellation.check();
            HttpURLConnection connection = connection(current, cancellation);
            try {
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || redirect == 5) throw new IOException("媒体重定向异常。");
                    current = NativePolicy.mediaUri(current.resolve(location).toString());
                    continue;
                }
                if (status != 200) throw new IOException("媒体下载失败（HTTP " + status + "），请重新解析后重试。");
                long expected = connection.getContentLengthLong();
                if (expected == 0 || expected > NativePolicy.MAX_MEDIA_BYTES
                        || (expected > 0 && completedBytes + expected > NativePolicy.MAX_TOTAL_BYTES)) {
                    throw new IOException("文件为空或超过大小限制（单文件 512 MB，单次 1 GB）。");
                }
                String encoding = connection.getContentEncoding();
                if (encoding != null && !encoding.equalsIgnoreCase("identity")) {
                    throw new IOException("媒体响应编码不受支持。");
                }
                long free = file.getParentFile().getUsableSpace();
                if (expected > 0 && free > 0 && expected + 8L * 1024 * 1024 > free) {
                    throw new IOException("手机可用空间不足，请清理后重试。");
                }
                try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(file)) {
                    byte[] prefix = new byte[64];
                    int prefixLength = 0;
                    while (prefixLength < prefix.length) {
                        cancellation.check();
                        int count = input.read(prefix, prefixLength, prefix.length - prefixLength);
                        if (count < 0) break;
                        prefixLength += count;
                    }
                    String mime = NativePolicy.sniffMime(prefix, prefixLength);
                    NativePolicy.validateMime(connection.getContentType(), mime, kind);
                    if (completedBytes + prefixLength > NativePolicy.MAX_TOTAL_BYTES) {
                        throw new IOException("本次文件总大小超过 1 GB。");
                    }
                    output.write(prefix, 0, prefixLength);
                    long count = prefixLength;
                    byte[] buffer = new byte[BUFFER_SIZE];
                    int length;
                    while ((length = input.read(buffer)) != -1) {
                        cancellation.check();
                        count += length;
                        if (count > NativePolicy.MAX_MEDIA_BYTES || completedBytes + count > NativePolicy.MAX_TOTAL_BYTES) {
                            throw new IOException("超过文件大小限制（单文件 512 MB，单次 1 GB）。");
                        }
                        if ((System.nanoTime() - startedAt) / 1_000_000 > DOWNLOAD_TIMEOUT_MS) {
                            throw new IOException("媒体下载超时，请检查网络后重试。");
                        }
                        output.write(buffer, 0, length);
                        progress.update(count);
                    }
                    if (count < 1 || (expected >= 0 && count != expected)) {
                        throw new IOException("媒体下载不完整，请重试。");
                    }
                    cancellation.check();
                    progress.update(count);
                    return new Media(file, mime);
                }
            } finally { cancellation.detach(connection); }
        }
        throw new IOException("媒体重定向次数过多。");
    }

    static void copy(File source, OutputStream output, Cancellation cancellation) throws IOException {
        try (InputStream input = new FileInputStream(source)) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int length;
            while ((length = input.read(buffer)) != -1) {
                cancellation.check();
                output.write(buffer, 0, length);
            }
        }
    }

    private static void validateTracks(File file, boolean requireAudio) throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(file.getAbsolutePath());
            boolean video = false;
            boolean audio = false;
            for (int track = 0; track < extractor.getTrackCount(); track++) {
                MediaFormat format = extractor.getTrackFormat(track);
                String mime = format.getString(MediaFormat.KEY_MIME);
                if (mime == null || !(mime.startsWith("video/") || mime.startsWith("audio/"))) continue;
                extractor.selectTrack(track);
                extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
                boolean hasSamples = extractor.getSampleTime() >= 0;
                extractor.unselectTrack(track);
                if (mime.startsWith("video/") && hasSamples) video = true;
                if (mime.startsWith("audio/") && hasSamples) audio = true;
            }
            if (!video) throw new IOException("文件中未找到视频画面，请切换清晰度后重试。");
            if (requireAudio && !audio) throw new IOException("该地址只有视频画面、没有音轨，请切换清晰度后重试。");
        } catch (RuntimeException error) {
            throw new IOException("视频文件无法验证，请切换清晰度后重试。");
        } finally { extractor.release(); }
    }

    private static void validateImage(File file, String mime) throws IOException {
        // These codecs are present on every supported Android version. AVIF/HEIF may require
        // newer system decoders, so their original bytes remain downloadable on older devices.
        if (!(mime.equals("image/jpeg") || mime.equals("image/png")
                || mime.equals("image/webp") || mime.equals("image/gif"))) return;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("图片文件损坏或下载不完整，请重试。");
        options.inJustDecodeBounds = false;
        options.inSampleSize = 1;
        while (options.outWidth / options.inSampleSize > 1024 || options.outHeight / options.inSampleSize > 1024) {
            options.inSampleSize *= 2;
        }
        Bitmap decoded = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        if (decoded == null) throw new IOException("图片文件无法完整读取，请重新解析后重试。");
        decoded.recycle();
    }

    private static HttpURLConnection connection(URI uri, Cancellation cancellation) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", USER_AGENT);
        connection.setRequestProperty("Referer", "https://www.xiaohongshu.com/");
        connection.setRequestProperty("Accept-Encoding", "identity");
        cancellation.attach(connection);
        return connection;
    }

    private static byte[] readLimited(InputStream input, int maximum, Cancellation cancellation) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int length;
        while ((length = input.read(buffer)) != -1) {
            cancellation.check();
            if (output.size() + length > maximum) throw new IOException("解析结果过大，请更换链接。");
            output.write(buffer, 0, length);
        }
        return output.toByteArray();
    }
}
