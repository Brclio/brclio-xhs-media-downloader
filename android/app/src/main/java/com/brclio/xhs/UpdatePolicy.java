package com.brclio.xhs;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure validation for Android's independent release channel. */
final class UpdatePolicy {
    static final String APPLICATION_ID = "com.brclio.xhs";
    static final String REPOSITORY = "Brclio/brclio-xhs-media-downloader";
    static final String RELEASES_API = "https://api.github.com/repos/" + REPOSITORY + "/releases?per_page=100";
    static final long MAX_APK_BYTES = 512L * 1024 * 1024;
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})");
    private static final Set<String> DOWNLOAD_HOSTS = new HashSet<>(Arrays.asList(
            "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"));

    private UpdatePolicy() {}

    static String versionFromTag(String tag) {
        if (tag == null || !tag.startsWith("android-v")) return null;
        String version = tag.substring("android-v".length());
        return VERSION.matcher(version).matches() ? version : null;
    }

    static int compareVersions(String first, String second) {
        Matcher left = VERSION.matcher(first);
        Matcher right = VERSION.matcher(second);
        if (!left.matches() || !right.matches()) throw new IllegalArgumentException("安卓版本号格式无效。");
        for (int index = 1; index <= 3; index++) {
            int compared = Integer.compare(Integer.parseInt(left.group(index)), Integer.parseInt(right.group(index)));
            if (compared != 0) return compared;
        }
        return 0;
    }

    static String filename(String version) {
        if (!VERSION.matcher(version).matches()) throw new IllegalArgumentException("安卓版本号格式无效。");
        return "Brclio-XHS-Android-" + version + "-release.apk";
    }

    static URI assetUri(String tag, String asset, String actualUrl) {
        String version = versionFromTag(tag);
        if (version == null || !(asset.equals(filename(version)) || asset.equals(filename(version) + ".sha256"))) {
            throw new IllegalArgumentException("安卓安装包名称与发布版本不一致。");
        }
        String expected = "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + asset;
        if (!expected.equals(actualUrl)) throw new IllegalArgumentException("安装包来源与官方发布地址不一致。");
        return URI.create(expected);
    }

    static URI redirectUri(String value) {
        URI uri = NativePolicy.httpsUri(value);
        if (!DOWNLOAD_HOSTS.contains(uri.getHost().toLowerCase(Locale.ROOT))) {
            throw new IllegalArgumentException("更新下载跳转到了不受信任的地址。");
        }
        return uri;
    }

    static String checksum(String value, String expectedFilename) {
        if (value == null || value.length() > 4096) throw new IllegalArgumentException("安装包校验文件无效。");
        String line = value.trim();
        Matcher match = Pattern.compile("([a-fA-F0-9]{64})[ \\t]+\\*?" + Pattern.quote(expectedFilename)).matcher(line);
        if (!match.matches()) throw new IllegalArgumentException("安装包校验文件与当前版本不匹配。");
        return match.group(1).toLowerCase(Locale.ROOT);
    }

    static void validateVersion(String expectedVersion, String archiveVersion, long archiveCode, long installedCode) {
        if (!expectedVersion.equals(archiveVersion)) throw new IllegalArgumentException("安装包版本与发布标签不一致。");
        if (archiveCode <= installedCode) throw new IllegalArgumentException("安装包版本不高于当前版本，已阻止重复安装或降级。");
    }

    static boolean sameSigners(Set<String> installed, Set<String> downloaded) {
        return installed != null && downloaded != null && !installed.isEmpty() && installed.equals(downloaded);
    }
}
