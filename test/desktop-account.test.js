import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, verify } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SecureAccountStore, stableDeviceHash } from '../desktop/account-storage.js';
import { AccountClient, validateAccountEndpoint } from '../desktop/account-client.js';
import { ProfileManager } from '../desktop/profile-manager.js';
import { createProtocolHandler } from '../desktop/protocol.js';
import { membershipLabel } from '../account-ui.js';

const STABLE_HASH = 'a'.repeat(64);
const PROFILE = 'https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c';
const NOTE = '1'.repeat(24);
function mockSafeStorage() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(data) {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    }
  };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-account-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const safeStorage = mockSafeStorage();
  const store = new SecureAccountStore({ directory, safeStorage, platform: 'darwin', deviceIdentity: async () => STABLE_HASH, deviceName: 'Test Mac' });
  const sessions = new Map(), requests = [], redemptions = new Map();
  let offline = false, deviceStatus = 'authorized';
  let membership = { type: 'duration', startsAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z', active: true };
  const serverTime = '2026-09-20T00:00:00Z';
  const account = () => ({ user: { id: 'user-1', email: 'member@example.com', role: 'user', createdAt: serverTime }, membership, device: { status: deviceStatus }, serverTime });
  const fetchImpl = async (_url, init) => {
    if (offline) throw new Error('network down');
    const request = JSON.parse(init.body), token = init.headers.Authorization?.replace(/^Bearer /, '') || '';
    requests.push({ ...request, token });
    const success = body => Response.json({ ok: true, ...body, serverTime });
    const failure = (code, status = 403) => Response.json({ ok: false, error: { code, message: code }, serverTime }, { status });
    if (request.action === 'send-code') return success({ expiresAt: '2026-09-20T00:05:00Z', retryAfter: 60 });
    const publicKey = request.action === 'verify-code' ? request.input.device.publicKey : sessions.get(token)?.publicKey;
    if (!publicKey) return failure('SESSION_REVOKED', 401);
    const payload = `${request.action}\n${request.proof.timestamp}\n${request.proof.nonce}\n${JSON.stringify(request.input)}\n${token}`;
    assert.equal(verify(null, Buffer.from(payload), publicKey, Buffer.from(request.proof.signature, 'base64')), true);
    if (request.action === 'verify-code') {
      const token = `test-session-${randomUUID()}`;
      sessions.set(token, { publicKey });
      return success({ token, account: account() });
    }
    if (request.action === 'logout') { sessions.delete(token); return success({ revoked: true }); }
    if (request.action === 'authorize') {
      if (deviceStatus !== 'authorized') return failure(deviceStatus === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_LIMIT');
      if (!membership.active) return failure('MEMBERSHIP_EXPIRED');
      return success({ authorized: true, account: account() });
    }
    if (request.action === 'redeem') {
      const replayed = redemptions.has(request.input.requestId);
      redemptions.set(request.input.requestId, true);
      return success({ account: account(), replayed });
    }
    return success({ account: account() });
  };
  const config = { store, endpoint: 'https://accounts.example/api/account', fetchImpl, ...options };
  const client = new AccountClient(config);
  await client.initialize();
  const login = () => client.verifyCode('member@example.com', '123456');
  return { directory, store, safeStorage, client, config, sessions, requests, redemptions, login,
    offline: value => { offline = value; }, device: value => { deviceStatus = value; }, membership: value => { membership = value; } };
}

test('stable device identity hashes domain/platform UUID and never falls back to device name or MAC', async () => {
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const mac = await stableDeviceHash({ platform: 'darwin', exec: async () => ({ stdout: `"IOPlatformUUID" = "${uuid}"` }) });
  const win = await stableDeviceHash({ platform: 'win32', exec: async (_command, args) => {
    assert.ok(args.includes('/reg:64')); return { stdout: `MachineGuid    REG_SZ    ${uuid}` };
  } });
  assert.match(mac, /^[a-f\d]{64}$/); assert.notEqual(mac, win); assert.ok(!mac.includes(uuid));
  assert.equal(mac, await stableDeviceHash({ platform: 'darwin', exec: async () => ({ stdout: `"IOPlatformUUID" = "${uuid.toUpperCase()}"` }) }));
  await assert.rejects(stableDeviceHash({ platform: 'darwin', exec: async () => ({ stdout: '' }) }), { code: 'DEVICE_ID_UNAVAILABLE' });
  await assert.rejects(stableDeviceHash({ platform: 'linux' }), { code: 'DEVICE_ID_UNAVAILABLE' });
});

test('encrypted credentials, device keys, and permanent session survive client/store re-instantiation', async t => {
  const f = await fixture(t); await f.login();
  const credentials = await f.store.load(), bytes = await readFile(f.store.filename);
  assert.equal(bytes.includes(Buffer.from(credentials.token)), false);
  assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false);
  const store = new SecureAccountStore({ directory: f.directory, safeStorage: f.safeStorage, platform: 'darwin', deviceIdentity: async () => STABLE_HASH });
  const restarted = new AccountClient({ ...f.config, store, now: () => Date.now() + 1000 * 86400 * 365 * 10 });
  await restarted.initialize(); await restarted.refresh();
  assert.equal(restarted.snapshot().authenticated, true);
  const restored = await store.load();
  assert.equal(restored.token, credentials.token); assert.equal(restored.privateKey, credentials.privateKey);
  assert.equal(restored.publicKey, credentials.publicKey); assert.equal(restored.stableIdHash, credentials.stableIdHash);
  assert.equal(JSON.stringify(restarted.snapshot()).includes(credentials.token), false);
  assert.equal(JSON.stringify(restarted.snapshot()).includes('PRIVATE KEY'), false);
});

