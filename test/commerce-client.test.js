import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AccountClient } from '../desktop/account-client.js';
import { createBrowserAccountBridge } from '../lib/browser-account.js';

const account = id => ({ user: { id, email: `${id}@example.test` }, membership: { type: 'none' }, serverTime: new Date().toISOString() });
function desktop(fetchImpl) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const client = new AccountClient({ endpoint: 'https://accounts.example.test/api/account', fetchImpl, store: { save: async () => {}, device: () => ({ name: 'fixture-device', platform: 'darwin' }) } });
  client.credentials = { privateKey, publicKey, token: 'token-a', pendingLogoutTokens: [], pendingRedemptions: {} }; client.account = account('a'); client.status = 'ready';
  return { client, publicKey };
}
function profileAccount(id, nickname = '原来的昵称') {
  const base = account(id);
  return { ...base, user: { ...base.user, role: 'user', nickname },
    membership: { type: 'duration', active: true, startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z' },
    device: { id: `device-${id}`, status: 'authorized', name: '已有授权设备' },
    features: { 'profile-download': { requiresMembership: true, requiresDevice: true, allowed: true } } };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
test('desktop reviews can be read anonymously without storage or sending a bearer; private orders and evaluation use a signed proof', async () => {
  const calls = [];
  const { client, publicKey } = desktop(async (_, init) => {
    const body = JSON.parse(init.body); calls.push({ body, headers: init.headers });
    if (body.action !== 'reviews-public') {
      const { timestamp, nonce, signature } = body.proof;
      assert.equal(verify(null, Buffer.from(`${body.action}\n${timestamp}\n${nonce}\n${JSON.stringify(body.input)}\ntoken-a`), publicKey, Buffer.from(signature, 'base64')), true);
    }
    return Response.json({ ok: true, orders: [], reviews: [] });
  });
  const saved = client.credentials; client.credentials = null;
  await client.commerceRequest('reviews-public', { page: 1 });
  assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[0].body.proof, undefined);
  client.credentials = saved;
  await client.commerceRequest('orders-mine', { expectedUserId: 'a' });
  await client.commerceRequest('review-submit', { rating: 5, content: '很实用的软件', expectedUserId: 'a', requestId: 'fixture-request' });
  assert.equal(calls[1].headers.Authorization, 'Bearer token-a');
  assert.throws(() => client.commerceRequest('admin-revenue'), { code: 'UNKNOWN_ACTION' });
  await assert.rejects(client.commerceRequest('orders-mine', { expectedUserId: 'b' }), { code: 'SESSION_CHANGED' });
  assert.equal(calls.length, 3);
});
test('desktop discards delayed private order data after the software account changes', async () => {
  let resolve;
  const { client } = desktop(() => new Promise(done => { resolve = done; }));
  const pending = client.commerceRequest('orders-mine', { expectedUserId: 'a' });
  client.credentials = { ...client.credentials, token: 'token-b' }; client.account = account('b');
  resolve(Response.json({ ok: true, orders: [{ id: 'private-a' }] }));
  await assert.rejects(pending, { code: 'SESSION_CHANGED' });
  assert.equal(client.account.user.id, 'b');
});
test('browser commerce sends same-origin cookies, selects browser authentication, and closes private reads during pending logout', async () => {
  const calls = [];
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(init.credentials, 'same-origin'); assert.equal(body.input.client, 'browser');
    if (body.action === 'logout') throw new Error('offline');
    return Response.json({ ok: true, account: account('a'), orders: [] });
  } });
  await bridge.verifyAccountCode('a@example.test', '123456');
  assert.equal((await bridge.commerceRequest('orders-mine', { expectedUserId: 'a' })).ok, true);
  await bridge.logoutAccount();
  const count = calls.length;
  assert.equal((await bridge.commerceRequest('orders-mine', { expectedUserId: 'a' })).ok, false);
  assert.equal((await bridge.commerceRequest('profile-update', { expectedUserId: 'a', nickname: '新昵称', requestId: 'profile-while-logout' })).ok, false);
  assert.equal(calls.length, count);
  assert.equal((await bridge.commerceRequest('reviews-public')).ok, true);
  assert.equal((await bridge.commerceRequest('admin-orders')).ok, false);
});
test('an uncertain commerce network failure retains the verified browser identity and the authored request', async () => {
  let offline = false;
  const calls = [];
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_, init) => {
    calls.push(JSON.parse(init.body));
    if (offline) throw new Error('response lost');
    return Response.json({ ok: true, account: account('a') });
  } });
  await bridge.verifyAccountCode('a@example.test', '123456');
  const draft = { expectedUserId: 'a', rating: 5, content: '很好用的下载工具', requestId: 'same-authored-request' };
  offline = true;
  const failed = await bridge.commerceRequest('review-submit', draft);
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(failed.state.verified, true); assert.equal(failed.state.account.user.id, 'a');
  offline = false;
  await bridge.commerceRequest('review-submit', draft);
  assert.deepEqual(calls[1], calls[2]);
});

