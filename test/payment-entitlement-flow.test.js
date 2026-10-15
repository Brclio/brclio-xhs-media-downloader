import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AccountClient } from '../desktop/account-client.js';
import { issueEntitlement } from '../lib/entitlement.js';
import { PROTECTED_FEATURES } from '../lib/membership-policy.js';

const START = Date.parse('2026-10-15T02:00:00Z');
const TOKEN = 'payment-entitlement-fixture-session-000000000000';
const failure = (code, status = 503) => Response.json({ ok: false, error: { code, message: code } }, { status });
function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

async function fixture({ paid = false } = {}) {
  const device = generateKeyPairSync('ed25519'), issuer = generateKeyPairSync('ed25519');
  let stored = { version: 1, token: TOKEN, privateKey: device.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: device.publicKey.export({ type: 'spki', format: 'pem' }), stableIdHash: 'a'.repeat(64),
    pendingLogoutTokens: [], pendingRedemptions: {} };
  let clock = START, expiresAt = START + 60_000, deviceStatus = 'authorized';
  let meFailure = null, authorizeFailure = null, authorizationBarrier = null, corruptGrant = false;
  const calls = [], updates = [];
  const account = () => {
    const active = paid && clock < expiresAt;
    return { user: { id: 'payment-fixture-user', email: 'paid@example.test' },
      membership: { type: paid ? 'duration' : 'none', active,
        ...(paid ? { startsAt: new Date(START).toISOString(), expiresAt: new Date(expiresAt).toISOString() } : {}) },
      device: { id: 'payment-fixture-device', status: deviceStatus, message: `device ${deviceStatus}` },
      features: Object.fromEntries(PROTECTED_FEATURES.map(feature => [feature, { allowed: active && deviceStatus === 'authorized' }])),
      serverTime: new Date(clock).toISOString() };
  };
  const client = new AccountClient({ endpoint: 'https://accounts.example.test/api/account',
    store: { load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); },
      device: credentials => ({ publicKey: credentials.publicKey, stableIdHash: credentials.stableIdHash, platform: 'win32', name: 'Payment fixture' }) },
    now: () => clock, monotonicNow: () => clock - START, sleep: async () => {},
    entitlementPublicKeys: { fixture: issuer.publicKey }, onUpdate: state => updates.push(state),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body), token = init.headers.Authorization?.replace(/^Bearer /, '') || '';
      const payload = `${request.action}\n${request.proof.timestamp}\n${request.proof.nonce}\n${JSON.stringify(request.input)}\n${token}`;
      assert.equal(verify(null, Buffer.from(payload), device.publicKey, Buffer.from(request.proof.signature, 'base64')), true);
      calls.push(request);
      if (request.action === 'me') return meFailure ? failure(meFailure) : Response.json({ ok: true, account: account() });
      if (request.action === 'verify-code') return Response.json({ ok: true, token: TOKEN, account: account() });
      assert.equal(request.action, 'authorize');
      if (authorizationBarrier) await authorizationBarrier(request);
      if (authorizeFailure) return failure(authorizeFailure);
      if (!account().features[request.input.feature].allowed) return failure(deviceStatus === 'revoked' ? 'DEVICE_REVOKED' : 'MEMBERSHIP_REQUIRED', 403);
      const entitlement = issueEntitlement({ privateKey: issuer.privateKey, keyId: 'fixture', token,
          publicKey: stored.publicKey, userId: 'payment-fixture-user', deviceId: 'payment-fixture-device',
          feature: request.input.feature, now: clock, membershipExpiresAt: expiresAt, requestNonce: request.proof.nonce });
      if (corruptGrant) entitlement.signature = Buffer.alloc(64).toString('base64url');
      return Response.json({ ok: true, authorized: true, account: account(), entitlement });
    } });
  await client.initialize();
  await client.refresh();
  return { client, calls, updates, saved: () => structuredClone(stored),
    pay: expiry => { paid = true; if (expiry) expiresAt = expiry; },
    advance: value => { clock = value; }, device: value => { deviceStatus = value; },
    failMe: value => { meFailure = value; }, failAuthorize: value => { authorizeFailure = value; },
    corruptGrant: value => { corruptGrant = value; },
    holdAuthorization: value => { authorizationBarrier = value; } };
}

