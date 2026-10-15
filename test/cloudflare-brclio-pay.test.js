import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign, createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';

test('production Worker and AccountRuntime sign current catalog requests and commit payment entitlements durably', async t => {
  const origin = 'https://payment.example.test', payOrigin = 'https://pay.example.test';
  const pepper = 'isolated-payment-account-fixture-'.repeat(2), apiSecret = 'isolated-payment-api-fixture-'.repeat(2), webhookSecret = 'isolated-payment-webhook-fixture-'.repeat(2);
  const ownerId = randomUUID(), otherId = randomUUID(), adminId = randomUUID();
  const ownerToken = 'o'.repeat(43), otherToken = 'u'.repeat(43), adminToken = 'a'.repeat(43), desktopToken = 'd'.repeat(43);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let state = emptyState(), revision = 1, writes = 0, putAttempts = 0, failNextPut = false, loseNextReceipt = false;
  const createdAt = new Date().toISOString();
  for (const [id, email] of [[ownerId, 'owner@example.test'], [otherId, 'other@example.test'], [adminId, 'admin@example.test']]) state.users[id] = { id, email, createdAt, membership: { type: 'none', startsAt: null, expiresAt: null } };
  for (const [token, userId, client] of [[ownerToken, ownerId, 'browser'], [otherToken, otherId, 'browser'], [adminToken, adminId, 'admin'], [desktopToken, ownerId, 'desktop']]) {
    state.sessions[digest(pepper, 'session', token)] = { id: randomUUID(), userId, client, revokedAt: null, createdAt, ...(client === 'desktop' ? { publicKey: publicKey.export({ format: 'pem', type: 'spki' }) } : {}) };
  }
  // Existing account snapshots have no payment table; read-only catalog access
  // must not persist a migration or expose the local credentials.
  delete state.paymentEvents;
  let catalog = { clientId: 'xhs-downloader', name: 'XHS fixture', enabled: true, mode: 'live', currency: 'CNY', version: 'catalog-one', skus: { daily: { subject: '日付', amount: '3.00' }, monthly: { subject: '月付', amount: '19.90' }, yearly: { subject: '年付', amount: '69.90', enabled: false } } };
  const paymentOrders = new Map(), external = [], apiNonces = new Set();
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/worker.js', import.meta.url))], bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ACCOUNT_RUNTIME: { className: 'AccountRuntime', useSQLite: true } },
    bindings: { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: pepper, AUTH_ADMIN_EMAILS: 'admin@example.test', AUTH_GITHUB_OWNER: 'fixture', AUTH_GITHUB_REPO: 'payment', AUTH_GITHUB_TOKEN: 'isolated-github-fixture', BRCLIO_PAY_BASE_URL: payOrigin, BRCLIO_PAY_CLIENT_ID: 'xhs-downloader', BRCLIO_PAY_API_SECRET: apiSecret, BRCLIO_PAY_WEBHOOK_SECRET: webhookSecret, BRCLIO_PAY_MODE: 'live' },
    outboundService: async request => {
      const url = new URL(request.url);
      external.push({ origin: url.origin, path: url.pathname, method: request.method });
      if (url.origin === payOrigin) {
        const body = await request.text(), timestamp = request.headers.get('x-brclio-timestamp'), nonce = request.headers.get('x-brclio-nonce');
        assert.equal(url.search, ''); assert.equal(request.headers.get('x-brclio-client'), 'xhs-downloader');
        assert.match(timestamp, /^\d{10}$/); assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 300);
        assert.match(nonce, /^[A-Za-z0-9_-]{16,80}$/); assert.ok(!apiNonces.has(nonce)); apiNonces.add(nonce);
        const canonical = [request.method, url.pathname, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
        assert.equal(request.headers.get('x-brclio-signature'), createHmac('sha256', apiSecret).update(canonical).digest('hex'));
        assert.equal(request.headers.get('authorization'), null, 'integration Bearer credentials are never used for payment APIs');
        if (url.pathname === '/api/v1/catalog') { assert.equal(request.method, 'GET'); assert.equal(body, ''); return Response.json(catalog); }
        if (url.pathname === '/api/v1/orders') {
          assert.equal(request.method, 'POST');
          const input = JSON.parse(body);
          assert.deepEqual(Object.keys(input).sort(), ['productOrderId', 'returnUrl', 'sku']);
          assert.equal(new URL(input.returnUrl).origin, origin);
          assert.equal(new URL(input.returnUrl).searchParams.get('payment_order'), input.productOrderId);
          let order = paymentOrders.get(input.productOrderId);
          if (!order) {
            order = { id: `pay_${randomUUID().replaceAll('-', '')}`, productOrderId: input.productOrderId, sku: input.sku, amount: catalog.skus[input.sku].amount, clientId: 'xhs-downloader', mode: 'live', currency: 'CNY', status: 'PENDING' };
            paymentOrders.set(input.productOrderId, order);
          }
          return Response.json({ order, checkoutUrl: `${payOrigin}/checkout/${order.id}#token=local-checkout-fixture` });
        }
        const order = [...paymentOrders.values()].find(item => `/api/v1/orders/${item.id}` === url.pathname);
        assert.ok(order, `unexpected payment request ${url.pathname}`); assert.equal(request.method, 'GET');
        return Response.json({ order });
      }
      assert.equal(url.origin, 'https://api.github.com', 'only local GitHub and pay mocks are reachable');
      assert.equal(request.headers.get('authorization'), 'Bearer isolated-github-fixture');
      if (url.pathname === '/repos/fixture/payment') return Response.json({ private: true });
      assert.equal(url.pathname, '/repos/fixture/payment/contents/state/accounts.json');
      if (request.method === 'GET') return Response.json({ sha: String(revision), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
      assert.equal(request.method, 'PUT'); putAttempts++;
      if (failNextPut) { failNextPut = false; return Response.json({}, { status: 503 }); }
      const update = await request.json();
      if (update.sha !== String(revision)) return Response.json({}, { status: 409 });
      state = JSON.parse(Buffer.from(update.content, 'base64').toString('utf8')); revision++; writes++;
      if (loseNextReceipt) { loseNextReceipt = false; return Response.json({}, { status: 503 }); }
      return Response.json({ content: { sha: String(revision) } });
    },
  }));
  t.after(() => runtime.dispose());
  const ownerCookie = `__Host-xhs-browser=${ownerToken}`, otherCookie = `__Host-xhs-browser=${otherToken}`, adminCookie = `__Host-xhs-admin=${adminToken}`;
  async function call(action, input = {}, { cookie = '', headers = {}, proof } = {}) {
    const response = await runtime.dispatchFetch(`${origin}/api/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify({ action, input, ...(proof ? { proof } : {}) }) });
    const body = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('access-control-allow-origin'), null);
    for (const secret of [apiSecret, webhookSecret, pepper, 'isolated-github-fixture']) assert.ok(!JSON.stringify(body).includes(secret));
    return { response, body };
  }
  function desktopCall(action, input) {
    const timestamp = Date.now(), nonce = randomUUID();
    const signature = sign(null, Buffer.from(`${action}\n${timestamp}\n${nonce}\n${JSON.stringify(input)}\n${desktopToken}`), privateKey).toString('base64');
    return call(action, input, { headers: { Authorization: `Bearer ${desktopToken}` }, proof: { timestamp, nonce, signature } });
  }
  const quoteInput = (extra = {}) => ({ expectedUserId: ownerId, requestId: randomUUID(), planId: 'monthly', amount: catalog.skus.monthly.amount, catalogVersion: catalog.version, ...extra });
  function eventFor(order, extra = {}) {
    const now = new Date().toISOString();
    return { id: `evt_${order.paymentOrderId}`, type: 'payment.paid', mode: 'live', createdAt: now, data: { orderId: order.paymentOrderId, productOrderId: order.id, clientId: 'xhs-downloader', sku: order.planId, amount: `${(order.priceCents / 100).toFixed(2)}`, currency: 'CNY', tradeNo: '20261015000000000001', paidAt: now }, ...extra };
  }
  async function notify(event, { raw = JSON.stringify(event, null, 2) + '\n', signatureBody = raw, headers = {} } = {}) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await runtime.dispatchFetch(`${origin}/api/brclio-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Event': event.id, 'X-Brclio-Signature': createHmac('sha256', webhookSecret).update(`${timestamp}.${signatureBody}`).digest('hex'), ...headers }, body: raw });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    return { response, body: await response.json() };
  }
  let firstOrder;

  await t.test('anonymous catalog is live and disabled products never appear for sale', async () => {
    const first = await call('payment-catalog');
    assert.equal(first.response.status, 200, JSON.stringify(first.body)); assert.equal(first.body.catalog.version, 'catalog-one');
    assert.deepEqual(first.body.catalog.plans.map(plan => plan.id), ['daily', 'monthly']); assert.equal(writes, 0); assert.equal(state.paymentEvents, undefined);
    catalog = { ...catalog, version: 'catalog-two', skus: { ...catalog.skus, monthly: { ...catalog.skus.monthly, amount: '20.90' } } };
    const updated = await call('payment-catalog');
    assert.equal(updated.body.catalog.version, 'catalog-two'); assert.equal(updated.body.catalog.plans.find(plan => plan.id === 'monthly').priceCents, 2090);
    assert.equal(external.filter(request => request.path === '/api/v1/catalog').length, 2);
  });

  await t.test('browser identity and exact origin are required for purchases and desktop proofs remain required', async () => {
    const before = external.length;
    const csrf = await call('payment-create', quoteInput(), { cookie: ownerCookie, headers: { Origin: 'https://untrusted.example.test' } });
    assert.equal(csrf.response.status, 403); assert.equal(csrf.body.error.code, 'ORIGIN_FORBIDDEN'); assert.equal(external.length, before);
    const anonymous = await call('payment-create', quoteInput());
    assert.equal(anonymous.response.status, 401); assert.equal(anonymous.body.error.code, 'ACCOUNT_REQUIRED');
    const accountChanged = await call('payment-create', quoteInput(), { cookie: otherCookie });
    assert.equal(accountChanged.response.status, 409); assert.equal(accountChanged.body.error.code, 'ACCOUNT_CHANGED');
    const administrator = await call('payment-create', quoteInput(), { cookie: adminCookie });
    assert.equal(administrator.response.status, 403); assert.equal(administrator.body.error.code, 'USER_SESSION_REQUIRED');
    const unsigned = await call('payment-create', quoteInput(), { headers: { Authorization: `Bearer ${desktopToken}` } });
    assert.equal(unsigned.response.status, 401); assert.equal(unsigned.body.error.code, 'INVALID_DEVICE_PROOF');
    const input = quoteInput(), created = await call('payment-create', input, { cookie: `${ownerCookie}; ${adminCookie}` });
    assert.equal(created.response.status, 200, JSON.stringify(created.body)); firstOrder = created.body.order;
    assert.match(created.body.checkoutUrl, /^https:\/\/pay\.example\.test\/checkout\/pay_/);
    assert.equal(firstOrder.priceCents, 2090); assert.equal(firstOrder.status, 'pending');
    assert.equal(state.orders[firstOrder.id].entitlementSnapshot.days, 30); assert.equal(state.users[ownerId].membership.type, 'none');
    const repeated = await call('payment-create', input, { cookie: ownerCookie });
    assert.equal(repeated.body.order.id, firstOrder.id); assert.equal(repeated.body.replayed, true);
  });

  await t.test('checkout return and even an upstream PAID status never grant membership', async () => {
    const other = await call('payment-status', { expectedUserId: otherId, orderId: firstOrder.id }, { cookie: otherCookie });
    assert.equal(other.response.status, 404);
    paymentOrders.get(firstOrder.id).status = 'PAID';
    const result = await desktopCall('payment-status', { expectedUserId: ownerId, orderId: firstOrder.id, success: true, amount: '0.01' });
    assert.equal(result.response.status, 200, JSON.stringify(result.body)); assert.equal(result.body.paymentStatus, 'PAID');
    assert.equal(result.body.order.status, 'pending'); assert.equal(state.users[ownerId].membership.type, 'none');
    assert.equal(Object.keys(state.paymentEvents).length, 0);
  });

  await t.test('signed raw-body notifications reject alteration, wrong product, sandbox and mismatched historical amount', async () => {
    const valid = eventFor(firstOrder), writesBefore = writes;
    const spaced = JSON.stringify(valid, null, 2) + '\n';
    const altered = await notify(valid, { raw: JSON.stringify(valid), signatureBody: spaced });
    assert.equal(altered.response.status, 401); assert.equal(altered.body.error.code, 'PAYMENT_INVALID_SIGNATURE');
    for (const event of [{ ...valid, mode: 'sandbox' }, { ...valid, data: { ...valid.data, clientId: 'another-product' } }, { ...valid, data: { ...valid.data, amount: '0.01' } }]) {
      const rejected = await notify(event);
      assert.ok([401, 409].includes(rejected.response.status), JSON.stringify(rejected.body));
    }
    assert.equal(writes, writesBefore); assert.equal(state.users[ownerId].membership.type, 'none');
    // A later catalog price must not invalidate the amount already promised.
    catalog = { ...catalog, version: 'catalog-three', skus: { ...catalog.skus, monthly: { ...catalog.skus.monthly, amount: '29.90' } } };
  });

  await t.test('temporary persistence failure is retried, then one signed notification grants once', async () => {
    const event = eventFor(firstOrder), before = writes;
    failNextPut = true;
    const failed = await notify(event);
    assert.equal(failed.response.status, 503); assert.equal(state.orders[firstOrder.id].status, 'pending'); assert.equal(state.users[ownerId].membership.type, 'none'); assert.equal(writes, before);
    const paid = await notify(event);
    assert.equal(paid.response.status, 200, JSON.stringify(paid.body)); assert.deepEqual(paid.body, { ok: true });
    assert.equal(state.orders[firstOrder.id].status, 'confirmed'); assert.equal(state.orders[firstOrder.id].amountCents, 2090);
    const granted = structuredClone(state.users[ownerId].membership);
    assert.equal(granted.type, 'duration'); assert.equal(Date.parse(granted.expiresAt) - Date.parse(granted.startsAt), 30 * 86_400_000);
    assert.equal(writes, before + 1); assert.equal(state.paymentEvents[event.id].orderId, firstOrder.id);
    const duplicate = await notify(event);
    assert.equal(duplicate.response.status, 200); assert.equal(writes, before + 1); assert.deepEqual(state.users[ownerId].membership, granted);
    assert.equal(state.audit.filter(entry => entry.action === 'brclio-payment-paid' && entry.orderId === firstOrder.id).length, 1);
  });

  await t.test('a lost write receipt remains retryable and persisted dedupe prevents a second extension', async () => {
    const created = await desktopCall('payment-create', quoteInput({ planId: 'daily', amount: '3.00' }));
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    const event = eventFor(created.body.order), before = writes;
    loseNextReceipt = true;
    const uncertain = await notify(event);
    assert.equal(uncertain.response.status, 503); assert.equal(writes, before + 1);
    const afterCommit = structuredClone(state.users[ownerId].membership);
    const retried = await notify(event);
    assert.equal(retried.response.status, 200); assert.equal(writes, before + 1); assert.deepEqual(state.users[ownerId].membership, afterCommit);
    assert.equal(Object.keys(state.paymentEvents).length, 2); assert.ok(putAttempts > writes);
  });
});
