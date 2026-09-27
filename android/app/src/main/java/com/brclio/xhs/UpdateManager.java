package com.brclio.xhs;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Checks one fixed Android release channel; JavaScript never supplies an APK URL or file path. */
final class UpdateManager {
    static final int PERMISSION_REQUEST = 2101;
    static final int INSTALL_REQUEST = 2102;
    private static final int MAX_METADATA_BYTES = 8 * 1024 * 1024;
    private static final long DEADLINE_MS = 15 * 60 * 1000L;

    interface Callback {
        void success(JSONObject result);
        void failure(String error);
    }
    interface Events { void emit(JSONObject event); }
    interface InstallGate { boolean isReady(); }

    private static final class Release {
        final String version;
        final String tag;
        final String notes;
        final String filename;
        final URI apkUrl;
        final URI checksumUrl;
        final long size;
        final long checksumSize;
        final long assetId;
        final long checksumId;
        Release(JSONObject json) throws JSONException {
            tag = json.getString("tag_name");
            version = UpdatePolicy.versionFromTag(tag);
            if (version == null) throw new IllegalArgumentException("不是安卓正式发布版本。");
            String body = json.optString("body", "");
            notes = body.length() > 16000 ? body.substring(0, 16000) : body;
            filename = UpdatePolicy.filename(version);
            JSONObject apk = null;
            JSONObject checksum = null;
            JSONArray assets = json.getJSONArray("assets");
            for (int index = 0; index < assets.length(); index++) {
                JSONObject asset = assets.getJSONObject(index);
                if (asset.optString("name").equals(filename)) {
                    if (apk != null) throw new IllegalArgumentException("发布中存在重复的安装包。");
                    apk = asset;
                }
                if (asset.optString("name").equals(filename + ".sha256")) {
                    if (checksum != null) throw new IllegalArgumentException("发布中存在重复的校验文件。");
                    checksum = asset;
                }
            }
            if (apk == null || checksum == null || !apk.optString("state").equals("uploaded")
                    || !checksum.optString("state").equals("uploaded")) {
                throw new IllegalArgumentException("安卓新版发布尚未完整，请稍后重新检查。");
            }
            size = apk.getLong("size");
            checksumSize = checksum.getLong("size");
            assetId = apk.getLong("id");
            checksumId = checksum.getLong("id");
            if (size < 1 || size > UpdatePolicy.MAX_APK_BYTES || checksumSize < 1 || checksumSize > 4096
                    || assetId < 1 || checksumId < 1) {
                throw new IllegalArgumentException("安卓发布文件大小或标识无效。");
            }
            apkUrl = UpdatePolicy.assetUri(tag, filename, apk.getString("browser_download_url"));
            checksumUrl = UpdatePolicy.assetUri(tag, filename + ".sha256", checksum.getString("browser_download_url"));
        }
        boolean sameAsset(Release other) {
            return other != null && tag.equals(other.tag) && size == other.size && assetId == other.assetId
                    && checksumId == other.checksumId && checksumSize == other.checksumSize;
        }
        JSONObject json(Long code) {
            JSONObject result = object("versionName", version, "tag", tag, "notes", notes,
                    "filename", filename, "size", size, "url", apkUrl.toString());
            if (code != null) put(result, "versionCode", code);
            return result;
        }
    }

    private static final class Download {
        final Release release;
        final File file;
        final String sha256;
        final long versionCode;
        Download(Release release, File file, String sha256, long versionCode) {
            this.release = release;
            this.file = file;
            this.sha256 = sha256;
            this.versionCode = versionCode;
        }
    }

    private static final class Job {
        final NativeTransfer.Cancellation cancellation = new NativeTransfer.Cancellation();
        final long startedAt = System.nanoTime();
        Download output;
        void check() throws IOException {
            cancellation.check();
            if ((System.nanoTime() - startedAt) / 1_000_000 > DEADLINE_MS) throw new IOException("更新操作超时，请检查网络后重试。");
        }
    }

    private final Activity activity;
    private final Events events;
    private final InstallGate installGate;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final File directory;
    private final Object lock = new Object();
    private final boolean canInstallBuild;
    private String status = "idle";
    private String error;
    private Release available;
    private Download downloaded;
    private Job active;
    private long bytes;
    private long total;
    private long lastProgress;
    private volatile boolean closed;
    private boolean awaitingPermission;
    private boolean installerOpen;

