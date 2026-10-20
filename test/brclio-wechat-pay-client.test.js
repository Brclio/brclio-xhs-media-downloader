import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBrclioWechatPayClient, verifyBrclioWechatPayEvent } from '../server/auth/brclio-wechat-pay-client.js';

const clientId = 'p-2bb6d77a673327a2f8d881bac2d4fe26';
const apiKey = 'isolated-wechat-api-fixture-'.repeat(2);
const webhookSecret = 'isolated-wechat-webhook-fixture-'.repeat(2);
const clock = Date.parse('2026-10-20T15:00:00Z');
const baseUrl = 'https://paywc.bornforthis.cn';
const sign = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest('hex');
const orderInput = { merchantOrderId: 'wechat-business-order-fixture', sku: 'monthly', quantity: 1, channel: 'native', expectedTotal: 1990, returnUrl: 'https://xhs.download.brclio.com/membership.html?payment=wechat' };
const event = { eventId: 'payment.success.center-order-fixture', type: 'payment.success', orderId: 'center-order-fixture', clientId, merchantOrderId: orderInput.merchantOrderId, sku: 'monthly', quantity: 1, total: 1990, currency: 'CNY', transactionId: 'wechat-transaction-fixture', paidAt: new Date(clock).toISOString() };
const config = extra => ({ baseUrl, clientId, apiKey, now: () => clock, ...extra });
const response = (data = {}, init) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' }, ...init });

function signedHeaders(rawBody, extra = {}) {
  const timestamp = String(clock / 1000), nonce = 'ab'.repeat(16);
  return { 'x-brclio-timestamp': timestamp, 'x-brclio-nonce': nonce, 'x-brclio-event': event.eventId, 'x-brclio-signature': sign(webhookSecret, `${timestamp}\n${nonce}\n${rawBody}\n`), ...extra };
}
function verify(rawBody = JSON.stringify(event), headers = signedHeaders(rawBody), extra = {}) {
  return verifyBrclioWechatPayEvent({ rawBody, headers, webhookSecret, clientId, now: clock, ...extra });
}

test('native orders sign exactly the transmitted raw JSON, LF terminator and 16-byte nonce', async () => {
  const calls = [], expected = { id: event.orderId, status: 'PENDING', amount: { total: 1990, currency: 'CNY' }, payment: { channel: 'native', codeUrl: 'weixin://fixture' } };
  const client = createBrclioWechatPayClient(config({ fetcher: async (url, options) => { calls.push({ url, options }); return response(expected); } }));
  assert.deepEqual(await client.createOrder(orderInput), expected);
  const { url, options } = calls[0], headers = options.headers;
  assert.equal(String(url), `${baseUrl}/api/v1/orders`);
  assert.equal(options.method, 'POST'); assert.equal(options.body, JSON.stringify(orderInput));
  assert.equal(headers['X-Brclio-Client'], clientId); assert.equal(headers['X-Brclio-Timestamp'], String(clock / 1000));
  assert.match(headers['X-Brclio-Nonce'], /^[a-f0-9]{32}$/);
  assert.equal(headers['X-Brclio-Signature'], sign(apiKey, `POST\n/api/v1/orders\n${clock / 1000}\n${headers['X-Brclio-Nonce']}\n${options.body}\n`));
  assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
  assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
  assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined);
  assert.deepEqual(Object.keys(client).sort(), ['createOrder', 'getOrder', 'refreshOrder']);
  assert.doesNotMatch(JSON.stringify({ url: String(url), ...options }), new RegExp(apiKey));
});

test('reads and refreshes use opaque encoded IDs, fresh nonces, empty GET body and exact refresh JSON', async () => {
  const calls = [];
  const client = createBrclioWechatPayClient(config({ fetcher: async (url, options) => { calls.push({ url, options }); return response({ order: { id: 'opaque/center?value' } }); } }));
  assert.deepEqual(await client.getOrder('opaque/center?value'), { order: { id: 'opaque/center?value' } });
  await client.refreshOrder('opaque/center?value');
  assert.equal(calls[0].url.pathname, '/api/v1/orders/opaque%2Fcenter%3Fvalue');
  assert.equal(calls[0].url.search, ''); assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].url.pathname, '/api/v1/orders/opaque%2Fcenter%3Fvalue/refresh');
  assert.equal(calls[1].options.body, '{}');
  assert.notEqual(calls[0].options.headers['X-Brclio-Nonce'], calls[1].options.headers['X-Brclio-Nonce']);
  for (const { url, options } of calls) {
    const h = options.headers;
    assert.equal(h['X-Brclio-Signature'], sign(apiKey, `${options.method}\n${url.pathname}${url.search}\n${h['X-Brclio-Timestamp']}\n${h['X-Brclio-Nonce']}\n${options.body || ''}\n`));
  }
});

