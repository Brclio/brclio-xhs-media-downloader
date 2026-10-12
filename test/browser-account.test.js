import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAccountBridge } from '../lib/browser-account.js';

const account = id => ({ user: { id, email: `${id}@example.test` }, membership: { active: true, type: 'permanent' } });
const success = id => Response.json({ ok: true, account: account(id) });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(done => setImmediate(done));

test('an account switch invalidates old membership immediately and ignores earlier refresh results', async () => {
  const pendingMe = deferred(), pendingLogin = deferred();
  let refreshes = 0;
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_url, options) => {
    const { action } = JSON.parse(options.body);
    if (action === 'me') return ++refreshes === 1 ? success('member-a') : pendingMe.promise;
    assert.equal(action, 'verify-code'); return pendingLogin.promise;
  } });
  const updates = [];
  bridge.onAccountUpdate(state => updates.push(state));
  assert.equal((await bridge.getAccountState()).account.user.id, 'member-a');
  const refresh = bridge.refreshAccount(); await tick();
  const login = bridge.verifyAccountCode('member-b@example.test', '123456');
  assert.equal(updates.at(-1).authenticated, false);
  assert.equal(updates.at(-1).verified, false);
  assert.equal(updates.at(-1).account, null);
  pendingMe.resolve(success('member-a'));
  assert.equal((await refresh).ok, false);
  pendingLogin.resolve(success('member-b'));
  assert.equal((await login).state.account.user.id, 'member-b');
});

test('cookie-writing logins are serialized so an older Set-Cookie cannot replace a newer account', async () => {
  const first = deferred(); const calls = [];
  let cookieUser = '';
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_url, options) => {
    const { action, input } = JSON.parse(options.body); calls.push(input.email);
    assert.equal(action, 'verify-code');
    if (input.email === 'member-a@example.test') await first.promise;
    cookieUser = input.email.split('@')[0];
    return success(cookieUser);
  } });
  const loginA = bridge.verifyAccountCode('member-a@example.test', '123456'); await tick();
  const loginB = bridge.verifyAccountCode('member-b@example.test', '123456'); await tick();
  assert.deepEqual(calls, ['member-a@example.test']);
  first.resolve();
  assert.equal((await loginA).ok, false);
  assert.equal((await loginB).state.account.user.id, 'member-b');
  assert.equal(cookieUser, 'member-b');
});

test('logout follows an in-flight cookie-writing login and refresh cannot restore the old account', async () => {
  const pending = deferred(); const calls = [];
  let cookieUser = '';
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_url, options) => {
    const { action } = JSON.parse(options.body); calls.push(action);
    if (action === 'verify-code') { await pending.promise; cookieUser = 'member-a'; return success(cookieUser); }
    if (action === 'logout') { cookieUser = ''; return Response.json({ ok: true, revoked: true }); }
    assert.equal(cookieUser, ''); return Response.json({ ok: false }, { status: 401 });
  } });
  const login = bridge.verifyAccountCode('member-a@example.test', '123456'); await tick();
  const logout = bridge.logoutAccount(), refresh = bridge.refreshAccount(); await tick();
  assert.deepEqual(calls, ['verify-code']);
  pending.resolve();
  assert.equal((await login).ok, false);
  assert.equal((await logout).state.authenticated, false);
  assert.equal((await refresh).state.authenticated, false);
  assert.equal(cookieUser, '');
  assert.deepEqual(calls, ['verify-code', 'logout', 'me']);
});

test('a failed logout remains locally closed and refresh retries logout before accepting any account', async () => {
  const calls = [];
  let logoutCalls = 0;
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_url, options) => {
    const { action } = JSON.parse(options.body); calls.push(action);
    if (action === 'me') return success('member-a');
    if (action === 'logout' && ++logoutCalls === 1) throw new Error('offline');
    return Response.json({ ok: true, revoked: true });
  } });
  await bridge.getAccountState();
  const failed = await bridge.logoutAccount();
  assert.equal(failed.ok, false);
  assert.equal(failed.state.authenticated, false);
  assert.equal(failed.state.pendingLogout, true);
  assert.equal((await bridge.redeemAccountCode('SAMPLE-CODE')).ok, false);
  assert.equal((await bridge.refreshAccount()).state.authenticated, false);
  assert.deepEqual(calls, ['me', 'logout', 'logout']);
});

test('invalidated sessions and malformed refresh data cannot preserve verified membership', async () => {
  for (const response of [Response.json({ ok: false }, { status: 401 }), Response.json({ ok: true })]) {
    let calls = 0;
    const bridge = createBrowserAccountBridge({ fetchImpl: async () => ++calls === 1 ? success('member-a') : response });
    await bridge.getAccountState();
    const result = await bridge.refreshAccount();
    assert.equal(result.ok, false);
    assert.equal(result.state.verified, false);
  }
});

test('public Google configuration failures preserve the verified account and private commerce access', async () => {
  const updates = [], failures = [
    () => Response.json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Configuration unavailable' } }, { status: 503 }),
    () => Response.json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Unexpected public endpoint rejection' } }, { status: 401 }),
    () => Response.json({ ok: false }, { status: 200 }),
    () => new Response('<html>Upstream unavailable</html>', { status: 502 }),
    () => { throw new Error('connection reset'); },
  ];
  let configurationRequests = 0;
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_url, options) => {
    const { action, input, proof } = JSON.parse(options.body);
    if (action === 'me') return success('member-a');
    if (action === 'google-config') {
      assert.deepEqual(input, { client: 'browser' });
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(proof, undefined);
      assert.equal(options.credentials, 'same-origin');
      return failures[configurationRequests++]();
    }
    assert.equal(action, 'orders-mine');
    assert.equal(input.expectedUserId, 'member-a');
    return Response.json({ ok: true, orders: [{ id: 'member-a-order' }] });
  } });
  bridge.onAccountUpdate(value => updates.push(value));
  const verified = await bridge.getAccountState();
  assert.equal(verified.authenticated, true);
  assert.equal(verified.verified, true);
  for (const _failure of failures) {
    const updatesBeforeConfiguration = updates.length;
    const reply = await bridge.getAccountGoogleConfig();
    assert.equal(reply.ok, false);
    assert.equal(reply.result.enabled, false);
    assert.ok(reply.error);
    assert.deepEqual(reply.state, verified, 'Discovery failures must not change account, membership or account error state');
    assert.equal(updates.length, updatesBeforeConfiguration, 'Discovery failures must not emit an account change');
    const orders = await bridge.commerceRequest('orders-mine', { expectedUserId: 'member-a' });
    assert.equal(orders.ok, true);
    assert.deepEqual(orders.result.orders, [{ id: 'member-a-order' }]);
    assert.deepEqual(orders.state, verified);
  }
  assert.equal(configurationRequests, failures.length);
});