    UpdateManager(Activity activity, Events events, InstallGate installGate) {
        this.activity = activity;
        this.events = events;
        this.installGate = installGate;
        this.directory = new File(activity.getCacheDir(), "updates");
        this.canInstallBuild = !BuildConfig.DEBUG && activity.getPackageName().equals(UpdatePolicy.APPLICATION_ID);
        File[] oldFiles = directory.listFiles();
        worker.execute(() -> {
            if (oldFiles == null) return;
            long expiration = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000;
            for (File file : oldFiles) {
                if (file.isFile() && (file.getName().endsWith(".part") || file.lastModified() < expiration)) file.delete();
            }
        });
    }

    JSONObject state() {
        synchronized (lock) {
            boolean allowed = false;
            try { allowed = canInstallBuild && activity.getPackageManager().canRequestPackageInstalls(); }
            catch (RuntimeException ignored) { }
            JSONObject state = object("currentVersion", BuildConfig.VERSION_NAME,
                    "currentVersionCode", BuildConfig.VERSION_CODE, "status", status,
                    "canInstallBuild", canInstallBuild, "debug", BuildConfig.DEBUG,
                    "installAllowed", allowed, "bytes", bytes, "total", total,
                    "update", available == null ? JSONObject.NULL : available.json(downloaded != null
                            && available.sameAsset(downloaded.release) ? downloaded.versionCode : null));
            if (available != null) put(state, "versionName", available.version);
            if (downloaded != null) {
                put(state, "filename", downloaded.release.filename);
                put(state, "versionCode", downloaded.versionCode);
            }
            if (error != null) put(state, "error", error);
            if (status.equals("cancelled")) put(state, "cancelled", true);
            return state;
        }
    }

    void check(Callback callback) {
        Job job = begin("checking", callback);
        if (job == null) return;
        worker.execute(() -> {
            try {
                byte[] response = fetchBytes(URI.create(UpdatePolicy.RELEASES_API), MAX_METADATA_BYTES, -1, false, job);
                JSONArray releases;
                try { releases = new JSONArray(new String(response, StandardCharsets.UTF_8)); }
                catch (JSONException invalid) { throw new IOException("版本服务返回无效内容，请稍后重试。"); }
                JSONObject latest = null;
                String latestVersion = null;
                for (int index = 0; index < releases.length(); index++) {
                    JSONObject release = releases.optJSONObject(index);
                    if (release == null || release.optBoolean("draft", true) || release.optBoolean("prerelease", true)) continue;
                    String version = UpdatePolicy.versionFromTag(release.optString("tag_name"));
                    if (version != null && (latestVersion == null || UpdatePolicy.compareVersions(version, latestVersion) > 0)) {
                        latest = release;
                        latestVersion = version;
                    }
                }
                job.check();
                String current = BuildConfig.VERSION_NAME.replaceFirst("-debug$", "");
                Release update = latest != null && UpdatePolicy.compareVersions(latestVersion, current) > 0 ? new Release(latest) : null;
                Download stale = null;
                synchronized (lock) {
                    if (downloaded != null && (update == null || !update.sameAsset(downloaded.release)
                            || !downloaded.file.isFile() || downloaded.file.length() != downloaded.release.size)) {
                        stale = downloaded;
                        downloaded = null;
                    }
                    available = update;
                    status = latest == null ? "unpublished" : update == null ? "latest" : downloaded == null ? "available" : "downloaded";
                    bytes = downloaded == null ? 0 : downloaded.file.length();
                    total = available == null ? 0 : available.size;
                }
                if (stale != null) stale.file.delete();
                finish(job, callback, null);
            } catch (Exception failure) { finish(job, callback, failure); }
        });
    }

