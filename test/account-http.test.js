import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHandler, ADMIN_COOKIE, BROWSER_COOKIE } from '../api/account.js';
import { AccountError } from '../server/auth/errors.js';

const origin = 'https://account.example.test';
const token = 'a'.repeat(43);
async function request({ method = 'POST', body = { action: 'me', input: {} }, headers = {}, execute = async () => ({ account: {} }) } = {}) {
  const response = { code: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(v) { this.code = v; return this; }, json(v) { this.body = v; return this; } };
  const calls = [];
  await createAccountHandler({ service: { execute: async value => { calls.push(value); return execute(value); } }, config: { siteOrigin: origin } })(
    { method, body, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, response);
  return { ...response, calls };
}

test('HTTP admin login sets a secure host-only cookie and never returns the session token in JSON', async () => {
  const result = await request({ body: { action: 'verify-code', input: { client: 'admin' } }, headers: { origin }, execute: async () => ({ token, account: { user: { role: 'admin' } } }) });
  assert.equal(result.code, 200);
  assert.equal(result.body.token, undefined);
  assert.match(result.headers['set-cookie'], new RegExp(`^${ADMIN_COOKIE}=`));
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(result.headers['set-cookie'].includes(flag));
  assert.ok(!result.headers['set-cookie'].includes('Domain='));
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('HTTP desktop proof and bearer pass only to service while browser cookies require exact origin', async () => {
  const proof = { nonce: 'fixture', timestamp: 1, signature: 'fixture' };
  const direct = await request({ body: { action: 'authorize', input: { feature: 'profile-download' }, proof }, headers: { authorization: `Bearer ${token}` } });
  assert.equal(direct.code, 200);
  assert.equal(direct.calls[0].token, token);
  assert.deepEqual(direct.calls[0].proof, proof);
  for (const badOrigin of ['', 'https://evil.test', `${origin}.evil.test`, 'null']) {
    const result = await request({ headers: { cookie: `${ADMIN_COOKIE}=${token}`, origin: badOrigin } });
    assert.equal(result.code, 403);
    assert.equal(result.calls.length, 0);
  }
});

test('every admin-prefixed endpoint requires trusted origin before service access', async () => {
  for (const action of ['admin-users', 'admin-user', 'admin-membership', 'admin-unbind', 'admin-codes', 'admin-generate-codes', 'admin-send-activation', 'admin-void-code', 'admin-audit', 'admin-status', 'admin-feedback', 'admin-feedback-detail', 'admin-feedback-part', 'admin-feedback-status', 'admin-feedback-reply', 'admin-orders', 'admin-record-order', 'admin-revenue']) {
    const rejected = await request({ body: { action, input: {} } });
    assert.equal(rejected.code, 403, action);
    assert.equal(rejected.calls.length, 0);
  }
  const cross = await request({ body: { action: 'admin-unbind', input: {} }, headers: { origin, 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.code, 403);
});

test('commerce browser cookies select only browser identity and enforce origin while desktop proof remains intact', async () => {
  const browserToken = 'b'.repeat(43), cookies = `${ADMIN_COOKIE}=${token}; ${BROWSER_COOKIE}=${browserToken}`;
  for (const action of ['review-mine', 'review-submit', 'order-create', 'orders-mine']) {
    const result = await request({ body: { action, input: {} }, headers: { origin, cookie: cookies } });
    assert.equal(result.code, 200); assert.equal(result.calls[0].client, 'browser'); assert.equal(result.calls[0].token, browserToken);
    const denied = await request({ body: { action, input: {} }, headers: { origin: 'https://evil.test', cookie: `${BROWSER_COOKIE}=${browserToken}` } });
    assert.equal(denied.code, 403); assert.equal(denied.calls.length, 0);
    const noFallback = await request({ body: { action, input: { client: 'browser' } }, headers: { origin, cookie: `${ADMIN_COOKIE}=${token}` } });
    assert.equal(noFallback.calls[0].token, '');
    const proof = { timestamp: 1, nonce: 'proof-fixture', signature: 'signature-fixture' };
    const desktop = await request({ body: { action, input: {}, proof }, headers: { authorization: `Bearer ${token}` } });
    assert.equal(desktop.calls[0].client, 'desktop'); assert.deepEqual(desktop.calls[0].proof, proof);
  }
  const publicReviews = await request({ body: { action: 'reviews-public', input: {} } });
  assert.equal(publicReviews.code, 200); assert.equal(publicReviews.calls[0].token, '');
});

test('reply HTTP envelopes admit full Chinese and escaped text with authentication headers intact', async () => {
  for (const action of ['feedback-reply', 'admin-feedback-reply']) {
    for (const content of ['中'.repeat(8000), '\u0000'.repeat(8000)]) {
      const input = { feedbackId: '12345678-1234-1234-1234-123456789012', requestId: '12345678-1234-1234-1234-123456789013', content };
      const result = await request({ body: JSON.stringify({ action, input }), headers: { origin, ...(action.startsWith('admin-') ? { cookie: `${ADMIN_COOKIE}=${token}` } : { authorization: `Bearer ${token}` }) } });
      assert.equal(result.code, 200); assert.equal(result.calls[0].input.content, content); assert.equal(result.calls[0].token, token);
    }
    const oversized = await request({ body: { action, input: { content: 'a'.repeat(49152) } }, headers: { origin } });
    assert.equal(oversized.code, 413); assert.equal(oversized.calls.length, 0);
  }
});

test('HTTP admits bounded feedback manifests and full log chunks without widening ordinary action limits', async () => {
  const manifest = { action: 'feedback-begin', input: { description: '中'.repeat(8000), parts: Array.from({ length: 64 }, () => ({ bytes: 100, sha256: 'a'.repeat(64) })) } };
  const accepted = await request({ body: JSON.stringify(manifest), headers: { authorization: `Bearer ${token}` } });
  assert.equal(accepted.code, 200); assert.equal(accepted.calls.length, 1);
  const content = '"'.repeat(262144);
  const uploaded = await request({ body: { action: 'feedback-upload-part', input: { content } } });
  assert.equal(uploaded.code, 200); assert.equal(uploaded.calls[0].input.content, content);
  for (const action of ['me', 'feedback-finalize', 'admin-feedback-detail']) {
    const rejected = await request({ body: { action, input: { content } }, headers: { origin } });
    assert.equal(rejected.code, 413); assert.equal(rejected.calls.length, 0);
  }
  const tooLarge = await request({ body: { action: 'feedback-upload-part', input: { content: 'a'.repeat(1_600_000) } } });
  assert.equal(tooLarge.code, 413); assert.equal(tooLarge.calls.length, 0);
  const claimedSize = await request({ body: manifest, headers: { 'content-length': '50000' } });
  assert.equal(claimedSize.code, 413); assert.equal(claimedSize.calls.length, 0);
});

test('HTTP rejects malformed, oversized, mixed credentials and non-JSON requests', async () => {
  assert.equal((await request({ method: 'GET' })).code, 405);
  assert.equal((await request({ headers: { 'content-type': 'text/plain' } })).code, 415);
  assert.equal((await request({ body: '{' })).code, 400);
  assert.equal((await request({ body: [] })).code, 400);
  assert.equal((await request({ body: { action: 'me', input: { value: 'a'.repeat(17000) } } })).code, 413);
  const mixed = await request({ headers: { origin, authorization: `Bearer ${token}`, cookie: `${ADMIN_COOKIE}=${token}` } });
  assert.equal(mixed.code, 400);
  assert.equal(mixed.calls.length, 0);
});

test('HTTP rejects a throwing lazy JSON body getter before configuration or account service access', async () => {
  let reads = 0;
  const req = { method: 'POST', headers: { 'content-type': 'application/json' } };
  Object.defineProperty(req, 'body', { get() { reads++; throw new SyntaxError('private-invalid-body-sentinel'); } });
  const res = { code: 200, headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  const handler = createAccountHandler({
    env: new Proxy({}, { get() { assert.fail('Malformed lazy JSON reached account configuration'); } }),
    service: { execute() { assert.fail('Malformed lazy JSON reached account service'); } },
  });
  await handler(req, res);
  assert.equal(reads, 1);
  assert.equal(res.code, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'INVALID_JSON');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(res.body), /private-invalid-body-sentinel/);
});

test('HTTP role denial and storage failures never become success or expose internal errors', async () => {
  const denied = await request({ body: { action: 'admin-membership', input: {} }, headers: { origin }, execute: async () => { throw new AccountError('FORBIDDEN', '权限不足', 403); } });
  assert.equal(denied.code, 403);
  assert.equal(denied.body.ok, false);
  const failed = await request({ execute: async () => { throw new Error('private-credential-sentinel'); } });
  assert.equal(failed.code, 503);
  assert.equal(failed.body.ok, false);
  assert.ok(!JSON.stringify(failed.body).includes('private-credential-sentinel'));
});

test('HTTP logout clears the admin cookie only after server confirms revocation', async () => {
  const options = { body: { action: 'logout', input: {} }, headers: { origin, cookie: `${ADMIN_COOKIE}=${token}` } };
  assert.match((await request(options)).headers['set-cookie'], /Max-Age=0/);
  const failed = await request({ ...options, execute: async () => { throw new AccountError('STORAGE_UNAVAILABLE', '暂不可用', 503); } });
  assert.equal(failed.code, 503);
  assert.equal(failed.headers['set-cookie'], undefined);
});

test('browser OTP login keeps its session in a separate secure cookie and never returns the token', async () => {
  const result = await request({ body: { action: 'verify-code', input: { client: 'browser' } }, headers: { origin }, execute: async value => {
    assert.equal(value.client, 'browser'); return { token, account: { user: { role: 'user' } } };
  } });
  assert.equal(result.code, 200); assert.equal(result.body.token, undefined);
  assert.match(result.headers['set-cookie'], new RegExp(`^${BROWSER_COOKIE}=`));
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(result.headers['set-cookie'].includes(flag));
  assert.ok(!result.headers['set-cookie'].includes('Domain='));
  for (const action of ['send-code', 'verify-code', 'me', 'logout']) {
    for (const badOrigin of ['', 'https://evil.test', `${origin}.evil.test`]) {
      const denied = await request({ body: { action, input: { client: 'browser' } }, headers: { origin: badOrigin } });
      assert.equal(denied.code, 403); assert.equal(denied.calls.length, 0);
    }
  }
});

test('coexisting browser and admin cookies select explicit sessions and logout clears only the chosen client', async () => {
  const browserToken = 'b'.repeat(43), cookies = `${ADMIN_COOKIE}=${token}; ${BROWSER_COOKIE}=${browserToken}`;
  const selected = [
    ['me', { client: 'browser' }, browserToken, 'browser'], ['logout', { client: 'browser' }, browserToken, 'browser'],
    ['feedback-owner-detail', {}, browserToken, 'browser'], ['feedback-owner-reply', {}, browserToken, 'browser'],
    ['feedback-public-comment', {}, browserToken, 'browser'], ['admin-feedback-detail', {}, token, 'admin'],
    ['me', {}, token, 'admin'], ['logout', {}, token, 'admin'],
  ];
  for (const [action, input, expectedToken, expectedClient] of selected) {
    const result = await request({ body: { action, input }, headers: { origin, cookie: cookies } });
    assert.equal(result.code, 200); assert.equal(result.calls[0].token, expectedToken); assert.equal(result.calls[0].client, expectedClient);
    if (action === 'logout') assert.match(result.headers['set-cookie'], new RegExp(`^${expectedClient === 'browser' ? BROWSER_COOKIE : ADMIN_COOKIE}=;.*Max-Age=0`));
  }
  for (const action of ['me', 'logout', 'feedback-owner-detail', 'feedback-owner-reply']) {
    const result = await request({ body: { action, input: { client: 'browser' } }, headers: { origin, cookie: `${ADMIN_COOKIE}=${token}` } });
    assert.equal(result.calls[0].token, '', 'a browser action never falls back to an administrator cookie');
    assert.equal(result.headers['set-cookie'], undefined);
  }
  const failed = await request({ body: { action: 'logout', input: { client: 'browser' } }, headers: { origin, cookie: cookies }, execute: async () => { throw new AccountError('STORAGE_UNAVAILABLE', '暂不可用', 503); } });
  assert.equal(failed.headers['set-cookie'], undefined);
});

test('board HTTP reads are anonymous while comments and owner actions preserve transport and size boundaries', async () => {
  for (const action of ['feedback-public-list', 'feedback-public-detail']) {
    const result = await request({ body: { action, input: {} } }); assert.equal(result.code, 200); assert.equal(result.calls[0].token, '');
  }
  for (const action of ['feedback-owner-detail', 'feedback-owner-reply', 'feedback-public-comment']) {
    const rejected = await request({ body: { action, input: {} }, headers: { cookie: `${BROWSER_COOKIE}=${token}`, origin: 'https://evil.test' } });
    assert.equal(rejected.code, 403); assert.equal(rejected.calls.length, 0);
  }
  const mixed = await request({ body: { action: 'feedback-public-comment', input: {} }, headers: { origin, cookie: `${BROWSER_COOKIE}=${token}`, authorization: `Bearer ${token}` } });
  assert.equal(mixed.body.error.code, 'AMBIGUOUS_CREDENTIALS');
  for (const content of ['中'.repeat(2000), '\u0000'.repeat(2000)]) {
    const accepted = await request({ body: { action: 'feedback-public-comment', input: { content, expectedUserId: 'draft-account-id' } }, headers: { origin, cookie: `${BROWSER_COOKIE}=${token}` } });
    assert.equal(accepted.code, 200); assert.equal(accepted.calls[0].input.content, content);
    assert.equal(accepted.calls[0].input.expectedUserId, 'draft-account-id');
  }
  const tooLarge = await request({ body: { action: 'feedback-public-comment', input: { content: 'a'.repeat(16384) } }, headers: { origin } });
  assert.equal(tooLarge.code, 413);
  const reply = await request({ body: { action: 'feedback-owner-reply', input: { content: '\u0000'.repeat(8000) } }, headers: { origin, cookie: `${BROWSER_COOKIE}=${token}` } });
  assert.equal(reply.code, 200);
});
