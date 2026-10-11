import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GithubStateStore, emptyState, validateState } from '../server/auth/store.js';
import { SqliteStateStore } from '../server/auth/sqlite-store.js';
import { createAccountService } from '../server/auth/service.js';
import { readConfig } from '../server/auth/config.js';
import { digest } from '../server/auth/crypto.js';
import { createAccountHandler, ADMIN_COOKIE } from '../api/account.js';
import { encryptWebParseSubscription, webParseSubscriptionUrlValue, webParseProxyPrivateConfig, webParseProxyAdminView } from '../server/auth/web-parse-proxy.js';
import { loadWebParseProxySettings } from '../cloudflare/account-runtime.js';

const adminToken = 'fixture-admin-token-'.repeat(3), userToken = 'fixture-browser-token-'.repeat(3);
const env = { AUTH_SECRET_PEPPER: 'web-parse-fixture-pepper-'.repeat(3), AUTH_ADMIN_EMAILS: 'admin@example.test', AUTH_SITE_ORIGIN: 'https://app.example.test' };
const config = readConfig(env), clock = Date.parse('2026-10-11T00:00:00Z');
const subscriptionUrl = 'https://subscription.example.test/private-credential/sub?token=fixture-web-secret';
const replacement = 'https://replacement.example.test/private-secondary?token=fixture-new-secret';
function seededState() {
  const state = emptyState();
  for (const [id, email, token, client] of [['admin', 'admin@example.test', adminToken, 'admin'], ['user', 'user@example.test', userToken, 'browser']]) {
    state.users[id] = { id, email, createdAt: new Date(clock).toISOString(), membership: { type: 'none' } };
    state.sessions[digest(config.pepper, 'session', token)] = { id: `${id}-session`, userId: id, client, revokedAt: null };
  }
  state.updateProxyConfig = { enabled: true, subscriptionUrls: ['https://updates.example.test/sub?token=separate-update-secret'], subscriptionUrl: 'https://updates.example.test/sub?token=separate-update-secret', revision: 3, updatedAt: new Date(clock).toISOString() };
  return state;
}
const serviceFor = (store, serviceConfig = config) => createAccountService({ store, config: serviceConfig, mailer: { configured: false }, now: () => clock });
const save = (service, input = {}) => service.execute({ action: 'admin-save-web-parse-proxy-config', input: { enabled: true, subscriptionUrl, reason: '更换网页抓取订阅', expectedRevision: 0, requestId: randomUUID(), ...input }, token: adminToken, client: 'admin' });
function fixture(serviceConfig = config) {
  let state = seededState(), version = 1, writes = 0, loseResponse = false;
  const store = new GithubStateStore({ owner: 'fixture', repo: 'private', token: 'fixture', delay: async () => {}, fetchImpl: async (url, options) => {
    if (!url.includes('/contents/')) return Response.json({ private: true });
    if (options.method === 'GET') return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
    const body = JSON.parse(options.body);
    if (body.sha !== String(version)) return Response.json({}, { status: 409 });
    state = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); version++; writes++;
    if (loseResponse) { loseResponse = false; throw Error('response unavailable'); }
    return Response.json({ content: { sha: String(version) } });
  } });
  return { store, service: () => serviceFor(store, serviceConfig), get state() { return state; }, get writes() { return writes; }, loseNextResponse() { loseResponse = true; } };
}

function noSubscriptionSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const secret of ['fixture-web-secret', 'private-credential', 'fixture-new-secret', 'private-secondary']) assert.ok(!serialized.includes(secret), 'credentials must not appear in public responses, state, ledger or audit');
}

test('web proxy defaults, administrator reads and native update configuration remain independent', async () => {
  const f = fixture(), s = f.service();
  const result = await s.execute({ action: 'admin-web-parse-proxy-config', token: adminToken, client: 'admin' });
  assert.deepEqual(result.proxyConfig, { enabled: false, configured: false, subscriptionHost: '', maskedSubscriptionUrl: '', revision: 0, updatedAt: null });
  await assert.rejects(s.execute({ action: 'admin-web-parse-proxy-config' }), { code: 'ACCOUNT_REQUIRED' });
  await assert.rejects(s.execute({ action: 'web-parse-proxy-config' }), { code: 'ACCOUNT_REQUIRED' });
  await assert.rejects(s.execute({ action: 'admin-web-parse-proxy-config', token: userToken, client: 'browser' }), { code: 'FORBIDDEN' });
  await assert.rejects(s.execute({ action: 'admin-save-web-parse-proxy-config', input: {}, token: userToken, client: 'browser' }), { code: 'FORBIDDEN' });
  const updates = structuredClone(f.state.updateProxyConfig);
  const saved = await save(s);
  assert.equal(saved.proxyConfig.configured, true); assert.equal(saved.proxyConfig.subscriptionHost, 'subscription.example.test');
  assert.equal(saved.proxyConfig.maskedSubscriptionUrl, 'https://subscription.example.test/[REDACTED]');
  assert.deepEqual(f.state.updateProxyConfig, updates);
  assert.deepEqual((await s.execute({ action: 'update-proxy-config' })).proxyConfig.subscriptionUrls, updates.subscriptionUrls);
  assert.equal(f.writes, 1); noSubscriptionSecrets(saved); noSubscriptionSecrets(f.state);
  assert.equal((await loadWebParseProxySettings(env, { store: f.store })).subscriptionUrl, subscriptionUrl);
});

