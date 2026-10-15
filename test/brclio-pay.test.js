import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubStateStore, emptyState } from '../server/auth/store.js';
import { SqliteStateStore } from '../server/auth/sqlite-store.js';
import { createAccountService } from '../server/auth/service.js';
import { readConfig } from '../server/auth/config.js';
import { digest } from '../server/auth/crypto.js';
import { createBrclioPayClient } from '../server/auth/brclio-pay-client.js';
import { AccountError } from '../server/auth/errors.js';

const DAY = 86_400_000;
const PAY_CONFIG = { baseUrl: 'https://pay.bornforthis.cn', clientId: 'xhs-downloader', apiSecret: 'test-only-api-secret-'.repeat(3), webhookSecret: 'test-only-webhook-secret-'.repeat(3), mode: 'live', returnOrigin: 'https://xhs.download.brclio.com' };

function fixture({ sqlite = false } = {}) {
  let state = emptyState(), revision = 1, clock = Date.parse('2026-10-15T01:00:00.000Z');
  const config = { ...readConfig({ AUTH_SECRET_PEPPER: 'test-only-account-pepper-'.repeat(3), AUTH_ADMIN_EMAILS: 'admin@example.test' }), brclioPay: PAY_CONFIG };
  const userId = randomUUID(), otherId = randomUUID(), adminId = randomUUID(), token = 'test-browser-token-'.repeat(3), otherToken = 'other-browser-token-'.repeat(3), adminToken = 'admin-session-token-'.repeat(3);
  for (const [id, email, loginToken, client] of [[userId, 'member@example.test', token, 'browser'], [otherId, 'other@example.test', otherToken, 'browser'], [adminId, 'admin@example.test', adminToken, 'admin']]) {
    state.users[id] = { id, email, createdAt: new Date(clock).toISOString(), membership: { type: 'none', startsAt: null, expiresAt: null } };
    state.sessions[digest(config.pepper, 'session', loginToken)] = { userId: id, client, revokedAt: null };
  }
  const faults = [], apiCalls = [], upstreamOrders = new Map();
  let price = '3.00', version = 'catalog-v1', enabled = true, acceptingPayments = true, skuEnabled = true, beforeCreate = null, throwCreate = false, responseOverrides = {}, remoteStatus = 'PENDING';
  const catalog = () => ({ clientId: 'xhs-downloader', mode: 'live', currency: 'CNY', enabled, acceptingPayments, version, skus: { daily: { subject: '日付', amount: price, enabled: skuEnabled }, monthly: { subject: '月付', amount: '19.90', entitlement: '30 天' }, unknown: { subject: '不可执行的未知套餐', amount: '1.00' } } });
  const upstream = {
    async catalog() { apiCalls.push('catalog'); return catalog(); },
    async createOrder(input) {
      apiCalls.push({ create: input });
      if (throwCreate) throw Error('simulated upstream failure');
      if (beforeCreate) await beforeCreate(input);
      if (!upstreamOrders.has(input.productOrderId)) upstreamOrders.set(input.productOrderId, { id: `pay_${randomUUID().replaceAll('-', '')}`, productOrderId: input.productOrderId, sku: input.sku, amount: input.sku === 'daily' ? price : '19.90', currency: 'CNY', mode: 'live', status: 'PENDING', checkoutUrl: 'https://pay.bornforthis.cn/checkout#token=test_checkout_token_0123456789' });
      return { ...upstreamOrders.get(input.productOrderId), ...responseOverrides };
    },
    async getOrder(id) { apiCalls.push({ status: id }); return { ...[...upstreamOrders.values()].find(order => order.id === id), status: remoteStatus, ...responseOverrides }; },
  };
  const fetchImpl = async (url, options) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (options.method === 'GET') return Response.json({ sha: String(revision), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    const body = JSON.parse(options.body);
    if (body.sha !== String(revision)) return Response.json({}, { status: 409 });
    const fault = faults.shift();
    if (fault === 'fail') return Response.json({}, { status: 503 });
    state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); revision++;
    if (fault === 'commit-lost') throw Error('response lost after commit');
    return Response.json({ content: { sha: String(revision) } });
  };
  const directory = sqlite ? mkdtempSync(join(tmpdir(), 'brclio-pay-test-')) : null;
  let sqliteStore = sqlite ? new SqliteStateStore({ path: join(directory, 'accounts.sqlite') }) : null;
  const githubStore = () => new GithubStateStore({ owner: 'fake-owner', repo: 'fake-private-data', token: 'test-only-data-token', fetchImpl, delay: async () => {} });
  const service = () => createAccountService({ config, store: sqliteStore || githubStore(), mailer: {}, now: () => clock, paymentClient: upstream });
  const call = (action, input = {}, currentToken = token, client = 'browser') => service().execute({ action, input, token: currentToken, client });
  const createInput = (overrides = {}) => ({ planId: 'daily', amount: price, catalogVersion: version, expectedUserId: userId, requestId: randomUUID(), ...overrides });
  const event = (order, overrides = {}, rawOverrides = {}) => {
    const data = { orderId: order.paymentOrderId, productOrderId: order.id, clientId: PAY_CONFIG.clientId, sku: order.planId, amount: String((order.priceCents / 100).toFixed(2)), currency: 'CNY', tradeNo: '2026101512345678901234', paidAt: new Date(clock).toISOString(), ...overrides };
    const payload = { id: `evt_${data.orderId}`, type: 'payment.paid', mode: 'live', createdAt: new Date(clock).toISOString(), data, ...rawOverrides };
    const rawBody = JSON.stringify(payload), timestamp = String(Math.floor(clock / 1000));
    return { rawBody, headers: new Headers({ 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Event': payload.id, 'X-Brclio-Signature': createHmac('sha256', PAY_CONFIG.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex') }) };
  };
  return {
    config, userId, otherId, token, otherToken, adminToken, faults, apiCalls, service, call, event, createInput,
    async initialize() { if (sqliteStore) await sqliteStore.transaction(target => { Object.assign(target, state); return { value: true }; }); },
    async read() { return (await (sqliteStore || githubStore()).read()).state; },
    async mutate(callback) { return (sqliteStore || githubStore()).transaction(target => { callback(target); return { value: true }; }); },
    restart() { sqliteStore.close(); sqliteStore = new SqliteStateStore({ path: join(directory, 'accounts.sqlite'), openExisting: true }); },
    dispose() { sqliteStore?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); },
    set price(value) { price = value; }, set version(value) { version = value; }, set enabled(value) { enabled = value; }, set acceptingPayments(value) { acceptingPayments = value; }, set skuEnabled(value) { skuEnabled = value; }, set beforeCreate(value) { beforeCreate = value; }, set throwCreate(value) { throwCreate = value; }, set responseOverrides(value) { responseOverrides = value; }, set remoteStatus(value) { remoteStatus = value; },
    get clock() { return clock; }, advance(ms) { clock += ms; },
  };
}

