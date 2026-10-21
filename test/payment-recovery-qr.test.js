import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentRecovery } from '../lib/payment-recovery.js';

const ORDER = '12345678-1234-1234-1234-123456789abc';
const NEXT = '87654321-4321-4321-4321-cba987654321';
const CODE = 'weixin://wxpay/bizpayurl?pr=fixture-payment';
const account = (id = 'owner-a', verified = true, active = false) => ({
  authenticated: true, verified, status: verified ? 'ready' : 'offline',
  account: { user: { id }, membership: { type: active ? 'duration' : 'none', active } },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

function fixture(options = {}) {
  let clock = 0, serial = 0;
  const timers = new Map(), calls = [], changes = [], confirmed = [];
  const data = { provider: 'wechat', owner: 'owner-a', orderStatus: 'pending', paymentStatus: 'PENDING',
    qrCodeUrl: CODE, qrCodeExpiresAt: new Date(20_000).toISOString() };
  const reply = (orderId = ORDER) => ({ ok: true, result: {
    order: { id: orderId, userId: data.owner, provider: data.provider, status: data.orderStatus },
    paymentStatus: data.paymentStatus, qrCodeUrl: data.qrCodeUrl, qrCodeExpiresAt: data.qrCodeExpiresAt,
  } });
  const bridge = {
    commerceRequest: async (action, input) => {
      calls.push({ action, input });
      return data.statusWork ? data.statusWork(input) : reply(input.orderId);
    },
    refreshAccount: async () => ({ ok: true, state: account() }),
    refreshAccountPermissions: async () => {
      calls.push({ action: 'permissions' });
      return data.permissionsWork ? data.permissionsWork() : { ok: true, state: account('owner-a', true, true), result: { complete: true, permissions: [] } };
    },
    clearPendingPayment: async input => {
      calls.push({ action: 'clear', input });
      return { ok: true, result: { cleared: true } };
    },
    getPendingPayment: async () => ({ ok: true, result: { userId: 'owner-a', orderId: ORDER } }),
  };
  const recovery = createPaymentRecovery({ bridge, onChange: value => changes.push(value), onConfirmed: value => confirmed.push(value),
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id), now: () => clock, ...options });
  recovery.setAccount(account());
  const advance = async amount => {
    clock += amount;
    const due = [...timers].filter(([, value]) => value.at <= clock);
    for (const [id, value] of due) { if (timers.delete(id)) value.callback(); }
    await tick();
  };
  return { recovery, data, reply, bridge, timers, calls, changes, confirmed, advance,
    count: action => calls.filter(call => call.action === action).length };
}

test('only a verified owner receives an in-memory Native code for its current pending WeChat order', async () => {
  const f = fixture();
  f.recovery.track(ORDER);
  assert.equal(f.recovery.snapshot().wechatQr, null, 'a saved order id is not a payment presentation');
  await f.recovery.check();
  assert.deepEqual(f.recovery.snapshot().wechatQr, { ownerId: 'owner-a', orderId: ORDER, codeUrl: CODE, expiresAt: f.data.qrCodeExpiresAt });
  assert.equal(f.count('payment-create'), 0);
  assert.equal(f.count('permissions'), 0);
  assert.equal(f.count('clear'), 0);
  const copied = f.recovery.snapshot(); copied.wechatQr.codeUrl = 'changed';
  assert.equal(f.recovery.snapshot().wechatQr.codeUrl, CODE, 'observers cannot mutate the controller presentation');
  for (const patch of [{ id: NEXT }, { userId: 'owner-b' }]) {
    const result = f.reply().result; result.order = { ...result.order, ...patch };
    assert.equal(f.recovery.observe(result), false);
    assert.equal(f.recovery.snapshot().wechatQr.codeUrl, CODE);
  }
  f.recovery.dispose();
});

test('invalid, expired, foreign, anonymous or non-WeChat presentation data never becomes a payable code', () => {
  const cases = [
    { qrCodeUrl: 'https://example.test/qr' },
    { qrCodeUrl: 'weixin://other/bizpayurl?pr=fixture' },
    { qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=fixture&pr=duplicate' },
    { qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=fixture&next=https://example.test' },
    { qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=fixture#fragment' },
    { qrCodeUrl: 'weixin://user@wxpay/bizpayurl?pr=fixture' },
    { qrCodeUrl: 'weixin://wxpay:80/bizpayurl?pr=fixture' },
    { qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=' },
    { qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=fixture%0a' },
    { qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=fixture%2Fother' },
    { qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=' + 'a'.repeat(1025) },
    { qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=' + 'a'.repeat(2048) },
    { qrCodeExpiresAt: null }, { qrCodeExpiresAt: 'not-a-date' }, { qrCodeExpiresAt: new Date(0).toISOString() },
    { order: { userId: undefined } }, { order: { provider: 'alipay' } }, { paymentStatus: null },
    { unverified: true }, { anonymous: true },
  ];
  for (const entry of cases) {
    const f = fixture(); f.recovery.track(ORDER);
    if (entry.unverified) f.recovery.setAccount(account('owner-a', false));
    if (entry.anonymous) f.recovery.setAccount({ authenticated: false, verified: false, account: null });
    const result = { ...f.reply().result, ...entry, order: { ...f.reply().result.order, ...entry.order } };
    f.recovery.observe(result);
    assert.equal(f.recovery.snapshot().wechatQr, null, JSON.stringify(entry));
    assert.equal(f.count('permissions'), 0);
    assert.equal(f.count('clear'), 0);
    f.recovery.dispose();
  }
});

test('expiry in the background hides the code without abandoning the recoverable order', async () => {
  const f = fixture(); f.recovery.track(ORDER); await f.recovery.check();
  f.recovery.setForeground(false);
  const checks = f.count('payment-status');
  await f.advance(19_999);
  assert.ok(f.recovery.snapshot().wechatQr);
  await f.advance(1);
  assert.equal(f.recovery.snapshot().wechatQr, null);
  assert.equal(f.changes.at(-1).wechatQr, null, 'expiry actively notifies the renderer');
  assert.equal(f.recovery.snapshot().orderId, ORDER);
  assert.equal(f.recovery.snapshot().phase, 'waiting');
  assert.equal(f.count('payment-status'), checks, 'QR expiry does not invent a payment result');
  assert.equal(f.count('clear'), 0);
  assert.equal(f.count('permissions'), 0);
  assert.equal(f.timers.size, 0);
  f.data.qrCodeUrl = CODE + '-refreshed'; f.data.qrCodeExpiresAt = new Date(40_000).toISOString();
  f.recovery.setForeground(true); await f.recovery.focus();
  assert.equal(f.recovery.snapshot().wechatQr.codeUrl, CODE + '-refreshed');
  assert.equal(f.recovery.snapshot().orderId, ORDER);
  assert.equal(f.count('payment-create'), 0);
  f.recovery.dispose();
});

test('a valid visible Native code keeps three-second polling beyond the ordinary recovery window without changing other providers', async () => {
  const f = fixture({ automaticWindowMs: 1000 }); f.recovery.track(ORDER); await f.recovery.check();
  for (let index = 0; index < 6; index++) {
    const before = f.count('payment-status');
    await f.advance(2999); assert.equal(f.count('payment-status'), before);
    await f.advance(1); assert.equal(f.count('payment-status'), before + 1);
    assert.ok(f.recovery.snapshot().wechatQr);
    assert.doesNotMatch(f.recovery.snapshot().message, /自动查询已暂停/);
  }
  f.recovery.setForeground(false); const before = f.count('payment-status'); await f.advance(1000);
  assert.equal(f.count('payment-status'), before, 'backgrounding still pauses all status polling');
  f.recovery.dispose();
  const alipay = fixture(); alipay.data.provider = 'alipay'; alipay.recovery.track(ORDER); await alipay.recovery.check();
  assert.equal(alipay.recovery.snapshot().wechatQr, null);
  await alipay.advance(4999); assert.equal(alipay.count('payment-status'), 1);
  await alipay.advance(1); assert.equal(alipay.count('payment-status'), 2, 'Alipay keeps its existing unpaid backoff');
  alipay.recovery.dispose();
});

test('PAID near QR expiry still receives its bounded entitlement-confirmation window', async () => {
  const f = fixture({ automaticWindowMs: 1000 }); f.data.qrCodeExpiresAt = new Date(4000).toISOString();
  f.recovery.track(ORDER); await f.recovery.check();
  await f.advance(3000);
  f.data.paymentStatus = 'PAID'; await f.recovery.check();
  assert.equal(f.recovery.snapshot().wechatQr, null);
  const before = f.count('payment-status');
  await f.advance(1000); assert.equal(f.count('payment-status'), before + 1);
  assert.equal(f.recovery.snapshot().phase, 'confirming');
  assert.doesNotMatch(f.recovery.snapshot().message, /自动查询已暂停/);
  assert.equal(f.count('permissions'), 0);
  f.recovery.dispose();
});

test('same-owner verification loss, logout and account switch immediately revoke the current code', async () => {
  for (const next of [account('owner-a', false), account('owner-b'), { authenticated: false, verified: false, account: null }]) {
    const f = fixture(); f.recovery.track(ORDER); await f.recovery.check();
    f.recovery.setAccount(next);
    assert.equal(f.recovery.snapshot().wechatQr, null);
    assert.equal(f.changes.at(-1).wechatQr, null);
    assert.equal(f.count('clear'), 0);
    f.recovery.setAccount(account());
    assert.equal(f.recovery.snapshot().wechatQr, null, 'verification alone cannot revive an old payment code');
    f.recovery.dispose();
  }
});

test('old status replies cannot expose another account code, including after a same-owner loss of verification', async () => {
  for (const next of [account('owner-b'), account('owner-a', false), { authenticated: false, verified: false, account: null }]) {
    const f = fixture(), hold = deferred(); f.recovery.track(ORDER);
    f.data.statusWork = () => hold.promise;
    const work = f.recovery.check();
    f.recovery.setAccount(next); hold.resolve(f.reply()); await work;
    assert.equal(f.recovery.snapshot().wechatQr, null);
    assert.equal(f.count('clear'), 0);
    assert.equal(f.count('permissions'), 0);
    f.recovery.dispose();
  }
});

test('loss and restoration of the same owner verification cannot revive an earlier status or resume code', async () => {
  const f = fixture(), held = deferred(); f.recovery.track(ORDER);
  const originalRevision = f.recovery.snapshot().accountRevision;
  f.data.statusWork = () => held.promise;
  const work = f.recovery.check();
  f.recovery.setAccount(account('owner-a', false)); f.recovery.setAccount(account());
  assert.notEqual(f.recovery.snapshot().accountRevision, originalRevision);
  held.resolve(f.reply()); await work;
  assert.equal(f.recovery.snapshot().wechatQr, null, 'a late status cannot reuse the verified identity from before the loss');
  f.recovery.observe(f.reply().result, { accountRevision: originalRevision });
  assert.equal(f.recovery.snapshot().wechatQr, null, 'the same identity revision also binds asynchronous create/resume presentations');
  assert.equal(f.recovery.snapshot().orderId, ORDER);
  delete f.data.statusWork; await f.recovery.check();
  assert.equal(f.recovery.snapshot().wechatQr.codeUrl, CODE, 'only a new authenticated status restores the code');
  assert.equal(f.count('clear'), 0);
  assert.equal(f.count('permissions'), 0);
  f.recovery.dispose();
});

test('identity errors without a state snapshot invalidate earlier QR request revisions before reverification', async () => {
  for (const code of ['ACCOUNT_CHANGED', 'SESSION_CHANGED', 'ACCOUNT_UNVERIFIED']) {
    const f = fixture(); f.recovery.track(ORDER); await f.recovery.check();
    const revision = f.recovery.snapshot().accountRevision;
    f.data.statusWork = async () => ({ ok: false, error: { code, message: 'fixture identity unavailable' } });
    await f.recovery.check();
    assert.ok(f.recovery.snapshot().accountRevision > revision, code);
    assert.equal(f.recovery.snapshot().wechatQr, null);
    f.recovery.setAccount(account());
    f.recovery.observe(f.reply().result, { accountRevision: revision });
    assert.equal(f.recovery.snapshot().wechatQr, null, code + ' cannot retain a prior presentation identity');
    assert.equal(f.recovery.snapshot().orderId, ORDER);
    f.recovery.dispose();
  }
  const restoring = fixture(), revision = restoring.recovery.snapshot().accountRevision;
  restoring.bridge.getPendingPayment = async () => ({ ok: false, error: { code: 'ACCOUNT_UNVERIFIED' } });
  await restoring.recovery.restore();
  assert.ok(restoring.recovery.snapshot().accountRevision > revision);
  assert.equal(restoring.recovery.snapshot().phase, 'restore-retry');
  restoring.recovery.dispose();
});

test('PAID hides the code before entitlement refresh and an old PENDING cannot restore it', async () => {
  const f = fixture(); f.recovery.track(ORDER); await f.recovery.check();
  const oldStatus = deferred(); f.data.statusWork = () => oldStatus.promise;
  const checking = f.recovery.check();
  f.recovery.observe({ ...f.reply().result, paymentStatus: 'PAID' });
  assert.equal(f.recovery.snapshot().wechatQr, null);
  assert.equal(f.recovery.snapshot().phase, 'confirming');
  assert.equal(f.changes.findLast(value => value.paymentStatus === 'PAID').wechatQr, null);
  oldStatus.resolve(f.reply()); await checking;
  assert.equal(f.recovery.snapshot().wechatQr, null);
  assert.equal(f.recovery.snapshot().paymentStatus, 'PAID');
  assert.equal(f.count('clear'), 0);
  assert.equal(f.count('permissions'), 0);
  delete f.data.statusWork;
  f.data.orderStatus = 'confirmed'; f.data.paymentStatus = 'PAID';
  const permissions = deferred(); f.data.permissionsWork = () => permissions.promise;
  const first = f.recovery.check(), duplicate = f.recovery.focus(); await tick();
  assert.equal(f.recovery.snapshot().phase, 'refreshing');
  assert.equal(f.recovery.snapshot().wechatQr, null);
  assert.equal(f.confirmed.length, 0);
  assert.equal(f.count('permissions'), 1);
  permissions.resolve({ ok: true, state: account('owner-a', true, true), result: { complete: true, permissions: [] } });
  await Promise.all([first, duplicate]);
  assert.equal(f.recovery.snapshot().phase, 'confirmed');
  assert.equal(f.recovery.snapshot().wechatQr, null);
  assert.equal(f.count('clear'), 1);
  assert.equal(f.confirmed.length, 1);
  assert.equal(f.recovery.observe(f.reply().result), false);
  await f.recovery.focus();
  assert.equal(f.count('permissions'), 1);
  assert.equal(f.confirmed.length, 1, 'duplicate status/returns cannot announce or grant twice');
  f.recovery.dispose();
});

test('explicit presentation revocation and closed payment results remove the code without refreshing rights', async () => {
  const f = fixture(); f.recovery.track(ORDER); await f.recovery.check();
  f.recovery.observe({ ...f.reply().result, qrCodeUrl: null, qrCodeExpiresAt: null });
  assert.equal(f.recovery.snapshot().wechatQr, null);
  assert.equal(f.recovery.snapshot().orderId, ORDER);
  f.recovery.observe(f.reply().result); assert.ok(f.recovery.snapshot().wechatQr);
  f.data.paymentStatus = 'CLOSED';
  f.recovery.observe(f.reply().result); assert.equal(f.recovery.snapshot().wechatQr, null);
  f.data.paymentStatus = 'PENDING';
  f.recovery.observe(f.reply().result);
  assert.equal(f.recovery.snapshot().paymentStatus, 'CLOSED', 'an older pending response cannot revive a closed payment');
  assert.equal(f.recovery.snapshot().wechatQr, null);
  await f.recovery.check();
  assert.equal(f.recovery.snapshot().phase, 'closed');
  assert.equal(f.recovery.snapshot().wechatQr, null);
  assert.equal(f.count('clear'), 1);
  assert.equal(f.count('permissions'), 0);
  assert.equal(f.confirmed.length, 0);
  f.recovery.dispose();
});

test('replacement tracking, restore and disposal never persist or revive a previous payment code', async () => {
  const f = fixture(); f.recovery.track(ORDER); await f.recovery.check();
  const oldExpiry = [...f.timers.values()].find(value => value.at === 20_000).callback;
  f.recovery.track(NEXT);
  assert.equal(f.recovery.snapshot().wechatQr, null);
  f.data.qrCodeUrl = CODE + '-next'; f.data.qrCodeExpiresAt = new Date(40_000).toISOString();
  await f.recovery.check(); oldExpiry();
  assert.equal(f.recovery.snapshot().wechatQr.orderId, NEXT);
  assert.equal(f.recovery.snapshot().wechatQr.codeUrl, CODE + '-next');
  f.recovery.dispose();
  assert.equal(f.recovery.snapshot().wechatQr, null);
  assert.equal(f.timers.size, 0);
  const restored = fixture(), status = deferred();
  restored.data.statusWork = () => status.promise;
  const work = restored.recovery.restore(); await tick();
  assert.equal(restored.recovery.snapshot().wechatQr, null);
  status.resolve(restored.reply()); await work;
  assert.equal(restored.recovery.snapshot().wechatQr.orderId, ORDER);
  assert.equal(restored.count('payment-create'), 0);
  restored.recovery.dispose();
});
