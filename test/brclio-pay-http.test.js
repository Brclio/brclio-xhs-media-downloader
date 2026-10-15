import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { createBrclioPaymentHandler, config as webhookConfig } from '../api/brclio-payment.js';
import { createAccountHandler, ADMIN_COOKIE, BROWSER_COOKIE } from '../api/account.js';
import { verifyBrclioPayEvent } from '../server/auth/brclio-pay-client.js';
import { AccountError } from '../server/auth/errors.js';

const origin = 'https://account.example.test';
const webhookSecret = 'isolated-webhook-http-fixture-'.repeat(2);
const clock = Date.parse('2026-10-15T02:00:00Z');
const paymentId = `pay_${'a'.repeat(32)}`;
const event = {
  id: `evt_${paymentId}`, type: 'payment.paid', mode: 'live', createdAt: new Date(clock).toISOString(),
  data: { orderId: paymentId, productOrderId: 'business-order-fixture', clientId: 'xhs-downloader', sku: 'monthly', amount: '19.90', currency: 'CNY', tradeNo: '20261015000000000001', paidAt: new Date(clock).toISOString() },
};
function signedHeaders(rawBody) {
  const timestamp = String(clock / 1000);
  return { 'x-brclio-timestamp': timestamp, 'x-brclio-event': event.id, 'x-brclio-signature': createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex') };
}
function response() {
  return { code: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
async function webhook({ method = 'POST', body = JSON.stringify(event), headers = {}, url = '/api/brclio-payment', chunks, receivePayment = async () => ({ received: true }) } = {}) {
  const req = chunks ? Readable.from(chunks) : {};
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', ...headers }, ...(chunks ? {} : { body }) });
  const res = response(), calls = [];
  await createBrclioPaymentHandler({ service: { receivePayment: async input => { calls.push(input); return receivePayment(input); } }, now: () => clock })(req, res);
  return { ...res, calls };
}
async function account({ action = 'payment-catalog', input = {}, proof, headers = {} } = {}) {
  const res = response(), calls = [];
  await createAccountHandler({ config: { siteOrigin: origin }, service: { execute: async value => { calls.push(value); return { catalog: {} }; } } })(
    { method: 'POST', body: { action, input, ...(proof ? { proof } : {}) }, headers: { 'content-type': 'application/json', ...headers } }, res);
  return { ...res, calls };
}

test('webhook transport preserves the signed JSON bytes across split UTF-8 chunks without browser authentication', async () => {
  assert.deepEqual(webhookConfig, { api: { bodyParser: false } });
  const raw = `  ${JSON.stringify({ ...event, note: '中文原始空白' }, null, 2)}\n`;
  const bytes = Buffer.from(raw), split = bytes.indexOf(Buffer.from('中文')) + 1;
  const result = await webhook({ chunks: [bytes.subarray(0, split), bytes.subarray(split)], headers: { ...signedHeaders(raw), origin: 'https://unrelated.example.test', cookie: `${BROWSER_COOKIE}=irrelevant`, authorization: 'Bearer irrelevant', 'content-type': 'application/json; charset=utf-8' },
    receivePayment: input => verifyBrclioPayEvent({ ...input, webhookSecret, clientId: 'xhs-downloader', mode: 'live', now: clock }) });
  assert.equal(result.code, 200); assert.deepEqual(result.body, { ok: true });
  assert.equal(result.calls[0].rawBody, raw);
  assert.ok(result.calls[0].headers instanceof Headers);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  const reconstructed = await webhook({ body: JSON.stringify(JSON.parse(raw)), headers: signedHeaders(raw), receivePayment: input => verifyBrclioPayEvent({ ...input, webhookSecret, clientId: 'xhs-downloader', mode: 'live', now: clock }) });
  assert.equal(reconstructed.code, 401); assert.equal(reconstructed.body.error.code, 'PAYMENT_INVALID_SIGNATURE');
});

test('webhook rejects non-raw, oversized, query and non-JSON inputs before invoking payment processing', async () => {
  const cases = [
    [{ method: 'GET' }, 405, 'METHOD_NOT_ALLOWED'],
    [{ headers: { 'content-type': 'text/plain' } }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ url: '/api/brclio-payment?success=true' }, 400, 'INVALID_REQUEST'],
    [{ body: event }, 400, 'INVALID_WEBHOOK_BODY'],
    [{ headers: { 'content-length': '16385' } }, 413, 'REQUEST_TOO_LARGE'],
    [{ body: Buffer.alloc(16385, 'a') }, 413, 'REQUEST_TOO_LARGE'],
    [{ chunks: [Buffer.alloc(8192, 'a'), Buffer.alloc(8193, 'b')] }, 413, 'REQUEST_TOO_LARGE'],
  ];
  for (const [options, status, code] of cases) {
    const result = await webhook(options);
    assert.equal(result.code, status); assert.equal(result.body.error.code, code);
    assert.equal(result.calls.length, 0, code);
  }
  assert.equal((await webhook({ method: 'GET' })).headers.allow, 'POST');
});

test('webhook leaves retryable processing failures non-2xx and hides unexpected diagnostic details', async () => {
  const raw = JSON.stringify(event), headers = signedHeaders(raw);
  const invalid = await webhook({ body: raw, headers: { ...headers, 'x-brclio-signature': '0'.repeat(64) }, receivePayment: input => verifyBrclioPayEvent({ ...input, webhookSecret, clientId: 'xhs-downloader', now: clock }) });
  assert.equal(invalid.code, 401);
  let attempts = 0;
  const receivePayment = async input => {
    verifyBrclioPayEvent({ ...input, webhookSecret, clientId: 'xhs-downloader', now: clock });
    if (++attempts === 1) throw new AccountError('STORAGE_UNAVAILABLE', '请重试。', 503);
  };
  const first = await webhook({ body: raw, headers, receivePayment });
  assert.equal(first.code, 503); assert.equal(first.body.ok, false);
  assert.equal((await webhook({ body: Buffer.from(raw), headers, receivePayment })).code, 200);
  const unexpected = await webhook({ receivePayment: async () => { throw Error('private-payment-secret-sentinel'); } });
  assert.equal(unexpected.code, 503); assert.equal(unexpected.body.error.code, 'PAYMENT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unexpected.body), /private-payment-secret-sentinel/);
});

test('payment actions preserve browser cookie origin checks and desktop bearer proofs', async () => {
  const browserToken = 'b'.repeat(43), adminToken = 'a'.repeat(43), desktopToken = 'd'.repeat(43);
  const cookie = `${ADMIN_COOKIE}=${adminToken}; ${BROWSER_COOKIE}=${browserToken}`;
  for (const action of ['payment-catalog', 'payment-create', 'payment-status']) {
    const accepted = await account({ action, headers: { origin, cookie } });
    assert.equal(accepted.code, 200); assert.equal(accepted.calls[0].client, 'browser'); assert.equal(accepted.calls[0].token, browserToken);
    for (const headers of [{ cookie }, { cookie, origin: `${origin}.evil.test` }, { cookie, origin, 'sec-fetch-site': 'cross-site' }]) {
      const denied = await account({ action, headers });
      assert.equal(denied.code, 403, action); assert.equal(denied.calls.length, 0);
    }
    const noAdminFallback = await account({ action, input: { client: 'browser' }, headers: { origin, cookie: `${ADMIN_COOKIE}=${adminToken}` } });
    assert.equal(noAdminFallback.calls[0].client, 'browser'); assert.equal(noAdminFallback.calls[0].token, '');
    const proof = { timestamp: clock, nonce: 'desktop-proof-fixture', signature: 'test-signature' };
    const desktop = await account({ action, input: { expectedUserId: 'desktop-user' }, proof, headers: { authorization: `Bearer ${desktopToken}` } });
    assert.equal(desktop.code, 200); assert.equal(desktop.calls[0].client, 'desktop'); assert.equal(desktop.calls[0].token, desktopToken); assert.deepEqual(desktop.calls[0].proof, proof);
    const mixed = await account({ action, headers: { origin, cookie, authorization: `Bearer ${desktopToken}` } });
    assert.equal(mixed.body.error.code, 'AMBIGUOUS_CREDENTIALS'); assert.equal(mixed.calls.length, 0);
  }
  const publicCatalog = await account();
  assert.equal(publicCatalog.code, 200); assert.equal(publicCatalog.calls[0].token, '');
});
