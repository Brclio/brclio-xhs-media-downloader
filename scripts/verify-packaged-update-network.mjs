// Real packaged main/preload/updater smoke. Explicit --live is required because
// this contacts the configured subscription and GitHub through the bundled core.
// The signed .app stays byte-identical; no installation or installer download.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sanitizeDiagnostic } from '../lib/diagnostic-sanitize.js';
import { verifyPackagedUpdateProxy } from './verify-packaged-update-proxy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);

async function command(file, args) {
  try { return await run(file, args, { timeout: 15000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error('Packaged updater native verification command failed.'); }
}

async function connectCDP(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Packaged updater CDP connection timed out.')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Packaged updater CDP connection failed.')); }, { once: true });
  });
  let sequence = 0;
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence;
    const finish = (error, value) => {
      clearTimeout(timer); socket.removeEventListener('message', message); socket.removeEventListener('close', closed);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Packaged updater CDP evaluation timed out.')), 5000);
    const closed = () => finish(new Error('Packaged updater CDP disconnected.'));
    const message = event => {
      let response;
      try { response = JSON.parse(event.data); } catch { return; }
      if (response.id !== id) return;
      if (response.error) {
        const error = new Error('Packaged updater CDP request failed.'); error.cdpCode = response.error.code; finish(error);
      } else if (response.result?.exceptionDetails) finish(new Error('Packaged updater renderer evaluation failed.'));
      else finish(null, response.result?.result?.value);
    };
    socket.addEventListener('message', message); socket.addEventListener('close', closed, { once: true });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => socket.close() };
}

/** Query command lines only for descendants owned by this disposable launch. */
async function ownedProxyProcesses(mainPid, profile, tracked) {
  const { stdout } = await command('ps', ['-axo', 'pid=,ppid=']);
  const parents = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([mainPid]);
  let changed;
  do {
    changed = false;
    for (const [pid, parent] of parents) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
  } while (changed);
  const candidates = [...new Set([...descendants, ...tracked])].filter(pid => pid !== mainPid && parents.some(([value]) => value === pid));
  if (!candidates.length) return [];
  // These are our child process commands; never emit them or inspect another
  // user's installed/running client. Proxy credentials are stored in files.
  let lines;
  try { ({ stdout: lines } = await run('ps', ['-p', candidates.join(','), '-o', 'pid=,command='], { timeout: 15000, maxBuffer: 1024 * 1024 })); }
  catch (error) { if (error.code === 1 && !error.stdout?.trim()) return []; throw new Error('Owned updater process inspection failed.'); }
  const proxies = [];
  for (const line of lines.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match && match[2].includes(profile) && /proxy-core-supervisor\.cjs|[\/]mihomo(?:\s|$)/.test(match[2])) {
      const pid = Number(match[1]); tracked.add(pid); proxies.push(pid);
    }
  }
  return proxies;
}

async function diagnosticEvents(profile) {
  const directory = path.join(profile, 'diagnostics');
  let names;
  try { names = (await readdir(directory)).filter(name => /^events(?:\.\d+)?\.ndjson$/.test(name)); }
  catch { return []; }
  const rows = [];
  for (const name of names) {
    const contents = await readFile(path.join(directory, name), 'utf8');
    const lines = contents.split('\n');
    // An in-flight append can expose an incomplete final row. Completed rows
    // remain strict JSON; the final post-check diagnostics snapshot flushes it.
    for (const line of lines.slice(0, -1)) if (line) rows.push(JSON.parse(line));
  }
  return rows;
}

