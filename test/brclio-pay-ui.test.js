import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { consumePaymentCallback, paymentCheckoutUrl, paymentCatalog } from '../account-ui.js';
import { createBrowserAccountBridge } from '../lib/browser-account.js';
import { AccountClient } from '../desktop/account-client.js';

const orderId = '12345678-1234-1234-1234-123456789abc';
const catalog = () => ({ enabled: true, mode: 'live', currency: 'CNY', version: 1,
  plans: [{ id: 'monthly', name: '月付', days: 30, priceCents: 1990, amount: '19.90' }] });
const account = id => ({ user: { id, email: `${id}@example.test` }, membership: { type: 'none', active: false } });

test('payment returns consume only a valid business order reference and never interpret status or payment provider IDs', () => {
  let replacement;
  const reference = consumePaymentCallback({ href: `https://xhs.example/?payment_order=${orderId}&payment_order_id=center&product_order_id=forged&status=PAID&note=keep`, replace: value => { replacement = new URL(value); } });
  assert.equal(reference, orderId);
  for (const key of ['payment_order', 'payment_order_id', 'product_order_id']) assert.equal(replacement.searchParams.has(key), false);
  assert.equal(replacement.searchParams.get('status'), 'PAID');
  assert.equal(replacement.searchParams.get('note'), 'keep');
  assert.equal(consumePaymentCallback({ href: 'https://xhs.example/?payment_order=PAID', replace: () => {} }), null);
  assert.equal(consumePaymentCallback({ href: `https://xhs.example/vip.html?payment_order=${orderId}`, replace: () => assert.fail('unrelated page must be left alone') }), null);
});

test('checkout requires the exact HTTPS payment center and preserves its single-order token fragment', () => {
  assert.equal(paymentCheckoutUrl('https://pay.bornforthis.cn/checkout/order#token=fixture-order-token'), 'https://pay.bornforthis.cn/checkout/order#token=fixture-order-token');
  for (const url of ['javascript:alert(1)', 'http://pay.bornforthis.cn/checkout', 'https://pay.bornforthis.cn.attacker.test/checkout',
    'https://user:password@pay.bornforthis.cn/checkout', 'https://pay.bornforthis.cn:8443/checkout', 'https://pay.bornforthis.cn/checkout#fake',
    'https://pay.bornforthis.cn/checkout', 'https://pay.bornforthis.cn/checkout#token=a&token=b', 'https://pay.bornforthis.cn/checkout#token=']) {
    assert.throws(() => paymentCheckoutUrl(url));
  }
});

test('live online catalog rejects foreign currency, sandbox, unknown rights, duplicate SKUs and inconsistent price snapshots', () => {
  assert.deepEqual(paymentCatalog(catalog()), catalog());
  assert.equal(paymentCatalog({ ...catalog(), acceptingPayments: false }).acceptingPayments, false);
  assert.equal(paymentCatalog({ ...catalog(), acceptingPayments: true }).acceptingPayments, true);
  for (const patch of [{ currency: 'USD' }, { mode: 'sandbox' }, { version: null }, { plans: [{ ...catalog().plans[0], days: 31 }] },
    { acceptingPayments: 'false' }, { plans: [{ ...catalog().plans[0], amount: '19.91' }] }, { plans: [{ ...catalog().plans[0], id: 'permanent' }] }, { plans: [catalog().plans[0], catalog().plans[0]] }]) {
    assert.throws(() => paymentCatalog({ ...catalog(), ...patch }));
  }
  assert.equal(paymentCatalog({ ...catalog(), plans: [{ ...catalog().plans[0], priceCents: 6990, amount: '69.90' }] }).plans[0].priceCents, 6990);
});

test('desktop payment requests retain the existing signed-user proof and reject account changes', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const calls = [];
  const client = new AccountClient({ endpoint: 'https://accounts.example.test/api/account', store: { save: async () => {}, device: () => ({ name: 'fixture', platform: 'darwin' }) }, fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.action === 'payment-catalog') {
      assert.equal(body.proof, undefined); assert.equal(init.headers.Authorization, undefined);
    } else {
      const { timestamp, nonce, signature } = body.proof;
      assert.equal(verify(null, Buffer.from(`${body.action}\n${timestamp}\n${nonce}\n${JSON.stringify(body.input)}\ntoken-a`), publicKey, Buffer.from(signature, 'base64')), true);
      assert.equal(init.headers.Authorization, 'Bearer token-a');
    }
    return Response.json({ ok: true, catalog: catalog(), order: { id: orderId, status: 'pending' } });
  } });
  client.credentials = { privateKey, publicKey, token: 'token-a', pendingLogoutTokens: [], pendingRedemptions: {} }; client.account = account('a'); client.status = 'ready';
  for (const action of ['payment-catalog', 'payment-create', 'payment-status']) await client.commerceRequest(action, { expectedUserId: 'a', orderId });
  await assert.rejects(client.commerceRequest('payment-create', { expectedUserId: 'b' }), { code: 'SESSION_CHANGED' });
  assert.throws(() => client.commerceRequest('payment-admin'), { code: 'UNKNOWN_ACTION' });
  assert.equal(calls.length, 3);
});

test('browser payment requests use same-origin cookies, preserve uncertain identity and stop during pending logout', async () => {
  const calls = []; let offline = false;
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
    assert.equal(body.input.client, 'browser');
    if (offline) throw new Error('offline');
    return Response.json({ ok: true, account: account('a'), catalog: catalog() });
  } });
  await bridge.verifyAccountCode('a@example.test', '123456');
  for (const action of ['payment-catalog', 'payment-create', 'payment-status']) assert.equal((await bridge.commerceRequest(action, { expectedUserId: 'a', orderId })).ok, true);
  offline = true;
  const failed = await bridge.commerceRequest('payment-create', { expectedUserId: 'a', requestId: 'repeat-original-order' });
  assert.equal(failed.ok, false); assert.equal(failed.state.verified, true);
  await bridge.logoutAccount(); const count = calls.length;
  for (const action of ['payment-create', 'payment-status']) assert.equal((await bridge.commerceRequest(action, { expectedUserId: 'a' })).ok, false);
  assert.equal(calls.length, count);
  assert.equal((await bridge.commerceRequest('payment-admin')).ok, false);
});
