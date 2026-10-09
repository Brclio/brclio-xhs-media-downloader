import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GithubStateStore, emptyState, validateState } from '../server/auth/store.js';
import { createAccountService } from '../server/auth/service.js';
import { digest } from '../server/auth/crypto.js';
import { readConfig } from '../server/auth/config.js';

const clock = Date.parse('2026-10-09T12:00:00Z');
function fixture() {
  const config = readConfig({ AUTH_SECRET_PEPPER: 'commerce-test-only-'.repeat(4), AUTH_ADMIN_EMAILS: 'admin@example.test' });
  let state = emptyState(), version = 1, commitThenThrow = false, conflicts = 0, beforeNextPut = null;
  const users = ['owner', 'other', 'admin'].map(label => ({ id: randomUUID(), email: `${label}@example.test`, createdAt: new Date(clock).toISOString(), membership: { type: 'none', startsAt: null, expiresAt: null } }));
  const sessions = users.map((user, index) => {
    state.users[user.id] = user;
    const token = String(index + 1).repeat(43), client = index === 2 ? 'admin' : 'browser';
    state.sessions[digest(config.pepper, 'session', token)] = { id: randomUUID(), userId: user.id, client, revokedAt: null };
    return { token, client, user };
  });
  const fetchImpl = async (url, options) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (options.method === 'GET') return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    const body = JSON.parse(options.body);
    if (beforeNextPut) { const change = beforeNextPut; beforeNextPut = null; change(state); version++; }
    if (body.sha !== String(version)) { conflicts++; return Response.json({}, { status: 409 }); }
    state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); version++;
    if (commitThenThrow) { commitThenThrow = false; throw Error('lost receipt'); }
    return Response.json({ content: { sha: String(version) } });
  };
  const store = () => new GithubStateStore({ owner: 'fake', repo: 'private', token: 'test', fetchImpl, delay: async () => {} });
  const instance = (storage = store()) => createAccountService({ store: storage, config, mailer: {}, now: () => clock });
  const call = (action, input = {}, session = sessions[0], service = instance()) => service.execute({ action, input, token: session?.token || '', client: session?.client });
  const userInput = (input = {}, session = sessions[0]) => ({ requestId: randomUUID(), expectedUserId: session.user.id, ...input });
  const record = (input = {}) => ({ requestId: randomUUID(), userId: users[0].id, planId: 'monthly', amountCents: 1990, paymentMethod: 'wechat', paidAt: '2026-10-09T01:00:00+08:00', transactionReference: randomUUID(), reason: '核实真实支付凭证', ...input });
  return { sessions, users, store, instance, call, userInput, record, config, set uncertain(value) { commitThenThrow = value; }, set beforeNextPut(value) { beforeNextPut = value; }, get state() { return state; }, get conflicts() { return conflicts; } };
}

