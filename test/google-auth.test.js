import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createAccountService } from '../server/auth/service.js';
import { createAccountHandler, BROWSER_COOKIE, GOOGLE_COOKIE } from '../api/account.js';
import { readConfig } from '../server/auth/config.js';
import { emptyState, validateState } from '../server/auth/store.js';
import { AccountError } from '../server/auth/errors.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const clientId = '123456789012-test-google-client.apps.googleusercontent.com';
const siteOrigin = 'https://account.example.test';
const device = () => {
  const key = generateKeyPairSync('ed25519');
  return { ...key, input: { publicKey: key.publicKey.export({ format: 'pem', type: 'spki' }), stableIdHash: createHash('sha256').update(randomUUID()).digest('hex'), name: 'Test Mac', platform: 'darwin' } };
};

function fixture(configOverrides = {}) {
  let state = emptyState(), time = Date.parse('2026-10-12T00:00:00Z'), tokenCalls = 0, jwksCalls = 0, currentNonce = '';
  let claims = {}, header = {}, signer = rsa.privateKey, writeFault = 0;
  const config = { ...readConfig({ AUTH_SECRET_PEPPER: 'google-unit-test-pepper-'.repeat(3), AUTH_SITE_ORIGIN: siteOrigin,
    AUTH_GOOGLE_CLIENT_ID: clientId, AUTH_GOOGLE_CLIENT_SECRET: 'server-only-test-secret', AUTH_ADMIN_EMAILS: 'admin@gmail.com' }), ...configOverrides };
  const store = {
    async read() { return { state: structuredClone(state) }; },
    async transaction(mutate) {
      const candidate = structuredClone(state), result = await mutate(candidate);
      if (result?.changed === false) return result.value;
      state = validateState(candidate);
      if (writeFault && --writeFault === 0) throw new AccountError('STORAGE_WRITE_UNCERTAIN', 'response lost', 503);
      return result?.value;
    },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      jwksCalls++;
      return Response.json({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] }, { headers: { 'Cache-Control': 'max-age=3600' } });
    }
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    tokenCalls++;
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('client_id'), clientId); assert.equal(body.get('client_secret'), config.googleClientSecret);
    assert.equal(body.get('redirect_uri'), `${siteOrigin}/?google_callback=1`);
    assert.equal(body.get('code_challenge'), null);
    assert.match(body.get('code_verifier'), /^[a-f0-9]{64}$/);
    const payload = { iss: 'https://accounts.google.com', aud: clientId, iat: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 3600,
      sub: 'stable-google-subject', nonce: currentNonce, email: 'member@gmail.com', email_verified: true, ...claims };
    const prefix = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', ...header })).toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url')].join('.');
    const idToken = `${prefix}.${sign('RSA-SHA256', Buffer.from(prefix), signer).toString('base64url')}`;
    return Response.json({ id_token: idToken, access_token: 'access-token-never-persisted', refresh_token: 'refresh-token-never-persisted' });
  };
  const service = createAccountService({ store, config, now: () => time, fetchImpl, mailer: { configured: false } });
  const execute = async (action, input = {}, { binding = '', dev, token = '', client = input.client === 'browser' ? 'browser' : 'desktop' } = {}) => {
    const proof = dev ? { timestamp: time, nonce: randomUUID() } : undefined;
    if (proof) proof.signature = sign(null, Buffer.from(`${action}\n${proof.timestamp}\n${proof.nonce}\n${JSON.stringify(input)}\n${token}`), dev.privateKey).toString('base64');
    return service.execute({ action, input, token, proof, googleBinding: binding, client, ip: '192.0.2.3' });
  };
  const begin = async (client = 'browser', dev) => {
    const result = await execute('google-start', { client, ...(dev ? { device: dev.input } : {}) }, { dev });
    const url = new URL(result.authorizationUrl);
    currentNonce = url.searchParams.get('nonce');
    return { ...result, state: url.searchParams.get('state'), url };
  };
  const complete = (attempt, binding = attempt.browserBinding) => execute('google-complete', { client: 'browser', code: 'google-test-code', state: attempt.state }, { binding });
  return { service, store, config, execute, begin, complete, get state() { return state; }, get time() { return time; }, get tokenCalls() { return tokenCalls; }, get jwksCalls() { return jwksCalls; },
    advance(ms) { time += ms; }, claims(value) { claims = value; }, header(value) { header = value; }, signer(value) { signer = value; }, loseWrite(number) { writeFault = number; } };
}

