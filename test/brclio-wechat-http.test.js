import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createBrclioWechatPaymentHandler } from '../api/brclio-wechat-payment.js';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';

const CLIENT = 'p-2bb6d77a673327a2f8d881bac2d4fe26';
const PAY = 'https://paywc.bornforthis.cn';
const SECRET = 'isolated-wechat-http-fixture-'.repeat(3);

function reply() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}

test('WeChat callback preserves raw bytes, uses its own verifier, and bounds the HTTP interface', async () => {
  const raw = '{ "eventId": "fixture" }\n', calls = [];
  const handler = createBrclioWechatPaymentHandler({ service: { receivePayment() { assert.fail('legacy verifier must not receive WeChat callbacks'); }, async receiveWechatPayment(r) { calls.push(r.rawBody); } } });
  const call = async overrides => {
    const res = reply();
    await handler({ method: 'POST', url: '/api/brclio-wechat-payment', headers: { 'content-type': 'application/json' }, body: Buffer.from(raw), ...overrides }, res);
    return res;
  };
  assert.equal((await call()).statusCode, 200);
  assert.deepEqual(calls, [raw]);
  for (const [input, status] of [[{ method: 'GET' }, 405], [{ url: '/api/brclio-wechat-payment?paid=true' }, 400], [{ body: {} }, 400], [{ body: 'x'.repeat(16385) }, 413], [{ headers: { 'content-type': 'text/plain' } }, 415]]) assert.equal((await call(input)).statusCode, status);
  assert.equal(calls.length, 1);
});

