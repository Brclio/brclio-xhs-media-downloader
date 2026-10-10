package com.brclio.xhs;

import android.app.Activity;

import org.json.JSONObject;
import org.json.JSONArray;
import org.yaml.snakeyaml.Yaml;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.TimeUnit;

import okhttp3.Credentials;
import okhttp3.OkHttpClient;

/** One update operation owns one private process; application/WebView/media networking is untouched. */
final class UpdateProxySession implements AutoCloseable {
    interface Check { void run() throws IOException; }
    interface SystemRoute { boolean enabled(); }
    private static final URI CONFIG_URI = URI.create("https://xhs.download.brclio.com/api/account");
    private static final UpdateProxyConfiguration CONFIGURATION = new UpdateProxyConfiguration();
    private final Check check;
    private final SystemRoute systemRoute;
    private final Set<HttpURLConnection> connections = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final ExecutorService probes = Executors.newFixedThreadPool(8);
    private volatile boolean closed;
    private volatile Process process;
    private volatile File directory;
    private volatile OkHttpClient client;
    private volatile boolean internal;
    private boolean cleanupScheduled;
    private String secret;
    private int controllerPort;
    private final List<Delay> ranked = new ArrayList<>();
    private int selectedIndex;

    UpdateProxySession(Check check, SystemRoute systemRoute) { this.check = check; this.systemRoute = systemRoute; }

    boolean usesInternalProxy() { return internal; }

