package com.brclio.xhs;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import java.net.URI;
import org.junit.Test;

public class SoftwareAccountPagePolicyTest {
    @Test public void reviewsAndOrdersUseOnlyTheOfficialBrowserPagesWithoutCredentials() {
        URI reviews = SoftwareAccountPagePolicy.pageUri("reviews");
        URI orders = SoftwareAccountPagePolicy.pageUri("orders");
        assertEquals("https://xhs.download.brclio.com/#software-reviews", reviews.toString());
        assertEquals("https://xhs.download.brclio.com/?account=orders", orders.toString());
        for (URI page : new URI[] {reviews, orders}) {
            assertEquals("https", page.getScheme());
            assertEquals("xhs.download.brclio.com", page.getHost());
            assertEquals("/", page.getPath());
            assertEquals(-1, page.getPort());
            assertNull(page.getUserInfo());
        }
        assertNull(reviews.getQuery());
        assertEquals("software-reviews", reviews.getFragment());
        assertEquals("account=orders", orders.getQuery());
        assertNull(orders.getFragment());
    }

    @Test public void nativeAccountEntryRejectsArbitraryUrlsCredentialsAndAmbiguousPageNames() {
        for (String page : new String[] {null, "", "Reviews", "orders ", "../orders", "admin", "login",
                "reviews?token=private", "orders#private", "?account=orders", "#software-reviews",
                "https://attacker.example/", "javascript:alert(1)", "file:///private/account.json",
                "https://xhs.download.brclio.com/?account=orders&token=private"}) {
            assertThrows(String.valueOf(page), IllegalArgumentException.class,
                    () -> SoftwareAccountPagePolicy.pageUri(page));
        }
    }
}
