package com.brclio.xhs;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class UpdateProxyControlTest {
    @Test public void systemProxyWinsAndManualStopNeverCancelsThatOperation() {
        UpdateProxyControl control = new UpdateProxyControl();
        AtomicInteger stopped = new AtomicInteger();
        assertEquals(UpdateProxyControl.Route.SYSTEM, control.begin(stopped::incrementAndGet, true));
        assertEquals("system", control.state(true).mode);
        assertFalse(control.stop());
        assertEquals(0, stopped.get());
        assertTrue(control.state(true).manuallyDisabled);
        assertEquals(UpdateProxyControl.Route.SYSTEM, control.begin(stopped::incrementAndGet, true));
    }

    @Test public void manualStopCancelsStartupAndAutomaticChecksStayDirectUntilTheNextExplicitOperation() {
        UpdateProxyControl control = new UpdateProxyControl();
        AtomicInteger stopped = new AtomicInteger();
        UpdateProxyControl.Owner owner = stopped::incrementAndGet;
        assertEquals(UpdateProxyControl.Route.INTERNAL, control.begin(owner, false));
        assertEquals("starting", control.state(false).mode);
        assertTrue(control.stop());
        assertEquals(1, stopped.get());
        assertEquals("off", control.state(false).mode);
        assertFalse(control.state(false).canStop);
        assertFalse(control.stop());
        control.ready(owner, true);
        control.finished(owner, true);
        assertEquals("off", control.state(false).mode);
        assertFalse(control.acceptOperation(false));
        assertEquals(UpdateProxyControl.Route.DIRECT, control.begin(owner, false));
        assertTrue(control.acceptOperation(true));
        assertFalse(control.state(false).manuallyDisabled);
        assertEquals(UpdateProxyControl.Route.INTERNAL, control.begin(owner, false));
        control.ready(owner, true);
        assertEquals("internal", control.state(false).mode);
        assertTrue(control.stop());
        assertEquals(2, stopped.get());
    }

    @Test public void restoredManualOffSurvivesBackgroundChecksAndExplicitChecksAndDownloadsRestoreDefault() {
        for (String operation : new String[] { "check", "download" }) {
            UpdateProxyControl control = new UpdateProxyControl(true);
            UpdateProxyControl.Owner owner = () -> fail("No cancellation required");
            assertTrue(control.state(false).manuallyDisabled);
            assertFalse(control.acceptOperation(false));
            assertEquals(UpdateProxyControl.Route.DIRECT, control.begin(owner, false));
            assertTrue(operation, control.acceptOperation(true));
            assertFalse(control.state(false).manuallyDisabled);
            assertEquals(UpdateProxyControl.Route.INTERNAL, control.begin(owner, false));
            control.ready(owner, true);
            control.finished(owner, false);
            assertEquals("off", control.state(false).mode);
            assertFalse(control.state(false).manuallyDisabled);
        }
    }

    @Test public void explicitOperationsRetainSystemPriorityAndCannotStealACurrentInternalOwner() {
        UpdateProxyControl control = new UpdateProxyControl(true);
        AtomicInteger stopped = new AtomicInteger();
        UpdateProxyControl.Owner owner = stopped::incrementAndGet;
        assertTrue(control.acceptOperation(true));
        assertEquals(UpdateProxyControl.Route.SYSTEM, control.begin(owner, true));
        assertFalse(control.stop());
        assertEquals(0, stopped.get());
        assertTrue(control.acceptOperation(true));
        assertEquals(UpdateProxyControl.Route.INTERNAL, control.begin(owner, false));
        control.ready(owner, true);
        assertFalse(control.acceptOperation(true));
        assertEquals("internal", control.state(false).mode);
        assertTrue(control.stop());
        assertEquals(1, stopped.get());
    }

    @Test public void serverDisabledOrCompletedSessionsLoseCancellationOwnership() {
        UpdateProxyControl control = new UpdateProxyControl();
        AtomicInteger stopped = new AtomicInteger();
        UpdateProxyControl.Owner owner = stopped::incrementAndGet;
        control.begin(owner, false);
        control.ready(owner, false);
        assertFalse(control.stop());
        assertEquals(0, stopped.get());
        control.acceptOperation(true);
        control.begin(owner, false);
        control.ready(owner, true);
        control.finished(owner, false);
        assertFalse(control.stop());
        assertEquals(0, stopped.get());
    }

    @Test public void startupFailureCanBeManuallyClearedWithoutInventingAnActiveProcess() {
        UpdateProxyControl control = new UpdateProxyControl();
        UpdateProxyControl.Owner owner = () -> fail("Finished proxy must not be stopped again");
        control.begin(owner, false);
        control.finished(owner, true);
        assertEquals("error", control.state(false).mode);
        assertFalse(control.stop());
        assertEquals("off", control.state(false).mode);
    }

    @Test(timeout = 5000) public void delayedCleanupCannotCancelAResumedNewOwner() throws Exception {
        UpdateProxyControl control = new UpdateProxyControl();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger newOwnerStopped = new AtomicInteger();
        UpdateProxyControl.Owner previous = () -> {
            entered.countDown();
            try { release.await(); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        };
        control.begin(previous, false);
        Thread stop = new Thread(control::stop);
        stop.start();
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            assertTrue(control.state(false).manuallyDisabled);
            control.acceptOperation(true);
            UpdateProxyControl.Owner current = newOwnerStopped::incrementAndGet;
            control.begin(current, false);
            control.ready(current, true);
            control.finished(previous, true);
            assertEquals("internal", control.state(false).mode);
            assertEquals(0, newOwnerStopped.get());
        } finally { release.countDown(); stop.join(2000); }
        assertFalse(stop.isAlive());
        assertTrue(control.stop());
        assertEquals(1, newOwnerStopped.get());
    }
}
