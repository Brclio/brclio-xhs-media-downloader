package com.brclio.xhs;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/** The controller listener can start before Mihomo installs the configured proxies. */
final class UpdateProxyReadiness {
    interface Status { JSONObject fetch(long timeoutNanos) throws IOException; }
    interface Check { void run() throws IOException; }
    interface Pause { void sleep(long nanoseconds) throws InterruptedException; }
    private static final long MIN_REQUEST_NANOS = TimeUnit.MILLISECONDS.toNanos(1);
    private static final long REQUEST_NANOS = TimeUnit.MILLISECONDS.toNanos(500);
    private static final long POLL_NANOS = TimeUnit.MILLISECONDS.toNanos(80);

    private UpdateProxyReadiness() { }

    static void await(List<String> expected, Status status, Check check) throws IOException {
        await(expected, status, check, System::nanoTime, TimeUnit.NANOSECONDS::sleep,
                TimeUnit.SECONDS.toNanos(12));
    }

    static void await(List<String> expected, Status status, Check check, LongSupplier clock,
                      Pause pause, long timeoutNanos) throws IOException {
        long deadline = clock.getAsLong() + timeoutNanos;
        while (true) {
            check.run();
            long remaining = deadline - clock.getAsLong();
            // OkHttp rejects positive timeouts smaller than its millisecond precision.
            if (remaining < MIN_REQUEST_NANOS) throw timeout();
            boolean ready = false;
            try { ready = configured(status.fetch(Math.min(REQUEST_NANOS, remaining)), expected); }
            catch (IOException pending) { /* Refusal and HTTP 404 are normal before configuration is installed. */ }
            check.run();
            remaining = deadline - clock.getAsLong();
            if (remaining <= 0) throw timeout();
            if (ready) return;
            try { pause.sleep(Math.min(POLL_NANOS, remaining)); }
            catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("更新网络检查已取消。", interrupted);
            }
        }
    }

    static boolean configured(JSONObject group, List<String> expected) {
        if (group == null || !UpdateProxyPolicy.GROUP.equals(group.optString("name"))
                || !"Selector".equals(group.optString("type")) || expected.isEmpty()) return false;
        JSONArray all = group.optJSONArray("all");
        if (all == null || all.length() != expected.size()) return false;
        Set<String> names = new HashSet<>();
        for (int index = 0; index < all.length(); index++) {
            Object name = all.opt(index);
            if (!(name instanceof String) || !names.add((String) name)) return false;
        }
        return names.equals(new HashSet<>(expected));
    }

    private static IOException timeout() { return new IOException("更新网络组件启动超时，请重试。"); }
}
