package com.brclio.xhs;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Local application UI with a narrow, origin-bound bridge to Android capabilities. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/assets/www/index.html";
    private static final int CREATE_DOCUMENT = 1001;
    private static final String PENDING_DOCUMENT = "pending_document";
    private static final String CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            + "img-src 'self' data: https://*.xhscdn.com https://xhscdn.com https://ci.xiaohongshu.com; "
            + "media-src https://*.xhscdn.com https://xhscdn.com https://ci.xiaohongshu.com; "
            + "font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private final Set<String> activeRequests = new HashSet<>();
    private final Set<NativeTransfer.Cancellation> previews = Collections.synchronizedSet(new HashSet<>());
    private WebView webView;
    private SharedPreferences preferences;
    private volatile boolean destroyed;
    private volatile boolean cleanupComplete;
    private boolean webReady;
    private String sharedText = "";
    private NativeTransfer.Cancellation parsing;
    private Operation transfer;
    private UpdateManager updater;
    private long lastProgressAt;

    private final class Request {
        final Object id;
        final String key;
        final JavaScriptReplyProxy reply;
        boolean answered;
        Request(Object id, JavaScriptReplyProxy reply) { this.id = id; this.key = id.toString(); this.reply = reply; }
        void success(JSONObject result) { answer(true, result, null); }
        void failure(String message) { answer(false, null, message); }
        void answer(boolean ok, JSONObject result, String error) {
            runOnUiThread(() -> {
                if (answered) return;
                answered = true;
                activeRequests.remove(key);
                if (destroyed) return;
                JSONObject response = object("id", id, "ok", ok);
                try {
                    if (ok) response.put("result", result == null ? new JSONObject() : result);
                    else response.put("error", error == null ? "操作失败，请重试。" : error);
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                        reply.postMessage(response.toString());
                    }
                } catch (JSONException | RuntimeException ignored) {
                    // A reply can disappear when WebView's renderer is replaced or the Activity finishes.
                }
            });
        }
    }

    private static final class Operation {
        final Request request;
        final List<NativeTransfer.Entry> entries;
        final String filename;
        final String mime;
        final NativeTransfer.Cancellation cancellation = new NativeTransfer.Cancellation();
        volatile Uri document;
        boolean awaitingPicker;
        Operation(Request request, List<NativeTransfer.Entry> entries, String filename, String mime) {
            this.request = request;
            this.entries = entries;
            this.filename = filename;
            this.mime = mime;
        }
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("native_transfers", MODE_PRIVATE);
        updater = new UpdateManager(this, this::event, () -> parsing == null && transfer == null);
        sharedText = state == null ? "" : state.getString("shared_text", "");
        receiveShare(getIntent());
        String interruptedDocument = preferences.getString(PENDING_DOCUMENT, null);
        File[] oldCacheFiles = getCacheDir().listFiles();
        workers.execute(() -> {
            try {
                cleanupInterruptedDocument(interruptedDocument, oldCacheFiles);
                cleanupOldImages();
            } finally { cleanupComplete = true; }
        });
        initializeWebView();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void initializeWebView() {
        webView = new WebView(this);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            webView.destroy();
            webView = null;
            TextView message = new TextView(this);
            message.setText("请先更新 Android System WebView 或 Chrome，然后重新打开 Brclio 小红书下载器。");
            message.setTextSize(18);
            message.setPadding(32, 80, 32, 32);
            setContentView(message);
            return;
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isLocalDocument(uri)) return false;
                if (request.isForMainFrame() && request.hasGesture()
                        && LearningPagePolicy.isPromotionDocument(uri.toString())) {
                    startActivity(new Intent(MainActivity.this, LearningActivity.class)
                            .putExtra(LearningActivity.EXTRA_PAGE,
                                    LearningPagePolicy.isVipDocument(uri.toString()) ? "vip" : "learn"));
                    return true;
                }
                if (request.isForMainFrame() && request.hasGesture()) openExternal(uri);
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isLocalOrigin(uri) && uri.getPath() != null && uri.getPath().startsWith("/assets/www/")) {
                    WebResourceResponse response = assets.shouldInterceptRequest(uri);
                    if (response == null) return blocked();
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Content-Security-Policy", CSP);
                    headers.put("X-Content-Type-Options", "nosniff");
                    headers.put("Cache-Control", "no-store");
                    response.setResponseHeaders(headers);
                    return response;
                }
                if (request.isForMainFrame() || !request.getMethod().equals("GET")) return blocked();
                NativeTransfer.Cancellation cancellation = new NativeTransfer.Cancellation();
                previews.add(cancellation);
                try {
                    NativeTransfer.Preview preview = NativeTransfer.preview(NativePolicy.mediaUri(uri.toString()),
                            request.getRequestHeaders().get("Range"), cancellation, () -> previews.remove(cancellation));
                    return new WebResourceResponse(preview.mime, null, preview.status,
                            preview.status == 206 ? "Partial Content" : "OK", preview.headers, preview.stream);
                } catch (IOException | IllegalArgumentException error) {
                    previews.remove(cancellation);
                    return blocked();
                }
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                webReady = false;
                if (!isLocalDocument(Uri.parse(url))) view.stopLoading();
            }

            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (parsing != null) parsing.cancel();
                if (transfer != null) transfer.cancellation.cancel();
                Toast.makeText(MainActivity.this, "页面已停止，请重新打开应用；未完成的下载已取消。", Toast.LENGTH_LONG).show();
                finish();
                return true;
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "BrclioNative", Collections.singleton(ORIGIN),
                    (view, message, origin, mainFrame, reply) -> {
                        if (!mainFrame || !isLocalOrigin(origin) || destroyed) return;
                        String data;
                        try { data = message.getData(); } catch (RuntimeException error) { return; }
                        handleMessage(data, reply);
                    });
        }
        // Chromium ignores WebView padding. Inset its native parent so the HTML viewport itself
        // excludes system bars and the keyboard on edge-to-edge Android 15 and older devices.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(0xfff8f7f4);
        container.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        ViewCompat.setOnApplyWindowInsetsListener(container, (view, insets) -> {
            Insets padding = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(container);
        ViewCompat.requestApplyInsets(container);
        webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        webView.loadUrl(START_URL);
    }

    private void handleMessage(String message, JavaScriptReplyProxy reply) {
        if (message == null || message.length() > 2 * 1024 * 1024) return;
        Request request = null;
        try {
            JSONObject body = new JSONObject(message);
            Object id = body.get("id");
            if (!(id instanceof String || id instanceof Number) || id.toString().length() > 128) return;
            if (activeRequests.contains(id.toString())) return;
            request = new Request(id, reply);
            if (activeRequests.size() >= 32) { request.failure("操作过于频繁，请稍后重试。"); return; }
            activeRequests.add(request.key);
            JSONObject params = body.optJSONObject("params");
            if (params == null) params = new JSONObject();
            switch (body.getString("method")) {
                case "ready":
                    webReady = true;
                    request.success(object("version", BuildConfig.VERSION_NAME, "sharedText", sharedText));
                    sharedText = "";
                    break;
                case "paste":
                    ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                    ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
                    CharSequence text = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getText();
                    request.success(object("text", text == null ? "" : text.toString()));
                    break;
                case "copy":
                    String content = params.getString("text");
                    if (content.length() > NativePolicy.MAX_TEXT_BYTES) throw new IllegalArgumentException("复制内容过长。");
                    getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("小红书文案", content));
                    request.success(new JSONObject());
                    break;
                case "parse": startParse(request, params); break;
                case "save": startSave(request, params); break;
                case "copyImages": startImages(request, params, false); break;
                case "shareImages": startImages(request, params, true); break;
                case "checkUpdate": updater.check(updateCallback(request)); break;
                case "downloadUpdate": updater.download(updateCallback(request)); break;
                case "openManualUpdate": updater.openManualDownload(updateCallback(request)); break;
                case "installUpdate":
                    if (parsing != null || transfer != null) request.failure("请先完成当前解析或保存任务，再安装更新。");
                    else updater.install(updateCallback(request));
                    break;
                case "cancelUpdate": request.success(updater.cancel()); break;
                case "updateState": request.success(updater.state()); break;
                case "cancel":
                    boolean cancelled = transfer != null;
                    if (transfer != null) transfer.cancellation.cancel();
                    request.success(object("cancelled", cancelled));
                    break;
                default: request.failure("客户端不支持此操作，请更新后重试。");
            }
        } catch (JSONException | IllegalArgumentException error) {
            if (request != null) request.failure(error instanceof JSONException ? "操作参数无效。" : error.getMessage());
        } catch (RuntimeException error) {
            if (request != null) request.failure("系统无法完成此操作，请稍后重试。");
        }
    }

    private UpdateManager.Callback updateCallback(Request request) {
        return new UpdateManager.Callback() {
            @Override public void success(JSONObject result) { request.success(result); }
            @Override public void failure(String error) { request.failure(error); }
        };
    }

    private void startParse(Request request, JSONObject params) throws JSONException {
        if (parsing != null) { request.failure("已有笔记正在解析，请稍候。"); return; }
        String text = params.getString("text");
        String engine = params.optString("engine", "node");
        NativeTransfer.Cancellation cancellation = new NativeTransfer.Cancellation();
        parsing = cancellation;
        workers.execute(() -> {
            JSONObject result = null;
            String message = null;
            try { result = NativeTransfer.parse(text, engine, cancellation); }
            catch (Exception error) { message = friendlyError(error); }
            JSONObject parsed = result;
            String failure = message;
            runOnUiThread(() -> {
                if (parsing == cancellation) parsing = null;
                if (failure == null) request.success(parsed);
                else request.failure(failure);
            });
        });
    }

    private void startSave(Request request, JSONObject params) throws JSONException {
        if (!cleanupComplete) { request.failure("正在恢复上次保存状态，请稍后重试。"); return; }
        if (transfer != null) { request.failure("已有保存或复制任务，请等待完成或取消。"); return; }
        List<NativeTransfer.Entry> entries = NativeTransfer.entries(params.getJSONArray("entries"), false);
        String mime = params.getString("mime");
        boolean zip = mime.equals("application/zip");
        if (!zip && (entries.size() != 1 || !allowedMime(mime, entries.get(0).kind))) {
            throw new IllegalArgumentException("保存格式与文件类型不匹配。");
        }
        String filename = NativePolicy.filename(params.getString("filename"), zip ? "小红书笔记.zip" : entries.get(0).name);
        Operation operation = new Operation(request, entries, filename, mime);
        operation.awaitingPicker = true;
        transfer = operation;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, filename)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try { startActivityForResult(intent, CREATE_DOCUMENT); }
        catch (RuntimeException error) {
            transfer = null;
            request.failure("系统文件选择器不可用，请启用“文件”应用后重试。");
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (updater != null && updater.onActivityResult(requestCode, resultCode)) return;
        if (requestCode != CREATE_DOCUMENT) return;
        Operation operation = transfer;
        if (operation == null || !operation.awaitingPicker) return;
        operation.awaitingPicker = false;
        Uri uri = data == null ? null : data.getData();
        if (resultCode != RESULT_OK || uri == null) {
            finishOperation(operation, object("cancelled", true), null);
            return;
        }
        if (!"content".equals(uri.getScheme()) || uri.getAuthority() == null) {
            finishOperation(operation, null, "文件选择器返回了无效位置。");
            return;
        }
        operation.document = uri;
        try {
            boolean read = (data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
            boolean write = (data.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
            if (read && write) getContentResolver().takePersistableUriPermission(uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            else if (write) getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            else if (read) getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) { /* Some providers only grant access for this process. */ }
        workers.execute(() -> saveDocument(operation));
    }

    private void saveDocument(Operation operation) {
        File directory = new File(getCacheDir(), "transfer-" + UUID.randomUUID());
        long totalBytes = 0;
        boolean complete = false;
        String errorMessage = null;
        try {
            if (!preferences.edit().putString(PENDING_DOCUMENT, operation.document.toString()).commit()) {
                throw new IOException("无法记录保存状态，请检查手机存储空间后重试。");
            }
            operation.cancellation.check();
            if (!directory.mkdirs()) throw new IOException("无法创建临时目录，请检查手机存储空间。");
            try (OutputStream destination = getContentResolver().openOutputStream(operation.document, "wt")) {
                if (destination == null) throw new IOException("无法打开保存位置。");
                if (operation.mime.equals("application/zip")) {
                    try (ZipOutputStream zip = new ZipOutputStream(destination)) {
                        Set<String> zipNames = new HashSet<>();
                        for (int i = 0; i < operation.entries.size(); i++) {
                            NativeTransfer.Entry entry = operation.entries.get(i);
                            final long alreadySaved = totalBytes;
                            final int index = i + 1;
                            operation.cancellation.check();
                            NativeTransfer.Media media = entry.text == null ? NativeTransfer.download(entry, directory, totalBytes,
                                    operation.cancellation, bytes -> progress(operation, "download", alreadySaved + bytes, index, entry.name)) : null;
                            try {
                                String originalName = media == null ? entry.name : NativePolicy.mediaFilename(entry.name, media.mime);
                                String name = originalName;
                                for (int suffix = 2; !zipNames.add(name.toLowerCase(java.util.Locale.ROOT)); suffix++) {
                                    name = NativePolicy.numberedFilename(originalName, suffix);
                                }
                                zip.putNextEntry(new ZipEntry(name));
                                if (media == null) {
                                    byte[] text = entry.text.getBytes(StandardCharsets.UTF_8);
                                    if (totalBytes + text.length > NativePolicy.MAX_TOTAL_BYTES) throw new IOException("本次文件总大小超过 1 GB。");
                                    zip.write(text);
                                    totalBytes += text.length;
                                } else {
                                    NativeTransfer.copy(media.file, zip, operation.cancellation);
                                    totalBytes += media.file.length();
                                }
                                zip.closeEntry();
                                progress(operation, "write", totalBytes, index, entry.name);
                            } finally { if (media != null) media.file.delete(); }
                        }
                        operation.cancellation.check();
                        zip.finish();
                    }
                } else {
                    NativeTransfer.Entry entry = operation.entries.get(0);
                    if (entry.text != null) {
                        byte[] text = entry.text.getBytes(StandardCharsets.UTF_8);
                        destination.write(text);
                        totalBytes = text.length;
                    } else {
                        NativeTransfer.Media media = NativeTransfer.download(entry, directory, 0, operation.cancellation,
                                bytes -> progress(operation, "download", bytes, 1, entry.name));
                        try {
                            if (!operation.mime.equals(media.mime)) {
                                throw new IOException("媒体实际格式与所选格式不同，请使用 ZIP 保存以保留原始格式。");
                            }
                            NativeTransfer.copy(media.file, destination, operation.cancellation);
                            totalBytes = media.file.length();
                        } finally { media.file.delete(); }
                    }
                    operation.cancellation.check();
                    destination.flush();
                    progress(operation, "write", totalBytes, 1, entry.name);
                }
            }
            operation.cancellation.check();
            if (!forgetDocument(operation.document)) {
                throw new IOException("无法确认保存状态，请检查手机存储空间后重试。");
            }
            complete = true;
        } catch (Exception error) {
            errorMessage = friendlyError(error);
        } finally {
            deleteTree(directory);
            if (complete) {
                finishOperation(operation, object("cancelled", false, "filename", operation.filename,
                        "files", operation.entries.size(), "bytes", totalBytes), null);
            } else {
                boolean removed = deleteDocument(operation.document);
                if (removed) forgetDocument(operation.document);
                if (!removed) {
                    finishOperation(operation, null, "保存未完成。系统无法删除临时文件，请在所选位置删除“" + operation.filename + "”。");
                } else if (operation.cancellation.isCancelled()) {
                    finishOperation(operation, object("cancelled", true), null);
                } else finishOperation(operation, null, errorMessage);
            }
        }
    }

    private void startImages(Request request, JSONObject params, boolean share) throws JSONException {
        if (!cleanupComplete) { request.failure("正在清理临时文件，请稍后重试。"); return; }
        if (transfer != null) { request.failure("已有保存或复制任务，请等待完成或取消。"); return; }
        List<NativeTransfer.Entry> entries = NativeTransfer.entries(params.getJSONArray("images"), true);
        Operation operation = new Operation(request, entries, "", "image/*");
        transfer = operation;
        workers.execute(() -> {
            File directory = new File(new File(getCacheDir(), "shared-images"), UUID.randomUUID().toString());
            boolean delivered = false;
            try {
                if (!directory.mkdirs()) throw new IOException("无法创建图片缓存，请检查手机存储空间。");
                ArrayList<Uri> uris = new ArrayList<>();
                Set<String> mimes = new HashSet<>();
                long bytes = 0;
                for (int i = 0; i < entries.size(); i++) {
                    NativeTransfer.Entry entry = entries.get(i);
                    final int index = i + 1;
                    final long completed = bytes;
                    NativeTransfer.Media media = NativeTransfer.download(entry, directory, bytes, operation.cancellation,
                            count -> progress(operation, "download", completed + count, index, entry.name));
                    bytes += media.file.length();
                    File image = new File(directory, "图片_" + (i + 1) + NativePolicy.extension(media.mime));
                    if (!media.file.renameTo(image)) throw new IOException("无法准备图片，请检查手机存储空间。");
                    uris.add(FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", image));
                    mimes.add(media.mime);
                }
                operation.cancellation.check();
                // Keep URI targets alive after handing them to clipboard or the receiving app.
                delivered = true;
                runOnUiThread(() -> deliverImages(operation, directory, uris, mimes, share));
            } catch (Exception error) {
                if (operation.cancellation.isCancelled()) finishOperation(operation, object("cancelled", true), null);
                else finishOperation(operation, null, friendlyError(error));
            } finally { if (!delivered) deleteTree(directory); }
        });
    }

    private void deliverImages(Operation operation, File directory, ArrayList<Uri> uris, Set<String> mimes, boolean share) {
        if (destroyed || operation.cancellation.isCancelled()) {
            deleteTree(directory);
            finishOperation(operation, object("cancelled", true), null);
            return;
        }
        try {
            ClipData clip = new ClipData(new ClipDescription("小红书图片", mimes.toArray(new String[0])), new ClipData.Item(uris.get(0)));
            for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
            if (share) {
                Intent intent = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
                intent.setType(mimes.size() == 1 ? mimes.iterator().next() : "image/*");
                if (uris.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                else intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                intent.setClipData(clip);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(intent, "分享图片"));
            } else getSystemService(ClipboardManager.class).setPrimaryClip(clip);
            finishOperation(operation, object("count", uris.size()), null);
        } catch (RuntimeException error) {
            deleteTree(directory);
            finishOperation(operation, null, share ? "没有可接收图片的应用。" : "系统暂时无法复制图片，请尝试分享图片。");
        }
    }

    private void finishOperation(Operation operation, JSONObject result, String error) {
        runOnUiThread(() -> {
            if (transfer == operation) transfer = null;
            if (error == null) operation.request.success(result);
            else operation.request.failure(error);
        });
    }

    private void progress(Operation operation, String stage, long bytes, int file, String filename) {
        long now = android.os.SystemClock.elapsedRealtime();
        if (stage.equals("download") && now - lastProgressAt < 150) return;
        lastProgressAt = now;
        event(object("type", "progress", "stage", stage, "bytes", bytes, "file", file,
                "total", operation.entries.size(), "filename", filename));
    }

    private void event(JSONObject event) {
        runOnUiThread(() -> {
            if (destroyed || webView == null || !webReady) return;
            webView.evaluateJavascript("window.brclioEvent&&window.brclioEvent(" + event.toString() + ")", null);
        });
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receiveShare(intent);
        if (webReady && !sharedText.isEmpty()) {
            event(object("type", "share", "text", sharedText));
            sharedText = "";
        }
    }

    private void receiveShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction()) || !"text/plain".equals(intent.getType())) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null) {
            if (text.length() <= 3000) sharedText = text.toString();
            else Toast.makeText(this, "分享内容超过 3000 字，请只复制笔记链接。", Toast.LENGTH_LONG).show();
        }
        intent.removeExtra(Intent.EXTRA_TEXT);
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("shared_text", sharedText);
        super.onSaveInstanceState(state);
    }

    @Override protected void onResume() {
        super.onResume();
        if (updater != null) updater.onResume();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        if (updater != null) updater.close();
        if (parsing != null) parsing.cancel();
        if (transfer != null) transfer.cancellation.cancel();
        List<NativeTransfer.Cancellation> activePreviews;
        synchronized (previews) { activePreviews = new ArrayList<>(previews); }
        for (NativeTransfer.Cancellation preview : activePreviews) preview.cancel();
        previews.clear();
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        workers.shutdown();
        super.onDestroy();
    }

    private boolean deleteDocument(Uri uri) {
        if (uri == null) return true;
        try { if (DocumentsContract.deleteDocument(getContentResolver(), uri)) return true; }
        catch (Exception ignored) { }
        try { return getContentResolver().delete(uri, null, null) > 0; }
        catch (Exception ignored) { return false; }
    }

    private boolean forgetDocument(Uri uri) {
        if (uri != null && uri.toString().equals(preferences.getString(PENDING_DOCUMENT, ""))) {
            // The success callback must never precede clearing crash-recovery state on disk.
            if (!preferences.edit().remove(PENDING_DOCUMENT).commit()) return false;
        }
        if (uri != null) {
            try { getContentResolver().releasePersistableUriPermission(uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); }
            catch (SecurityException ignored) { }
        }
        return true;
    }

    private void cleanupInterruptedDocument(String pending, File[] files) {
        if (pending != null) {
            Uri uri = Uri.parse(pending);
            if (deleteDocument(uri)) forgetDocument(uri);
        }
        if (files != null) for (File file : files) {
            if (file.isDirectory() && file.getName().startsWith("transfer-")) deleteTree(file);
        }
    }

    private void cleanupOldImages() {
        File[] directories = new File(getCacheDir(), "shared-images").listFiles();
        long yesterday = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        if (directories != null) for (File directory : directories) {
            if (directory.lastModified() < yesterday) deleteTree(directory);
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    private static boolean allowedMime(String mime, String kind) {
        if (kind.equals("text")) return mime.equals("text/plain");
        if (kind.equals("video")) return mime.equals("video/mp4") || mime.equals("video/webm");
        return mime.equals("image/jpeg") || mime.equals("image/png") || mime.equals("image/webp")
                || mime.equals("image/gif") || mime.equals("image/avif") || mime.equals("image/heif");
    }

    private static boolean isLocalOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
                && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private static boolean isLocalDocument(Uri uri) {
        return isLocalOrigin(uri) && "/assets/www/index.html".equals(uri.getPath());
    }

    private void openExternal(Uri uri) {
        try {
            NativePolicy.httpsUri(uri.buildUpon().fragment(null).build().toString());
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (IllegalArgumentException | ActivityNotFoundException ignored) { }
    }

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0]));
    }

    private static JSONObject object(Object... pairs) {
        JSONObject result = new JSONObject();
        try { for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]); }
        catch (JSONException error) { throw new IllegalArgumentException("无法构造客户端消息。"); }
        return result;
    }

    private static String friendlyError(Exception error) {
        if (error instanceof java.net.SocketTimeoutException) return "网络连接超时，请检查网络后重试。";
        if (error instanceof java.net.UnknownHostException) return "无法连接服务器，请检查网络连接。";
        if (error instanceof javax.net.ssl.SSLException) return "安全连接失败，请检查设备时间或网络后重试。";
        if (error instanceof IOException || error instanceof IllegalArgumentException) {
            String message = error.getMessage();
            // Only our localized messages are suitable for users; system errors can contain private URLs/paths.
            if (message != null && message.matches("(?s).*[\\u4e00-\\u9fff].*") && !message.contains("://")) return message;
        }
        return "操作未完成，请检查网络和手机存储空间后重试。";
    }
}
