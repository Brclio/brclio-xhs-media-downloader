// Real Electron main/preload/UI regression smoke with a disposable profile.
// The fixture delays core IPC and replaces storage/XHS login discovery; it
// never reads the user's Keychain, credentials, cookies or external services.
import { app, ipcMain, session } from 'electron';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SecureAccountStore, accountError } from '../desktop/account-storage.js';
import { XhsBrowser } from '../desktop/profile-browser.js';
import { waitForDesktopReady } from '../desktop/startup-ready.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const temporary = mkdtempSync(path.join(tmpdir(), 'xhs-startup-storage-'));
app.commandLine.appendSwitch('use-mock-keychain');
app.setName(pkg.productName);
app.setPath('userData', temporary);
app.setPath('sessionData', temporary);
app.getAppPath = () => root;
app.getVersion = () => pkg.version;
// Keep configured account UI, but reject any unexpected attempt to contact it.
process.env.XHS_ACCOUNT_ENDPOINT = 'https://account-fixture.invalid/api/account';
let networkAttempts = 0;
let blockedBrowserRequests = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error('Unexpected external network request in startup fixture');
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
    blockedBrowserRequests++;
    callback({ cancel: true });
  });
});
XhsBrowser.prototype.getLoginState = async function () {
  return { status: 'signed_out', loggedIn: false, nickname: '', userId: '' };
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const initialLoad = deferred(), retryLoad = deferred();
const coreReady = deferred();
let coreRequests = 0;
const registerHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => registerHandle(channel, channel === 'desktop:get-profile-state'
  ? async (...args) => { const result = await callback(...args); coreRequests++; await coreReady.promise; return result; }
  : callback);
let loadCalls = 0;
SecureAccountStore.prototype.load = async function () {
  assert.equal(this.filename, path.join(temporary, 'account', 'account-v1.enc'));
  loadCalls++;
  if (loadCalls === 1) return initialLoad.promise;
  if (loadCalls === 2) return retryLoad.promise;
  throw new Error('Storage must not be prompted again without a new explicit retry');
};
SecureAccountStore.prototype.save = async function () {
  throw new Error('This signed-out fixture must never persist account credentials');
};

async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function snapshot(win) {
  return win.webContents.executeJavaScript(`(async () => ({
    state: await window.xhsDesktop.getAccountState(),
    ready: document.body.dataset.desktopReady === 'true',
    buttons: [...document.querySelectorAll('#software-account button')].map(button => ({ id: button.id, disabled: button.disabled })),
    retryLabel: document.querySelector('#account-refresh')?.textContent,
    nodeAvailable: typeof require === 'function'
  }))()`);
}

async function singleNoteCheck(win) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#single-note-tab').click();
    const payloads = [];
    for (const route of ['/api/parse', '/api/python_parse']) {
      const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'https://sns-img-bd.xhscdn.com/startup-storage-fixture-image' }) });
      const data = await response.json();
      payloads.push({ route, status: response.status, success: data.success, images: data.images?.length });
    }
    return { payloads, selected: document.querySelector('#single-note-tab').getAttribute('aria-selected') };
  })()`);
  assert.equal(result.selected, 'true', 'Navigation stays interactive while secure storage is unavailable');
  assert.equal(result.payloads.length, 2);
  for (const payload of result.payloads) {
    assert.equal(payload.status, 200, payload.route);
    assert.equal(payload.success, true, payload.route);
    assert.equal(payload.images, 1, payload.route);
  }
}

let started = false, finished = false;
const watchdog = setTimeout(() => {
  console.error('STARTUP_STORAGE_SMOKE_FAILED: timeout');
  app.exit(1);
}, 45000);
app.once('quit', () => {
  clearTimeout(watchdog);
  try { rmSync(temporary, { recursive: true, force: true }); } catch { /* OS may still be closing a profile handle. */ }
});

app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (started || !win.webContents.getURL().startsWith('xhs-app://local/')) return;
    started = true;
    try {
      await until(() => loadCalls === 1, 'delayed storage initialization');
      await until(() => win.isVisible(), 'visible application before storage resolves');
      // Delay real desktop-ui.js initialization, not a synthetic ready flag.
      // This exceeds the old one-shot 10 s timeout and survives a real reload.
      await until(() => coreRequests === 1, 'delayed core renderer IPC');
      const readyStarted = Date.now();
      const ready = waitForDesktopReady(win);
      const cancel = new AbortController();
      const cancelled = waitForDesktopReady(win, { signal: cancel.signal });
      cancel.abort();
      assert.equal(await cancelled, false, 'Quit cancels startup readiness immediately');
      const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      win.webContents.reload();
      await reloaded;
      await until(() => coreRequests >= 2, 'core renderer IPC after reload');
      await delay(10500);
      assert.equal((await snapshot(win)).ready, false, 'An incomplete core UI must not confirm startup');
      assert.equal(loadCalls, 1, 'Reload must not repeat secure storage initialization');
      coreReady.resolve();
      assert.equal(await ready, true, 'A real renderer ready after 10 s must still confirm startup');
      const rendererReadyDelayMs = Date.now() - readyStarted;
      assert.ok(rendererReadyDelayMs > 10000);
      const loading = await until(async () => {
        const value = await snapshot(win);
        return value.ready && value.buttons.length && value.state.status === 'initializing' ? value : null;
      }, 'ready renderer with pending secure storage');
      assert.equal(loading.nodeAvailable, false);
      assert.ok(loading.buttons.every(button => button.disabled), 'Every account operation is disabled during startup');
      await singleNoteCheck(win);
      assert.equal(loadCalls, 1, 'Using free features must not repeat the storage prompt');

      initialLoad.reject(accountError('SECURE_STORAGE_UNAVAILABLE', 'Fixture: Keychain access declined; original credentials retained.'));
      const denied = await until(async () => {
        const value = await snapshot(win);
        return value.state.status === 'secure_storage_unavailable' ? value : null;
      }, 'nonblocking denied storage state');
      assert.equal(denied.retryLabel, '重试安全存储');
      assert.equal(denied.buttons.find(button => button.id === 'account-refresh')?.disabled, false);
      assert.ok(denied.buttons.filter(button => button.id !== 'account-refresh').every(button => button.disabled));
      await singleNoteCheck(win);
      await delay(200);
      assert.equal(loadCalls, 1, 'A denied load must not automatically re-prompt');

      await win.webContents.executeJavaScript(`document.querySelector('#account-refresh').click(); document.querySelector('#account-refresh').click();`);
      await until(() => loadCalls === 2, 'explicit storage retry');
      const retrying = await snapshot(win);
      assert.equal(retrying.state.status, 'initializing');
      assert.ok(retrying.buttons.every(button => button.disabled));
      // Exercise rapid IPC retries too; AccountClient must share one pending load.
      await win.webContents.executeJavaScript(`window.__storageRetry = Promise.all([
        window.xhsDesktop.refreshAccount(), window.xhsDesktop.refreshAccount()
      ]); undefined;`);
      await delay(100);
      assert.equal(loadCalls, 2, 'Concurrent retry commands must share the existing prompt');

      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      retryLoad.resolve({ version: 1,
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        stableIdHash: 'a'.repeat(64), token: null, pendingLogoutTokens: [], pendingRedemptions: {} });
      const replies = await win.webContents.executeJavaScript('window.__storageRetry');
      assert.ok(replies.every(reply => reply.ok && reply.state.status === 'signed_out'));
      const recovered = await until(async () => {
        const value = await snapshot(win);
        return value.state.status === 'signed_out' && value.buttons.every(button => !button.disabled) ? value : null;
      }, 'recovered account controls');
      assert.equal(recovered.state.error, null);
      await win.webContents.executeJavaScript('window.xhsDesktop.refreshAccount()');
      assert.equal(loadCalls, 2, 'Ordinary refresh must reuse loaded credentials');
      assert.equal(networkAttempts, 0, 'The test must not contact external services');
      finished = true;
      clearTimeout(watchdog);
      console.log(JSON.stringify({ smoke: 'startup-storage-passed', visibleBeforeStorage: true,
        responsiveWhilePending: true, controlsGuarded: true, deniedStateRecoverable: true,
        explicitRetryDeduplicated: true, singleNoteEngines: ['node', 'python'], loadCalls, networkAttempts, blockedBrowserRequests,
        rendererReadyDelayMs, lateRendererConfirmed: true, reloadRecovered: true, readinessCancelled: true,
        nativeKeychainTested: false }));
      app.quit();
    } catch (error) {
      clearTimeout(watchdog);
      console.error('STARTUP_STORAGE_SMOKE_FAILED', error);
      app.exit(1);
    }
  });
});
await import('../desktop/main.js');
app.once('will-quit', () => { if (!finished) process.exitCode = 1; });
