package com.brclio.xhs;

import org.junit.Test;

import java.io.IOException;
import java.net.Proxy;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class UpdateCheckNetworkTest {
    @Test public void directSuccessNeverPreparesAnotherRoute() throws Exception {
        assertEquals("latest", UpdateCheckNetwork.run(() -> "latest", () -> {
            fail("Successful direct metadata must not prepare proxy configuration or subscriptions");
            return null;
        }, () -> { }, () -> { fail("No fallback decision is needed on success"); return true; }));
    }

    @Test public void transportFailureFallsBackExactlyOnce() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        assertEquals("available", UpdateCheckNetwork.run(() -> {
            requests.incrementAndGet();
            throw new UpdateCheckNetwork.Failure("connection unavailable");
        }, () -> { requests.incrementAndGet(); return "available"; }, () -> { }, () -> true));
        assertEquals(2, requests.get());
    }

    @Test public void manualOffPreventsFallbackAfterDirectFailure() throws Exception {
        UpdateCheckNetwork.Failure unavailable = new UpdateCheckNetwork.Failure("rate limited");
        try {
            UpdateCheckNetwork.run(() -> { throw unavailable; }, () -> {
                fail("Manual off must not start the bundled proxy"); return null;
            }, () -> { }, () -> false);
            fail("Expected original network failure");
        } catch (IOException failure) { assertSame(unavailable, failure); }
    }

    @Test public void cancellationBetweenRoutesPreventsFallback() throws Exception {
        IOException cancelled = new IOException("cancelled");
        try {
            UpdateCheckNetwork.run(() -> { throw new UpdateCheckNetwork.Failure("timeout"); }, () -> {
                fail("A cancelled check must not start another connection"); return null;
            }, () -> { throw cancelled; }, () -> true);
            fail("Expected cancellation");
        } catch (IOException failure) { assertSame(cancelled, failure); }
    }

    @Test public void invalidMetadataAndSecurityFailuresDoNotFallBack() throws Exception {
        for (IOException invalid : new IOException[] { new IOException("invalid metadata"),
                new javax.net.ssl.SSLHandshakeException("untrusted certificate") }) {
            try {
                UpdateCheckNetwork.run(() -> { throw invalid; }, () -> {
                    fail("Changing network routes must not bypass invalid metadata or TLS validation"); return null;
                }, () -> { }, () -> true);
                fail("Expected validation failure");
            } catch (IOException failure) { assertSame(invalid, failure); }
        }
    }

    @Test public void directClientExplicitlyBypassesSystemHttpProxy() {
        assertEquals(Proxy.NO_PROXY, UpdateProxySession.directClient().proxy());
        assertNull(UpdateProxySession.systemClient().proxy());
    }
}
