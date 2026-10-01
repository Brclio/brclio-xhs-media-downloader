// Exercise quitting while the real main window is still loading. A cancelled
// startup must finish ordinary shutdown without opening a blocking error box.
import { app, BrowserWindow, dialog, protocol, session } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecureAccountStore } from '../desktop/account-storage.js';
import { XhsBrowser } from '../desktop/profile-browser.js';
import { ProfileManager } from '../desktop/profile-manager.js';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const failStartup = process.argv.includes('--startup-failure');
const temporary = mkdtempSync(path.join(tmpdir(), 'brclio-startup-quit-'));
app.commandLine.appendSwitch('use-mock-keychain');
app.setName(pkg.productName);
app.setPath('userData', temporary);
app.setPath('sessionData', temporary);
app.getAppPath = () => root;
app.getVersion = () => pkg.version;
process.env.XHS_ACCOUNT_ENDPOINT = 'https://account-fixture.invalid/api/account';
SecureAccountStore.prototype.load = async () => null;
XhsBrowser.prototype.getLoginState = async () => ({ status: 'signed_out', loggedIn: false });
globalThis.fetch = async () => { throw new Error('Unexpected external request in startup quit fixture'); };
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true })));

const shutdown = ProfileManager.prototype.shutdown;
ProfileManager.prototype.shutdown = async function () {
  // Model an ordinary pending state flush so the navigation rejection reaches
  // boot while the real before-quit sequence is still running.
  await delay(200);
  return shutdown.call(this);
};
let requested = false, closed = false, loadFailed = false;
const load = BrowserWindow.prototype.loadURL;
BrowserWindow.prototype.loadURL = function (...args) {
  return load.apply(this, args).catch(error => { loadFailed = true; throw error; });
};
const errorBoxes = [];
dialog.showErrorBox = (title, content) => { errorBoxes.push({ title, content }); };
const register = protocol.handle.bind(protocol);
protocol.handle = (scheme, handler) => register(scheme, async request => {
  if (scheme !== 'xhs-app' || new URL(request.url).pathname !== '/') return handler(request);
  requested = true;
  const win = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
  assert.ok(win, 'The real main window requested its packaged page');
  win.once('closed', () => { closed = true; });
  if (failStartup) return Response.error();
  win.webContents.once('did-fail-load', () => { loadFailed = true; });
  // Hold the real navigation until the user closes its window. This guarantees
  // loadURL is pending; no synthetic boot promise or shutdown hook is used.
  await new Promise(resolve => {
    win.once('closed', () => setTimeout(resolve, 25));
    setImmediate(() => win.close());
  });
  return handler(request);
});

const watchdog = setTimeout(() => { console.error('STARTUP_QUIT_FAILED: timeout'); app.exit(1); }, 15000);
app.once('quit', () => {
  clearTimeout(watchdog);
  try {
    assert.equal(requested, true);
    assert.equal(closed, true);
    assert.equal(loadFailed, true, 'Closing actually interrupted the pending navigation');
    if (failStartup) {
      assert.equal(errorBoxes.length, 1, 'A genuine startup failure must still be reported');
      assert.equal(errorBoxes[0].title, '无法启动 Brclio 小红书下载器');
    } else assert.deepEqual(errorBoxes, [], 'An intentional quit must not show a startup error dialog');
    const events = readFileSync(path.join(temporary, 'diagnostics/events.ndjson'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.event === 'app.stopped'), 'Ordinary shutdown flushed its diagnostics');
    assert.equal(events.some(event => event.event === 'app.start_failed'), failStartup);
    console.log(JSON.stringify({ startupQuitVerified: !failStartup, startupFailureVerified: failStartup,
      navigationInterrupted: true, errorBoxes: errorBoxes.length }));
  } catch (error) {
    console.error(error);
    try { rmSync(temporary, { recursive: true, force: true }); } catch { /* Profile handles may remain. */ }
    app.exit(1);
    return;
  }
  try { rmSync(temporary, { recursive: true, force: true }); } catch { /* Windows may still be releasing handles. */ }
});
await import('../desktop/main.js');
