import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { XhsBrowser } from '../desktop/profile-browser.js';
import { XhsLoginReset } from '../desktop/xhs-login-reset.js';

const loggedOut = { status: 'logged-out', loggedIn: false, nickname: '', userId: '' };
const signedIn = { status: 'logged-in', loggedIn: true, nickname: '旧账号', userId: '111111111111111111111111' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function browserFixture(t) {
  const events = [], updates = [], windows = [];
  const store = {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    async clearStorageData(options) { events.push(['storage', options]); },
    async closeAllConnections() { events.push(['connections']); },
    async clearData() { events.push(['data']); },
    async clearAuthCache() { events.push(['auth']); },
    async clearCodeCaches(options) { events.push(['code', options]); },
    async clearHostResolverCache() { events.push(['dns']); },
    flushStorageData() { events.push(['flush-storage']); },
    cookies: { async flushStore() { events.push(['flush-cookies']); } }
  };
  class Window extends EventEmitter {
    constructor() {
      super(); windows.push(this); this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {}, stop: () => events.push(['stop']),
        getURL: () => this.url || '', executeJavaScript: async () => signedIn
      });
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; events.push(['destroy']); }
    show() {} focus() {} hide() {}
  }
  const browser = new XhsBrowser({ BrowserWindow: Window, session: {
    fromPartition(partition) { assert.equal(partition, 'persist:xhs-account'); return store; }
  }, onLoginState: state => updates.push(state) });
  t.after(() => browser.close());
  return { browser, store, events, updates, windows };
}

test('cancelled reset does not pause jobs or clear login data', async () => {
  const reset = new XhsLoginReset({ confirm: async () => false,
    manager: { clearLoginData() { assert.fail('cancel must not mutate data'); } } });
  assert.deepEqual(await reset.run(), { cancelled: true });
  assert.equal(reset.busy, false);
});

test('confirmation and cleanup are shared and restart commands stay blocked until completion', async () => {
  const confirmation = deferred(), cleanup = deferred();
  let prompts = 0, calls = 0;
  const reset = new XhsLoginReset({ confirm: () => { prompts++; return confirmation.promise; },
    manager: { clearLoginData() { calls++; return cleanup.promise; } } });
  const first = reset.run();
  assert.equal(reset.run(), first);
  assert.equal(reset.busy, true);
  assert.throws(() => reset.assertIdle(), /正在清除/);
  assert.equal(calls, 0);
  confirmation.resolve(true);
  await Promise.resolve();
  assert.equal(prompts, 1);
  assert.equal(calls, 1);
  assert.throws(() => reset.assertIdle(), /正在清除/);
  cleanup.resolve({ loginState: loggedOut, profileState: { status: 'paused' } });
  const result = await first;
  assert.deepEqual(result.loginState, loggedOut);
  assert.equal(result.profileState.status, 'paused');
  assert.match(result.message, /其它账号/);
  assert.equal(reset.busy, false);
  reset.assertIdle();
});

test('failed cleanup reports failure and permits a new confirmation and retry', async () => {
  let calls = 0;
  const reset = new XhsLoginReset({ confirm: async () => true, manager: {
    async clearLoginData() { if (++calls === 1) throw Error('storage failed'); return { loginState: loggedOut }; }
  } });
  await assert.rejects(reset.run(), /storage failed/);
  assert.equal(reset.busy, false);
  assert.deepEqual((await reset.run()).loginState, loggedOut);
});

test('a completed reset still rejects operations carrying a pre-confirmation revision', async () => {
  const reset = new XhsLoginReset({ confirm: async () => true,
    manager: { async clearLoginData() { return { loginState: loggedOut }; } } });
  const revision = reset.revision;
  await reset.run();
  assert.equal(reset.busy, false);
  assert.throws(() => reset.assertIdle(revision), /登录状态已变更/);
  reset.assertIdle(reset.revision);
});

test('reset destroys all old helpers before clearing the entire isolated XHS partition', async t => {
  const f = browserFixture(t);
  for (const kind of ['profile', 'detail', 'account']) await f.browser.window(kind);
  f.browser.loginState = signedIn;
  f.browser.blockedWindow = f.windows[0];
  assert.deepEqual(await f.browser.clearLoginData(), loggedOut);
  assert.ok(f.windows.every(win => win.isDestroyed()));
  for (const key of ['profileWindow', 'detailWindow', 'accountWindow']) {
    assert.equal(f.browser[key], null);
    assert.equal(f.browser[`${key}Ready`], null);
  }
  assert.equal(f.browser.blockedWindow, null);
  assert.equal(f.browser.loginTimer, null);
  assert.equal(f.events.filter(([event]) => event === 'destroy').length, 3);
  assert.ok(f.events.findIndex(([event]) => event === 'storage') > f.events.map(([event]) => event).lastIndexOf('destroy'));
  assert.deepEqual(f.events.slice(-8), [
    ['storage', { storages: ['serviceworkers'] }], ['connections'], ['data'], ['auth'], ['code', {}],
    ['dns'], ['flush-storage'], ['flush-cookies']
  ]);
  assert.deepEqual(f.updates.at(-1), loggedOut);
  assert.equal(f.windows.length, 3, 'reset itself never reopens a page');
});

