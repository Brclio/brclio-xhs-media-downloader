import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { AccountClient } from '../desktop/account-client.js';
import { SecureAccountStore, sanitizePendingPayments } from '../desktop/account-storage.js';

const ORDER_A = '12345678-1234-1234-1234-123456789abc';
const ORDER_B = '87654321-4321-4321-4321-cba987654321';
const CHECKOUT = 'https://pay.bornforthis.cn/checkout/payment#token=never-persist-checkout-secret';
const ENDPOINT = 'https://accounts.example.test/api/account';
const paymentKey = (userId, endpoint = ENDPOINT) => `${createHash('sha256').update(endpoint).digest('hex')}:${userId}`;
const account = userId => ({ user: { id: userId }, membership: { active: false }, device: { status: 'authorized' } });

function encryptedStorage() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
    }
  };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-pending-payment-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const safeStorage = encryptedStorage();
  const store = new SecureAccountStore({ directory, safeStorage, platform: 'darwin', deviceIdentity: async () => 'a'.repeat(64) });
  const sessions = new Map(), requests = [];
  let holdPayment, nextOrder = ORDER_A, failRefresh = false, custom;
  const config = { endpoint: ENDPOINT, store, fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body), token = init.headers.Authorization?.slice(7);
    requests.push(request);
    const success = values => Response.json({ ok: true, ...values });
    if (custom) {
      const response = await custom(request);
      if (response) return response;
    }
    if (request.action === 'verify-code') {
      const userId = request.input.email.split('@')[0], token = `fixed-fixture-token-${userId}`;
      sessions.set(token, userId);
      return success({ token, account: account(userId) });
    }
    if (request.action === 'logout') return success({ revoked: true });
    if (request.action === 'me') {
      if (failRefresh) return Response.json({ ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'unavailable' } }, { status: 503 });
      return success({ account: account(sessions.get(token)) });
    }
    if (request.action === 'payment-create') {
      if (holdPayment) await holdPayment;
      return success({ order: { id: nextOrder, status: 'pending', userId: sessions.get(token) }, checkoutUrl: CHECKOUT });
    }
    if (request.action === 'payment-status') return success({ order: { id: request.input.orderId, userId: sessions.get(token), status: 'confirmed' }, paymentStatus: 'PAID' });
    throw new Error(`Unexpected test request: ${request.action}`);
  } };
  const client = new AccountClient(config);
  await client.initialize();
  const login = userId => client.verifyCode(`${userId}@example.test`, '123456');
  await login('user-a');
  return { client, store, safeStorage, config, requests, login,
    order: value => { nextOrder = value; }, hold: promise => { holdPayment = promise; }, failRefresh: value => { failRefresh = value; }, handler: value => { custom = value; } };
}

test('desktop saves only encrypted product order references before returning checkout and restores after verified restart', async t => {
  const f = await fixture(t);
  const created = await f.client.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  assert.equal(created.checkoutUrl, CHECKOUT);
  const saved = await f.store.load();
  assert.deepEqual(saved.pendingPayments, { [paymentKey('user-a')]: { userId: 'user-a', orderId: ORDER_A } });
  const bytes = await readFile(f.store.filename);
  assert.equal(bytes.includes(Buffer.from(ORDER_A)), false);
  assert.equal(f.safeStorage.decryptString(bytes).includes('never-persist-checkout-secret'), false);
  assert.equal(f.safeStorage.decryptString(bytes).includes('pay.bornforthis.cn'), false);
  const restarted = new AccountClient(f.config);
  await restarted.initialize();
  assert.equal(await restarted.getPendingPayment(), null, 'Saved session must be verified before exposing its order');
  await restarted.refresh();
  assert.deepEqual(await restarted.getPendingPayment(), { userId: 'user-a', orderId: ORDER_A });
  assert.equal(f.requests.some(request => request.input?.orderId === ORDER_A), false, 'Recovery reads local metadata without mutating the server ledger');
});

test('pending payments stay isolated by account and service through switch and logout', async t => {
  const f = await fixture(t);
  await f.client.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  await f.login('user-b');
  assert.equal(await f.client.getPendingPayment(), null);
  f.order(ORDER_B);
  await f.client.commerceRequest('payment-create', { expectedUserId: 'user-b' });
  assert.deepEqual(await f.client.getPendingPayment(), { userId: 'user-b', orderId: ORDER_B });
  await f.client.logout();
  assert.equal(await f.client.getPendingPayment(), null);
  await f.login('user-a');
  assert.deepEqual(await f.client.getPendingPayment(), { userId: 'user-a', orderId: ORDER_A });
  const anotherService = new AccountClient({ ...f.config, endpoint: 'https://other-accounts.example.test/api/account' });
  await anotherService.initialize(); await anotherService.refresh();
  assert.equal(await anotherService.getPendingPayment(), null);
  await assert.rejects(f.client.clearPendingPayment({ orderId: ORDER_A, expectedUserId: 'user-b' }), { code: 'SESSION_CHANGED' });
});

test('confirmed status and failed account refresh keep recovery metadata until an explicit matching clear', async t => {
  const f = await fixture(t);
  await f.client.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  const status = await f.client.commerceRequest('payment-status', { expectedUserId: 'user-a', orderId: ORDER_A });
  assert.equal(status.order.status, 'confirmed');
  assert.deepEqual(await f.client.getPendingPayment(), { userId: 'user-a', orderId: ORDER_A });
  f.failRefresh(true);
  await assert.rejects(f.client.refreshAccountPermissions(), { code: 'STORAGE_UNAVAILABLE' });
  await assert.rejects(f.client.getPendingPayment(), { code: 'ACCOUNT_UNVERIFIED' });
  assert.equal((await f.store.load()).pendingPayments[paymentKey('user-a')].orderId, ORDER_A);
  f.failRefresh(false); await f.client.refresh();
  assert.deepEqual(await f.client.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_B }), { cleared: false });
  assert.deepEqual(await f.client.getPendingPayment(), { userId: 'user-a', orderId: ORDER_A });
  assert.deepEqual(await f.client.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_A }), { cleared: true });
  const restarted = new AccountClient(f.config);
  await restarted.initialize(); await restarted.refresh();
  assert.equal(await restarted.getPendingPayment(), null);
});