test('software review requires a user session, persists once across browser and desktop, and anonymous views disclose no identity', async () => {
  const f = fixture(), input = f.userInput({ rating: 5, content: '下载很方便 owner@example.test 电话：13812345678 激活码：Brclio-1234567890ABCDEF1234567890ABCDEF12345678AB' });
  await assert.rejects(f.call('review-submit', input, null), { code: 'ACCOUNT_REQUIRED' });
  await assert.rejects(f.call('review-submit', input, f.sessions[2]), { code: 'USER_SESSION_REQUIRED' });
  await assert.rejects(f.call('review-submit', { ...input, expectedUserId: f.users[1].id }), { code: 'ACCOUNT_CHANGED' });
  const created = await f.call('review-submit', input);
  assert.equal(created.review.rating, 5); assert.match(created.review.authorLabel, /^用户 [A-F0-9]{6}$/);
  assert.equal((await f.call('review-submit', input)).replayed, true);
  await assert.rejects(f.call('review-submit', { ...input, requestId: randomUUID() }), { code: 'REVIEW_ALREADY_EXISTS' });
  await assert.rejects(f.call('review-submit', { ...input, content: '变更原评价内容' }), { code: 'REQUEST_ID_REUSED' });
  assert.equal((await f.call('review-mine')).review.id, created.review.id);
  assert.equal((await f.call('review-mine', {}, f.sessions[1])).review, null);
  const publicResult = await f.call('reviews-public', {}, null);
  assert.deepEqual(publicResult.summary, { count: 1, averageRating: 5 });
  const serialized = JSON.stringify(publicResult);
  for (const secret of ['owner@example.test', f.users[0].id, '13812345678', 'Brclio-1234', 'email', 'userId']) assert.ok(!serialized.includes(secret), secret);
  assert.ok(!JSON.stringify(f.state.reviews).includes('owner@example.test'), 'only redacted text is persisted');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const token = 'd'.repeat(43);
  f.state.sessions[digest(f.config.pepper, 'session', token)] = { userId: f.users[0].id, client: 'desktop', publicKey: publicKey.export({ format: 'pem', type: 'spki' }) };
  const desktopInput = { ...input, requestId: randomUUID() }, nonce = randomUUID();
  const proof = { timestamp: clock, nonce, signature: sign(null, Buffer.from(`review-submit\n${clock}\n${nonce}\n${JSON.stringify(desktopInput)}\n${token}`), privateKey).toString('base64') };
  await assert.rejects(f.instance().execute({ action: 'review-submit', input: desktopInput, token, client: 'desktop' }), { code: 'INVALID_DEVICE_PROOF' });
  await assert.rejects(f.instance().execute({ action: 'review-submit', input: desktopInput, token, client: 'desktop', proof }), { code: 'REVIEW_ALREADY_EXISTS' });
});