test('desktop profile updates are signed, allowed only for the current user and merge only the nickname', async () => {
  const calls = [];
  const { client, publicKey } = desktop(async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    const { timestamp, nonce, signature } = body.proof;
    assert.equal(verify(null, Buffer.from(`${body.action}\n${timestamp}\n${nonce}\n${JSON.stringify(body.input)}\ntoken-a`), publicKey, Buffer.from(signature, 'base64')), true);
    assert.equal(init.headers.Authorization, 'Bearer token-a');
    return Response.json({ ok: true, profile: { nickname: '晒太阳的小鹿' } });
  });
  client.account = profileAccount('a');
  const before = structuredClone(client.account), events = [];
  client.onUpdate = state => events.push(state);
  const input = Object.freeze({ nickname: '晒太阳的小鹿', expectedUserId: 'a', requestId: 'desktop-profile-request' });
  const result = await client.commerceRequest('profile-update', input);
  assert.equal(result.profile.nickname, input.nickname);
  assert.equal(calls[0].action, 'profile-update'); assert.deepEqual(calls[0].input, input);
  assert.deepEqual(client.account, { ...before, user: { ...before.user, nickname: input.nickname } });
  assert.equal(client.snapshot().verified, true); assert.equal(events.at(-1).account.user.nickname, input.nickname);
  await assert.rejects(client.commerceRequest('profile-update', { ...input, expectedUserId: 'b' }), { code: 'SESSION_CHANGED' });
  assert.throws(() => client.commerceRequest('admin-profile-update', input), { code: 'UNKNOWN_ACTION' });
  assert.equal(calls.length, 1, 'rejected actions send no signed account request');
});

test('browser profile updates use same-origin cookies and merge the nickname without replacing entitlements', async () => {
  const initial = profileAccount('a'), calls = [], events = [];
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(init.credentials, 'same-origin'); assert.equal(body.input.client, 'browser');
    assert.equal(init.headers.Authorization, undefined); assert.equal(body.proof, undefined);
    return Response.json(body.action === 'profile-update' ? { ok: true, profile: { nickname: '听风的海鸥' } } : { ok: true, account: initial });
  } });
  bridge.onAccountUpdate(state => events.push(state));
  await bridge.verifyAccountCode('a@example.test', '123456');
  const input = Object.freeze({ nickname: '听风的海鸥', expectedUserId: 'a', requestId: 'browser-profile-request' });
  const reply = await bridge.commerceRequest('profile-update', input);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.state.account, { ...initial, user: { ...initial.user, nickname: input.nickname } });
  assert.deepEqual(calls[1], { action: 'profile-update', input: { ...input, client: 'browser' } });
  assert.equal(reply.state.verified, true); assert.equal(events.at(-1).account.user.nickname, input.nickname);
  const count = calls.length;
  assert.equal((await bridge.commerceRequest('admin-profile-update', input)).ok, false);
  assert.equal(calls.length, count, 'profile support does not enable arbitrary administrator operations');
});

