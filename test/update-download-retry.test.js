import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpdateManager, LATEST_RELEASE_URL, installerName } from '../desktop/update-manager.js';

const content = Buffer.from('installer bytes used to verify automatic retry and saved download progress');
const digest = createHash('sha256').update(content).digest('hex');
const name = installerName('1.7.0', 'darwin', 'arm64');
const assetUrl = `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v1.7.0/${name}`;
const release = { tag_name: 'v1.7.0', draft: false, prerelease: false,
  html_url: 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v1.7.0',
  body: 'Trusted release notes', published_at: '2026-09-20T00:00:00Z',
  assets: [{ name, size: content.length, browser_download_url: assetUrl, digest: `sha256:${digest}` }] };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function proxyScope({ internal = true, beforeWork } = {}) {
  const controllers = [];
  let active = false, enables = 0, opens = 0, closes = 0;
  return { controllers,
    get enables() { return enables; }, get opens() { return opens; }, get closes() { return closes; },
    async requestInternalProxyForUserOperation() { enables++; },
    async run(controller, work, { onInternalProxy } = {}) {
      assert.equal(active, false, 'the previous network scope closes before the next attempt');
      assert.equal(controller.signal.aborted, false, 'every new network scope starts with a live signal');
      active = true; controllers.push(controller); opens++;
      try {
        if (internal) onInternalProxy?.();
        await beforeWork?.(controller);
        return await work();
      } finally { active = false; closes++; }
    }
  };
}

async function fixture(t, { assetFetch = () => new Response(content), ...options } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'xhs-update-retry-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [], states = [];
  const onUpdate = options.onUpdate;
  const manager = new UpdateManager({ currentVersion: '1.6.0', platform: 'darwin', arch: 'arm64',
    directory, networkTimeoutMs: 1000, downloadRetryDelayMs: 0, ...options,
    onUpdate: state => { states.push(state); onUpdate?.(state); },
    fetchImpl: async (url, init) => {
      requests.push({ url, signal: init.signal, range: new Headers(init.headers).get('range') });
      if (url === LATEST_RELEASE_URL) return Response.json(release);
      assert.equal(url, assetUrl, 'every retry uses the previously validated release asset');
      return assetFetch(url, init);
    }
  });
  assert.equal((await manager.checkForUpdates()).status, 'available');
  return { manager, directory, requests, states, partial: path.join(directory, `${name}.${digest}.partial`) };
}

function rangedResponse(offset, bytes = content.subarray(offset)) {
  return new Response(bytes, { status: 206, headers: {
    'content-range': `bytes ${offset}-${content.length - 1}/${content.length}`,
    'content-length': String(content.length - offset)
  } });
}

function failures(states) {
  return [...new Set(states.filter(state => state.retry?.active).map(state => state.retry.consecutiveFailures))];
}

test('internal proxy download timeout retries with a fresh signal and clears retry state after success', async t => {
  const networkScope = proxyScope();
  let attempts = 0;
  const f = await fixture(t, { networkScope, networkTimeoutMs: 15,
    assetFetch: () => ++attempts === 1 ? new Promise(() => {}) : new Response(content) });
  const result = await f.manager.downloadUpdate();
  assert.equal(result.status, 'downloaded');
  assert.equal(result.retry, null); assert.equal(result.error, null);
  assert.deepEqual(failures(f.states), [1]);
  const retry = f.states.find(state => state.retry?.active);
  assert.equal(retry.status, 'downloading'); assert.equal(retry.canRetry, false);
  assert.deepEqual(retry.retry, { active: true, consecutiveFailures: 1, limit: 10,
    lastError: { code: 'TIMEOUT', message: '更新服务器响应超时，请重试。' } });
  const downloadRequests = f.requests.filter(request => request.url === assetUrl);
  assert.equal(downloadRequests.length, 2);
  assert.notEqual(downloadRequests[0].signal, downloadRequests[1].signal);
  assert.equal(downloadRequests[0].signal.aborted, true);
  assert.equal(downloadRequests[1].signal.aborted, false);
  assert.equal(new Set(networkScope.controllers).size, 3, 'check and both attempts have distinct network controllers');
  assert.equal(networkScope.opens, networkScope.closes);
  assert.equal(networkScope.enables, 2, 'automatic attempts do not re-enable a manually stopped proxy');
  assert.equal(f.requests.filter(request => request.url === LATEST_RELEASE_URL).length, 1);
  assert.deepEqual(await readFile(f.manager.verifiedFile), content);
});

