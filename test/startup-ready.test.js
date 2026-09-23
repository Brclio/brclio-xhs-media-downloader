import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hasPendingMacUpdate, waitForDesktopReady } from '../desktop/startup-ready.js';

function windowFixture(execute = async () => false) {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    isLoadingMainFrame: () => false, mainFrame: { url: 'xhs-app://local/', executeJavaScript: execute } });
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents });
}

function noListeners(window) {
  assert.equal(window.listenerCount('closed'), 0);
  assert.equal(window.webContents.listenerCount('destroyed'), 0);
  assert.equal(window.webContents.listenerCount('did-start-navigation'), 0);
}

test('late renderer readiness is retried, then all lifecycle listeners are removed', async () => {
  let ready = false, checks = 0;
  const window = windowFixture(async () => { checks++; return ready; });
  const result = waitForDesktopReady(window, { retryMs: 5, timeoutMs: 1000 });
  await delay(25);
  assert.ok(checks > 1, 'An incomplete renderer must remain observable');
  ready = true;
  assert.equal(await result, true);
  noListeners(window);
  const finishedChecks = checks;
  await delay(15);
  assert.equal(checks, finishedChecks);
});

test('a ready result from a replaced document cannot acknowledge the new renderer', async () => {
  let finishOld, calls = 0;
  const window = windowFixture(() => ++calls === 1 ? new Promise(resolve => { finishOld = resolve; }) : false);
  const cancel = new AbortController();
  const result = waitForDesktopReady(window, { signal: cancel.signal, retryMs: 5 });
  window.webContents.emit('did-start-navigation', {}, 'xhs-app://local/', false, true);
  finishOld(true);
  await delay(15);
  cancel.abort();
  assert.equal(await result, false);
  noListeners(window);
});

test('quit, window closure, destruction and timeout cancel without requiring renderer cooperation', async () => {
  for (const reason of ['abort', 'closed', 'destroyed', 'timeout']) {
    const window = windowFixture(() => new Promise(() => {}));
    const cancel = new AbortController();
    const result = waitForDesktopReady(window, { signal: cancel.signal, timeoutMs: 15 });
    if (reason === 'abort') cancel.abort();
    if (reason === 'closed') window.emit('closed');
    if (reason === 'destroyed') window.webContents.emit('destroyed');
    assert.equal(await result, false, reason);
    noListeners(window);
  }
});

test('only a loaded trusted main frame can supply readiness', async () => {
  let calls = 0;
  const window = windowFixture(async () => { calls++; return true; });
  window.webContents.mainFrame.url = 'https://example.invalid/';
  assert.equal(await waitForDesktopReady(window, { timeoutMs: 15, retryMs: 5 }), false);
  window.webContents.mainFrame.url = 'xhs-app://local/';
  window.webContents.isLoadingMainFrame = () => true;
  assert.equal(await waitForDesktopReady(window, { timeoutMs: 15, retryMs: 5 }), false);
  assert.equal(calls, 0);
  noListeners(window);
});

test('only relevant unfinished update history schedules the long readiness wait', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'xhs-startup-hint-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const currentAppPath = path.join(directory, 'Current.app');
  const cacheDirectory = path.join(directory, 'updates');
  await mkdir(currentAppPath);
  await mkdir(cacheDirectory);
  const options = { cacheDirectory, currentAppPath, currentVersion: '1.8.6' };
  assert.equal(await hasPendingMacUpdate(options), false);
  const work = path.join(cacheDirectory, 'mac-install-aB1234');
  await mkdir(work);
  const filename = path.join(work, 'install-result.json');
  const record = { appId: 'cn.bornforthis.xhs-downloader', currentAppPath,
    version: '1.8.6', schemaVersion: 2, status: 'awaiting_startup' };
  const save = value => writeFile(filename, JSON.stringify(value));
  await save(record);
  assert.equal(await hasPendingMacUpdate(options), true);
  for (const override of [{ backupRemoved: true }, { currentAppPath: `${currentAppPath}.other` },
    { version: '1.8.7' }, { appId: 'another.app' }, { status: 'rolled_back' }]) {
    await save({ ...record, ...override });
    assert.equal(await hasPendingMacUpdate(options), false, JSON.stringify(override));
  }
  await save({ ...record, version: '1.8.5', status: 'cleanup_failed', startupConfirmed: true });
  assert.equal(await hasPendingMacUpdate(options), true, 'Interrupted cleanup remains recoverable');
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).status, 'cleanup_failed', 'The hint never mutates update records');
});