test('encrypted persisted configuration replays uncertain writes without secret-bearing ledger or audit', async () => {
  const f = fixture(), id = randomUUID(), input = { requestId: id, reason: `URL ${subscriptionUrl} standalone fixture-web-secret` };
  f.loseNextResponse();
  await assert.rejects(save(f.service(), input), { code: 'STORAGE_WRITE_UNCERTAIN' });
  const result = await save(f.service(), input);
  assert.equal(result.replayed, true); assert.equal(result.appliedRevision, 1); assert.equal(f.writes, 1);
  assert.equal(f.state.webParseProxyConfig.subscriptionUrl, undefined);
  noSubscriptionSecrets(f.state); noSubscriptionSecrets(result);
  assert.equal(f.state.audit[0].after.subscriptionChanged, true);
  await assert.rejects(save(f.service(), { ...input, enabled: false }), { code: 'REQUEST_ID_REUSED' });
});

test('bootstrap secret is used only before an explicit saved setting; blank input preserves credentials', async () => {
  const bootstrapConfig = readConfig({ ...env, WEB_PARSE_PROXY_SUBSCRIPTION_URL: subscriptionUrl });
  const f = fixture(bootstrapConfig), s = f.service();
  assert.deepEqual(webParseProxyPrivateConfig(f.state, bootstrapConfig), { enabled: true, subscriptionUrl, revision: 0, updatedAt: null });
  const read = await s.execute({ action: 'admin-web-parse-proxy-config', token: adminToken, client: 'admin' });
  assert.equal(read.proxyConfig.configured, true); noSubscriptionSecrets(read);
  await save(s, { enabled: false, subscriptionUrl: '' });
  assert.equal(webParseProxyPrivateConfig(f.state, bootstrapConfig).enabled, false, 'saved disable cannot be revived by deployment bootstrap');
  assert.equal(webParseProxyPrivateConfig(f.state, bootstrapConfig).subscriptionUrl, subscriptionUrl);
  await save(s, { enabled: true, subscriptionUrl: '', expectedRevision: 1 });
  assert.equal(webParseProxyPrivateConfig(f.state, bootstrapConfig).subscriptionUrl, subscriptionUrl);
  assert.equal(f.state.audit[1].after.subscriptionChanged, false);
  await save(s, { subscriptionUrl: replacement, expectedRevision: 2 });
  assert.equal(webParseProxyPrivateConfig(f.state, bootstrapConfig).subscriptionUrl, replacement);
  noSubscriptionSecrets(f.state);
  const disabled = fixture(bootstrapConfig);
  await save(disabled.service(), { enabled: false, subscriptionUrl: '' });
  const noBootstrap = { ...bootstrapConfig, webParseProxySubscriptionUrl: '' };
  assert.equal(webParseProxyPrivateConfig(disabled.state, noBootstrap).enabled, false);
});

test('stale saves conflict, invalid requests never change durable settings and replay reads latest revision', async () => {
  const f = fixture(), id = randomUUID(); await save(f.service(), { requestId: id });
  await assert.rejects(save(f.service(), { expectedRevision: 0, subscriptionUrl: replacement }), { code: 'PROXY_CONFIG_CONFLICT' });
  for (const input of [{ enabled: 'yes' }, { subscriptionUrl: null }, { subscriptionUrl: 'https://127.0.0.1/sub' }, { subscriptionUrl: 'https://public.example.test:444/sub' }]) {
    await assert.rejects(save(f.service(), { expectedRevision: 1, ...input }));
  }
  assert.equal(f.writes, 1);
  await save(f.service(), { expectedRevision: 1, subscriptionUrl: replacement });
  const replay = await save(f.service(), { requestId: id });
  assert.equal(replay.replayed, true); assert.equal(replay.appliedRevision, 1); assert.equal(replay.proxyConfig.revision, 2);
  assert.equal(replay.proxyConfig.subscriptionHost, 'replacement.example.test'); noSubscriptionSecrets(replay);
  await assert.rejects(save(fixture().service(), { enabled: true, subscriptionUrl: '' }), { code: 'INVALID_SUBSCRIPTION_URL' });
  const empty = fixture(); await save(empty.service(), { enabled: false, subscriptionUrl: '' });
  assert.equal(empty.state.webParseProxyConfig.subscriptionCiphertext, null);
});

