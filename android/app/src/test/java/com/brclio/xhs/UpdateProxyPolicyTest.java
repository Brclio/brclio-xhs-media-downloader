package com.brclio.xhs;

import static org.junit.Assert.*;

import org.junit.Test;

import java.util.List;
import java.util.Map;
import java.util.Arrays;
import java.util.Collections;

public class UpdateProxyPolicyTest {
    private static final String NODE = "proxies:\n  - name: remote-name\n    type: vless\n    server: node.example.com\n    port: 443\n    uuid: 11111111-2222-3333-4444-555555555555\n    tls: true\n    network: ws\n    ws-opts:\n      path: /ws\n      headers:\n        Host: node.example.com\n";

    @Test public void remoteListenersRoutingAndFileOptionsCannotReachGeneratedConfiguration() {
        List<Map<String, Object>> nodes = UpdateProxyPolicy.nodes(NODE
                + "    dialer-proxy: DIRECT\n    interface-name: lo\n    certificate: /private/file\n    skip-cert-verify: true\n"
                + "tun:\n  enable: true\nexternal-controller: 0.0.0.0:9090\nproxy-providers:\n  malicious:\n    url: https://evil.example.com\n"
                + "rules:\n  - MATCH,DIRECT\n");
        Map<String, Object> node = nodes.get(0);
        assertEquals("brclio-node-1", node.get("name"));
        assertEquals(Boolean.FALSE, node.get("skip-cert-verify"));
        assertEquals(Boolean.FALSE, node.get("udp"));
        assertFalse(node.containsKey("dialer-proxy"));
        assertFalse(node.containsKey("interface-name"));
        assertFalse(node.containsKey("certificate"));
        assertTrue(node.containsKey("ws-opts"));
        Map<String, Object> generated = UpdateProxyPolicy.configuration(nodes, 31001, 31002, "local", "password", "secret");
        assertEquals("127.0.0.1", generated.get("bind-address"));
        assertEquals("127.0.0.1:31002", generated.get("external-controller"));
        assertEquals(Boolean.FALSE, ((Map<?, ?>) generated.get("tun")).get("enable"));
        assertEquals(Boolean.FALSE, ((Map<?, ?>) generated.get("dns")).get("enable"));
        assertFalse(generated.containsKey("proxy-providers"));
        assertEquals(0, ((List<?>) generated.get("skip-auth-prefixes")).size());
        List<?> rules = (List<?>) generated.get("rules");
        assertTrue(rules.contains("AND,((DOMAIN,api.github.com),(DST-PORT,443)),BRCLIO_UPDATE"));
        assertEquals("MATCH,REJECT", rules.get(rules.size() - 1));
    }

    @Test public void unsafeYamlTagsAliasesAndDuplicateKeysAreRejected() {
        assertThrows(IllegalArgumentException.class, () -> UpdateProxyPolicy.nodes("!!java.net.URL [https://evil.example.com]"));
        assertThrows(IllegalArgumentException.class, () -> UpdateProxyPolicy.nodes("proxies: &nodes []\nproxies: *nodes\n"));
        assertThrows(IllegalArgumentException.class, () -> UpdateProxyPolicy.nodes(NODE + "    port: 80\n"));
    }

    @Test public void nodeEndpointsCannotUseLocalNetworkOrUnexpectedProtocols() {
        for (String host : new String[]{"localhost", "127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "100.64.1.1", "::1", "fc00::1", "router.lan"}) {
            assertThrows(host, IllegalArgumentException.class, () -> UpdateProxyPolicy.nodes(NODE.replace("server: node.example.com", "server: '" + host + "'")));
        }
        assertThrows(IllegalArgumentException.class, () -> UpdateProxyPolicy.nodes(NODE.replace("type: vless", "type: wireguard")));
        assertEquals("vless", UpdateProxyPolicy.nodes(NODE.replace("server: node.example.com", "server: 8.8.8.8")).get(0).get("type"));
    }

    @Test public void subscriptionRequiresPublicHttpsWithoutCredentialsOrFragments() {
        assertEquals("subscription.example.com", UpdateProxyPolicy.subscriptionUri("https://subscription.example.com/sub?token=fixture").getHost());
        assertEquals(8443, UpdateProxyPolicy.subscriptionUri("https://subscription.example.com:8443/sub").getPort());
        for (String uri : new String[]{"http://subscription.example.com/sub", "https://127.0.0.1/sub", "https://localhost/sub", "https://router.local/sub", "https://router.internal/sub", "https://user:pass@subscription.example.com/sub", "https://subscription.example.com:0/sub", "https://subscription.example.com/sub#token"}) {
            assertThrows(uri, IllegalArgumentException.class, () -> UpdateProxyPolicy.subscriptionUri(uri));
        }
    }

    @Test public void subscriptionsMergeUniqueNodesAndPreserveLegacyConfigurations() {
        List<String> urls = Arrays.asList("https://first.example.com/sub", "https://second.example.com/sub", "https://first.example.com/sub");
        assertEquals(2, UpdateProxyPolicy.subscriptionUrls(urls, "https://legacy.example.com/sub", true).size());
        assertEquals(Collections.singletonList("https://legacy.example.com/sub"), UpdateProxyPolicy.subscriptionUrls(null, "https://legacy.example.com/sub", true));
        assertTrue(UpdateProxyPolicy.subscriptionUrls(Collections.emptyList(), "https://legacy.example.com/sub", false).isEmpty());
        assertThrows(IllegalArgumentException.class, () -> UpdateProxyPolicy.subscriptionUrls(Collections.emptyList(), null, true));
        assertThrows(IllegalArgumentException.class, () -> UpdateProxyPolicy.subscriptionUrls(Collections.nCopies(9, "https://first.example.com/sub"), null, true));
        List<Map<String, Object>> combined = UpdateProxyPolicy.mergeNodes(Arrays.asList(UpdateProxyPolicy.nodes(NODE),
                UpdateProxyPolicy.nodes(NODE), UpdateProxyPolicy.nodes(NODE.replace("node.example.com", "second.example.com"))));
        assertEquals(2, combined.size());
        assertEquals("brclio-node-1", combined.get(0).get("name"));
        assertEquals("brclio-node-2", combined.get(1).get("name"));
    }

    @Test public void emojiAtReaderChunkBoundaryDoesNotDiscardAnOtherwiseValidSubscription() {
        String prefix = "#" + "x".repeat(1022) + "\uD83C\uDDFA\uD83C\uDDF8\n";
        assertEquals(1, UpdateProxyPolicy.nodes(prefix + NODE).size());
    }
}
