package com.brclio.xhs;

/** TLS socket close can perform network I/O; cancellation must not run it on Android's UI thread. */
final class UpdateNetworkCleanup {
    private UpdateNetworkCleanup() { }

    static Thread start(Runnable cleanup) {
        Thread thread = new Thread(() -> {
            try { cleanup.run(); }
            catch (RuntimeException ignored) { /* Cleanup errors must not leak endpoint or credential details. */ }
        }, "brclio-update-network-cleanup");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }
}
