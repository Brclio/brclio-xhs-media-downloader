import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AccountClient } from '../desktop/account-client.js';
import { issueEntitlement, ENTITLEMENT_MAX_AGE_MS } from '../lib/entitlement.js';

const FEATURE = 'profile-download';
const VIDEO = 'watermark-free-video';
const TIME = Date.parse('2026-10-12T02:00:00Z');
const TOKEN = 'test-session-token-'.repeat(3);
const account = () => ({ user: { id: 'user-1' }, membership: { type: 'permanent', active: true }, device: { id: 'device-1', status: 'authorized' } });
const success = body => Response.json({ ok: true, ...body });
const failure = (code, status = 503) => Response.json({ ok: false, error: { code, message: 'GitHub 存储访问失败，请联系管理员。' } }, { status });
function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

async function fixture({ signed = false, keys = true, sleep } = {}) {
  const device = generateKeyPairSync('ed25519'), issuer = generateKeyPairSync('ed25519');
  let wall = TIME, mono = 0, serverNow = TIME;
  let saved = { version: 1, token: TOKEN, privateKey: device.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: device.publicKey.export({ type: 'spki', format: 'pem' }), stableIdHash: 'a'.repeat(64), pendingLogoutTokens: [], pendingRedemptions: {} };
  const requests = [], delays = [], diagnostics = [];
  const store = { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); },
    device: credentials => ({ publicKey: credentials.publicKey, stableIdHash: credentials.stableIdHash, platform: 'win32', name: 'Test Windows' }) };
  const grant = (feature = FEATURE, input = {}) => issueEntitlement({ privateKey: issuer.privateKey, keyId: 'test-v1', token: TOKEN,
    publicKey: saved.publicKey, userId: 'user-1', deviceId: 'device-1', feature, now: serverNow,
    requestNonce: requests.findLast(request => request.action === 'authorize' && request.input.feature === feature)?.proof.nonce || 'fixture-nonce-12345678', ...input });
  const defaultHandler = request => request.action === 'authorize'
    ? success({ authorized: true, account: account(), ...(signed ? { entitlement: grant(request.input.feature) } : {}) })
    : request.action === 'verify-code' ? success({ token: TOKEN, account: account() })
      : success({ account: account() });
  let handler = defaultHandler;
  const config = { store, endpoint: 'https://accounts.example/api/account', now: () => wall, monotonicNow: () => mono,
    sleep: sleep || (async delay => { delays.push(delay); }),
    entitlementPublicKeys: keys ? { 'test-v1': issuer.publicKey.export({ type: 'spki', format: 'pem' }) } : {},
    onDiagnostic: (...event) => diagnostics.push(event),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body), token = init.headers.Authorization?.slice(7) || '';
      if (request.proof) {
        const payload = `${request.action}\n${request.proof.timestamp}\n${request.proof.nonce}\n${JSON.stringify(request.input)}\n${token}`;
        assert.equal(verify(null, Buffer.from(payload), device.publicKey, Buffer.from(request.proof.signature, 'base64')), true);
      }
      requests.push(request);
      return handler(request);
    } };
  const makeClient = async () => { const client = new AccountClient(config); await client.initialize(); client.account = account(); client.status = 'ready'; return client; };
  const client = await makeClient();
  return { client, config, store, requests, delays, diagnostics, grant, makeClient,
    saved: () => structuredClone(saved), handler: value => { handler = value; }, defaultHandler,
    advance: delta => { wall += delta; mono += delta; serverNow += delta; },
    wall: value => { wall = value; }, mono: value => { mono = value; }, serverTime: value => { serverNow = value; } };
}

test('authorize retries transient failures three times with fresh signed proofs and bounded delays', async () => {
  const f = await fixture();
  let attempts = 0;
  f.handler(request => {
    if (++attempts === 1) throw new TypeError('temporary network failure');
    if (attempts === 2) return failure('STORAGE_RATE_LIMITED');
    return f.defaultHandler(request);
  });
  assert.deepEqual(await f.client.authorize(FEATURE), { authorized: true, userId: 'user-1' });
  assert.deepEqual(f.delays, [1000, 2000]);
  assert.equal(new Set(f.requests.map(value => value.proof.nonce)).size, 3);
  assert.equal(f.client.snapshot().status, 'ready');
  await f.client.authorize(FEATURE);
  assert.equal(attempts, 4, 'unsigned legacy successes are never cached');
});