const permissionsAllowed = result => {
  assert.equal(result.complete, true);
  assert.deepEqual(result.permissions, PROTECTED_FEATURES.map(feature => ({ feature, authorized: true })));
};
const assertLocalGuards = client => {
  for (const feature of PROTECTED_FEATURES) assert.deepEqual(client.checkLocalAuthorization(feature),
    { authorized: true, userId: 'payment-fixture-user' });
};
const claims = (f, feature) => JSON.parse(Buffer.from(f.saved().entitlements[feature].entitlement.payload, 'base64url').toString('utf8'));

test('payment confirmation refreshes membership and signs both newly allowed desktop features immediately', { timeout: 5000 }, async () => {
  const f = await fixture();
  assert.equal(f.client.snapshot().account.membership.active, false);
  f.pay();
  f.calls.length = 0;
  permissionsAllowed(await f.client.refreshAccountPermissions());
  assert.equal(f.calls[0].action, 'me', 'The saved unpaid account must be replaced before permissions are requested');
  assert.deepEqual(f.calls.slice(1).map(call => call.input.feature).sort(), [...PROTECTED_FEATURES].sort());
  assert.equal(f.client.snapshot().verified, true);
  assert.equal(f.client.snapshot().account.membership.active, true);
  for (const feature of PROTECTED_FEATURES) assert.equal(f.client.snapshot().account.features[feature].allowed, true);
  assertLocalGuards(f.client);
  assert.ok(f.updates.some(state => state.verified && state.account?.membership?.active), 'Refreshed membership is published to renderer subscribers');
});

test('a paid renewal replaces existing signed grants before their old membership deadline', { timeout: 5000 }, async () => {
  const f = await fixture({ paid: true });
  for (const feature of PROTECTED_FEATURES) await f.client.authorize(feature);
  for (const feature of PROTECTED_FEATURES) assert.equal(claims(f, feature).expiresAt, START + 60_000);
  f.advance(START + 30_000);
  f.pay(START + 120_000);
  f.calls.length = 0;
  permissionsAllowed(await f.client.refreshAccountPermissions());
  assert.equal(f.calls.filter(call => call.action === 'authorize').length, PROTECTED_FEATURES.length, 'Valid local grants must not bypass the fresh remote renewal');
  for (const feature of PROTECTED_FEATURES) {
    assert.equal(claims(f, feature).expiresAt, START + 120_000);
    assert.equal(claims(f, feature).membershipExpiresAt, START + 120_000);
  }
  f.advance(START + 60_001);
  assertLocalGuards(f.client);
});

test('confirmed membership cannot grant features to a device that the account service denies', async t => {
  for (const [device, code] of [['device_limit', 'DEVICE_LIMIT'], ['revoked', 'DEVICE_REVOKED']]) await t.test(device, async () => {
    const f = await fixture({ paid: true });
    for (const feature of PROTECTED_FEATURES) await f.client.authorize(feature);
    f.device(device);
    f.calls.length = 0;
    const result = await f.client.refreshAccountPermissions();
    assert.equal(result.complete, true, 'An explicit permission denial is a resolved account state');
    assert.deepEqual(result.permissions.map(permission => ({ feature: permission.feature, authorized: permission.authorized, code: permission.error?.code })),
      PROTECTED_FEATURES.map(feature => ({ feature, authorized: false, code })));
    assert.equal(f.client.snapshot().account.membership.active, true, 'Delivery of membership and this device permission remain separate facts');
    assert.equal(f.calls.filter(call => call.action === 'authorize').length, 0);
    assert.deepEqual(f.saved().entitlements, {});
    for (const feature of PROTECTED_FEATURES) assert.throws(() => f.client.checkLocalAuthorization(feature));
  });
});