    void download(Callback callback) {
        if (!canInstallBuild) { callback.failure("测试版本不能在线覆盖安装，请先安装正式版 APK。"); return; }
        final Release release;
        synchronized (lock) { release = available; }
        if (release == null) { callback.failure("请先检查并确认有可用的安卓新版。"); return; }
        Job job = begin("downloading", callback);
        if (job == null) return;
        worker.execute(() -> {
            File part = null;
            File completed = null;
            boolean accepted = false;
            try {
                job.check();
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建更新缓存，请检查存储空间。");
                if (directory.getUsableSpace() < release.size + 16L * 1024 * 1024) throw new IOException("存储空间不足，无法下载更新。");
                byte[] checkBytes = fetchBytes(release.checksumUrl, 4096, release.checksumSize, true, job);
                String expected = UpdatePolicy.checksum(new String(checkBytes, StandardCharsets.UTF_8), release.filename);
                part = File.createTempFile("update-", ".part", directory);
                MessageDigest digest = sha256();
                try (Response response = open(release.apkUrl, true, job);
                     FileOutputStream output = new FileOutputStream(part)) {
                    if (response.length >= 0 && response.length != release.size) throw new IOException("安装包大小与发布记录不一致。");
                    byte[] buffer = new byte[64 * 1024];
                    long received = 0;
                    int length;
                    while ((length = response.input.read(buffer)) != -1) {
                        job.check();
                        received += length;
                        if (received > release.size || received > UpdatePolicy.MAX_APK_BYTES) throw new IOException("安装包超出发布的大小限制。");
                        output.write(buffer, 0, length);
                        digest.update(buffer, 0, length);
                        progress(received, release.size);
                    }
                    if (received != release.size) throw new IOException("安装包下载不完整，请重新下载。");
                    output.getFD().sync();
                }
                job.check();
                if (!constantEquals(expected, hex(digest.digest()))) throw new IOException("安装包 SHA-256 校验失败，文件已丢弃，请重新下载。");
                synchronized (lock) { status = "verifying"; bytes = release.size; total = release.size; }
                emit();
                long code = verifyArchive(part, release);
                job.check();
                completed = new File(directory, "update-" + UUID.randomUUID() + ".apk");
                if (!part.renameTo(completed)) throw new IOException("无法保存已校验的安装包，请检查存储空间。");
                Download previous;
                synchronized (lock) {
                    job.check();
                    previous = downloaded;
                    downloaded = new Download(release, completed, expected, code);
                    job.output = downloaded;
                    status = "downloaded";
                    accepted = true;
                }
                if (previous != null) previous.file.delete();
                finish(job, callback, null);
            } catch (Exception failure) { finish(job, callback, failure); }
            finally {
                if (part != null) part.delete();
                if (!accepted && completed != null) completed.delete();
            }
        });
    }

    void install(Callback callback) {
        if (!canInstallBuild) { callback.failure("测试版本不能在线覆盖安装，请先安装正式版 APK。"); return; }
        final Download update;
        synchronized (lock) {
            if (active != null || installerOpen) { callback.failure("请先完成当前更新任务或关闭系统安装器。"); return; }
            update = downloaded;
        }
        if (update == null || !update.file.isFile()) {
            synchronized (lock) {
                if (downloaded == update) downloaded = null;
                status = available == null ? "idle" : "available";
            }
            emit();
            callback.failure("请先下载更新安装包；已被系统清理的缓存需要重新下载。");
            return;
        }
        Job job = begin("verifying", callback);
        if (job == null) return;
        worker.execute(() -> {
            try {
                if (update.file.length() != update.release.size || !constantEquals(update.sha256, hashFile(update.file, job))) {
                    throw new IOException("缓存安装包校验失败，请重新下载。");
                }
                verifyArchive(update.file, update.release);
                job.check();
                activity.runOnUiThread(() -> openInstaller(job, update, callback));
            } catch (Exception failure) {
                if (!job.cancellation.isCancelled()) {
                    synchronized (lock) { if (downloaded == update) downloaded = null; }
                    update.file.delete();
                }
                finish(job, callback, failure);
            }
        });
    }