test('an old in-flight account snapshot cannot restore the old nickname after reset', async t => {
  const f = browserFixture(t), snapshot = deferred();
  const win = await f.browser.window('account');
  win.url = 'https://www.xiaohongshu.com/explore';
  win.webContents.executeJavaScript = () => snapshot.promise;
  const read = f.browser.refreshLogin(win);
  await f.browser.clearLoginData();
  snapshot.resolve(signedIn);
  assert.deepEqual(await read, loggedOut);
  assert.deepEqual(f.browser.loginState, loggedOut);
  assert.equal(f.updates.some(state => state.loggedIn), false);
});

test('a pre-reset login read cannot navigate or recreate a helper after its window becomes ready', async t => {
  const f = browserFixture(t), ready = deferred();
  const win = await f.browser.window('account');
  f.browser.accountWindowReady = ready.promise;
  const read = f.browser.getLoginState();
  await f.browser.clearLoginData();
  ready.resolve();
  assert.deepEqual(await read, loggedOut);
  assert.equal(win.url, 'about:blank');
  assert.equal(f.windows.length, 1);
});

test('concurrent resets share cleanup and new helper creation waits for cleanup', async t => {
  const f = browserFixture(t), cleanup = deferred();
  let calls = 0;
  f.store.clearData = () => { calls++; return cleanup.promise; };
  const first = f.browser.clearLoginData();
  assert.equal(f.browser.clearLoginData(), first);
  const loginRead = f.browser.getLoginState();
  const newWindow = f.browser.window('account');
  await Promise.resolve();
  assert.equal(f.windows.length, 0);
  cleanup.resolve();
  assert.deepEqual(await first, loggedOut);
  assert.deepEqual(await loginRead, loggedOut);
  assert.equal((await newWindow).isDestroyed(), false);
  assert.equal(calls, 1);
  assert.equal(f.windows.length, 1);
});

test('stale helper startup cannot restore a polling timer or return a destroyed window', async t => {
  const f = browserFixture(t), ready = deferred();
  const BaseWindow = f.browser.electron.BrowserWindow;
  f.browser.electron.BrowserWindow = class extends BaseWindow {
    loadURL(url) { this.url = url; return ready.promise; }
  };
  const opening = f.browser.window('account');
  const rejected = assert.rejects(opening, { code: 'AUTH_REQUIRED' });
  await f.browser.clearLoginData();
  ready.resolve();
  await rejected;
  assert.equal(f.browser.accountWindow, null);
  assert.equal(f.browser.loginTimer, null);
});

test('an obsolete snapshot completion cannot release the busy guard of a new account read', async t => {
  const f = browserFixture(t), oldSnapshot = deferred(), newSnapshot = deferred();
  const oldWin = await f.browser.window('account');
  oldWin.url = 'https://www.xiaohongshu.com/explore';
  oldWin.webContents.executeJavaScript = () => oldSnapshot.promise;
  const oldRead = f.browser.refreshLogin(oldWin);
  await f.browser.clearLoginData();
  const newWin = await f.browser.window('account');
  newWin.url = 'https://www.xiaohongshu.com/explore';
  newWin.webContents.executeJavaScript = () => newSnapshot.promise;
  const newRead = f.browser.refreshLogin(newWin);
  const marker = f.browser.loginBusy;
  oldSnapshot.resolve(signedIn);
  await oldRead;
  assert.equal(f.browser.loginBusy, marker);
  assert.deepEqual(f.browser.loginState, loggedOut);
  const switched = { ...signedIn, nickname: '新账号', userId: '222222222222222222222222' };
  newSnapshot.resolve(switched);
  assert.deepEqual(await newRead, switched);
  assert.equal(f.browser.loginBusy, false);
});

test('partial cleanup never emits successful logout and can be retried', async t => {
  const f = browserFixture(t);
  let calls = 0;
  f.browser.loginState = signedIn;
  f.store.clearData = async () => { if (++calls === 1) throw Error('disk error'); };
  await assert.rejects(f.browser.clearLoginData(), /disk error/);
  assert.equal(f.browser.resetPromise, null);
  assert.equal(f.browser.loginState.status, 'unknown');
  assert.equal(f.updates.some(state => state.status === 'logged-out'), false);
  assert.deepEqual(await f.browser.clearLoginData(), loggedOut);
});