test('temporary authorization storage failure preserves diagnostic code and conceals provider details', async () => {
  const f = await fixture();
  f.handler(() => failure('STORAGE_UNAVAILABLE'));
  await assert.rejects(f.client.authorize(FEATURE), error => error.code === 'STORAGE_UNAVAILABLE'
    && /软件账号服务/.test(error.message) && !/GitHub/.test(error.message));
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.delays, [1000, 2000]);
  assert.equal(f.client.snapshot().error.code, 'STORAGE_UNAVAILABLE');
});

test('explicit membership, session, device, proof and storage configuration denials never retry even with HTTP 503', async t => {
  for (const code of ['MEMBERSHIP_EXPIRED', 'DEVICE_REVOKED', 'SESSION_REVOKED', 'INVALID_DEVICE_PROOF',
    'PROOF_EXPIRED', 'CONFIGURATION_REQUIRED', 'STORAGE_INVALID', 'STORAGE_CAPACITY', 'STORAGE_NOT_PRIVATE', 'STORAGE_ACCESS_DENIED']) {
    await t.test(code, async () => {
      const f = await fixture(); f.handler(() => failure(code));
      await assert.rejects(f.client.authorize(FEATURE), { code });
      assert.equal(f.requests.length, 1); assert.deepEqual(f.delays, []);
    });
  }
});

test('mutating account actions are never replayed by authorization retry policy', async () => {
  const f = await fixture(); f.handler(() => { throw new Error('network interruption'); });
  await assert.rejects(f.client.sendCode('member@example.com'), { code: 'SERVICE_UNAVAILABLE' });
  await assert.rejects(f.client.redeem('ACTIVATION-CODE'), { code: 'SERVICE_UNAVAILABLE' });
  await assert.rejects(f.client.feedbackRequest('feedback-reply', { content: 'feedback' }, 'user-1'), { code: 'SERVICE_UNAVAILABLE' });
  assert.deepEqual(f.requests.map(value => value.action), ['send-code', 'redeem', 'feedback-reply']);
  assert.deepEqual(f.delays, []);
});

test('only pending same-feature same-session remote authorizations coalesce', async () => {
  const f = await fixture(), held = deferred();
  f.handler(async request => { await held.promise; return f.defaultHandler(request); });
  const profile = f.client.authorize(FEATURE), duplicate = f.client.authorize(FEATURE), video = f.client.authorize(VIDEO);
  assert.equal(f.requests.length, 2);
  held.resolve(); await Promise.all([profile, duplicate, video]);
  await f.client.authorize(FEATURE);
  assert.equal(f.requests.length, 3);
});

test('logout during authorization backoff cancels stale retry without corrupting signed-out status', async () => {
  const sleeping = deferred(), entered = deferred();
  const f = await fixture({ sleep: async () => { entered.resolve(); await sleeping.promise; } });
  f.handler(request => request.action === 'authorize' ? failure('STORAGE_UNAVAILABLE') : f.defaultHandler(request));
  const authorization = f.client.authorize(FEATURE); await entered.promise;
  await f.client.logout(); sleeping.resolve();
  await assert.rejects(authorization, { code: 'SESSION_CHANGED' });
  assert.equal(f.requests.filter(value => value.action === 'authorize').length, 1);
  assert.equal(f.client.snapshot().status, 'signed_out'); assert.equal(f.client.snapshot().error, null);
});

test('late successful and failed authorizations cannot overwrite a replacement login even if token is reused', async t => {
  for (const denied of [false, true]) await t.test(String(denied), async () => {
    const f = await fixture(), held = deferred();
    f.handler(async request => request.action === 'authorize' ? held.promise : f.defaultHandler(request));
    const authorization = f.client.authorize(FEATURE);
    await f.client.verifyCode('member@example.com', '123456');
    held.resolve(denied ? failure('DEVICE_REVOKED') : success({ authorized: true, account: account() }));
    await assert.rejects(authorization, { code: 'SESSION_CHANGED' });
    assert.equal(f.client.snapshot().status, 'ready'); assert.equal(f.client.snapshot().error, null);
  });
});

test('without pinned keys a signed-capable server retains live legacy authorization semantics', async () => {
  const f = await fixture({ signed: true, keys: false });
  await f.client.authorize(FEATURE); await f.client.authorize(FEATURE);
  assert.equal(f.requests.length, 2); assert.equal(f.client.checkLocalAuthorization(FEATURE), null);
});

