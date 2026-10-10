// Isolated real UpdateManager -> desktop:* IPC -> actual preload -> actual renderer.
// Run offline: npm run desktop:verify:update-retry
// Explicit real network acceptance: npm run desktop:verify:update-retry -- --live
// Optional custom live scenario: BRCLIO_UI_SCENARIO_FACTORY=/absolute/factory.mjs with --live.
const { app, BrowserWindow, ipcMain, protocol, session, net } = require('electron');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const root = path.resolve(process.env.BRCLIO_REPO || path.join(__dirname, '..'));
// The Node launcher owns this directory and removes private data after Electron
// has exited. A direct invocation cannot select an existing application profile.
const output = (() => {
  const argument = name => process.argv[process.argv.indexOf(name) + 1];
  const directory = argument('--verification-output');
  const token = argument('--verification-token');
  assert.ok(process.argv.includes('--verification-output') && process.argv.includes('--verification-token'),
    'Run through npm run desktop:verify:update-retry');
  assert.ok(path.isAbsolute(directory) && path.basename(directory).startsWith('brclio-real-preload-retry-ui-'));
  assert.equal(fs.realpathSync(path.dirname(directory)), fs.realpathSync(os.tmpdir()));
  assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink());
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'run.json'), 'utf8'));
  assert.equal(marker.kind, 'brclio-update-retry-verification');
  assert.equal(marker.token, token);
  return directory;
})();
app.setPath('userData', path.join(output, 'profile'));
// Destroying the test window must not bypass the final diagnostic report.
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'xhs-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true
} }]);
let win, manager, network, scenario, timeout;
const states = [], diagnostics = [], rendererErrors = [], calls = [], screenshots = {};
const publicState = state => ({ status: state.status, latestVersion: state.latestVersion,
  download: state.download, retry: state.retry, error: state.error, canRetry: state.canRetry });
const diagnostic = (event, details = {}) => diagnostics.push({ event, code: details.code || details.error?.code || null });
let finished = false;

async function finish(code, error, result) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  const currentState = manager ? publicState(manager.snapshot()) : null;
  const shutdownErrors = [];
  if (error) console.error('RETRY_UI_FAILED', error.stack || error);
  try { await manager?.shutdown(); } catch (failure) { shutdownErrors.push(failure.message); }
  try { await scenario?.cleanup?.(); } catch (failure) { shutdownErrors.push(failure.message); }
  if (win && !win.isDestroyed()) win.destroy();
  if (shutdownErrors.length) code = 1;
  const metadata = path.join(output, code ? 'failure.json' : 'verification.json');
  fs.writeFileSync(metadata, JSON.stringify(result ? { ...result, status: code ? 'failed' : 'passed', shutdownErrors }
    : { status: 'failed', live: scenario?.live === true, error: error?.message, currentState,
      states, diagnostics, rendererErrors, screenshots, shutdownErrors }, null, 2));
  console.log(`RETRY_UI_REPORT ${metadata}`);
  app.exit(code);
}

process.on('message', message => {
  if (message?.type === 'verification:shutdown') void finish(1, new Error(message.reason || 'Launcher requested shutdown'));
});
process.on('disconnect', () => void finish(1, new Error('Verification launcher disconnected')));

// Covers initialization failures before a scenario can provide its own budget.
timeout = setTimeout(() => void finish(1, new Error('RETRY_UI_INITIALIZATION_TIMEOUT')), 90000);

