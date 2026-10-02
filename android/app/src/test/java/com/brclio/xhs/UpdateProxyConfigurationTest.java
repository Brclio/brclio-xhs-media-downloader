package com.brclio.xhs;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.*;

public class UpdateProxyConfigurationTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private JSONObject configuration(boolean enabled, long revision) throws Exception {
        return new JSONObject().put("enabled", enabled).put("revision", revision)
                .put("subscriptionUrls", new JSONArray().put("https://subscriptions.example.test/a"));
    }

    @Test public void firstOfflineCheckHasNoDefaultSubscription() {
        JSONObject value = new UpdateProxyConfiguration().fallback(new File(temporary.getRoot(), "missing.json"));
        assertFalse(value.optBoolean("enabled"));
        assertEquals(0, value.optLong("revision"));
        assertEquals(0, value.optJSONArray("subscriptionUrls").length());
        assertEquals("", value.optString("subscriptionUrl"));
    }

    @Test public void administratorConfigurationSurvivesProcessRestartAndOfflineCheck() throws Exception {
        File cache = new File(temporary.getRoot(), "cache.json");
        new UpdateProxyConfiguration().accept(configuration(true, 2), cache);
        JSONObject cached = new UpdateProxyConfiguration().fallback(cache);
        assertTrue(cached.optBoolean("enabled"));
        assertEquals(2, cached.optLong("revision"));
        assertEquals("https://subscriptions.example.test/a", cached.optString("subscriptionUrl"));
    }

    @Test public void newerDisableIsNotOverwrittenBySlowOlderResponse() throws Exception {
        File cache = new File(temporary.getRoot(), "cache.json");
        UpdateProxyConfiguration store = new UpdateProxyConfiguration();
        store.accept(configuration(true, 1), cache);
        store.accept(configuration(false, 3), cache);
        assertFalse(store.accept(configuration(true, 2), cache).optBoolean("enabled"));
        assertEquals(3, new UpdateProxyConfiguration().fallback(cache).optLong("revision"));
    }

    @Test public void failedCacheWriteKeepsNewestDisableInMemory() throws Exception {
        File cache = new File(temporary.getRoot(), "cache.json");
        UpdateProxyConfiguration store = new UpdateProxyConfiguration();
        store.accept(configuration(true, 1), cache);
        store.accept(configuration(false, 2), new File(temporary.getRoot(), "missing/cache.json"));
        JSONObject value = store.fallback(cache);
        assertFalse(value.optBoolean("enabled"));
        assertEquals(2, value.optLong("revision"));
    }

    @Test public void onlineUnconfiguredBackendClearsPreviouslyCachedSubscriptions() throws Exception {
        File cache = new File(temporary.getRoot(), "cache.json");
        UpdateProxyConfiguration store = new UpdateProxyConfiguration();
        store.accept(configuration(true, 3), cache);
        assertFalse(store.accept(UpdateProxyConfiguration.disabled(), cache).optBoolean("enabled"));
        JSONObject restarted = new UpdateProxyConfiguration().fallback(cache);
        assertEquals(0, restarted.optLong("revision"));
        assertEquals(0, restarted.optJSONArray("subscriptionUrls").length());
    }

    @Test public void invalidConfigurationCannotReplaceAdministratorCache() throws Exception {
        File cache = new File(temporary.getRoot(), "cache.json");
        UpdateProxyConfiguration store = new UpdateProxyConfiguration();
        store.accept(configuration(true, 2), cache);
        JSONObject invalid = configuration(true, 3).put("subscriptionUrls", new JSONArray().put("http://localhost/private"));
        assertThrows(IllegalArgumentException.class, () -> store.accept(invalid, cache));
        assertEquals(2, store.fallback(cache).optLong("revision"));
        Files.write(cache.toPath(), "invalid JSON".getBytes(StandardCharsets.UTF_8));
        assertFalse(new UpdateProxyConfiguration().fallback(cache).optBoolean("enabled"));
    }

    @Test public void fullEightSourceCacheCanExceedThirtyTwoKilobytes() throws Exception {
        File cache = new File(temporary.getRoot(), "cache.json");
        JSONArray urls = new JSONArray();
        for (int index = 0; index < 8; index++) {
            urls.put("https://subscriptions.example.test/" + index + "/" + "x".repeat(4000));
        }
        JSONObject config = new JSONObject().put("enabled", true).put("revision", 4).put("subscriptionUrls", urls);
        new UpdateProxyConfiguration().accept(config, cache);
        assertTrue(cache.length() > 32768);
        assertEquals(8, new UpdateProxyConfiguration().fallback(cache).optJSONArray("subscriptionUrls").length());
    }
}