test('review uniqueness survives CAS races, and a lost write receipt recovers with the same request', async () => {
  const f = fixture(), input = f.userInput({ rating: 4, content: '网页和客户端使用顺手' });
  const results = await Promise.allSettled([f.call('review-submit', input), f.call('review-submit', { ...input, requestId: randomUUID() })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVIEW_ALREADY_EXISTS');
  assert.equal(Object.keys(f.state.reviews).length, 1); assert.ok(f.conflicts >= 1);
  const g = fixture(); g.uncertain = true;
  const retry = g.userInput({ rating: 3, content: '希望继续改进下载体验' });
  await assert.rejects(g.call('review-submit', retry), { code: 'STORAGE_WRITE_UNCERTAIN' });
  assert.equal((await g.call('review-submit', retry)).replayed, true);
  assert.equal(Object.keys(g.state.reviews).length, 1);
  const h = fixture(), same = h.userInput({ rating: 5, content: '重试提交只有一条记录' });
  const replay = await Promise.all([h.call('review-submit', same), h.call('review-submit', same)]);
  assert.deepEqual(replay.map(result => result.replayed).sort(), [false, true]);
});

test('reviews enforce bounded ratings and text and server pagination', async () => {
  const f = fixture();
  for (const patch of [{ rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: '5' }, { content: '短' }, { content: '中'.repeat(1001) }, { content: '控制符\u0000禁止' }]) {
    await assert.rejects(f.call('review-submit', f.userInput({ rating: 5, content: '正常的评论内容', ...patch })), { code: 'INVALID_REVIEW' });
  }
  await f.call('review-submit', f.userInput({ rating: 5, content: '这是第一位用户的评价' }));
  await f.call('review-submit', f.userInput({ rating: 3, content: '这是另一位用户的评价' }, f.sessions[1]), f.sessions[1]);
  const page = await f.call('reviews-public', { page: 2, pageSize: 1 }, null);
  assert.equal(page.reviews.length, 1); assert.equal(page.totalPages, 2); assert.deepEqual(page.summary, { count: 2, averageRating: 4 });
  for (const input of [{ page: 0 }, { pageSize: 51 }, { page: '1' }, { pageSize: -1 }]) await assert.rejects(f.call('reviews-public', input, null), { code: 'INVALID_PAGINATION' });
});

test('commerce reauthenticates after a CAS conflict and read actions reject a different draft account', async () => {
  const f = fixture();
  for (const action of ['review-mine', 'orders-mine']) await assert.rejects(f.call(action, { expectedUserId: f.users[1].id }), { code: 'ACCOUNT_CHANGED' });
  f.beforeNextPut = state => { state.sessions[digest(f.config.pepper, 'session', f.sessions[0].token)].revokedAt = new Date(clock).toISOString(); };
  await assert.rejects(f.call('review-submit', f.userInput({ rating: 5, content: '会话撤销不能继续发布评价' })), { code: 'SESSION_REVOKED' });
  assert.equal(Object.keys(f.state.reviews).length, 0);
  const g = fixture();
  g.beforeNextPut = state => { state.sessions[digest(g.config.pepper, 'session', g.sessions[2].token)].revokedAt = new Date(clock).toISOString(); };
  await assert.rejects(g.call('admin-record-order', g.record(), g.sessions[2]), { code: 'SESSION_REVOKED' });
  assert.equal(Object.keys(g.state.orders).length, 0); assert.equal(g.state.audit.length, 0);
});

test('orders list only the owner and pending reports never count as money or grant membership', async () => {
  const f = fixture(), input = f.userInput({ planId: 'monthly', paymentMethod: 'wechat', amountCents: 1 });
  const created = await f.call('order-create', input);
  assert.equal(created.order.priceCents, 1990); assert.equal(created.order.amountCents, null); assert.equal(created.order.status, 'pending');
  assert.equal((await f.call('order-create', input)).order.id, created.order.id);
  assert.equal((await f.call('order-create', { ...input, requestId: randomUUID() })).order.id, created.order.id, 'duplicate pending reports share one order');
  assert.equal((await f.call('orders-mine')).total, 1);
  assert.equal((await f.call('orders-mine', {}, f.sessions[1])).total, 0);
  const revenue = (await f.call('admin-revenue', {}, f.sessions[2])).revenue;
  assert.equal(revenue.totalCents, 0); assert.equal(revenue.pendingCount, 1);
  assert.equal(f.state.users[f.users[0].id].membership.type, 'none');
  await assert.rejects(f.call('admin-orders'), { code: 'FORBIDDEN' });
  await assert.rejects(f.call('admin-revenue'), { code: 'FORBIDDEN' });
  await assert.rejects(f.call('admin-record-order', f.record()), { code: 'FORBIDDEN' });
  await assert.rejects(f.call('order-create', { ...input, expectedUserId: f.users[1].id }), { code: 'ACCOUNT_CHANGED' });
  for (const patch of [{ planId: 'permanent' }, { paymentMethod: 'other' }]) await assert.rejects(f.call('order-create', f.userInput({ planId: 'monthly', paymentMethod: 'wechat', ...patch })), { code: 'INVALID_ORDER' });
});

test('administrator records actual receipts exactly once, audits confirmation and rejects duplicate external receipts', async () => {
  const f = fixture(), pending = (await f.call('order-create', f.userInput({ planId: 'monthly', paymentMethod: 'wechat' }))).order;
  const input = f.record({ orderId: pending.id, amountCents: 1800 });
  const created = await f.call('admin-record-order', input, f.sessions[2]);
  assert.equal(created.order.id, pending.id); assert.equal(created.order.amountCents, 1800); assert.equal(created.order.priceCents, 1990);
  assert.equal((await f.call('admin-record-order', input, f.sessions[2])).replayed, true);
  assert.equal(f.state.audit.length, 1); assert.equal(f.state.audit[0].before.status, 'pending'); assert.equal(f.state.audit[0].after.status, 'confirmed');
  await assert.rejects(f.call('admin-record-order', { ...input, requestId: randomUUID() }, f.sessions[2]), { code: 'ORDER_PAYMENT_DUPLICATE' });
  await assert.rejects(f.call('admin-record-order', { ...input, requestId: randomUUID(), transactionReference: randomUUID() }, f.sessions[2]), { code: 'ORDER_ALREADY_CONFIRMED' });
  const owner = (await f.call('orders-mine')).orders[0];
  assert.equal(owner.amountCents, 1800); assert.equal(owner.transactionReference, undefined); assert.equal(owner.reason, undefined); assert.equal(owner.email, undefined);
  const admin = await f.call('admin-orders', { query: input.transactionReference, status: 'confirmed' }, f.sessions[2]);
  assert.equal(admin.total, 1); assert.equal(admin.orders[0].email, f.users[0].email); assert.equal(admin.orders[0].transactionReference, input.transactionReference);
  assert.equal((await f.call('admin-revenue', {}, f.sessions[2])).revenue.totalCents, 1800);
  assert.equal(f.state.users[f.users[0].id].membership.type, 'none', 'recording receipts never implicitly grants benefits');
});

test('receipt uniqueness also holds under concurrent admin writes and lost write receipts', async () => {
  const f = fixture(), input = f.record();
  const results = await Promise.allSettled([f.call('admin-record-order', input, f.sessions[2]), f.call('admin-record-order', { ...input, requestId: randomUUID() }, f.sessions[2])]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ORDER_PAYMENT_DUPLICATE');
  assert.equal(Object.keys(f.state.orders).length, 1);
  const g = fixture(), retry = g.record(); g.uncertain = true;
  await assert.rejects(g.call('admin-record-order', retry, g.sessions[2]), { code: 'STORAGE_WRITE_UNCERTAIN' });
  assert.equal((await g.call('admin-record-order', retry, g.sessions[2])).replayed, true);
  assert.equal((await g.call('admin-revenue', {}, g.sessions[2])).revenue.totalCents, 1990);
});

test('revenue uses exact cents and Shanghai payment dates including both edges of a date range', async () => {
  const f = fixture();
  for (const patch of [
    { paidAt: '2026-10-08T15:59:59Z', amountCents: 111 },
    { paidAt: '2026-10-08T16:00:00Z', amountCents: 222 },
    { paidAt: '2026-10-09T15:59:59+08:00', amountCents: 333, paymentMethod: 'alipay', planId: 'daily' },
  ]) await f.call('admin-record-order', f.record(patch), f.sessions[2]);
  const revenue = (await f.call('admin-revenue', { startDate: '2026-10-09', endDate: '2026-10-09' }, f.sessions[2])).revenue;
  assert.equal(revenue.totalCents, 555); assert.equal(revenue.confirmedCount, 2); assert.equal(revenue.timeZone, 'Asia/Shanghai');
  assert.deepEqual(revenue.byDay, [{ date: '2026-10-09', totalCents: 555, count: 2 }]);
  assert.equal(revenue.byPlan.find(plan => plan.planId === 'monthly').totalCents, 222);
  assert.equal(revenue.byPaymentMethod.find(method => method.paymentMethod === 'alipay').totalCents, 333);
  assert.equal((await f.call('admin-orders', { startDate: '2026-10-09', endDate: '2026-10-09', pageSize: 1 }, f.sessions[2])).totalPages, 2);
  for (const input of [{ startDate: '2026-02-30' }, { endDate: '2026-13-01' }, { startDate: '2026-10-10', endDate: '2026-10-09' }]) await assert.rejects(f.call('admin-revenue', input, f.sessions[2]), { code: 'INVALID_DATE_RANGE' });
});

test('gifts, redemptions and quoted legacy prices are never counted as receipts; legacy confirmation links once', async () => {
  const f = fixture(), id = randomUUID(), giftId = randomUUID();
  f.state.codes[id] = { id, recipientId: f.users[0].id, planId: 'monthly', planName: '月付', priceCents: 1990, createdAt: '2026-09-01T00:00:00Z', status: 'used', redeemedBy: f.users[0].id, digest: 'private-code-digest' };
  f.state.codes[giftId] = { id: giftId, type: 'permanent', createdAt: '2026-09-01T00:00:00Z', status: 'used', redeemedBy: f.users[0].id };
  const legacy = (await f.call('orders-mine')).orders;
  assert.equal(legacy.length, 1); assert.equal(legacy[0].status, 'legacy_unverified'); assert.equal(legacy[0].amountCents, null);
  assert.ok(!JSON.stringify(legacy).includes('digest'));
  assert.equal((await f.call('admin-revenue', {}, f.sessions[2])).revenue.totalCents, 0);
  const confirmed = await f.call('admin-record-order', f.record({ orderId: `legacy-${id}` }), f.sessions[2]);
  assert.equal(confirmed.order.codeId, id);
  assert.equal((await f.call('orders-mine')).total, 1, 'linked legacy record is replaced by its receipt');
  assert.equal((await f.call('admin-revenue', {}, f.sessions[2])).revenue.legacyUnverifiedCount, 0);
  await assert.rejects(f.call('admin-record-order', f.record({ codeId: id }), f.sessions[2]), { code: 'ORDER_CODE_DUPLICATE' });
  await assert.rejects(f.call('admin-record-order', f.record({ userId: f.users[1].id, codeId: id }), f.sessions[2]), { code: 'ORDER_CODE_MISMATCH' });
});

test('administrator receipts reject invalid amounts, missing evidence, mismatched users and unsafe dates', async () => {
  const f = fixture();
  for (const patch of [{ amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.99 }, { amountCents: '1990' }, { amountCents: Number.MAX_SAFE_INTEGER }, { paymentMethod: 'cash' }, { planId: 'invalid' }]) await assert.rejects(f.call('admin-record-order', f.record(patch), f.sessions[2]), { code: 'INVALID_ORDER' });
  for (const patch of [{ transactionReference: '' }, { transactionReference: '12' }, { transactionReference: 'x\nabc' }]) await assert.rejects(f.call('admin-record-order', f.record(patch), f.sessions[2]), { code: 'PAYMENT_REFERENCE_REQUIRED' });
  for (const patch of [{ paidAt: 'invalid' }, { paidAt: '2027-01-01T00:00:00Z' }, { paidAt: '2026-10-09T01:00:00' }]) await assert.rejects(f.call('admin-record-order', f.record(patch), f.sessions[2]), { code: 'INVALID_PAID_AT' });
  await assert.rejects(f.call('admin-record-order', f.record({ reason: '短' }), f.sessions[2]), { code: 'REASON_REQUIRED' });
  await assert.rejects(f.call('admin-record-order', f.record({ userId: 'missing' }), f.sessions[2]), { code: 'USER_NOT_FOUND' });
  const pending = (await f.call('order-create', f.userInput({ planId: 'monthly', paymentMethod: 'wechat' }))).order;
  await assert.rejects(f.call('admin-record-order', f.record({ orderId: pending.id, userId: f.users[1].id }), f.sessions[2]), { code: 'ORDER_NOT_FOUND' });
  assert.equal(Object.values(f.state.orders).filter(order => order.status === 'confirmed').length, 0);
});

test('confirmed receipts can link a subsequently issued targeted code without changing money or duplicating purchase history', async () => {
  const f = fixture();
  const pending = (await f.call('order-create', f.userInput({ planId: 'monthly', paymentMethod: 'wechat' }))).order;
  const confirmed = (await f.call('admin-record-order', f.record({ orderId: pending.id, amountCents: 1800 }), f.sessions[2])).order;
  const issued = await f.call('admin-generate-codes', { userId: f.users[0].id, planId: 'monthly', count: 1, reason: '确认收款后发放定向激活码', requestId: randomUUID() }, f.sessions[2]);
  assert.equal((await f.call('orders-mine')).total, 2, 'unlinked issuance remains a separate unverified historical record');
  const before = structuredClone(f.state.orders[confirmed.id]);
  const input = { orderId: confirmed.id, codeId: issued.codes[0].id, reason: '关联此订单付款后发放的激活码', requestId: randomUUID(), amountCents: 999999, paidAt: '2020-01-01T00:00:00Z', transactionReference: 'ignored-override' };
  const linked = await f.call('admin-link-order-code', input, f.sessions[2]);
  assert.equal(linked.order.codeId, issued.codes[0].id);
  assert.deepEqual({ ...f.state.orders[confirmed.id], codeId: before.codeId }, before, 'all original receipt fields are immutable');
  const orders = await f.call('orders-mine'); assert.equal(orders.total, 1); assert.equal(orders.orders[0].id, confirmed.id);
  const revenue = (await f.call('admin-revenue', {}, f.sessions[2])).revenue;
  assert.equal(revenue.totalCents, 1800); assert.equal(revenue.confirmedCount, 1); assert.equal(revenue.legacyUnverifiedCount, 0);
  const audit = f.state.audit.filter(entry => entry.action === 'admin-link-order-code');
  assert.equal(audit.length, 1); assert.equal(audit[0].before.codeId, null); assert.equal(audit[0].after.codeId, issued.codes[0].id);
  assert.equal(audit[0].reason, input.reason);
  const replay = await f.call('admin-link-order-code', input, f.sessions[2]); assert.equal(replay.replayed, true);
  assert.equal(f.state.audit.filter(entry => entry.action === 'admin-link-order-code').length, 1);
  await f.call('redeem', { code: issued.codes[0].code, requestId: randomUUID() });
  assert.equal((await f.call('orders-mine')).total, 1, 'redemption retains one purchase history record');
  assert.equal((await f.call('admin-revenue', {}, f.sessions[2])).revenue.totalCents, 1800);
});

test('post-payment code links enforce administrator scope, confirmed state, ownership and plan without overwriting a link', async () => {
  const f = fixture(), confirmed = (await f.call('admin-record-order', f.record(), f.sessions[2])).order;
  const issued = await f.call('admin-generate-codes', { userId: f.users[0].id, planId: 'monthly', count: 1, reason: '测试收款后定向发码', requestId: randomUUID() }, f.sessions[2]);
  const codeId = issued.codes[0].id, originalCode = structuredClone(f.state.codes[codeId]);
  const input = { orderId: confirmed.id, codeId, reason: '核对已收款订单后关联激活码', requestId: randomUUID() };
  await assert.rejects(f.call('admin-link-order-code', input), { code: 'FORBIDDEN' });
  await assert.rejects(f.call('admin-link-order-code', { ...input, reason: '短' }, f.sessions[2]), { code: 'REASON_REQUIRED' });
  for (const patch of [{ orderId: null }, { codeId: {} }, { orderId: `legacy-${codeId}` }]) await assert.rejects(f.call('admin-link-order-code', { ...input, ...patch }, f.sessions[2]), { code: 'INVALID_ORDER' });
  await assert.rejects(f.call('admin-link-order-code', { ...input, orderId: randomUUID() }, f.sessions[2]), { code: 'ORDER_NOT_FOUND' });
  const pending = (await f.call('order-create', f.userInput({ planId: 'daily', paymentMethod: 'wechat' }))).order;
  await assert.rejects(f.call('admin-link-order-code', { ...input, orderId: pending.id }, f.sessions[2]), { code: 'ORDER_NOT_CONFIRMED' });
  for (const patch of [{ status: 'void' }, { recipientId: f.users[1].id }, { redeemedBy: f.users[1].id }, { planId: 'yearly' }, { recipientId: null, redeemedBy: null }]) {
    f.state.codes[codeId] = { ...originalCode, ...patch };
    await assert.rejects(f.call('admin-link-order-code', input, f.sessions[2]), { code: 'ORDER_CODE_MISMATCH' });
  }
  f.state.codes[codeId] = originalCode;
  await f.call('admin-link-order-code', input, f.sessions[2]);
  await assert.rejects(f.call('admin-link-order-code', { ...input, requestId: randomUUID() }, f.sessions[2]), { code: 'ORDER_ALREADY_LINKED' });
  const otherOrder = (await f.call('admin-record-order', f.record(), f.sessions[2])).order;
  await assert.rejects(f.call('admin-link-order-code', { ...input, orderId: otherOrder.id, requestId: randomUUID() }, f.sessions[2]), { code: 'ORDER_CODE_DUPLICATE' });
  assert.equal(f.state.orders[otherOrder.id].codeId, null);
});

test('concurrent code links, receipt confirmations and lost responses preserve single-code ownership and one link audit', async () => {
  const f = fixture(), first = (await f.call('admin-record-order', f.record(), f.sessions[2])).order;
  const pending = (await f.call('order-create', f.userInput({ planId: 'monthly', paymentMethod: 'wechat' }))).order;
  const { codes: [code] } = await f.call('admin-generate-codes', { userId: f.users[0].id, planId: 'monthly', count: 1, reason: '测试并发竞争同一激活码', requestId: randomUUID() }, f.sessions[2]);
  const link = { orderId: first.id, codeId: code.id, reason: '将已发激活码关联收款订单', requestId: randomUUID() };
  const raced = await Promise.allSettled([
    f.call('admin-link-order-code', link, f.sessions[2]),
    f.call('admin-record-order', f.record({ orderId: pending.id, codeId: code.id }), f.sessions[2]),
  ]);
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(raced.find(result => result.status === 'rejected').reason.code, 'ORDER_CODE_DUPLICATE');
  assert.equal(Object.values(f.state.orders).filter(order => order.codeId === code.id).length, 1);
  const g = fixture(), order = (await g.call('admin-record-order', g.record(), g.sessions[2])).order;
  const { codes: [gCode] } = await g.call('admin-generate-codes', { userId: g.users[0].id, planId: 'monthly', count: 1, reason: '测试同请求关联并发重试', requestId: randomUUID() }, g.sessions[2]);
  const retry = { orderId: order.id, codeId: gCode.id, reason: '发码后关联已确认的收款订单', requestId: randomUUID() };
  const duplicates = await Promise.all([g.call('admin-link-order-code', retry, g.sessions[2]), g.call('admin-link-order-code', retry, g.sessions[2])]);
  assert.deepEqual(duplicates.map(result => result.replayed).sort(), [false, true]);
  assert.equal(g.state.audit.filter(entry => entry.action === 'admin-link-order-code').length, 1);
  const h = fixture(), hOrder = (await h.call('admin-record-order', h.record(), h.sessions[2])).order;
  const { codes: [hCode] } = await h.call('admin-generate-codes', { userId: h.users[0].id, planId: 'monthly', count: 1, reason: '测试关联写入结果不确定恢复', requestId: randomUUID() }, h.sessions[2]);
  const uncertain = { orderId: hOrder.id, codeId: hCode.id, reason: '恢复已保存的激活码关联结果', requestId: randomUUID() };
  h.uncertain = true;
  await assert.rejects(h.call('admin-link-order-code', uncertain, h.sessions[2]), { code: 'STORAGE_WRITE_UNCERTAIN' });
  assert.equal((await h.call('admin-link-order-code', uncertain, h.sessions[2])).replayed, true);
  assert.equal(h.state.audit.filter(entry => entry.action === 'admin-link-order-code').length, 1);
  assert.equal((await h.call('orders-mine')).total, 1);
  const j = fixture(), jOrder = (await j.call('admin-record-order', j.record(), j.sessions[2])).order;
  const codes = [];
  for (let index = 0; index < 2; index++) codes.push((await j.call('admin-generate-codes', { userId: j.users[0].id, planId: 'monthly', count: 1, reason: '测试同订单并发关联不同激活码', requestId: randomUUID() }, j.sessions[2])).codes[0]);
  const differentCodes = await Promise.allSettled(codes.map(code => j.call('admin-link-order-code', { orderId: jOrder.id, codeId: code.id, reason: '同订单只能关联一个有效激活码', requestId: randomUUID() }, j.sessions[2])));
  assert.equal(differentCodes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(differentCodes.find(result => result.status === 'rejected').reason.code, 'ORDER_ALREADY_LINKED');
  assert.equal(j.state.audit.filter(entry => entry.action === 'admin-link-order-code').length, 1);
});

test('voided unlinked targeted codes are not orders while linked confirmed receipts survive a later code void', async () => {
  const f = fixture();
  const issue = async () => (await f.call('admin-generate-codes', { userId: f.users[0].id, planId: 'monthly', count: 1, reason: '测试未收款定向码作废展示', requestId: randomUUID() }, f.sessions[2])).codes[0];
  const unlinked = await issue();
  assert.equal((await f.call('orders-mine')).total, 1);
  await f.call('admin-void-code', { codeId: unlinked.id, reason: '未收款取消发码', requestId: randomUUID() }, f.sessions[2]);
  assert.equal((await f.call('orders-mine')).total, 0);
  assert.equal((await f.call('admin-revenue', {}, f.sessions[2])).revenue.legacyUnverifiedCount, 0);
  const confirmed = (await f.call('admin-record-order', f.record(), f.sessions[2])).order, linked = await issue();
  await f.call('admin-link-order-code', { orderId: confirmed.id, codeId: linked.id, reason: '关联已收款后发出的有效激活码', requestId: randomUUID() }, f.sessions[2]);
  await f.call('admin-void-code', { codeId: linked.id, reason: '作废激活码不改变已收款事实', requestId: randomUUID() }, f.sessions[2]);
  const orders = await f.call('orders-mine');
  assert.equal(orders.total, 1); assert.equal(orders.orders[0].status, 'confirmed'); assert.equal(orders.orders[0].codeId, linked.id);
  assert.equal((await f.call('admin-revenue', {}, f.sessions[2])).revenue.totalCents, 1990);
});

test('schema v1 migrates commerce fields additively and rejects invalid or duplicated ledger states', () => {
  const state = emptyState(); delete state.reviews; delete state.orders;
  assert.deepEqual(validateState(state).reviews, {}); assert.deepEqual(state.orders, {}); assert.equal(state.schemaVersion, 1);
  for (const key of ['reviews', 'orders']) assert.throws(() => validateState({ ...emptyState(), [key]: [] }), { code: 'STORAGE_INVALID' });
  const id = randomUUID();
  const order = { id, userId: randomUUID(), planId: 'monthly', priceCents: 1990, status: 'pending', paymentMethod: 'wechat', createdAt: new Date(clock).toISOString(), amountCents: 1990, paidAt: null, confirmedAt: null };
  assert.throws(() => validateState({ ...emptyState(), orders: { [id]: order } }), { code: 'STORAGE_INVALID' });
});

test('SQLite preserves commerce records after restart and races independent connections on one review', async () => {
  const { SqliteStateStore } = await import('../server/auth/sqlite-store.js');
  const directory = mkdtempSync(join(tmpdir(), 'brclio-commerce-')), path = join(directory, 'accounts.sqlite');
  const f = fixture(); let first, second;
  try {
    first = new SqliteStateStore({ path });
    const old = structuredClone(f.state); delete old.orders; delete old.reviews;
    await first.importSnapshot({ state: old, parts: [] });
    second = new SqliteStateStore({ path });
    const a = f.instance(first), b = f.instance(second), input = f.userInput({ rating: 5, content: 'SQLite 并发只保存一条评价' });
    const results = await Promise.allSettled([f.call('review-submit', input, f.sessions[0], a), f.call('review-submit', { ...input, requestId: randomUUID() }, f.sessions[0], b)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const record = f.record(), order = (await f.call('admin-record-order', record, f.sessions[2], a)).order;
    const { codes: [code] } = await f.call('admin-generate-codes', { userId: f.users[0].id, planId: 'monthly', count: 1, reason: 'SQLite 收款后发码再关联', requestId: randomUUID() }, f.sessions[2], a);
    const link = { orderId: order.id, codeId: code.id, reason: 'SQLite 保留原订单收款证据关联激活码', requestId: randomUUID() };
    await f.call('admin-link-order-code', link, f.sessions[2], a);
    first.close(); first = new SqliteStateStore({ path });
    const restarted = f.instance(first);
    assert.equal((await f.call('review-mine', {}, f.sessions[0], restarted)).review.rating, 5);
    assert.equal((await f.call('admin-revenue', {}, f.sessions[2], restarted)).revenue.totalCents, 1990);
    assert.equal((await f.call('admin-record-order', record, f.sessions[2], restarted)).replayed, true);
    assert.equal((await f.call('admin-link-order-code', link, f.sessions[2], restarted)).replayed, true);
    const orders = await f.call('orders-mine', {}, f.sessions[0], restarted);
    assert.equal(orders.total, 1); assert.equal(orders.orders[0].codeId, code.id);
  } finally { first?.close(); second?.close(); rmSync(directory, { recursive: true, force: true }); }
});
