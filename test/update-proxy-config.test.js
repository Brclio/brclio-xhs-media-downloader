import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GithubStateStore, emptyState, validateState } from '../server/auth/store.js';
import { SqliteStateStore } from '../server/auth/sqlite-store.js';
import { createAccountService } from '../server/auth/service.js';
import { readConfig } from '../server/auth/config.js';
import { digest } from '../server/auth/crypto.js';
import { createAccountHandler, ADMIN_COOKIE } from '../api/account.js';
import { subscriptionUrlValue, subscriptionUrlsValue, updateProxyConfigView } from '../server/auth/update-proxy.js';

const adminToken = 'fixture-admin-token-'.repeat(3), userToken = 'fixture-browser-token-'.repeat(3);
const config = readConfig({ AUTH_SECRET_PEPPER: 'update-network-fixture-pepper-'.repeat(3), AUTH_ADMIN_EMAILS: 'admin@example.test', AUTH_SITE_ORIGIN: 'https://app.example.test' });
const clock = Date.parse('2026-10-02T00:00:00Z');
const subscriptionUrl = 'https://subscription.example.test/private-credential/sub?token=fixture-secret';
const secondSubscriptionUrl = 'https://second.example.test/private-secondary?token=fixture-secondary-secret';
function seededState() {
  const state = emptyState();
  for (const [id, email, token, client] of [['admin', 'admin@example.test', adminToken, 'admin'], ['user', 'user@example.test', userToken, 'browser']]) {
    state.users[id] = { id, email, createdAt: new Date(clock).toISOString(), membership: { type: 'none' } };
    state.sessions[digest(config.pepper, 'session', token)] = { id: `${id}-session`, userId: id, client, revokedAt: null };
  }
  return state;
}
const serviceFor = store => createAccountService({ store, config, mailer: { configured: false }, now: () => clock });
const save = (service, input = {}) => service.execute({ action: 'admin-save-update-proxy-config', input: { enabled: true, subscriptionUrl, reason: '更换软件更新订阅', requestId: randomUUID(), ...input }, token: adminToken, client: 'admin' });
function githubFixture() {
  let state = seededState(), version = 1, writes = 0, loseResponse = false;
  const fetchImpl = async (url, options) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (options.method === 'GET') return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    const body = JSON.parse(options.body);
    if (body.sha !== String(version)) return Response.json({}, { status: 409 });
    state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); version++; writes++;
    if (loseResponse) { loseResponse = false; throw Error('response unavailable'); }
    return Response.json({ content: { sha: String(version) } });
  };
  return {
    service: () => serviceFor(new GithubStateStore({ owner: 'fixture', repo: 'private', token: 'fixture', fetchImpl, delay: async () => {} })),
    get state() { return state; }, get writes() { return writes; }, loseNextResponse() { loseResponse = true; },
  };
}

test('unconfigured public read is anonymous, read-only and distinct from administrator disable', async () => {
  const fixture = githubFixture(), service = fixture.service();
  assert.deepEqual((await service.execute({ action: 'update-proxy-config' })).proxyConfig, { enabled: false, subscriptionUrls: [], subscriptionUrl: '', revision: 0, updatedAt: null });
  assert.equal(fixture.writes, 0);
  await assert.rejects(service.execute({ action: 'admin-update-proxy-config' }), { code: 'ACCOUNT_REQUIRED' });
  await assert.rejects(service.execute({ action: 'admin-save-update-proxy-config', input: {}, token: userToken, client: 'browser' }), { code: 'FORBIDDEN' });
  await save(service, { enabled: false, subscriptionUrl: '', expectedRevision: 0 });
  const read = await fixture.service().execute({ action: 'update-proxy-config' });
  assert.equal(read.proxyConfig.enabled, false); assert.equal(read.proxyConfig.revision, 1);
  assert.equal(read.proxyConfig.updatedAt, new Date(clock).toISOString());
});

test('GitHub saves survive a lost response and replay without credentials in audit or operation ledger', async () => {
  const fixture = githubFixture();
  const requestId = randomUUID(), input = { requestId, subscriptionUrls: [subscriptionUrl, secondSubscriptionUrl], expectedRevision: 0, reason: `更新地址 ${subscriptionUrl} 和 ${secondSubscriptionUrl}` };
  fixture.loseNextResponse();
  await assert.rejects(save(fixture.service(), input), { code: 'STORAGE_WRITE_UNCERTAIN' });
  const replay = await save(fixture.service(), input);
  assert.equal(replay.saved, true); assert.equal(replay.proxyConfig.revision, 1);
  assert.equal(replay.replayed, true); assert.equal(replay.appliedRevision, 1);
  assert.equal(fixture.writes, 1); assert.equal(fixture.state.audit.length, 1);
  assert.equal(fixture.state.updateProxyConfig.subscriptionUrl, subscriptionUrl);
  assert.deepEqual(replay.proxyConfig.subscriptionUrls, [subscriptionUrl, secondSubscriptionUrl]);
  for (const collection of [fixture.state.audit, fixture.state.operations]) {
    assert.ok(!JSON.stringify(collection).includes('fixture-secret'));
    assert.ok(!JSON.stringify(collection).includes('private-credential'));
    assert.ok(!JSON.stringify(collection).includes('fixture-secondary-secret'));
    assert.ok(!JSON.stringify(collection).includes('private-secondary'));
  }
  assert.match(fixture.state.audit[0].after.subscriptionUrl, /REDACTED/);
  await assert.rejects(save(fixture.service(), { ...input, enabled: false }), { code: 'REQUEST_ID_REUSED' });
});

