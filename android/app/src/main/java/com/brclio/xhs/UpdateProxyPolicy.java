package com.brclio.xhs;

import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

import java.net.URI;
import java.net.InetAddress;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Remote subscriptions supply node credentials only, never routing, listeners, files or code. */
final class UpdateProxyPolicy {
    static final String GROUP = "BRCLIO_UPDATE";
    static final String PROBE_URL = "https://api.github.com/zen";
    static final int MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
    static final int MAX_NODES = 256;
    static final int MAX_SUBSCRIPTIONS = 8;
    private static final Set<String> TYPES = new HashSet<>(Arrays.asList(
            "ss", "ssr", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "http", "socks5", "snell", "anytls"));
    private static final Set<String> FIELDS = new HashSet<>(Arrays.asList(
            "type", "server", "port", "password", "cipher", "uuid", "alterId", "network", "tls", "servername",
            "sni", "client-fingerprint", "fingerprint", "alpn", "flow", "reality-opts", "ws-opts", "grpc-opts",
            "h2-opts", "http-opts", "tfo", "udp-over-tcp", "up", "down", "obfs", "obfs-password", "protocol",
            "protocol-param", "obfs-param", "plugin", "plugin-opts", "token", "username", "version", "ip",
            "reduce-rtt", "request-timeout", "udp-relay-mode", "congestion-controller", "heartbeat-interval",
            "disable-sni", "fast-open", "recv-window-conn", "recv-window", "hop-interval", "ports"));

    private UpdateProxyPolicy() {}

    static URI subscriptionUri(String value) {
        try {
            if (value == null || value.length() > 4096 || value.contains("\\")) throw new URISyntaxException("", "Invalid subscription");
            URI uri = new URI(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getRawFragment() != null || uri.getHost().endsWith(".")
                    || uri.getPort() == 0 || uri.getPort() > 65535) throw new URISyntaxException("", "Invalid subscription");
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
            if (!publicNodeServer(host)) throw new URISyntaxException("", "Invalid public endpoint");
            return uri;
        } catch (URISyntaxException invalid) { throw new IllegalArgumentException("订阅地址必须使用公开的 HTTPS 地址。"); }
    }

    static List<String> subscriptionUrls(List<String> plural, String legacy, boolean enabled) {
        List<String> values = plural != null ? plural : legacy == null || legacy.isEmpty()
                ? new ArrayList<>() : Arrays.asList(legacy);
        if (values.size() > MAX_SUBSCRIPTIONS) throw new IllegalArgumentException("更新订阅最多支持 8 个来源。");
        List<String> result = new ArrayList<>();
        for (String value : values) {
            if (value == null) throw new IllegalArgumentException("更新订阅地址无效。");
            String url = subscriptionUri(value.trim()).toString();
            if (!result.contains(url)) result.add(url);
        }
        if (enabled && result.isEmpty()) throw new IllegalArgumentException("更新代理缺少订阅来源。");
        return result;
    }

    static List<Map<String, Object>> mergeNodes(List<List<Map<String, Object>>> sources) {
        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (List<Map<String, Object>> source : sources) {
            for (Map<String, Object> node : source) {
                Map<String, Object> copy = new LinkedHashMap<>(node);
                copy.remove("name");
                if (!seen.add(new Yaml().dump(copy))) continue;
                if (result.size() >= MAX_NODES * MAX_SUBSCRIPTIONS) throw new IllegalArgumentException("更新订阅的合并节点数量过多。");
                copy.put("name", "brclio-node-" + (result.size() + 1));
                result.add(copy);
            }
        }
        return result;
    }

    static List<Map<String, Object>> nodes(String subscription) {
        LoaderOptions options = new LoaderOptions();
        options.setAllowDuplicateKeys(false);
        options.setMaxAliasesForCollections(0);
        options.setCodePointLimit(MAX_SUBSCRIPTION_BYTES);
        options.setNestingDepthLimit(16);
        Object loaded;
        try { loaded = new Yaml(new SafeConstructor(options)).load(subscription); }
        catch (RuntimeException invalid) { throw new IllegalArgumentException("更新订阅不是有效的 Clash YAML 配置。"); }
        if (!(loaded instanceof Map)) throw new IllegalArgumentException("更新订阅不是有效的 Clash YAML 配置。");
        Object proxies = ((Map<?, ?>) loaded).get("proxies");
        if (!(proxies instanceof List) || ((List<?>) proxies).isEmpty() || ((List<?>) proxies).size() > MAX_NODES) {
            throw new IllegalArgumentException("更新订阅的节点数量无效。");
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object entry : (List<?>) proxies) {
            if (!(entry instanceof Map)) continue;
            Map<?, ?> node = (Map<?, ?>) entry;
            Object type = node.get("type");
            Object server = node.get("server");
            Object port = node.get("port");
            if (!(type instanceof String) || !TYPES.contains(type)
                    || !(server instanceof String) || ((String) server).length() > 253
                    || !((String) server).matches("[A-Za-z0-9.:-]+")
                    || !publicNodeServer((String) server)
                    || !(port instanceof Number) || ((Number) port).doubleValue() != ((Number) port).intValue()
                    || ((Number) port).intValue() < 1 || ((Number) port).intValue() > 65535) continue;
            Map<String, Object> safe = new LinkedHashMap<>();
            for (String field : FIELDS) {
                if (node.containsKey(field)) safe.put(field, copyValue(node.get(field), 0));
            }
            safe.put("name", "brclio-node-" + (result.size() + 1));
            safe.put("port", ((Number) port).intValue());
            safe.put("udp", false);
            safe.put("skip-cert-verify", false);
            result.add(safe);
        }
        if (result.isEmpty()) throw new IllegalArgumentException("更新订阅没有受支持的代理节点。");
        return result;
    }

