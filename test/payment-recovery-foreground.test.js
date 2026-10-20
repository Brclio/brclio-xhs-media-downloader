import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentRecovery } from '../lib/payment-recovery.js';

const ORDER = '12345678-1234-1234-1234-123456789abc';
const SECOND = '87654321-4321-4321-4321-cba987654321';
const account = (id = 'a', active = false) => ({ configured: true, authenticated: true, verified: true, status: 'ready',
  account: { user: { id }, membership: { type: active ? 'duration' : 'none', active },
    features: { 'profile-download': { allowed: active }, 'watermark-free-video': { allowed: active } } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

function fixture(options = {}) {
  let clock = 0, serial = 0, recovery;
  const calls = [], changes = [], confirmed = [], timers = new Map();
  const data = { owner: 'a', pending: { userId: 'a', orderId: ORDER }, orderStatus: 'pending', paymentStatus: 'PENDING' };
  const reply = (status = data.orderStatus, paymentStatus = data.paymentStatus, input = { orderId: ORDER, expectedUserId: data.owner }) => ({ ok: true,
    result: { order: { id: input.orderId, userId: input.expectedUserId, status }, paymentStatus } });
  const bridge = {
    getPendingPayment: async () => { calls.push('pending'); return data.pendingWork ? data.pendingWork() : { ok: true, result: data.pending }; },
    commerceRequest: async (_action, input) => { calls.push('status'); return data.statusWork ? data.statusWork(input) : reply(data.orderStatus, data.paymentStatus, input); },
    refreshAccount: async () => { calls.push('account'); return { ok: true, state: account(data.owner, true) }; },
    refreshAccountPermissions: async () => { calls.push('permissions'); return data.permissionsWork ? data.permissionsWork()
      : { ok: true, state: account(data.owner, true), result: { complete: true, permissions: [{ feature: 'profile-download', authorized: true }] } }; },
    clearPendingPayment: async () => { calls.push('clear'); data.pending = null; return { ok: true, result: { cleared: true } }; },
  };
  recovery = createPaymentRecovery({ bridge, now: () => clock,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimer: id => timers.delete(id),
    onChange: value => { changes.push(value); options.onChange?.(value, recovery); },
    onConfirmed: value => { confirmed.push(value); options.onConfirmed?.(value, recovery); },
  });
  recovery.setAccount(account());
  const advance = async milliseconds => {
    clock += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.delete(id)) timer.callback();
    await tick();
  };
  return { recovery, bridge, calls, data, changes, confirmed, timers, reply, advance,
    count: action => calls.filter(call => call === action).length,
    nextDelay: () => Math.min(...[...timers.values()].map(timer => timer.at - clock)) };
}

test('foreground return coalesces one serial fresh check after an older PENDING and awaits fresh permissions', async () => {
  const f = fixture(), oldStatus = deferred(), rights = deferred();
  let statusCalls = 0, active = 0, maximumActive = 0;
  f.data.statusWork = async input => {
    active++; maximumActive = Math.max(maximumActive, active);
    const result = statusCalls++ === 0 ? await oldStatus.promise : f.reply('confirmed', 'PAID', input);
    active--; return result;
  };
  f.data.permissionsWork = () => rights.promise;
  f.recovery.track(ORDER);
  const beforeReturn = f.recovery.check();
  const returned = f.recovery.focus(), repeatedReturn = f.recovery.focus();
  assert.equal(f.count('status'), 1);
  oldStatus.resolve(f.reply('pending', 'PENDING'));
  await tick();
  assert.equal(f.count('status'), 2, 'the return does not wait for the normal polling timer');
  assert.equal(maximumActive, 1, 'the follow-up never overlaps the older status request');
  assert.equal(f.recovery.snapshot().phase, 'refreshing');
  assert.equal(f.recovery.snapshot().completedAccount, null);
  assert.equal(f.count('clear'), 0);
  assert.equal(f.confirmed.length, 0);
  rights.resolve({ ok: true, state: account('a', true), result: { complete: true, permissions: [{ feature: 'profile-download', authorized: true }] } });
  await Promise.all([beforeReturn, returned, repeatedReturn]);
  assert.equal(f.count('status'), 2);
  assert.equal(f.count('clear'), 1);
  assert.equal(f.confirmed.length, 1);
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.equal(f.recovery.snapshot().completedAccount.account.membership.active, true);
  f.recovery.dispose();
});

test('confirmed result survives same-owner render, restore and duplicate tracking until explicitly dismissed', async () => {
  const f = fixture({ onConfirmed: (value, recovery) => { recovery.setAccount(value.state); void recovery.restore(); } });
  f.data.orderStatus = 'confirmed'; f.data.paymentStatus = 'PAID';
  f.recovery.track(ORDER); await f.recovery.check();
  const completed = f.recovery.snapshot();
  f.recovery.setAccount({ ...account('a', true), verified: false, status: 'service_unavailable' });
  await f.recovery.restore(); await f.recovery.focus(); f.recovery.track(ORDER);
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.deepEqual(f.recovery.snapshot().completedAccount, completed.completedAccount);
  assert.deepEqual(f.calls, ['status', 'permissions', 'clear'], 'cleared local storage is not read back into idle');
  assert.equal(f.confirmed.length, 1);
  assert.equal(f.recovery.dismissResult(), true);
  assert.equal(f.recovery.snapshot().phase, 'idle');
  assert.equal(f.recovery.snapshot().orderId, null);
  assert.equal(f.recovery.snapshot().completedAccount, null);
  assert.deepEqual(f.recovery.snapshot().permissions, []);
  assert.equal(f.count('clear'), 1, 'dismissing is an in-memory acknowledgement only');
  f.recovery.dispose();
});

test('a paid resume observed during permission refresh cannot regress the refreshing phase or completed server order', async () => {
  const f = fixture(), rights = deferred();
  f.data.orderStatus = 'confirmed'; f.data.paymentStatus = 'PAID';
  f.data.permissionsWork = () => rights.promise;
  f.recovery.track(ORDER); const work = f.recovery.check(); await tick();
  assert.equal(f.recovery.snapshot().phase, 'refreshing');
  f.recovery.observe(f.reply('pending', 'PENDING').result);
  f.recovery.observe(f.reply('pending', 'PAID').result);
  const focused = f.recovery.focus(); await tick();
  assert.equal(f.recovery.snapshot().phase, 'refreshing');
  assert.equal(f.recovery.snapshot().order.status, 'confirmed');
  assert.equal(f.recovery.snapshot().paymentStatus, 'PAID');
  rights.resolve({ ok: true, state: account('a', true), result: { complete: true, permissions: [] } });
  await Promise.all([work, focused]);
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.equal(f.count('status'), 1);
  assert.equal(f.confirmed.length, 1);
  f.recovery.dispose();
});

test('UI observer errors cannot undo successful confirmation or lose its fresh account snapshot', async () => {
  const f = fixture({ onChange: value => { if (value.phase === 'confirmed') throw Error('fixture render error'); }, onConfirmed: () => { throw Error('fixture observer error'); } });
  f.data.orderStatus = 'confirmed'; f.data.paymentStatus = 'PAID';
  f.recovery.track(ORDER); await f.recovery.check();
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.equal(f.recovery.snapshot().busy, false);
  assert.equal(f.recovery.snapshot().completedAccount.verified, true);
  assert.equal(f.confirmed.length, 1);
  assert.equal(f.count('clear'), 1);
  f.recovery.dispose();
});

test('a verified active account update prompts a status check but cannot itself confirm payment', async () => {
  const f = fixture(); f.recovery.track(ORDER);
  f.recovery.setAccount(account('a', true)); await tick();
  assert.equal(f.count('status'), 1);
  assert.equal(f.recovery.snapshot().phase, 'waiting');
  assert.equal(f.recovery.snapshot().completedAccount, null);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.count('permissions'), 0);
  f.data.orderStatus = 'confirmed'; f.data.paymentStatus = 'PAID';
  await f.recovery.focus();
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.equal(f.confirmed.length, 1);
  f.recovery.dispose();
});

test('a verified active account observed during an old status read prompts a serial follow-up', async () => {
  const f = fixture(), oldStatus = deferred();
  f.recovery.track(ORDER); f.data.statusWork = () => oldStatus.promise;
  const work = f.recovery.check();
  f.recovery.setAccount(account('a', true)); await tick();
  f.data.statusWork = input => f.reply('confirmed', 'PAID', input);
  oldStatus.resolve(f.reply('pending', 'PENDING')); await work;
  assert.equal(f.count('status'), 2);
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.equal(f.confirmed.length, 1);
  f.recovery.dispose();
});

test('known PAID starts a fast bounded confirmation window even after a long unpaid backoff', async () => {
  const f = fixture(); f.recovery.track(ORDER);
  for (let index = 0; index < 5; index++) await f.advance(30_000);
  assert.equal(f.nextDelay(), 30_000);
  f.data.paymentStatus = 'PAID'; await f.recovery.check();
  assert.equal(f.nextDelay(), 1000, 'the old unpaid backoff cannot delay payment confirmation');
  for (let index = 0; index < 10; index++) { await f.advance(3000); assert.ok(f.nextDelay() <= 3000); }
  await f.advance(31_000);
  assert.equal(f.nextDelay(), 30_000, 'long confirmation lag returns to bounded normal polling');
  assert.equal(f.confirmed.length, 0);
  f.recovery.dispose();
});

test('foreground lifecycle pauses background polling and focus immediately resumes the same paid order', async () => {
  const f = fixture(); f.recovery.track(ORDER); f.data.paymentStatus = 'PAID'; await f.recovery.check();
  const before = f.count('status');
  f.recovery.setForeground(false);
  assert.equal(f.timers.size, 0);
  await f.advance(15 * 60_000);
  assert.equal(f.count('status'), before);
  f.recovery.setForeground(true); await f.recovery.focus();
  assert.equal(f.count('status'), before + 1);
  assert.equal(f.recovery.snapshot().orderId, ORDER);
  assert.equal(f.nextDelay(), 1000);
  f.recovery.dispose();
});

test('background pending-record failures retain their recovery guard and resume on explicit focus', async () => {
  const f = fixture(); f.recovery.setForeground(false);
  f.data.pendingWork = async () => ({ ok: false, error: { message: 'fixture unavailable' } });
  await f.recovery.restore(); await f.advance(30_000);
  assert.equal(f.count('pending'), 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.recovery.snapshot().phase, 'restore-retry');
  delete f.data.pendingWork; f.recovery.setForeground(true); await f.recovery.focus();
  assert.equal(f.count('pending'), 2);
  assert.equal(f.recovery.snapshot().phase, 'waiting');
  assert.equal(f.recovery.snapshot().orderId, ORDER);
  f.recovery.dispose();
});

test('backgrounding before an older status settles cancels its queued tail until the next foreground return', async () => {
  const f = fixture(), oldStatus = deferred();
  f.recovery.track(ORDER); f.data.statusWork = () => oldStatus.promise;
  const first = f.recovery.check(), focus = f.recovery.focus();
  f.recovery.setForeground(false); oldStatus.resolve(f.reply());
  await Promise.all([first, focus]);
  assert.equal(f.count('status'), 1);
  assert.equal(f.timers.size, 0);
  delete f.data.statusWork; f.recovery.setForeground(true); await f.recovery.focus();
  assert.equal(f.count('status'), 2);
  f.recovery.dispose();
});

test('dismissResult rejects pending, paid retries, restoring and busy completion; closed results dismiss without a second clear', async () => {
  const busyDismiss = [];
  const f = fixture({ onChange: (value, recovery) => { if (value.phase === 'confirmed' && value.busy) busyDismiss.push(recovery.dismissResult()); } });
  assert.equal(f.recovery.dismissResult(), false);
  const lookup = deferred(); f.data.pendingWork = () => lookup.promise;
  const restoring = f.recovery.restore(); assert.equal(f.recovery.dismissResult(), false);
  lookup.resolve({ ok: true, result: f.data.pending }); await restoring;
  assert.equal(f.recovery.dismissResult(), false);
  f.data.paymentStatus = 'PAID'; await f.recovery.check();
  assert.equal(f.recovery.dismissResult(), false);
  f.data.statusWork = async () => ({ ok: false, error: { message: 'fixture offline' } }); await f.recovery.check();
  assert.equal(f.recovery.dismissResult(), false);
  delete f.data.statusWork; f.data.orderStatus = 'confirmed'; await f.recovery.check();
  assert.ok(busyDismiss.length > 0); assert.ok(busyDismiss.every(value => value === false));
  assert.equal(f.recovery.dismissResult(), true);
  assert.equal(f.count('clear'), 1);
  f.recovery.track(SECOND); f.data.orderStatus = 'pending'; f.data.paymentStatus = 'CLOSED'; await f.recovery.check();
  assert.equal(f.recovery.snapshot().phase, 'closed');
  await f.recovery.restore(); assert.equal(f.recovery.snapshot().phase, 'closed');
  assert.equal(f.recovery.dismissResult(), true);
  assert.equal(f.count('clear'), 2);
  f.recovery.dispose();
});

test('account switch invalidates a queued foreground tail and completion account snapshot', async () => {
  const f = fixture(), oldStatus = deferred();
  f.recovery.track(ORDER); f.data.statusWork = () => oldStatus.promise;
  const work = f.recovery.check(), wake = f.recovery.focus();
  f.recovery.setAccount(account('b')); oldStatus.resolve(f.reply('confirmed', 'PAID'));
  await Promise.all([work, wake]);
  assert.equal(f.count('status'), 1);
  assert.equal(f.count('permissions'), 0);
  assert.equal(f.count('clear'), 0);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.recovery.snapshot().ownerId, 'b');
  assert.equal(f.recovery.snapshot().completedAccount, null);
  f.recovery.dispose();
});
