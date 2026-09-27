package com.brclio.xhs;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.net.URI;
import java.nio.charset.StandardCharsets;

public class NativePolicyTest {
    @Test public void officialMediaHostsKeepSignedQueriesAndDefaultHttpsPorts() {
        String signed = "https://sns-webpic-qc.xhscdn.com/image.jpg?sign=a%2Bb%3D&expires=123";
        assertEquals(signed, NativePolicy.mediaUri(signed).toString());
        for (String url : new String[] {
                "https://xhscdn.com/image.jpg", "https://a.b.xhscdn.com/image.jpg",
                "https://ci.xiaohongshu.com/image.jpg", "HTTPS://SNS-VIDEO-V28.XHSCDN.COM/video.mp4",
                "https://sns-video-v28.xhscdn.com:443/video.mp4"
        }) assertNotNull(NativePolicy.mediaUri(url));
    }

    @Test public void mediaHostsCannotBeSpoofedWithSuffixesUserInfoOrIpAddresses() {
        for (String url : new String[] {
                "https://evilxhscdn.com/image.jpg", "https://xhscdn.com.attacker.test/image.jpg",
                "https://ci.xiaohongshu.com.attacker.test/image.jpg", "https://www.xiaohongshu.com/image.jpg",
                "https://localhost/image.jpg", "https://127.0.0.1/image.jpg", "https://[::1]/image.jpg",
                "https://user:password@sns-webpic-qc.xhscdn.com/image.jpg",
                "https://xhscdn.com@attacker.test/image.jpg", "https://attacker.test@xhscdn.com/image.jpg",
                "https://sns-webpic-qc.xhscdn.com./image.jpg",
                "https://sns-webpic-qc.xhscdn.com%2eattacker.test/image.jpg",
                "https://sns-webpic-qc.xhscdn.com\\@attacker.test/image.jpg"
        }) assertThrows(url, IllegalArgumentException.class, () -> NativePolicy.mediaUri(url));
    }

    @Test public void nativeNetworkBoundaryRequiresHttpsAndRejectsPortsFragmentsAndMalformedInput() {
        for (String url : new String[] {
                null, "", "not a URL", "//xhscdn.com/image.jpg", "http://xhscdn.com/image.jpg",
                "file:///private/image.jpg", "content://com.brclio.xhs/private", "javascript:alert(1)",
                "https://xhscdn.com:80/image.jpg", "https://xhscdn.com:8443/image.jpg",
                "https://xhscdn.com/image.jpg#fragment", "https://xhscdn.com/image.jpg\r\nX-Injected: yes",
                "https://xhscdn.com/" + "a".repeat(8192)
        }) assertThrows(String.valueOf(url), IllegalArgumentException.class, () -> NativePolicy.mediaUri(url));
    }

    @Test public void relativeRedirectsRemainSubjectToTheSameMediaPolicy() {
        URI base = NativePolicy.mediaUri("https://sns-video-v28.xhscdn.com/stream/old.mp4?sign=old");
        URI next = base.resolve("../new.mp4?sign=a%2Bb%3D");
        assertEquals("https://sns-video-v28.xhscdn.com/new.mp4?sign=a%2Bb%3D", NativePolicy.mediaUri(next.toString()).toString());
        for (String target : new String[] { "//attacker.test/media", "http://xhscdn.com/media", "https://xhscdn.com:8443/media" }) {
            assertThrows(IllegalArgumentException.class, () -> NativePolicy.mediaUri(base.resolve(target).toString()));
        }
    }

    @Test public void filenamesCannotEscapeDirectoriesOrHideAnExtension() {
        String clean = NativePolicy.filename(" ../夏天\\回忆:照片\u0000\n\u007f\u202egpj.mp4 ", "default.jpg");
        assertFalse(clean.matches(".*[\\\\/:*?\"<>|\\p{Cntrl}].*"));
        assertFalse(clean.contains("\u202e"));
        assertFalse(clean.startsWith("."));
        assertFalse(clean.endsWith(" "));
        assertEquals("default.jpg", NativePolicy.filename(" ... ", "default.jpg"));
        assertEquals("default.jpg", NativePolicy.filename(null, "default.jpg"));
        assertEquals("旅行照片.jpg", NativePolicy.filename("旅行照片.jpg", "default.jpg"));
        String longName = NativePolicy.filename("夏".repeat(180) + ".mp4", "video.mp4");
        assertEquals(140, longName.length());
        assertTrue(longName.endsWith(".mp4"));
    }

