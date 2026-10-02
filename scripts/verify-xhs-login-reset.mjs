// Run with Node. A fresh Electron process and temporary profile verify real
// session cleanup without reading the user's cookies, accounts or installed app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const partition = 'persist:xhs-account';
const signedOut = { status: 'logged-out', loggedIn: false, nickname: '', userId: '' };

if (!process.versions.electron) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-login-reset-'));
  const electronBinary = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(electronBinary, [script, '--worker', temporary], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const collect = chunk => { output = (output + chunk.toString()).slice(-12000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`XHS login reset verification timed out: ${output.slice(-4000)}`));
      }, 45000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`XHS login reset verification failed (${signal || code}): ${output.slice(-8000)}`));
          return;
        }
        const report = output.split('\n').find(line => line.startsWith('{"smoke":"xhs-login-reset-passed"'));
        if (!report) { reject(new Error(`Verification returned no success report: ${output.slice(-4000)}`)); return; }
        process.stdout.write(`${report}\n`);
        resolve();
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const { XhsBrowser } = await import('../desktop/profile-browser.js');
  const temporary = process.argv[3];
  if (process.argv[2] !== '--worker' || !temporary) throw new Error('Expected an isolated worker directory');
  await mkdir(path.join(temporary, 'profile'), { recursive: true });
  app.setName('Brclio XHS Login Reset Verification');
  app.setPath('userData', path.join(temporary, 'profile'));
  app.setPath('sessionData', path.join(temporary, 'profile'));
  app.commandLine.appendSwitch('disable-background-networking');
  app.on('window-all-closed', () => {});

  let browser, defaultWindow, server;
  let externalRequests = 0;
  const watchdog = setTimeout(() => {
    console.error('XHS_LOGIN_RESET_SMOKE_FAILED: worker timeout');
    app.exit(1);
  }, 40000);
  const progress = message => process.stderr.write(`XHS login reset: ${message}\n`);

  // Both sessions use the same localhost origin so preserving the default
  // partition proves that cleanup targets the XHS partition, not an origin.
  const seed = `async label => {
    localStorage.setItem('fixture-login', label);
    sessionStorage.setItem('fixture-window', label);
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('fixture-login-db', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('account');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('account', 'readwrite');
        transaction.objectStore('account').put(label, 'fixture-login');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
    const cache = await caches.open('fixture-login-cache');
    await cache.put('/fixture-cached', new Response(label));
    await navigator.serviceWorker.register('/fixture-worker.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  }`;
  const snapshot = `(async () => ({
    local: localStorage.getItem('fixture-login'),
    session: sessionStorage.getItem('fixture-window'),
    databases: (await indexedDB.databases()).map(database => database.name).sort(),
    caches: (await caches.keys()).sort(),
    workers: (await navigator.serviceWorker.getRegistrations()).map(worker => worker.scope).sort(),
  }))()`;

  // Electron waits for its entry module to finish evaluating before ready;
  // keep the ready wait inside an unawaited worker task.
  void (async () => {
  try {
    await app.whenReady();
    server = createServer((request, response) => {
      if (request.url === '/fixture-worker.js') {
        response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
        response.end("self.addEventListener('install', event => event.waitUntil(self.skipWaiting())); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));");
      } else {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end('<!doctype html><html><head><title>Isolated XHS reset fixture</title></head><body>Local storage fixture</body></html>');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const fixtureUrl = `${origin}/fixture.html`;
    const xhsSession = session.fromPartition(partition);
    for (const targetSession of [xhsSession, session.defaultSession]) {
      targetSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        const external = new URL(details.url).origin !== origin;
        if (external) externalRequests++;
        callback({ cancel: external });
      });
    }

    const loginEvents = [];
    browser = new XhsBrowser({ BrowserWindow, session, onLoginState: state => loginEvents.push(state) });
    const windows = [];
    for (const kind of ['profile', 'detail', 'account']) {
      const window = await browser.window(kind);
      assert.equal(window.webContents.session, xhsSession);
      await window.loadURL(fixtureUrl);
      windows.push(window);
    }
    defaultWindow = new BrowserWindow({ show: false, webPreferences: {
      session: session.defaultSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
    } });
    await defaultWindow.loadURL(fixtureUrl);
    progress('seeding isolated cookie, storage, database, cache and service worker');
    await xhsSession.cookies.set({ url: origin, name: 'fixture-xhs-session', value: 'xhs-test-only', httpOnly: true });
    await session.defaultSession.cookies.set({ url: origin, name: 'fixture-app-session', value: 'app-test-only', httpOnly: true });
    await windows[0].webContents.executeJavaScript(`(${seed})('xhs-test-only')`);
    await defaultWindow.webContents.executeJavaScript(`(${seed})('app-test-only')`);
    const xhsBefore = await windows[0].webContents.executeJavaScript(snapshot);
    const defaultBefore = await defaultWindow.webContents.executeJavaScript(snapshot);
    for (const value of [xhsBefore, defaultBefore]) {
      assert.deepEqual(value.databases, ['fixture-login-db']);
      assert.deepEqual(value.caches, ['fixture-login-cache']);
      assert.deepEqual(value.workers, [`${origin}/`]);
      assert.ok(value.local && value.session);
    }
    const defaultCookiesBefore = await session.defaultSession.cookies.get({});
    assert.equal((await xhsSession.cookies.get({})).length, 1);
    browser.loginState = { status: 'logged-in', loggedIn: true, nickname: 'Fixture XHS account', userId: 'fixture-xhs-user' };
    browser.blockedWindow = windows[2];

    progress('clearing XHS session and concurrently requesting a fresh window');
    const reset = browser.clearLoginData();
    assert.equal(browser.clearLoginData(), reset, 'Concurrent reset commands must reuse one cleanup operation');
    const reopening = browser.window('account');
    assert.deepEqual(await reset, signedOut);
    assert.deepEqual(browser.loginState, signedOut);
    assert.deepEqual(loginEvents.at(-1), signedOut);
    assert.ok(windows.every(window => window.isDestroyed()), 'Every old XHS window must be destroyed');
    assert.equal(browser.profileWindow, null);
    assert.equal(browser.detailWindow, null);
    assert.equal(browser.blockedWindow, null);
    const freshWindow = await reopening;
    assert.ok(!windows.includes(freshWindow) && !freshWindow.isDestroyed(), 'Reopening creates a new usable window');
    assert.equal(freshWindow.webContents.session, xhsSession);
    assert.equal(freshWindow.webContents.getURL(), 'about:blank');
    await freshWindow.loadURL(fixtureUrl);
    assert.deepEqual(await freshWindow.webContents.executeJavaScript(snapshot), {
      local: null, session: null, databases: [], caches: [], workers: [],
    }, 'The fresh XHS window must have no previous account storage');
    assert.deepEqual(await xhsSession.cookies.get({}), [], 'All XHS partition cookies must be cleared');
    assert.deepEqual(await defaultWindow.webContents.executeJavaScript(snapshot), defaultBefore,
      'The default application browser partition must retain its data');
    assert.deepEqual(await session.defaultSession.cookies.get({}), defaultCookiesBefore,
      'Application browser cookies must remain unchanged');
    assert.equal(externalRequests, 0, 'The verifier must never request external services');
    console.log(JSON.stringify({ smoke: 'xhs-login-reset-passed', platform: process.platform,
      realElectronSession: true, temporaryProfile: true, concurrentResetCoalesced: true,
      oldWindowsDestroyed: windows.length, freshWindowCreated: true, loggedOutState: true,
      cleared: ['cookies', 'localStorage', 'sessionStorage', 'IndexedDB', 'CacheStorage', 'serviceWorkers'],
      defaultPartitionPreserved: true, externalRequests, installedApplicationTested: false }));
    browser.close();
    defaultWindow.destroy();
    await new Promise(resolve => server.close(resolve));
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error('XHS_LOGIN_RESET_SMOKE_FAILED', error);
    browser?.close();
    if (defaultWindow && !defaultWindow.isDestroyed()) defaultWindow.destroy();
    server?.close();
    clearTimeout(watchdog);
    app.exit(1);
  }
  })();
}
