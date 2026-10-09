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
    @Test public void onlyIndividualVideoSavesBypassMediaAndArchiveCaps() {
        assertTrue(NativePolicy.unlimitedVideoSave(false, 1, "video"));
        assertFalse(NativePolicy.unlimitedVideoSave(true, 1, "video"));
        assertFalse(NativePolicy.unlimitedVideoSave(false, 2, "video"));
        assertFalse(NativePolicy.unlimitedVideoSave(false, 1, "image"));
        assertFalse(NativePolicy.unlimitedVideoSave(false, 1, "text"));
        assertFalse(NativePolicy.unlimitedVideoSave(false, 0, "video"));
    }

    @Test public void individualVideoByteAccountingCrosses512MiB1GiBAnd2GiBWithoutAllocatingMedia() {
        long count = 0, target = 8L * 1024 * 1024 * 1024 + 17;
        while (count < target) {
            count = NativePolicy.addBytes(count, Math.min(64 * 1024, target - count));
            NativePolicy.validateMediaBytes("video", true, 0, count);
        }
        assertEquals(target, count);
        NativePolicy.validateMediaBytes("video", true, 0, NativePolicy.contentLength(Long.toString(target)));
    }

    @Test public void imageArchiveAndPreviewLimitsRemainBounded() {
        long fileLimit = NativePolicy.MAX_MEDIA_BYTES;
        NativePolicy.validateMediaBytes("image", false, fileLimit, fileLimit);
        NativePolicy.validateMediaBytes("video", false, 0, fileLimit);
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMediaBytes("video", false, 0, fileLimit + 1));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMediaBytes("image", false, 0, fileLimit + 1));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMediaBytes("image", true, 0, fileLimit + 1));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMediaBytes("image", false, NativePolicy.MAX_TOTAL_BYTES, 1));
    }

    @Test public void malformedNegativeZeroAndOverflowingDeclaredLengthsAreRejected() {
        assertEquals(-1, NativePolicy.contentLength(null));
        assertEquals(2L * 1024 * 1024 * 1024 + 1, NativePolicy.contentLength("2147483649"));
        for (String header : new String[] {"", "0", "-1", "1.5", "1e9", "NaN", " 5", "+5", "9223372036854775808"}) {
            assertThrows(header, IllegalArgumentException.class, () -> NativePolicy.contentLength(header));
        }
    }

    @Test public void accountingNeverWrapsLongCountersEvenForUnlimitedVideos() {
        assertEquals(Long.MAX_VALUE, NativePolicy.addBytes(Long.MAX_VALUE - 1, 1));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.addBytes(Long.MAX_VALUE, 1));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.addBytes(-1, 1));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.addBytes(0, -1));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMediaBytes("video", true, Long.MAX_VALUE, 1));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.validateMediaBytes("metadata", true, 0, 1));
    }

    @Test public void longHealthyVideoSavesHaveNoTotalTransferOrJobDeadline() {
        long twoHours = 2 * 60 * 60 * 1000L;
        assertFalse(NativePolicy.downloadTimedOut(twoHours, true));
        assertFalse(NativePolicy.jobTimedOut(twoHours, true));
        assertTrue(NativePolicy.downloadTimedOut(twoHours, false));
        assertTrue(NativePolicy.jobTimedOut(twoHours, false));
        assertFalse(NativePolicy.downloadTimedOut(NativePolicy.DOWNLOAD_TIMEOUT_MS, false));
        assertTrue(NativePolicy.downloadTimedOut(NativePolicy.DOWNLOAD_TIMEOUT_MS + 1, false));
    }

    @Test public void diskSpaceCheckReservesHeadroomWithoutOverflowingLargeDeclaredSizes() {
        long reserve = NativePolicy.SPACE_RESERVE_BYTES;
        assertTrue(NativePolicy.hasDownloadSpace(2147483649L, 2147483649L + reserve));
        assertFalse(NativePolicy.hasDownloadSpace(2147483649L, 2147483649L + reserve - 1));
        assertFalse(NativePolicy.hasDownloadSpace(Long.MAX_VALUE, Long.MAX_VALUE));
        assertTrue(NativePolicy.hasDownloadSpace(Long.MAX_VALUE - reserve, Long.MAX_VALUE));
        assertFalse(NativePolicy.hasDownloadSpace(0, reserve - 1));
    }

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

    @Test public void nativeVideoTransfersOnlyAcceptOrdinaryPlaybackIncludingEveryRedirectTarget() {
        URI playback = NativePolicy.playbackVideoUri("https://sns-video-v28.xhscdn.com/stream/ordinary.mp4?sign=a%2Bb%3D");
        assertEquals("https://sns-video-v28.xhscdn.com/stream/ordinary.mp4?sign=a%2Bb%3D", playback.toString());
        assertEquals(playback, NativePolicy.previewUri(playback.toString()));
        assertNotNull(NativePolicy.previewUri("https://sns-webpic-qc.xhscdn.com/original-image.jpg"));
        for (String original : new String[] {
                "https://sns-video-v28.xhscdn.com/spectrum/original", "https://sns-video-v28.xhscdn.com/original.mp4",
                "https://sns-video-v28.xhscdn.com/stream/../original.mp4",
                "https://sns-video-v28.xhscdn.com/stream/%2e%2e/original.mp4",
                "https://sns-video-v28.xhscdn.com/stream/%5coriginal.mp4",
                "https://ci.xiaohongshu.com/stream/original.mp4"
        }) assertThrows(original, IllegalArgumentException.class, () -> NativePolicy.playbackVideoUri(original));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.playbackVideoUri(playback.resolve("../original.mp4").toString()));
        assertThrows(IllegalArgumentException.class, () -> NativePolicy.previewUri("https://sns-video-v28.xhscdn.com/original.mp4"));
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