    OkHttpClient prepare(Activity activity) throws IOException {
        check();
        if (systemRoute.enabled()) return useSystemClient();
        JSONObject config = newestConfiguration(activity);
        synchronized (this) {
            check();
            client = directClient();
        }
        if (!config.optBoolean("enabled", false)) return client;
        List<List<Map<String, Object>>> sources = new ArrayList<>();
        UpdateSubscriptionRetry.Diagnostics sourceFailures = new UpdateSubscriptionRetry.Diagnostics();
        JSONArray urls = config.optJSONArray("subscriptionUrls");
        for (int index = 0; urls != null && index < urls.length(); index++) {
            check();
            try {
                URI subscription;
                try { subscription = UpdateProxyPolicy.subscriptionUri(urls.optString(index)); }
                catch (IllegalArgumentException invalid) { throw UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.URL); }
                sources.add(UpdateSubscriptionRetry.execute(() -> {
                    String text = new String(fetchSubscription(subscription), StandardCharsets.UTF_8);
                    try { return UpdateProxyPolicy.nodes(text); }
                    catch (RuntimeException invalid) { throw UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.FORMAT); }
                }, this::check));
            } catch (Exception unavailable) {
                check();
                sourceFailures.addSummary(UpdateSubscriptionRetry.classify(unavailable));
                /* Other administrator-configured sources remain usable. */
            }
        }
        List<Map<String, Object>> nodes;
        try { nodes = UpdateProxyPolicy.mergeNodes(sources); }
        catch (IllegalArgumentException invalid) { throw new IOException(invalid.getMessage()); }
        if (nodes.isEmpty()) throw new IOException("更新订阅暂不可用（" + sourceFailures.summary() + "），请联系管理员或稍后重试。");
        if (systemRoute.enabled()) return useSystemClient();
        int proxyPort = unusedPort();
        controllerPort = unusedPort();
        while (proxyPort == controllerPort) controllerPort = unusedPort();
        String username = "brclio";
        String password = UUID.randomUUID().toString().replace("-", "");
        secret = UUID.randomUUID().toString().replace("-", "");
        File parent = new File(activity.getCacheDir(), "update-proxy");
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法准备更新网络缓存。");
        File configuration;
        synchronized (this) {
            check();
            directory = new File(parent, UUID.randomUUID().toString());
            if (!directory.mkdir()) throw new IOException("无法准备更新网络缓存。");
            configuration = new File(directory, "config.yaml");
            writePrivate(configuration, new Yaml().dump(UpdateProxyPolicy.configuration(nodes, proxyPort, controllerPort,
                    username, password, secret)).getBytes(StandardCharsets.UTF_8));
        }
        File executable = new File(activity.getApplicationInfo().nativeLibraryDir, "libbrclio_update_proxy.so");
        File launcher = new File(activity.getApplicationInfo().nativeLibraryDir, "libbrclio_update_proxy_launcher.so");
        if (!executable.isFile() || !executable.canExecute() || !launcher.isFile() || !launcher.canExecute()) {
            throw new IOException("此安装包缺少当前设备的更新网络组件，请重新安装完整版本。");
        }
        check();
        synchronized (this) {
            check();
            if (systemRoute.enabled()) return useSystemClient();
            process = new ProcessBuilder(launcher.getAbsolutePath(), executable.getAbsolutePath(), "-d", directory.getAbsolutePath(),
                    "-f", configuration.getAbsolutePath()).redirectErrorStream(true).start();
        }
        final Process started = process;
        Thread discard = new Thread(() -> {
            try (InputStream input = started.getInputStream()) {
                byte[] bytes = new byte[4096];
                while (input.read(bytes) != -1) { /* Never log subscriptions or node credentials. */ }
            } catch (IOException ignored) { }
        }, "brclio-update-proxy-output");
        discard.setDaemon(true);
        discard.start();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12);
        boolean ready = false;
        while (System.nanoTime() < deadline) {
            check();
            if (!started.isAlive()) throw new IOException("更新网络组件未能启动，请稍后重试。");
            try { controller("GET", "/version", null, 500); ready = true; break; }
            catch (IOException failure) {
                try { Thread.sleep(80); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); check(); }
            }
        }
        if (!ready) throw new IOException("更新网络组件启动超时，请重试。");
        selectFastest(nodes);
        check();
        String authorization = Credentials.basic(username, password);
        synchronized (this) {
            check();
            client = client.newBuilder()
                .proxy(new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", proxyPort)))
                .proxyAuthenticator((route, response) -> {
                    if (response.request().header("Proxy-Authorization") != null) return null;
                    return response.request().newBuilder().header("Proxy-Authorization", authorization).build();
                }).build();
            internal = true;
        }
        return client;
    }

    static OkHttpClient directClient() {
        return new OkHttpClient.Builder().proxy(Proxy.NO_PROXY)
                .followRedirects(false).followSslRedirects(false)
                .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
                .retryOnConnectionFailure(false).build();
    }

    /** Leaving proxy unset preserves Android's ProxySelector, PAC rules and active VPN. */
    static OkHttpClient systemClient() {
        return new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
                .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
                .retryOnConnectionFailure(false).build();
    }

    private synchronized OkHttpClient useSystemClient() throws IOException {
        check();
        client = systemClient();
        return client;
    }

    private JSONObject newestConfiguration(Activity activity) throws IOException {
        File cache = new File(activity.getNoBackupFilesDir(), "update-proxy-config.json");
        try {
            byte[] bytes = request(CONFIG_URI, "POST", "{\"action\":\"update-proxy-config\"}".getBytes(StandardCharsets.UTF_8), 65536, 8000);
            JSONObject current = UpdateProxyConfiguration.validate(
                    new JSONObject(new String(bytes, StandardCharsets.UTF_8)).getJSONObject("proxyConfig"));
            check();
            return CONFIGURATION.accept(current, cache);
        } catch (Exception unavailable) {
            check();
            return CONFIGURATION.fallback(cache);
        }
    }

    private byte[] fetchSubscription(URI initial) throws IOException {
        URI uri = initial;
        for (int index = 0; index <= 3; index++) {
            check();
            HttpURLConnection connection = connect(uri, 10000);
            try {
                connection.setRequestProperty("Accept", "application/yaml, text/yaml, text/plain");
                connection.setRequestProperty("User-Agent", "clash.meta");
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || index == 3) throw UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.URL);
                    try { uri = UpdateProxyPolicy.subscriptionUri(uri.resolve(location).toString()); }
                    catch (IllegalArgumentException invalid) { throw UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.URL); }
                    continue;
                }
                if (status != 200) throw UpdateSubscriptionRetry.Failure.http(status, connection.getHeaderField("Retry-After"));
                try (InputStream input = connection.getInputStream()) { return readChecked(input, UpdateProxyPolicy.MAX_SUBSCRIPTION_BYTES); }
            } finally { detach(connection); }
        }
        throw UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.URL);
    }

    private static final class Delay {
        final String name;
        final int milliseconds;
        Delay(String name, int milliseconds) { this.name = name; this.milliseconds = milliseconds; }
    }

    private void selectFastest(List<Map<String, Object>> nodes) throws IOException {
        List<Future<Delay>> pending = new ArrayList<>();
        UpdateSubscriptionRetry.Diagnostics failures = new UpdateSubscriptionRetry.Diagnostics();
        for (Map<String, Object> node : nodes) {
            String name = (String) node.get("name");
            pending.add(probes.submit(() -> {
                check();
                try {
                    byte[] result = controller("GET", "/proxies/" + encode(name) + "/delay?timeout=6000&expected=200&url="
                            + encode(UpdateProxyPolicy.PROBE_URL), null, 8000);
                    int delay = new JSONObject(new String(result, StandardCharsets.UTF_8)).optInt("delay", -1);
                    if (delay >= 0 && delay <= 6000) return new Delay(name, delay);
                    failures.add(UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.PROBE_NO_DELAY));
                    return null;
                } catch (Exception unavailable) { check(); failures.add(UpdateSubscriptionRetry.classify(unavailable)); return null; }
            }));
        }
        List<Delay> successful = new ArrayList<>();
        for (Future<Delay> probe : pending) {
            check();
            try {
                Delay delay;
                while (true) {
                    check();
                    try { delay = probe.get(200, TimeUnit.MILLISECONDS); break; }
                    catch (TimeoutException pendingProbe) { /* Keep cancellation and the job deadline responsive. */ }
                }
                if (delay != null) successful.add(delay);
            }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException("更新网络检查已取消。"); }
            catch (ExecutionException failed) { check(); }
        }
        if (successful.isEmpty()) throw new IOException("订阅中的代理节点均不可用（" + failures.summary() + "），请联系管理员或稍后重试。");
        successful.sort(Comparator.comparingInt(value -> value.milliseconds));
        ranked.clear();
        ranked.addAll(successful);
        selectedIndex = 0;
        select(successful.get(0).name);
    }

    /** Try the next fastest measured node if GitHub rejects an exit or a connection fails. */
    boolean selectNext() throws IOException {
        check();
        if (selectedIndex + 1 >= ranked.size()) return false;
        selectedIndex++;
        select(ranked.get(selectedIndex).name);
        OkHttpClient current = client;
        if (current != null) current.connectionPool().evictAll();
        return true;
    }

    private void select(String name) throws IOException {
        try {
            JSONObject choice = new JSONObject().put("name", name);
            controller("PUT", "/proxies/" + UpdateProxyPolicy.GROUP, choice.toString().getBytes(StandardCharsets.UTF_8), 3000);
        } catch (org.json.JSONException impossible) { throw new IOException("更新网络选择失败。"); }
    }

    private byte[] controller(String method, String path, byte[] body, int timeout) throws IOException {
        return request(URI.create("http://127.0.0.1:" + controllerPort + path), method, body, 65536, timeout);
    }

    private byte[] request(URI uri, String method, byte[] body, int maximum, int timeout) throws IOException {
        check();
        HttpURLConnection connection = connect(uri, timeout);
        try {
            connection.setRequestMethod(method);
            if (uri.getHost().equals("127.0.0.1")) connection.setRequestProperty("Authorization", "Bearer " + secret);
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(body.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
            }
            int status = connection.getResponseCode();
            if (status != 200 && status != 204) throw UpdateSubscriptionRetry.Failure.http(status, null);
            if (status == 204) return new byte[0];
            try (InputStream input = connection.getInputStream()) { return readChecked(input, maximum); }
        } finally { detach(connection); }
    }

    private HttpURLConnection connect(URI uri, int timeout) throws IOException {
        check();
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection(Proxy.NO_PROXY);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(timeout);
        connection.setReadTimeout(timeout);
        connection.setRequestProperty("User-Agent", "Brclio-Update/" + BuildConfig.VERSION_NAME);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connections.add(connection);
        try { check(); return connection; }
        catch (IOException cancelled) { detach(connection); throw cancelled; }
    }

    private void detach(HttpURLConnection connection) { connections.remove(connection); connection.disconnect(); }

    private byte[] readChecked(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        byte[] bytes = new byte[16384];
        int count;
        while ((count = input.read(bytes)) != -1) {
            check();
            if (result.size() + count > maximum) throw UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.FORMAT);
            result.write(bytes, 0, count);
        }
        return result.toByteArray();
    }

    private static byte[] read(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        byte[] bytes = new byte[8192];
        int count;
        while ((count = input.read(bytes)) != -1) {
            if (result.size() + count > maximum) throw new IOException("Update configuration is too large");
            result.write(bytes, 0, count);
        }
        return result.toByteArray();
    }

    private void check() throws IOException {
        check.run();
        if (closed) throw new IOException("更新操作已取消。");
        Process running = process;
        if (running != null && !running.isAlive()) throw new IOException("更新网络组件已停止，请重试。");
    }

    private static String encode(String value) {
        try { return URLEncoder.encode(value, "UTF-8").replace("+", "%20"); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new IllegalStateException(impossible); }
    }

    private static int unusedPort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) { return socket.getLocalPort(); }
    }

    private static void writePrivate(File file, byte[] bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); output.getFD().sync(); }
        file.setReadable(false, false);
        file.setWritable(false, false);
        if (!file.setReadable(true, true) || !file.setWritable(true, true)) throw new IOException("无法保存更新网络配置。");
    }

    @Override public void close() {
        OkHttpClient ownedClient;
        synchronized (this) {
            closed = true;
            try {
                if (process != null) process.destroy();
            } finally {
                if (process != null && process.isAlive()) process.destroyForcibly();
            }
            if (cleanupScheduled) return;
            cleanupScheduled = true;
            ownedClient = client;
        }
        probes.shutdownNow();
        UpdateNetworkCleanup.start(() -> {
            try {
                for (HttpURLConnection connection : connections) {
                    try { connection.disconnect(); } catch (RuntimeException ignored) { }
                }
                connections.clear();
                if (ownedClient != null) {
                    try { ownedClient.dispatcher().cancelAll(); }
                    finally {
                        try { ownedClient.connectionPool().evictAll(); }
                        finally { ownedClient.dispatcher().executorService().shutdownNow(); }
                    }
                }
            } finally { remove(directory); }
        });
    }

    private static void remove(File file) {
        if (file == null) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        file.delete();
    }

    static void clearPreviousSessions(File cacheDirectory) { remove(new File(cacheDirectory, "update-proxy")); }
}
