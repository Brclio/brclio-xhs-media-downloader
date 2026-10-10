package com.brclio.xhs;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.*;

public class UpdateProxyReadinessTest {
    private static final List<String> NAMES = Arrays.asList("brclio-node-1", "brclio-node-2");

    private static JSONObject group(List<String> names) throws Exception {
        return new JSONObject().put("name", UpdateProxyPolicy.GROUP).put("type", "Selector")
                .put("all", new JSONArray(names));
    }

    @Test public void listenerReadyBeforeProxiesDoesNotStartProbes() throws Exception {
        AtomicLong clock = new AtomicLong();
        AtomicInteger requests = new AtomicInteger();
        AtomicInteger probes = new AtomicInteger();
        JSONObject partial = group(Arrays.asList(NAMES.get(0)));
        JSONObject complete = group(NAMES);
        UpdateProxyReadiness.await(NAMES, timeout -> {
            assertEquals(0, probes.get());
            assertTrue(timeout > 0 && timeout <= TimeUnit.MILLISECONDS.toNanos(500));
            switch (requests.incrementAndGet()) {
                case 1: throw UpdateSubscriptionRetry.Failure.http(404, null);
                case 2: return new JSONObject(); // /version could already have returned HTTP 200.
                case 3: return partial;
                default: return complete;
            }
        }, () -> { }, clock::get, clock::addAndGet, TimeUnit.SECONDS.toNanos(12));
        probes.incrementAndGet();
        assertEquals(4, requests.get());
        assertEquals(TimeUnit.MILLISECONDS.toNanos(240), clock.get());
        assertEquals(1, probes.get());
    }

    @Test public void readinessRequiresExactGroupTypeAndCompleteUniqueNodeMembership() throws Exception {
        assertTrue(UpdateProxyReadiness.configured(group(Arrays.asList(NAMES.get(1), NAMES.get(0))), NAMES));
        assertFalse(UpdateProxyReadiness.configured(group(NAMES).put("name", "OTHER"), NAMES));
        assertFalse(UpdateProxyReadiness.configured(group(NAMES).put("type", "Direct"), NAMES));
        assertFalse(UpdateProxyReadiness.configured(group(Arrays.asList(NAMES.get(0), NAMES.get(0))), NAMES));
        assertFalse(UpdateProxyReadiness.configured(group(Arrays.asList(NAMES.get(0), "unknown")), NAMES));
        assertFalse(UpdateProxyReadiness.configured(group(NAMES).put("all", new JSONArray().put(1).put(2)), NAMES));
        assertFalse(UpdateProxyReadiness.configured(group(NAMES).put("all", new JSONArray()), NAMES));
    }

    @Test public void startupDeadlineIncludesRequestsAndCapsLastPoll() throws Exception {
        AtomicLong clock = new AtomicLong();
        List<Long> budgets = new ArrayList<>();
        try {
            UpdateProxyReadiness.await(NAMES, timeout -> {
                budgets.add(timeout);
                clock.addAndGet(timeout);
                throw new IOException("controller not configured");
            }, () -> { }, clock::get, clock::addAndGet, TimeUnit.MILLISECONDS.toNanos(600));
            fail("Expected bounded startup timeout");
        } catch (IOException timeout) { assertTrue(timeout.getMessage().contains("启动超时")); }
        assertEquals(Arrays.asList(TimeUnit.MILLISECONDS.toNanos(500), TimeUnit.MILLISECONDS.toNanos(20)), budgets);
        assertEquals(TimeUnit.MILLISECONDS.toNanos(600), clock.get());
    }

    @Test public void responseArrivingAtDeadlineCannotStartProbes() throws Exception {
        AtomicLong clock = new AtomicLong();
        JSONObject complete = group(NAMES);
        try {
            UpdateProxyReadiness.await(NAMES, timeout -> {
                clock.addAndGet(timeout);
                return complete;
            }, () -> { }, clock::get, clock::addAndGet, TimeUnit.MILLISECONDS.toNanos(10));
            fail("Expired readiness must not be accepted");
        } catch (IOException timeout) { assertTrue(timeout.getMessage().contains("启动超时")); }
    }

    @Test public void fractionalMillisecondBudgetTimesOutBeforeOpeningAnotherCall() throws Exception {
        try {
            UpdateProxyReadiness.await(NAMES, timeout -> {
                fail("OkHttp cannot accept a submillisecond timeout"); return null;
            }, () -> { }, () -> 0, duration -> fail("An exhausted budget must not sleep"),
                    TimeUnit.MICROSECONDS.toNanos(999));
            fail("Expected startup timeout");
        } catch (IOException timeout) { assertTrue(timeout.getMessage().contains("启动超时")); }
    }

    @Test public void cancellationAfterControllerFailureSkipsSleepAndRetry() throws Exception {
        AtomicLong clock = new AtomicLong();
        AtomicInteger checks = new AtomicInteger();
        IOException cancelled = new IOException("cancelled");
        try {
            UpdateProxyReadiness.await(NAMES, timeout -> { throw new IOException("HTTP 404"); }, () -> {
                if (checks.incrementAndGet() == 2) throw cancelled;
            }, clock::get, duration -> fail("Cancellation must not enter another poll"), TimeUnit.SECONDS.toNanos(12));
            fail("Expected cancellation");
        } catch (IOException actual) { assertSame(cancelled, actual); }
    }

    @Test public void maximumConfiguredSelectorFitsBoundWithoutFullProxyMap() throws Exception {
        List<String> names = new ArrayList<>();
        for (int index = 1; index <= UpdateProxyPolicy.MAX_NODES * UpdateProxyPolicy.MAX_SUBSCRIPTIONS; index++) {
            names.add("brclio-node-" + index);
        }
        JSONObject maximum = group(names);
        assertTrue(maximum.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 60000);
        assertTrue(UpdateProxyReadiness.configured(maximum, names));
    }
}
