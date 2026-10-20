import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { GithubStateStore, emptyState } from '../server/auth/store.js';
import { createAccountService } from '../server/auth/service.js';
import { readConfig } from '../server/auth/config.js';
import { digest } from '../server/auth/crypto.js';

const CENTER = 'https://paywc.bornforthis.cn';
const CLIENT_ID = 'p-2bb6d77a673327a2f8d881bac2d4fe26';
const SECRET = 'isolated-reference-audit-fixture-'.repeat(2);
const DAY = 86_400_000;
const TIME = Date.parse('2026-10-20T14:00:00Z');

function fixture() {
  const userId = randomUUID(), otherId = randomUUID(), adminId = randomUUID();
  const userToken = 'reference-user-token-'.repeat(3), adminToken = 'reference-admin-token-'.repeat(3);
  const config = readConfig({ AUTH_SECRET_PEPPER: SECRET, AUTH_SITE_ORIGIN: 'https://reference.example.test', AUTH_ADMIN_EMAILS: 'reference-admin@example.test' });
  config.brclioWechatPay = { baseUrl: CENTER, clientId: CLIENT_ID, apiKey: SECRET, webhookSecret: SECRET, returnOrigin: config.siteOrigin };
  let state = emptyState(), revision = 1, writes = 0, conflicts = 0, delaySource = null, raceArrivals = 0, raceReady = null, releaseRace;
  const centerOrders = new Map();
  for (const [id, email] of [[userId, 'reference-user@example.test'], [otherId, 'reference-other@example.test'], [adminId, 'reference-admin@example.test']]) state.users[id] = { id, email, createdAt: new Date(TIME).toISOString(), membership: { type: 'none', startsAt: null, expiresAt: null } };
  for (const [id, token, client] of [[userId, userToken, 'browser'], [adminId, adminToken, 'admin']]) state.sessions[digest(config.pepper, 'session', token)] = { userId: id, client, revokedAt: null };
  const fetchImpl = async (url, options) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (options.method === 'GET') return Response.json({ sha: String(revision), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    const update = JSON.parse(options.body), next = JSON.parse(Buffer.from(update.content, 'base64'));
    if (raceReady && raceArrivals < 2 && Object.values(next.orders).some(order => order.status === 'confirmed')) {
      raceArrivals++;
      if (raceArrivals === 2) releaseRace();
      await raceReady;
    }
    if (delaySource && Object.values(next.orders).some(order => order.source === delaySource && order.status === 'confirmed')
      && !Object.values(state.orders).some(order => order.source === delaySource && order.status === 'confirmed')) await new Promise(resolve => setTimeout(resolve, 10));
    if (update.sha !== String(revision)) { conflicts++; return Response.json({}, { status: 409 }); }
    state = next; revision++; writes++;
    return Response.json({ content: { sha: String(revision) } });
  };
  const store = () => new GithubStateStore({ owner: 'reference-fixture', repo: 'private-data', token: 'reference-fixture-token', fetchImpl, delay: async () => {} });
  const paymentClient = {
    async createOrder(input) {
      if (!centerOrders.has(input.merchantOrderId)) {
        const id = randomUUID().replaceAll('-', '');
        centerOrders.set(input.merchantOrderId, { id, clientId: CLIENT_ID, merchantOrderId: input.merchantOrderId, sku: input.sku, quantity: 1, amount: { total: input.expectedTotal, currency: 'CNY' }, status: 'PENDING', payment: { channel: 'native' }, checkoutUrl: `${CENTER}/checkout/${id}#token=reference_fixture_checkout_token` });
      }
      return structuredClone(centerOrders.get(input.merchantOrderId));
    },
    async getOrder(id) { return structuredClone([...centerOrders.values()].find(order => order.id === id)); },
    async refreshOrder(id) { return this.getOrder(id); },
  };
  const service = () => createAccountService({ store: store(), config, mailer: {}, now: () => TIME, wechatPaymentClient: paymentClient });
  const call = (action, input = {}, admin = false) => service().execute({ action, input, token: admin ? adminToken : userToken, client: admin ? 'admin' : 'browser' });
  const create = async () => {
    const { catalog } = await call('payment-catalog', { provider: 'wechat' });
    return (await call('payment-create', { provider: 'wechat', requestId: randomUUID(), expectedUserId: userId, planId: 'daily', amount: '3.00', catalogVersion: catalog.version })).order;
  };
  const paid = (order, transactionId) => Object.assign(centerOrders.get(order.id), { status: 'SUCCESS', transactionId, paidAt: new Date(TIME).toISOString() });
  const check = order => call('payment-status', { orderId: order.id, expectedUserId: userId });
  const manual = (reference, overrides = {}) => call('admin-record-order', { requestId: randomUUID(), userId, planId: 'daily', paymentMethod: 'wechat', amountCents: 300, paidAt: new Date(TIME).toISOString(), transactionReference: reference, reason: '核对历史收款凭证', ...overrides }, true);
  const webhook = order => {
    const p = centerOrders.get(order.id), timestamp = String(TIME / 1000), nonce = 'a'.repeat(32);
    const event = { eventId: `payment.success.${p.id}`, type: 'payment.success', orderId: p.id, clientId: CLIENT_ID, merchantOrderId: order.id, sku: order.planId, quantity: 1, total: order.priceCents, currency: 'CNY', transactionId: p.transactionId, paidAt: p.paidAt };
    const rawBody = JSON.stringify(event), headers = new Headers({ 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce, 'X-Brclio-Event': event.eventId, 'X-Brclio-Signature': createHmac('sha256', SECRET).update(`${timestamp}\n${nonce}\n${rawBody}\n`).digest('hex') });
    return service().receiveWechatPayment({ rawBody, headers });
  };
  return { userId, otherId, create, paid, check, manual, webhook, call, service, config,
    async read() { return (await store().read()).state; },
    async revenue() { return (await call('admin-revenue', {}, true)).revenue; },
    set delaySource(value) { delaySource = value; raceReady = new Promise(resolve => { releaseRace = resolve; }); }, get writes() { return writes; }, get conflicts() { return conflicts; },
  };
}

test('a verified WeChat receipt prevents manual duplicate references for this or another user without changing the original receipt', async () => {
  const f = fixture(), order = await f.create();
  f.paid(order, 'WX_AUDIT_TRANSACTION_001'); await f.check(order);
  const before = await f.read(), writes = f.writes;
  for (const userId of [f.userId, f.otherId]) await assert.rejects(f.manual('  wx_audit_transaction_001  ', { userId }), { code: 'ORDER_PAYMENT_DUPLICATE' });
  assert.equal(f.writes, writes); assert.deepEqual(await f.read(), before);
  assert.equal((await f.revenue()).totalCents, 300);
  assert.equal((await f.call('orders-mine')).orders[0].id, order.id);
});

test('a historical manual WeChat receipt blocks both paid query and callback fulfillment without migrating its hash or membership', async () => {
  const f = fixture(), manual = (await f.manual('WX_AUDIT_TRANSACTION_002')).order;
  const original = (await f.read()).orders[manual.id];
  const order = await f.create(); f.paid(order, 'wx_audit_transaction_002');
  const writes = f.writes;
  await assert.rejects(f.check(order), { code: 'PAYMENT_ORDER_MISMATCH' });
  await assert.rejects(f.webhook(order), { code: 'PAYMENT_ORDER_MISMATCH' });
  const state = await f.read();
  assert.equal(f.writes, writes); assert.deepEqual(state.orders[manual.id], original);
  assert.equal(original.paymentKey, digest(f.config.pepper, 'order-payment', 'wechat:wx_audit_transaction_002'));
  assert.equal(state.orders[order.id].status, 'pending'); assert.equal(state.users[f.userId].membership.type, 'none');
  assert.equal(Object.keys(state.wechatPaymentEvents).length, 0);
  assert.equal((await f.revenue()).totalCents, 300);
  assert.equal((await f.call('orders-mine')).total, 2, 'the historical receipt and unfulfilled automatic order remain visible');
});

test('manual receipt and automatic WeChat fulfillment race within the same GitHub CAS boundary for either winner', async () => {
  for (const delayedSource of ['admin_record', 'brclio_wechat']) for (const viaWebhook of [false, true]) {
    const f = fixture(), order = await f.create(); f.paid(order, 'WX_AUDIT_TRANSACTION_003'); f.delaySource = delayedSource;
    const results = await Promise.allSettled([f.manual('wx_audit_transaction_003'), viaWebhook ? f.webhook(order) : f.check(order)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(['ORDER_PAYMENT_DUPLICATE', 'PAYMENT_ORDER_MISMATCH'].includes(results.find(result => result.status === 'rejected').reason.code));
    assert.ok(f.conflicts > 0, 'the slower writer must revalidate after a real GitHub SHA conflict');
    const state = await f.read(), receipts = Object.values(state.orders).filter(item => item.status === 'confirmed');
    assert.equal(receipts.length, 1); assert.equal((await f.revenue()).totalCents, 300);
    if (receipts[0].source === 'brclio_wechat') {
      assert.equal(Date.parse(state.users[f.userId].membership.expiresAt) - TIME, DAY);
      assert.equal(Object.keys(state.wechatPaymentEvents).length, 1);
    } else {
      assert.equal(state.users[f.userId].membership.type, 'none'); assert.equal(Object.keys(state.wechatPaymentEvents).length, 0);
    }
  }
});

test('different WeChat receipts and the same textual Alipay reference retain their independent historical ledger entries', async () => {
  const f = fixture(), oldWechat = (await f.manual('WX_AUDIT_TRANSACTION_004')).order;
  const oldAlipay = (await f.manual('WX_AUDIT_TRANSACTION_005', { paymentMethod: 'alipay' })).order;
  const before = await f.read(), order = await f.create(); f.paid(order, 'WX_AUDIT_TRANSACTION_005');
  await f.check(order); await f.webhook(order);
  const state = await f.read(), revenue = await f.revenue();
  for (const historical of [oldWechat, oldAlipay]) assert.deepEqual(state.orders[historical.id], before.orders[historical.id]);
  assert.equal(revenue.confirmedCount, 3); assert.equal(revenue.totalCents, 900);
  assert.equal(state.audit.filter(event => event.action === 'brclio-wechat-payment-paid').length, 1);
});
