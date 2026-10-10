package com.brclio.xhs;

/** Owns only this application's temporary updater proxy, never an external system route. */
final class UpdateProxyControl {
    interface Owner { void stop(); }
    enum Route { INTERNAL, SYSTEM, DIRECT }

    static final class State {
        final String mode;
        final boolean manuallyDisabled;
        final boolean canStop;
        State(String mode, boolean manuallyDisabled) {
            this.mode = mode;
            this.manuallyDisabled = manuallyDisabled;
            this.canStop = !manuallyDisabled;
        }
    }

    private boolean manuallyDisabled;
    private String mode = "off";
    private Owner owner;

    UpdateProxyControl() { this(false); }

    UpdateProxyControl(boolean manuallyDisabled) { this.manuallyDisabled = manuallyDisabled; }

    /** Only an accepted new user-requested check/download clears manual off. */
    synchronized boolean acceptOperation(boolean explicit) {
        if (!explicit || owner != null) return false;
        boolean changed = manuallyDisabled;
        manuallyDisabled = false;
        mode = "off";
        return changed;
    }

    synchronized Route begin(Owner candidate, boolean systemProxy) {
        if (systemProxy) { mode = "system"; return Route.SYSTEM; }
        if (manuallyDisabled) { mode = "off"; return Route.DIRECT; }
        owner = candidate;
        mode = "starting";
        return Route.INTERNAL;
    }

    synchronized void beginDirect() {
        if (owner == null) mode = "off";
    }

    synchronized void ready(Owner candidate, boolean internal) {
        if (owner != candidate) return;
        mode = internal ? "internal" : "off";
        if (!internal) owner = null;
    }

    synchronized void finished(Owner candidate, boolean failed) {
        if (owner != candidate) return;
        owner = null;
        mode = failed ? "error" : "off";
    }

    boolean stop() {
        Owner current;
        synchronized (this) {
            manuallyDisabled = true;
            current = owner;
            owner = null;
            mode = "off";
        }
        // Cancelling sockets must not hold the state lock or touch an external/system-only job.
        if (current != null) current.stop();
        return current != null;
    }

    synchronized void resume() {
        manuallyDisabled = false;
        if (owner == null) mode = "off";
    }

    synchronized State state(boolean systemProxy) {
        String current = owner != null ? mode : systemProxy ? "system"
                : mode.equals("error") && !manuallyDisabled ? "error" : "off";
        return new State(current, manuallyDisabled);
    }
}