test('server client signs exact no-cache request bytes and never forwards upstream errors or credentials', async () => {
  const calls = [], client = createBrclioPayClient({ ...PAY_CONFIG, now: () => Date.parse('2026-10-15T01:00:00Z'), fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true }); } });
  await client.catalog();
  await client.createOrder({ productOrderId: 'product-order', sku: 'daily', returnUrl: 'https://xhs.download.brclio.com/?payment_order=product-order' });
  for (const { url, options } of calls) {
    const { headers } = options, raw = options.body || '';
    const expected = createHmac('sha256', PAY_CONFIG.apiSecret).update([options.method, url.pathname, headers['X-Brclio-Timestamp'], headers['X-Brclio-Nonce'], createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
    assert.equal(headers['X-Brclio-Signature'], expected);
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'manual'); assert.equal(url.search, '');
    assert.equal(headers.Authorization, undefined);
  }
  assert.equal(calls[0].options.body, undefined);
  const broken = createBrclioPayClient({ ...PAY_CONFIG, fetcher: async () => Response.json({ error: { message: 'private upstream credential' } }, { status: 500 }) });
  await assert.rejects(broken.catalog(), error => error.code === 'PAYMENT_UNAVAILABLE' && !error.message.includes('credential'));
  assert.throws(() => createBrclioPayClient({ ...PAY_CONFIG, baseUrl: 'https://other.test/unsafe?key=x' }), { code: 'PAYMENT_NOT_CONFIGURED' });
});