    private static boolean publicNodeServer(String server) {
        String lower = server.toLowerCase(Locale.ROOT);
        if (lower.equals("localhost") || lower.endsWith(".localhost") || lower.endsWith(".local")
                || lower.endsWith(".internal") || lower.endsWith(".lan")) return false;
        if (lower.indexOf(':') >= 0 || lower.matches("[0-9.]+")) {
            try {
                InetAddress address = InetAddress.getByName(lower);
                return !(address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                        || address.isSiteLocalAddress() || address.isMulticastAddress()
                        || (address.getAddress().length == 4 && ((address.getAddress()[0] & 255) == 0
                        || (address.getAddress()[0] & 255) >= 224))
                        || (address.getAddress().length == 4 && (address.getAddress()[0] & 255) == 100
                        && (address.getAddress()[1] & 255) >= 64 && (address.getAddress()[1] & 255) <= 127)
                        || (address.getAddress().length == 16 && (address.getAddress()[0] & 254) == 252));
            } catch (Exception invalid) { return false; }
        }
        return lower.indexOf('.') > 0;
    }

    private static Object copyValue(Object value, int depth) {
        if (depth > 8) throw new IllegalArgumentException("更新订阅的节点配置过深。");
        if (value == null || value instanceof Boolean || value instanceof Number) return value;
        if (value instanceof String) {
            if (((String) value).length() > 8192) throw new IllegalArgumentException("更新订阅的节点参数过长。");
            return value;
        }
        if (value instanceof List) {
            if (((List<?>) value).size() > 128) throw new IllegalArgumentException("更新订阅的节点参数过多。");
            List<Object> copy = new ArrayList<>();
            for (Object item : (List<?>) value) copy.add(copyValue(item, depth + 1));
            return copy;
        }
        if (value instanceof Map) {
            if (((Map<?, ?>) value).size() > 128) throw new IllegalArgumentException("更新订阅的节点参数过多。");
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> item : ((Map<?, ?>) value).entrySet()) {
                if (!(item.getKey() instanceof String) || ((String) item.getKey()).length() > 128) {
                    throw new IllegalArgumentException("更新订阅的节点参数无效。");
                }
                copy.put((String) item.getKey(), copyValue(item.getValue(), depth + 1));
            }
            return copy;
        }
        throw new IllegalArgumentException("更新订阅的节点参数无效。");
    }

    static Map<String, Object> configuration(List<Map<String, Object>> nodes, int port, int controller,
                                              String username, String password, String secret) {
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("mixed-port", port);
        config.put("allow-lan", false);
        config.put("bind-address", "127.0.0.1");
        config.put("authentication", Arrays.asList(username + ":" + password));
        // Mihomo otherwise exempts all loopback requests from authentication by default.
        config.put("skip-auth-prefixes", new ArrayList<>());
        config.put("external-controller", "127.0.0.1:" + controller);
        config.put("secret", secret);
        config.put("mode", "rule");
        config.put("log-level", "silent");
        config.put("ipv6", false);
        config.put("find-process-mode", "off");
        config.put("geodata-loader", "memconservative");
        config.put("geo-auto-update", false);
        config.put("tun", singleton("enable", false));
        config.put("dns", singleton("enable", false));
        config.put("profile", singleton("store-selected", false));
        config.put("proxies", nodes);
        List<String> names = new ArrayList<>();
        for (Map<String, Object> node : nodes) names.add((String) node.get("name"));
        Map<String, Object> group = new LinkedHashMap<>();
        group.put("name", GROUP);
        group.put("type", "select");
        group.put("proxies", names);
        config.put("proxy-groups", Arrays.asList(group));
        List<String> rules = new ArrayList<>();
        for (String host : Arrays.asList("api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")) {
            rules.add("AND,((DOMAIN," + host + "),(DST-PORT,443))," + GROUP);
        }
        rules.add("MATCH,REJECT");
        config.put("rules", rules);
        return config;
    }

    private static Map<String, Object> singleton(String key, Object value) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put(key, value);
        return result;
    }
}
