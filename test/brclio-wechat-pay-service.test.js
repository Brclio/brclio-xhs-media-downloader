import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { GithubStateStore, emptyState } from '../server/auth/store.js';
import { createBrclioWechatPayService, validateBrclioWechatPayState } from '../server/auth/brclio-wechat-pay.js';
import { createBrclioPayService } from '../server/auth/brclio-pay.js';
import { fail } from '../server/auth/errors.js';

const DAY = 86_400_000;
const CONFIG = { baseUrl: 'https://paywc.bornforthis.cn', clientId: 'p-2bb6d77a673327a2f8d881bac2d4fe26', apiKey: 'test-only-wechat-api-key-'.repeat(3), webhookSecret: 'test-only-wechat-webhook-secret-'.repeat(3), returnOrigin: 'https://xhs.download.brclio.com' };
const digest = (scope, value) => createHash('sha256').update(`${scope}:${value}`).digest('hex');

function fixture() {
  let state = emptyState(), revision = 1, clock = Date.parse('2026-10-20T14:00:00Z');
  const userId = randomUUID(), otherId = randomUUID(), faults = [], apiCalls = [], remote = new Map();
  for (const id of [userId, otherId]) state.users[id] = { id, membership: { type: 'none', startsAt: null, expiresAt: null } };
  let createError = false, createOverrides = {}, queryOverrides = {}, minimalCreate = false, beforeCreate = null, beforeRefresh = null;
  const fetchImpl = async (url, options) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (options.method === 'GET') return Response.json({ sha: String(revision), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    const body = JSON.parse(options.body);
    if (body.sha !== String(revision)) return Response.json({}, { status: 409 });
    const fault = faults.shift();
    if (fault === 'fail') return Response.json({}, { status: 503 });
    state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); revision++;
    if (fault === 'commit-lost') throw Error('fixture commit confirmation lost');
    return Response.json({ content: { sha: String(revision) } });
  };
  const store = () => new GithubStateStore({ owner: 'fixture-owner', repo: 'fixture-private-data', token: 'fixture-data-token', fetchImpl, delay: async () => {} });
  const authenticate = (current, request) => {
    if (!request.token) fail('ACCOUNT_REQUIRED', '请先登录软件账号。', 401);
    const user = current.users[request.token];
    if (!user) fail('ACCOUNT_REQUIRED', '请先登录软件账号。', 401);
    return { user, session: { client: request.client || 'browser' } };
  };
  const upstream = {
    async createOrder(input) {
      apiCalls.push({ create: structuredClone(input) });
      if (beforeCreate) await beforeCreate(input);
      if (createError) throw Error('fixture upstream timeout');
      if (!remote.has(input.merchantOrderId)) {
        const id = randomUUID().replaceAll('-', '');
        remote.set(input.merchantOrderId, { id, clientId: CONFIG.clientId, merchantOrderId: input.merchantOrderId, sku: input.sku, quantity: input.quantity, amount: { total: input.expectedTotal, currency: 'CNY' }, status: 'PENDING', expiresAt: new Date(clock + 600_000).toISOString(), payment: { channel: 'native', codeUrl: `weixin://wxpay/bizpayurl?pr=isolated_${id}` }, checkoutUrl: `${CONFIG.baseUrl}/checkout/${id}#token=fixture-not-a-real-checkout-token` });
      }
      const result = { ...structuredClone(remote.get(input.merchantOrderId)), ...createOverrides };
      return minimalCreate ? { id: result.id, status: result.status, checkoutUrl: result.checkoutUrl, payment: result.payment } : result;
    },
    async getOrder(id) { apiCalls.push({ get: id }); return { ...structuredClone([...remote.values()].find(p => p.id === id)), ...queryOverrides }; },
    async refreshOrder(id) { apiCalls.push({ refresh: id }); const result = { ...structuredClone([...remote.values()].find(p => p.id === id)), ...queryOverrides }; if (beforeRefresh) await beforeRefresh(id); return result; },
  };
  const service = () => createBrclioWechatPayService({ store: store(), now: () => clock, authenticate, hash: digest, config: CONFIG, paymentClient: upstream });
  const call = (action, input = {}, token = userId, client = 'browser') => service().execute({ action, input, token, client });
  const legacyCall = requestId => createBrclioPayService({ store: store(), now: () => clock, authenticate, hash: digest,
    config: { baseUrl: 'https://pay.bornforthis.cn', clientId: 'xhs-downloader', mode: 'live', returnOrigin: CONFIG.returnOrigin },
    paymentClient: {
      catalog: async () => ({ clientId: 'xhs-downloader', mode: 'live', currency: 'CNY', enabled: true, version: 'legacy-v1', skus: { daily: { subject: '日付', amount: '3.00' } } }),
      createOrder: async input => ({ id: `pay_${randomUUID().replaceAll('-', '')}`, productOrderId: input.productOrderId, sku: input.sku, amount: '3.00', currency: 'CNY', mode: 'live', status: 'PENDING', checkoutUrl: 'https://pay.bornforthis.cn/checkout#token=fixture_legacy_checkout_token' }),
    },
  }).execute({ action: 'payment-create', token: userId, client: 'browser', input: { requestId, expectedUserId: userId, planId: 'daily', amount: '3.00', catalogVersion: 'legacy-v1' } });
  const createInput = async (overrides = {}) => ({ requestId: randomUUID(), expectedUserId: userId, planId: 'daily', amount: '3.00', catalogVersion: (await call('payment-catalog')).catalog.version, ...overrides });
  const paid = (order, overrides = {}) => { Object.assign(remote.get(order.id), { status: 'SUCCESS', transactionId: `wx_${randomUUID().replaceAll('-', '')}`, paidAt: new Date(clock).toISOString(), ...overrides }); return remote.get(order.id); };
  const event = (order, overrides = {}) => {
    const center = remote.get(order.id);
    const payload = { eventId: `payment.success.${center.id}`, type: 'payment.success', orderId: center.id, clientId: CONFIG.clientId, merchantOrderId: order.id, sku: order.planId, quantity: 1, total: order.priceCents, currency: 'CNY', transactionId: center.transactionId || `wx_${randomUUID().replaceAll('-', '')}`, paidAt: new Date(clock).toISOString(), ...overrides };
    const rawBody = JSON.stringify(payload), timestamp = String(Math.floor(clock / 1000)), nonce = '0123456789abcdef0123456789abcdef';
    return { rawBody, headers: new Headers({ 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce, 'X-Brclio-Event': payload.eventId, 'X-Brclio-Signature': createHmac('sha256', CONFIG.webhookSecret).update(`${timestamp}\n${nonce}\n${rawBody}\n`).digest('hex') }) };
  };
  return { userId, otherId, faults, remote, apiCalls, service, call, legacyCall, createInput, paid, event,
    async read() { return (await store().read()).state; },
    async mutate(fn) { return store().transaction(current => { fn(current); return { value: true }; }); },
    set createError(value) { createError = value; }, set createOverrides(value) { createOverrides = value; }, set queryOverrides(value) { queryOverrides = value; }, set minimalCreate(value) { minimalCreate = value; }, set beforeCreate(value) { beforeCreate = value; }, set beforeRefresh(value) { beforeRefresh = value; },
    get clock() { return clock; }, advance(ms) { clock += ms; },
  };
}