test('a desktop refresh started before a successful nickname save cannot restore an old nickname', async () => {
  const oldRefresh = deferred(), refreshStarted = deferred();
  const freshAccount = profileAccount('a', '刷新开始时的旧昵称');
  freshAccount.membership = { type: 'permanent', active: true };
  const { client } = desktop(async (_, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'me') { refreshStarted.resolve(); return oldRefresh.promise; }
    assert.equal(body.action, 'profile-update');
    return Response.json({ ok: true, profile: { nickname: '刚刚保存的新昵称' } });
  });
  client.account = profileAccount('a');
  const pending = client.refresh(); await refreshStarted.promise;
  await client.commerceRequest('profile-update', { nickname: '刚刚保存的新昵称', expectedUserId: 'a', requestId: 'save-during-refresh' });
  oldRefresh.resolve(Response.json({ ok: true, account: freshAccount }));
  const result = await pending;
  assert.equal(result.account.user.nickname, '刚刚保存的新昵称');
  assert.equal(client.account.user.nickname, '刚刚保存的新昵称');
  assert.deepEqual(client.account.membership, freshAccount.membership, 'fresh authoritative entitlements still apply');
  assert.deepEqual(client.account.device, freshAccount.device);
});

test('a browser me request started before a successful nickname save cannot restore an old nickname', async () => {
  const oldRefresh = deferred(), refreshStarted = deferred();
  const freshAccount = profileAccount('a', '刷新开始时的旧昵称');
  freshAccount.membership = { type: 'permanent', active: true };
  const bridge = createBrowserAccountBridge({ fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'me') { refreshStarted.resolve(); return oldRefresh.promise; }
    if (body.action === 'profile-update') return Response.json({ ok: true, profile: { nickname: '刚刚保存的新昵称' } });
    return Response.json({ ok: true, account: profileAccount('a') });
  } });
  await bridge.verifyAccountCode('a@example.test', '123456');
  const pending = bridge.refreshAccount(); await refreshStarted.promise;
  await bridge.commerceRequest('profile-update', { nickname: '刚刚保存的新昵称', expectedUserId: 'a', requestId: 'save-during-browser-me' });
  oldRefresh.resolve(Response.json({ ok: true, account: freshAccount }));
  const reply = await pending;
  assert.equal(reply.state.account.user.nickname, '刚刚保存的新昵称');
  assert.equal(reply.result.account.user.nickname, '刚刚保存的新昵称');
  assert.deepEqual(reply.state.account.membership, freshAccount.membership);
  assert.deepEqual(reply.state.account.device, freshAccount.device);
});

test('desktop delayed nickname responses are discarded after logout or replacement login', async () => {
  for (const action of ['logout', 'switch']) {
    const delayed = deferred(), started = deferred(), events = [];
    const { client } = desktop(async (_, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'profile-update') { started.resolve(); return delayed.promise; }
      if (body.action === 'verify-code') return Response.json({ ok: true, token: 'token-b', account: profileAccount('b', '另一个账号的昵称') });
      assert.equal(body.action, 'logout');
      return Response.json({ ok: true });
    });
    client.account = profileAccount('a'); client.onUpdate = state => events.push(state);
    const pending = client.commerceRequest('profile-update', { nickname: '不能恢复的旧账号昵称', expectedUserId: 'a', requestId: `delayed-desktop-${action}` });
    await started.promise;
    if (action === 'logout') await client.logout();
    else await client.verifyCode('b@example.test', '123456');
    delayed.resolve(Response.json({ ok: true, profile: { nickname: '不能恢复的旧账号昵称' } }));
    await assert.rejects(pending, { code: 'SESSION_CHANGED' });
    assert.equal(client.account?.user?.id || null, action === 'logout' ? null : 'b');
    assert.equal(events.some(event => event.account?.user?.nickname === '不能恢复的旧账号昵称'), false);
    if (action === 'switch') assert.equal(client.account.user.nickname, '另一个账号的昵称');
  }
});

