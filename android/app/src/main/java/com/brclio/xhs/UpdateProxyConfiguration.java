package com.brclio.xhs;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Only administrator responses enter this cache. No build-time subscription exists. */
final class UpdateProxyConfiguration {
    private JSONObject last;

    static JSONObject disabled() {
        try {
            return new JSONObject().put("enabled", false).put("subscriptionUrls", new JSONArray())
                    .put("subscriptionUrl", "").put("revision", 0);
        } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    static JSONObject validate(JSONObject value) {
        Object enabled = value.opt("enabled");
        Object revision = value.opt("revision");
        if (!(enabled instanceof Boolean) || !(revision instanceof Number)
                || ((Number) revision).longValue() < 0 || ((Number) revision).doubleValue() != ((Number) revision).longValue()) {
            throw new IllegalArgumentException("Invalid update proxy configuration");
        }
        List<String> plural = null;
        if (value.has("subscriptionUrls")) {
            JSONArray array = value.optJSONArray("subscriptionUrls");
            if (array == null) throw new IllegalArgumentException("Invalid update subscription list");
            plural = new ArrayList<>();
            for (int index = 0; index < array.length(); index++) {
                if (!(array.opt(index) instanceof String)) throw new IllegalArgumentException("Invalid update subscription list");
                plural.add(array.optString(index));
            }
        }
        List<String> urls = UpdateProxyPolicy.subscriptionUrls(plural, value.optString("subscriptionUrl"), (Boolean) enabled);
        try {
            value.put("subscriptionUrls", new JSONArray(urls));
            value.put("subscriptionUrl", urls.isEmpty() ? "" : urls.get(0));
        } catch (org.json.JSONException impossible) { throw new IllegalArgumentException("Invalid update subscription list"); }
        return value;
    }

    synchronized JSONObject accept(JSONObject incoming, File cache) {
        JSONObject current = validate(incoming);
        if (current.optLong("revision") == 0) {
            // An online unconfigured backend is authoritative, even after an administrator reset.
            last = disabled();
        } else {
            JSONObject latest = readLatest(cache);
            last = latest.optLong("revision") > current.optLong("revision") ? latest : current;
        }
        // Preserve the newest response in memory even when storage is unavailable.
        File temporary = null;
        try {
            temporary = File.createTempFile("update-proxy-config-", ".part", cache.getParentFile());
            if (!temporary.setReadable(false, false) || !temporary.setWritable(false, false)
                    || !temporary.setReadable(true, true) || !temporary.setWritable(true, true)) {
                throw new IOException("Private configuration permissions unavailable");
            }
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(last.toString().getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            if (!temporary.renameTo(cache)) throw new IOException("Cannot save update configuration");
        } catch (IOException ignored) { /* The session still uses the current administrator response. */ }
        finally { if (temporary != null) temporary.delete(); }
        return last;
    }

    synchronized JSONObject fallback(File cache) {
        last = readLatest(cache);
        return last;
    }

    private JSONObject readLatest(File cache) {
        if (last != null && last.optLong("revision") == 0) return last;
        JSONObject latest = last;
        try (InputStream input = new FileInputStream(cache)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 65536) throw new IOException("Configuration too large");
                output.write(buffer, 0, count);
            }
            JSONObject disk = validate(new JSONObject(output.toString(StandardCharsets.UTF_8.name())));
            if (latest == null || disk.optLong("revision") > latest.optLong("revision")) latest = disk;
        } catch (Exception invalid) { /* No previously accepted administrator configuration is available. */ }
        return latest == null ? disabled() : latest;
    }
}