test('WeChat catalog uses registered integer CNY prices and exposes no credentials', async () => {
  const f = fixture(), { catalog } = await f.call('payment-catalog', {}, '');
  assert.deepEqual(catalog.plans.map(p => [p.id, p.priceCents, p.days]), [['daily', 300, 1], ['monthly', 1990, 30], ['yearly', 6990, 365]]);
  assert.deepEqual(catalog.channels, ['native']); assert.equal(catalog.provider, 'wechat');
  assert.equal(catalog.version, (await f.call('payment-catalog')).catalog.version);
  assert.equal(f.apiCalls.length, 0); assert.ok(!JSON.stringify(catalog).includes(CONFIG.apiKey));
});

test('WeChat requires the original account, session kind and exact accepted quote before creating an order', async () => {
  const f = fixture(), input = await f.createInput();
  await assert.rejects(f.call('payment-create', input, ''), { code: 'ACCOUNT_REQUIRED' });
  await assert.rejects(f.call('payment-create', { ...input, expectedUserId: f.otherId }), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(f.call('payment-create', input, f.userId, 'admin'), { code: 'USER_SESSION_REQUIRED' });
  for (const change of [{ amount: '0.01' }, { catalogVersion: 'stale' }, { planId: 'unregistered' }]) await assert.rejects(f.call('payment-create', { ...input, ...change }));
  assert.equal(f.apiCalls.length, 0); assert.equal(Object.keys((await f.read()).orders).length, 0);
});

test('WeChat persists user and quote before contacting center and retries the same business order', async () => {
  const f = fixture(), input = await f.createInput();
  f.beforeCreate = async sent => { const state = await f.read(), order = state.orders[sent.merchantOrderId]; assert.equal(order.userId, f.userId); assert.equal(order.payment.total, 300); assert.equal(sent.expectedTotal, 300); assert.equal(sent.quantity, 1); assert.equal(sent.channel, 'native'); };
  f.createError = true; await assert.rejects(f.call('payment-create', input));
  const original = Object.values((await f.read()).orders)[0];
  f.createError = false;
  const created = await f.call('payment-create', input), replayed = await f.call('payment-create', input);
  assert.equal(created.order.id, original.id); assert.equal(replayed.order.id, original.id);
  assert.equal(f.remote.size, 1); assert.equal(Object.keys((await f.read()).orders).length, 1);
  assert.ok(created.checkoutUrl); assert.equal(replayed.replayed, true);
});

test('WeChat shares request IDs with existing Alipay so changing channels cannot create another sale', async () => {
  for (const legacyFirst of [true, false]) {
    const f = fixture(), input = await f.createInput();
    if (legacyFirst) {
      await f.legacyCall(input.requestId);
      await assert.rejects(f.call('payment-create', input), { code: 'REQUEST_ID_REUSED' });
      assert.equal(f.apiCalls.length, 0); assert.equal(f.remote.size, 0);
    } else {
      await f.call('payment-create', input);
      await assert.rejects(f.legacyCall(input.requestId), { code: 'REQUEST_ID_REUSED' });
    }
    assert.equal(Object.keys((await f.read()).orders).length, 1);
  }
});

test('WeChat rejects changed center identity, price, SKU, quantity, currency and checkout origin before exposing checkout', async () => {
  for (const overrides of [{ clientId: 'p-other-product' }, { merchantOrderId: randomUUID() }, { sku: 'monthly' }, { quantity: 2 }, { amount: { total: 1, currency: 'CNY' } }, { amount: { total: 300, currency: 'USD' } }, { total: 1 }, { checkoutUrl: 'https://attacker.test/#token=fixture' }, { checkoutUrl: `${CONFIG.baseUrl}/checkout/1234567890abcdef1234567890abcdef#token=fixture` }, { checkoutUrl: `${CONFIG.baseUrl}/checkout/1234567890abcdef1234567890abcdef?other=1#token=fixture` }, { payment: { channel: 'h5' } }]) {
    const f = fixture(); f.createOverrides = overrides;
    await assert.rejects(f.call('payment-create', await f.createInput()), { code: 'PAYMENT_INVALID_ORDER' });
    const order = Object.values((await f.read()).orders)[0]; assert.equal(order.payment.orderId, null); assert.equal(order.status, 'pending');
  }
});

test('WeChat verifies signed full order when center creation returns only checkout projection', async () => {
  const f = fixture(); f.minimalCreate = true;
  const created = await f.call('payment-create', await f.createInput());
  assert.ok(created.checkoutUrl); assert.equal(f.apiCalls.filter(item => item.get).length, 1);
  const broken = fixture(); broken.minimalCreate = true; broken.queryOverrides = { clientId: 'p-other-product' };
  await assert.rejects(broken.call('payment-create', await broken.createInput()), { code: 'PAYMENT_INVALID_ORDER' });
});

test('WeChat owner-only Native QR accompanies create, resume and status without durable payloads or a second sale', async () => {
  const f = fixture(), input = await f.createInput();
  const created = await f.call('payment-create', input), remote = f.remote.get(created.order.id);
  for (const response of [created, await f.call('payment-resume', { orderId: created.order.id, expectedUserId: f.userId })]) {
    assert.equal(response.qrCodeUrl, remote.payment.codeUrl);
    assert.equal(response.qrCodeExpiresAt, remote.expiresAt);
    assert.ok(response.checkoutUrl);
  }
  const creates = f.apiCalls.filter(call => call.create).length;
  const status = await f.call('payment-status', { orderId: created.order.id, expectedUserId: f.userId });
  assert.equal(status.qrCodeUrl, remote.payment.codeUrl);
  assert.equal(status.qrCodeExpiresAt, remote.expiresAt);
  assert.equal(f.apiCalls.filter(call => call.create).length, creates, 'status reads the original center order without POST creation');
  assert.equal(f.remote.size, 1);
  const state = await f.read(), persisted = JSON.stringify(state);
  assert.equal(Object.keys(state.orders).length, 1);
  assert.equal(state.users[f.userId].membership.type, 'none');
  assert.ok(!persisted.includes('weixin:') && !persisted.includes('qrCode') && !persisted.includes('fixture-not-a-real-checkout-token'));
  assert.ok(!JSON.stringify(status).includes(CONFIG.apiKey) && !JSON.stringify(status).includes(CONFIG.webhookSecret));
});

test('missing, unsafe and expired Native QR data remains unavailable while preserving the original checkout', async () => {
  const invalidCodes = [undefined, '', 'https://attacker.test/qr', 'javascript:alert(1)', 'data:text/plain,fixture',
    'weixin://other/bizpayurl?pr=fixture', 'weixin://wxpay/other?pr=fixture', 'weixin://wxpay/bizpayurl',
    'weixin://wxpay/bizpayurl?pr=fixture&pr=second', 'weixin://wxpay/bizpayurl?pr=fixture&other=1',
    'weixin://user@wxpay/bizpayurl?pr=fixture', 'weixin://wxpay:443/bizpayurl?pr=fixture',
    'weixin://wxpay/bizpayurl?pr=fixture#other', 'weixin://wxpay/bizpayurl?pr=%00',
    'weixin://wxpay/bizpayurl?pr=has%20space', 'weixin://wxpay/bizpayurl?pr=fixture\n',
    `weixin://wxpay/bizpayurl?pr=${'a'.repeat(2050)}`];
  const invalid = invalidCodes.map(codeUrl => ({ payment: { channel: 'native', codeUrl } }));
  invalid.push({ expiresAt: undefined }, { expiresAt: 'not-a-date' }, { expiresAt: '2099' }, { expiresAt: '2026-10-20T14:10:00' }, { expiresAt: '2026-10-20T14:00:00Z' }, { expiresAt: '2026-10-20T13:59:59Z' });
  for (const change of invalid) {
    const f = fixture(); f.createOverrides = change; f.queryOverrides = change;
    const created = await f.call('payment-create', await f.createInput());
    const status = await f.call('payment-status', { orderId: created.order.id, expectedUserId: f.userId });
    for (const result of [created, status]) {
      assert.equal(result.qrCodeUrl, null); assert.equal(result.qrCodeExpiresAt, null);
      assert.equal(result.order.status, 'pending');
    }
    assert.ok(created.checkoutUrl, 'safe browser checkout remains available');
    assert.equal((await f.read()).users[f.userId].membership.type, 'none');
  }
});

test('Native QR ownership and center snapshot checks happen before data can be returned', async () => {
  const f = fixture(), { order } = await f.call('payment-create', await f.createInput());
  const before = f.apiCalls.length;
  for (const action of ['payment-resume', 'payment-status']) {
    await assert.rejects(f.call(action, { orderId: order.id, expectedUserId: f.userId }, ''), { code: 'ACCOUNT_REQUIRED' });
    await assert.rejects(f.call(action, { orderId: order.id, expectedUserId: f.otherId }, f.otherId), { code: 'ORDER_NOT_FOUND' });
    await assert.rejects(f.call(action, { orderId: order.id, expectedUserId: f.otherId }), { code: 'ACCOUNT_CHANGED' });
  }
  assert.equal(f.apiCalls.length, before);
  for (const change of [{ id: randomUUID().replaceAll('-', '') }, { clientId: 'p-other-product' }, { merchantOrderId: randomUUID() }, { sku: 'monthly' }, { quantity: 2 }, { amount: { total: 301, currency: 'CNY' } }, { amount: { total: 300, currency: 'USD' } }, { payment: { channel: 'h5', codeUrl: 'weixin://wxpay/bizpayurl?pr=isolated_invalid_channel' } }]) {
    f.queryOverrides = change;
    await assert.rejects(f.call('payment-status', { orderId: order.id, expectedUserId: f.userId }), error => {
      assert.equal(error.code, 'PAYMENT_INVALID_ORDER'); assert.ok(!error.message.includes('weixin:')); return true;
    });
  }
  assert.equal((await f.read()).users[f.userId].membership.type, 'none');
});

test('minimal creation uses the verified full order for Native QR rather than an unchecked projection', async () => {
  const f = fixture(); f.minimalCreate = true;
  f.createOverrides = { payment: { channel: 'native', codeUrl: 'weixin://wxpay/bizpayurl?pr=isolated_projection' } };
  const created = await f.call('payment-create', await f.createInput());
  assert.equal(created.qrCodeUrl, f.remote.get(created.order.id).payment.codeUrl);
  assert.notEqual(created.qrCodeUrl, 'weixin://wxpay/bizpayurl?pr=isolated_projection');
});

test('paid, closed and locally expired orders revoke QR without granting from client-visible data', async () => {
  for (const outcome of ['query-paid', 'webhook-paid', 'closed', 'expired']) {
    const f = fixture(), { order } = await f.call('payment-create', await f.createInput());
    if (outcome === 'query-paid' || outcome === 'webhook-paid') {
      f.paid(order);
      if (outcome === 'webhook-paid') await f.service().receivePayment(f.event(order));
    } else if (outcome === 'closed') f.remote.get(order.id).status = 'CLOSED';
    else f.advance(600_001);
    const status = await f.call('payment-status', { orderId: order.id, expectedUserId: f.userId });
    assert.equal(status.qrCodeUrl, null); assert.equal(status.qrCodeExpiresAt, null);
    const state = await f.read();
    if (outcome.endsWith('paid')) {
      assert.equal(status.paymentStatus, 'PAID'); assert.equal(state.audit.length, 1);
      const resumed = await f.call('payment-resume', { orderId: order.id, expectedUserId: f.userId });
      assert.equal(resumed.qrCodeUrl, null); assert.equal(resumed.qrCodeExpiresAt, null); assert.equal(resumed.checkoutUrl, undefined);
      await f.service().receivePayment(f.event(order)); assert.equal((await f.read()).audit.length, 1);
    } else assert.equal(state.users[f.userId].membership.type, 'none');
  }
});

test('a webhook confirming during a pending QR query wins the final owner snapshot', async () => {
  const f = fixture(), { order } = await f.call('payment-create', await f.createInput());
  f.beforeRefresh = async () => f.service().receivePayment(f.event(order, { transactionId: 'wx_callback_during_qr_query' }));
  const result = await f.call('payment-status', { orderId: order.id, expectedUserId: f.userId });
  assert.equal(result.paymentStatus, 'PAID'); assert.equal(result.order.status, 'confirmed');
  assert.equal(result.qrCodeUrl, null); assert.equal(result.qrCodeExpiresAt, null);
  assert.equal((await f.read()).audit.length, 1);
});

test('Native QR is withheld on binding or paid-fulfillment persistence failure and retry keeps the original order', async () => {
  const f = fixture(), input = await f.createInput();
  f.beforeCreate = async () => f.faults.push('fail');
  await assert.rejects(f.call('payment-create', input), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(Object.values((await f.read()).orders)[0].payment.orderId, null);
  f.beforeCreate = null;
  const created = await f.call('payment-create', input);
  assert.ok(created.qrCodeUrl); assert.equal(f.remote.size, 1);
  f.paid(created.order); f.faults.push('fail');
  await assert.rejects(f.call('payment-status', { orderId: created.order.id, expectedUserId: f.userId }), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal((await f.read()).users[f.userId].membership.type, 'none');
  const paid = await f.call('payment-status', { orderId: created.order.id, expectedUserId: f.userId });
  assert.equal(paid.paymentStatus, 'PAID'); assert.equal(paid.qrCodeUrl, null); assert.equal(paid.qrCodeExpiresAt, null);
  assert.equal((await f.read()).audit.length, 1);
});

test('signed SUCCESS query and webhook use the same durable fulfillment in either arrival order', async () => {
  for (const webhookFirst of [false, true]) {
    const f = fixture(), { order } = await f.call('payment-create', await f.createInput());
    f.paid(order); const event = f.event(order);
    if (webhookFirst) await f.service().receivePayment(event);
    const status = await f.call('payment-status', { orderId: order.id, expectedUserId: f.userId });
    assert.equal(status.paymentStatus, 'PAID'); assert.equal(status.order.status, 'confirmed');
    await f.service().receivePayment(event); await f.service().receivePayment(event);
    const state = await f.read();
    assert.equal(Date.parse(state.users[f.userId].membership.expiresAt) - f.clock, DAY);
    assert.equal(Object.keys(state.wechatPaymentEvents).length, 1); assert.equal(state.audit.filter(a => a.action === 'brclio-wechat-payment-paid').length, 1);
    assert.equal(Object.keys(state.paymentEvents).length, 0);
  }
});

test('WeChat queries refresh pending center status and authenticate ownership before calling center', async () => {
  const f = fixture(), { order } = await f.call('payment-create', await f.createInput());
  const count = f.apiCalls.length;
  await assert.rejects(f.call('payment-status', { orderId: order.id, expectedUserId: f.otherId }, f.otherId), { code: 'ORDER_NOT_FOUND' });
  await assert.rejects(f.call('payment-resume', { orderId: order.id, expectedUserId: f.userId }, ''), { code: 'ACCOUNT_REQUIRED' });
  assert.equal(f.apiCalls.length, count);
  await f.call('payment-status', { orderId: order.id, expectedUserId: f.userId });
  assert.equal(f.apiCalls.filter(item => item.refresh).length, 1);
});

test('WeChat rejects signed paid queries for another product, business order or amount', async () => {
  for (const change of [{ clientId: 'p-other' }, { merchantOrderId: randomUUID() }, { amount: { total: 301, currency: 'CNY' } }, { quantity: 2 }, { sku: 'monthly' }, { currency: 'USD' }, { transactionId: '' }, { paidAt: 'invalid' }]) {
    const f = fixture(), { order } = await f.call('payment-create', await f.createInput()); f.paid(order); f.queryOverrides = change;
    await assert.rejects(f.call('payment-status', { orderId: order.id, expectedUserId: f.userId }), { code: 'PAYMENT_INVALID_ORDER' });
    assert.equal((await f.read()).users[f.userId].membership.type, 'none');
  }
});

test('WeChat rejects validly signed notification fields that differ from the stored business snapshot', async () => {
  for (const change of [{ clientId: 'p-other' }, { merchantOrderId: randomUUID() }, { total: 301 }, { quantity: 2 }, { sku: 'monthly' }, { currency: 'USD' }, { orderId: 'wc_different_center_order' }]) {
    const f = fixture(), { order } = await f.call('payment-create', await f.createInput()); f.paid(order);
    await assert.rejects(f.service().receivePayment(f.event(order, change)));
    assert.equal((await f.read()).users[f.userId].membership.type, 'none');
  }
});

test('WeChat notification arriving before center id binding returns retryable failure without fulfillment', async () => {
  const f = fixture(); let earlyCode;
  f.beforeCreate = async sent => {
    const stored = (await f.read()).orders[sent.merchantOrderId];
    f.remote.set(stored.id, { id: '1234567890abcdef1234567890abcdef', transactionId: 'wx_early_transaction' });
    try { await f.service().receivePayment(f.event({ id: stored.id, planId: stored.planId, priceCents: stored.priceCents })); } catch (error) { earlyCode = error.code; }
    f.remote.delete(stored.id);
  };
  await f.call('payment-create', await f.createInput());
  assert.equal(earlyCode, 'PAYMENT_ORDER_NOT_READY'); assert.equal((await f.read()).users[f.userId].membership.type, 'none');
});

test('one WeChat transaction cannot fulfill two business orders even with two valid signed events', async () => {
  const f = fixture(), one = (await f.call('payment-create', await f.createInput())).order, two = (await f.call('payment-create', await f.createInput())).order;
  const transaction = 'wx_same_paid_transaction'; f.paid(one, { transactionId: transaction }); f.paid(two, { transactionId: transaction });
  await f.service().receivePayment(f.event(one));
  await assert.rejects(f.service().receivePayment(f.event(two)), { code: 'PAYMENT_ORDER_MISMATCH' });
  const state = await f.read(); assert.equal(state.orders[two.id].status, 'pending'); assert.equal(Object.keys(state.wechatPaymentEvents).length, 1);
});

test('concurrent WeChat signed query and duplicate callbacks commit only one GitHub receipt', async () => {
  const f = fixture(), { order } = await f.call('payment-create', await f.createInput()); f.paid(order); const event = f.event(order);
  await Promise.all([f.service().receivePayment(event), f.service().receivePayment(event), f.call('payment-status', { orderId: order.id, expectedUserId: f.userId })]);
  const state = await f.read(); assert.equal(Object.keys(state.wechatPaymentEvents).length, 1); assert.equal(state.audit.length, 1); assert.equal(Date.parse(state.users[f.userId].membership.expiresAt) - f.clock, DAY);
});

test('WeChat commit failure is retried and lost confirmation never grants twice after restart', async () => {
  for (const fault of ['fail', 'commit-lost']) {
    const f = fixture(), { order } = await f.call('payment-create', await f.createInput()); f.paid(order); const event = f.event(order);
    f.faults.push(fault); await assert.rejects(f.service().receivePayment(event), { code: fault === 'fail' ? 'STORAGE_UNAVAILABLE' : 'STORAGE_WRITE_UNCERTAIN' });
    await f.service().receivePayment(event);
    const state = await f.read(); assert.equal(state.audit.length, 1); assert.equal(Date.parse(state.users[f.userId].membership.expiresAt) - f.clock, DAY);
  }
});

test('WeChat retry after center id commit confirmation loss recovers the same checkout', async () => {
  const f = fixture(), input = await f.createInput(); let visits = 0;
  f.beforeCreate = async () => { visits++; if (visits === 1) f.faults.push('commit-lost'); };
  await assert.rejects(f.call('payment-create', input), { code: 'STORAGE_WRITE_UNCERTAIN' });
  const restored = await f.call('payment-create', input);
  assert.ok(restored.checkoutUrl); assert.equal(f.remote.size, 1); assert.equal(Object.keys((await f.read()).orders).length, 1);
});

test('WeChat refuses to bind a center id that already belongs to another business order', async () => {
  const f = fixture(), one = (await f.call('payment-create', await f.createInput())).order;
  f.createOverrides = { id: one.paymentOrderId, checkoutUrl: `${CONFIG.baseUrl}/checkout/${one.paymentOrderId}#token=fixture_duplicate_center_id` };
  await assert.rejects(f.call('payment-create', await f.createInput()), { code: 'PAYMENT_ORDER_MISMATCH' });
  const state = await f.read();
  assert.equal(state.orders[one.id].payment.orderId, one.paymentOrderId);
  assert.equal(Object.values(state.orders).filter(o => o.payment.orderId).length, 1);
  assert.equal(state.users[f.userId].membership.type, 'none');
});

test('a PAID creation response alone cannot grant WeChat membership without matching signed query', async () => {
  const f = fixture(); f.createOverrides = { status: 'SUCCESS', transactionId: 'wx_unverified_create_transaction', paidAt: new Date(f.clock).toISOString() };
  const result = await f.call('payment-create', await f.createInput());
  assert.equal(result.checkoutUrl, undefined); assert.equal(result.order.status, 'pending');
  assert.equal((await f.read()).users[f.userId].membership.type, 'none');
  assert.ok(f.apiCalls.some(call => call.get)); assert.ok(f.apiCalls.some(call => call.refresh));
});

test('WeChat fulfillment retains later permanent membership and extends active duration membership', async () => {
  for (const permanent of [false, true]) {
    const f = fixture(), { order } = await f.call('payment-create', await f.createInput());
    await f.mutate(state => { state.users[f.userId].membership = permanent ? { type: 'permanent', startsAt: new Date(f.clock).toISOString(), expiresAt: null } : { type: 'duration', startsAt: new Date(f.clock - DAY).toISOString(), expiresAt: new Date(f.clock + 5 * DAY).toISOString() }; });
    f.paid(order); await f.service().receivePayment(f.event(order));
    const member = (await f.read()).users[f.userId].membership;
    if (permanent) assert.equal(member.type, 'permanent'); else assert.equal(Date.parse(member.expiresAt) - f.clock, 6 * DAY);
  }
});

test('WeChat persisted state rejects moved user binding and duplicate center order id', async () => {
  const f = fixture(), one = (await f.call('payment-create', await f.createInput())).order, two = (await f.call('payment-create', await f.createInput())).order;
  const state = await f.read(), altered = structuredClone(state); altered.orders[one.id].userId = f.otherId;
  assert.throws(() => validateBrclioWechatPayState(altered), { code: 'STORAGE_INVALID' });
  const duplicate = structuredClone(state); duplicate.orders[two.id].payment.orderId = duplicate.orders[one.id].payment.orderId;
  assert.throws(() => validateBrclioWechatPayState(duplicate), { code: 'STORAGE_INVALID' });
});
