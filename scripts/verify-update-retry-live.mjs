// Explicit --live acceptance only: real Electron sessions, administrator configuration, subscriptions, Mihomo,
// GitHub assets, and production retry code. Only this temporary session's
// external-proxy detector is forced direct to exercise the built-in route.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateProxyNetwork } from '../desktop/update-proxy.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function createScenario({ net, session, directory, output, onDiagnostic, onProxyState }) {
  const config = JSON.parse(await readFile(path.join(root, 'desktop/account-config.json'), 'utf8'));
  const before = await session.defaultSession.resolveProxy('https://api.github.com/zen');
  const report = { checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    network: 'real administrator configuration, real subscription, real Mihomo and GitHub',
    fault: 'close only the temporary owned proxy supervisor stdin after receiving installer bytes',
    isolatedDirectDetection: true, sources: {}, scopesOpened: 0, scopesClosed: 0,
    injections: [], retryEvents: [], requests: [], events: [], manualStarted: false };
  for (const file of ['desktop/update-manager.js', 'desktop/update-proxy.js', 'desktop/preload.cjs', 'desktop-ui.js']) {
    report.sources[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  }
  const reportPath = path.join(output, 'live-network.json');
  const cores = new Set(), starts = new WeakMap(), injected = new WeakSet(), ids = new WeakMap();
  let injectFailures = true, lastRetryKey = '', lastProgress = -1;
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const network = new UpdateProxyNetwork({ net, session, endpoint: config.endpoint,
    runtimeDirectory: path.join(root, 'desktop-runtime', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`, 'proxy'),
    cacheDirectory: directory,
    detectExternalProxy: async scoped => {
      await scoped.setProxy({ mode: 'direct' });
      return { enabled: false, source: 'isolated-test-session' };
    },
    onDiagnostic(event, details = {}) {
      const safe = Object.fromEntries(Object.entries(details).filter(([key]) => ['code', 'nodes', 'sources', 'available', 'revision', 'node', 'latencyMs'].includes(key)));
      report.events.push({ event, ...safe }); onDiagnostic(event, safe);
    },
    onStateChange: () => onProxyState?.()
  });
  const prepare = network.prepare.bind(network);
  network.prepare = async (...args) => {
    try { return await prepare(...args); }
    finally { if (args[0].child) cores.add(args[0].child); }
  };
  const run = network.run.bind(network);
  network.run = async (controller, work, options) => {
    const id = ++report.scopesOpened; ids.set(controller.signal, id);
    console.log(`Live internal network scope ${id} started`);
    try { return await run(controller, work, options); }
    finally {
      report.scopesClosed++; report.activeScopes = network.active.size;
      report.defaultSessionUnchanged = await session.defaultSession.resolveProxy('https://api.github.com/zen') === before;
      save();
    }
  };
  const fetchImpl = (url, options) => {
    const parsed = new URL(url);
    report.requests.push({ scope: ids.get(options.signal), host: parsed.hostname,
      asset: parsed.pathname.includes('/releases/download/') || parsed.hostname.includes('githubusercontent.com'),
      range: new Headers(options.headers).get('range') });
    return network.fetch(url, options);
  };
  save(); console.log(`LIVE_NETWORK_REPORT ${reportPath}`);
  // Ten fresh proxy handshakes plus a full installer can exceed twenty minutes
  // on a slow node; this opt-in acceptance does not use the short offline CI budget.
  return { networkScope: network, fetchImpl, live: true, timeoutMs: 3600000,
    networkTimeoutMs: 30000, downloadRetryDelayMs: 1000,
    onManagerState(state) {
      const retryKey = `${state.status}:${state.retry?.consecutiveFailures ?? 0}:${state.retry?.active ?? false}`;
      if (retryKey !== lastRetryKey) {
        lastRetryKey = retryKey;
        report.retryEvents.push({ at: new Date().toISOString(), status: state.status,
          failures: state.retry?.consecutiveFailures || 0, active: state.retry?.active || false,
          code: state.error?.code || state.retry?.lastError?.code || null, bytes: state.download.receivedBytes });
        console.log(`Live updater ${state.status}: failures=${state.retry?.consecutiveFailures || 0}, bytes=${state.download.receivedBytes}`);
        save();
      }
      if (state.status === 'downloaded') {
        report.downloadVerified = true; report.downloadBytes = state.download.receivedBytes; report.latestVersion = state.latestVersion; save();
      }
      if (state.status !== 'downloading') return;
      const mark = Math.floor(state.download.percent / 20);
      if (mark > lastProgress) { lastProgress = mark; console.log(`Live installer progress ${state.download.percent}%`); }
      const scope = [...network.active.values()].find(value => value.internal && value.ready && value.workStarted);
      if (!scope) return;
      if (!starts.has(scope)) starts.set(scope, state.download.receivedBytes);
      if (injectFailures && !injected.has(scope) && scope.child?.exitCode === null
        && state.download.receivedBytes - starts.get(scope) >= 256 * 1024) {
        injected.add(scope);
        report.injections.push({ scope: ids.get(scope.controller.signal), bytes: state.download.receivedBytes,
          previousFailures: state.retry?.consecutiveFailures || 0 });
        scope.child.stdin.end();
        console.log(`Injected owned Mihomo interruption at ${state.download.receivedBytes} bytes`); save();
      }
    },
    async beforeManualRetry({ manager }) {
      assert.equal(manager.snapshot().retry?.consecutiveFailures, 10);
      injectFailures = false; report.manualStarted = true; report.bytesBeforeManual = manager.snapshot().download.receivedBytes; save();
      console.log('Ten failures reached; manual continuation now uses the uninterrupted real proxy.');
    },
    async cleanup() {
      // Every scope here belongs to this temporary harness. Stop any unfinished
      // attempt before checking that its supervisors and private cache are gone.
      if (network.active.size) await network.stopInternalProxy();
      await network.flushPreferences();
      report.activeScopesAfterCleanup = network.active.size;
      report.coreCount = cores.size;
      report.activeOwnedSupervisors = [...cores].filter(child => child.exitCode === null && child.signalCode === null).length;
      report.defaultSessionUnchanged = await session.defaultSession.resolveProxy('https://api.github.com/zen') === before;
      save();
      assert.equal(report.activeScopesAfterCleanup, 0); assert.equal(report.activeOwnedSupervisors, 0);
      assert.equal(report.defaultSessionUnchanged, true);
      // The launcher removes the private subscription cache and test installer
      // after Electron exits, and makes a cleanup failure fail the command.
    }
  };
}
