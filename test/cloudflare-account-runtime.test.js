import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';

test('real SQLite Durable Object preserves account auth and validates near-8-MiB feedback through four batches', async t => {
  const origin = 'https://account.example.test';
  const pepper = 'isolated-runtime-fixture-pepper-'.repeat(2);
  const token = 'a'.repeat(43), desktopToken = 'b'.repeat(43);
  const createdAt = new Date().toISOString();
  const feedbackId = '12345678-1234-1234-1234-123456789012';
  const line = JSON.stringify({ at: createdAt, level: 'info', event: 'fixture.download', message: 'a'.repeat(900) }) + '\n';
  const chunk = line.repeat(Math.floor(131072 / Buffer.byteLength(line)));
  const chunks = Array(64).fill(chunk);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let state = emptyState(), version = 1;
  state.users.admin = { id: 'admin', email: 'admin@example.test', createdAt, membership: { type: 'permanent' } };
  state.users.desktop = { id: 'desktop', email: 'user@example.test', createdAt, membership: { type: 'none' } };
  state.sessions[digest(pepper, 'session', token)] = { id: 'admin-session', userId: 'admin', client: 'admin', revokedAt: null, createdAt };
  state.sessions[digest(pepper, 'session', desktopToken)] = { id: 'desktop-session', userId: 'desktop', client: 'desktop', revokedAt: null, createdAt, publicKey: publicKey.export({ format: 'pem', type: 'spki' }) };
  state.feedback[feedbackId] = {
    id: feedbackId, userId: 'desktop', title: 'runtime fixture', description: 'full size fixture verification', category: 'other',
    appVersion: 'test', platform: 'darwin', arch: 'arm64', status: 'uploading', createdAt, updatedAt: createdAt, submittedAt: null,
    inputHash: 'fixed-manifest', requestKey: 'fixed-request',
    log: { partCount: chunks.length, totalBytes: Buffer.byteLength(chunks.join('')), sha256: sha256(chunks.join('')), firstTimestamp: createdAt, lastTimestamp: createdAt, truncated: false, parts: chunks.map(content => ({ bytes: Buffer.byteLength(content), sha256: sha256(content) })) },
  };
  assert.ok(state.feedback[feedbackId].log.totalBytes > 8_000_000);
  const calls = [];
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
      export { AccountRuntime } from './cloudflare/account-runtime.js';
      export default { fetch(request, env) {
        return env.ACCOUNT_RUNTIME.get(env.ACCOUNT_RUNTIME.idFromName('accounts-v1')).fetch(request);
      } };
    ` },
    bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'],
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ACCOUNT_RUNTIME: { className: 'AccountRuntime', useSQLite: true } },
    bindings: { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: pepper, AUTH_ADMIN_EMAILS: 'admin@example.test', AUTH_GITHUB_OWNER: 'fixture', AUTH_GITHUB_REPO: 'fixture', AUTH_GITHUB_TOKEN: 'fixture-token' },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push({ path: url.pathname, method: request.method });
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-token');
      if (url.pathname === '/graphql') {
        const { variables } = await request.json();
        const repository = { isPrivate: true };
        for (const key of Object.keys(variables).filter(key => key.startsWith('path'))) {
          const index = Number(key.slice(4)), content = chunks[index];
          repository[`part${index}`] = { oid: `part-${index}`, byteSize: Buffer.byteLength(content), isBinary: false, isTruncated: false, text: content };
        }
        return Response.json({ data: { repository } });
      }
      if (!url.pathname.includes('/contents/')) return Response.json({ private: true });
      if (request.method === 'GET') return Response.json({ sha: String(version), encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') });
      const update = await request.json();
      if (update.sha !== String(version)) return Response.json({}, { status: 409 });
      state = JSON.parse(Buffer.from(update.content, 'base64').toString('utf8'));
      version++;
      return Response.json({ content: { sha: String(version) } });
    },
  }));
  t.after(() => runtime.dispose());
  const call = (body, headers = {}) => runtime.dispatchFetch(`${origin}/api/account`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const malformed = await call('{');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  const oversized = await call('x'.repeat(1_600_001));
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'REQUEST_TOO_LARGE');
  const csrf = await call({ action: 'me', input: {} }, { Cookie: `__Host-xhs-admin=${token}` });
  assert.equal(csrf.status, 403);
  assert.equal(calls.length, 0, 'invalid requests must not reach storage');
  const me = await call({ action: 'me', input: {} }, { Origin: origin, Cookie: `__Host-xhs-admin=${token}` });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).account.user.id, 'admin');
  assert.equal(me.headers.get('cache-control'), 'no-store');

  const input = { feedbackId, requestId: 'fixture-finalize-request-123' };
  const timestamp = Date.now(), nonce = 'fixture-nonce-0123456789';
  const signature = sign(null, Buffer.from(`feedback-finalize\n${timestamp}\n${nonce}\n${JSON.stringify(input)}\n${desktopToken}`), privateKey).toString('base64');
  const finalized = await call({ action: 'feedback-finalize', input, proof: { timestamp, nonce, signature } }, { Authorization: `Bearer ${desktopToken}` });
  assert.equal(finalized.status, 200);
  assert.equal((await finalized.json()).feedback.status, 'new');
  assert.equal(calls.filter(call => call.path === '/graphql').length, 4);
  assert.equal(state.feedback[feedbackId].status, 'new');
  assert.ok(state.feedback[feedbackId].submittedAt);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);

  const logout = await call({ action: 'logout', input: {} }, { Origin: origin, Cookie: `__Host-xhs-admin=${token}` });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.ok(state.sessions[digest(pepper, 'session', token)].revokedAt);
});