test('public catalog reads latest enabled fixed SKUs and actual local duration rules on every call', async () => {
  const f = fixture();
  let result = await f.call('payment-catalog', {}, '');
  assert.deepEqual(result.catalog.plans.map(item => item.id), ['daily', 'monthly']);
  assert.equal(result.catalog.plans[0].days, 1);
  assert.equal(result.catalog.plans[0].priceCents, 300);
  f.price = '4.50'; f.version = 'catalog-v2'; f.skuEnabled = false;
  result = await f.call('payment-catalog', {}, '');
  assert.equal(result.catalog.version, 'catalog-v2');
  assert.deepEqual(result.catalog.plans.map(item => item.id), ['monthly']);
  assert.equal(f.apiCalls.filter(call => call === 'catalog').length, 2);
  assert.ok(!JSON.stringify(result).includes(PAY_CONFIG.apiSecret));
});

test('upstream disabled code has a fixed public message while unexpected error bodies remain private', async () => {
  const sentinel = 'private-upstream-diagnostic-fixture';
  const disabled = createBrclioPayClient({ ...PAY_CONFIG, fetcher: async () => Response.json({ error: { code: 'PAYMENTS_DISABLED', message: sentinel }, secret: sentinel }, { status: 503 }) });
  await assert.rejects(disabled.createOrder({ productOrderId: 'fixture', sku: 'daily', returnUrl: PAY_CONFIG.returnOrigin }), error => {
    assert.equal(error.code, 'PAYMENT_SERVICE_DISABLED'); assert.equal(error.status, 503);
    assert.match(error.message, /尚未启用在线收款/); assert.doesNotMatch(error.message, /private-upstream/);
    return true;
  });
  for (const [status, body] of [[500, { error: { code: 'PAYMENTS_DISABLED', message: sentinel } }], [503, { error: { code: 'CONFIGURATION', message: sentinel } }], [401, { error: { code: 'UNAUTHORIZED', message: sentinel } }], [503, { message: sentinel }]]) {
    const client = createBrclioPayClient({ ...PAY_CONFIG, fetcher: async () => Response.json(body, { status }) });
    await assert.rejects(client.catalog(), error => error.code === 'PAYMENT_UNAVAILABLE' && !error.message.includes(sentinel));
  }
  for (const body of [sentinel, `${sentinel}${'x'.repeat(131_072)}`]) {
    const client = createBrclioPayClient({ ...PAY_CONFIG, fetcher: async () => new Response(body, { status: 503 }) });
    await assert.rejects(client.catalog(), error => error.code === 'PAYMENT_UNAVAILABLE' && !error.message.includes(sentinel));
  }
});

