package com.brclio.xhs;

import org.junit.Test;

import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.util.Arrays;
import java.util.Collections;

import okhttp3.OkHttpClient;

import static org.junit.Assert.*;

public class UpdateSystemProxyTest {
    @Test public void detectsConfiguredHttpOrPacButRejectsDisabledSettings() {
        assertTrue(UpdateSystemProxy.configured("127.0.0.1", 7890, ""));
        assertTrue(UpdateSystemProxy.configured("", -1, "https://example.com/network.pac"));
        assertFalse(UpdateSystemProxy.configured("", 0, ""));
        assertFalse(UpdateSystemProxy.configured("  ", 7890, null));
        assertFalse(UpdateSystemProxy.configured("proxy.example", 0, ""));
        assertFalse(UpdateSystemProxy.configured("proxy.example", 65536, ""));
    }

    @Test public void ignoresDirectAndNullRoutesButAcceptsHttpAndSocks() {
        assertFalse(UpdateSystemProxy.hasProxy(null));
        assertFalse(UpdateSystemProxy.hasProxy(Arrays.asList(null, Proxy.NO_PROXY)));
        assertTrue(UpdateSystemProxy.hasProxy(Arrays.asList(Proxy.NO_PROXY,
                new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", 7890)))));
        assertTrue(UpdateSystemProxy.hasProxy(Collections.singletonList(
                new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", 1080)))));
    }

    @Test public void externalNetworkClientRetainsTheSystemSelectorWithoutForcingDirect() {
        ProxySelector system = ProxySelector.getDefault();
        OkHttpClient client = UpdateProxySession.systemClient();
        assertNull(client.proxy());
        assertSame(system, client.proxySelector());
        assertFalse(client.followRedirects());
        assertFalse(client.followSslRedirects());
        assertFalse(client.retryOnConnectionFailure());
    }
}