test('concurrent administrators cannot overwrite a stale configuration; old replay returns current settings', async () => {
  const fixture = githubFixture(), firstId = randomUUID();
  await save(fixture.service(), { expectedRevision: 0, requestId: firstId });
  const settled = await Promise.allSettled([
    save(fixture.service(), { enabled: false, expectedRevision: 1 }),
    save(fixture.service(), { subscriptionUrl: 'https://replacement.example.test/sub?token=second', expectedRevision: 1 }),
  ]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.find(item => item.status === 'rejected').reason.code, 'PROXY_CONFIG_CONFLICT');
  assert.equal(fixture.state.updateProxyConfig.revision, 2);
  const replay = await save(fixture.service(), { expectedRevision: 0, requestId: firstId });
  assert.equal(replay.appliedRevision, 1); assert.equal(replay.proxyConfig.revision, 2);
  assert.equal(fixture.state.audit.length, 2);
});

test('SQLite update subscription persists across restart and shares authenticated admin API', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'brclio-update-proxy-'));
  const stores = [];
  t.after(async () => { stores.forEach(store => store.close()); await rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'accounts.sqlite');
  const store = new SqliteStateStore({ path: filename }); stores.push(store);
  await store.transaction(state => { Object.assign(state, seededState()); return { value: true }; });
  await save(serviceFor(store), { subscriptionUrls: [subscriptionUrl, secondSubscriptionUrl], expectedRevision: 0 });
  store.close();
  const restarted = new SqliteStateStore({ path: filename, openExisting: true }); stores.push(restarted);
  const result = await serviceFor(restarted).execute({ action: 'admin-update-proxy-config', token: adminToken, client: 'admin' });
  assert.equal(result.proxyConfig.subscriptionUrl, subscriptionUrl); assert.equal(result.proxyConfig.revision, 1);
  assert.deepEqual(result.proxyConfig.subscriptionUrls, [subscriptionUrl, secondSubscriptionUrl]);
  assert.equal((await restarted.read()).state.audit[0].action, 'admin-save-update-proxy-config');
});

test('subscription pools normalize and deduplicate up to eight URLs while retaining legacy state and inputs', async () => {
  assert.deepEqual(subscriptionUrlsValue(['  https://SUBSCRIPTION.example.test:443/sub  ', 'https://subscription.example.test/sub', '', secondSubscriptionUrl]), ['https://subscription.example.test/sub', secondSubscriptionUrl]);
  const eight = Array.from({ length: 8 }, (_, index) => `https://source${index}.example.test/sub`);
  assert.deepEqual(subscriptionUrlsValue([...eight, eight[0]]), eight, 'limit applies after canonical deduplication');
  for (const value of [[...eight, 'https://ninth.example.test/sub'], [], ['  '], [subscriptionUrl, null], subscriptionUrl + '\n' + secondSubscriptionUrl, null]) {
    assert.throws(() => subscriptionUrlsValue(value), { code: 'INVALID_SUBSCRIPTION_URL' });
  }
  assert.deepEqual(subscriptionUrlsValue([], { enabled: false }), []);
  const legacy = { enabled: true, subscriptionUrl, revision: 3, updatedAt: new Date(clock).toISOString() };
  assert.doesNotThrow(() => validateState({ ...seededState(), updateProxyConfig: legacy }));
  assert.deepEqual(updateProxyConfigView({ updateProxyConfig: legacy }).subscriptionUrls, [subscriptionUrl]);
  const fixture = githubFixture(), service = fixture.service();
  const legacySaved = await save(service, { expectedRevision: 0 });
  assert.deepEqual(legacySaved.proxyConfig.subscriptionUrls, [subscriptionUrl]);
  const pool = await save(service, { subscriptionUrls: [secondSubscriptionUrl, subscriptionUrl, secondSubscriptionUrl], subscriptionUrl: 'http://ignored.invalid/sub', expectedRevision: 1 });
  assert.deepEqual(pool.proxyConfig.subscriptionUrls, [secondSubscriptionUrl, subscriptionUrl]);
  assert.equal(pool.proxyConfig.subscriptionUrl, secondSubscriptionUrl, 'plural input is authoritative over the legacy alias');
  const disabled = await save(service, { enabled: false, subscriptionUrls: pool.proxyConfig.subscriptionUrls, expectedRevision: 2 });
  assert.equal(disabled.proxyConfig.enabled, false);
  assert.deepEqual(disabled.proxyConfig.subscriptionUrls, pool.proxyConfig.subscriptionUrls, 'disabling retains the pool');
  await assert.rejects(save(service, { subscriptionUrls: [], expectedRevision: 3 }), { code: 'INVALID_SUBSCRIPTION_URL' });
  await assert.rejects(save(service, { subscriptionUrls: subscriptionUrl, expectedRevision: 3 }), { code: 'INVALID_SUBSCRIPTION_URL' });
  assert.equal(fixture.state.updateProxyConfig.revision, 3, 'invalid pool cannot change durable settings');
});

