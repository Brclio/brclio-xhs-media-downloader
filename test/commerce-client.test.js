import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AccountClient } from '../desktop/account-client.js';
import { createBrowserAccountBridge } from '../lib/browser-account.js';

const account = id => ({ user: { id, email: `${id}@example.test` }, membership: { type: 'none' }, serverTime: new Date().toISOString() });
function desktop(fetchImpl) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const client = new AccountClient({ endpoint: 'https://accounts.example.test/api/account', fetchImpl, store: { save: async () => {} } });
  client.credentials = { privateKey, publicKey, token: 'token-a' }; client.account = account('a'); client.status = 'ready';
  return { client, publicKey };
}
test('desktop reviews can be read anonymously without storage or sending a bearer; private orders and evaluation use a signed proof', async () => {
  const calls = [];
  const { client, publicKey } = desktop(async (_, init) => {
    const body = JSON.parse(init.body); calls.push({ body, headers: init.headers });
    if (body.action !== 'reviews-public') {
      const { timestamp, nonce, signature } = body.proof;
      assert.equal(verify(null, Buffer.from(`${body.action}\n${timestamp}\n${nonce}\n${JSON.stringify(body.input)}\ntoken-a`), publicKey, Buffer.from(signature, 'base64')), true);
    }
    return Response.json({ ok: true, orders: [], reviews: [] });
  });
  const saved = client.credentials; client.credentials = null;
  await client.commerceRequest('reviews-public', { page: 1 });
  assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[0].body.proof, undefined);
  client.credentials = saved;
  await client.commerceRequest('orders-mine', { expectedUserId: 'a' });
  await client.commerceRequest('review-submit', { rating: 5, content: '很实用的软件', expectedUserId: 'a', requestId: 'fixture-request' });
  assert.equal(calls[1].headers.Authorization, 'Bearer token-a');
  assert.throws(() => client.commerceRequest('admin-revenue'), { code: 'UNKNOWN_ACTION' });
  await assert.rejects(client.commerceRequest('orders-mine', { expectedUserId: 'b' }), { code: 'SESSION_CHANGED' });
  assert.equal(calls.length, 3);
});
test('desktop discards delayed private order data after the software account changes', async () => {
  let resolve;
  const { client } = desktop(() => new Promise(done => { resolve = done; }));
  const pending = client.commerceRequest('orders-mine', { expectedUserId: 'a' });
  client.credentials = { ...client.credentials, token: 'token-b' }; client.account = account('b');
  resolve(Response.json({ ok: true, orders: [{ id: 'private-a' }] }));
  await assert.rejects(pending, { code: 'SESSION_CHANGED' });
  assert.equal(client.account.user.id, 'b');
});
test('browser commerce sends same-origin cookies, selects browser authentication, and closes private reads during pending logout', async () => {
  const calls = [];
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(init.credentials, 'same-origin'); assert.equal(body.input.client, 'browser');
    if (body.action === 'logout') throw new Error('offline');
    return Response.json({ ok: true, account: account('a'), orders: [] });
  } });
  await bridge.verifyAccountCode('a@example.test', '123456');
  assert.equal((await bridge.commerceRequest('orders-mine', { expectedUserId: 'a' })).ok, true);
  await bridge.logoutAccount();
  const count = calls.length;
  assert.equal((await bridge.commerceRequest('orders-mine', { expectedUserId: 'a' })).ok, false);
  assert.equal(calls.length, count);
  assert.equal((await bridge.commerceRequest('reviews-public')).ok, true);
  assert.equal((await bridge.commerceRequest('admin-orders')).ok, false);
});
test('an uncertain commerce network failure retains the verified browser identity and the authored request', async () => {
  let offline = false;
  const calls = [];
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_, init) => {
    calls.push(JSON.parse(init.body));
    if (offline) throw new Error('response lost');
    return Response.json({ ok: true, account: account('a') });
  } });
  await bridge.verifyAccountCode('a@example.test', '123456');
  const draft = { expectedUserId: 'a', rating: 5, content: '很好用的下载工具', requestId: 'same-authored-request' };
  offline = true;
  const failed = await bridge.commerceRequest('review-submit', draft);
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(failed.state.verified, true); assert.equal(failed.state.account.user.id, 'a');
  offline = false;
  await bridge.commerceRequest('review-submit', draft);
  assert.deepEqual(calls[1], calls[2]);
});
