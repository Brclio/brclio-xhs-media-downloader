import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ENTITLEMENT_MAX_AGE_MS, ENTITLEMENT_SYNC_INTERVAL_MS, issueEntitlement, verifyEntitlement } from '../lib/entitlement.js';
import { readConfig } from '../server/auth/config.js';
import { createAccountService } from '../server/auth/service.js';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';

const issuer = generateKeyPairSync('ed25519'), device = generateKeyPairSync('ed25519');
const issuerPem = issuer.privateKey.export({ type: 'pkcs8', format: 'pem' });
const devicePem = device.publicKey.export({ type: 'spki', format: 'pem' });
const clock = Date.parse('2026-10-12T00:00:00Z'), token = 'unit-test-session-token-'.repeat(2);
const hash = value => createHash('sha256').update(value).digest('hex');
const options = (overrides = {}) => ({ privateKey: issuer.privateKey, keyId: 'v1', token, publicKey: devicePem,
  userId: 'user-1', deviceId: 'device-1', requestNonce: 'fixture-request-nonce-0001', feature: 'profile-download', membershipExpiresAt: null, now: clock, ...overrides });
const verification = (overrides = {}) => ({ publicKeys: { v1: issuer.publicKey }, now: clock, token, publicKey: devicePem,
  feature: 'profile-download', userId: 'user-1', ...overrides });
function replaceClaims(entitlement, update) {
  const claims = JSON.parse(Buffer.from(entitlement.payload, 'base64url').toString('utf8'));
  update(claims);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { ...entitlement, payload, signature: sign(null, Buffer.from(`${entitlement.keyId}.${payload}`), issuer.privateKey).toString('base64url') };
}

test('Ed25519 grants bind the current identity, session, device and protected feature within 24 hours', () => {
  const entitlement = issueEntitlement(options()), claims = verifyEntitlement(entitlement, verification());
  assert.equal(ENTITLEMENT_MAX_AGE_MS, 86_400_000);
  assert.equal(ENTITLEMENT_SYNC_INTERVAL_MS, 300_000);
  assert.deepEqual(claims, { version: 1, issuer: 'brclio-xhs-account', audience: 'brclio-xhs-desktop',
    userId: 'user-1', deviceId: 'device-1', deviceKeyHash: hash(device.publicKey.export({ type: 'spki', format: 'der' })),
    sessionHash: hash(token), requestNonce: 'fixture-request-nonce-0001', features: ['profile-download'], issuedAt: clock,
    expiresAt: clock + ENTITLEMENT_MAX_AGE_MS, membershipExpiresAt: null });
  assert.doesNotMatch(Buffer.from(entitlement.payload, 'base64url').toString(), /BEGIN PUBLIC KEY|unit-test-session-token/);
  const memberExpiry = clock + 45_000;
  const short = verifyEntitlement(issueEntitlement(options({ membershipExpiresAt: memberExpiry })), verification());
  assert.equal(short.expiresAt, memberExpiry);
  assert.equal(short.membershipExpiresAt, memberExpiry);
  const long = verifyEntitlement(issueEntitlement(options({ membershipExpiresAt: clock + 10 * ENTITLEMENT_MAX_AGE_MS })), verification());
  assert.equal(long.expiresAt, clock + ENTITLEMENT_MAX_AGE_MS);
});

test('local grants reject forged signatures, unpinned keys, other users, sessions, devices and features', () => {
  const entitlement = issueEntitlement(options());
  for (const context of [
    { token: `${token}different` }, { publicKey: generateKeyPairSync('ed25519').publicKey }, { requestNonce: randomUUID() },
    { userId: 'another-user' }, { feature: 'watermark-free-video' }, { feature: 'single-download' },
    { publicKeys: {} }, { publicKeys: { v1: generateKeyPairSync('ed25519').publicKey } },
    { publicKeys: Object.create({ v1: issuer.publicKey }) },
  ]) assert.throws(() => verifyEntitlement(entitlement, verification(context)), { code: 'ENTITLEMENT_INVALID' });
  for (const changed of [
    { ...entitlement, signature: 'A'.repeat(86) }, { ...entitlement, payload: `${entitlement.payload}A` },
    { ...entitlement, keyId: 'v2' }, { ...entitlement, keyId: 1 }, { ...entitlement, payload: `${entitlement.payload}=` },
    { ...entitlement, signature: `${entitlement.signature}=` }, { ...entitlement, extra: true }, null,
  ]) assert.throws(() => verifyEntitlement(changed, verification()), { code: 'ENTITLEMENT_INVALID' });
  assert.equal(verifyEntitlement(entitlement, verification({ publicKeys: new Map([['v1', issuer.publicKey]]) })).userId, 'user-1');
  assert.equal(verifyEntitlement(entitlement, verification({ requestNonce: 'fixture-request-nonce-0001' })).userId, 'user-1');
});