test('pinned server-signed grants authorize locally, remain feature-specific and refresh explicitly', async () => {
  const f = await fixture({ signed: true });
  await f.client.authorize(FEATURE);
  for (let index = 0; index < 130; index++) await f.client.authorize(FEATURE);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.client.checkLocalAuthorization(FEATURE), { authorized: true, userId: 'user-1' });
  assert.equal(f.client.checkLocalAuthorization(VIDEO), null);
  await f.client.authorize(VIDEO);
  await f.client.authorize(FEATURE, { forceRemote: true });
  assert.equal(f.requests.length, 3);
  assert.ok(f.saved().entitlements[FEATURE]); assert.ok(f.saved().entitlements[VIDEO]);
});

test('temporary remote failures fall back only to a still-valid signed grant and preserve ready account state', async () => {
  const f = await fixture({ signed: true }); await f.client.authorize(FEATURE);
  f.handler(() => failure('STORAGE_RATE_LIMITED'));
  assert.equal((await f.client.authorize(FEATURE, { forceRemote: true })).authorized, true);
  assert.equal(f.requests.length, 4); assert.equal(f.client.snapshot().status, 'ready'); assert.equal(f.client.snapshot().error, null);
  assert.ok(f.diagnostics.some(([event]) => event === 'account.entitlement_fallback'));
  f.advance(ENTITLEMENT_MAX_AGE_MS);
  assert.throws(() => f.client.checkLocalAuthorization(FEATURE), { code: 'ENTITLEMENT_EXPIRED' });
  await assert.rejects(f.client.authorize(FEATURE, { forceRemote: true }), { code: 'STORAGE_RATE_LIMITED' });
});

test('authoritative denial invalidates all signed features immediately and persists invalidation', async () => {
  const f = await fixture({ signed: true }); await f.client.authorize(FEATURE); await f.client.authorize(VIDEO);
  f.handler(() => failure('DEVICE_REVOKED', 403));
  await assert.rejects(f.client.authorize(FEATURE, { forceRemote: true }), { code: 'DEVICE_REVOKED' });
  for (const feature of [FEATURE, VIDEO]) assert.throws(() => f.client.checkLocalAuthorization(feature), { code: 'ENTITLEMENT_INVALID' });
  assert.deepEqual(f.saved().entitlements, {});
  const restarted = await f.makeClient();
  assert.throws(() => restarted.checkLocalAuthorization(FEATURE), { code: 'ENTITLEMENT_INVALID' });
});

test('a concurrent grant cannot revive authorization after another feature reports revocation', async () => {
  const f = await fixture({ signed: true }); await f.client.authorize(FEATURE); await f.client.authorize(VIDEO);
  const held = deferred();
  f.handler(request => request.input.feature === VIDEO ? held.promise : failure('MEMBERSHIP_EXPIRED', 403));
  const video = f.client.authorize(VIDEO, { forceRemote: true });
  await assert.rejects(f.client.authorize(FEATURE, { forceRemote: true }), { code: 'MEMBERSHIP_EXPIRED' });
  held.resolve(success({ authorized: true, account: account(), entitlement: f.grant(VIDEO) }));
  await assert.rejects(video, { code: 'SESSION_CHANGED' });
  assert.deepEqual(f.saved().entitlements, {});
});

test('signed authorization never downgrades to an unsigned successful response', async () => {
  const f = await fixture({ signed: true }); await f.client.authorize(FEATURE);
  f.handler(() => success({ authorized: true, account: account() }));
  await assert.rejects(f.client.authorize(FEATURE, { forceRemote: true }), { code: 'ENTITLEMENT_INVALID' });
  assert.throws(() => f.client.checkLocalAuthorization(FEATURE), { code: 'ENTITLEMENT_INVALID' });
});

test('a replayed signed response cannot renew authority with a new request nonce', async () => {
  const f = await fixture({ signed: true }); await f.client.authorize(FEATURE);
  const previous = f.saved().entitlements[FEATURE].entitlement;
  f.advance(ENTITLEMENT_MAX_AGE_MS);
  f.handler(() => success({ authorized: true, account: account(), entitlement: previous }));
  await assert.rejects(f.client.authorize(FEATURE, { forceRemote: true }), { code: 'ENTITLEMENT_INVALID' });
  assert.throws(() => f.client.checkLocalAuthorization(FEATURE), { code: 'ENTITLEMENT_INVALID' });
});

