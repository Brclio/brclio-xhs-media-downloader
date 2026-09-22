import { randomUUID } from 'node:crypto';

// Approval belongs to one pending main-process installation. A stale renderer
// reply cannot approve a later version, and losing the window cancels safely.
export class InstallConfirmation {
  constructor({ timeoutMs = 5 * 60 * 1000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = null;
  }

  request(state, send) {
    if (this.pending) return this.pending.promise;
    const id = randomUUID();
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const timer = setTimeout(() => this.cancel(), this.timeoutMs);
    timer.unref?.();
    this.pending = { id, promise, resolve, timer };
    try {
      send({ id, currentVersion: state.currentVersion, latestVersion: state.latestVersion,
        platform: state.platform, portable: state.portable, installationHint: state.installationHint });
    } catch { this.cancel(); }
    return promise;
  }

  respond(id, confirmed) {
    if (!this.pending || typeof id !== 'string' || id !== this.pending.id || typeof confirmed !== 'boolean') return false;
    const { resolve, timer } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    resolve(confirmed);
    return true;
  }

  cancel() {
    if (this.pending) this.respond(this.pending.id, false);
  }
}
