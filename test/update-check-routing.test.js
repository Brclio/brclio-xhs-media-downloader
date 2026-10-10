import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LATEST_RELEASE_URL, UpdateManager } from '../desktop/update-manager.js';
import { UpdateProxyNetwork } from '../desktop/update-proxy.js';

const endpoint = 'https://updates.example.com/api/account';
const subscription = 'https://subscription.example.com/update-check';
const installer = 'Brclio-XHS-2.0.13-mac-arm64.dmg';
const release = { tag_name: 'v2.0.13', draft: false, prerelease: false,
  html_url: 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/tag/v2.0.13',
  body: 'Version check routing fixture', published_at: '2026-10-10T00:00:00Z',
  assets: [{ name: installer, size: 32, digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/v2.0.13/${installer}` }] };

async function fixture(t, { response = () => ({}), systemProxy = false, ...managerOptions } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'update-check-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = [], requests = [], directRequests = [], children = [];
  let detections = 0;
  const session = { fromPartition() {
    const scoped = { mode: 'system', modes: [], cleared: false, closed: 0,
      async setProxy(value) { this.mode = value.mode; this.modes.push(value.mode); },
      async closeAllConnections() { this.closed++; },
      async clearStorageData() { this.cleared = true; } };
    sessions.push(scoped);
    return scoped;
  } };
  const net = { request(options) {
    const request = new EventEmitter();
    const recorded = { options, request, mode: options.session.mode, aborted: false };
    requests.push(recorded);
    request.abort = () => { recorded.aborted = true; };
    request.end = () => queueMicrotask(() => {
      const result = response(recorded, requests.length) || {};
      if (result.hang) return;
      if (result.error) { request.emit('error', result.error); return; }
      if (result.redirect) { request.emit('redirect', 302, 'GET', result.redirect); return; }
      const incoming = result.stream || Readable.from([Buffer.from(result.body ?? JSON.stringify(release))]);
      incoming.statusCode = result.status ?? 200;
      incoming.headers = result.headers || {};
      request.emit('response', incoming);
    });
    return request;
  } };
  const network = new UpdateProxyNetwork({ net, session, endpoint,
    cacheDirectory: directory, runtimeDirectory: path.join(directory, 'runtime'), env: {},
    detectExternalProxy: async scoped => {
      detections++;
      await scoped.setProxy({ mode: 'system' });
      return { enabled: systemProxy, source: systemProxy ? 'system' : 'none' };
    },
    fetchDirect: async (url, init) => {
      init.signal.throwIfAborted();
      directRequests.push(url);
      if (url === endpoint) return Response.json({ ok: true,
        proxyConfig: { enabled: true, revision: 1, subscriptionUrl: subscription } });
      if (url === subscription) return Response.json({ proxies: [{ name: 'fixture', type: 'vless',
        server: 'node.example.com', port: 443, uuid: 'fixture-id', tls: true }] });
      const parsed = new URL(url);
      assert.equal(parsed.hostname, '127.0.0.1');
      if (parsed.pathname === '/version') return Response.json({ version: 'fixture' });
      if (parsed.pathname === '/proxies/BRCLIO_UPDATE' && init.method !== 'PUT') return Response.json({
        name: 'BRCLIO_UPDATE', type: 'Selector', all: ['node-001']
      });
      if (parsed.pathname.endsWith('/delay')) return Response.json({ delay: 1 });
      assert.equal(parsed.pathname, '/proxies/BRCLIO_UPDATE');
      assert.equal(init.method, 'PUT');
      return new Response(null, { status: 204 });
    },
    launchCore: () => {
      const child = new EventEmitter();
      child.exitCode = null; child.signalCode = null;
      child.stdin = { end() { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); } };
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
      children.push(child);
      return child;
    } });
  const manager = new UpdateManager({ currentVersion: '2.0.12', platform: 'darwin', arch: 'arm64',
    directory, networkScope: network, fetchImpl: network.fetch, ...managerOptions });
  return { manager, network, directory, sessions, requests, directRequests, children,
    get detections() { return detections; } };
}

function assertClean(f) {
  assert.equal(f.network.active.size, 0);
  assert.ok(f.sessions.every(scoped => scoped.cleared && scoped.closed > 0 && scoped.mode === 'direct'));
  assert.ok(f.children.every(child => child.exitCode === 0));
  assert.equal(f.manager.operation, null);
  assert.equal(f.manager.controller, null);
}

for (const manual of [true, false]) {
  test(`${manual ? 'manual' : 'automatic'} version check succeeds directly without proxy setup even with a system proxy`, async t => {
    const f = await fixture(t, { systemProxy: true });
    const result = await f.manager.checkForUpdates({ manual });
    assert.equal(result.status, 'available');
    assert.equal(result.latestVersion, '2.0.13');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].options.url, LATEST_RELEASE_URL);
    assert.equal(f.requests[0].mode, 'direct');
    assert.equal(f.detections, 0);
    assert.deepEqual(f.directRequests, []);
    assert.equal(f.children.length, 0);
    assertClean(f);
  });
}

for (const failure of ['connection', 403, 429, 500, 502, 503, 504]) {
  test(`direct version check ${failure} falls back to the configured internal proxy and closes both scopes`, async t => {
    const f = await fixture(t, { response: (_request, count) => count === 1
      ? failure === 'connection' ? { error: Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }) } : { status: failure }
      : {} });
    const result = await f.manager.checkForUpdates();
    assert.equal(result.status, 'available');
    assert.deepEqual(f.requests.map(value => value.mode), ['direct', 'fixed_servers']);
    assert.equal(f.detections, 1);
    assert.equal(f.directRequests.filter(url => url === endpoint).length, 1);
    assert.equal(f.directRequests.filter(url => url === subscription).length, 1);
    assert.equal(f.children.length, 1);
    assert.equal((await readdir(f.directory)).filter(name => name.startsWith('proxy-') && name !== 'proxy-preference.json' && name !== 'proxy-config.json').length, 0);
    assertClean(f);
  });
}

test('a failed direct check uses the existing system proxy before considering an internal proxy', async t => {
  const f = await fixture(t, { systemProxy: true,
    response: (_request, count) => count === 1 ? { status: 503 } : {} });
  assert.equal((await f.manager.checkForUpdates()).status, 'available');
  assert.deepEqual(f.requests.map(value => value.mode), ['direct', 'system']);
  assert.equal(f.detections, 1);
  assert.deepEqual(f.directRequests, []);
  assert.equal(f.children.length, 0);
  assertClean(f);
});

test('a direct response body connection reset can fall back without accepting partial metadata', async t => {
  const f = await fixture(t, { response: (_request, count) => count === 1 ? {
    stream: Readable.from((async function* () {
      yield Buffer.from('{"tag_name":');
      throw Object.assign(new Error('Response connection reset'), { code: 'ECONNRESET' });
    })())
  } : {} });
  const result = await f.manager.checkForUpdates();
  assert.equal(result.status, 'available');
  assert.equal(result.latestVersion, '2.0.13');
  assert.deepEqual(f.requests.map(value => value.mode), ['direct', 'fixed_servers']);
  assertClean(f);
});

test('direct timeout starts a fresh fallback request without aborting the parent operation', async t => {
  let parent;
  const f = await fixture(t, { networkTimeoutMs: 20, directCheckTimeoutMs: 1000,
    response: (_request, count) => {
      if (count !== 1) return {};
      parent = f.manager.controller;
      return { hang: true };
    } });
  assert.equal((await f.manager.checkForUpdates()).status, 'available');
  assert.equal(parent.signal.aborted, false);
  assert.equal(f.requests[0].aborted, true);
  assert.deepEqual(f.requests.map(value => value.mode), ['direct', 'fixed_servers']);
  assertClean(f);
});

test('the direct-check time budget also bounds metadata body reads', async t => {
  let parent;
  const f = await fixture(t, { networkTimeoutMs: 1000, directCheckTimeoutMs: 20,
    response: (_request, count) => {
      if (count !== 1) return {};
      parent = f.manager.controller;
      return { stream: new Readable({ read() {} }) };
    } });
  assert.equal((await f.manager.checkForUpdates()).status, 'available');
  assert.equal(parent.signal.aborted, false);
  assert.equal(f.requests[0].aborted, true);
  assert.deepEqual(f.requests.map(value => value.mode), ['direct', 'fixed_servers']);
  assertClean(f);
});

test('shutdown during the direct request cancels the check without starting fallback', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { response: () => { entered(); return { hang: true }; } });
  const operation = f.manager.checkForUpdates();
  await ready;
  await f.manager.shutdown();
  const result = await operation;
  assert.equal(result.status, 'idle');
  assert.equal(result.error, null);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].aborted, true);
  assert.equal(f.detections, 0);
  assert.deepEqual(f.directRequests, []);
  assertClean(f);
});

for (const status of [400, 401, 404]) {
  test(`direct version check HTTP ${status} is terminal without proxy fallback`, async t => {
    const f = await fixture(t, { response: (_request, count) => count === 1 ? { status } : {} });
    const result = await f.manager.checkForUpdates();
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, status === 404 ? 'RELEASE_NOT_FOUND' : 'HTTP_ERROR');
    assert.deepEqual(f.requests.map(request => request.mode), ['direct']);
    assert.equal(f.detections, 0);
    assert.deepEqual(f.directRequests, []);
    assert.equal(f.children.length, 0);
    assertClean(f);
  });
}

for (const [label, error] of [
  ['Electron certificate message', new Error('net::ERR_CERT_AUTHORITY_INVALID')],
  ['Electron SSL message', new Error('net::ERR_SSL_PROTOCOL_ERROR')],
  ['Chromium certificate code', Object.assign(new Error('Certificate rejected'), { code: 'ERR_CERT_COMMON_NAME_INVALID' })],
  ['Chromium SSL code', Object.assign(new Error('TLS protocol failed'), { code: 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH' })],
  ['Node fetch certificate cause', new TypeError('fetch failed', { cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) })],
  ['Node fetch expired certificate cause', new TypeError('fetch failed', { cause: Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' }) })],
  ['Node fetch TLS cause', new TypeError('fetch failed', { cause: Object.assign(new Error('Hostname rejected'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) })]
]) {
  test(`${label} fails without starting another network route`, async t => {
    const f = await fixture(t, { response: (_request, count) => count === 1 ? { error } : {} });
    const result = await f.manager.checkForUpdates();
    assert.equal(result.status, 'error');
    assert.deepEqual(f.requests.map(request => request.mode), ['direct']);
    assert.equal(f.detections, 0);
    assert.deepEqual(f.directRequests, []);
    assert.equal(f.children.length, 0);
    assertClean(f);
  });
}

for (const [label, response, code] of [
  ['malformed JSON', { body: '{broken release' }, 'INVALID_RELEASE'],
  ['untrusted release URL', { body: JSON.stringify({ ...release, html_url: 'https://example.com/release' }) }, 'UNTRUSTED_URL'],
  ['untrusted installer URL', { body: JSON.stringify({ ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://example.com/installer.dmg' }] }) }, 'UNTRUSTED_URL'],
  ['oversized response', { headers: { 'content-length': String(1024 * 1024 + 1) } }, 'SIZE_MISMATCH'],
  ['metadata redirect', { redirect: 'https://example.com/release' }, 'UNTRUSTED_REDIRECT']
]) {
  test(`${label} fails without consuming the internal proxy`, async t => {
    const f = await fixture(t, { response: () => response });
    const result = await f.manager.checkForUpdates();
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, code);
    assert.equal(f.requests.length, 1);
    assert.equal(f.detections, 0);
    assert.deepEqual(f.directRequests, []);
    assertClean(f);
  });
}

test('cache permission failure after successful metadata does not start a proxy fallback', async t => {
  const f = await fixture(t);
  f.manager.partialSize = async () => { throw Object.assign(new Error('Cache denied'), { code: 'EACCES', syscall: 'lstat' }); };
  const result = await f.manager.checkForUpdates();
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'CACHE_PERMISSION');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.directRequests, []);
  assert.equal(f.children.length, 0);
  assertClean(f);
});

test('automatic direct-check failure respects the persisted manual proxy disable', async t => {
  const f = await fixture(t, { response: (_request, count) => count === 1 ? { status: 503 } : {} });
  await f.network.stopInternalProxy();
  await f.manager.checkForUpdates({ manual: false });
  assert.ok(f.requests.every(request => request.mode === 'direct' || request.mode === 'system'));
  assert.deepEqual(f.directRequests, []);
  assert.equal(f.children.length, 0);
  assert.equal(f.network.snapshot().manuallyDisabled, true);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'proxy-preference.json'), 'utf8')).manuallyDisabled, true);
  assertClean(f);
});

test('a newer manual stop during the direct request is not undone before fallback', async t => {
  let entered, pendingRequest;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { response: (recorded, count) => {
    if (count !== 1) return {};
    pendingRequest = recorded.request;
    entered();
    return { hang: true };
  } });
  const operation = f.manager.checkForUpdates();
  await ready;
  await f.network.stopInternalProxy();
  pendingRequest.emit('error', Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }));
  await operation;
  assert.deepEqual(f.directRequests, []);
  assert.equal(f.children.length, 0);
  assert.equal(f.network.snapshot().manuallyDisabled, true);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'proxy-preference.json'), 'utf8')).manuallyDisabled, true);
  assertClean(f);
});