export async function verifyPackagedUpdateNetwork(appPath, { live = false } = {}) {
  assert.equal(live, true, 'Use --live to verify the subscriptions configured in the management backend.');
  assert.equal(process.platform, 'darwin', 'This signed package smoke runs on macOS.');
  const sourcePackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const resources = path.join(appPath, 'Contents/Resources');
  const asar = require('@electron/asar');
  const archive = path.join(resources, 'app.asar');
  asar.uncache(archive);
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(packaged.version, sourcePackage.version, 'Packaged app version must match the current source.');
  for (const file of ['desktop/main.js', 'desktop/preload.cjs', 'desktop/update-proxy.js', 'desktop/update-manager.js', 'desktop/proxy-core-supervisor.cjs']) {
    assert.equal(hash(asar.extractFile(archive, file)), hash(await readFile(path.join(root, file))), `Packaged updater source is stale: ${file}`);
  }
  await command('codesign', ['--verify', '--deep', '--strict', appPath]);
  await verifyPackagedUpdateProxy(resources);
  const account = JSON.parse(asar.extractFile(archive, 'desktop/account-config.json').toString('utf8'));
  const configuration = await fetch(account.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-proxy-config', input: {} }), signal: AbortSignal.timeout(12000) }).then(response => response.json());
  assert.equal(configuration.ok, true, 'The live management configuration must be available before packaged proxy verification.');
  const urls = configuration.proxyConfig.subscriptionUrls || [];
  assert.ok(configuration.proxyConfig.enabled && urls.length, 'Configure the management subscriptions before this live proxy acceptance.');
  const privateValues = [...urls, ...urls.flatMap(url => [...new URL(url).searchParams.values()])].filter(value => value.length >= 8);
  const profile = await mkdtemp(path.join(tmpdir(), 'brclio-packaged-update-network-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(appPath, 'Contents/MacOS', sourcePackage.build.productName), [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--use-mock-keychain',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', launchError, cdp;
  const tracked = new Set();
  let report, failure;
  child.on('error', () => { launchError = new Error('Signed updater package could not launch.'); });
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-16000); });
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-16000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const launchDeadline = Date.now() + 45000;
    let page;
    while (Date.now() < launchDeadline) {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, 'Packaged app exited before opening its renderer.');
      assert.equal(child.signalCode, null, 'Packaged app stopped before opening its renderer.');
      const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1];
      if (port) {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then(response => response.json());
        page = targets.find(target => target.type === 'page' && target.url.startsWith('xhs-app://local/'));
        if (page?.webSocketDebuggerUrl) break;
      }
      await delay(200);
    }
    assert.ok(page?.webSocketDebuggerUrl, 'Packaged app did not advertise its renderer.');
    cdp = await connectCDP(page.webSocketDebuggerUrl);
    const readyDeadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        ready = await cdp.evaluate(`document.readyState === 'complete' && document.body.dataset.desktopReady === 'true'
          && typeof window.xhsDesktop?.checkForUpdates === 'function' && typeof window.xhsDesktop?.getUpdateState === 'function'`);
        if (ready) break;
      } catch (error) { if (error.cdpCode !== -32000) throw error; }
      await delay(200);
    }
    assert.equal(ready, true, 'Packaged preload did not expose real update IPC.');
    const info = await cdp.evaluate('window.xhsDesktop.getInfo()');
    assert.equal(info.version, sourcePackage.version);
    console.log('Packaged updater: signed main, preload and current updater source verified.');
    await cdp.evaluate(`window.__packagedUpdateCheck = { done: false };
      window.xhsDesktop.checkForUpdates().then(result => { window.__packagedUpdateCheck = { done: true, status: result.status }; },
        () => { window.__packagedUpdateCheck = { done: true, rejected: true }; }); true`);
    const updateDeadline = Date.now() + 180000;
    let state, completed = false, progressAt = 0;
    while (Date.now() < updateDeadline) {
      assert.equal(child.exitCode, null, 'Packaged updater exited during its network check.');
      await ownedProxyProcesses(child.pid, profile, tracked);
      const check = await cdp.evaluate('window.__packagedUpdateCheck');
      state = await cdp.evaluate('window.xhsDesktop.getUpdateState()');
      if (check?.done) { assert.equal(check.rejected, undefined, 'Real packaged update IPC rejected.'); completed = true; break; }
      if (Date.now() - progressAt > 10000) { console.log(`Packaged updater: ${state.status}.`); progressAt = Date.now(); }
      await delay(500);
    }
    assert.equal(completed, true, 'Packaged update check timed out.');
    assert.ok(['available', 'up-to-date'].includes(state.status), `Packaged update check failed (${state.error?.code || state.status}).`);
    assert.equal(state.error, null);
    await cdp.evaluate('window.xhsDesktop.getDiagnosticsInfo()');
    const events = await diagnosticEvents(profile);
    const proxyEvents = events.filter(event => ['update.check_direct', 'update.proxy_selected', 'update.proxy_system_selected', 'update.proxy_stopped'].includes(event.event));
    const directChecks = proxyEvents.filter(event => event.event === 'update.check_direct');
    const selected = proxyEvents.filter(event => event.event === 'update.proxy_selected');
    const systemSelected = proxyEvents.filter(event => event.event === 'update.proxy_system_selected');
    assert.ok(directChecks.length, 'Packaged update check did not attempt the direct network route first.');
    if (systemSelected.length) assert.equal(selected.length, 0, 'System proxy precedence must skip internal proxy startup.');
    assert.ok(proxyEvents.some(event => event.event === 'update.proxy_stopped'), 'Packaged update check did not close its proxy scope.');
    for (const event of selected) {
      assert.match(event.details?.node || '', /^node-\d{3}$/);
      assert.ok(Number.isFinite(event.details.latencyMs) && event.details.latencyMs >= 0);
    }
    assert.deepEqual(proxyEvents, sanitizeDiagnostic(proxyEvents), 'Update diagnostics contain unredacted credentials.');
    assert.ok(privateValues.every(value => !JSON.stringify(events).includes(value)), 'Private subscription credentials leaked into diagnostics.');
    let running = [];
    const cleanupDeadline = Date.now() + 5000;
    do {
      running = await ownedProxyProcesses(child.pid, profile, tracked);
      if (!running.length) break;
      await delay(100);
    } while (Date.now() < cleanupDeadline);
    assert.equal(running.length, 0, 'Packaged update proxy core survived its completed operation.');
    report = { result: 'PASS', packagedUpdateNetworkVerified: true, checkedAt: new Date().toISOString(),
      version: info.version, latestVersion: state.latestVersion, status: state.status, signedPackageVerified: true,
      sourceMatchesCurrentWorkspace: true, preloadAndIPCVerified: true, profile: 'temporary', keychain: 'mock',
      directCheckAttempted: true, proxySelected: selected.length > 0, systemProxySelected: systemSelected.length > 0,
      networkRoute: systemSelected.length ? 'system' : selected.length ? 'internal' : 'direct', proxyStopped: true, diagnosticsRedacted: true,
      selectedNodes: selected.map(event => ({ node: event.details.node, latencyMs: event.details.latencyMs, nodes: event.details.nodes })),
      activeProxyProcessesAfterCheck: 0, installed: false, installerDownloaded: false, published: false };
  } catch (error) { failure = error; }
  finally {
    cdp?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const stopped = await Promise.race([closed.then(() => true), delay(10000).then(() => false)]);
    if (!stopped) { child.kill('SIGKILL'); await Promise.race([closed, delay(3000)]); }
    let survivors = [];
    const exitDeadline = Date.now() + 5000;
    do {
      survivors = await ownedProxyProcesses(child.pid, profile, tracked);
      if (!survivors.length) break;
      await delay(100);
    } while (Date.now() < exitDeadline);
    if (survivors.length) {
      failure ||= new Error('Packaged proxy process survived application exit.');
      // Restrict recovery to known proxy commands containing our disposable
      // profile; no user-owned installed client or other proxy is touched.
      for (const pid of survivors) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    }
    if (report) report.activeProxyProcessesAfterExit = survivors.length;
    await rm(profile, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const appPath = path.resolve(args.find(value => !value.startsWith('--')) || path.join(root, `dist-desktop/mac-${process.arch}/Brclio 小红书下载器.app`));
  verifyPackagedUpdateNetwork(appPath, { live: args.includes('--live') }).then(async report => {
    const directory = path.join(root, 'dist-desktop/proxy-validation'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'packaged-network.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }).catch(error => {
    // Native output and subscription-bearing application errors stay private.
    console.error(`Packaged update network verification failed: ${error.message}`); process.exitCode = 1;
  });
}