    @Test public void duplicateEntryNamesCanBeDisambiguatedWithoutLosingExtensions() {
        assertEquals("照片 (2).jpg", NativePolicy.numberedFilename("照片.jpg", 2));
        assertEquals("note.backup (3).txt", NativePolicy.numberedFilename("note.backup.txt", 3));
        assertEquals("README (4)", NativePolicy.numberedFilename("README", 4));
    }

    @Test public void sniffingDistinguishesImageVideoAndHtmlRegardlessOfTheClaimedExtension() {
        assertEquals("image/jpeg", sniff(new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff}));
        assertEquals("image/png", sniff(new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10}));
        assertEquals("image/gif", sniff("GIF89a"));
        assertEquals("image/gif", sniff("GIF87a"));
        assertEquals("image/webp", sniff("RIFF0000WEBP"));
        assertEquals("image/avif", sniff("0000ftypavif"));
        assertEquals("image/avif", sniff("0000ftypavis"));
        assertEquals("image/heif", sniff("0000ftypheic"));
        assertEquals("video/mp4", sniff("0000ftypisom"));
        assertEquals("video/webm", sniff(new byte[] {0x1a, 0x45, (byte) 0xdf, (byte) 0xa3}));
        assertNull(sniff("<!DOCTYPE html><html>verification required</html>"));
        assertNull(sniff("{\"success\":false}"));
        assertNull(sniff(new byte[] {(byte) 0xff, (byte) 0xd8}));
        assertNull(sniff(new byte[0]));
    }

    @Test public void mimeValidationRejectsHtmlAndWrongKindEvenWhenHttpSaysSuccess() {
        NativePolicy.validateMime("image/jpeg; charset=binary", "image/jpeg", "image");
        NativePolicy.validateMime("application/octet-stream", "image/png", "image");
        NativePolicy.validateMime(null, "video/mp4", "video");
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMime("image/jpeg", null, "image"));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMime("text/html", "image/jpeg", "image"));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMime("image/png", "video/mp4", "image"));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMime("video/mp4", "image/avif", "video"));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMime("application/json", "video/mp4", "video"));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMime("image/jpeg", "image/jpeg", "text"));
    }

    @Test public void cacheFilesUseTheDetectedMediaFormatForClipboardAndShareUris() {
        assertEquals(".jpg", NativePolicy.extension("image/jpeg"));
        assertEquals(".png", NativePolicy.extension("image/png"));
        assertEquals(".webp", NativePolicy.extension("image/webp"));
        assertEquals(".gif", NativePolicy.extension("image/gif"));
        assertEquals(".avif", NativePolicy.extension("image/avif"));
        assertEquals(".heif", NativePolicy.extension("image/heif"));
        assertEquals(".webm", NativePolicy.extension("video/webm"));
        assertEquals(".mp4", NativePolicy.extension("video/mp4"));
    }

    @Test public void archiveMediaNamesUseActualBytesInsteadOfMislabelingPngOrWebpAsJpeg() {
        assertEquals("01.png", NativePolicy.mediaFilename("01.jpg", "image/png"));
        assertEquals("实况原图.webp", NativePolicy.mediaFilename("实况原图.jpg", "image/webp"));
        assertEquals("01-live.mp4", NativePolicy.mediaFilename("01-live.mp4", "video/mp4"));
        assertEquals("video.webm", NativePolicy.mediaFilename("video.mp4", "video/webm"));
        assertEquals("原图.jpg", NativePolicy.mediaFilename("原图", "image/jpeg"));
    }

    private static String sniff(String value) { return sniff(value.getBytes(StandardCharsets.US_ASCII)); }
    private static String sniff(byte[] value) { return NativePolicy.sniffMime(value, value.length); }
}