test('even signed grants enforce schema, audience, duration, membership expiry and server issuance time', () => {
  const entitlement = issueEntitlement(options());
  for (const update of [
    claims => { claims.version = 2; }, claims => { claims.issuer = 'other'; }, claims => { claims.audience = 'browser'; },
    claims => { delete claims.deviceId; }, claims => { claims.extra = true; }, claims => { claims.deviceId = '../escape'; },
    claims => { delete claims.requestNonce; }, claims => { claims.requestNonce = 'short'; },
    claims => { claims.features = ['single-download']; }, claims => { claims.features.push('watermark-free-video'); },
    claims => { claims.issuedAt = clock + 1; }, claims => { claims.expiresAt = clock; },
    claims => { claims.expiresAt += 1; }, claims => { claims.expiresAt = String(claims.expiresAt); },
    claims => { claims.membershipExpiresAt = claims.expiresAt - 1; }, claims => { claims.membershipExpiresAt = 'permanent'; },
    claims => { claims.sessionHash = '0'.repeat(64); }, claims => { claims.deviceKeyHash = '0'.repeat(64); },
  ]) assert.throws(() => verifyEntitlement(replaceClaims(entitlement, update), verification()), { code: 'ENTITLEMENT_INVALID' });
});

test('local grant expiry is strict and never extends membership', () => {
  const expiry = clock + 1000, entitlement = issueEntitlement(options({ membershipExpiresAt: expiry }));
  assert.equal(verifyEntitlement(entitlement, verification({ now: expiry - 1 })).expiresAt, expiry);
  for (const now of [expiry, expiry + 1, clock + ENTITLEMENT_MAX_AGE_MS]) {
    assert.throws(() => verifyEntitlement(entitlement, verification({ now })), { code: 'ENTITLEMENT_EXPIRED' });
  }
  for (const context of [{ feature: 'single-download' }, { membershipExpiresAt: clock }, { membershipExpiresAt: clock - 1 },
    { keyId: 1 }, { now: Number.MAX_SAFE_INTEGER }, { requestNonce: undefined },
    { privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }, { publicKey: 'invalid-public-key' }]) {
    assert.throws(() => issueEntitlement(options(context)), { code: 'ENTITLEMENT_INVALID' });
  }
});

test('signing configuration remains optional and only accepts Ed25519 private keys and safe IDs', () => {
  const env = { AUTH_SECRET_PEPPER: 'entitlement-test-only-pepper-'.repeat(2) };
  assert.equal(readConfig(env).entitlementPrivateKey, null);
  const configured = readConfig({ ...env, AUTH_ENTITLEMENT_PRIVATE_KEY: issuerPem.replaceAll('\n', '\\n') });
  assert.equal(configured.entitlementPrivateKey.asymmetricKeyType, 'ed25519');
  assert.equal(configured.entitlementKeyId, 'v1');
  for (const extra of [
    { AUTH_ENTITLEMENT_PRIVATE_KEY: 'broken' }, { AUTH_ENTITLEMENT_PRIVATE_KEY: issuer.publicKey.export({ format: 'pem', type: 'spki' }) },
    { AUTH_ENTITLEMENT_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }) },
    { AUTH_ENTITLEMENT_KEY_ID: '../invalid' },
  ]) assert.throws(() => readConfig({ ...env, ...extra }), { code: 'SERVICE_NOT_CONFIGURED' });
});