    private void openInstaller(Job job, Download update, Callback callback) {
        try {
            job.check();
            if (closed || activity.isFinishing() || activity.isDestroyed()) throw new IOException("应用已关闭，安装操作已取消。");
            if (!installGate.isReady()) throw new IOException("请先完成当前解析或保存任务，再安装更新。");
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivityForResult(settings, PERMISSION_REQUEST);
                awaitingPermission = true;
                synchronized (lock) { status = "permission_required"; }
            } else {
                Uri content = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", update.file);
                Intent installer = new Intent(Intent.ACTION_INSTALL_PACKAGE).setData(content)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).putExtra(Intent.EXTRA_RETURN_RESULT, true);
                installer.setClipData(ClipData.newRawUri("Brclio 安卓更新", content));
                activity.startActivityForResult(installer, INSTALL_REQUEST);
                installerOpen = true;
                synchronized (lock) { status = "installer_opened"; }
            }
            finish(job, callback, null);
        } catch (Exception failure) { finish(job, callback, failure); }
    }

    JSONObject cancel() {
        Job job;
        synchronized (lock) { job = active; }
        if (job != null) job.cancellation.cancel();
        return object("cancelled", job != null);
    }

    void onResume() {
        if (!awaitingPermission) return;
        awaitingPermission = false;
        synchronized (lock) { if (downloaded != null) status = "downloaded"; }
        emit(); // Permission never starts installation by itself; the user presses Install again.
    }

    boolean onActivityResult(int requestCode, int resultCode) {
        if (requestCode == PERMISSION_REQUEST) { onResume(); return true; }
        if (requestCode != INSTALL_REQUEST) return false;
        installerOpen = false;
        synchronized (lock) { if (downloaded != null) status = "downloaded"; }
        JSONObject event = state();
        put(event, "type", "update");
        put(event, "installerClosed", true);
        put(event, "installerCancelled", resultCode != Activity.RESULT_OK);
        events.emit(event);
        return true;
    }

    void close() {
        closed = true;
        cancel();
        worker.shutdown();
    }

    private Job begin(String nextStatus, Callback callback) {
        synchronized (lock) {
            if (closed) { callback.failure("应用已关闭。"); return null; }
            if (installerOpen) { callback.failure("请先完成或关闭系统安装器。"); return null; }
            if (active != null) { callback.failure("已有版本检查或更新任务正在进行，请稍候。"); return null; }
            active = new Job();
            status = nextStatus;
            error = null;
            if (nextStatus.equals("downloading")) { bytes = 0; total = available == null ? 0 : available.size; }
            emit();
            return active;
        }
    }

    private void finish(Job job, Callback callback, Exception failure) {
        Download cancelledOutput = null;
        synchronized (lock) {
            if (active != job) return;
            active = null;
            if (job.cancellation.isCancelled()) {
                status = "cancelled";
                error = null;
                if (job.output != null && downloaded == job.output) {
                    cancelledOutput = downloaded;
                    downloaded = null;
                    bytes = 0;
                }
            }
            else if (failure != null) { status = "error"; error = friendlyError(failure); }
        }
        if (cancelledOutput != null) cancelledOutput.file.delete();
        if (closed) return;
        JSONObject result = state();
        emit();
        activity.runOnUiThread(() -> {
            if (closed) return;
            if (failure != null && !job.cancellation.isCancelled()) callback.failure(friendlyError(failure));
            else callback.success(result);
        });
    }

    private void progress(long received, long expected) {
        synchronized (lock) {
            bytes = received;
            total = expected;
            long now = android.os.SystemClock.elapsedRealtime();
            if (received != expected && now - lastProgress < 150) return;
            lastProgress = now;
        }
        emit();
    }

    private void emit() {
        if (closed) return;
        JSONObject event = state();
        put(event, "type", "update");
        events.emit(event);
    }

    private long verifyArchive(File apk, Release release) throws IOException, PackageManager.NameNotFoundException {
        PackageManager manager = activity.getPackageManager();
        PackageInfo archive;
        PackageInfo installed;
        if (Build.VERSION.SDK_INT >= 28) {
            archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
            installed = manager.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        } else {
            archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
            installed = manager.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNATURES);
        }
        if (archive == null || !UpdatePolicy.APPLICATION_ID.equals(archive.packageName)
                || !installed.packageName.equals(archive.packageName)) throw new IOException("安装包不是当前 Brclio 安卓应用，已阻止安装。");
        long code = versionCode(archive);
        UpdatePolicy.validateVersion(release.version, archive.versionName, code, versionCode(installed));
        if (archive.applicationInfo != null && archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT) {
            throw new IOException("此更新需要更高版本的 Android，当前设备无法安装。");
        }
        if (archive.applicationInfo == null || (archive.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            throw new IOException("安装包不是正式发布构建，已阻止安装。");
        }
        if (!UpdatePolicy.sameSigners(signerDigests(installed), signerDigests(archive))) {
            throw new IOException("安装包签名与当前应用不同，已阻止安装。");
        }
        return code;
    }

    private static Set<String> signerDigests(PackageInfo info) throws IOException {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= 28) {
            if (info.signingInfo == null) throw new IOException("无法读取应用签名，已阻止安装。");
            // Require the exact present signer set. A future key rotation needs an explicit update-policy migration.
            signatures = info.signingInfo.getApkContentsSigners();
        } else signatures = info.signatures;
        if (signatures == null || signatures.length == 0) throw new IOException("安装包没有有效签名，已阻止安装。");
        Set<String> digests = new HashSet<>();
        for (Signature signature : signatures) digests.add(hex(sha256().digest(signature.toByteArray())));
        return digests;
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private static final class Response implements AutoCloseable {
        final HttpURLConnection connection;
        final InputStream input;
        final long length;
        final Job job;
        Response(HttpURLConnection connection, InputStream input, long length, Job job) {
            this.connection = connection; this.input = input; this.length = length; this.job = job;
        }
        @Override public void close() throws IOException {
            try { input.close(); } finally { job.cancellation.detach(connection); }
        }
    }

    private static Response open(URI initial, boolean asset, Job job) throws IOException {
        URI current = initial;
        for (int redirect = 0; redirect <= 5; redirect++) {
            job.check();
            if (asset) UpdatePolicy.redirectUri(current.toString());
            else if (!current.toString().equals(UpdatePolicy.RELEASES_API)) throw new IOException("版本服务地址无效。");
            HttpURLConnection connection = (HttpURLConnection) current.toURL().openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setUseCaches(false);
            connection.setRequestProperty("User-Agent", "Brclio-Android/" + BuildConfig.VERSION_NAME);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Accept", asset ? "application/octet-stream" : "application/vnd.github+json");
            if (!asset) connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            job.cancellation.attach(connection);
            boolean streaming = false;
            try {
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (!asset || location == null || redirect == 5) throw new IOException("更新服务重定向异常，请稍后重试。");
                    current = UpdatePolicy.redirectUri(current.resolve(location).toString());
                    continue;
                }
                if (status == 403 || status == 429) throw new IOException("版本服务请求受限，请稍后重新检查。");
                if (status == 404) throw new IOException("更新文件尚未发布或已被移除，请重新检查版本。");
                if (status != 200) throw new IOException("更新服务暂不可用（HTTP " + status + "），请稍后重试。");
                String encoding = connection.getContentEncoding();
                if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw new IOException("更新响应编码无效。");
                InputStream input = connection.getInputStream();
                streaming = true;
                return new Response(connection, input, connection.getContentLengthLong(), job);
            } finally { if (!streaming) job.cancellation.detach(connection); }
        }
        throw new IOException("更新下载重定向次数过多。");
    }

    private static byte[] fetchBytes(URI uri, int maximum, long expected, boolean asset, Job job) throws IOException {
        try (Response response = open(uri, asset, job)) {
            if (response.length > maximum || (expected >= 0 && response.length >= 0 && response.length != expected)) {
                throw new IOException("版本信息文件大小异常。");
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            int length;
            while ((length = response.input.read(buffer)) != -1) {
                job.check();
                if (output.size() + length > maximum) throw new IOException("版本信息超过大小限制。");
                output.write(buffer, 0, length);
            }
            if ((expected >= 0 && output.size() != expected)
                    || (response.length >= 0 && output.size() != response.length)) throw new IOException("版本信息读取不完整，请重试。");
            return output.toByteArray();
        }
    }

    private static String hashFile(File file, Job job) throws IOException {
        MessageDigest digest = sha256();
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int length;
            while ((length = input.read(buffer)) != -1) {
                job.check();
                digest.update(buffer, 0, length);
            }
        }
        return hex(digest.digest());
    }

    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static boolean constantEquals(String first, String second) {
        return MessageDigest.isEqual(first.getBytes(StandardCharsets.US_ASCII), second.getBytes(StandardCharsets.US_ASCII));
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    private static JSONObject object(Object... pairs) {
        JSONObject result = new JSONObject();
        for (int index = 0; index < pairs.length; index += 2) put(result, (String) pairs[index], pairs[index + 1]);
        return result;
    }

    private static void put(JSONObject json, String key, Object value) {
        try { json.put(key, value); }
        catch (JSONException invalid) { throw new IllegalArgumentException("更新状态无效。"); }
    }

    private static String friendlyError(Exception failure) {
        if (failure instanceof java.net.SocketTimeoutException) return "更新连接超时，请检查网络后重试。";
        if (failure instanceof java.net.UnknownHostException) return "无法连接 GitHub 版本服务，请检查网络后重试。";
        if (failure instanceof javax.net.ssl.SSLException) return "更新安全连接失败，请检查设备时间和网络。";
        String message = failure.getMessage();
        if ((failure instanceof IOException || failure instanceof IllegalArgumentException) && message != null
                && message.matches("(?s).*[\\u4e00-\\u9fff].*") && !message.contains("://")) return message;
        return "更新操作未完成，请检查网络和存储空间后重试。";
    }
}