test('global payment pause keeps catalog prices visible and rejects new orders before any durable write', async () => {
  const f = fixture(), input = f.createInput();
  f.acceptingPayments = false;
  const { catalog } = await f.call('payment-catalog', {}, '');
  assert.equal(catalog.enabled, true); assert.equal(catalog.acceptingPayments, false);
  assert.equal(catalog.version, 'catalog-v1'); assert.equal(catalog.plans[0].amount, '3.00');
  await assert.rejects(f.call('payment-create', input), { code: 'PAYMENT_SERVICE_DISABLED', status: 503 });
  const state = await f.read();
  assert.equal(Object.keys(state.orders).length, 0); assert.equal(Object.keys(state.operations).length, 0);
  assert.equal(f.apiCalls.filter(call => call.create).length, 0);
  f.acceptingPayments = true;
  assert.ok((await f.call('payment-create', input)).checkoutUrl);
  f.acceptingPayments = 'false';
  await assert.rejects(f.call('payment-catalog', {}, ''), { code: 'PAYMENT_INVALID_CATALOG' });
  f.acceptingPayments = undefined;
  assert.equal(Object.hasOwn((await f.call('payment-catalog', {}, '')).catalog, 'acceptingPayments'), false, 'older center catalogs do not claim readiness without evidence');
  assert.ok((await f.call('payment-create', f.createInput())).checkoutUrl, 'older center catalogs retain compatible attempt behavior');
  f.enabled = false; f.acceptingPayments = true;
  assert.equal((await f.call('payment-catalog', {}, '')).catalog.acceptingPayments, false, 'product pause also prevents payments');
});

test('payment pause after local order persistence keeps original request retryable and existing delivery available', async () => {
  const f = fixture(), input = f.createInput();
  f.beforeCreate = async () => { throw new AccountError('PAYMENT_SERVICE_DISABLED', '支付中心尚未启用在线收款。', 503); };
  await assert.rejects(f.call('payment-create', input), { code: 'PAYMENT_SERVICE_DISABLED' });
  const originalId = Object.keys((await f.read()).orders)[0];
  f.beforeCreate = null;
  const created = await f.call('payment-create', input);
  assert.equal(created.order.id, originalId); assert.equal(Object.keys((await f.read()).orders).length, 1);
  f.acceptingPayments = false; f.enabled = false;
  assert.equal((await f.call('payment-status', { orderId: originalId, expectedUserId: f.userId })).paymentStatus, 'PENDING');
  await f.service().receivePayment(f.event(created.order));
  assert.equal((await f.read()).orders[originalId].status, 'confirmed');
  assert.equal((await f.call('payment-create', input)).order.status, 'confirmed');
});

test('authenticated create persists user/quote/rules first, exposes only center checkout, and webhook atomically grants once', async () => {
  const f = fixture(), input = f.createInput();
  f.beforeCreate = async params => { const state = await f.read(); assert.equal(state.orders[params.productOrderId].userId, f.userId); assert.deepEqual(state.orders[params.productOrderId].entitlementSnapshot, { type: 'duration', days: 1, features: ['profile-download', 'watermark-free-video'] }); };
  const created = await f.call('payment-create', input);
  assert.equal(new URL(created.checkoutUrl).origin, PAY_CONFIG.baseUrl);
  assert.match(f.apiCalls.find(call => call.create).create.returnUrl, /^https:\/\/xhs\.download\.brclio\.com\/\?payment_order=[a-f0-9-]{36}$/);
  const stored = (await f.read()).orders[created.order.id];
  assert.ok(!JSON.stringify(stored).includes('test_checkout_token'));
  const first = await f.service().receivePayment(f.event(created.order));
  const replay = await f.service().receivePayment(f.event(created.order));
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
  const state = await f.read();
  assert.equal(state.users[f.userId].membership.expiresAt, new Date(f.clock + DAY).toISOString());
  assert.equal(state.orders[created.order.id].status, 'confirmed');
  assert.equal(state.orders[created.order.id].amountCents, 300);
  assert.equal(Object.keys(state.paymentEvents).length, 1);
  assert.equal(state.audit.filter(item => item.action === 'brclio-payment-paid').length, 1);
  assert.equal((await f.call('payment-create', input)).checkoutUrl, undefined);
  assert.equal((await f.call('orders-mine', { expectedUserId: f.userId })).orders[0].source, 'brclio_pay');
});

