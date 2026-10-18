import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAccountBridge } from '../lib/browser-account.js';

const ORDER_A = '12345678-1234-1234-1234-123456789abc';
const ORDER_B = '87654321-4321-4321-4321-cba987654321';
const CHECKOUT = 'https://pay.bornforthis.cn/checkout/payment#token=never-save-this-checkout-secret';
const ENDPOINT = 'https://accounts.example.test/api/account';
const account = userId => ({ user: { id: userId }, membership: { active: true, type: 'duration' } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(done => setImmediate(done));

function fixture() {
  const values = new Map(), requests = [];
  let cookieUser = 'user-a', nextOrder = ORDER_A, paymentStatus = 'PENDING', orderStatus = 'pending', fail = '', custom;
  const storage = {
    getItem(key) { if (fail === 'all' || fail === 'get') throw new Error('Storage blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (fail === 'all' || fail === 'set') throw new Error('Storage quota'); values.set(key, value); },
    removeItem(key) { if (fail === 'all' || fail === 'remove') throw new Error('Storage blocked'); values.delete(key); }
  };
  const success = body => Response.json({ ok: true, ...body });
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(request.proof, undefined);
    assert.equal(request.input.client, 'browser');
    if (custom) {
      const response = await custom(request, url);
      if (response) return response;
    }
    if (request.action === 'verify-code') { cookieUser = request.input.email.split('@')[0]; return success({ account: account(cookieUser) }); }
    if (request.action === 'logout') { cookieUser = null; return success({ revoked: true }); }
    if (request.action === 'me') return cookieUser ? success({ account: account(cookieUser) }) : Response.json({ ok: false }, { status: 401 });
    if (request.action === 'payment-create') return success({ order: { id: nextOrder, userId: cookieUser, status: orderStatus }, checkoutUrl: CHECKOUT });
    if (request.action === 'payment-resume') return success({ order: { id: request.input.orderId, userId: cookieUser, status: orderStatus }, checkoutUrl: CHECKOUT });
    if (request.action === 'payment-status') return success({ order: { id: request.input.orderId, userId: cookieUser, status: orderStatus }, paymentStatus });
    throw new Error(`Unexpected test request ${request.action}`);
  };
  const make = (options = {}) => createBrowserAccountBridge({ storage, endpoint: ENDPOINT, fetchImpl, ...options });
  return { bridge: make(), make, requests, values, storage, success,
    order: value => { nextOrder = value; }, status: (value, provider = 'PAID') => { orderStatus = value; paymentStatus = provider; },
    fail: value => { fail = value; }, handler: value => { custom = value; } };
}

test('browser persists only non-authenticating product references and restores them after fresh cookie identity verification', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  const created = await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a', requestId: 'create-request', amount: '19.90' });
  assert.equal(created.ok, true); assert.equal(created.recovery.persistent, true);
  assert.equal(created.result.checkoutUrl, CHECKOUT);
  assert.equal(f.values.size, 1);
  assert.deepEqual(JSON.parse([...f.values.values()][0]), { userId: 'user-a', orderId: ORDER_A });
  assert.equal(JSON.stringify([...f.values]).includes('token'), false);
  assert.equal(JSON.stringify([...f.values]).includes('19.90'), false);
  const restarted = f.make();
  assert.equal((await restarted.getPendingPayment()).result, null, 'Order identity remains hidden until the cookie account is verified');
  await restarted.getAccountState();
  assert.deepEqual((await restarted.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
  assert.equal(f.requests.filter(request => request.action === 'payment-status').length, 0, 'A local recovery read does not write a payment ledger');
});

test('browser recovery and clear remain scoped to the current verified account and service endpoint', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  await f.bridge.verifyAccountCode('user-b@example.test', '123456');
  assert.equal((await f.bridge.getPendingPayment()).result, null);
  assert.equal((await f.bridge.clearPendingPayment({ orderId: ORDER_A, expectedUserId: 'user-a' })).error.code, 'SESSION_CHANGED');
  f.order(ORDER_B); await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-b' });
  await f.bridge.logoutAccount();
  assert.equal((await f.bridge.getPendingPayment()).result, null);
  await f.bridge.verifyAccountCode('user-a@example.test', '123456');
  assert.deepEqual((await f.bridge.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
  const other = f.make({ endpoint: 'https://other-accounts.example.test/api/account' });
  await other.getAccountState();
  assert.equal((await other.getPendingPayment()).result, null);
  assert.equal((await other.clearPendingPayment({ orderId: ORDER_A, expectedUserId: 'user-a' })).result.cleared, false);
  assert.equal(f.values.size, 2);
});

test('an owned status lookup recovers a valid callback order and confirmation keeps it until a matching clear', async () => {
  const f = fixture(); await f.bridge.getAccountState(); f.status('confirmed');
  const status = await f.bridge.commerceRequest('payment-status', { orderId: ORDER_A, expectedUserId: 'user-a' });
  assert.equal(status.result.order.status, 'confirmed'); assert.equal(status.recovery.persistent, true);
  assert.deepEqual((await f.bridge.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
  assert.equal((await f.bridge.clearPendingPayment({ orderId: ORDER_B, expectedUserId: 'user-a' })).result.cleared, false);
  assert.equal((await f.bridge.clearPendingPayment({ orderId: ORDER_A, expectedUserId: 'user-a' })).result.cleared, true);
  assert.equal(f.values.size, 0);
  const restarted = f.make(); await restarted.getAccountState();
  assert.equal((await restarted.getPendingPayment()).result, null);
});

test('foreign, mismatched and malformed status responses never become a durable callback reference', async () => {
  for (const order of [
    { id: ORDER_A, userId: 'user-b', status: 'confirmed' },
    { id: ORDER_B, userId: 'user-a', status: 'confirmed' },
    { id: ORDER_A, status: 'confirmed' },
    { id: ORDER_A, userId: 'user-a', status: 'invalid' },
    { id: CHECKOUT, userId: 'user-a', status: 'pending' }
  ]) {
    const f = fixture(); await f.bridge.getAccountState();
    f.handler(request => request.action === 'payment-status' ? f.success({ order }) : null);
    await f.bridge.commerceRequest('payment-status', { orderId: ORDER_A, expectedUserId: 'user-a' });
    assert.equal((await f.bridge.getPendingPayment()).result, null);
    assert.equal(f.values.size, 0);
  }
});

test('a late old status response cannot overwrite a newly created browser order or resurrect a cleared order', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  const held = deferred();
  f.handler(request => request.action === 'payment-status' ? held.promise : null);
  const oldStatus = f.bridge.commerceRequest('payment-status', { orderId: ORDER_A, expectedUserId: 'user-a' }); await tick();
  f.order(ORDER_B); await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  held.resolve(f.success({ order: { id: ORDER_A, userId: 'user-a', status: 'pending' } })); await oldStatus;
  assert.deepEqual((await f.bridge.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_B });
  const afterClear = deferred();
  f.handler(request => request.action === 'payment-status' ? afterClear.promise : null);
  const checking = f.bridge.commerceRequest('payment-status', { orderId: ORDER_B, expectedUserId: 'user-a' }); await tick();
  await f.bridge.clearPendingPayment({ orderId: ORDER_B, expectedUserId: 'user-a' });
  afterClear.resolve(f.success({ order: { id: ORDER_B, userId: 'user-a', status: 'confirmed' } })); await checking;
  assert.equal((await f.bridge.getPendingPayment()).result, null);
});

test('reverse-arriving creates retain the latest request and account switches discard late payment responses', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  const held = deferred(); let creates = 0;
  f.handler(request => request.action === 'payment-create' && ++creates === 1 ? held.promise : null);
  const older = f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' }); await tick();
  f.order(ORDER_B); const newer = await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  assert.equal(newer.ok, true);
  held.resolve(f.success({ order: { id: ORDER_A, userId: 'user-a', status: 'pending' }, checkoutUrl: CHECKOUT }));
  assert.equal((await older).error.code, 'PAYMENT_REQUEST_SUPERSEDED');
  assert.deepEqual((await f.bridge.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_B });
  const switched = deferred();
  f.handler(request => request.action === 'payment-status' ? switched.promise : null);
  const checking = f.bridge.commerceRequest('payment-status', { orderId: ORDER_A, expectedUserId: 'user-a' }); await tick();
  await f.bridge.verifyAccountCode('user-b@example.test', '123456');
  switched.resolve(f.success({ order: { id: ORDER_A, userId: 'user-a', status: 'pending' } }));
  assert.equal((await checking).ok, false);
  assert.equal((await f.bridge.getPendingPayment()).result, null);
});

test('blocked browser storage retains memory recovery and reports its limitation until persistence recovers', async () => {
  const f = fixture(); await f.bridge.getAccountState(); f.fail('all');
  const created = await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  assert.equal(created.ok, true); assert.equal(created.recovery.persistent, false);
  assert.equal(created.recovery.error.code, 'PAYMENT_RECOVERY_STORAGE_UNAVAILABLE');
  assert.equal(f.values.size, 0);
  const current = await f.bridge.getPendingPayment();
  assert.deepEqual(current.result, { userId: 'user-a', orderId: ORDER_A }); assert.equal(current.recovery.persistent, false);
  const unavailableRestart = f.make(); await unavailableRestart.getAccountState();
  assert.equal((await unavailableRestart.getPendingPayment()).result, null);
  f.fail('');
  assert.equal((await f.bridge.getPendingPayment()).recovery.persistent, true);
  const recoveredRestart = f.make(); await recoveredRestart.getAccountState();
  assert.deepEqual((await recoveredRestart.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
});

test('failed removal retains a previously persisted order, while a memory-only order can complete honestly', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  f.fail('remove');
  const blocked = await f.bridge.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_A });
  assert.equal(blocked.ok, false); assert.equal(blocked.recovery.persistent, false);
  assert.deepEqual((await f.bridge.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
  f.fail(''); assert.equal((await f.bridge.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_A })).result.cleared, true);
  f.fail('all'); await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  const completed = await f.bridge.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_A });
  assert.equal(completed.ok, true); assert.equal(completed.result.cleared, true); assert.equal(completed.recovery.persistent, false);
  assert.equal((await f.bridge.getPendingPayment()).result, null);
});

test('malformed browser storage is ignored and recovery never trusts a stored account identity', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  const key = [...f.values.keys()][0];
  for (const value of ['not-json', JSON.stringify({ userId: 'user-b', orderId: ORDER_A }), JSON.stringify({ userId: 'user-a', orderId: CHECKOUT })]) {
    f.values.set(key, value);
    const restarted = f.make(); await restarted.getAccountState();
    assert.equal((await restarted.getPendingPayment()).result, null);
  }
  f.values.set(key, JSON.stringify({ userId: 'user-a', orderId: ORDER_A, token: 'forged-auth-token', checkoutUrl: CHECKOUT }));
  const restarted = f.make(); await restarted.getAccountState();
  const restored = await restarted.getPendingPayment();
  assert.deepEqual(restored.result, { userId: 'user-a', orderId: ORDER_A });
  assert.equal(restored.state.account.user.id, 'user-a');
  assert.equal(JSON.stringify(f.requests).includes('forged-auth-token'), false);
});

test('a browser identity made temporarily unverified reports retry instead of claiming its pending order is absent', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  f.handler(request => request.action === 'me' ? Response.json({ ok: false, error: { code: 'STORAGE_UNAVAILABLE' } }, { status: 503 }) : null);
  assert.equal((await f.bridge.refreshAccount()).ok, false);
  const uncertain = await f.bridge.getPendingPayment();
  assert.equal(uncertain.ok, false); assert.equal(uncertain.error.code, 'ACCOUNT_UNVERIFIED');
  assert.equal(f.values.size, 1);
  f.handler(null); await f.bridge.refreshAccount();
  assert.deepEqual((await f.bridge.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
});

test('browser resumes the persisted product order after restart without creating or saving checkout credentials', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  const restarted = f.make(); await restarted.getAccountState();
  const resumed = await restarted.commerceRequest('payment-resume', { expectedUserId: 'user-a', orderId: ORDER_A });
  assert.equal(resumed.ok, true); assert.equal(resumed.result.checkoutUrl, CHECKOUT);
  assert.deepEqual((await restarted.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
  assert.equal(f.requests.filter(request => request.action === 'payment-create').length, 1);
  assert.deepEqual(f.requests.find(request => request.action === 'payment-resume').input, { expectedUserId: 'user-a', orderId: ORDER_A, client: 'browser' });
  assert.doesNotMatch([...f.values.values()].join(''), /checkout|token|pay\.bornforthis/);
  await restarted.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_A });
  assert.equal((await restarted.commerceRequest('payment-resume', { expectedUserId: 'user-a', orderId: ORDER_A })).ok, true);
  assert.deepEqual((await restarted.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
});

test('late browser resume cannot expose checkout or overwrite a newer order or resurrect a cleared reference', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  let held = deferred();
  f.handler(request => request.action === 'payment-resume' ? held.promise : null);
  const oldResume = f.bridge.commerceRequest('payment-resume', { expectedUserId: 'user-a', orderId: ORDER_A }); await tick();
  f.order(ORDER_B); await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  held.resolve(f.success({ order: { id: ORDER_A, userId: 'user-a', status: 'pending' }, checkoutUrl: CHECKOUT }));
  assert.equal((await oldResume).error.code, 'PAYMENT_REQUEST_SUPERSEDED');
  assert.deepEqual((await f.bridge.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_B });
  held = deferred();
  const clearedResume = f.bridge.commerceRequest('payment-resume', { expectedUserId: 'user-a', orderId: ORDER_B }); await tick();
  await f.bridge.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_B });
  held.resolve(f.success({ order: { id: ORDER_B, userId: 'user-a', status: 'pending' }, checkoutUrl: CHECKOUT }));
  assert.equal((await clearedResume).error.code, 'PAYMENT_REQUEST_SUPERSEDED');
  assert.equal((await f.bridge.getPendingPayment()).result, null);
});

