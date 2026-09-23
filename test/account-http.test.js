import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHandler, ADMIN_COOKIE } from '../api/account.js';
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
  for (const action of ['admin-users', 'admin-user', 'admin-membership', 'admin-unbind', 'admin-codes', 'admin-generate-codes', 'admin-send-activation', 'admin-void-code', 'admin-audit', 'admin-status', 'admin-feedback', 'admin-feedback-detail', 'admin-feedback-part', 'admin-feedback-status']) {
    const rejected = await request({ body: { action, input: {} } });
    assert.equal(rejected.code, 403, action);
    assert.equal(rejected.calls.length, 0);
  }
  const cross = await request({ body: { action: 'admin-unbind', input: {} }, headers: { origin, 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.code, 403);
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