test('unpaid return and authoritative paid lookup never grant membership without webhook', async () => {
  const f = fixture(), created = await f.call('payment-create', f.createInput());
  const statusInput = { orderId: created.order.id, expectedUserId: f.userId, payment_success: true, product_order_id: created.order.id };
  assert.equal((await f.call('payment-status', statusInput)).paymentStatus, 'PENDING');
  f.remoteStatus = 'PAID';
  const result = await f.call('payment-status', statusInput);
  assert.equal(result.paymentStatus, 'PAID'); assert.equal(result.order.status, 'pending');
  assert.equal((await f.read()).users[f.userId].membership.type, 'none');
});

test('creates enforce authentication, owner, permanent eligibility, fixed SKUs and enabled product', async () => {
  const f = fixture();
  await assert.rejects(f.call('payment-create', f.createInput(), ''), { code: 'ACCOUNT_REQUIRED' });
  await assert.rejects(f.call('payment-create', f.createInput({ expectedUserId: f.otherId })), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(f.call('payment-create', f.createInput({ planId: 'unknown' })), { code: 'INVALID_ORDER' });
  await assert.rejects(f.call('payment-create', f.createInput({ amount: '3' })), { code: 'INVALID_ORDER', status: 400 });
  f.enabled = false;
  await assert.rejects(f.call('payment-create', f.createInput()), { code: 'PAYMENT_PRODUCT_DISABLED' });
  f.enabled = true; f.skuEnabled = false;
  await assert.rejects(f.call('payment-create', f.createInput()), { code: 'PAYMENT_PRODUCT_DISABLED' });
  f.skuEnabled = true;
  await f.mutate(state => { state.users[f.userId].membership = { type: 'permanent', startsAt: new Date(f.clock).toISOString(), expiresAt: null }; });
  await assert.rejects(f.call('payment-create', f.createInput()), { code: 'ALREADY_PERMANENT' });
  assert.equal(f.apiCalls.filter(call => call.create).length, 0);
});

test('catalog-price change before create requires reconfirmation before any business/payment order', async () => {
  const f = fixture(), stale = f.createInput();
  f.price = '4.00'; f.version = 'catalog-v2';
  await assert.rejects(f.call('payment-create', stale), { code: 'QUOTE_CHANGED' });
  assert.equal(Object.keys((await f.read()).orders).length, 0);
  assert.equal(f.apiCalls.filter(call => call.create).length, 0);
  const fresh = await f.call('payment-create', f.createInput());
  assert.equal(fresh.order.priceCents, 400);
});

for (const overrides of [{ amount: '4.00' }, { sku: 'monthly', amount: '19.90' }]) test(`authoritative create quote race ${JSON.stringify(overrides)} blocks checkout and fulfillment`, async () => {
  const f = fixture(), input = f.createInput();
  f.responseOverrides = overrides;
  await assert.rejects(f.call('payment-create', input), { code: 'QUOTE_CHANGED' });
  const state = await f.read(), stored = Object.values(state.orders)[0];
  assert.equal(stored.payment.amount, overrides.amount);
  assert.equal(stored.priceCents, Number(overrides.amount.replace('.', '')));
  assert.equal(stored.payment.quoteAccepted, false);
  assert.equal(stored.payment.state, 'quote_changed');
  const view = { ...stored, paymentOrderId: stored.payment.orderId };
  await assert.rejects(f.service().receivePayment(f.event(view, { sku: stored.payment.sku })), error => ['PAYMENT_ORDER_NOT_READY', 'PAYMENT_ORDER_MISMATCH'].includes(error.code));
  await assert.rejects(f.call('payment-create', input), { code: 'QUOTE_CHANGED' });
  assert.equal(f.apiCalls.filter(call => call.create).length, 1);
  assert.equal((await f.read()).users[f.userId].membership.type, 'none');
  f.responseOverrides = {}; f.price = overrides.amount; f.version = 'catalog-v2';
  const fresh = await f.call('payment-create', f.createInput());
  assert.notEqual(fresh.order.id, stored.id);
});

test('old orders keep price and entitlement snapshots after remote catalog changes', async () => {
  const f = fixture(), created = await f.call('payment-create', f.createInput({ planId: 'monthly', amount: '19.90' }));
  // Simulate an older purchased rules snapshot; fulfillment must not recalculate
  // from today's getMembershipPlan monthly days or directory description.
  await f.mutate(state => { state.orders[created.order.id].entitlementSnapshot.days = 17; });
  f.price = '9.90'; f.version = 'catalog-v3'; f.enabled = false; f.skuEnabled = false;
  await f.service().receivePayment(f.event(created.order));
  const state = await f.read();
  assert.equal(state.orders[created.order.id].amountCents, 1990);
  assert.equal(state.users[f.userId].membership.expiresAt, new Date(f.clock + 17 * DAY).toISOString());
});

test('create idempotency survives uncertain upstream calls and storage commit responses without duplicate orders', async () => {
  const f = fixture(), input = f.createInput();
  f.throwCreate = true;
  await assert.rejects(f.call('payment-create', input));
  const id = Object.keys((await f.read()).orders)[0];
  f.throwCreate = false;
  const created = await f.call('payment-create', input);
  assert.equal(created.order.id, id);
  assert.equal(Object.keys((await f.read()).orders).length, 1);
  await assert.rejects(f.call('payment-create', { ...input, amount: '4.00' }), { code: 'REQUEST_ID_REUSED' });
  const another = fixture(), secondInput = another.createInput();
  another.faults.push('commit-lost');
  await assert.rejects(another.call('payment-create', secondInput), { code: 'STORAGE_WRITE_UNCERTAIN' });
  const retried = await another.call('payment-create', secondInput);
  assert.equal(Object.keys((await another.read()).orders).length, 1);
  assert.ok(retried.checkoutUrl);
});

test('lookup refuses another account and forged upstream order/product/environment/currency', async () => {
  const f = fixture(), created = await f.call('payment-create', f.createInput());
  await assert.rejects(f.call('payment-status', { orderId: created.order.id, expectedUserId: f.otherId }, f.otherToken), { code: 'ORDER_NOT_FOUND' });
  for (const overrides of [{ productOrderId: randomUUID() }, { clientId: 'other-product' }, { mode: 'sandbox' }, { amount: '99.99' }, { currency: 'USD' }, { sku: 'monthly' }]) {
    f.responseOverrides = overrides;
    await assert.rejects(f.call('payment-status', { orderId: created.order.id, expectedUserId: f.userId }), { code: 'PAYMENT_INVALID_ORDER' });
  }
  assert.equal((await f.read()).users[f.userId].membership.type, 'none');
});

test('webhook rejects invalid/raw-modified/stale signatures and signed wrong amount/product/mode/sku/order', async () => {
  const f = fixture(), created = await f.call('payment-create', f.createInput());
  const invalid = f.event(created.order); invalid.headers.set('X-Brclio-Signature', 'a'.repeat(64));
  await assert.rejects(f.service().receivePayment(invalid), { code: 'PAYMENT_INVALID_SIGNATURE' });
  const altered = f.event(created.order); altered.rawBody += ' ';
  await assert.rejects(f.service().receivePayment(altered), { code: 'PAYMENT_INVALID_SIGNATURE' });
  const stale = f.event(created.order); f.advance(301_000);
  await assert.rejects(f.service().receivePayment(stale), { code: 'PAYMENT_INVALID_SIGNATURE' });
  for (const [data, top, code] of [[{ amount: '4.00' }, {}, 'PAYMENT_ORDER_MISMATCH'], [{ clientId: 'other-product' }, {}, 'PAYMENT_INVALID_EVENT'], [{}, { mode: 'sandbox' }, 'PAYMENT_INVALID_EVENT'], [{ sku: 'monthly' }, {}, 'PAYMENT_ORDER_MISMATCH'], [{ productOrderId: randomUUID() }, {}, 'PAYMENT_ORDER_MISMATCH'], [{ currency: 'USD' }, {}, 'PAYMENT_INVALID_EVENT']]) await assert.rejects(f.service().receivePayment(f.event(created.order, data, top)), { code });
  assert.equal((await f.read()).users[f.userId].membership.type, 'none');
  assert.equal(Object.keys((await f.read()).paymentEvents).length, 0);
});

test('webhook storage failure retries and uncertain committed response fulfills only once', async () => {
  for (const fault of ['fail', 'commit-lost']) {
    const f = fixture(), created = await f.call('payment-create', f.createInput());
    f.faults.push(fault);
    await assert.rejects(f.service().receivePayment(f.event(created.order)), { code: fault === 'fail' ? 'STORAGE_UNAVAILABLE' : 'STORAGE_WRITE_UNCERTAIN' });
    const result = await f.service().receivePayment(f.event(created.order));
    assert.equal(result.replayed, fault === 'commit-lost');
    const state = await f.read();
    assert.equal(state.users[f.userId].membership.expiresAt, new Date(f.clock + DAY).toISOString());
    assert.equal(state.audit.filter(item => item.action === 'brclio-payment-paid').length, 1);
  }
});

test('concurrent durable webhook deliveries race safely and duration renewals extend existing time', async () => {
  const f = fixture(), created = await f.call('payment-create', f.createInput());
  await f.mutate(state => { state.users[f.userId].membership = { type: 'duration', startsAt: new Date(f.clock - DAY).toISOString(), expiresAt: new Date(f.clock + 3 * DAY).toISOString() }; });
  const results = await Promise.all([f.service().receivePayment(f.event(created.order)), f.service().receivePayment(f.event(created.order))]);
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
  assert.equal((await f.read()).users[f.userId].membership.expiresAt, new Date(f.clock + 4 * DAY).toISOString());
});

test('a permanent grant after purchase is preserved when pending payment later completes', async () => {
  const f = fixture(), created = await f.call('payment-create', f.createInput());
  const permanent = { type: 'permanent', startsAt: new Date(f.clock).toISOString(), expiresAt: null };
  await f.mutate(state => { state.users[f.userId].membership = permanent; });
  await f.service().receivePayment(f.event(created.order));
  const state = await f.read();
  assert.deepEqual(state.users[f.userId].membership, permanent);
  assert.equal(state.orders[created.order.id].status, 'confirmed');
});

test('Brclio orders remain in revenue ledger but cannot be manually confirmed or linked to activation codes', async () => {
  const f = fixture(), created = await f.call('payment-create', f.createInput());
  await assert.rejects(f.call('admin-record-order', { orderId: created.order.id, userId: f.userId, planId: 'daily', paymentMethod: 'alipay', amountCents: 300, paidAt: new Date(f.clock).toISOString(), transactionReference: 'manual-reference', reason: 'manual attempted', requestId: randomUUID() }, f.adminToken, 'admin'), { code: 'PAYMENT_AUTOMATED_ORDER' });
  await f.service().receivePayment(f.event(created.order));
  await assert.rejects(f.call('admin-link-order-code', { orderId: created.order.id, codeId: randomUUID(), reason: 'manual attempted', requestId: randomUUID() }, f.adminToken, 'admin'), { code: 'PAYMENT_AUTOMATED_ORDER' });
  const revenue = await f.call('admin-revenue', {}, f.adminToken, 'admin');
  assert.equal(revenue.revenue.totalCents, 300);
  assert.deepEqual(revenue.revenue.byPaymentMethod.map(item => item.paymentMethod), ['brclio_pay']);
});

test('payment event and membership dedupe survive real SQLite close/reopen', async () => {
  const f = fixture({ sqlite: true });
  try {
    await f.initialize();
    const created = await f.call('payment-create', f.createInput());
    await f.service().receivePayment(f.event(created.order));
    f.restart();
    assert.equal((await f.service().receivePayment(f.event(created.order))).replayed, true);
    const state = await f.read();
    assert.equal(state.users[f.userId].membership.expiresAt, new Date(f.clock + DAY).toISOString());
    assert.equal(Object.keys(state.paymentEvents).length, 1);
  } finally { f.dispose(); }
});
