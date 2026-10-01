import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';
import { BROWSER_COOKIE } from '../api/account.js';

test('real Cloudflare account and parse objects enforce membership and encrypted original download tickets', async t => {
  const pepper = 'member-runtime-only-pepper-'.repeat(2), token = 'c'.repeat(43);
  const origin = 'https://member.example.test', noteId = 'abcdef1234567890abcdef12';
  const upload = 'https://sns-video-bd.xhscdn.com/spectrum/upload';
  const state = emptyState();
  state.users.member = { id: 'member', email: 'member@example.test', createdAt: new Date().toISOString(), membership: { type: 'permanent' } };
  state.sessions[digest(pepper, 'session', token)] = { id: 'session', userId: 'member', client: 'browser', revokedAt: null };
  let sourceCalls = 0;
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: { note: {
    noteId, type: 'video', title: 'original', video: { consumer: { originVideoKey: 'spectrum/upload' } },
  } } } } })}</script>`;
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/worker.js', import.meta.url))],
    bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'] });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ACCOUNT_RUNTIME: { className: 'AccountRuntime', useSQLite: true }, PARSE_RUNTIME: { className: 'ParseRuntime', useSQLite: true } },
    bindings: { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: pepper, AUTH_GITHUB_OWNER: 'fixture', AUTH_GITHUB_REPO: 'fixture', AUTH_GITHUB_TOKEN: 'fixture-token' },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.origin === 'https://api.github.com') {
        assert.equal(request.headers.get('authorization'), 'Bearer fixture-token');
        return url.pathname.includes('/contents/') ? Response.json({ sha: '1', encoding: 'base64', content: Buffer.from(JSON.stringify(state)).toString('base64') }) : Response.json({ private: true });
      }
      sourceCalls++;
      assert.equal(request.headers.get('cookie'), null);
      if (url.origin === 'https://www.xiaohongshu.com') return new Response(html);
      assert.equal(request.url, upload);
      const range = request.headers.get('range');
      const [start, end] = range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
      return new Response(new Uint8Array([1, 2, 3, 4]).slice(start, end + 1), { status: 206, headers: {
        'content-range': `bytes ${start}-${end}/4`, 'content-length': String(end - start + 1), 'content-type': 'video/mp4',
      } });
    },
  }));
  t.after(() => runtime.dispose());
  const post = cookie => runtime.dispatchFetch(`${origin}/api/member_video`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `${BROWSER_COOKIE}=${token}` } : {}) }, body: JSON.stringify({ text: `https://www.xiaohongshu.com/explore/${noteId}` }) });
  assert.equal((await post(false)).status, 401); assert.equal(sourceCalls, 0);
  const response = await post(true); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(JSON.stringify(data).includes(upload), false);
  const ticket = data.videos[0].url.slice('member-video:'.length);
  const get = query => runtime.dispatchFetch(`${origin}/api/member_video?ticket=${ticket}&${query}`, { headers: { Cookie: `${BROWSER_COOKIE}=${token}` } });
  const meta = await get('action=meta'); assert.equal(meta.status, 200); assert.equal((await meta.json()).size, 4);
  const chunk = await get('action=chunk&start=0&end=3'); assert.equal(chunk.status, 200);
  assert.deepEqual([...new Uint8Array(await chunk.arrayBuffer())], [1, 2, 3, 4]);
  state.users.member.membership = { type: 'none' };
  const before = sourceCalls; assert.equal((await get('action=chunk&start=0&end=3')).status, 403); assert.equal(sourceCalls, before);
});