function serviceFixture({ signing = true, client = 'desktop', membershipType = 'duration', stale = false } = {}) {
  const config = readConfig({ AUTH_SECRET_PEPPER: 'entitlement-service-test-pepper-'.repeat(2), ...(signing ? { AUTH_ENTITLEMENT_PRIVATE_KEY: issuerPem } : {}) });
  let state = emptyState(), writes = 0, beforeTransaction = null, lastNonce;
  state.users['user-1'] = { id: 'user-1', email: 'member@example.test', createdAt: new Date(clock).toISOString(),
    membership: { type: membershipType, startsAt: new Date(clock - 1000).toISOString(), expiresAt: membershipType === 'duration' ? new Date(clock + 60_000).toISOString() : null } };
  state.devices['device-1'] = { id: 'device-1', userId: 'user-1', status: 'active', publicKey: devicePem,
    lastCheckedAt: new Date(stale ? clock - ENTITLEMENT_MAX_AGE_MS : clock).toISOString() };
  const sessionKey = digest(config.pepper, 'session', token);
  state.sessions[sessionKey] = { id: 'session-1', userId: 'user-1', client, publicKey: devicePem, deviceId: 'device-1' };
  const store = { async read() { return { state: structuredClone(state), sha: 'fixture' }; },
    async transaction(mutate) {
      beforeTransaction?.(state);
      const latest = structuredClone(state), result = await mutate(latest);
      if (result.changed !== false) { state = latest; writes++; }
      return result.value;
    } };
  const service = createAccountService({ config, store, mailer: {}, now: () => clock });
  const authorize = (feature = 'profile-download') => {
    const input = { feature }, timestamp = clock, nonce = randomUUID();
    lastNonce = nonce;
    const proof = { timestamp, nonce, signature: sign(null, Buffer.from(`authorize\n${timestamp}\n${nonce}\n${JSON.stringify(input)}\n${token}`), device.privateKey).toString('base64') };
    return service.execute({ action: 'authorize', input, proof, token, client });
  };
  return { authorize, get state() { return state; }, get writes() { return writes; }, get lastNonce() { return lastNonce; }, sessionKey,
    set beforeTransaction(callback) { beforeTransaction = callback; } };
}

test('authoritative service signs protected desktop rights after read or daily revalidation with exact member expiry', async () => {
  for (const stale of [false, true]) {
    const f = serviceFixture({ stale }), result = await f.authorize();
    const claims = verifyEntitlement(result.entitlement, verification());
    assert.equal(claims.requestNonce, f.lastNonce);
    assert.equal(claims.expiresAt, clock + 60_000);
    assert.equal(claims.membershipExpiresAt, clock + 60_000);
    assert.equal(f.writes, Number(stale));
  }
  const permanent = await serviceFixture({ membershipType: 'permanent' }).authorize('watermark-free-video');
  assert.equal(verifyEntitlement(permanent.entitlement, verification({ feature: 'watermark-free-video' })).expiresAt, clock + ENTITLEMENT_MAX_AGE_MS);
});

test('legacy backends, browsers and free features do not issue local protected entitlements', async () => {
  assert.equal((await serviceFixture({ signing: false }).authorize()).entitlement, undefined);
  assert.equal((await serviceFixture({ client: 'browser' }).authorize('watermark-free-video')).entitlement, undefined);
  assert.equal((await serviceFixture().authorize('single-download')).entitlement, undefined);
});

test('authoritative membership, session and device denial blocks signing including a concurrent daily check', async () => {
  for (const [update, code] of [
    [f => { f.state.sessions[f.sessionKey].revokedAt = new Date(clock).toISOString(); }, 'SESSION_REVOKED'],
    [f => { f.state.devices['device-1'].status = 'revoked'; }, 'DEVICE_REVOKED'],
    [f => { f.state.users['user-1'].membership.expiresAt = new Date(clock).toISOString(); }, 'MEMBERSHIP_EXPIRED'],
  ]) {
    const f = serviceFixture(); update(f); await assert.rejects(f.authorize(), { code });
  }
  for (const [update, code] of [
    [state => { Object.values(state.sessions)[0].revokedAt = new Date(clock).toISOString(); }, 'SESSION_REVOKED'],
    [state => { state.devices['device-1'].status = 'revoked'; }, 'DEVICE_REVOKED'],
    [state => { state.users['user-1'].membership.expiresAt = new Date(clock).toISOString(); }, 'MEMBERSHIP_EXPIRED'],
  ]) {
    const f = serviceFixture({ stale: true }); f.beforeTransaction = update;
    await assert.rejects(f.authorize(), { code }); assert.equal(f.writes, 0);
  }
});

test('signed desktop entitlements execute and verify inside the real Cloudflare runtime', async t => {
  const input = options({ privateKey: issuerPem });
  const pinned = issuer.publicKey.export({ format: 'pem', type: 'spki' });
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
    import { issueEntitlement, verifyEntitlement } from './lib/entitlement.js';
    export default { fetch() {
      const entitlement = issueEntitlement(${JSON.stringify(input)});
      const claims = verifyEntitlement(entitlement, ${JSON.stringify(verification({ publicKeys: { v1: pinned } }))});
      return Response.json({ userId: claims.userId, expiresAt: claims.expiresAt });
    } };
  ` }, bundle: true, format: 'esm', write: false, platform: 'neutral', packages: 'external' });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'] }));
  t.after(() => runtime.dispose());
  assert.deepEqual(await (await runtime.dispatchFetch('https://fixture.test/')).json(), { userId: 'user-1', expiresAt: clock + ENTITLEMENT_MAX_AGE_MS });
});