test('late payment response cannot restore an order after replacement login even if token and user are reused', async t => {
  const f = await fixture(t);
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const creating = f.client.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  await f.login('user-a');
  release();
  await assert.rejects(creating, { code: 'SESSION_CHANGED' });
  assert.equal(await f.client.getPendingPayment(), null);
  assert.deepEqual((await f.store.load()).pendingPayments, {});
});

test('desktop owned callback status restores an absent order without replacing another pending order', async t => {
  const f = await fixture(t);
  await f.client.commerceRequest('payment-status', { expectedUserId: 'user-a', orderId: ORDER_A });
  assert.deepEqual(await f.client.getPendingPayment(), { userId: 'user-a', orderId: ORDER_A });
  await f.client.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_A });
  f.order(ORDER_B);
  await f.client.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  await f.client.commerceRequest('payment-status', { expectedUserId: 'user-a', orderId: ORDER_A });
  assert.deepEqual(await f.client.getPendingPayment(), { userId: 'user-a', orderId: ORDER_B });
});

test('late desktop callback status cannot replace a newer pending order or resurrect its cleared reference', async t => {
  const f = await fixture(t);
  let release;
  f.handler(request => request.action === 'payment-status' ? new Promise(resolve => { release = resolve; }) : null);
  const oldStatus = f.client.commerceRequest('payment-status', { expectedUserId: 'user-a', orderId: ORDER_A });
  f.order(ORDER_B);
  await f.client.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  release(Response.json({ ok: true, order: { id: ORDER_A, userId: 'user-a', status: 'pending' } })); await oldStatus;
  assert.deepEqual(await f.client.getPendingPayment(), { userId: 'user-a', orderId: ORDER_B });
  const checking = f.client.commerceRequest('payment-status', { expectedUserId: 'user-a', orderId: ORDER_B });
  await f.client.clearPendingPayment({ expectedUserId: 'user-a', orderId: ORDER_B });
  release(Response.json({ ok: true, order: { id: ORDER_B, userId: 'user-a', status: 'confirmed' } })); await checking;
  assert.equal(await f.client.getPendingPayment(), null);
});

test('reverse-arriving desktop creates expose only the latest request and keep its pending order', async t => {
  const f = await fixture(t);
  let release, creates = 0;
  f.handler(request => request.action === 'payment-create' && ++creates === 1 ? new Promise(resolve => { release = resolve; }) : null);
  const older = f.client.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  f.order(ORDER_B);
  await f.client.commerceRequest('payment-create', { expectedUserId: 'user-a' });
  release(Response.json({ ok: true, order: { id: ORDER_A, userId: 'user-a', status: 'pending' }, checkoutUrl: CHECKOUT }));
  await assert.rejects(older, { code: 'PAYMENT_REQUEST_SUPERSEDED' });
  assert.deepEqual(await f.client.getPendingPayment(), { userId: 'user-a', orderId: ORDER_B });
});

test('pending recovery sanitization strips URL/token fields and ignores malformed optional records without replacing account keys', async t => {
  const f = await fixture(t), before = await f.store.load();
  const pendingPayments = {
    [paymentKey('user-a')]: { userId: 'user-a', orderId: ORDER_A, checkoutUrl: CHECKOUT, token: 'checkout-secret' },
    [paymentKey('user-b')]: { userId: 'user-b', orderId: CHECKOUT },
    [paymentKey('user-c')]: { userId: 'user-a', orderId: ORDER_B }
  };
  const expected = { [paymentKey('user-a')]: { userId: 'user-a', orderId: ORDER_A } };
  assert.deepEqual(sanitizePendingPayments(pendingPayments), expected);
  await f.store.save({ ...before, pendingPayments });
  assert.deepEqual((await f.store.load()).pendingPayments, expected);
  const saved = f.safeStorage.decryptString(await readFile(f.store.filename));
  assert.equal(saved.includes(CHECKOUT), false);
  await writeFile(f.store.filename, f.safeStorage.encryptString(JSON.stringify({ ...before, pendingPayments })));
  const loaded = await f.store.load();
  assert.deepEqual(loaded.pendingPayments, expected);
  assert.equal(loaded.privateKey, before.privateKey);
});

test('preload exposes scoped pending-payment, permission refresh and removable native focus bridge', async () => {
  const source = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  const calls = [], listeners = new Map();
  let bridge;
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); }, on: (name, fn) => listeners.set(name, fn), removeListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } } };
  } });
  bridge.getPendingPayment();
  bridge.clearPendingPayment({ orderId: ORDER_A, expectedUserId: 'user-a' });
  bridge.refreshAccountPermissions();
  assert.deepEqual(calls, [['desktop:pending-payment'], ['desktop:clear-pending-payment', { orderId: ORDER_A, expectedUserId: 'user-a' }], ['desktop:account-refresh-permissions']]);
  let focused = 0;
  const stop = bridge.onAppFocus(() => { focused++; });
  listeners.get('desktop:app-focus')();
  assert.equal(focused, 1); stop();
  assert.equal(listeners.has('desktop:app-focus'), false);
  assert.throws(() => bridge.onAppFocus(null), { name: 'TypeError' });
});
