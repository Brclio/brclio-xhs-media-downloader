package com.brclio.xhs;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
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
        for (String name : new String[] {"learn.html", "learn.css", "learn.js", "vip.html", "vip.css", "vip.js", "aiyc.svg", "favicon.svg",
                "assets/learning/book-promo.png", "assets/support/wechat-personal-qr.png"}) {
            assertTrue(name, LearningPagePolicy.isBundledAsset(LearningPagePolicy.ORIGIN + "/assets/www/" + name));
        }
        for (String name : new String[] {"index.html", "client.js", "media.js", "assets/support/other.png", "../learn.html"}) {
            assertFalse(name, LearningPagePolicy.isBundledAsset(LearningPagePolicy.ORIGIN + "/assets/www/" + name));
        }
    }

    @Test public void vipPageUsesExactBundledDocumentAndDedicatedSaveName() {
        assertTrue(LearningPagePolicy.isVipDocument(LearningPagePolicy.VIP_URL));
        assertTrue(LearningPagePolicy.isVipDocument(LearningPagePolicy.VIP_URL + "#contact"));
        assertTrue(LearningPagePolicy.isPromotionDocument(LearningPagePolicy.VIP_URL));
        assertTrue(LearningPagePolicy.isPromotionDocument(LearningPagePolicy.START_URL));
        assertFalse(LearningPagePolicy.isLearningDocument(LearningPagePolicy.VIP_URL));
        assertFalse(LearningPagePolicy.isVipDocument(LearningPagePolicy.START_URL));
        assertEquals(LearningPagePolicy.VIP_URL, LearningPagePolicy.startUrl("vip"));
        for (String page : new String[] {null, "", "learn", "../vip", "https://example.com", "VIP"}) {
            assertEquals(LearningPagePolicy.START_URL, LearningPagePolicy.startUrl(page));
        }
        assertEquals("Brclio-VIP-微信.png", LearningPagePolicy.qrFilename(LearningPagePolicy.VIP_URL));
        assertEquals("Brclio-微信咨询.png", LearningPagePolicy.qrFilename(LearningPagePolicy.START_URL));
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
            assertFalse(String.valueOf(url), LearningPagePolicy.isVipDocument(url));
            assertFalse(String.valueOf(url), LearningPagePolicy.isPromotionDocument(url));
            assertFalse(String.valueOf(url), LearningPagePolicy.isBundledAsset(url));
            assertFalse(String.valueOf(url), LearningPagePolicy.isReturnDocument(url));
        }
    }

    @Test public void vipPageDoesNotAcceptRemoteEncodedTraversingOrQueryUrls() {
        for (String url : new String[] {
                "https://example.com/assets/www/vip.html", "file:///assets/www/vip.html",
                LearningPagePolicy.VIP_URL + "?source=remote", LearningPagePolicy.VIP_URL + "/other",
                LearningPagePolicy.VIP_URL.replace("vip", "%76ip"),
                LearningPagePolicy.VIP_URL.replace("/www/", "/www/../www/"),
                "https://user@appassets.androidplatform.net/assets/www/vip.html",
                "https://appassets.androidplatform.net:8443/assets/www/vip.html"}) {
            assertFalse(url, LearningPagePolicy.isPromotionDocument(url));
            assertFalse(url, LearningPagePolicy.isBundledAsset(url));
        }
    }
}
