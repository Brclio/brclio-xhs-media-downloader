package com.brclio.xhs;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

public class UpdateNetworkCleanupTest {
    @Test(timeout = 5000) public void networkCleanupRunsAwayFromCallerAndDoesNotBlockCancellation() throws Exception {
        Thread caller = Thread.currentThread();
        AtomicReference<Thread> cleanupThread = new AtomicReference<>();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch mayCloseSocket = new CountDownLatch(1);
        Thread cleanup = UpdateNetworkCleanup.start(() -> {
            cleanupThread.set(Thread.currentThread());
            entered.countDown();
            try { mayCloseSocket.await(); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        });
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            assertNotSame(caller, cleanupThread.get());
            assertTrue(cleanup.isDaemon());
            assertTrue(cleanup.isAlive());
        } finally { mayCloseSocket.countDown(); cleanup.join(2000); }
        assertFalse(cleanup.isAlive());
    }

    @Test(timeout = 5000) public void blockedSocketCleanupCannotDelayAnotherOperationCleanup() throws Exception {
        CountDownLatch blocked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch secondClosed = new CountDownLatch(1);
        Thread first = UpdateNetworkCleanup.start(() -> {
            blocked.countDown();
            try { release.await(); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        });
        try {
            assertTrue(blocked.await(2, TimeUnit.SECONDS));
            Thread second = UpdateNetworkCleanup.start(secondClosed::countDown);
            assertTrue(secondClosed.await(2, TimeUnit.SECONDS));
            second.join(2000);
            assertFalse(second.isAlive());
        } finally { release.countDown(); first.join(2000); }
    }
}
