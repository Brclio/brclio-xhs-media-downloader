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
let publicReviewRequests = 0;
let publicGoogleConfigRequests = 0;
globalThis.fetch = async (url, options = {}) => {
  // Public account configuration and reviews are independent of credential
  // storage. Keep them local while rejecting every unexpected/private action.
  const body = JSON.parse(options.body || '{}');
  if (url === process.env.XHS_ACCOUNT_ENDPOINT && body.action === 'google-config') {
    assert.equal(options.headers?.Authorization, undefined, 'Google configuration must not send an account token');
    assert.equal(body.proof, undefined, 'Google configuration must not access a signing key');
    assert.deepEqual(body.input, { client: 'desktop' });
    publicGoogleConfigRequests++;
    return new Response(JSON.stringify({ ok: true, enabled: true }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url === process.env.XHS_ACCOUNT_ENDPOINT && body.action === 'reviews-public') {
    assert.equal(options.headers?.Authorization, undefined, 'Public reviews must not send an account token');
    assert.equal(body.proof, undefined, 'Public reviews must not access a signing key');
    publicReviewRequests++;
    return new Response(JSON.stringify({ ok: true, reviews: [], total: 0,
      page: 1, pageSize: 6, totalPages: 0, summary: { count: 0, averageRating: 0 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  }
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
  return win.webContents.executeJavaScript(`(async () => {
    const state = await window.xhsDesktop.getAccountState();
    // The account tab may be inactive. Check operations regardless of parent
    // visibility, and check contextual Google controls by their own sections.
    const buttons = [...document.querySelectorAll('#software-account button')]
      .filter(button => !button.closest('#membership-dialog') && button.id !== 'account-open-membership')
      .map(button => ({ id: button.id, disabled: button.disabled }));
    return {
      state,
      ready: document.body.dataset.desktopReady === 'true',
      // Account operations must wait for secure storage. The membership dialog
      // only browses prices or navigates to login; its controls have separate guards.
      buttons,
      operationButtons: buttons.filter(button => !['account-google-confirm', 'account-google-decline', 'account-google-cancel'].includes(button.id)),
      google: {
        loginRowHidden: document.querySelector('#account-google-login-row')?.hidden,
        confirmationHidden: document.querySelector('#account-google-confirmation')?.hidden,
        cancelHidden: document.querySelector('#account-google-cancel')?.hidden,
      },
      membership: {
        browseDisabled: document.querySelector('#account-open-membership')?.disabled,
        paymentHidden: document.querySelector('#membership-payment')?.hidden,
        emailHidden: document.querySelector('#membership-email-row')?.hidden,
        copyDisabled: document.querySelector('#membership-copy-email')?.disabled,
        loginGuidanceHidden: document.querySelector('#membership-login-guidance')?.hidden
      },
      retryLabel: document.querySelector('#account-refresh')?.textContent,
      nodeAvailable: typeof require === 'function'
    };
  })()`);
}

function assertIdleGoogleControls(value, loginDisabled) {
  assert.deepEqual(value.google, { loginRowHidden: false, confirmationHidden: true, cancelHidden: true },
    'Google login stays available while confirmation and cancellation controls remain contextual');
  assert.deepEqual(value.buttons.filter(button => !value.operationButtons.some(operation => operation.id === button.id))
    .map(button => button.id).sort(), ['account-google-cancel', 'account-google-confirm', 'account-google-decline']);
  assert.equal(value.operationButtons.find(button => button.id === 'account-google-login')?.disabled, loginDisabled,
    'Google login follows the secure storage guard');
}

function assertSignedOutMembershipGuard(value) {
  assert.deepEqual(value.membership, {
    browseDisabled: false, paymentHidden: true, emailHidden: true,
    copyDisabled: true, loginGuidanceHidden: false,
  }, 'Users can view plans and login guidance, but payment codes and email copying require their verified account');
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
        return value.ready && value.operationButtons.length && value.google.loginRowHidden === false
          && value.state.status === 'initializing' ? value : null;
      }, 'ready renderer with pending secure storage');
      assert.equal(loading.nodeAvailable, false);
      assert.deepEqual(loading.operationButtons.map(button => button.id).sort(), [
        'account-google-login', 'account-login', 'account-logout', 'account-redeem', 'account-refresh', 'account-send-code', 'orders-refresh',
      ], 'The guard covers every existing account operation');
      assert.ok(loading.operationButtons.every(button => button.disabled), 'Every account operation is disabled during startup');
      assertIdleGoogleControls(loading, true);
      assertSignedOutMembershipGuard(loading);
      await singleNoteCheck(win);
      assert.equal(loadCalls, 1, 'Using free features must not repeat the storage prompt');

      initialLoad.reject(accountError('SECURE_STORAGE_UNAVAILABLE', 'Fixture: Keychain access declined; original credentials retained.'));
      const denied = await until(async () => {
        const value = await snapshot(win);
        return value.state.status === 'secure_storage_unavailable' ? value : null;
      }, 'nonblocking denied storage state');
      assert.equal(denied.retryLabel, '重试安全存储');
      assert.equal(denied.operationButtons.find(button => button.id === 'account-refresh')?.disabled, false);
      assert.ok(denied.operationButtons.filter(button => button.id !== 'account-refresh').every(button => button.disabled));
      assertIdleGoogleControls(denied, true);
      assertSignedOutMembershipGuard(denied);
      await singleNoteCheck(win);
      await delay(200);
      assert.equal(loadCalls, 1, 'A denied load must not automatically re-prompt');

      await win.webContents.executeJavaScript(`document.querySelector('#account-refresh').click(); document.querySelector('#account-refresh').click();`);
      await until(() => loadCalls === 2, 'explicit storage retry');
      const retrying = await snapshot(win);
      assert.equal(retrying.state.status, 'initializing');
      assert.ok(retrying.operationButtons.every(button => button.disabled));
      assertIdleGoogleControls(retrying, true);
      assertSignedOutMembershipGuard(retrying);
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
        return value.state.status === 'signed_out' && value.operationButtons.every(button => !button.disabled) ? value : null;
      }, 'recovered account controls');
      assert.equal(recovered.state.error, null);
      assertIdleGoogleControls(recovered, false);
      assertSignedOutMembershipGuard(recovered);
      await win.webContents.executeJavaScript('window.xhsDesktop.refreshAccount()');
      assert.equal(loadCalls, 2, 'Ordinary refresh must reuse loaded credentials');
      assert.ok(publicReviewRequests > 0, 'Anonymous reviews remain available while credential storage initializes');
      assert.ok(publicGoogleConfigRequests > 0, 'Google configuration remains available while credential storage initializes');
      assert.equal(networkAttempts, 0, 'The test must not contact external services');
      finished = true;
      clearTimeout(watchdog);
      console.log(JSON.stringify({ smoke: 'startup-storage-passed', visibleBeforeStorage: true,
        responsiveWhilePending: true, controlsGuarded: true, deniedStateRecoverable: true,
        signedOutMembershipGuarded: true,
        explicitRetryDeduplicated: true, singleNoteEngines: ['node', 'python'], loadCalls, networkAttempts, blockedBrowserRequests, publicReviewRequests, publicGoogleConfigRequests,
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
