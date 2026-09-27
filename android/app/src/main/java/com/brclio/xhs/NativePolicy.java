package com.brclio.xhs;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Validation shared by previews, downloaded files, and their redirect targets. */
final class NativePolicy {
    static final long MAX_MEDIA_BYTES = 512L * 1024 * 1024;
    static final long MAX_TOTAL_BYTES = 1024L * 1024 * 1024;
    static final int MAX_ENTRIES = 101;
    static final int MAX_TEXT_BYTES = 1024 * 1024;

    private NativePolicy() {}

    static URI mediaUri(String value) {
        URI uri = httpsUri(value);
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (!(host.equals("xhscdn.com") || host.endsWith(".xhscdn.com")
                || host.equals("ci.xiaohongshu.com"))) {
            throw new IllegalArgumentException("只支持小红书官方媒体地址。");
        }
        return uri;
    }

    static URI httpsUri(String value) {
        try {
            if (value == null || value.length() > 8192 || value.contains("\\")) {
                throw new URISyntaxException("", "Invalid URL");
            }
            URI uri = new URI(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)
                    || uri.getHost().endsWith(".") || uri.getRawFragment() != null) {
                throw new URISyntaxException("", "Invalid HTTPS URL");
            }
            return uri;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("地址必须是安全的 HTTPS 地址。");
        }
    }

    static String filename(String raw, String fallback) {
        String name = raw == null ? "" : raw.replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|]", "_")
                .replaceAll("[\\u202a-\\u202e\\u2066-\\u2069]", "")
                .replaceAll("^[.\\s]+|[.\\s]+$", "");
        if (name.isEmpty()) name = fallback;
        if (name.length() > 140) {
            int dot = name.lastIndexOf('.');
            String extension = dot > 0 && name.length() - dot <= 10 ? name.substring(dot) : "";
            name = name.substring(0, 140 - extension.length()) + extension;
        }
        return name;
    }

    static String numberedFilename(String name, int index) {
        int dot = name.lastIndexOf('.');
        return dot <= 0 ? name + " (" + index + ")"
                : name.substring(0, dot) + " (" + index + ")" + name.substring(dot);
    }

    static String mediaFilename(String name, String mime) {
        int dot = name.lastIndexOf('.');
        return (dot <= 0 ? name : name.substring(0, dot)) + extension(mime);
    }

    /** A type header alone is insufficient: CDNs sometimes return HTML with a 200 status. */
    static String sniffMime(byte[] bytes, int length) {
        if (length >= 3 && unsigned(bytes[0]) == 0xff && unsigned(bytes[1]) == 0xd8
                && unsigned(bytes[2]) == 0xff) return "image/jpeg";
        if (length >= 8 && unsigned(bytes[0]) == 0x89 && ascii(bytes, 1, 3).equals("PNG")
                && unsigned(bytes[4]) == 13 && unsigned(bytes[5]) == 10
                && unsigned(bytes[6]) == 26 && unsigned(bytes[7]) == 10) return "image/png";
        if (length >= 6 && (ascii(bytes, 0, 6).equals("GIF87a")
                || ascii(bytes, 0, 6).equals("GIF89a"))) return "image/gif";
        if (length >= 12 && ascii(bytes, 0, 4).equals("RIFF")
                && ascii(bytes, 8, 4).equals("WEBP")) return "image/webp";
        if (length >= 12 && ascii(bytes, 4, 4).equals("ftyp")) {
            String brand = ascii(bytes, 8, 4);
            if (brand.equals("avif") || brand.equals("avis")) return "image/avif";
            if (brand.equals("heic") || brand.equals("heix") || brand.equals("hevc")
                    || brand.equals("hevx") || brand.equals("mif1") || brand.equals("msf1")) {
                return "image/heif";
            }
            return "video/mp4";
        }
        if (length >= 4 && unsigned(bytes[0]) == 0x1a && unsigned(bytes[1]) == 0x45
                && unsigned(bytes[2]) == 0xdf && unsigned(bytes[3]) == 0xa3) return "video/webm";
        return null;
    }

    static void validateMime(String header, String detected, String kind) {
        if (!("image".equals(kind) || "video".equals(kind)) || detected == null
                || !detected.startsWith(kind + "/")) {
            throw new IllegalArgumentException("服务器返回的内容不是有效的" + ("video".equals(kind) ? "视频" : "图片") + "。");
        }
        String normalized = header == null ? "" : header.toLowerCase(Locale.ROOT).split(";", 2)[0].trim();
        if (!normalized.isEmpty() && !normalized.equals("application/octet-stream")
                && !normalized.equals("binary/octet-stream") && !normalized.startsWith(kind + "/")) {
            throw new IllegalArgumentException("媒体内容类型不匹配，请重新解析后重试。");
        }
    }

    static String extension(String mime) {
        switch (mime) {
            case "image/jpeg": return ".jpg";
            case "image/png": return ".png";
            case "image/gif": return ".gif";
            case "image/webp": return ".webp";
            case "image/avif": return ".avif";
            case "image/heif": return ".heif";
            case "video/webm": return ".webm";
            default: return ".mp4";
        }
    }

    private static String ascii(byte[] bytes, int offset, int count) {
        return new String(bytes, offset, count, StandardCharsets.US_ASCII);
    }

    private static int unsigned(byte value) { return value & 0xff; }
}