test('internal proxy stream interruption immediately retains bytes and automatically resumes with Range', async t => {
  const offset = 11;
  let streamController, interrupted = false, attempts = 0;
  const networkScope = proxyScope();
  const f = await fixture(t, { networkScope, onUpdate: state => {
    if (!interrupted && streamController && state.download.receivedBytes === offset) {
      interrupted = true;
      streamController.error(new Error('connection reset'));
    }
  }, assetFetch: (url, init) => {
    if (++attempts > 1) {
      assert.equal(new Headers(init.headers).get('range'), `bytes=${offset}-`);
      return rangedResponse(offset);
    }
    return new Response(new ReadableStream({ start(controller) {
      streamController = controller;
      controller.enqueue(content.subarray(0, offset));
    } }));
  } });
  assert.equal((await f.manager.downloadUpdate()).status, 'downloaded');
  const retry = f.states.find(state => state.retry?.active);
  assert.equal(retry.download.receivedBytes, offset);
  assert.equal(retry.download.canResume, true);
  assert.equal(retry.retry.lastError.code, 'NETWORK_ERROR');
  assert.deepEqual(f.requests.filter(request => request.url === assetUrl).map(request => request.range), [null, `bytes=${offset}-`]);
  assert.equal(f.requests.filter(request => request.url === LATEST_RELEASE_URL).length, 1);
  assert.deepEqual(await readdir(f.directory), [name]);
  assert.deepEqual(await readFile(f.manager.verifiedFile), content);
});

