package com.brclio.xhs;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.security.cert.CertificateException;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.net.ssl.SSLException;
import javax.net.ssl.SSLPeerUnverifiedException;

/** Bounded per-source retries. Messages and diagnostics never include remote data or exception messages. */
final class UpdateSubscriptionRetry {
    static final int MAX_ATTEMPTS = 3;
    static final long MAX_BACKOFF_MS = 2000;
    interface Check { void run() throws IOException; }
    interface Request<T> { T run() throws Exception; }
    interface Sleep { void run(long milliseconds) throws InterruptedException; }
    enum Reason { DNS, CONNECT, TIMEOUT, TLS, HTTP, URL, FORMAT, IO, PROBE_NO_DELAY }

    static final class Failure extends IOException {
        final Reason reason;
        final int status;
        final long retryAfterMs;
        final boolean retryable;
        private Map<String, Integer> history;
        private int attempts = 1;

        Failure(Reason reason, int status, long retryAfterMs, boolean retryable) {
            super(reason.name() + (reason == Reason.HTTP && status > 0 ? "_" + status : ""));
            this.reason = reason;
            this.status = status;
            this.retryAfterMs = Math.max(0, Math.min(MAX_BACKOFF_MS, retryAfterMs));
            this.retryable = retryable;
        }
        static Failure permanent(Reason reason) { return new Failure(reason, 0, 0, false); }
        static Failure http(int status, String retryAfter) {
            boolean temporary = status == 408 || status == 429 || status == 500 || status == 502
                    || status == 503 || status == 504;
            return new Failure(Reason.HTTP, status >= 100 && status <= 599 ? status : 0,
                    retryAfter(retryAfter, System.currentTimeMillis()), temporary);
        }
    }

    /** Only fixed categories, HTTP codes and counts can enter a user-visible error. */
    static final class Diagnostics {
        private final Map<String, Integer> counts = new LinkedHashMap<>();
        private int attempts;
        private int retries;
        private boolean sourceSummary;
        synchronized void add(Failure failure) {
            String key = failure.getMessage();
            counts.put(key, counts.getOrDefault(key, 0) + 1);
        }
        synchronized void addSummary(Failure failure) {
            sourceSummary = true;
            attempts += failure.attempts;
            retries += Math.max(0, failure.attempts - 1);
            if (failure.history == null) add(failure);
            else for (Map.Entry<String, Integer> entry : failure.history.entrySet()) {
                counts.put(entry.getKey(), counts.getOrDefault(entry.getKey(), 0) + entry.getValue());
            }
        }
        private synchronized Map<String, Integer> snapshot() { return new LinkedHashMap<>(counts); }
        synchronized String summary() {
            StringBuilder result = new StringBuilder();
            for (Map.Entry<String, Integer> entry : counts.entrySet()) {
                if (result.length() > 0) result.append("; ");
                result.append(entry.getKey()).append(" x").append(entry.getValue());
            }
            String failures = result.length() == 0 ? "IO" : result.toString();
            return sourceSummary ? "attempts=" + attempts + ", retries=" + retries + "; " + failures : failures;
        }
    }

    static <T> T execute(Request<T> request, Check check) throws IOException {
        return execute(request, check, Thread::sleep);
    }

    static <T> T execute(Request<T> request, Check check, Sleep sleep) throws IOException {
        Diagnostics attempts = new Diagnostics();
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            check.run();
            try {
                T result = request.run();
                check.run();
                return result;
            } catch (Exception unavailable) {
                // Cancellation/deadline outrank retry classification, including a socket
                // closed by cancellation while an HTTP request is still in progress.
                check.run();
                Failure failure = classify(unavailable);
                attempts.add(failure);
                if (!failure.retryable || attempt == MAX_ATTEMPTS) {
                    failure.history = attempts.snapshot();
                    failure.attempts = attempt;
                    throw failure;
                }
                backoff(Math.max(300L * attempt, failure.retryAfterMs), check, sleep);
            }
        }
        throw Failure.permanent(Reason.IO);
    }

    private static void backoff(long milliseconds, Check check, Sleep sleep) throws IOException {
        long remaining = Math.min(MAX_BACKOFF_MS, milliseconds);
        while (remaining > 0) {
            check.run();
            long slice = Math.min(100, remaining);
            try { sleep.run(slice); }
            catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("更新网络检查已取消。");
            }
            remaining -= slice;
        }
        check.run();
    }

    static Failure classify(Throwable error) {
        if (error instanceof Failure) return (Failure) error;
        // A TLS/certificate exception anywhere in the cause chain is permanent,
        // even if it also wraps a socket timeout or connection exception.
        Throwable cause = error;
        for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
            if (cause instanceof SSLException || cause instanceof SSLPeerUnverifiedException
                    || cause instanceof CertificateException) return Failure.permanent(Reason.TLS);
        }
        if (error instanceof IllegalArgumentException) return Failure.permanent(Reason.FORMAT);
        cause = error;
        for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
            if (cause instanceof UnknownHostException) return new Failure(Reason.DNS, 0, 0, true);
            if (cause instanceof SocketTimeoutException) return new Failure(Reason.TIMEOUT, 0, 0, true);
            if (cause instanceof ConnectException || cause instanceof NoRouteToHostException || cause instanceof SocketException) {
                return new Failure(Reason.CONNECT, 0, 0, true);
            }
        }
        return Failure.permanent(Reason.IO);
    }

    static long retryAfter(String value, long nowMs) {
        if (value == null || value.length() > 128) return 0;
        String header = value.trim();
        try {
            long seconds = Long.parseLong(header);
            if (seconds < 0) return 0;
            return Math.min(seconds, MAX_BACKOFF_MS / 1000) * 1000;
        } catch (NumberFormatException date) {
            try {
                long when = ZonedDateTime.parse(header, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli();
                return when <= nowMs ? 0 : Math.min(MAX_BACKOFF_MS, when - nowMs);
            } catch (RuntimeException invalid) { return 0; }
        }
    }
}