test('browser delayed nickname responses are discarded after logout or replacement login', async () => {
  for (const action of ['logout', 'switch']) {
    const delayed = deferred(), started = deferred(), events = [];
    const bridge = createBrowserAccountBridge({ fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'profile-update') { started.resolve(); return delayed.promise; }
      if (body.action === 'logout') return Response.json({ ok: true });
      assert.equal(body.action, 'verify-code');
      const id = body.input.email.startsWith('b@') ? 'b' : 'a';
      return Response.json({ ok: true, account: profileAccount(id, `${id}账号自己的昵称`) });
    } });
    bridge.onAccountUpdate(state => events.push(state));
    await bridge.verifyAccountCode('a@example.test', '123456');
    const pending = bridge.commerceRequest('profile-update', { nickname: '不能恢复的旧账号昵称', expectedUserId: 'a', requestId: `delayed-browser-${action}` });
    await started.promise;
    if (action === 'logout') await bridge.logoutAccount();
    else await bridge.verifyAccountCode('b@example.test', '123456');
    delayed.resolve(Response.json({ ok: true, profile: { nickname: '不能恢复的旧账号昵称' } }));
    const reply = await pending;
    assert.equal(reply.ok, false);
    assert.equal(reply.state.account?.user?.id || null, action === 'logout' ? null : 'b');
    assert.equal(events.some(event => event.account?.user?.nickname === '不能恢复的旧账号昵称'), false);
    if (action === 'switch') assert.equal(reply.state.account.user.nickname, 'b账号自己的昵称');
  }
});

test('nickname save network failures preserve verified identity, rights and the exact authored retry input', async () => {
  const input = Object.freeze({ nickname: '保留原昵称保存请求', expectedUserId: 'a', requestId: 'same-nickname-request' });
  for (const platform of ['desktop', 'browser']) {
    let offline = false;
    const calls = [], initial = profileAccount('a');
    const fetchImpl = async (_, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      if (body.action === 'profile-update' && offline) throw new Error('fixture profile response lost');
      return Response.json(body.action === 'profile-update' ? { ok: true, profile: { nickname: input.nickname } } : { ok: true, account: initial });
    };
    let call, snapshot;
    if (platform === 'desktop') {
      const { client } = desktop(fetchImpl); client.account = initial;
      call = () => client.commerceRequest('profile-update', input); snapshot = () => client.snapshot();
      offline = true; await assert.rejects(call(), { code: 'SERVICE_UNAVAILABLE' });
    } else {
      const bridge = createBrowserAccountBridge({ fetchImpl }); let state;
      bridge.onAccountUpdate(value => { state = value; });
      await bridge.verifyAccountCode('a@example.test', '123456');
      call = () => bridge.commerceRequest('profile-update', input); snapshot = () => state;
      offline = true; const reply = await call();
      assert.equal(reply.ok, false); assert.equal(reply.error.code, 'SERVICE_UNAVAILABLE');
    }
    assert.equal(snapshot().verified, true, platform);
    assert.deepEqual(snapshot().account, initial, `${platform} retains the old nickname and entitlements`);
    offline = false; await call();
    const submissions = calls.filter(body => body.action === 'profile-update');
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[0].input, submissions[1].input, `${platform} retries the same request ID and nickname`);
    assert.equal(snapshot().account.user.nickname, input.nickname);
    assert.equal(input.nickname, '保留原昵称保存请求', 'bridge never rewrites the caller-owned draft');
  }
});

async function nicknameBridge(platform, fetchImpl, initial) {
  if (platform === 'desktop') {
    const { client } = desktop(fetchImpl);
    client.account = initial;
    return { request: (action, input) => client.commerceRequest(action, input), snapshot: () => client.snapshot() };
  }
  const bridge = createBrowserAccountBridge({ fetchImpl });
  let state;
  bridge.onAccountUpdate(value => { state = value; });
  await bridge.verifyAccountCode('a@example.test', '123456');
  return { request: (action, input) => bridge.commerceRequest(action, input), snapshot: () => state };
}