test('ten consecutive failures stop automatic retries even with partial progress and manual retry resets the counter', async t => {
  const networkScope = proxyScope();
  let attempts = 0, manualStart;
  const f = await fixture(t, { networkScope, assetFetch: (url, init) => {
    const offset = attempts;
    const range = new Headers(init.headers).get('range');
    assert.equal(range, offset ? `bytes=${offset}-` : null);
    attempts++;
    if (attempts > 10) {
      manualStart = f.manager.snapshot();
      return rangedResponse(offset);
    }
    const bytes = content.subarray(offset, offset + 1);
    return offset ? rangedResponse(offset, bytes)
      : new Response(bytes, { headers: { 'content-length': String(content.length) } });
  } });
  const failed = await f.manager.downloadUpdate();
  assert.equal(attempts, 10); assert.equal(failed.status, 'error'); assert.equal(failed.canRetry, true);
  assert.equal(failed.error.code, 'DOWNLOAD_INCOMPLETE');
  assert.deepEqual(failures(f.states), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(failed.retry, { active: false, consecutiveFailures: 10, limit: 10,
    lastError: { code: 'DOWNLOAD_INCOMPLETE', message: failed.error.message } });
  assert.equal(failed.download.receivedBytes, 10);
  assert.deepEqual(await readFile(f.partial), content.subarray(0, 10));
  assert.equal(f.manager.operation, null); assert.equal(f.manager.controller, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 10, 'exhausted automatic retries stay stopped until the user clicks');
  const completed = await f.manager.downloadUpdate();
  assert.equal(attempts, 11); assert.equal(completed.status, 'downloaded'); assert.equal(completed.retry, null);
  assert.equal(manualStart.status, 'downloading'); assert.equal(manualStart.retry, null);
  assert.equal(networkScope.enables, 3);
  assert.equal(f.requests.filter(request => request.url === LATEST_RELEASE_URL).length, 1);
  assert.deepEqual(await readFile(f.manager.verifiedFile), content);
});

for (const action of ['cancel', 'shutdown']) {
  test(`${action} during automatic retry wait cancels the whole operation and retains resumable progress`, { timeout: 2000 }, async t => {
    const waiting = deferred();
    const networkScope = proxyScope();
    const f = await fixture(t, { networkScope, downloadRetryDelayMs: 60000,
      onUpdate: state => { if (state.retry?.active) waiting.resolve(); },
      assetFetch: () => new Response(content.subarray(0, 5)) });
    const operation = f.manager.downloadUpdate();
    await waiting.promise;
    const rootController = f.manager.controller;
    if (action === 'cancel') await f.manager.cancelUpdateDownload();
    else await f.manager.shutdown();
    const result = await operation;
    assert.equal(rootController.signal.aborted, true);
    assert.equal(result.status, 'available'); assert.equal(result.error, null); assert.equal(result.retry, null);
    assert.equal(result.download.receivedBytes, 5); assert.equal(result.download.canResume, true);
    assert.deepEqual(await readFile(f.partial), content.subarray(0, 5));
    assert.equal(f.requests.filter(request => request.url === assetUrl).length, 1);
    assert.equal(networkScope.opens, networkScope.closes);
    assert.equal(f.manager.operation, null); assert.equal(f.manager.controller, null);
  });
}

test('duplicate download clicks during automatic retry keep one root controller and one retry loop', async t => {
  const waiting = deferred();
  const networkScope = proxyScope();
  let attempts = 0, rootController;
  const f = await fixture(t, { networkScope, downloadRetryDelayMs: 25,
    onUpdate: state => { if (state.retry?.active) waiting.resolve(); },
    assetFetch: () => {
      rootController ??= f.manager.controller;
      assert.equal(f.manager.controller, rootController);
      if (++attempts === 1) throw new Error('temporary disconnection');
      return new Response(content);
    }
  });
  const first = f.manager.downloadUpdate();
  await waiting.promise;
  const second = f.manager.downloadUpdate();
  const third = f.manager.downloadUpdate();
  const states = await Promise.all([first, second, third]);
  assert.ok(states.every(state => state.status === 'downloaded' && state.retry === null));
  assert.equal(attempts, 2); assert.equal(networkScope.enables, 2);
  assert.deepEqual(failures(f.states), [1]);
});

test('manual proxy stop between attempts prevents the next automatic retry from re-enabling it', async t => {
  let manuallyDisabled = false;
  const networkScope = proxyScope();
  networkScope.snapshot = () => ({ manuallyDisabled });
  const f = await fixture(t, { networkScope,
    onUpdate: state => { if (state.retry?.active) manuallyDisabled = true; },
    assetFetch: () => { throw new Error('temporary disconnection'); } });
  const result = await f.manager.downloadUpdate();
  assert.equal(result.status, 'available'); assert.equal(result.retry, null); assert.equal(result.error, null);
  assert.equal(f.requests.filter(request => request.url === assetUrl).length, 1);
  assert.equal(networkScope.enables, 2);
  assert.equal(networkScope.opens, networkScope.closes);
});

test('internal proxy update checks still report a startup failure once without automatic download retry state', async t => {
  let failCheck = false, failedScopes = 0;
  const networkScope = proxyScope({ beforeWork: () => {
    if (failCheck) { failedScopes++; throw Object.assign(new Error('proxy failed'), { code: 'PROXY_START_FAILED' }); }
  } });
  const f = await fixture(t, { networkScope });
  failCheck = true;
  const result = await f.manager.checkForUpdates();
  assert.equal(failedScopes, 1); assert.equal(result.status, 'available');
  assert.equal(result.checkError.code, 'PROXY_START_FAILED'); assert.equal(result.checkError.phase, 'check');
  assert.equal(result.retry, null); assert.deepEqual(failures(f.states), []);
});

for (const [label, networkScope] of [['direct connection', null], ['system proxy', proxyScope({ internal: false })]]) {
  test(`${label} reports a failed download once and requires a user retry`, async t => {
    let attempts = 0;
    const f = await fixture(t, { networkScope, assetFetch: () => { attempts++; throw new Error('disconnected'); } });
    const result = await f.manager.downloadUpdate();
    assert.equal(attempts, 1); assert.equal(result.status, 'error'); assert.equal(result.error.code, 'NETWORK_ERROR');
    assert.equal(result.retry, null); assert.equal(result.canRetry, true);
    assert.deepEqual(failures(f.states), []);
  });
}

test('internal proxy preparation failures retry before any installer request', async t => {
  let attempts = 0;
  const networkScope = proxyScope({ beforeWork: (controller) => {
    if (attempts++ === 1) throw Object.assign(new Error('internal proxy start failed'), { code: 'PROXY_START_FAILED' });
  } });
  const f = await fixture(t, { networkScope });
  const result = await f.manager.downloadUpdate();
  assert.equal(result.status, 'downloaded'); assert.equal(attempts, 3);
  assert.equal(f.states.find(state => state.retry?.active).retry.lastError.code, 'PROXY_START_FAILED');
  assert.equal(f.requests.filter(request => request.url === assetUrl).length, 1);
  assert.equal(networkScope.opens, networkScope.closes);
});

for (const [label, code, response] of [
  ['hash mismatch', 'HASH_MISMATCH', () => new Response(Buffer.alloc(content.length, 42))],
  ['untrusted redirect', 'UNTRUSTED_REDIRECT', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/installer' } })],
  ['invalid content range', 'INVALID_RANGE', () => new Response(content, { status: 200,
    headers: { 'content-range': `bytes 1-${content.length}/${content.length}` } })],
  ['disk full', 'DISK_FULL', () => { throw Object.assign(new Error('out of space'), { code: 'ENOSPC' }); }],
  ['non-filesystem access error', 'NETWORK_ERROR', () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }],
  ['invalid proxy configuration', 'PROXY_CONFIG_INVALID', () => { throw Object.assign(new Error('invalid configuration'), { code: 'PROXY_CONFIG_INVALID' }); }]
]) {
  test(`internal proxy ${label} does not retry automatically`, async t => {
    const networkScope = proxyScope();
    let attempts = 0;
    const f = await fixture(t, { networkScope, assetFetch: () => { attempts++; return response(); } });
    const result = await f.manager.downloadUpdate();
    assert.equal(attempts, 1); assert.equal(result.status, 'error'); assert.equal(result.error.code, code);
    assert.equal(result.retry, null); assert.equal(result.canRetry, true);
    assert.deepEqual(failures(f.states), []);
  });
}

test('an actual unreadable partial file reports cache permissions and retains bytes without retrying', async t => {
  const networkScope = proxyScope();
  const f = await fixture(t, { networkScope });
  const saved = content.subarray(0, 5);
  await writeFile(f.partial, saved);
  await chmod(f.partial, 0);
  try {
    let probe;
    try { probe = await open(f.partial, 'r+'); }
    catch (error) { assert.ok(['EACCES', 'EPERM'].includes(error.code)); }
    if (probe) {
      await probe.close();
      t.skip('this filesystem or user does not enforce the fixture file permissions');
      return;
    }
    const result = await f.manager.downloadUpdate();
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'CACHE_PERMISSION');
    assert.match(result.error.message, /缓存.*权限/); assert.equal(result.retry, null); assert.equal(result.canRetry, true);
    assert.equal(result.download.receivedBytes, saved.length); assert.equal(result.download.canResume, true);
    assert.equal(f.requests.filter(request => request.url === assetUrl).length, 0);
    assert.deepEqual(failures(f.states), []); assert.equal(networkScope.opens, networkScope.closes);
  } finally { await chmod(f.partial, 0o600); }
  assert.deepEqual(await readFile(f.partial), saved);
});

