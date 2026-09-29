package com.brclio.xhs;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LearningPagePolicyTest {
    @Test public void localLearningDocumentKeepsSectionLinksAndExplicitHttpsPort() {
        assertTrue(LearningPagePolicy.isLearningDocument(LearningPagePolicy.START_URL));
        assertTrue(LearningPagePolicy.isLearningDocument(LearningPagePolicy.START_URL + "#contact"));
        assertTrue(LearningPagePolicy.isLearningDocument("https://appassets.androidplatform.net:443/assets/www/learn.html"));
        assertTrue(LearningPagePolicy.isReturnDocument(LearningPagePolicy.ORIGIN + "/assets/www/index.html"));
        assertFalse(LearningPagePolicy.isLearningDocument(LearningPagePolicy.ORIGIN + "/assets/www/index.html"));
    }

    @Test public void assetsAreExplicitAndDoNotExposeDownloaderScripts() {
        for (String name : new String[] {"learn.html", "learn.css", "learn.js", "aiyc.svg", "favicon.svg",
                "assets/learning/book-promo.png", "assets/support/wechat-personal-qr.png"}) {
            assertTrue(name, LearningPagePolicy.isBundledAsset(LearningPagePolicy.ORIGIN + "/assets/www/" + name));
        }
        for (String name : new String[] {"index.html", "client.js", "media.js", "assets/support/other.png", "../learn.html"}) {
            assertFalse(name, LearningPagePolicy.isBundledAsset(LearningPagePolicy.ORIGIN + "/assets/www/" + name));
        }
    }

    @Test public void remoteOriginsEncodedPathsAndAmbiguousUrlsCannotAccessAssetsOrNavigation() {
        for (String url : new String[] {null, "", "learn.html", "javascript:alert(1)", "file:///assets/www/learn.html",
                "http://appassets.androidplatform.net/assets/www/learn.html",
                "https://appassets.androidplatform.net.attacker.test/assets/www/learn.html",
                "https://user@appassets.androidplatform.net/assets/www/learn.html",
                "https://appassets.androidplatform.net:8443/assets/www/learn.html",
                LearningPagePolicy.START_URL + "?redirect=https://example.com",
                LearningPagePolicy.START_URL + "/other", LearningPagePolicy.START_URL.replace("learn", "%6cearn"),
                LearningPagePolicy.START_URL.replace("/www/", "/www/../www/")}) {
            assertFalse(String.valueOf(url), LearningPagePolicy.isLearningDocument(url));
            assertFalse(String.valueOf(url), LearningPagePolicy.isBundledAsset(url));
            assertFalse(String.valueOf(url), LearningPagePolicy.isReturnDocument(url));
        }
    }
}
