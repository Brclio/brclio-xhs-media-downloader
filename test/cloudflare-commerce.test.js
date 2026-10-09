import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';

test('production Worker and AccountRuntime isolate public reviews, personal orders and confirmed receipts', async t => {
  const origin = 'https://commerce.example.test', pepper = 'isolated-commerce-worker-fixture-'.repeat(2);
  const createdAt = new Date().toISOString(), ownerId = randomUUID(), otherId = randomUUID(), adminId = randomUUID();
  const ownerToken = 'o'.repeat(43), otherToken = 'u'.repeat(43), adminToken = 'a'.repeat(43), desktopToken = 'd'.repeat(43);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let state = emptyState(), version = 1, writes = 0, commitWithoutReceipt = false;
  // Exercise a deployed schema-v1 snapshot: new fields appear only on a write.
  delete state.reviews; delete state.orders;
  for (const [id, email] of [[ownerId, 'owner@example.test'], [otherId, 'other@example.test'], [adminId, 'admin@example.test']]) {
    state.users[id] = { id, email, createdAt, membership: { type: 'none', startsAt: null, expiresAt: null } };
  }
  for (const [token, userId, client] of [[ownerToken, ownerId, 'browser'], [otherToken, otherId, 'browser'], [adminToken, adminId, 'admin'], [desktopToken, ownerId, 'desktop']]) {
    state.sessions[digest(pepper, 'session', token)] = { id: randomUUID(), userId, client, revokedAt: null, createdAt, ...(client === 'desktop' ? { publicKey: publicKey.export({ format: 'pem', type: 'spki' }) } : {}) };
  }
  const legacyId = randomUUID();
  state.codes[legacyId] = { id: legacyId, recipientId: ownerId, recipientEmail: 'owner@example.test', planId: 'monthly', planName: '月付', priceCents: 1990, createdAt, status: 'used', redeemedBy: ownerId, digest: 'PRIVATE_ACTIVATION_DIGEST' };
  const giftId = randomUUID();
  state.codes[giftId] = { id: giftId, type: 'permanent', createdAt, status: 'used', redeemedBy: ownerId, digest: 'PRIVATE_GIFT_DIGEST' };
  state.audit.push({ id: randomUUID(), actorId: adminId, actorEmail: 'admin@example.test', action: 'admin-membership', at: createdAt, targetId: ownerId, reason: 'PRIVATE_AUDIT_REASON', before: null, after: { type: 'permanent' } });
  const external = [];
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/worker.js', import.meta.url))], bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ACCOUNT_RUNTIME: { className: 'AccountRuntime', useSQLite: true } },
    bindings: { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: pepper, AUTH_ADMIN_EMAILS: 'admin@example.test', AUTH_GITHUB_OWNER: 'fixture', AUTH_GITHUB_REPO: 'commerce', AUTH_GITHUB_TOKEN: 'isolated-fixture-token' },
    outboundService: async request => {
      const url = new URL(request.url);
      external.push({ path: url.pathname, method: request.method });
      assert.equal(url.origin, 'https://api.github.com', 'all network traffic stays in the local fixture; commerce never sends email');
      assert.equal(request.headers.get('authorization'), 'Bearer isolated-fixture-token');
      if (url.pathname === '/repos/fixture/commerce') return Response.json({ private: true });
      assert.equal(url.pathname, '/repos/fixture/commerce/contents/state/accounts.json');
      if (request.method === 'GET') return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
      assert.equal(request.method, 'PUT');
      const update = await request.json();
      if (update.sha !== String(version)) return Response.json({}, { status: 409 });
      state = JSON.parse(Buffer.from(update.content, 'base64').toString('utf8')); version++; writes++;
      if (commitWithoutReceipt) { commitWithoutReceipt = false; return Response.json({}, { status: 503 }); }
      return Response.json({ content: { sha: String(version) } });
    },
  }));
  t.after(() => runtime.dispose());
  const ownerCookie = `__Host-xhs-browser=${ownerToken}`, otherCookie = `__Host-xhs-browser=${otherToken}`, adminCookie = `__Host-xhs-admin=${adminToken}`;
  const bothCookies = `${ownerCookie}; ${adminCookie}`;
  async function call(action, input = {}, cookie = '', headers = {}, proof) {
    const response = await runtime.dispatchFetch(`${origin}/api/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify({ action, input, ...(proof ? { proof } : {}) }) });
    const body = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store', `${action} must never enter a shared cache`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    for (const dimension of ['Origin', 'Cookie', 'Authorization']) assert.ok(response.headers.get('vary').includes(dimension));
    assert.equal(response.headers.get('set-cookie'), null, 'commerce requests never replace login cookies');
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'private account data does not gain permissive CORS');
    return { response, body };
  }
  function desktopCall(action, input) {
    const timestamp = Date.now(), nonce = randomUUID();
    const signature = sign(null, Buffer.from(`${action}\n${timestamp}\n${nonce}\n${JSON.stringify(input)}\n${desktopToken}`), privateKey).toString('base64');
    return call(action, input, '', { Authorization: `Bearer ${desktopToken}` }, { timestamp, nonce, signature });
  }
  const orderInput = extra => ({ expectedUserId: ownerId, requestId: randomUUID(), planId: 'monthly', paymentMethod: 'wechat', ...extra });
  const receiptInput = extra => ({ requestId: randomUUID(), userId: ownerId, planId: 'monthly', amountCents: 1800, paymentMethod: 'wechat', paidAt: '2026-01-01T16:00:00Z', transactionReference: randomUUID(), reason: '核实真实到账凭证', ...extra });

  await t.test('anonymous reads migrate old snapshots in memory and expose a strict review allowlist', async () => {
    const anonymous = await call('reviews-public');
    assert.equal(anonymous.response.status, 200); assert.deepEqual(anonymous.body.reviews, []);
    assert.deepEqual(anonymous.body.summary, { count: 0, averageRating: 0 });
    assert.equal(writes, 0); assert.equal(state.reviews, undefined); assert.equal(state.orders, undefined);
    for (const action of ['review-mine', 'orders-mine']) {
      const denied = await call(action); assert.equal(denied.response.status, 401); assert.equal(denied.body.error.code, 'ACCOUNT_REQUIRED');
    }
    const before = external.length;
    for (const action of ['review-submit', 'order-create', 'admin-orders', 'admin-revenue', 'admin-record-order']) {
      const denied = await call(action, {}, bothCookies, { Origin: 'https://untrusted.example.test' });
      assert.equal(denied.response.status, 403); assert.equal(denied.body.error.code, 'ORIGIN_FORBIDDEN');
    }
    assert.equal(external.length, before, 'CSRF requests fail before GitHub storage');
  });

  await t.test('one software identity can submit only once across browser and signed desktop requests', async () => {
    const input = { rating: 5, content: '很实用 owner@example.test 手机号：13812345678\nCookie: PRIVATE_COOKIE\n<img src=x onerror=alert(1)>', expectedUserId: ownerId, requestId: randomUUID() };
    const changed = await call('review-submit', input, otherCookie);
    assert.equal(changed.response.status, 409); assert.equal(changed.body.error.code, 'ACCOUNT_CHANGED');
    const before = writes;
    const submitted = await call('review-submit', input, bothCookies);
    assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
    const replay = await call('review-submit', input, ownerCookie);
    assert.equal(replay.body.replayed, true); assert.equal(writes, before + 1);
    const desktopDuplicate = await desktopCall('review-submit', { ...input, requestId: randomUUID() });
    assert.equal(desktopDuplicate.response.status, 409); assert.equal(desktopDuplicate.body.error.code, 'REVIEW_ALREADY_EXISTS');
    const forgedDesktop = await call('review-mine', { expectedUserId: ownerId }, '', { Authorization: `Bearer ${desktopToken}` });
    assert.equal(forgedDesktop.response.status, 401); assert.equal(forgedDesktop.body.error.code, 'INVALID_DEVICE_PROOF');
    const mine = await desktopCall('review-mine', { expectedUserId: ownerId });
    assert.equal(mine.body.review.id, submitted.body.review.id);
    const publicResult = await call('reviews-public', { page: 1, pageSize: 1 });
    assert.equal(publicResult.body.reviews.length, 1);
    assert.deepEqual(Object.keys(publicResult.body.reviews[0]).sort(), ['id', 'authorLabel', 'rating', 'content', 'createdAt'].sort());
    assert.deepEqual(publicResult.body.summary, { count: 1, averageRating: 5 });
    const serialized = JSON.stringify(publicResult.body);
    for (const secret of [ownerId, adminId, 'owner@example.test', 'admin@example.test', '13812345678', 'PRIVATE_COOKIE', 'PRIVATE_ACTIVATION_DIGEST', 'PRIVATE_GIFT_DIGEST', 'PRIVATE_AUDIT_REASON', ownerToken, adminToken]) assert.ok(!serialized.includes(secret), secret);
    assert.ok(!JSON.stringify(state.reviews).includes('owner@example.test'), 'authored emails are removed before persistence');
    const page = await call('reviews-public', { pageSize: 51 }); assert.equal(page.response.status, 400); assert.equal(page.body.error.code, 'INVALID_PAGINATION');
  });

  await t.test('cookie selection and draft assertions isolate orders while grants and quoted prices remain unverified', async () => {
    const anonymousOrder = await call('order-create', orderInput()); assert.equal(anonymousOrder.response.status, 401);
    const owner = await call('orders-mine', { expectedUserId: ownerId }, bothCookies);
    assert.equal(owner.response.status, 200); assert.equal(owner.body.orders.length, 1); assert.equal(owner.body.orders[0].status, 'legacy_unverified');
    assert.equal(owner.body.orders[0].amountCents, null); assert.equal(owner.body.orders[0].email, undefined);
    const other = await call('orders-mine', { expectedUserId: otherId }, otherCookie); assert.equal(other.body.total, 0);
    const changed = await call('orders-mine', { expectedUserId: ownerId }, otherCookie); assert.equal(changed.response.status, 409); assert.equal(changed.body.error.code, 'ACCOUNT_CHANGED');
    const before = await call('admin-revenue', {}, bothCookies);
    assert.equal(before.body.revenue.totalCents, 0); assert.equal(before.body.revenue.legacyUnverifiedCount, 1);
    const input = orderInput(), reported = await call('order-create', input, bothCookies);
    assert.equal(reported.response.status, 200, JSON.stringify(reported.body));
    assert.equal(reported.body.order.status, 'pending'); assert.equal(reported.body.order.amountCents, null); assert.equal(reported.body.order.priceCents, 1990);
    const repeat = await call('order-create', { ...input, requestId: randomUUID() }, ownerCookie);
    assert.equal(repeat.body.order.id, reported.body.order.id);
    const after = await call('admin-revenue', {}, adminCookie);
    assert.equal(after.body.revenue.totalCents, 0); assert.equal(after.body.revenue.pendingCount, 1);
    assert.equal(state.users[ownerId].membership.type, 'none');
    for (const action of ['admin-orders', 'admin-revenue', 'admin-record-order']) {
      const browserDenied = await call(action, {}, ownerCookie); assert.equal(browserDenied.response.status, 401);
      const desktopDenied = await desktopCall(action, {}); assert.equal(desktopDenied.response.status, 403);
    }
  });

  await t.test('only confirmed integer cents enter Shanghai-date revenue and uncertain receipt retries stay idempotent', async () => {
    const pending = Object.values(state.orders).find(order => order.status === 'pending');
    const input = receiptInput({ orderId: pending.id, codeId: legacyId });
    commitWithoutReceipt = true;
    const uncertain = await call('admin-record-order', input, bothCookies);
    assert.equal(uncertain.response.status, 503); assert.equal(uncertain.body.ok, false);
    const afterCommit = writes, replay = await call('admin-record-order', input, adminCookie);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.replayed, true); assert.equal(writes, afterCommit);
    assert.equal(replay.body.order.id, pending.id); assert.equal(replay.body.order.status, 'confirmed'); assert.equal(replay.body.order.amountCents, 1800);
    const duplicate = await call('admin-record-order', { ...input, requestId: randomUUID(), orderId: undefined, codeId: undefined }, adminCookie);
    assert.equal(duplicate.response.status, 409); assert.equal(duplicate.body.error.code, 'ORDER_PAYMENT_DUPLICATE');
    const revenue = await call('admin-revenue', { startDate: '2026-01-02', endDate: '2026-01-02' }, bothCookies);
    assert.equal(revenue.response.status, 200); assert.equal(revenue.body.revenue.totalCents, 1800); assert.equal(revenue.body.revenue.confirmedCount, 1);
    assert.deepEqual(revenue.body.revenue.byDay, [{ date: '2026-01-02', totalCents: 1800, count: 1 }]);
    const priorDate = await call('admin-revenue', { startDate: '2026-01-01', endDate: '2026-01-01' }, adminCookie); assert.equal(priorDate.body.revenue.totalCents, 0);
    const adminList = await call('admin-orders', { query: input.transactionReference, status: 'confirmed', page: 1, pageSize: 1 }, bothCookies);
    assert.equal(adminList.body.total, 1); assert.equal(adminList.body.orders[0].email, 'owner@example.test'); assert.equal(adminList.body.orders[0].transactionReference, input.transactionReference);
    const ownerList = await call('orders-mine', { expectedUserId: ownerId }, bothCookies);
    assert.equal(ownerList.body.total, 1, 'a linked historical issue is replaced by its confirmed receipt');
    for (const field of ['email', 'transactionReference', 'reason', 'confirmedBy', 'paymentKey']) assert.equal(ownerList.body.orders[0][field], undefined);
    assert.equal(state.audit.filter(entry => entry.action === 'admin-record-order').length, 1);
    assert.equal(state.users[ownerId].membership.type, 'none', 'receipt accounting does not grant membership');
  });
});
