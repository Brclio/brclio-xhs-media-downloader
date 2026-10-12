import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';
import { AVATAR_MAX_BYTES, AVATAR_PART_BYTES } from '../server/auth/avatar.js';
import { GithubAvatarFixture } from './helpers/github-avatar-fixture.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

test('real Worker and existing AccountRuntime preserve 100 MiB in private GitHub with every request below 50 GitHub calls', async t => {
  const origin = 'https://avatars.example.test', pepper = 'isolated-github-avatar-fixture-'.repeat(2);
  const ownerId = randomUUID(), adminId = randomUUID(), ownerToken = 'o'.repeat(43), adminToken = 'a'.repeat(43);
  const state = emptyState();
  for (const [id, email] of [[ownerId, 'owner@example.test'], [adminId, 'admin@example.test']]) state.users[id] = { id, email, createdAt: new Date().toISOString(), membership: { type: 'none' } };
  for (const [token, id, client] of [[ownerToken, ownerId, 'browser'], [adminToken, adminId, 'admin']]) state.sessions[digest(pepper, 'session', token)] = { id: randomUUID(), userId: id, client, revokedAt: null };
  const github = new GithubAvatarFixture({ files: { 'state/accounts.json': JSON.stringify(state) } });
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/worker.js', import.meta.url))], bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ACCOUNT_RUNTIME: { className: 'AccountRuntime', useSQLite: true } },
    bindings: { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: pepper, AUTH_ADMIN_EMAILS: 'admin@example.test', AUTH_GITHUB_OWNER: github.owner, AUTH_GITHUB_REPO: github.repo, AUTH_GITHUB_TOKEN: github.token },
    outboundService: async request => {
      try { return await github.handle(request); }
      catch (error) { t.diagnostic(error.stack); return Response.json({}, { status: 500 }); }
    },
  }));
  t.after(() => runtime.dispose());
  const counts = [];
  const dispatch = async (url, input, read = response => response.json()) => {
    const before = github.calls.length, response = await runtime.dispatchFetch(url, input), body = await read(response), count = github.calls.length - before;
    counts.push(count); assert.ok(count <= 50, `${url}: ${count} GitHub calls`);
    return { response, body, count };
  };
  const call = async (action, input = {}, admin = false, expectedStatus = 200) => {
    const reply = await dispatch(`${origin}/api/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
      Cookie: `__Host-xhs-${admin ? 'admin' : 'browser'}=${admin ? adminToken : ownerToken}` }, body: JSON.stringify({ action, input }) });
    assert.equal(reply.response.status, expectedStatus, JSON.stringify(reply.body)); return reply;
  };
  const put = async (upload, part, bytes) => {
    const url = new URL(upload.url, origin); url.searchParams.set('part', String(part));
    const reply = await dispatch(url.href, { method: 'PUT', body: bytes });
    assert.equal(reply.response.status, 200, JSON.stringify(reply.body));
  };
  const begun = (await call('avatar-begin', { expectedUserId: ownerId, name: '私密 原图 100MiB.png', contentType: 'image/png', bytes: AVATAR_MAX_BYTES })).body;
  assert.equal(begun.upload.partCount, 34);
  const expected = createHash('sha256');
  for (let index = 0; index < begun.upload.partCount; index++) {
    const bytes = Buffer.alloc(Math.min(AVATAR_PART_BYTES, AVATAR_MAX_BYTES - index * AVATAR_PART_BYTES), (index * 17) % 256);
    if (!index) PNG.copy(bytes);
    expected.update(bytes); await put(begun.upload, index, bytes);
  }
  await put(begun.upload, 'thumbnail', PNG);
  const originalHash = expected.digest('hex');
  // A committed collection must survive a subsequent account pointer write
  // failure and be recoverable with the same completed upload ID.
  let failAccount = true;
  github.beforeRequest = ({ route, request }) => {
    if (failAccount && route === '/contents/state/accounts.json' && request.method === 'PUT') { failAccount = false; return Response.json({}, { status: 503 }); }
  };
  const uncertain = await call('avatar-complete', { expectedUserId: ownerId, uploadId: begun.upload.id }, false, 503);
  assert.ok(uncertain.count <= 48); assert.ok([...github.files.keys()].some(path => path.includes('/collection/') && path.endsWith(`${begun.upload.id}.json`)));
  github.beforeRequest = null;
  const beforeRetry = github.calls.length;
  const completed = (await call('avatar-complete', { expectedUserId: ownerId, uploadId: begun.upload.id })).body;
  assert.equal(github.calls.slice(beforeRetry).filter(call => call.route.includes('/originals/')).length, 0, 'confirmed original SHA avoids rereading all chunks on recovery');
  assert.match(completed.profile.avatar.url, /^\/api\/account_avatar\?/);
  const thumbnail = await dispatch(new URL(completed.profile.avatar.url, origin).href, undefined, async response => Buffer.from(await response.arrayBuffer()));
  assert.equal(thumbnail.response.headers.get('content-type'), 'image/png'); assert.deepEqual(thumbnail.body, PNG);
  const original = (await call('avatar-original', { expectedUserId: ownerId })).body;
  assert.equal(original.sha256, originalHash);
  const download = await dispatch(new URL(original.url, origin).href, undefined, async response => {
    const hash = createHash('sha256'), reader = response.body.getReader(); let bytes = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; hash.update(next.value); }
    return { bytes, sha256: hash.digest('hex') };
  });
  assert.deepEqual(download.body, { bytes: AVATAR_MAX_BYTES, sha256: originalHash }); assert.equal(download.count, 36);
  assert.equal(download.response.headers.get('content-type'), 'application/octet-stream');
  await call('avatar-select', { expectedUserId: ownerId, builtinId: 'avatar-050' });
  const list = (await call('admin-avatar-list', { limit: 50 }, true)).body;
  assert.equal(list.avatars.length, 1); assert.equal(list.avatars[0].sha256, originalHash);
  assert.equal((await runtime.dispatchFetch(`${origin}/__internal/avatar-cleanup`)).status, 404);
  assert.equal((await runtime.dispatchFetch(`${origin}/api/account_avatar?action=original&id=${begun.upload.id}`)).status, 403);
  assert.ok(github.files.get('state/accounts.json').length < 10_000);
  assert.equal([...github.files.keys()].filter(path => path.startsWith('avatars/uploads/')).length, 0);
  assert.equal([...github.files.keys()].filter(path => path.startsWith('avatars/originals/')).length, 34);
  assert.ok(github.calls.filter(call => call.route.includes('/originals/') && call.method === 'GET').every(call => ['application/vnd.github.raw+json', 'application/vnd.github.object+json'].includes(call.accept)));
  const health = await (await runtime.dispatchFetch(`${origin}/api/health`)).json(); assert.equal(health.avatars.customUploads, true);
  t.diagnostic(`100 MiB SHA-256 ${originalHash}; complete ${uncertain.count} calls, original streaming ${download.count}, max request ${Math.max(...counts)}`);
});