test('a signed reply that expires in flight never grants extra membership time at receipt', async () => {
  const f = await fixture({ signed: true });
  f.handler(() => {
    const entitlement = f.grant(FEATURE, { membershipExpiresAt: TIME + 5000 });
    f.advance(10_000);
    return success({ authorized: true, account: account(), entitlement });
  });
  await assert.rejects(f.client.authorize(FEATURE), { code: 'ENTITLEMENT_EXPIRED' });
  assert.deepEqual(f.saved().entitlements, {});
});

test('authority that expires while waiting for encrypted persistence is never returned', async () => {
  const f = await fixture({ signed: true });
  f.handler(() => success({ authorized: true, account: account(), entitlement: f.grant(FEATURE, { membershipExpiresAt: TIME + 5000 }) }));
  const save = f.store.save;
  let delayed = false;
  f.store.save = async value => { if (!delayed) { delayed = true; f.advance(10_000); } await save(value); };
  await assert.rejects(f.client.authorize(FEATURE), { code: 'ENTITLEMENT_EXPIRED' });
  assert.deepEqual(f.saved().entitlements, {});
});

test('me membership/device denials and logout clear local signed grants', async t => {
  for (const state of ['membership', 'device', 'logout']) await t.test(state, async () => {
    const f = await fixture({ signed: true }); await f.client.authorize(FEATURE);
    if (state === 'logout') {
      await f.client.logout();
      assert.throws(() => f.client.checkLocalAuthorization(FEATURE), { code: 'ACCOUNT_AUTHORIZATION_REQUIRED' });
    } else {
      const denied = account();
      if (state === 'membership') denied.membership.active = false;
      else denied.device.status = 'revoked';
      f.handler(() => success({ account: denied })); await f.client.refresh();
      assert.throws(() => f.client.checkLocalAuthorization(FEATURE), { code: 'ENTITLEMENT_INVALID' });
    }
    assert.deepEqual(f.saved().entitlements, {});
  });
});

test('persisted grants survive restart only with the same pinned key, session, device, user and trusted clock', async t => {
  const f = await fixture({ signed: true }); await f.client.authorize(FEATURE); f.advance(1000);
  const restored = await f.makeClient(); assert.equal(restored.checkLocalAuthorization(FEATURE).authorized, true);
  for (const mutation of ['key', 'token', 'device', 'user', 'rollback']) await t.test(mutation, async () => {
    const current = await f.makeClient();
    if (mutation === 'key') current.entitlementPublicKeys = {};
    if (mutation === 'token') current.credentials.token = `${TOKEN}-replacement`;
    if (mutation === 'device') current.credentials.publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    if (mutation === 'user') current.account.user.id = 'user-2';
    if (mutation === 'rollback') {
      f.wall(TIME - 1);
      const rolledBack = await f.makeClient();
      assert.throws(() => rolledBack.checkLocalAuthorization(FEATURE), { code: 'ENTITLEMENT_INVALID' });
      f.wall(TIME + 1000); return;
    }
    assert.throws(() => current.checkLocalAuthorization(FEATURE), { code: 'ENTITLEMENT_INVALID' });
  });
});

test('monotonic time expires signed authority despite clock rollback, and fresh signed grants recover clock skew', async () => {
  const f = await fixture({ signed: true });
  f.wall(TIME + 10 * ENTITLEMENT_MAX_AGE_MS);
  await f.client.authorize(FEATURE);
  assert.equal(f.client.checkLocalAuthorization(FEATURE).authorized, true, 'a valid server signature anchors even an ahead desktop clock');
  f.mono(ENTITLEMENT_MAX_AGE_MS); f.wall(TIME - ENTITLEMENT_MAX_AGE_MS);
  assert.throws(() => f.client.checkLocalAuthorization(FEATURE), { code: 'ENTITLEMENT_EXPIRED' });
  f.serverTime(TIME + ENTITLEMENT_MAX_AGE_MS);
  await f.client.authorize(FEATURE, { forceRemote: true });
  assert.equal(f.client.checkLocalAuthorization(FEATURE).authorized, true);
});

test('background entitlement sync renews only issued features and stays idle after logout', async () => {
  const f = await fixture({ signed: true });
  assert.deepEqual(await f.client.syncEntitlements(), []); assert.equal(f.requests.length, 0);
  await f.client.authorize(FEATURE);
  assert.equal((await f.client.syncEntitlements())[0].status, 'fulfilled');
  assert.deepEqual(f.requests.filter(value => value.action === 'authorize').map(value => value.input.feature), [FEATURE, FEATURE]);
  await f.client.logout(); const calls = f.requests.length;
  assert.deepEqual(await f.client.syncEntitlements(), []); assert.equal(f.requests.length, calls);
});