test('subscription URLs require public HTTPS DNS names and malformed durable configuration fails closed', () => {
  for (const hostname of ['router.home.arpa', 'host.localdomain', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.example`]) {
    assert.throws(() => subscriptionUrlValue(`https://${hostname}/sub`), { code: 'INVALID_SUBSCRIPTION_URL' });
  }
  for (const value of ['http://subscription.example.test/sub', 'https://localhost/sub', 'https://127.0.0.1/sub', 'https://2130706433/sub', 'https://10.0.0.2/sub', 'https://[::1]/sub', 'https://[2606:4700::1111]/sub', 'https://host.local/sub', 'https://user:password@subscription.example.test/sub', 'https://subscription.example.test/sub#secret', 'https://subscription.example.test/sub?bad=\r\nvalue', 'https://subscription.example.test/' + 'a'.repeat(4096), null]) {
    assert.throws(() => subscriptionUrlValue(value), { code: 'INVALID_SUBSCRIPTION_URL' });
  }
  assert.equal(subscriptionUrlValue('  ' , { enabled: false }), '');
  assert.throws(() => subscriptionUrlValue(''), { code: 'INVALID_SUBSCRIPTION_URL' });
  const oldState = seededState(); delete oldState.updateProxyConfig;
  assert.doesNotThrow(() => validateState(oldState));
  for (const bad of [[], { enabled: 'yes' }, { enabled: true, subscriptionUrl, revision: -1, updatedAt: new Date(clock).toISOString() }, { enabled: true, subscriptionUrls: subscriptionUrl, revision: 1, updatedAt: new Date(clock).toISOString() }, { enabled: true, subscriptionUrls: [], revision: 1, updatedAt: new Date(clock).toISOString() }]) {
    assert.throws(() => validateState({ ...seededState(), updateProxyConfig: bad }), { code: 'STORAGE_INVALID' });
  }
});

test('HTTP anonymous config read remains no-store and admin mutation enforces origin and session', async () => {
  const fixture = githubFixture(), handler = createAccountHandler({ service: fixture.service(), config });
  const call = async (action, input = {}, headers = {}) => {
    const result = { headers: {} }, response = { setHeader(name, value) { result.headers[name.toLowerCase()] = value; }, status(code) { result.code = code; return this; }, json(body) { result.body = body; } };
    await handler({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: { action, input } }, response);
    return result;
  };
  const anonymous = await call('update-proxy-config');
  assert.equal(anonymous.code, 200); assert.equal(anonymous.headers['cache-control'], 'no-store');
  const input = { enabled: true, subscriptionUrl, reason: '初始配置订阅', requestId: randomUUID() };
  const forged = await call('admin-save-update-proxy-config', input, { cookie: `${ADMIN_COOKIE}=${adminToken}`, origin: 'https://evil.example.test' });
  assert.equal(forged.code, 403); assert.equal(fixture.writes, 0);
  assert.equal((await call('admin-save-update-proxy-config', input, { origin: config.siteOrigin })).code, 401);
  const saved = await call('admin-save-update-proxy-config', input, { cookie: `${ADMIN_COOKIE}=${adminToken}`, origin: config.siteOrigin });
  assert.equal(saved.code, 200); assert.equal(saved.body.proxyConfig.revision, 1);
  const longUrls = Array.from({ length: 8 }, (_, index) => `https://source${index}.example.test/sub?token=${'a'.repeat(3900)}`);
  const pool = await call('admin-save-update-proxy-config', { ...input, subscriptionUrls: longUrls, expectedRevision: 1, requestId: randomUUID() }, { cookie: `${ADMIN_COOKIE}=${adminToken}`, origin: config.siteOrigin });
  assert.equal(pool.code, 200, 'eight valid subscriptions may exceed the standard 16KB action limit');
  assert.deepEqual(pool.body.proxyConfig.subscriptionUrls, longUrls);
});
