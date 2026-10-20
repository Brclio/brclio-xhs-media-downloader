import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createAccountService } from '../server/auth/service.js';
import { GithubStateStore, emptyState } from '../server/auth/store.js';
import { readConfig } from '../server/auth/config.js';
import { digest } from '../server/auth/crypto.js';
import { paymentReturnUrl } from '../server/auth/payment-return-url.js';

const ORIGIN = 'https://xhs.download.brclio.com';
const TIME = Date.parse('2026-10-21T01:00:00Z');
const SECRET = 'isolated-return-session-fixture-'.repeat(2);

function fixture() {
  const userId = randomUUID(), browserToken = 'return-browser-fixture-'.repeat(2), desktopToken = 'return-desktop-fixture-'.repeat(2);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = readConfig({ AUTH_SECRET_PEPPER: SECRET, AUTH_SITE_ORIGIN: ORIGIN });
  config.brclioPay = { ...config.brclioPay, apiSecret: SECRET, webhookSecret: SECRET };
  config.brclioWechatPay = { ...config.brclioWechatPay, apiKey: SECRET, webhookSecret: SECRET };
  let state = emptyState(), revision = 1;
  state.users[userId] = { id: userId, email: 'return-fixture@example.test', createdAt: new Date(TIME).toISOString(), membership: { type: 'none', startsAt: null, expiresAt: null } };
  for (const [token, client] of [[browserToken, 'browser'], [desktopToken, 'desktop']]) state.sessions[digest(config.pepper, 'session', token)] = { userId, client, revokedAt: null, ...(client === 'desktop' ? { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) } : {}) };
  const fetchImpl = async (url, options) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (options.method === 'GET') return Response.json({ sha: String(revision), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    const update = JSON.parse(options.body); if (update.sha !== String(revision)) return Response.json({}, { status: 409 });
    state = JSON.parse(Buffer.from(update.content, 'base64')); revision++;
    return Response.json({ content: { sha: String(revision) } });
  };
  const orders = new Map(), calls = [];
  const alipay = {
    async catalog() { return { clientId: 'xhs-downloader', mode: 'live', currency: 'CNY', enabled: true, version: 'return-fixture-catalog', skus: { daily: { subject: '日付', amount: '3.00' } } }; },
    async createOrder(input) {
      calls.push(input);
      if (!orders.has(input.productOrderId)) orders.set(input.productOrderId, { id: `pay_${randomUUID().replaceAll('-', '')}`, productOrderId: input.productOrderId, sku: input.sku, amount: '3.00', mode: 'live', currency: 'CNY', status: 'PENDING', checkoutUrl: 'https://pay.bornforthis.cn/checkout#token=isolated_return_checkout_fixture' });
      return orders.get(input.productOrderId);
    },
    async getOrder(id) { return [...orders.values()].find(order => order.id === id); },
  };
  const wechat = {
    async createOrder(input) {
      calls.push(input);
      if (!orders.has(input.merchantOrderId)) { const id = randomUUID().replaceAll('-', ''); orders.set(input.merchantOrderId, { id, clientId: config.brclioWechatPay.clientId, merchantOrderId: input.merchantOrderId, sku: input.sku, quantity: 1, amount: { total: 300, currency: 'CNY' }, status: 'PENDING', payment: { channel: 'native' }, checkoutUrl: `https://paywc.bornforthis.cn/checkout/${id}#token=isolated_return_checkout_fixture` }); }
      return orders.get(input.merchantOrderId);
    },
    async getOrder(id) { return [...orders.values()].find(order => order.id === id); },
    async refreshOrder(id) { return this.getOrder(id); },
  };
  const store = () => new GithubStateStore({ owner: 'return-fixture', repo: 'private-data', token: 'return-fixture-github-token', fetchImpl, delay: async () => {} });
  const service = () => createAccountService({ store: store(), config, now: () => TIME, mailer: {}, paymentClient: alipay, wechatPaymentClient: wechat });
  const call = (action, input, client = 'browser', proof = true) => {
    const token = client === 'desktop' ? desktopToken : browserToken;
    const nonce = randomUUID(), signature = sign(null, Buffer.from(`${action}\n${TIME}\n${nonce}\n${JSON.stringify(input)}\n${token}`), privateKey).toString('base64');
    return service().execute({ action, input, token, client, ...(client === 'desktop' && proof ? { proof: { timestamp: TIME, nonce, signature } } : {}) });
  };
  const input = async provider => ({ ...(provider === 'wechat' ? { provider } : {}), expectedUserId: userId, requestId: randomUUID(), planId: 'daily', amount: '3.00', catalogVersion: (await call('payment-catalog', provider === 'wechat' ? { provider } : {})).catalog.version });
  return { userId, call, input, calls, async read() { return (await store().read()).state; }, async mutate(fn) { return store().transaction(current => { fn(current); return { value: true }; }); } };
}

test('payment return URL accepts only HTTPS origin and an order UUID without any session data', () => {
  const id = randomUUID();
  assert.equal(paymentReturnUrl(ORIGIN, id, 'desktop'), `${ORIGIN}/payment-return?payment_order=${id}&client=desktop`);
  assert.equal(paymentReturnUrl(ORIGIN, id, 'browser'), `${ORIGIN}/?payment_order=${id}`);
  for (const origin of ['http://example.test', `${ORIGIN}/path`, `${ORIGIN}/?token=secret`, 'https://user:secret@example.test']) assert.throws(() => paymentReturnUrl(origin, id, 'desktop'), { code: 'PAYMENT_NOT_CONFIGURED' });
  assert.throws(() => paymentReturnUrl(ORIGIN, 'not-an-order', 'desktop'), { code: 'PAYMENT_INVALID_ORDER' });
});

test('both centers return authenticated desktop purchases to the app handoff and browser purchases to their website', async () => {
  for (const provider of ['alipay', 'wechat']) {
    const f = fixture(), desktopInput = await f.input(provider);
    await assert.rejects(f.call('payment-create', desktopInput, 'desktop', false), { code: 'INVALID_DEVICE_PROOF' });
    const desktop = await f.call('payment-create', desktopInput, 'desktop');
    assert.equal(f.calls.at(-1).returnUrl, `${ORIGIN}/payment-return?payment_order=${desktop.order.id}&client=desktop`);
    const browser = await f.call('payment-create', { ...await f.input(provider), client: 'desktop' });
    assert.equal(f.calls.at(-1).returnUrl, `${ORIGIN}/?payment_order=${browser.order.id}`, 'a browser input hint cannot impersonate a desktop session');
    assert.equal((await f.read()).users[f.userId].membership.type, 'none');
  }
});

test('retries and restored historical orders retain their original return URL across browser and desktop sessions', async () => {
  for (const provider of ['alipay', 'wechat']) {
    const f = fixture(), input = await f.input(provider), created = await f.call('payment-create', input);
    const original = (await f.read()).orders[created.order.id].payment.returnUrl;
    const retried = await f.call('payment-create', input, 'desktop');
    assert.equal(retried.order.id, created.order.id); assert.equal(f.calls.at(-1).returnUrl, original);
    await f.call('payment-resume', { orderId: created.order.id, expectedUserId: f.userId }, 'desktop');
    assert.equal(f.calls.at(-1).returnUrl, original);
    assert.equal(Object.keys((await f.read()).orders).length, 1);
  }
});