test('browser resume rejects mismatched responses, replacement tracking and switched sessions before returning checkout', async () => {
  const f = fixture(); await f.bridge.getAccountState();
  for (const order of [{ id: ORDER_B, userId: 'user-a', status: 'pending' }, { id: ORDER_A, userId: 'user-b', status: 'pending' }, { id: ORDER_A, status: 'pending' }]) {
    f.handler(request => request.action === 'payment-resume' ? f.success({ order, checkoutUrl: CHECKOUT }) : null);
    const reply = await f.bridge.commerceRequest('payment-resume', { expectedUserId: 'user-a', orderId: ORDER_A });
    assert.equal(reply.ok, false); assert.equal(reply.error.code, 'PAYMENT_INVALID_ORDER');
    assert.equal((await f.bridge.getPendingPayment()).result, null);
  }
  f.handler(null); f.order(ORDER_B); await f.bridge.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  const otherOrder = await f.bridge.commerceRequest('payment-resume', { expectedUserId: 'user-a', orderId: ORDER_A });
  assert.equal(otherOrder.error.code, 'PAYMENT_REQUEST_SUPERSEDED');
  const held = deferred();
  f.handler(request => request.action === 'payment-resume' ? held.promise : null);
  const switching = f.bridge.commerceRequest('payment-resume', { expectedUserId: 'user-a', orderId: ORDER_B }); await tick();
  await f.bridge.verifyAccountCode('user-b@example.test', '123456');
  held.resolve(f.success({ order: { id: ORDER_B, userId: 'user-a', status: 'pending' }, checkoutUrl: CHECKOUT }));
  assert.equal((await switching).ok, false);
  assert.equal((await f.bridge.getPendingPayment()).result, null);
});

test('browser resume reports blocked recovery storage while retaining its order in the current page', async () => {
  const f = fixture(); await f.bridge.getAccountState(); f.fail('all');
  const resumed = await f.bridge.commerceRequest('payment-resume', { expectedUserId: 'user-a', orderId: ORDER_A });
  assert.equal(resumed.ok, true); assert.equal(resumed.result.checkoutUrl, CHECKOUT);
  assert.equal(resumed.recovery.persistent, false); assert.equal(resumed.recovery.error.code, 'PAYMENT_RECOVERY_STORAGE_UNAVAILABLE');
  assert.deepEqual((await f.bridge.getPendingPayment()).result, { userId: 'user-a', orderId: ORDER_A });
  assert.equal(f.values.size, 0);
  f.fail('');
  assert.equal((await f.bridge.getPendingPayment()).recovery.persistent, true);
  assert.doesNotMatch([...f.values.values()].join(''), /checkout|token|pay\.bornforthis/);
});