test('production Worker routes both providers and durably fulfills WeChat query/webhook exactly once', async t => {
  const origin = 'https://product.example.test', pepper = 'isolated-http-account-pepper-'.repeat(3);
  const userId = randomUUID(), token = 'isolated-browser-token-'.repeat(3);
  let state = emptyState(), revision = 1, writes = 0;
  state.users[userId] = { id: userId, email: 'fixture@example.test', createdAt: new Date().toISOString(), membership: { type: 'none', startsAt: null, expiresAt: null } };
  state.sessions[digest(pepper, 'session', token)] = { userId, client: 'browser', revokedAt: null };
  const orders = new Map();
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/worker.js', import.meta.url))], bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'], durableObjects: { ACCOUNT_RUNTIME: { className: 'AccountRuntime', useSQLite: true } },
    bindings: { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: pepper, AUTH_GITHUB_OWNER: 'fixture', AUTH_GITHUB_REPO: 'private', AUTH_GITHUB_TOKEN: 'isolated-github-token', BRCLIO_WECHAT_PAY_BASE_URL: PAY, BRCLIO_WECHAT_PAY_CLIENT_ID: CLIENT, BRCLIO_WECHAT_PAY_API_KEY: SECRET, BRCLIO_WECHAT_PAY_WEBHOOK_SECRET: SECRET, BRCLIO_PAY_API_SECRET: SECRET, BRCLIO_PAY_WEBHOOK_SECRET: SECRET },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.origin === PAY) {
        const raw = await request.text(), ts = request.headers.get('x-brclio-timestamp'), nonce = request.headers.get('x-brclio-nonce');
        assert.equal(request.headers.get('x-brclio-client'), CLIENT);
        assert.match(nonce, /^[a-f0-9]{32}$/);
        assert.equal(request.headers.get('x-brclio-signature'), createHmac('sha256', SECRET).update([request.method, url.pathname + url.search, ts, nonce, raw, ''].join('\n')).digest('hex'));
        assert.equal(request.headers.get('authorization'), null);
        if (url.pathname === '/api/v1/orders') {
          const input = JSON.parse(raw);
          assert.equal(input.quantity, 1); assert.equal(input.channel, 'native'); assert.equal(input.expectedTotal, 300);
          if (!orders.has(input.merchantOrderId)) orders.set(input.merchantOrderId, { id: randomUUID().replaceAll('-', ''), clientId: CLIENT, merchantOrderId: input.merchantOrderId, sku: 'daily', quantity: 1, amount: { total: 300, currency: 'CNY' }, status: 'PENDING', payment: { channel: 'native' } });
          const order = orders.get(input.merchantOrderId);
          return Response.json({ ...order, checkoutUrl: `${PAY}/checkout/${order.id}#token=isolated_checkout_fixture_token` });
        }
        const order = [...orders.values()].find(o => url.pathname === `/api/v1/orders/${o.id}` || url.pathname === `/api/v1/orders/${o.id}/refresh`);
        assert.ok(order, 'only known fixture order can be queried');
        return Response.json(order);
      }
      if (url.origin === 'https://pay.bornforthis.cn') return Response.json({ clientId: 'xhs-downloader', mode: 'live', currency: 'CNY', enabled: true, version: 'legacy-fixture', skus: { daily: { subject: '日付', amount: '3.00' } } });
      assert.equal(url.origin, 'https://api.github.com');
      if (url.pathname === '/repos/fixture/private') return Response.json({ private: true });
      assert.equal(url.pathname, '/repos/fixture/private/contents/state/accounts.json');
      if (request.method === 'GET') return Response.json({ sha: String(revision), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
      const input = await request.json();
      if (input.sha !== String(revision)) return Response.json({}, { status: 409 });
      state = JSON.parse(Buffer.from(input.content, 'base64')); revision++; writes++;
      return Response.json({ content: { sha: String(revision) } });
    } }));
  t.after(() => runtime.dispose());
  const call = async (action, input = {}, authenticated = true) => {
    const res = await runtime.dispatchFetch(origin + '/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(authenticated ? { Cookie: `__Host-xhs-browser=${token}` } : {}) }, body: JSON.stringify({ action, input }) });
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes(SECRET));
    return { status: res.status, body };
  };
  const catalog = await call('payment-catalog', { provider: 'wechat' }, false);
  assert.equal(catalog.status, 200); assert.equal(catalog.body.catalog.provider, 'wechat'); assert.deepEqual(catalog.body.catalog.channels, ['native']); assert.equal(writes, 0);
  const legacy = await call('payment-catalog', {}, false);
  assert.equal(legacy.status, 200); assert.equal(legacy.body.catalog.version, 'legacy-fixture');
  const input = { provider: 'wechat', planId: 'daily', amount: '3.00', catalogVersion: catalog.body.catalog.version, expectedUserId: userId, requestId: randomUUID() };
  assert.equal((await call('payment-create', input, false)).status, 401);
  assert.equal((await call('payment-create', { ...input, amount: '0.01' })).status, 409);
  const created = await call('payment-create', input);
  assert.equal(created.status, 200, JSON.stringify(created.body)); assert.equal(created.body.order.source, 'brclio_wechat');
  const replayed = await call('payment-create', input);
  assert.equal(replayed.body.order.id, created.body.order.id); assert.equal(orders.size, 1);
  const remote = [...orders.values()][0];
  Object.assign(remote, { status: 'SUCCESS', transactionId: '20261020000000000000001', paidAt: new Date().toISOString() });
  // Input provider cannot switch an existing order away from its persisted center.
  const paid = await call('payment-status', { orderId: created.body.order.id, expectedUserId: userId, provider: 'alipay' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body)); assert.equal(paid.body.order.status, 'confirmed');
  const expires = state.users[userId].membership.expiresAt, writesAfterPaid = writes;
  const event = { eventId: `payment.success.${remote.id}`, type: 'payment.success', orderId: remote.id, clientId: CLIENT, merchantOrderId: created.body.order.id, sku: 'daily', quantity: 1, total: 300, currency: 'CNY', transactionId: remote.transactionId, paidAt: remote.paidAt };
  const raw = JSON.stringify(event, null, 2) + '\n', ts = String(Math.floor(Date.now() / 1000)), nonce = 'a'.repeat(32);
  const signature = createHmac('sha256', SECRET).update([ts, nonce, raw, ''].join('\n')).digest('hex');
  const webhook = await runtime.dispatchFetch(origin + '/api/brclio-wechat-payment', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Brclio-Timestamp': ts, 'X-Brclio-Nonce': nonce, 'X-Brclio-Event': event.eventId, 'X-Brclio-Signature': signature }, body: raw });
  assert.equal(webhook.status, 200, await webhook.text());
  assert.equal(state.users[userId].membership.expiresAt, expires); assert.equal(writes, writesAfterPaid);
  assert.equal(state.audit.filter(e => e.action === 'brclio-wechat-payment-paid').length, 1);
  const forged = await runtime.dispatchFetch(origin + '/api/brclio-wechat-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
  assert.equal(forged.status, 401); assert.equal(writes, writesAfterPaid);
});