async function main() {
  const { UpdateManager, LATEST_RELEASE_URL, installerName } = await import(pathToFileURL(path.join(root, 'desktop/update-manager.js')));
  const { createProtocolHandler, isAppUrl } = await import(pathToFileURL(path.join(root, 'desktop/protocol.js')));
  await app.whenReady();
  const content = Buffer.alloc(128 * 1024, 87), digest = createHash('sha256').update(content).digest('hex');
  const name = installerName('1.7.0', process.platform, process.arch);
  const assetUrl = `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v1.7.0/${name}`;
  const release = { tag_name: 'v1.7.0', draft: false, prerelease: false,
    html_url: 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v1.7.0',
    body: 'Deterministic connection interruption fixture', published_at: '2026-10-04T00:00:00Z',
    assets: [{ name, size: content.length, browser_download_url: assetUrl, digest: `sha256:${digest}` }] };
  let failStreams = true, attempts = 0, activeScopes = 0, opens = 0, closes = 0;
  const fixtureFetch = async (url, init) => {
    if (url === LATEST_RELEASE_URL) return Response.json(release);
    assert.equal(url, assetUrl);
    attempts++;
    const range = new Headers(init.headers).get('range');
    const offset = range ? Number(/^bytes=(\d+)-$/.exec(range)[1]) : 0;
    const headers = { 'content-length': String(content.length - offset) };
    if (offset) headers['content-range'] = `bytes ${offset}-${content.length - 1}/${content.length}`;
    const body = failStreams ? new ReadableStream({ start(controller) {
      controller.enqueue(content.subarray(offset, offset + 1024));
      setTimeout(() => controller.error(new Error('deterministic stream interruption')), 100);
    } }) : content.subarray(offset);
    return new Response(body, { status: offset ? 206 : 200, headers });
  };
  const publishProxy = () => {
    if (win && !win.isDestroyed()) win.webContents.send('desktop:update-proxy-state', network.snapshot());
  };
  const deterministicScope = {
    async requestInternalProxyForUserOperation() {},
    snapshot: () => ({ mode: activeScopes ? 'internal' : 'off', manuallyDisabled: false, activeScopes }),
    async run(controller, work, { onInternalProxy } = {}) {
      assert.equal(activeScopes, 0); controller.signal.throwIfAborted();
      opens++; activeScopes++; onInternalProxy?.(); publishProxy();
      try { return await work(); } finally { closes++; activeScopes--; publishProxy(); }
    },
    async stopInternalProxy() { await manager.cancelUpdateDownload(); return this.snapshot(); },
    async resumeInternalProxy() { return this.snapshot(); }
  };
  scenario = { networkScope: deterministicScope, fetchImpl: fixtureFetch, live: false,
    beforeManualRetry() { failStreams = false; }, timeoutMs: 90000 };
  if (process.argv.includes('--live')) {
    const factoryPath = process.env.BRCLIO_UI_SCENARIO_FACTORY || path.join(__dirname, 'verify-update-retry-live.mjs');
    const factory = await import(pathToFileURL(path.resolve(factoryPath)));
    scenario = await factory.createScenario({ net, session, directory: path.join(output, 'updates'),
      output, onDiagnostic: diagnostic, onProxyState: publishProxy, fixtureFetch, release, content, assetUrl });
    assert.ok(scenario.networkScope && typeof scenario.fetchImpl === 'function');
  }
  network = scenario.networkScope;
  clearTimeout(timeout);
  timeout = setTimeout(() => void finish(1, new Error('RETRY_UI_TIMEOUT')), scenario.timeoutMs || 90000);
  manager = new UpdateManager({ currentVersion: '0.0.0', platform: process.platform, arch: process.arch,
    directory: path.join(output, 'updates'), networkScope: network, fetchImpl: scenario.fetchImpl,
    networkTimeoutMs: scenario.networkTimeoutMs || 30000, downloadRetryDelayMs: scenario.downloadRetryDelayMs ?? 700,
    onUpdate(state) {
      states.push(publicState(state));
      if (win && !win.isDestroyed()) win.webContents.send('desktop:update-state', state);
      // Hook executes after the genuine state is sent; no retry state injection.
      if (scenario.onManagerState) Promise.resolve(scenario.onManagerState(state, manager)).catch(error => {
        rendererErrors.push(`scenario hook failed: ${error.message}`);
      });
    } });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  protocol.handle('xhs-app', createProtocolHandler({ rootDirectory: root }));
  const handle = (channel, handler) => ipcMain.handle(channel, async (event, ...args) => {
    assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame);
    assert.ok(isAppUrl(event.senderFrame.url)); calls.push(channel); return handler(...args);
  });
  const profile = { status: 'idle', items: [], directory: '', intervalSeconds: 10, jitterSeconds: 3 };
  const account = { configured: false, authenticated: false, verified: false, status: 'unconfigured' };
  handle('desktop:get-info', () => ({ version: '0.0.0', platform: process.platform, arch: process.arch, pythonAvailable: false }));
  handle('desktop:get-profile-state', () => profile);
  handle('desktop:get-login-state', () => ({ status: 'unknown', loggedIn: false }));
  handle('desktop:account-state', () => account);
  handle('desktop:commerce-request', action => ({ ok: true,
    result: action === 'reviews-public' ? { reviews: [], total: 0 } : { plans: [] }, state: account }));
  handle('desktop:diagnostics-info', () => ({ application: { version: '0.0.0' } }));
  handle('desktop:record-diagnostic', () => true);
  handle('desktop:get-update-history', () => null);
  handle('desktop:feedback-state', () => ({ status: 'idle' }));
  handle('desktop:feedback-list', () => ({ ok: true, feedback: [] }));
  handle('desktop:get-update-state', () => manager.snapshot());
  handle('desktop:get-update-proxy-state', () => network.snapshot());
  handle('desktop:check-for-updates', () => manager.checkForUpdates());
  handle('desktop:download-update', () => manager.downloadUpdate());
  handle('desktop:cancel-update-download', () => manager.cancelUpdateDownload());
  handle('desktop:stop-update-proxy', () => network.stopInternalProxy());
  handle('desktop:resume-update-proxy', () => network.resumeInternalProxy());
  win = new BrowserWindow({ show: false, width: 1180, height: 900, useContentSize: true,
    webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  const evaluate = source => win.webContents.executeJavaScript(source, true);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function check(source, label, timeoutMs = scenario.timeoutMs || 60000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await evaluate(source)) return;
      await sleep(30);
    }
    throw new Error(`${label}: ${JSON.stringify(publicState(manager.snapshot()))}; renderer ${JSON.stringify(rendererErrors)}`);
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const screenshot = async label => {
    let frameTimer;
    try {
      await Promise.race([
        evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
        new Promise((_resolve, reject) => {
          frameTimer = setTimeout(() => reject(new Error(`Screenshot animation frames timed out: ${label}`)), 5000);
        })
      ]);
    } finally { clearTimeout(frameTimer); }
    const file = path.join(output, `${label}.png`);
    const png = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { win.webContents.removeListener('paint', paint); reject(new Error('Screenshot paint timeout')); }, 5000);
      const paint = (_event, _dirty, frame) => {
        if (frame.isEmpty()) return;
        clearTimeout(timer); win.webContents.removeListener('paint', paint); resolve(frame.toPNG());
      };
      win.webContents.on('paint', paint); win.webContents.invalidate();
    });
    fs.writeFileSync(file, png); screenshots[label] = file;
  };
  await win.loadURL('xhs-app://local/');
  await check('document.body.dataset.desktopReady === "true"', 'actual desktop renderer initializes', 15000);
  await click('#about-tab');
  await click('#desktop-check-updates');
  await check('document.querySelector("#desktop-update-dialog").open && document.querySelector("#desktop-update-dialog-action").dataset.action === "download" && !document.querySelector("#desktop-update-dialog-action").disabled', 'real manager discovers release');
  await click('#desktop-update-dialog-action');
  for (const count of [1, 9]) {
    await check(`document.querySelector('#desktop-update-message').textContent.includes('连续失败 ${count}/10 次') && document.querySelector('#desktop-update-dialog-progress-text').textContent.includes('连续失败 ${count}/10 次')`, `real IPC displays retry ${count}`);
    assert.equal(manager.snapshot().retry.consecutiveFailures, count);
    assert.equal(await evaluate(`!document.querySelector('#desktop-update-cancel').disabled && !document.querySelector('#desktop-update-dialog-action').disabled`), true);
    await screenshot(`retry-${count}`);
  }
  await check(`document.querySelector('#desktop-update-dialog-error').textContent.includes('连续失败 10 次') && !document.querySelector('#desktop-update-dialog-action').disabled`, 'real manager reaches ten-failure manual recovery');
  const exhausted = manager.snapshot();
  assert.equal(exhausted.status, 'error'); assert.equal(exhausted.retry.active, false);
  assert.equal(exhausted.retry.consecutiveFailures, 10); assert.equal(exhausted.canRetry, true);
  assert.deepEqual([...new Set(states.filter(state => state.retry?.active).map(state => state.retry.consecutiveFailures))], [1,2,3,4,5,6,7,8,9]);
  assert.equal(calls.filter(channel => channel === 'desktop:download-update').length, 1);
  await screenshot('retry-10-manual');
  await sleep(850);
  assert.equal(manager.snapshot().retry.consecutiveFailures, 10);
  await scenario.beforeManualRetry?.({ manager, network });
  const manualIndex = states.length;
  await click('#desktop-update-dialog-action');
  await check(`document.querySelector('#desktop-update-dialog-action').dataset.action === 'install' && !document.querySelector('#desktop-update-dialog-action').disabled`, 'manual continuation downloads and verifies successfully');
  const completed = manager.snapshot();
  assert.equal(completed.status, 'downloaded'); assert.equal(completed.retry, null);
  assert.equal(completed.download.percent, 100);
  assert.ok(states.slice(manualIndex).some(state => state.status === 'downloading' && state.retry === null), 'manual operation resets retry counter');
  assert.equal(calls.filter(channel => channel === 'desktop:download-update').length, 2);
  assert.equal(network.snapshot().activeScopes || 0, 0);
  if (!scenario.live) {
    assert.equal(attempts, 11); assert.equal(opens, closes);
    assert.deepEqual(await fsp.readFile(manager.verifiedFile), content);
  }
  await screenshot('manual-success');
  assert.deepEqual(rendererErrors, []);
  const result = { status: 'passed', live: scenario.live === true,
    note: scenario.live ? 'Actual scenario network and actual UpdateManager, IPC, preload, renderer.' : 'Deterministic network eligibility/stream fixture; actual UpdateManager, IPC, preload, renderer. This mode does not prove a real proxy tunnel.',
    repoRoot: root, actualPreload: path.join(root, 'desktop/preload.cjs'), checkedAt: new Date().toISOString(),
    retryCounts: [1,2,3,4,5,6,7,8,9,10], exhausted: publicState(exhausted), completed: publicState(completed),
    networkAfter: network.snapshot(), deterministicAttempts: scenario.live ? undefined : attempts,
    states, diagnostics, screenshots, profileDirectory: path.join(output, 'profile') };
  await finish(0, null, result);
}
main().catch(error => void finish(1, error));
