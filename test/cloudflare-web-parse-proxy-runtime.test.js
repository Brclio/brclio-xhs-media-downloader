import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';

test('real private AccountRuntime exposes raw proxy settings only through binding and stores administrator changes encrypted', async t => {
  const origin = 'https://account.example.test', pepper = 'runtime-web-proxy-fixture-pepper-'.repeat(2), token = 'a'.repeat(43);
  const bootstrapUrl = 'https://bootstrap.example.test/private-bootstrap?token=fixture-bootstrap-secret';
  const replacementUrl = 'https://replacement.example.test/private-replacement?token=fixture-replacement-secret';
  const createdAt = new Date().toISOString();
  let state = emptyState(), revision = 1, writes = 0;
  state.users.admin = { id: 'admin', email: 'admin@example.test', createdAt, membership: { type: 'none' } };
  state.sessions[digest(pepper, 'session', token)] = { id: 'admin-session', userId: 'admin', client: 'admin', revokedAt: null, createdAt };
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
    export { AccountRuntime } from './cloudflare/account-runtime.js';
    export default { fetch(request, env) {
      return env.ACCOUNT_RUNTIME.get(env.ACCOUNT_RUNTIME.idFromName('accounts-v1')).fetch(request);
    } };
  ` }, bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'] });
  // The harness deliberately forwards its internal path to exercise the private
  // binding. The deployed public Worker rejects all /__internal/ paths.
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ACCOUNT_RUNTIME: { className: 'AccountRuntime', useSQLite: true } },
    bindings: { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: pepper, AUTH_ADMIN_EMAILS: 'admin@example.test', AUTH_GITHUB_OWNER: 'fixture', AUTH_GITHUB_REPO: 'fixture', AUTH_GITHUB_TOKEN: 'fixture-token', WEB_PARSE_PROXY_SUBSCRIPTION_URL: bootstrapUrl },
    outboundService: async request => {
      assert.equal(new URL(request.url).origin, 'https://api.github.com');
      if (!new URL(request.url).pathname.includes('/contents/')) return Response.json({ private: true });
      if (request.method === 'GET') return Response.json({ sha: String(revision), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
      const update = await request.json();
      if (update.sha !== String(revision)) return Response.json({}, { status: 409 });
      state = JSON.parse(Buffer.from(update.content, 'base64').toString('utf8')); revision++; writes++;
      return Response.json({ content: { sha: String(revision) } });
    },
  }));
  t.after(() => runtime.dispose());
  const internal = () => runtime.dispatchFetch(`${origin}/__internal/web-parse-proxy-settings`);
  const bootstrap = await internal(); assert.equal(bootstrap.status, 200); assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  assert.equal((await bootstrap.json()).proxyConfig.subscriptionUrl, bootstrapUrl); assert.equal(writes, 0);
  const deniedMethod = await runtime.dispatchFetch(`${origin}/__internal/web-parse-proxy-settings`, { method: 'POST' });
  assert.equal(deniedMethod.status, 405); assert.equal(deniedMethod.headers.get('allow'), 'GET');
  const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: `__Host-xhs-admin=${token}` };
  const call = (action, input = {}, override = {}) => runtime.dispatchFetch(`${origin}/api/account`, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify({ action, input }) });
  const input = { enabled: true, subscriptionUrl: replacementUrl, expectedRevision: 0, reason: '更换网页代理订阅', requestId: randomUUID() };
  const csrf = await call('admin-save-web-parse-proxy-config', input, { Origin: 'https://evil.example.test' }); assert.equal(csrf.status, 403); assert.equal(writes, 0);
  const save = await call('admin-save-web-parse-proxy-config', input); assert.equal(save.status, 200);
  const result = await save.json(); assert.equal(result.proxyConfig.subscriptionHost, 'replacement.example.test');
  for (const value of [result, state.webParseProxyConfig, state.audit, state.operations]) {
    assert.ok(!JSON.stringify(value).includes('fixture-replacement-secret')); assert.ok(!JSON.stringify(value).includes('private-replacement'));
  }
  assert.equal(writes, 1); assert.ok(state.webParseProxyConfig.subscriptionCiphertext);
  assert.equal((await (await internal()).json()).proxyConfig.subscriptionUrl, replacementUrl);
  const disabled = await call('admin-save-web-parse-proxy-config', { enabled: false, subscriptionUrl: '', expectedRevision: 1, reason: '临时停用网页代理', requestId: randomUUID() });
  assert.equal(disabled.status, 200);
  const privateDisabled = (await (await internal()).json()).proxyConfig;
  assert.equal(privateDisabled.enabled, false); assert.equal(privateDisabled.subscriptionUrl, replacementUrl, 'deployment bootstrap cannot override a saved disabled setting');
  const publicRead = await call('admin-web-parse-proxy-config'); assert.equal(publicRead.status, 200);
  assert.equal((await publicRead.json()).proxyConfig.maskedSubscriptionUrl, 'https://replacement.example.test/[REDACTED]');
});
