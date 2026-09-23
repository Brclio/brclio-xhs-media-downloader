import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { PARSE_FALLBACK_ORIGIN } from '../cloudflare/parse-fallback.js';

test('real SQLite ParseRuntime handles large native HTML and preserves bounded same-engine fallback', async t => {
  const noteId = '1234567890abcdef12345678';
  const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
  const note = { noteId, title: 'large native fixture', desc: 'exact note', imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/fixture-image-token' }] };
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: { note } } }, padding: 'x'.repeat(5 * 1024 * 1024) })}</script>`;
  assert.ok(Buffer.byteLength(html) < 6 * 1024 * 1024);
  const external = [], python = [];
  let fallbackStatus = 200;
  const payload = engine => ({ success: true, engine, images: [{ token: 'fixture-image-token' }], videos: [], count: 1, videoCount: 0 });
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
      export { ParseRuntime } from './cloudflare/parse-runtime.js';
      export default { fetch(request, env) {
        return env.PARSE_RUNTIME.get(env.PARSE_RUNTIME.idFromName('parsing-v1')).fetch(request);
      } };
    ` },
    bundle: true, format: 'esm', write: false, platform: 'neutral',
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-22',
    durableObjects: { PARSE_RUNTIME: { className: 'ParseRuntime', useSQLite: true } },
    bindings: { XHS_PARSE_FALLBACK_ORIGIN: PARSE_FALLBACK_ORIGIN },
    serviceBindings: { PYTHON_API: async request => {
      const body = await request.text();
      python.push({ method: request.method, url: request.url, body });
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      if (JSON.parse(body).text.includes('fallback')) return Response.json({ success: false, engine: 'python', message: 'fixture native failure' }, { status: 500 });
      return Response.json(payload('python'), { headers: { 'X-XHS-Engine': 'python' } });
    } },
    outboundService: async request => {
      const url = new URL(request.url);
      external.push({ url: request.url, method: request.method, headers: new Headers(request.headers), body: await request.text() });
      if (url.origin === PARSE_FALLBACK_ORIGIN) {
        if (fallbackStatus !== 200) return new Response(null, { status: fallbackStatus, headers: { Location: 'https://credential-trap.example.test/' } });
        return Response.json(payload(url.pathname === '/api/python_parse' ? 'python' : 'node'), { headers: { 'Set-Cookie': 'trap=1' } });
      }
      assert.equal(url.origin, 'https://www.xiaohongshu.com');
      return new Response(url.searchParams.has('fallback') ? '<html>source unavailable</html>' : html, { headers: { 'Content-Type': 'text/html' } });
    },
  }));
  t.after(() => runtime.dispose());
  const call = (path, text, extra = {}) => runtime.dispatchFetch(`https://fixture.example.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'private=do-not-forward', Authorization: 'Bearer do-not-forward' },
    body: JSON.stringify({ text, private: 'do-not-forward', ...extra }),
  });

  const native = await call('/api/parse', noteUrl);
  assert.equal(native.status, 200);
  const nativeBody = await native.json();
  assert.equal(nativeBody.engine, 'node');
  assert.equal(nativeBody.title, note.title);
  assert.equal(nativeBody.images[0].token, 'fixture-image-token');
  assert.equal(external.length, 1, 'successful native parsing never invokes fallback');

  const pythonNative = await call('/api/python_parse?preserved=1', 'https://sns-webpic-qc.xhscdn.com/fixture-image-token');
  assert.equal(pythonNative.status, 200);
  assert.equal((await pythonNative.json()).engine, 'python');
  assert.ok(python.at(-1).url.endsWith('/api/python_parse?preserved=1'));

  for (const [path, engine] of [['/api/parse', 'node'], ['/api/python_parse', 'python']]) {
    const response = await call(path, `share text ${noteUrl}?fallback=1`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).engine, engine);
    assert.equal(response.headers.get('x-xhs-parse-backend'), 'vercel-fallback');
    assert.equal(response.headers.get('set-cookie'), null);
    const forwarded = external.at(-1);
    assert.equal(forwarded.url, PARSE_FALLBACK_ORIGIN + path);
    assert.equal(forwarded.headers.get('authorization'), null);
    assert.equal(forwarded.headers.get('cookie'), null);
    assert.deepEqual(JSON.parse(forwarded.body), { text: `${noteUrl}?fallback=1` });
  }

  fallbackStatus = 302;
  const rejected = await call('/api/python_parse', `${noteUrl}?fallback=1`);
  assert.equal(rejected.status, 500);
  assert.equal((await rejected.json()).message, 'fixture native failure');
  const before = external.length + python.length;
  for (const path of ['/api/parse', '/api/python_parse']) {
    const oversized = await call(path, 'x'.repeat(16_384));
    assert.equal(oversized.status, 413);
    const method = await runtime.dispatchFetch(`https://fixture.example.test${path}`);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'POST');
  }
  assert.equal(external.length + python.length, before + 1, 'only the Python method guard reaches its binding');
  assert.equal((await call('/api/account', 'unused')).status, 404);
});
