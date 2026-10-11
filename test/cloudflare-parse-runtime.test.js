import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

test('real SQLite ParseRuntime keeps native parsing and failures inside Cloudflare', async t => {
  const noteId = '1234567890abcdef12345678';
  const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
  const note = { noteId, title: 'large native fixture', desc: 'exact note', imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/fixture-image-token' }] };
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: { note } } }, padding: 'x'.repeat(5 * 1024 * 1024) })}</script>`;
  assert.ok(Buffer.byteLength(html) < 6 * 1024 * 1024);
  const external = [], python = [];
  const payload = engine => ({ success: true, engine, images: [{ token: 'fixture-image-token' }], videos: [], count: 1, videoCount: 0 });
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
      export { ParseRuntime } from './cloudflare/parse-runtime.js';
      export default { fetch(request, env) {
        return env.PARSE_RUNTIME.get(env.PARSE_RUNTIME.idFromName('parsing-v1')).fetch(request);
      } };
    ` },
    bundle: true, format: 'esm', write: false, platform: 'node', external: ['node:*', 'cloudflare:*'],
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PARSE_RUNTIME: { className: 'ParseRuntime', useSQLite: true } },
    // Stale deployed configuration must not restore an external backend.
    bindings: { XHS_PARSE_FALLBACK_ORIGIN: 'https://xhs-images-video-vercel-downloader.vercel.app' },
    serviceBindings: { PYTHON_API: async request => {
      const body = await request.text();
      python.push({ method: request.method, url: request.url, body, cookie: request.headers.get('cookie') });
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      const input = JSON.parse(body);
      if (new URL(request.url).pathname === '/__internal/parse-rendered-note') {
        assert.deepEqual(Object.keys(input).sort(), ['finalUrl', 'html', 'noteId']);
        assert.equal(input.noteId, noteId);
        assert.equal(request.headers.get('authorization'), null);
        if (input.html.includes('source unavailable')) return Response.json({ success: false, engine: 'python', message: 'fixture native failure' }, { status: 422 });
      }
      return Response.json(payload('python'), { headers: { 'X-XHS-Engine': 'python' } });
    } },
    outboundService: async request => {
      const url = new URL(request.url);
      external.push({ url: request.url, method: request.method, headers: new Headers(request.headers), body: await request.text() });
      assert.equal(url.origin, 'https://www.xiaohongshu.com');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(request.headers.get('cookie'), null);
      return new Response(url.searchParams.has('missing') ? '<html>source unavailable</html>' : html, { headers: { 'Content-Type': 'text/html' } });
    },
  }));
  t.after(() => runtime.dispose());
  const call = (path, text, extra = {}) => runtime.dispatchFetch(`https://fixture.example.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://fixture.example.test', Cookie: 'private=do-not-forward', Authorization: 'Bearer do-not-forward' },
    body: JSON.stringify({ text, private: 'do-not-forward', ...extra }),
  });

  const native = await call('/api/parse', noteUrl);
  assert.equal(native.status, 200);
  const nativeBody = await native.json();
  assert.equal(nativeBody.engine, 'node');
  assert.equal(nativeBody.title, note.title);
  assert.equal(nativeBody.images[0].token, 'fixture-image-token');
  assert.equal(external.length, 1);

  const pythonShared = await call('/api/python_parse', noteUrl, { html: 'must not replace fetched HTML' });
  assert.equal(pythonShared.status, 200);
  assert.equal((await pythonShared.json()).engine, 'python');
  assert.equal(external.length, 2, 'Python uses the same DO outbound transport as Node');
  assert.equal(python.at(-1).url, 'https://python.internal/__internal/parse-rendered-note');
  assert.equal(JSON.parse(python.at(-1).body).html, html);
  assert.equal(python.at(-1).cookie, null);
  assert.deepEqual([...external[0].headers], [...external[1].headers], 'both engines use the configured shared page headers');

  const nativeClient = await runtime.dispatchFetch('https://fixture.example.test/api/python_parse?native=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: noteUrl }),
  });
  assert.equal(nativeClient.status, 200);
  assert.equal((await nativeClient.json()).engine, 'python');
  assert.equal(external.length, 2, 'native client must retain Python transport rather than use shared Node fetch');
  assert.equal(python.at(-1).url, 'https://python.internal/api/python_parse?native=1');
  assert.deepEqual(JSON.parse(python.at(-1).body), { text: noteUrl });

  const pythonNative = await call('/api/python_parse?preserved=1', 'https://sns-webpic-qc.xhscdn.com/fixture-image-token');
  assert.equal(pythonNative.status, 200);
  assert.equal((await pythonNative.json()).engine, 'python');
  assert.ok(python.at(-1).url.endsWith('/api/python_parse?preserved=1'));
  assert.equal(python.at(-1).cookie, null, 'visitor credentials are unnecessary on either private Python entry');

  for (const [path, engine, status, upstreamCalls] of [['/api/parse', 'node', 422, 1], ['/api/python_parse', 'python', 422, 1]]) {
    const before = external.length;
    const response = await call(path, `share text ${noteUrl}?missing=1`);
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.engine, engine);
    assert.equal(body.success, false);
    if (engine === 'python') assert.equal(body.message, 'fixture native failure');
    else assert.match(body.message, /没有解析到图片或视频/);
    assert.equal(response.headers.get('x-xhs-parse-backend'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(external.length, before + upstreamCalls, 'native failure must not call another backend');
  }

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