test('temporary permission failures keep a paid order unresolved and recover on the next refresh', { timeout: 5000 }, async () => {
  const f = await fixture();
  f.pay();
  f.failAuthorize('SERVICE_UNAVAILABLE');
  const result = await f.client.refreshAccountPermissions();
  assert.equal(result.complete, false);
  for (const permission of result.permissions) {
    assert.equal(permission.authorized, false);
    assert.equal(permission.error.code, 'SERVICE_UNAVAILABLE');
  }
  assert.equal(f.calls.filter(call => call.action === 'authorize').length, PROTECTED_FEATURES.length * 3, 'Fresh remote authorization uses the bounded transient retry policy');
  f.failAuthorize(null);
  permissionsAllowed(await f.client.refreshAccountPermissions());
  assertLocalGuards(f.client);
});

test('an older still-valid grant cannot hide a failed permission refresh after payment', { timeout: 5000 }, async () => {
  const f = await fixture({ paid: true });
  for (const feature of PROTECTED_FEATURES) await f.client.authorize(feature);
  f.pay(START + 120_000);
  f.failAuthorize('STORAGE_UNAVAILABLE');
  const result = await f.client.refreshAccountPermissions();
  assert.equal(result.complete, false);
  assert.ok(result.permissions.every(permission => !permission.authorized && permission.error.code === 'STORAGE_UNAVAILABLE'));
  for (const feature of PROTECTED_FEATURES) assert.equal(claims(f, feature).expiresAt, START + 60_000);
  assertLocalGuards(f.client);
});

test('a malformed new grant keeps payment verification unresolved even when valid old grants existed', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'existing grants' : 'first grants', async () => {
    const f = await fixture({ paid: true });
    if (existing) for (const feature of PROTECTED_FEATURES) await f.client.authorize(feature);
    f.pay(START + 120_000);
    f.corruptGrant(true);
    const result = await f.client.refreshAccountPermissions();
    assert.equal(result.complete, false, 'An invalid signature is an unresolved permission response, not a confirmed membership or device denial');
    assert.ok(result.permissions.every(permission => !permission.authorized));
    assert.ok(result.permissions.some(permission => permission.error.code === 'ENTITLEMENT_INVALID'));
    assert.deepEqual(f.saved().entitlements, {}, 'The invalid remote grant also retires older authority');
    f.corruptGrant(false);
    permissionsAllowed(await f.client.refreshAccountPermissions());
    assertLocalGuards(f.client);
  });
});

test('a failed post-payment account refresh does not prevent a later retry from restoring features', { timeout: 5000 }, async () => {
  const f = await fixture();
  f.pay();
  f.failMe('SERVICE_UNAVAILABLE');
  await assert.rejects(f.client.refreshAccountPermissions(), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(f.client.snapshot().authenticated, true);
  assert.equal(f.client.snapshot().verified, false);
  assert.equal(f.calls.filter(call => call.action === 'authorize').length, 0);
  f.failMe(null);
  permissionsAllowed(await f.client.refreshAccountPermissions());
  assert.equal(f.client.snapshot().verified, true);
  assertLocalGuards(f.client);
});

test('a delayed permission refresh cannot modify a replacement login even when user and token repeat', { timeout: 5000 }, async () => {
  const f = await fixture({ paid: true }), started = deferred(), release = deferred();
  let waiting = 0;
  f.holdAuthorization(async () => { if (++waiting === PROTECTED_FEATURES.length) started.resolve(); await release.promise; });
  const refresh = f.client.refreshAccountPermissions();
  const rejected = assert.rejects(refresh, { code: 'SESSION_CHANGED' });
  await started.promise;
  await f.client.verifyCode('paid@example.test', '123456');
  release.resolve();
  await rejected;
  assert.equal(f.client.snapshot().verified, true);
  assert.equal(f.client.snapshot().account.user.id, 'payment-fixture-user');
  assert.deepEqual(f.saved().entitlements, {});
});
