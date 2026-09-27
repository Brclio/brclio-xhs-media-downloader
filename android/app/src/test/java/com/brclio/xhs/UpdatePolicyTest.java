package com.brclio.xhs;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;

public class UpdatePolicyTest {
    @Test public void androidChannelDoesNotConsumeDesktopOrPreviewTags() {
        assertEquals("1.0.0", UpdatePolicy.versionFromTag("android-v1.0.0"));
        assertEquals("2.10.11", UpdatePolicy.versionFromTag("android-v2.10.11"));
        for (String tag : new String[] {null, "", "v9.8.7", "1.0.0", "android-1.0.0", "android-v1.0.0-beta.1",
                "android-v1.0.0+metadata", "android-v01.0.0", "android-v1.0", "android-v9999999999.0.0"}) {
            assertNull(tag, UpdatePolicy.versionFromTag(tag));
        }
    }

    @Test public void releaseOrderingIsNumericAndNeverLexicographic() {
        assertTrue(UpdatePolicy.compareVersions("1.10.0", "1.9.99") > 0);
        assertTrue(UpdatePolicy.compareVersions("2.0.0", "1.999.999") > 0);
        assertTrue(UpdatePolicy.compareVersions("1.0.10", "1.0.9") > 0);
        assertTrue(UpdatePolicy.compareVersions("0.9.0", "1.0.0") < 0);
        assertEquals(0, UpdatePolicy.compareVersions("1.0.0", "1.0.0"));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.compareVersions("1.0.0-debug", "1.0.0"));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.compareVersions("01.0.0", "1.0.0"));
    }

    @Test public void assetUrlBindsRepositoryTagAndExactReleaseFilename() {
        String filename = UpdatePolicy.filename("1.2.3");
        assertEquals("Brclio-XHS-Android-1.2.3-release.apk", filename);
        String exact = "https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.2.3/" + filename;
        assertEquals(exact, UpdatePolicy.assetUri("android-v1.2.3", filename, exact).toString());
        assertEquals(exact + ".sha256", UpdatePolicy.assetUri("android-v1.2.3", filename + ".sha256", exact + ".sha256").toString());
        for (String url : new String[] {exact.replace("Brclio/", "attacker/"), exact.replace("android-v1.2.3/", "v1.2.3/"),
                exact.replace("github.com", "github.com.attacker.test"), exact + "?download=true", exact.replace("1.2.3-release", "1.2.3-debug")}) {
            assertThrows(url, IllegalArgumentException.class, () -> UpdatePolicy.assetUri("android-v1.2.3", filename, url));
        }
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.assetUri("android-v1.2.3", "other.apk", exact));
    }

    @Test public void assetRedirectsAllowOnlyExactGitHubDownloadHosts() {
        for (String url : new String[] {"https://github.com/release/path", "https://release-assets.githubusercontent.com/asset?signature=abc",
                "https://objects.githubusercontent.com/asset", "https://objects.githubusercontent.com:443/asset"}) {
            assertNotNull(UpdatePolicy.redirectUri(url));
        }
        for (String url : new String[] {"http://github.com/file", "https://github.com.attacker.test/file", "https://attacker.github.com/file",
                "https://raw.githubusercontent.com/file", "https://api.github.com/file", "https://objects.githubusercontent.com:8443/file",
                "https://attacker.test@github.com/file", "https://objects.githubusercontent.com./file", "file:///app/update.apk",
                "https://release-assets.githubusercontent.com/file#fragment"}) {
            assertThrows(url, IllegalArgumentException.class, () -> UpdatePolicy.redirectUri(url));
        }
    }

    @Test public void checksumsMustDescribeExactlyTheSelectedApk() {
        String name = UpdatePolicy.filename("1.0.0");
        String hash = "a1".repeat(32);
        assertEquals(hash, UpdatePolicy.checksum(hash + "  " + name + "\n", name));
        assertEquals(hash, UpdatePolicy.checksum(hash.toUpperCase() + " *" + name + "\r\n", name));
        for (String value : new String[] {hash, hash.substring(1) + "  " + name, hash + "  other.apk", hash + "  ../" + name,
                hash + "  " + name + "\n" + hash + "  " + name, "<html>Forbidden</html>", "g".repeat(64) + "  " + name}) {
            assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.checksum(value, name));
        }
    }

    @Test public void archiveMustMatchPublishedVersionAndStrictlyIncreaseVersionCode() {
        UpdatePolicy.validateVersion("1.0.0", "1.0.0", 10000, 9000);
        UpdatePolicy.validateVersion("1.0.1", "1.0.1", 10001, 10000);
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateVersion("1.0.1", "1.0.1", 10000, 10000));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateVersion("1.0.1", "1.0.1", 9000, 10000));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateVersion("1.0.1", "1.0.2", 10002, 10000));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateVersion("1.0.1", "1.0.1-debug", 10001, 10000));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateVersion("1.0.1", null, 10001, 10000));
    }

    @Test public void signaturesRequireExactNonemptySignerSets() {
        assertTrue(UpdatePolicy.sameSigners(Collections.singleton("release-key"), Collections.singleton("release-key")));
        assertTrue(UpdatePolicy.sameSigners(new HashSet<>(Arrays.asList("first", "second")), new HashSet<>(Arrays.asList("second", "first"))));
        assertFalse(UpdatePolicy.sameSigners(Collections.singleton("release-key"), Collections.singleton("debug-key")));
        assertFalse(UpdatePolicy.sameSigners(Collections.singleton("release-key"), new HashSet<>(Arrays.asList("release-key", "extra-key"))));
        assertFalse(UpdatePolicy.sameSigners(Collections.emptySet(), Collections.emptySet()));
        assertFalse(UpdatePolicy.sameSigners(null, Collections.singleton("release-key")));
        assertFalse(UpdatePolicy.sameSigners(Collections.singleton("release-key"), null));
    }
}
