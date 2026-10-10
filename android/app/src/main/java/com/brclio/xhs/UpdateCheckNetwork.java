package com.brclio.xhs;

import java.io.IOException;
import java.util.function.BooleanSupplier;

/** Release metadata prefers direct networking; only transport/server failures may use another route. */
final class UpdateCheckNetwork {
    interface Request<T> { T run() throws IOException; }
    interface Check { void run() throws IOException; }

    static final class Failure extends IOException {
        Failure(String message) { super(message); }
        Failure(String message, Throwable cause) { super(message, cause); }
    }

    static <T> T run(Request<T> direct, Request<T> fallback, Check check, BooleanSupplier fallbackAllowed) throws IOException {
        try { return direct.run(); }
        catch (Failure unavailable) {
            check.run();
            if (!fallbackAllowed.getAsBoolean()) throw unavailable;
            return fallback.run();
        }
    }

    private UpdateCheckNetwork() { }
}