test('secure storage unavailable/corrupt/device mismatch fail closed and preserve previous ciphertext', async t => {
  const f = await fixture(t); await f.login();
  const bytes = await readFile(f.store.filename);
  const unavailable = new SecureAccountStore({ directory: f.directory, safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(unavailable.load(), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  const corrupt = new SecureAccountStore({ directory: f.directory, safeStorage: mockSafeStorage() });
  await assert.rejects(corrupt.load(), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  const moved = new SecureAccountStore({ directory: f.directory, safeStorage: f.safeStorage, deviceIdentity: async () => 'b'.repeat(64) });
  await assert.rejects(moved.load(), { code: 'DEVICE_ID_CHANGED' });
  assert.deepEqual(await readFile(f.store.filename), bytes);
});

test('send/login signs exact payload and reports device-limit account without granting feature access', async t => {
  const f = await fixture(t); f.device('device_limit');
  await f.client.sendCode('member@example.com'); const snapshot = await f.login();
  assert.equal(snapshot.authenticated, true); assert.equal(snapshot.account.device.status, 'device_limit');
  assert.equal(f.requests[0].proof, undefined);
  const device = f.requests[1].input.device;
  assert.deepEqual(Object.keys(device).sort(), ['name', 'platform', 'publicKey', 'stableIdHash']);
  await assert.rejects(f.client.authorize('profile-download'), { code: 'DEVICE_LIMIT' });
  assert.equal(JSON.stringify(snapshot).includes('test-session-'), false);
});

test('server expiry and device revocation override stored account; refresh never verifies email or auto-binds', async t => {
  const f = await fixture(t); await f.login(); await f.client.authorize('profile-download');
  f.membership({ type: 'duration', expiresAt: '2026-09-19T00:00:00Z', active: false });
  await assert.rejects(f.client.authorize('profile-download'), { code: 'MEMBERSHIP_EXPIRED' });
  await f.client.refresh(); assert.equal(f.client.snapshot().authenticated, true);
  assert.equal(f.client.snapshot().account.membership.active, false);
  f.device('revoked'); await f.client.refresh();
  await assert.rejects(f.client.authorize('profile-download'), { code: 'DEVICE_REVOKED' });
  assert.equal(f.requests.filter(request => request.action === 'verify-code').length, 1);
});

test('logout revokes remote token, clears local active token, and keeps stable device key', async t => {
  const f = await fixture(t); await f.login();
  const before = await f.store.load(); await f.client.logout(); const after = await f.store.load();
  assert.equal(f.sessions.has(before.token), false); assert.equal(after.token, null);
  assert.equal(after.privateKey, before.privateKey); assert.equal(after.stableIdHash, before.stableIdHash);
  assert.equal(f.client.snapshot().authenticated, false);
  await assert.rejects(f.client.authorize('profile-download'), { code: 'ACCOUNT_REQUIRED' });
});

test('offline logout blocks local use immediately and retries encrypted pending revocation after restart', async t => {
  const f = await fixture(t); await f.login(); const token = (await f.store.load()).token;
  f.offline(true); const result = await f.client.logout();
  assert.equal(result.state.authenticated, false); assert.equal(result.state.pendingLogout, true);
  assert.match(result.message, /尚未确认/); assert.equal(f.sessions.has(token), true);
  assert.equal((await readFile(f.store.filename)).includes(Buffer.from(token)), false);
  const restarted = new AccountClient(f.config); await restarted.initialize();
  await assert.rejects(restarted.authorize('profile-download'), { code: 'ACCOUNT_REQUIRED' });
  f.offline(false); await restarted.refresh();
  assert.equal(f.sessions.has(token), false); assert.equal(restarted.snapshot().pendingLogout, false);
});

test('redeem keeps the same idempotency key across retry and restart without persisting raw activation code', async t => {
  const f = await fixture(t); await f.login();
  await f.client.redeem('SECRET-ACTIVATION-CODE');
  const restarted = new AccountClient(f.config); await restarted.initialize();
  const retry = await restarted.redeem('SECRET-ACTIVATION-CODE');
  assert.equal(retry.replayed, true); assert.equal(f.redemptions.size, 1);
  assert.equal(JSON.stringify(await f.store.load()).includes('SECRET-ACTIVATION-CODE'), false);
  const requests = f.requests.filter(request => request.action === 'redeem');
  assert.equal(requests[0].input.requestId, requests[1].input.requestId);
});

test('service failure never reuses cached grants; free single remains available offline', async t => {
  const f = await fixture(t); await f.login(); await f.client.authorize('profile-download');
  f.offline(true);
  await assert.rejects(f.client.authorize('profile-download'), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(f.client.snapshot().status, 'service_unavailable');
  assert.equal(f.client.snapshot().authenticated, true);
  assert.equal((await f.client.authorize('single-download')).free, true);
  await assert.rejects(f.client.authorize('unknown'), { code: 'FEATURE_UNKNOWN' });
  const unconfigured = new AccountClient({ ...f.config, endpoint: '' }); await unconfigured.initialize();
  await assert.rejects(unconfigured.authorize('profile-download'), { code: 'CONFIGURATION_REQUIRED' });
  assert.equal((await unconfigured.authorize('single-download')).free, true);
});

test('HTTPS endpoints disallow credentials, query secrets, and non-local development HTTP', () => {
  for (const endpoint of ['http://example.com/api', 'https://name:secret@example.com/api', 'https://example.com/api?token=secret', 'invalid']) {
    assert.throws(() => validateAccountEndpoint(endpoint));
  }
  assert.equal(validateAccountEndpoint('http://localhost:3000/api/account', true), 'http://localhost:3000/api/account');
  assert.throws(() => validateAccountEndpoint('http://example.com/api', true));
});

test('server timestamp resynchronizes proof once without deriving membership from local time', async t => {
  const f = await fixture(t); await f.login(); let calls = 0;
  const serverTime = '2030-01-01T00:00:00.000Z';
  f.client.fetchImpl = async (_url, init) => {
    calls++; const { proof } = JSON.parse(init.body);
    if (calls === 1) return Response.json({ ok: false, error: { code: 'PROOF_EXPIRED', message: 'clock skew' }, serverTime }, { status: 401 });
    assert.ok(Math.abs(proof.timestamp - Date.parse(serverTime)) < 1000);
    return Response.json({ ok: true, authorized: true, serverTime });
  };
  assert.equal((await f.client.authorize('profile-download')).authorized, true); assert.equal(calls, 2);
});

test('profile manager denies missing authority and does not replace existing job state', async t => {
  const f = await fixture(t);
  const manager = new ProfileManager({ stateDirectory: path.join(f.directory, 'jobs'), browser: {} });
  await manager.initialize();
  await assert.rejects(manager.start({ profileUrl: PROFILE, directory: f.directory }), { code: 'ACCOUNT_AUTHORIZATION_REQUIRED' });
  assert.equal(manager.snapshot().profileUrl, '');
});

test('profile authorization is rechecked between notes and preserves completed records', async t => {
  const f = await fixture(t); let revoked = false;
  const manager = new ProfileManager({ stateDirectory: path.join(f.directory, 'jobs'), browser: {
    async *discover() { yield { notes: [{ id: NOTE, url: `https://www.xiaohongshu.com/explore/${NOTE}` }, { id: '2'.repeat(24), url: `https://www.xiaohongshu.com/explore/${'2'.repeat(24)}` }], done: true }; }
  }, authorize: async () => { if (revoked) throw new Error('设备已撤销'); } });
  await manager.initialize();
  manager._downloadNote = async item => { item.status = 'completed'; revoked = true; };
  await manager.start({ profileUrl: PROFILE, directory: f.directory }); await manager._runTask;
  const snapshot = manager.snapshot();
  assert.equal(snapshot.status, 'paused'); assert.equal(snapshot.completed, 1); assert.equal(snapshot.items[1].status, 'pending');
  assert.match(snapshot.message, /设备已撤销/);
  const persisted = await readFile(path.join(f.directory, 'jobs', 'profile-job.json'), 'utf8');
  assert.match(persisted, /completed/);
});

test('in-flight authorization heartbeat aborts long operation and retains task records', async t => {
  const f = await fixture(t); let revoked = false, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const manager = new ProfileManager({ stateDirectory: path.join(f.directory, 'jobs'), authorizationIntervalMs: 10,
    authorize: async () => { if (revoked) throw new Error('会员已取消'); }, browser: {
      async *discover() { yield { notes: [{ id: NOTE, url: `https://www.xiaohongshu.com/explore/${NOTE}` }], done: true }; }
    } });
  await manager.initialize();
  manager._downloadNote = async (_item, signal) => { entered(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  await manager.start({ profileUrl: PROFILE, directory: f.directory });
  await enteredPromise; revoked = true;
  // Keep event loop alive because production authorization timer deliberately unrefs.
  const guard = setTimeout(() => {}, 1000);
  try { await manager._runTask; } finally { clearTimeout(guard); }
  assert.equal(manager.snapshot().status, 'paused'); assert.equal(manager.snapshot().items[0].status, 'pending');
  assert.match(manager.snapshot().message, /会员已取消/);
});

test('protocol gates real Node and Python API entry points including aliases', async () => {
  let dispatched = false, checks = 0;
  const handle = createProtocolHandler({ rootDirectory: process.cwd(), authorize: async feature => {
    assert.equal(feature, 'single-download'); checks++; throw Object.assign(new Error('denied'), { status: 403 });
  }, nodeHandlers: { '/api/parse': () => { dispatched = true; } }, pythonBackend: { available: true, request: () => { dispatched = true; } } });
  for (const route of ['/api/parse', '/api/parse.js', '/api/python_image', '/api/python_image.py']) {
    assert.equal((await handle(new Request(`xhs-app://local${route}`))).status, 403);
  }
  assert.equal(checks, 4); assert.equal(dispatched, false);
});

test('membership labels use server-provided active/time and never the local system clock', () => {
  assert.equal(membershipLabel({ membership: { type: 'none' } }), '普通用户 · 未开通会员');
  assert.equal(membershipLabel({ membership: { type: 'permanent', active: true } }), '永久会员');
  assert.equal(membershipLabel({ membership: { type: 'duration', active: true, expiresAt: '2000-01-01' } }), '有效期会员');
  assert.equal(membershipLabel({ membership: { type: 'duration', active: false, startsAt: '2030-01-01' }, serverTime: '2026-01-01' }), '会员尚未生效');
});

test('desktop real client → HTTP handler → service → GitHub SHA adapter integrates login, grants, redeem, logout and unbind', async t => {
  const { GithubStateStore, emptyState } = await import('../server/auth/store.js');
  const { createAccountService } = await import('../server/auth/service.js');
  const { readConfig } = await import('../server/auth/config.js');
  const { createAccountHandler } = await import('../api/account.js');
  const f = await fixture(t);
  let persisted = emptyState(), revision = 1, backendNow = Date.now();
  const delivered = new Map();
  const config = readConfig({ AUTH_SECRET_PEPPER: 'test-only-pepper-for-integration-not-a-service-secret', AUTH_ADMIN_EMAILS: 'admin@example.com', AUTH_SITE_ORIGIN: 'https://accounts.example' });
  const githubFetch = async (url, init) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (init.method === 'GET') return Response.json({ sha: `sha-${revision}`, encoding: 'base64', content: Buffer.from(JSON.stringify(persisted)).toString('base64') });
    const change = JSON.parse(init.body);
    if (change.sha !== `sha-${revision}`) return Response.json({ message: 'sha conflict' }, { status: 409 });
    persisted = JSON.parse(Buffer.from(change.content, 'base64').toString('utf8')); revision++;
    return Response.json({ content: { sha: `sha-${revision}` } });
  };
  const githubStore = new GithubStateStore({ owner: 'fixture', repo: 'private-data', token: 'fake-github-transport-only', fetchImpl: githubFetch, delay: async () => {} });
  const service = createAccountService({ store: githubStore, config, now: () => backendNow,
    mailer: { configured: true, send: async message => delivered.set(message.email, message.code) } });
  const httpHandler = createAccountHandler({ service, config, now: () => backendNow });
  const fetchImpl = async (_url, init) => {
    const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; return this; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await httpHandler({ method: init.method, body: init.body, headers: Object.fromEntries(Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value])), socket: { remoteAddress: '127.0.0.1' } }, response);
    return Response.json(response.body, { status: response.statusCode, headers: response.headers });
  };
  f.client.fetchImpl = fetchImpl;
  await f.client.sendCode('member@example.com');
  await f.client.verifyCode('member@example.com', delivered.get('member@example.com'));
  const originalToken = (await f.store.load()).token;
  const userId = f.client.snapshot().account.user.id, deviceId = f.client.snapshot().account.device.id;
  assert.equal(f.client.snapshot().account.membership.type, 'none');
  await assert.rejects(f.client.authorize('profile-download'), { code: 'MEMBERSHIP_REQUIRED' });
  await service.execute({ action: 'send-code', input: { email: 'admin@example.com', client: 'admin' }, ip: '127.0.0.1' });
  const adminLogin = await service.execute({ action: 'verify-code', input: { email: 'admin@example.com', code: delivered.get('admin@example.com'), client: 'admin' } });
  const admin = (action, input) => service.execute({ action, input: { ...input, requestId: randomUUID(), reason: '集成测试人工操作' }, token: adminLogin.token });
  await admin('admin-membership', { userId, operation: 'days', days: 10 });
  await f.client.refresh(); assert.equal(f.client.snapshot().account.membership.active, true);
  assert.equal((await f.client.authorize('profile-download')).authorized, true);
  const codes = await admin('admin-generate-codes', { type: 'duration', days: 3, count: 1 });
  const rawCode = codes.codes[0].code;
  await f.client.redeem(rawCode); const expiresAt = f.client.snapshot().account.membership.expiresAt;
  assert.equal((await f.client.redeem(rawCode)).replayed, true);
  assert.equal(f.client.snapshot().account.membership.expiresAt, expiresAt);
  assert.equal(Date.parse(expiresAt) - backendNow, 13 * 86400_000);
  assert.equal(JSON.stringify(persisted).includes(rawCode), false);
  assert.equal(JSON.stringify(persisted).includes(originalToken), false);
  await f.client.logout();
  await assert.rejects(f.client._request('me', {}, { token: originalToken }), { code: 'SESSION_REVOKED' });
  backendNow += 61_000;
  await f.client.sendCode('member@example.com'); await f.client.verifyCode('member@example.com', delivered.get('member@example.com'));
  assert.equal(f.client.snapshot().account.device.id, deviceId);
  const secondStore = new SecureAccountStore({ directory: path.join(f.directory, 'second-device'), safeStorage: f.safeStorage,
    platform: 'win32', deviceIdentity: async () => 'b'.repeat(64), deviceName: 'New Windows' });
  const second = new AccountClient({ store: secondStore, endpoint: f.client.endpoint, fetchImpl }); await second.initialize();
  backendNow += 61_000;
  await second.sendCode('member@example.com'); await second.verifyCode('member@example.com', delivered.get('member@example.com'));
  assert.equal(second.snapshot().account.device.status, 'device_limit');
  await assert.rejects(second.authorize('profile-download'), { code: 'DEVICE_LIMIT' });
  await assert.rejects(f.client._request('admin-unbind', { userId, deviceId, requestId: randomUUID(), reason: '普通用户尝试解绑' }), { code: 'ORIGIN_FORBIDDEN' });
  await admin('admin-unbind', { userId, deviceId });
  await f.client.refresh();
  assert.equal(f.client.snapshot().authenticated, true); assert.equal(f.client.snapshot().account.device.status, 'revoked');
  await assert.rejects(f.client.authorize('profile-download'), { code: 'DEVICE_REVOKED' });
  backendNow += 61_000;
  await f.client.sendCode('member@example.com'); await f.client.verifyCode('member@example.com', delivered.get('member@example.com'));
  assert.equal(f.client.snapshot().account.device.status, 'revoked');
  await second.refresh(); assert.equal(second.snapshot().account.device.status, 'device_limit');
  backendNow += 61_000;
  await second.sendCode('member@example.com'); await second.verifyCode('member@example.com', delivered.get('member@example.com'));
  assert.equal(second.snapshot().account.device.status, 'authorized'); assert.equal((await second.authorize('profile-download')).authorized, true);
});

test('logout serializes against refresh and rejects a previously issued in-flight authorization response', async t => {
  const f = await fixture(t); await f.login();
  const originalFetch = f.client.fetchImpl;
  let releaseRefresh, refreshEntered;
  const entered = new Promise(resolve => { refreshEntered = resolve; });
  f.client.fetchImpl = async (...args) => {
    const response = await originalFetch(...args);
    if (JSON.parse(args[1].body).action === 'me') {
      refreshEntered(); await new Promise(resolve => { releaseRefresh = resolve; });
    }
    return response;
  };
  const refresh = f.client.refresh(); await entered;
  const logout = f.client.logout(); releaseRefresh(); await Promise.all([refresh, logout]);
  assert.equal(f.client.snapshot().authenticated, false); assert.equal(f.client.snapshot().account, null);
  f.client.fetchImpl = originalFetch; await f.login();
  let releaseGrant, grantEntered;
  const grantStarted = new Promise(resolve => { grantEntered = resolve; });
  f.client.fetchImpl = async (...args) => {
    const response = await originalFetch(...args);
    if (JSON.parse(args[1].body).action === 'authorize') {
      grantEntered(); await new Promise(resolve => { releaseGrant = resolve; });
    }
    return response;
  };
  const authorization = f.client.authorize('profile-download'); await grantStarted;
  await f.client.logout(); releaseGrant();
  await assert.rejects(authorization, { code: 'SESSION_CHANGED' });
  assert.equal(f.client.snapshot().authenticated, false); assert.equal(f.client.snapshot().account, null);
});

test('denied item/retry-all commands preserve previous failure records', async t => {
  const f = await fixture(t); let allowed = true;
  const manager = new ProfileManager({ stateDirectory: path.join(f.directory, 'jobs'), authorize: async () => { if (!allowed) throw new Error('没有会员权限'); }, browser: {
    async *discover() { yield { notes: [{ id: NOTE, url: `https://www.xiaohongshu.com/explore/${NOTE}` }], done: true }; }
  } });
  await manager.initialize(); manager._downloadNote = async () => { throw new Error('原始下载错误'); };
  await manager.start({ profileUrl: PROFILE, directory: f.directory }); await manager._runTask; allowed = false;
  for (const retry of [() => manager.retryItem(NOTE), () => manager.retryFailed()]) {
    await assert.rejects(retry(), { code: 'ACCOUNT_AUTHORIZATION_REQUIRED' });
    assert.equal(manager.snapshot().items[0].status, 'failed'); assert.equal(manager.snapshot().items[0].error, '原始下载错误');
  }
});

test('feedback requests capture the original signed identity and reject success after account switches in flight', async t => {
  for (const action of ['feedback-begin', 'feedback-upload-part', 'feedback-finalize']) {
    await t.test(action, async t => {
      const f = await fixture(t); await f.login();
      const originalToken = (await f.store.load()).token;
      const fetchOriginal = f.client.fetchImpl;
      let started, release;
      const requestStarted = new Promise(resolve => { started = resolve; });
      const responseGate = new Promise(resolve => { release = resolve; });
      f.client.fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        const response = await fetchOriginal(url, init); // Checks the real Ed25519 proof.
        if (body.action === action) { started(); await responseGate; return response; }
        if (body.action === 'verify-code' && body.input.email === 'other@example.com') {
          const value = await response.json();
          value.account.user = { ...value.account.user, id: 'user-2', email: 'other@example.com' };
          return Response.json(value);
        }
        return response;
      };
      const inFlight = f.client.feedbackRequest(action, { feedbackId: 'fixture-feedback' }, 'user-1');
      await requestStarted;
      try {
        await f.client.logout();
        await f.client.verifyCode('other@example.com', '123456');
        assert.equal(f.client.snapshot().account.user.id, 'user-2');
      } finally { release(); }
      await assert.rejects(inFlight, { code: 'SESSION_CHANGED' });
      const request = f.requests.find(value => value.action === action);
      assert.equal(request.token, originalToken, 'request never uses the replacement account token');
      assert.notEqual((await f.store.load()).token, originalToken);
      assert.equal(f.client.snapshot().account.user.id, 'user-2', 'old response cannot overwrite current identity');
    });
  }
});

test('feedback identity and action guards reject before sending log content or authentication', async t => {
  const f = await fixture(t);
  const secretFixture = { content: 'fixture-log-content-must-not-be-sent' };
  await assert.rejects(f.client.feedbackRequest('feedback-upload-part', secretFixture, 'user-1'), { code: 'SESSION_CHANGED' });
  assert.equal(f.requests.length, 0);
  await f.login(); const before = f.requests.length;
  await assert.rejects(f.client.feedbackRequest('feedback-begin', secretFixture, 'user-2'), { code: 'SESSION_CHANGED' });
  await assert.rejects(f.client.feedbackRequest('admin-feedback-part', secretFixture, 'user-1'), { code: 'UNKNOWN_ACTION' });
  assert.equal(f.requests.length, before);
});
