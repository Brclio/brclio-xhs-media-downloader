import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentRecovery } from '../lib/payment-recovery.js';

const ORDER = '12345678-1234-1234-1234-123456789abc';
const state = (patch = {}) => ({ authenticated: true, verified: true, status: 'ready',
  account: { user: { id: 'member-a' }, membership: { type: 'duration', active: true } }, ...patch });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fixture() {
  const calls = [], confirmed = [], timers = new Map();
  let serial = 0;
  const bridge = {
    commerceRequest: async (_action, input) => {
      calls.push('status');
      return { ok: true, result: { order: { id: input.orderId, userId: input.expectedUserId, status: 'confirmed' }, paymentStatus: 'PAID' } };
    },
    refreshAccountPermissions: async () => {
      calls.push('permissions');
      return { ok: true, state: state(), result: { complete: true, permissions: [] } };
    },
    clearPendingPayment: async () => { calls.push('clear'); return { ok: true, result: { cleared: true } }; },
  };
  const recovery = createPaymentRecovery({ bridge, onConfirmed: value => confirmed.push(value),
    setTimer: callback => { const id = ++serial; timers.set(id, callback); return id; }, clearTimer: id => timers.delete(id) });
  recovery.setAccount(state());
  recovery.track(ORDER);
  return { bridge, recovery, calls, confirmed, timers };
}

test('same-owner account updates during permission refresh preserve the active order and shared flight', async () => {
  const f = fixture(), hold = deferred();
  f.bridge.refreshAccountPermissions = async () => {
    f.calls.push('permissions');
    f.recovery.setAccount(state());
    await hold.promise;
    f.recovery.setAccount(state());
    return { ok: true, state: state(), result: { complete: true, permissions: [] } };
  };
  const first = f.recovery.check();
  await tick();
  const focused = f.recovery.focus();
  const manual = f.recovery.check();
  assert.deepEqual(f.calls, ['status', 'permissions']);
  hold.resolve();
  await Promise.all([first, focused, manual]);
  assert.deepEqual(f.calls, ['status', 'permissions', 'clear']);
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.equal(f.confirmed.length, 1);
  assert.equal(f.timers.size, 0);
  f.recovery.dispose();
});

test('a same-user replacement login rejected by the bridge retains its order for a fresh retry', async () => {
  const f = fixture(), hold = deferred();
  f.bridge.refreshAccountPermissions = () => { f.calls.push('permissions'); return hold.promise; };
  const check = f.recovery.check();
  await tick();
  f.recovery.setAccount(state());
  hold.resolve({ ok: false, state: state(), error: { code: 'SESSION_CHANGED', message: 'replacement login' } });
  await check;
  assert.equal(f.calls.includes('clear'), false);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.recovery.snapshot().phase, 'retry');
  assert.equal(f.recovery.snapshot().orderId, ORDER);
  f.bridge.refreshAccountPermissions = async () => ({ ok: true, state: state(), result: { complete: true, permissions: [] } });
  await f.recovery.focus();
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.equal(f.confirmed.length, 1);
  f.recovery.dispose();
});

test('disposal during a permission refresh prevents clearing or announcing its late successful response', async () => {
  const f = fixture(), hold = deferred();
  f.bridge.refreshAccountPermissions = () => { f.calls.push('permissions'); return hold.promise; };
  const check = f.recovery.check();
  await tick();
  f.recovery.dispose();
  hold.resolve({ ok: true, state: state(), result: { complete: true, permissions: [] } });
  await check;
  assert.deepEqual(f.calls, ['status', 'permissions']);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.timers.size, 0);
});

test('a historical confirmed order can finish recovery after its paid membership has already expired', async () => {
  const f = fixture();
  f.bridge.commerceRequest = async () => ({ ok: true, result: { order: { id: ORDER, userId: 'member-a', status: 'confirmed',
    paidAt: '2026-10-13T00:00:00.000Z' }, paymentStatus: 'PAID' } });
  f.bridge.refreshAccountPermissions = async () => ({ ok: true, state: state({ account: {
    user: { id: 'member-a' }, serverTime: '2026-10-15T00:00:00.000Z',
    membership: { type: 'duration', active: false, expiresAt: '2026-10-14T00:00:00.000Z' },
  } }), result: { complete: true, permissions: [{ feature: 'profile-download', authorized: false,
    error: { code: 'MEMBERSHIP_REQUIRED' } }] } });
  await f.recovery.check();
  assert.deepEqual(f.calls, ['clear']);
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.match(f.recovery.snapshot().message, /已到期/);
  assert.equal(f.confirmed.length, 1);
  assert.equal(f.confirmed[0].state.account.membership.active, false);
  f.recovery.dispose();
});
