package com.brclio.xhs;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.ProxyInfo;

import java.net.Proxy;
import java.net.ProxySelector;
import java.net.URI;
import java.util.List;

/** Reads Android networking state; it never changes proxy, VPN, or device settings. */
final class UpdateSystemProxy {
    private UpdateSystemProxy() { }

    static boolean enabled(Context context) {
        try {
            ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
            if (manager != null) {
                ProxyInfo proxy = manager.getDefaultProxy();
                if (proxy != null && configured(proxy.getHost(), proxy.getPort(),
                        proxy.getPacFileUrl() == null ? "" : proxy.getPacFileUrl().toString())) return true;
                Network network = manager.getBoundNetworkForProcess();
                if (network == null) network = manager.getActiveNetwork();
                NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
                if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true;
            }
        } catch (RuntimeException unavailable) { /* The normal permission may be unavailable on a custom ROM. */ }
        try {
            ProxySelector selector = ProxySelector.getDefault();
            if (selector != null) {
                for (String url : new String[] { UpdatePolicy.RELEASES_API,
                        "https://github.com/", "https://release-assets.githubusercontent.com/" }) {
                    if (hasProxy(selector.select(URI.create(url)))) return true;
                }
            }
        } catch (RuntimeException unavailable) { /* A failing selector is not proof of an enabled proxy. */ }
        return false;
    }

    static boolean configured(String host, int port, String pacUrl) {
        return pacUrl != null && !pacUrl.trim().isEmpty()
                || host != null && !host.trim().isEmpty() && port > 0 && port <= 65535;
    }

    static boolean hasProxy(List<Proxy> routes) {
        if (routes == null) return false;
        for (Proxy route : routes) {
            if (route != null && route.type() != Proxy.Type.DIRECT) return true;
        }
        return false;
    }
}
