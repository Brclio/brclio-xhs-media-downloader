import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentRecovery } from '../lib/payment-recovery.js';

const orderId = '12345678-1234-1234-1234-123456789abc';
const secondOrderId = '87654321-4321-4321-4321-cba987654321';
const accountState = (userId = 'a', active = false, patch = {}) => ({
  configured: true, authenticated: true, verified: true, status: 'ready',
  account: { user: { id: userId }, membership: { type: active ? 'duration' : 'none', active },
    device: { status: 'authorized' }, features: { 'profile-download': { allowed: active }, 'watermark-free-video': { allowed: active } } },
  ...patch,
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };

function fixture() {
  let clock = 0, serial = 0;
  const timers = new Map(), changes = [], calls = [], confirmed = [];
  const data = { state: accountState(), pending: { userId: 'a', orderId }, status: 'PENDING', orderStatus: 'pending' };
  const bridge = {
    getPendingPayment: async () => {
      calls.push({ action: 'getPendingPayment' });
      return data.pendingWork ? data.pendingWork() : { ok: true, result: data.pending, state: data.state };
    },
    commerceRequest: async (action, input) => {
      calls.push({ action, input });
      if (data.statusWork) return data.statusWork();
      return { ok: true, result: { order: { id: input.orderId, status: data.orderStatus }, paymentStatus: data.status } };
    },
    refreshAccount: async () => {
      calls.push({ action: 'refreshAccount' });
      if (data.refreshWork) return data.refreshWork();
      data.state = accountState('a', true);
      return { ok: true, state: data.state };
    },
    refreshAccountPermissions: async () => {
      calls.push({ action: 'refreshAccountPermissions' });
      if (data.permissionsWork) return data.permissionsWork();
      data.state = accountState('a', true);
      return { ok: true, state: data.state, result: { complete: true, permissions: [
        { feature: 'profile-download', authorized: true }, { feature: 'watermark-free-video', authorized: true },
      ] } };
    },
    clearPendingPayment: async input => {
      calls.push({ action: 'clearPendingPayment', input });
      if (data.clearWork) return data.clearWork(input);
      if (data.pending?.orderId === input.orderId && data.pending.userId === input.expectedUserId) data.pending = null;
      return { ok: true, result: { cleared: true }, state: data.state };
    },
  };
  const recovery = createPaymentRecovery({ bridge, onChange: value => changes.push(value), onConfirmed: value => confirmed.push(value),
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimer: id => timers.delete(id), now: () => clock });
  recovery.setAccount(data.state);
  const advance = async ms => {
    clock += ms;
    const due = [...timers].filter(([, timer]) => timer.at <= clock);
    for (const [id, timer] of due) { if (!timers.delete(id)) continue; timer.callback(); }
    await settle();
  };
  return { recovery, bridge, data, calls, changes, confirmed, timers, advance,
    count: action => calls.filter(call => call.action === action).length,
    last: () => changes.at(-1) };
}

test('an opened checkout waits, polls the same order, and focus checks immediately without another create', async () => {
  const f = fixture();
  f.recovery.track(orderId);
  assert.equal(f.last().phase, 'waiting');
  assert.equal(f.count('payment-status'), 0);
  await f.advance(2999);
  assert.equal(f.count('payment-status'), 0);
  await f.advance(1);
  assert.equal(f.count('payment-status'), 1);
  assert.equal(f.last().phase, 'waiting');
  assert.ok(f.timers.size > 0, 'PENDING continues automatic checks');
  await f.recovery.focus(); await settle();
  assert.equal(f.count('payment-status'), 2, 'focus bypasses the next poll delay');
  assert.deepEqual(f.calls.filter(call => call.action === 'payment-status').map(call => call.input), [
    { orderId, expectedUserId: 'a' }, { orderId, expectedUserId: 'a' },
  ]);
  assert.equal(f.count('payment-create'), 0);
  assert.equal(f.count('refreshAccountPermissions'), 0);
  assert.equal(f.count('clearPendingPayment'), 0);
  f.recovery.dispose(); assert.equal(f.timers.size, 0);
});

test('PAID remains confirming until the business order and fresh account permissions are confirmed', async () => {
  const f = fixture(); f.recovery.track(orderId); f.data.status = 'PAID';
  await f.recovery.check(); await settle();
  assert.equal(f.last().phase, 'confirming');
  assert.equal(f.count('refreshAccountPermissions'), 0);
  assert.equal(f.count('clearPendingPayment'), 0);
  assert.equal(f.confirmed.length, 0);
  assert.ok(f.timers.size > 0, 'webhook lag keeps checking');
  f.data.orderStatus = 'confirmed';
  await f.recovery.focus(); await settle();
  assert.equal(f.count('refreshAccountPermissions'), 1);
  assert.equal(f.data.state.account.features['profile-download'].allowed, true);
  assert.equal(f.data.state.account.features['watermark-free-video'].allowed, true);
  assert.equal(f.count('clearPendingPayment'), 1);
  assert.equal(f.data.pending, null);
  assert.equal(f.last().phase, 'confirmed');
  assert.equal(f.confirmed.length, 1);
  assert.equal(f.timers.size, 0);
  await f.recovery.focus(); await settle();
  assert.equal(f.count('payment-status'), 2, 'completed order no longer polls on focus');
  f.recovery.dispose();
});

test('a pending order restores after a new controller starts and immediately checks only its saved owner', async () => {
  const f = fixture();
  await f.recovery.restore(); await settle();
  assert.equal(f.count('payment-status'), 1);
  assert.equal(f.last().orderId, orderId);
  assert.equal(f.count('payment-create'), 0);
  assert.equal(f.count('clearPendingPayment'), 0);
  f.recovery.dispose();

  const foreign = fixture(); foreign.data.pending = { userId: 'b', orderId: secondOrderId };
  await foreign.recovery.restore(); await settle();
  assert.equal(foreign.count('payment-status'), 0, 'saved order cannot be looked up using another account');
  assert.equal(foreign.count('clearPendingPayment'), 0, 'another account cannot delete the saved order');
  foreign.recovery.dispose();
});

test('concurrent restore and focus share one pending-record read and one order status request', async () => {
  const f = fixture(), pending = deferred(), status = deferred();
  f.data.pendingWork = () => pending.promise;
  f.data.statusWork = () => status.promise;
  const first = f.recovery.restore();
  const second = f.recovery.restore();
  const focus = f.recovery.focus();
  await settle();
  assert.equal(f.count('getPendingPayment'), 1);
  assert.equal(f.count('payment-status'), 0);
  pending.resolve({ ok: true, result: { userId: 'a', orderId }, state: accountState() });
  await settle();
  assert.equal(f.count('payment-status'), 1);
  const duringStatus = f.recovery.restore();
  const focusedDuringStatus = f.recovery.focus();
  await settle();
  assert.equal(f.count('getPendingPayment'), 1, 'restore remains single-flight while its status lookup is still pending');
  assert.equal(f.count('payment-status'), 1);
  status.resolve({ ok: true, result: { order: { id: orderId, status: 'pending' }, paymentStatus: 'PENDING' } });
  await Promise.all([first, second, focus, duringStatus, focusedDuringStatus]); await settle();
  assert.equal(f.last().phase, 'waiting');
  assert.equal(f.last().busy, false);
  f.recovery.dispose();
});

test('restart after an offline identity refresh keeps recovery available for the next focus', async () => {
  const f = fixture(); f.recovery.setAccount(accountState('a', false, { verified: false }));
  f.data.refreshWork = async () => ({ ok: false, state: accountState('a', false, { verified: false }), error: { code: 'SERVICE_UNAVAILABLE' } });
  await f.recovery.restore(); await settle();
  assert.equal(f.count('getPendingPayment'), 0, 'secure pending record is read only after identity is verified');
  assert.equal(f.count('payment-status'), 0);
  assert.ok(f.timers.size > 0);
  delete f.data.refreshWork;
  await f.recovery.focus(); await settle();
  assert.equal(f.count('getPendingPayment'), 1);
  assert.equal(f.count('payment-status'), 1);
  assert.equal(f.last().orderId, orderId);
  f.recovery.dispose();
});

test('temporary pending-record reads recover automatically or immediately on focus', async () => {
  for (const resume of ['timer', 'focus']) {
    const f = fixture();
    f.data.pendingWork = async () => ({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture pending record unavailable' } });
    await f.recovery.restore(); await settle();
    assert.equal(f.count('getPendingPayment'), 1);
    assert.equal(f.count('payment-status'), 0);
    assert.ok(f.timers.size > 0);
    delete f.data.pendingWork;
    if (resume === 'timer') await f.advance(3000);
    else { await f.recovery.focus(); await settle(); }
    assert.equal(f.count('getPendingPayment'), 2);
    assert.equal(f.count('payment-status'), 1);
    assert.equal(f.count('payment-create'), 0);
    f.recovery.dispose();
  }
});

test('automatic, focus and manual checks share a single in-flight request', async () => {
  const f = fixture(), pending = deferred();
  f.data.statusWork = () => pending.promise;
  f.recovery.track(orderId);
  const first = f.recovery.check();
  const second = f.recovery.focus();
  const third = f.recovery.check();
  await f.advance(3000);
  assert.equal(f.count('payment-status'), 1);
  pending.resolve({ ok: true, result: { order: { id: orderId, status: 'pending' }, paymentStatus: 'PENDING' } });
  await Promise.all([first, second, third]); await settle();
  assert.equal(f.count('payment-status'), 1);
  assert.equal(f.last().busy, false);
  f.recovery.dispose();
});

test('temporary status errors retain the order and can recover on focus', async () => {
  const f = fixture(); f.recovery.track(orderId);
  f.data.statusWork = async () => ({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture offline' } });
  await f.recovery.check(); await settle();
  assert.equal(f.last().phase, 'retry');
  assert.equal(f.count('clearPendingPayment'), 0);
  assert.ok(f.timers.size > 0);
  delete f.data.statusWork;
  await f.recovery.focus(); await settle();
  assert.equal(f.last().phase, 'waiting');
  assert.equal(f.count('payment-status'), 2);
  f.recovery.dispose();
});

test('failed or incomplete permission refresh never clears the recoverable order', async () => {
  const f = fixture(); f.recovery.track(orderId); f.data.orderStatus = 'confirmed';
  f.data.permissionsWork = async () => ({ ok: false, error: { message: 'fixture refresh unavailable' }, state: accountState('a') });
  await f.recovery.check(); await settle();
  assert.equal(f.last().phase, 'retry');
  assert.equal(f.count('clearPendingPayment'), 0);
  assert.equal(f.confirmed.length, 0);
  f.data.permissionsWork = async () => ({ ok: true, state: accountState('a', true), result: { complete: false,
    permissions: [{ feature: 'profile-download', authorized: false, error: { code: 'SERVICE_UNAVAILABLE' } }] } });
  await f.recovery.focus(); await settle();
  assert.equal(f.last().phase, 'retry');
  assert.equal(f.count('clearPendingPayment'), 0);
  assert.equal(f.confirmed.length, 0);
  delete f.data.permissionsWork;
  await f.recovery.focus(); await settle();
  assert.equal(f.last().phase, 'confirmed');
  assert.equal(f.count('clearPendingPayment'), 1);
  f.recovery.dispose();
});

test('a successful response with inactive or unverified membership is kept for recovery', async () => {
  for (const fresh of [accountState('a'), accountState('a', true, { verified: false }), accountState('b', true)]) {
    const f = fixture(); f.recovery.track(orderId); f.data.orderStatus = 'confirmed';
    f.data.permissionsWork = async () => ({ ok: true, state: fresh, result: { complete: true, permissions: [] } });
    await f.recovery.check(); await settle();
    assert.equal(f.count('clearPendingPayment'), 0);
    assert.equal(f.confirmed.length, 0);
    assert.notEqual(f.last().phase, 'confirmed');
    f.recovery.dispose();
  }
});

test('clear failure retains a confirmed order for retry and browser fallback refresh is supported', async () => {
  const f = fixture(); delete f.bridge.refreshAccountPermissions;
  f.recovery.track(orderId); f.data.orderStatus = 'confirmed';
  f.data.clearWork = async () => ({ ok: false, error: { message: 'fixture secure storage unavailable' } });
  await f.recovery.check(); await settle();
  assert.equal(f.count('refreshAccount'), 1);
  assert.equal(f.last().phase, 'retry');
  assert.equal(f.confirmed.length, 0);
  assert.deepEqual(f.data.pending, { userId: 'a', orderId });
  delete f.data.clearWork;
  await f.recovery.focus(); await settle();
  assert.equal(f.last().phase, 'confirmed');
  assert.equal(f.confirmed.length, 1);
  f.recovery.dispose();
});

test('switching accounts discards late status and restore responses without refreshing or clearing', async () => {
  const f = fixture(), status = deferred();
  f.data.statusWork = () => status.promise;
  f.recovery.track(orderId);
  const check = f.recovery.check(); await settle();
  f.recovery.setAccount(accountState('b'));
  status.resolve({ ok: true, result: { order: { id: orderId, status: 'confirmed' }, paymentStatus: 'PAID' } });
  await check; await settle();
  assert.equal(f.count('refreshAccountPermissions'), 0);
  assert.equal(f.count('clearPendingPayment'), 0);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.timers.size, 0);
  f.recovery.dispose();

  const restoring = fixture(), saved = deferred();
  restoring.bridge.getPendingPayment = () => saved.promise;
  const restore = restoring.recovery.restore(); await settle();
  restoring.recovery.setAccount(accountState('b'));
  saved.resolve({ ok: true, result: { userId: 'a', orderId }, state: accountState('a') });
  await restore; await settle();
  assert.equal(restoring.count('payment-status'), 0);
  assert.equal(restoring.count('clearPendingPayment'), 0);
  restoring.recovery.dispose();
});

test('an account change during permission refresh cannot clear or announce the old order', async () => {
  const f = fixture(), refreshing = deferred();
  f.recovery.track(orderId); f.data.orderStatus = 'confirmed';
  f.data.permissionsWork = () => refreshing.promise;
  const check = f.recovery.check(); await settle();
  assert.equal(f.count('refreshAccountPermissions'), 1);
  f.recovery.setAccount(accountState('b'));
  refreshing.resolve({ ok: true, state: accountState('a', true), result: { complete: true, permissions: [] } });
  await check; await settle();
  assert.equal(f.count('clearPendingPayment'), 0);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.timers.size, 0);
  f.recovery.dispose();
});

test('an unverified account refreshes first, retains failures and immediately checks after recovery', async () => {
  const f = fixture(); f.recovery.track(orderId);
  f.recovery.setAccount(accountState('a', false, { verified: false }));
  f.data.refreshWork = async () => ({ ok: false, state: accountState('a', false, { verified: false }), error: { code: 'SERVICE_UNAVAILABLE' } });
  await f.recovery.focus(); await f.advance(60_000);
  assert.ok(f.count('refreshAccount') >= 1);
  assert.equal(f.count('payment-status'), 0, 'unverified account cannot query until its refresh succeeds');
  assert.equal(f.count('clearPendingPayment'), 0);
  assert.equal(f.last().phase, 'retry');
  delete f.data.refreshWork;
  await f.recovery.focus(); await settle();
  assert.equal(f.count('payment-status'), 1, 'a recovered identity queries the retained order in the same focus flow');
  assert.equal(f.last().phase, 'waiting');
  f.recovery.dispose();
});

test('logout and disposal prevent new checks and ignore late completion', async () => {
  const loggedOut = fixture(); loggedOut.recovery.track(orderId);
  loggedOut.recovery.setAccount({ configured: true, authenticated: false, verified: false, status: 'signed_out', account: null });
  await loggedOut.recovery.focus(); await loggedOut.advance(60_000);
  assert.equal(loggedOut.count('payment-status'), 0);
  assert.equal(loggedOut.count('clearPendingPayment'), 0);
  loggedOut.recovery.dispose();
  const f = fixture(), late = deferred(); f.data.statusWork = () => late.promise;
  f.recovery.track(orderId); const check = f.recovery.check(); await settle(); f.recovery.dispose();
  late.resolve({ ok: true, result: { order: { id: orderId, status: 'confirmed' }, paymentStatus: 'PAID' } });
  await check; await settle();
  assert.equal(f.count('refreshAccountPermissions'), 0);
  assert.equal(f.count('clearPendingPayment'), 0);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.timers.size, 0);
});

test('closed orders stop polling without granting membership or refreshing permissions', async () => {
  const f = fixture(); f.recovery.track(orderId); f.data.status = 'CLOSED';
  await f.recovery.check(); await settle();
  assert.equal(f.last().phase, 'closed');
  assert.equal(f.count('refreshAccountPermissions'), 0);
  assert.equal(f.count('refreshAccount'), 0);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.timers.size, 0);
  await f.recovery.focus(); await settle();
  assert.equal(f.count('payment-status'), 1);
  f.recovery.dispose();
});

test('mismatched server order identities cannot refresh rights or clear the saved reference', async () => {
  for (const order of [{ id: secondOrderId, status: 'confirmed' }, { id: orderId, userId: 'b', status: 'confirmed' }]) {
    const f = fixture(); f.recovery.track(orderId);
    f.data.statusWork = async () => ({ ok: true, result: { order, paymentStatus: 'PAID' } });
    await f.recovery.check(); await settle();
    assert.equal(f.last().phase, 'retry');
    assert.equal(f.count('refreshAccountPermissions'), 0);
    assert.equal(f.count('clearPendingPayment'), 0);
    assert.equal(f.confirmed.length, 0);
    f.recovery.dispose();
  }
});

test('background polling pauses after its bounded window and focus resumes immediately', async () => {
  const f = fixture(); f.recovery.track(orderId);
  await f.advance(10 * 60_000 + 1);
  assert.equal(f.count('payment-status'), 1);
  assert.equal(f.timers.size, 0);
  await f.recovery.focus(); await settle();
  assert.equal(f.count('payment-status'), 2);
  assert.ok(f.timers.size > 0);
  f.recovery.dispose();
});