test('configuration and payment input reject invalid or cross-product values before network access', async () => {
  for (const invalid of [{ baseUrl: 'http://paywc.bornforthis.cn' }, { baseUrl: `${baseUrl}/` }, { baseUrl: `${baseUrl}/path` }, { baseUrl: `${baseUrl}?key=fixture` }, { baseUrl: 'https://user:password@paywc.bornforthis.cn' }, { clientId: 'another-product' }, { apiKey: 'short' }]) {
    assert.throws(() => createBrclioWechatPayClient(config(invalid)), { code: 'PAYMENT_NOT_CONFIGURED', status: 503 });
  }
  let requests = 0;
  const client = createBrclioWechatPayClient(config({ fetcher: async () => { requests++; return response(); } }));
  for (const input of [undefined, null, []]) assert.throws(() => client.createOrder(input), { code: 'PAYMENT_INVALID_ORDER' });
  for (const patch of [{ expectedTotal: '1990' }, { expectedTotal: 19.9 }, { expectedTotal: 0 }, { expectedTotal: Number.MAX_SAFE_INTEGER + 1 }, { quantity: 2 }, { channel: 'h5' }, { sku: '' }, { merchantOrderId: 'bad\norder' }, { returnUrl: 'http://example.test' }, { returnUrl: 'https://user:password@example.test' }]) {
    assert.throws(() => client.createOrder({ ...orderInput, ...patch }), { code: 'PAYMENT_INVALID_ORDER' });
  }
  for (const id of ['', '.', '..', 'a'.repeat(257), 'bad\norder']) {
    assert.throws(() => client.getOrder(id), { code: 'PAYMENT_INVALID_ORDER' });
    assert.throws(() => client.refreshOrder(id), { code: 'PAYMENT_INVALID_ORDER' });
  }
  assert.equal(requests, 0);
});

test('center failures and redirects expose only fixed messages and observed price-change code', async () => {
  for (const [status, body, code, expectedStatus] of [
    [409, { error: { code: 'CATALOG_PRICE_CHANGED', message: 'upstream-secret-sentinel' } }, 'QUOTE_CHANGED', 409],
    [403, { error: { code: 'UNEXPECTED_AUTH_FAILURE', message: 'upstream-secret-sentinel' } }, 'PAYMENT_UNAVAILABLE', 503],
    [503, { error: { code: 'arbitrary', apiKey: 'upstream-secret-sentinel' } }, 'PAYMENT_UNAVAILABLE', 503],
  ]) {
    const client = createBrclioWechatPayClient(config({ fetcher: async () => response(body, { status }) }));
    await assert.rejects(client.createOrder(orderInput), error => {
      assert.equal(error.code, code); assert.equal(error.status, expectedStatus);
      assert.doesNotMatch(error.message, /upstream-secret-sentinel/); return true;
    });
  }
  let requests = 0;
  const redirecting = createBrclioWechatPayClient(config({ fetcher: async () => { requests++; return new Response('upstream-secret-sentinel', { status: 307, headers: { location: 'https://unrelated.example.test' } }); } }));
  await assert.rejects(redirecting.getOrder(event.orderId), { code: 'PAYMENT_UNAVAILABLE' });
  assert.equal(requests, 1);
  const failing = createBrclioWechatPayClient(config({ fetcher: async () => { throw Error('upstream-secret-sentinel'); } }));
  await assert.rejects(failing.getOrder(event.orderId), error => error.code === 'PAYMENT_UNAVAILABLE' && !error.message.includes('upstream-secret-sentinel'));
});