test('HTTPS public DNS, default port and bounded URL validation reject private and malformed sources', () => {
  assert.equal(webParseSubscriptionUrlValue('  https://SUBSCRIPTION.example.test:443/sub  '), 'https://subscription.example.test/sub');
  assert.equal(webParseSubscriptionUrlValue('', { enabled: false }), '');
  for (const value of ['http://subscription.example.test/sub', 'https://localhost/sub', 'https://127.0.0.1/sub', 'https://2130706433/sub', 'https://10.0.0.2/sub', 'https://[::1]/sub', 'https://host.local/sub', 'https://router.home.arpa/sub', 'https://host.internal/sub', 'https://user:password@public.example.test/sub', 'https://public.example.test/sub#secret', 'https://public.example.test:8443/sub', 'https://public.example.test/sub?bad=\r\nvalue', 'https://public.example.test/' + 'a'.repeat(4096), null]) assert.throws(() => webParseSubscriptionUrlValue(value), { code: 'INVALID_SUBSCRIPTION_URL' });
  const legacy = seededState(); delete legacy.webParseProxyConfig; assert.doesNotThrow(() => validateState(legacy));
  for (const value of [[], {}, { enabled: true, subscriptionUrl, revision: 1, updatedAt: new Date(clock).toISOString() }, { enabled: true, subscriptionCiphertext: null, revision: 1, updatedAt: new Date(clock).toISOString() }]) assert.throws(() => validateState({ ...seededState(), webParseProxyConfig: value }), { code: 'STORAGE_INVALID' });
});

test('AES-GCM rejects wrong keys, ciphertext tampering and unauthenticated metadata', () => {
  const encrypted = encryptWebParseSubscription(subscriptionUrl, config);
  const state = { webParseProxyConfig: { enabled: true, subscriptionCiphertext: encrypted, revision: 1, updatedAt: new Date(clock).toISOString() } };
  assert.equal(webParseProxyPrivateConfig(state, config).subscriptionUrl, subscriptionUrl);
  noSubscriptionSecrets(state);
  assert.throws(() => webParseProxyPrivateConfig(state, { ...config, pepper: 'wrong-encryption-key-'.repeat(3) }), { code: 'STORAGE_INVALID' });
  const corrupted = structuredClone(state); corrupted.webParseProxyConfig.subscriptionCiphertext.content = 'AAAA' + encrypted.content.slice(4);
  assert.throws(() => webParseProxyPrivateConfig(corrupted, config), { code: 'STORAGE_INVALID' });
  assert.notDeepEqual(encryptWebParseSubscription(subscriptionUrl, config), encrypted, 'fresh nonce for every encryption');
});

test('administrator HTTP reads and writes require same-origin admin session and never disclose credentials', async () => {
  const f = fixture(), handler = createAccountHandler({ service: f.service(), config });
  const call = async (action, input = {}, headers = {}) => {
    const result = { headers: {} }, response = { setHeader(name, value) { result.headers[name.toLowerCase()] = value; }, status(code) { result.code = code; return this; }, json(body) { result.body = body; } };
    await handler({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: { action, input } }, response); return result;
  };
  const input = { enabled: true, subscriptionUrl, reason: '网页订阅配置', expectedRevision: 0, requestId: randomUUID() };
  for (const action of ['admin-web-parse-proxy-config', 'admin-save-web-parse-proxy-config']) {
    for (const origin of ['', 'null', 'https://evil.example.test']) assert.equal((await call(action, input, { cookie: `${ADMIN_COOKIE}=${adminToken}`, origin })).code, 403);
    assert.equal((await call(action, input, { origin: config.siteOrigin })).code, 401);
    assert.equal((await call(action, input, { cookie: `${ADMIN_COOKIE}=${adminToken}`, origin: config.siteOrigin, 'sec-fetch-site': 'cross-site' })).code, 403);
  }
  assert.equal(f.writes, 0);
  const headers = { cookie: `${ADMIN_COOKIE}=${adminToken}`, origin: config.siteOrigin };
  const saved = await call('admin-save-web-parse-proxy-config', input, headers); assert.equal(saved.code, 200); noSubscriptionSecrets(saved.body);
  const read = await call('admin-web-parse-proxy-config', {}, headers); assert.equal(read.code, 200); assert.equal(read.headers['cache-control'], 'no-store'); noSubscriptionSecrets(read.body);
  const ambiguous = await call('admin-web-parse-proxy-config', {}, { ...headers, authorization: `Bearer ${adminToken}` }); assert.equal(ambiguous.code, 400);
});

test('encrypted web proxy persists across standalone storage restart and retains admin-only reads', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'brclio-web-proxy-')), stores = [];
  t.after(async () => { stores.forEach(store => store.close()); await rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'accounts.sqlite'), store = new SqliteStateStore({ path: filename }); stores.push(store);
  await store.transaction(state => { Object.assign(state, seededState()); return { value: true }; });
  await save(serviceFor(store)); store.close();
  const restarted = new SqliteStateStore({ path: filename, openExisting: true }); stores.push(restarted);
  const read = await serviceFor(restarted).execute({ action: 'admin-web-parse-proxy-config', token: adminToken, client: 'admin' });
  assert.equal(read.proxyConfig.configured, true); assert.equal(read.proxyConfig.revision, 1); noSubscriptionSecrets(read);
  assert.equal((await loadWebParseProxySettings(env, { store: restarted })).subscriptionUrl, subscriptionUrl);
  noSubscriptionSecrets((await restarted.read()).state);
});
