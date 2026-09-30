package com.brclio.xhs;

import static org.junit.Assert.assertEquals;

import android.app.Activity;

import org.junit.Test;

public class UpdateManagerResultTest {
    @Test public void installerResultDoesNotInventFailureFromCancellationOrUnknownCodes() {
        assertEquals("success", UpdateManager.installerResult(Activity.RESULT_OK));
        assertEquals("failed", UpdateManager.installerResult(Activity.RESULT_FIRST_USER));
        assertEquals("cancelled", UpdateManager.installerResult(Activity.RESULT_CANCELED));
        assertEquals("unknown", UpdateManager.installerResult(42));
    }
}