for (const platform of ['desktop', 'browser']) {
  test(`${platform} a later failed review does not suppress a pending successful nickname save`, async () => {
    const pendingSave = deferred(), saveStarted = deferred(), initial = profileAccount('a');
    const bridge = await nicknameBridge(platform, async (_, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'verify-code') return Response.json({ ok: true, account: initial });
      if (body.action === 'profile-update') { saveStarted.resolve(); return pendingSave.promise; }
      assert.equal(body.action, 'review-submit');
      return Response.json({ ok: false, error: { code: 'REVIEW_EXISTS', message: '每个账号仅可评价一次。' } }, { status: 409 });
    }, initial);
    const nickname = '先发成功保存的昵称';
    const saving = bridge.request('profile-update', { nickname, expectedUserId: 'a', requestId: `${platform}-pending-save` });
    await saveStarted.promise;
    const reviewing = bridge.request('review-submit', { rating: 5, content: '已评价账号再次提交', nickname: '不能覆盖的失败昵称', expectedUserId: 'a', requestId: `${platform}-failed-review` });
    if (platform === 'desktop') await assert.rejects(reviewing, { code: 'REVIEW_EXISTS' });
    else { const reply = await reviewing; assert.equal(reply.ok, false); assert.equal(reply.error.code, 'REVIEW_EXISTS'); }
    assert.deepEqual(bridge.snapshot().account, initial, 'failed review leaves the nickname and membership intact');
    pendingSave.resolve(Response.json({ ok: true, profile: { nickname } }));
    const saved = await saving;
    if (platform === 'browser') assert.equal(saved.ok, true);
    assert.equal(bridge.snapshot().verified, true);
    assert.deepEqual(bridge.snapshot().account, { ...initial, user: { ...initial.user, nickname } });
  });

  test(`${platform} an older nickname success cannot overwrite a later successful save or review`, async () => {
    for (const laterAction of ['profile-update', 'review-submit']) {
      const pendingSave = deferred(), saveStarted = deferred(), initial = profileAccount('a');
      const earlierNickname = '晚返回的先发昵称', nickname = '后发成功保存的昵称';
      const bridge = await nicknameBridge(platform, async (_, init) => {
        const body = JSON.parse(init.body);
        if (body.action === 'verify-code') return Response.json({ ok: true, account: initial });
        if (body.input.nickname === earlierNickname) { saveStarted.resolve(); return pendingSave.promise; }
        assert.equal(body.action, laterAction);
        return Response.json({ ok: true, profile: { nickname }, ...(laterAction === 'review-submit' ? { review: { id: 'review-a', nickname } } : {}) });
      }, initial);
      const earlier = bridge.request('profile-update', { nickname: earlierNickname, expectedUserId: 'a', requestId: `${platform}-${laterAction}-earlier` });
      await saveStarted.promise;
      const later = await bridge.request(laterAction, { nickname, expectedUserId: 'a', requestId: `${platform}-${laterAction}-later`, ...(laterAction === 'review-submit' ? { rating: 5, content: '成功提交评价的昵称' } : {}) });
      if (platform === 'browser') assert.equal(later.ok, true);
      const expected = { ...initial, user: { ...initial.user, nickname } };
      assert.deepEqual(bridge.snapshot().account, expected);
      pendingSave.resolve(Response.json({ ok: true, profile: { nickname: earlierNickname } }));
      const earlierResult = await earlier;
      if (platform === 'browser') { assert.equal(earlierResult.ok, true); assert.deepEqual(earlierResult.state.account, expected); }
      assert.equal(bridge.snapshot().verified, true);
      assert.deepEqual(bridge.snapshot().account, expected, `${laterAction} stays applied after the old response arrives`);
    }
  });
}