test('an invalid cache file stops before installer fetch instead of opening a retry loop', async t => {
  const networkScope = proxyScope();
  const f = await fixture(t, { networkScope });
  await symlink(path.join(f.directory, 'missing-target'), f.partial);
  const result = await f.manager.downloadUpdate();
  assert.equal(result.status, 'error'); assert.equal(result.retry, null);
  assert.equal(f.requests.filter(request => request.url === assetUrl).length, 0);
  assert.deepEqual(failures(f.states), []);
});

for (const [label, code, response] of [
  ['server failure', 'HTTP_ERROR', () => new Response(null, { status: 503 })],
  ['rate limit', 'RATE_LIMITED', () => new Response(null, { status: 429 })],
  ['access denial', 'ACCESS_DENIED', () => new Response(null, { status: 403 })],
  ['empty body', 'EMPTY_RESPONSE', () => new Response(null)],
  ['connection reset', 'NETWORK_ERROR', () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }]
]) {
  test(`internal proxy ${label} retries and succeeds without another release metadata request`, async t => {
    const networkScope = proxyScope();
    let attempts = 0;
    const f = await fixture(t, { networkScope, assetFetch: () => ++attempts === 1 ? response() : new Response(content) });
    const result = await f.manager.downloadUpdate();
    assert.equal(result.status, 'downloaded'); assert.equal(result.retry, null); assert.equal(attempts, 2);
    assert.equal(f.states.find(state => state.retry?.active).retry.lastError.code, code);
    assert.equal(f.requests.filter(request => request.url === LATEST_RELEASE_URL).length, 1);
  });
}
