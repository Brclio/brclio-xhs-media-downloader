package com.brclio.xhs;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A separate local page keeps the downloader's parsed result and ongoing transfer intact. */
public final class LearningActivity extends Activity {
    static final String EXTRA_PAGE = "promotion_page";
    private static final int SAVE_QR = 2001;
    private static final String CSP = "default-src 'none'; script-src 'self'; style-src 'self'; "
            + "img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; "
            + "object-src 'none'; base-uri 'none'; form-action 'none'";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private WebView webView;
    private boolean saving;
    private boolean destroyed;

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        saving = state != null && state.getBoolean("saving_qr", false);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setSafeBrowsingEnabled(true);
        webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        webView.setWebChromeClient(new WebChromeClient());
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                String url = request.getUrl().toString();
                if (LearningPagePolicy.isPromotionDocument(url)) return false;
                if (request.hasGesture()) {
                    if (LearningPagePolicy.isReturnDocument(url)) finish();
                    else openExternal(request.getUrl());
                }
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (!"GET".equals(request.getMethod()) || !LearningPagePolicy.isBundledAsset(url)
                        || (request.isForMainFrame() && !LearningPagePolicy.isPromotionDocument(url))) return blocked();
                WebResourceResponse response = assets.shouldInterceptRequest(request.getUrl());
                if (response == null) return blocked();
                Map<String, String> headers = new HashMap<>();
                headers.put("Content-Security-Policy", CSP);
                headers.put("X-Content-Type-Options", "nosniff");
                response.setResponseHeaders(headers);
                return response;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (!LearningPagePolicy.isPromotionDocument(url)) view.stopLoading();
            }

            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                Toast.makeText(LearningActivity.this, "页面已停止，请返回下载页重新打开。", Toast.LENGTH_LONG).show();
                finish();
                return true;
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "BrclioLearning", Collections.singleton(LearningPagePolicy.ORIGIN),
                    (view, message, origin, mainFrame, reply) -> {
                        if (destroyed || !mainFrame || !LearningPagePolicy.ORIGIN.equals(origin.toString())
                                || !LearningPagePolicy.isPromotionDocument(view.getUrl())) return;
                        try {
                            if ("saveQr".equals(message.getData())) saveQr();
                        } catch (RuntimeException ignored) { }
                    });
        }
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(0xfffefcf6);
        container.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        ViewCompat.setOnApplyWindowInsetsListener(container, (view, insets) -> {
            Insets padding = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(container);
        ViewCompat.requestApplyInsets(container);
        webView.loadUrl(LearningPagePolicy.startUrl(getIntent().getStringExtra(EXTRA_PAGE)));
    }

    private void saveQr() {
        if (saving) {
            notifySave(false, "请先完成当前的二维码保存。");
            return;
        }
        try {
            saving = true;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("image/png").putExtra(Intent.EXTRA_TITLE, LearningPagePolicy.qrFilename(webView.getUrl()));
            startActivityForResult(intent, SAVE_QR);
        } catch (RuntimeException error) {
            saving = false;
            notifySave(false, "未找到文件保存应用，可点击二维码放大后截图，再用微信扫一扫识别。");
        }
    }

    private void openExternal(Uri uri) {
        if ("appassets.androidplatform.net".equals(uri.getHost())) return;
        try {
            NativePolicy.httpsUri(uri.buildUpon().fragment(null).build().toString());
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (IllegalArgumentException | ActivityNotFoundException ignored) { }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SAVE_QR) return;
        Uri destination = data == null ? null : data.getData();
        if (resultCode != RESULT_OK || destination == null || !"content".equals(destination.getScheme())) {
            saving = false;
            notifySave(false, "已取消保存二维码。");
            return;
        }
        worker.execute(() -> {
            boolean success = false;
            try (InputStream input = getAssets().open(LearningPagePolicy.QR_ASSET);
                 OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                if (output == null) throw new IOException("Cannot open output");
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                output.flush();
                success = true;
            } catch (IOException | RuntimeException error) {
                success = false;
                try { DocumentsContract.deleteDocument(getContentResolver(), destination); }
                catch (Exception ignored) { }
            }
            final boolean saved = success;
            runOnUiThread(() -> {
                saving = false;
                notifySave(saved, saved ? "二维码已保存到所选位置，可在微信扫一扫中选择图片识别。"
                        : "保存失败，请重试或点击二维码放大后截图。");
            });
        });
    }

    private void notifySave(boolean ok, String message) {
        if (destroyed || webView == null) return;
        JSONObject result = new JSONObject();
        try { result.put("ok", ok).put("message", message); }
        catch (JSONException ignored) { return; }
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('brclio-qr-save-result',{detail:"
                + result + "}))", null);
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putBoolean("saving_qr", saving);
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        destroyed = true;
        if (webView != null) { webView.stopLoading(); webView.destroy(); webView = null; }
        worker.shutdown();
        super.onDestroy();
    }

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0]));
    }
}