test('Google availability is public and misconfiguration never disables existing account operations', async () => {
  for (const override of [{ googleClientSecret: '' }, { siteOrigin: 'http://evil.test' }, { googleRedirectUri: 'https://evil.test/?google_callback=1' }]) {
    const f = fixture(override);
    assert.equal((await f.execute('google-config')).enabled, false);
    await assert.rejects(f.begin(), { code: 'GOOGLE_NOT_CONFIGURED' });
    assert.equal((await f.execute('reviews-public')).reviews.length, 0);
  }
});

test('Google browser login uses PKCE, bound state and verified identity without consuming a device', async () => {
  const f = fixture(), attempt = await f.begin();
  assert.equal(attempt.url.origin, 'https://accounts.google.com');
  assert.equal(attempt.url.searchParams.get('scope'), 'openid email profile');
  assert.equal(attempt.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(attempt.url.searchParams.get('redirect_uri'), `${siteOrigin}/?google_callback=1`);
  assert.equal(attempt.url.searchParams.get('access_type'), 'online');
  assert.equal(attempt.pollToken, undefined);
  await assert.rejects(f.complete(attempt, ''), { code: 'GOOGLE_BROWSER_MISMATCH' });
  await assert.rejects(f.complete(attempt, 'copied-browser-secret'), { code: 'GOOGLE_BROWSER_MISMATCH' });
  assert.equal(f.tokenCalls, 0, 'a mismatched browser never exchanges a code');
  const result = await f.complete(attempt);
  assert.equal(result.loginClient, 'browser'); assert.equal(result.account.user.email, 'member@gmail.com');
  assert.equal(result.account.device.status, 'unbound'); assert.equal(Object.keys(f.state.devices).length, 0);
  const persisted = JSON.stringify(f.state);
  for (const secret of [attempt.state, attempt.browserBinding, attempt.url.searchParams.get('nonce'), result.token, 'google-test-code', 'stable-google-subject', f.config.googleClientSecret, 'access-token-never-persisted', 'refresh-token-never-persisted']) assert.ok(!persisted.includes(secret), `did not persist ${secret.slice(0, 8)}`);
  assert.equal(f.jwksCalls, 1);
});

test('Google linking keeps an existing mailbox membership and stable subject survives mailbox rename', async () => {
  const f = fixture();
  await f.store.transaction(state => { state.users.existing = { id: 'existing', email: 'member@gmail.com', createdAt: new Date(f.time - 1000).toISOString(), membership: { type: 'permanent', startsAt: null, expiresAt: null } }; return { value: true }; });
  const first = await f.complete(await f.begin());
  assert.equal(first.account.user.id, 'existing'); assert.equal(first.account.membership.active, true);
  f.claims({ email: 'renamed@gmail.com' });
  const second = await f.complete(await f.begin());
  assert.equal(second.account.user.id, 'existing'); assert.equal(second.account.user.email, 'member@gmail.com'); assert.equal(second.account.membership.active, true);
  f.claims({ sub: 'different-google-subject' });
  const different = await f.begin(); f.claims({ email: 'member@gmail.com', sub: 'different-google-subject' });
  await assert.rejects(f.complete(different), { code: 'GOOGLE_ACCOUNT_CONFLICT' });
  assert.equal(Object.keys(f.state.users).length, 1);
});

test('Google third-party mailbox ownership is not inferred from email_verified; Workspace is authoritative', async () => {
  const f = fixture();
  f.claims({ email: 'third-party@example.test' });
  await assert.rejects(f.complete(await f.begin()), { code: 'GOOGLE_EMAIL_VERIFICATION_REQUIRED' });
  assert.equal(Object.keys(f.state.users).length, 0);
  f.claims({ email: 'workspace@example.test', hd: 'example.test' });
  assert.equal((await f.complete(await f.begin())).account.user.email, 'workspace@example.test');
});

test('Google rejects forged JWTs, wrong issuer/audience/nonce/azp and expired or unverified identities', async () => {
  const cases = [
    { claims: { iss: 'https://evil.test' } }, { claims: { aud: 'different-client' } }, { claims: { aud: [clientId, 'another'], azp: 'another' } },
    { claims: { azp: 'different-client' } }, { claims: { nonce: 'f'.repeat(64) } }, { claims: { nonce: '中'.repeat(64) } },
    { claims: { exp: 1 } }, { claims: { iat: 9_999_999_999 } }, { claims: { email_verified: false } }, { claims: { email_verified: 'true' } },
    { claims: { sub: '' } }, { header: { alg: 'HS256' } }, { header: { crit: ['jku'] } }, { signer: otherRsa.privateKey },
  ];
  for (const item of cases) {
    const f = fixture(); f.claims(item.claims || {}); f.header(item.header || {}); if (item.signer) f.signer(item.signer);
    await assert.rejects(f.complete(await f.begin()), { code: 'GOOGLE_IDENTITY_INVALID' });
    assert.equal(Object.keys(f.state.users).length, 0); assert.equal(Object.keys(f.state.sessions).length, 0);
  }
});

test('Google callback retries recover the same committed browser session and never revive a logout', async () => {
  const f = fixture(), attempt = await f.begin();
  f.loseWrite(2); // The final identity/session commit succeeds but its response is lost.
  await assert.rejects(f.complete(attempt), { code: 'STORAGE_WRITE_UNCERTAIN' });
  const recovered = await f.complete(attempt), replay = await f.complete(attempt);
  assert.equal(recovered.token, replay.token); assert.equal(f.tokenCalls, 1); assert.equal(Object.keys(f.state.sessions).length, 1);
  await assert.rejects(f.execute('google-complete', { client: 'browser', code: 'different-code', state: attempt.state }, { binding: attempt.browserBinding }), { code: 'GOOGLE_ATTEMPT_INVALID' });
  await f.execute('logout', { client: 'browser' }, { client: 'browser', token: recovered.token });
  await assert.rejects(f.complete(attempt), { code: 'GOOGLE_ATTEMPT_USED' });
});

test('Google desktop requires signed proof and explicit cookie-bound device confirmation before issuing a session', async () => {
  const f = fixture(), dev = device();
  await assert.rejects(f.execute('google-start', { client: 'desktop', device: dev.input }), { code: 'INVALID_DEVICE_PROOF' });
  const attempt = await f.begin('desktop', dev), poll = { client: 'desktop', attemptId: attempt.attemptId, pollToken: attempt.pollToken };
  await assert.rejects(f.execute('google-poll', poll), { code: 'INVALID_DEVICE_PROOF' });
  await assert.rejects(f.execute('google-poll', poll, { dev: device() }), { code: 'INVALID_DEVICE_PROOF' });
  await assert.rejects(f.execute('google-poll', { ...poll, pollToken: 'copied-token' }, { dev }), { code: 'GOOGLE_ATTEMPT_INVALID' });
  assert.equal((await f.execute('google-poll', poll, { dev })).status, 'pending');
  const callback = await f.complete(attempt, '');
  assert.equal(callback.status, 'confirmation_required'); assert.equal(callback.deviceName, 'Test Mac'); assert.equal(callback.email, 'member@gmail.com');
  assert.equal(callback.token, undefined); assert.equal(callback.account, undefined); assert.equal(Object.keys(f.state.users).length, 0);
  assert.equal((await f.execute('google-poll', poll, { dev })).status, 'confirmation_required');
  const confirmation = { client: 'browser', attemptId: attempt.attemptId, confirmationToken: callback.confirmationToken };
  await assert.rejects(f.execute('google-confirm', confirmation), { code: 'GOOGLE_BROWSER_MISMATCH' });
  await f.execute('google-confirm', confirmation, { binding: callback.browserBinding });
  const result = await f.execute('google-poll', poll, { dev });
  assert.equal(result.status, 'complete'); assert.equal(result.account.device.status, 'authorized');
  const replay = await f.execute('google-poll', poll, { dev });
  assert.equal(result.token, replay.token); assert.equal(result.account.device.id, replay.account.device.id); assert.equal(Object.keys(f.state.devices).length, 1);
  const persisted = JSON.stringify(f.state);
  for (const secret of [attempt.pollToken, callback.confirmationToken, callback.browserBinding, result.token, dev.input.stableIdHash]) assert.ok(!persisted.includes(secret));
  await f.execute('google-cancel', poll, { dev });
  await assert.rejects(f.execute('me', {}, { dev, token: result.token }), { code: 'SESSION_REVOKED' });
  assert.equal((await f.execute('google-cancel', poll, { dev })).status, 'cancelled');
  assert.equal(Object.keys(f.state.devices).length, 1, 'cancelling follows logout semantics and never releases a device slot');
});

test('Google desktop shares the OTP device capacity and revoked-device tombstones', async () => {
  const f = fixture(), dev = device();
  const login = async d => {
    const attempt = await f.begin('desktop', d), callback = await f.complete(attempt);
    await f.execute('google-confirm', { client: 'browser', attemptId: attempt.attemptId, confirmationToken: callback.confirmationToken }, { binding: callback.browserBinding });
    return f.execute('google-poll', { client: 'desktop', attemptId: attempt.attemptId, pollToken: attempt.pollToken }, { dev: d });
  };
  const first = await login(dev), other = await login(device());
  assert.equal(other.account.device.status, 'device_limit'); assert.equal(other.account.user.id, first.account.user.id);
  await f.store.transaction(state => { state.devices[first.account.device.id].status = 'revoked'; return { value: true }; });
  const revoked = await login(dev);
  assert.equal(revoked.account.device.status, 'revoked'); assert.equal(Object.keys(f.state.devices).length, 1);
});

test('Google expired and cancelled attempts cannot exchange or mint a session', async () => {
  const f = fixture(), expired = await f.begin();
  f.advance(600_000);
  await assert.rejects(f.complete(expired), { code: 'GOOGLE_ATTEMPT_INVALID' });
  const dev = device(), attempt = await f.begin('desktop', dev), input = { client: 'desktop', attemptId: attempt.attemptId, pollToken: attempt.pollToken };
  await f.execute('google-cancel', input, { dev });
  await assert.rejects(f.complete(attempt), { code: 'GOOGLE_ATTEMPT_INVALID' });
  assert.equal(f.tokenCalls, 0); assert.equal(Object.keys(f.state.sessions).length, 0);
});

test('Google handler hides binding/session secrets and enforces origin for every browser action', async () => {
  const f = fixture();
  const http = async (action, input, cookies = '', origin = siteOrigin) => {
    const res = { headers: {}, code: 0, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await createAccountHandler({ service: f.service, config: f.config })({ method: 'POST', body: { action, input }, headers: { 'content-type': 'application/json', origin, cookie: cookies } }, res);
    return res;
  };
  const begin = await http('google-start', { client: 'browser' });
  assert.equal(begin.code, 200); assert.equal(begin.body.browserBinding, undefined);
  assert.match(begin.headers['set-cookie'], new RegExp(`^${GOOGLE_COOKIE}=`));
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600']) assert.ok(begin.headers['set-cookie'].includes(flag));
  // Start directly to set the fixture's nonce and obtain its private binding.
  const attempt = await f.begin(), input = { client: 'browser', code: 'google-test-code', state: attempt.state };
  const completed = await http('google-complete', input, `${GOOGLE_COOKIE}=${attempt.browserBinding}`);
  assert.equal(completed.code, 200); assert.equal(completed.body.token, undefined); assert.equal(completed.body.browserBinding, undefined);
  assert.match(completed.headers['set-cookie'], new RegExp(`^${BROWSER_COOKIE}=`));
  assert.ok(completed.headers['set-cookie'].includes('HttpOnly'));
  for (const action of ['google-start', 'google-complete', 'google-confirm']) {
    const rejected = await http(action, { client: 'browser' }, '', 'https://evil.test');
    assert.equal(rejected.code, 403); assert.equal(rejected.body.error.code, 'ORIGIN_FORBIDDEN');
  }
});
