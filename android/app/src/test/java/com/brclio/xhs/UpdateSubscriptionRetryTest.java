package com.brclio.xhs;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SSLHandshakeException;

import static org.junit.Assert.*;

public class UpdateSubscriptionRetryTest {
    private static final String VALID = "proxies:\n  - {name: test, type: http, server: node.example.test, port: 443}\n";

    /** Real loopback HTTP transport for retry behavior; production URL policy is never changed. */
    private static final class Source implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        final AtomicInteger requests = new AtomicInteger();
        final ExecutorService worker = Executors.newSingleThreadExecutor();
        final int[] statuses;
        final String text;
        final String retryAfter;
        Source(String text, String retryAfter, int... statuses) throws IOException {
            this.statuses = statuses; this.text = text; this.retryAfter = retryAfter;
            worker.submit(() -> {
                while (!server.isClosed()) {
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(3000);
                        BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                        String line;
                        while ((line = input.readLine()) != null && !line.isEmpty()) { /* Consume real HTTP headers. */ }
                        int request = requests.getAndIncrement();
                        int status = statuses[Math.min(request, statuses.length - 1)];
                        byte[] body = text.getBytes(StandardCharsets.UTF_8);
                        String response = "HTTP/1.1 " + status + " Test\r\nConnection: close\r\nContent-Length: " + body.length
                                + "\r\n" + (retryAfter == null ? "" : "Retry-After: " + retryAfter + "\r\n") + "\r\n";
                        socket.getOutputStream().write(response.getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().write(body);
                        socket.getOutputStream().flush();
                    } catch (IOException closed) { if (server.isClosed()) break; }
                }
            });
        }
        List<Map<String, Object>> read() throws IOException {
            HttpURLConnection connection = (HttpURLConnection) URI.create("http://127.0.0.1:" + server.getLocalPort()).toURL().openConnection();
            connection.setConnectTimeout(1000); connection.setReadTimeout(1000); connection.setUseCaches(false);
            try {
                int status = connection.getResponseCode();
                if (status != 200) throw UpdateSubscriptionRetry.Failure.http(status, connection.getHeaderField("Retry-After"));
                try {
                    return UpdateProxyPolicy.nodes(new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
                } catch (RuntimeException invalid) {
                    throw UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.FORMAT);
                }
            } finally { connection.disconnect(); }
        }
        @Override public void close() throws IOException { server.close(); worker.shutdownNow(); }
    }

    @Test public void actualHttp503ThenSuccessUsesSecondResponse() throws Exception {
        try (Source source = new Source(VALID, null, 503, 200)) {
            assertEquals(1, UpdateSubscriptionRetry.execute(source::read, () -> {}).size());
            assertEquals(2, source.requests.get());
        }
    }

    @Test public void permanentHttpAndMalformedYamlNeverRequestAgain() throws Exception {
        for (int status : new int[] {401, 403, 404}) {
            try (Source source = new Source(VALID, null, status, 200)) {
                UpdateSubscriptionRetry.Failure failure = assertThrows(UpdateSubscriptionRetry.Failure.class,
                        () -> UpdateSubscriptionRetry.execute(source::read, () -> {}));
                assertEquals("HTTP_" + status, failure.getMessage());
                assertEquals(1, source.requests.get());
            }
        }
        try (Source source = new Source("proxies: [invalid", null, 200, 200)) {
            UpdateSubscriptionRetry.Failure failure = assertThrows(UpdateSubscriptionRetry.Failure.class,
                    () -> UpdateSubscriptionRetry.execute(source::read, () -> {}));
            assertEquals(UpdateSubscriptionRetry.Reason.FORMAT, failure.reason);
            assertEquals(1, source.requests.get());
        }
    }

    @Test public void repeatedTransientHttpStopsAtThreeAndKeepsSafeCounts() throws Exception {
        try (Source source = new Source(VALID, null, 502)) {
            UpdateSubscriptionRetry.Failure failure = assertThrows(UpdateSubscriptionRetry.Failure.class,
                    () -> UpdateSubscriptionRetry.execute(source::read, () -> {}, milliseconds -> {}));
            assertEquals(3, source.requests.get());
            UpdateSubscriptionRetry.Diagnostics diagnostics = new UpdateSubscriptionRetry.Diagnostics();
            diagnostics.addSummary(failure);
            assertEquals("attempts=3, retries=2; HTTP_502 x3", diagnostics.summary());
        }
    }

    @Test public void cancellationDuringActualHttpBackoffPreventsNextRequest() throws Exception {
        AtomicBoolean cancelled = new AtomicBoolean();
        CountDownLatch backoff = new CountDownLatch(1), resume = new CountDownLatch(1);
        ExecutorService operation = Executors.newSingleThreadExecutor();
        try (Source source = new Source(VALID, "86400", 429, 200)) {
            Future<Boolean> result = operation.submit(() -> {
                try {
                    UpdateSubscriptionRetry.execute(source::read,
                            () -> { if (cancelled.get()) throw new IOException("cancelled"); },
                            milliseconds -> { backoff.countDown(); resume.await(2, TimeUnit.SECONDS); Thread.sleep(milliseconds); });
                    return false;
                } catch (IOException failure) { return failure.getMessage().equals("cancelled"); }
            });
            assertTrue(backoff.await(2, TimeUnit.SECONDS));
            cancelled.set(true); resume.countDown();
            assertTrue(result.get(2, TimeUnit.SECONDS));
            assertEquals(1, source.requests.get());
        } finally { resume.countDown(); operation.shutdownNow(); }
    }

    @Test public void deadlineAndCancellationOverrideTransientClassification() {
        AtomicInteger attempts = new AtomicInteger();
        IOException deadline = assertThrows(IOException.class, () -> UpdateSubscriptionRetry.execute(() -> {
            attempts.incrementAndGet(); throw new SocketTimeoutException("do-not-print-this-url");
        }, () -> { if (attempts.get() > 0) throw new IOException("deadline"); }));
        assertEquals("deadline", deadline.getMessage()); assertEquals(1, attempts.get());
    }

    @Test public void tlsAndFormatArePermanentEvenWhenTheyWrapTransientCauses() {
        SSLHandshakeException tls = new SSLHandshakeException("https://private.example/sub?token=must-not-leak");
        tls.initCause(new SocketTimeoutException("private node name"));
        UpdateSubscriptionRetry.Failure failure = UpdateSubscriptionRetry.classify(tls);
        assertEquals(UpdateSubscriptionRetry.Reason.TLS, failure.reason); assertFalse(failure.retryable);
        assertNull(failure.getCause()); assertEquals("TLS", failure.getMessage());
        assertFalse(UpdateSubscriptionRetry.classify(new IOException(new CertificateException("secret"))).retryable);
        assertFalse(UpdateSubscriptionRetry.classify(new IllegalArgumentException("secret", new UnknownHostException("secret"))).retryable);
        assertFalse(UpdateSubscriptionRetry.Failure.permanent(UpdateSubscriptionRetry.Reason.URL).retryable);
        AtomicInteger attempts = new AtomicInteger();
        assertThrows(UpdateSubscriptionRetry.Failure.class, () -> UpdateSubscriptionRetry.execute(() -> {
            attempts.incrementAndGet(); throw tls;
        }, () -> {}, milliseconds -> fail("A TLS certificate failure must never back off")));
        assertEquals(1, attempts.get());
    }

    @Test(timeout = 1000) public void cyclicCauseChainCannotHangClassification() {
        IOException first = new IOException("private exception"), second = new IOException("private URL");
        first.initCause(second); second.initCause(first);
        UpdateSubscriptionRetry.Failure failure = UpdateSubscriptionRetry.classify(first);
        assertEquals(UpdateSubscriptionRetry.Reason.IO, failure.reason);
        assertFalse(failure.retryable); assertNull(failure.getCause());
    }

    @Test public void onlySpecifiedHttpAndNetworkClassesRetry() {
        for (int status : new int[] {408, 429, 500, 502, 503, 504}) assertTrue(UpdateSubscriptionRetry.Failure.http(status, null).retryable);
        for (int status : new int[] {400, 401, 403, 404, 501, 505}) assertFalse(UpdateSubscriptionRetry.Failure.http(status, null).retryable);
        assertTrue(UpdateSubscriptionRetry.classify(new UnknownHostException("secret")).retryable);
        assertTrue(UpdateSubscriptionRetry.classify(new SocketTimeoutException("secret")).retryable);
        assertFalse(UpdateSubscriptionRetry.classify(new IOException("https://private.example/secret")).retryable);
    }

    @Test public void retryAfterIsAlwaysBoundedAndNeverEchoed() {
        assertEquals(2000, UpdateSubscriptionRetry.retryAfter("86400", 0));
        assertEquals(1000, UpdateSubscriptionRetry.retryAfter("1", 0));
        assertEquals(0, UpdateSubscriptionRetry.retryAfter("-1", 0));
        assertEquals(0, UpdateSubscriptionRetry.retryAfter("not a date or seconds", 0));
        assertEquals(2000, UpdateSubscriptionRetry.retryAfter("Wed, 21 Oct 2015 07:28:00 GMT", 0));
        assertEquals(0, UpdateSubscriptionRetry.retryAfter("Wed, 21 Oct 2015 07:28:00 GMT", Long.MAX_VALUE));
        assertEquals("HTTP_429", UpdateSubscriptionRetry.Failure.http(429, "private header").getMessage());
    }
}
