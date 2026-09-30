package com.brclio.xhs;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Only the two bundled promotion documents and their explicit static dependencies are exposed. */
final class LearningPagePolicy {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String START_URL = ORIGIN + "/assets/www/learn.html";
    static final String VIP_URL = ORIGIN + "/assets/www/vip.html";
    static final String QR_ASSET = "www/assets/support/wechat-personal-qr.png";
    private static final Set<String> ASSETS = new HashSet<>(Arrays.asList(
            "/assets/www/learn.html", "/assets/www/learn.css", "/assets/www/learn.js",
            "/assets/www/vip.html", "/assets/www/vip.css", "/assets/www/vip.js",
            "/assets/www/aiyc.svg", "/assets/www/favicon.svg",
            "/assets/www/assets/learning/book-promo.png",
            "/assets/www/assets/support/wechat-personal-qr.png"));

    private LearningPagePolicy() { }

    static boolean isLearningDocument(String value) {
        return "/assets/www/learn.html".equals(localPath(value));
    }

    static boolean isVipDocument(String value) {
        return "/assets/www/vip.html".equals(localPath(value));
    }

    static boolean isPromotionDocument(String value) {
        return isLearningDocument(value) || isVipDocument(value);
    }

    static String startUrl(String page) {
        return "vip".equals(page) ? VIP_URL : START_URL;
    }

    static String qrFilename(String url) {
        return isVipDocument(url) ? "Brclio-VIP-微信.png" : "Brclio-微信咨询.png";
    }

    static boolean isReturnDocument(String value) {
        return "/assets/www/index.html".equals(localPath(value));
    }

    static boolean isBundledAsset(String value) {
        return ASSETS.contains(localPath(value));
    }

    private static String localPath(String value) {
        if (value == null) return null;
        try {
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost())
                    || uri.getRawUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)
                    || uri.getRawQuery() != null) return null;
            return uri.getRawPath();
        } catch (URISyntaxException error) { return null; }
    }
}
