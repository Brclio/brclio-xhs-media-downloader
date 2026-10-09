package com.brclio.xhs;

import java.net.URI;

/** Software accounts stay in the system browser; native callers select a fixed page only. */
final class SoftwareAccountPagePolicy {
    private SoftwareAccountPagePolicy() {}

    static URI pageUri(String page) {
        if ("reviews".equals(page)) return URI.create("https://xhs.download.brclio.com/#software-reviews");
        if ("orders".equals(page)) return URI.create("https://xhs.download.brclio.com/?account=orders");
        throw new IllegalArgumentException("请选择软件评价或我的订单。");
    }
}