test('response parsing rejects non-object, malformed, invalid UTF-8 and bounded overlong bodies', async () => {
  for (const makeResponse of [
    () => response(null), () => response([]), () => new Response('<html>upstream-secret-sentinel</html>'),
    () => new Response(new Uint8Array([0xff])), () => new Response('x', { headers: { 'content-length': '131073' } }),
    () => new Response('x'.repeat(131073)),
  ]) {
    const client = createBrclioWechatPayClient(config({ fetcher: async () => makeResponse() }));
    await assert.rejects(client.getOrder(event.orderId), { code: 'PAYMENT_UNAVAILABLE', status: 503 });
  }
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(131073)); }, cancel() { cancelled = true; } });
  const client = createBrclioWechatPayClient(config({ fetcher: async () => new Response(stream) }));
  await assert.rejects(client.getOrder(event.orderId), { code: 'PAYMENT_UNAVAILABLE' });
  assert.equal(cancelled, true);
});

test('webhook verifies original UTF-8 bytes and LF-separated nonce protocol before parsing', () => {
  const raw = `  ${JSON.stringify({ ...event, note: '中文原始空白' }, null, 2)}\n`, headers = signedHeaders(raw);
  assert.deepEqual(verify(raw, new Headers(headers)), { ...event, note: '中文原始空白' });
  assert.deepEqual(verify(raw, Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toUpperCase(), value]))), { ...event, note: '中文原始空白' });
  assert.throws(() => verify(JSON.stringify(JSON.parse(raw)), headers), { code: 'PAYMENT_INVALID_SIGNATURE', status: 401 });
  assert.throws(() => verify(raw, { ...headers, 'x-brclio-signature': sign(webhookSecret, `${headers['x-brclio-timestamp']}.${raw}`) }), { code: 'PAYMENT_INVALID_SIGNATURE' });
  // Retry delivery is authenticated again; eventId deduplication belongs to durable fulfillment.
  assert.deepEqual(verify(raw, headers), verify(raw, headers));
});

test('webhook rejects stale/future replay windows, nonce or signature tampering and malformed headers', () => {
  const raw = JSON.stringify(event), headers = signedHeaders(raw);
  assert.deepEqual(verify(raw, headers, { now: clock + 299_000 }), event);
  for (const now of [clock + 300_000, clock - 300_000, Number.NaN]) assert.throws(() => verify(raw, headers, { now }), { code: 'PAYMENT_INVALID_SIGNATURE' });
  for (const patch of [
    { 'x-brclio-timestamp': `${clock / 1000}, ${clock / 1000}` },
    { 'x-brclio-timestamp': '0' }, { 'x-brclio-nonce': 'cd'.repeat(16) }, { 'x-brclio-nonce': 'ab'.repeat(15) },
    { 'x-brclio-nonce': '' }, { 'x-brclio-signature': '0'.repeat(64) }, { 'x-brclio-signature': 'x'.repeat(64) },
    { 'x-brclio-signature': [headers['x-brclio-signature']] },
  ]) assert.throws(() => verify(raw, { ...headers, ...patch }), { code: 'PAYMENT_INVALID_SIGNATURE', status: 401 });
  assert.throws(() => verify(raw, headers, { webhookSecret: 'short' }), { code: 'PAYMENT_NOT_CONFIGURED' });
  assert.throws(() => verify('a'.repeat(16385)), { code: 'PAYMENT_INVALID_EVENT' });
  assert.throws(() => verify(event), { code: 'PAYMENT_INVALID_EVENT' });
});

test('signed webhook payload still enforces exact product, event, quantity, integer CNY amount and transaction', () => {
  for (const patch of [
    { clientId: 'another-product' }, { eventId: 'payment.success.other' }, { orderId: 'different-order' },
    { type: 'payment.paid' }, { quantity: 2 }, { quantity: '1' }, { total: '1990' }, { total: 19.9 },
    { total: 0 }, { total: -1 }, { total: Number.MAX_SAFE_INTEGER + 1 }, { currency: 'USD' },
    { merchantOrderId: '' }, { sku: '' }, { transactionId: '' }, { transactionId: 'bad\ntransaction' },
    { paidAt: 'invalid-date' }, { paidAt: new Date(clock + 300_001).toISOString() },
  ]) {
    const raw = JSON.stringify({ ...event, ...patch });
    assert.throws(() => verify(raw), { code: 'PAYMENT_INVALID_EVENT', status: 401 });
  }
  const raw = JSON.stringify(event);
  assert.throws(() => verify(raw, signedHeaders(raw, { 'x-brclio-event': 'payment.success.other' })), { code: 'PAYMENT_INVALID_EVENT' });
  for (const rawBody of ['{invalid-json', 'null', '[]']) assert.throws(() => verify(rawBody), { code: 'PAYMENT_INVALID_EVENT' });
});
