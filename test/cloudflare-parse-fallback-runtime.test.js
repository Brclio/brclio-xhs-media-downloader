import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { PARSE_FALLBACK_ORIGIN } from '../cloudflare/parse-fallback.js';

test('real workerd supports fallback fetch options and refuses redirects for both engines', async t => {
  const calls = [];
  let redirect = false;
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
      import { parseWithFallback } from './cloudflare/parse-fallback.js';
      export default { fetch(request, env) {
        return parseWithFallback(request, env, async nativeRequest => {
          await nativeRequest.text();
          return Response.json({ success: false, message: 'upstream challenge' }, { status: 422 });
        });
      } };
    ` },
    bundle: true, format: 'esm', write: false, platform: 'neutral', packages: 'external',
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    bindings: { XHS_PARSE_FALLBACK_ORIGIN: PARSE_FALLBACK_ORIGIN },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push(url.pathname);
      assert.equal(url.origin, PARSE_FALLBACK_ORIGIN);
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('Cookie'), null);
      assert.equal(request.headers.get('Authorization'), null);
      assert.deepEqual(await request.json(), { text: 'https://xhslink.cn/o/fixture' });
      if (redirect) return new Response(null, { status: 302, headers: { Location: PARSE_FALLBACK_ORIGIN + '/credential-trap' } });
      return Response.json({ success: true, engine: url.pathname === '/api/parse' ? 'node' : 'python',
        count: 1, videoCount: 0, images: [{ token: 'fixture' }], videos: [],
      }, { headers: { 'Set-Cookie': 'unexpected=session' } });
    },
  }));
  t.after(() => runtime.dispose());
  const call = path => runtime.dispatchFetch('https://public.example.test' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'account=private', Authorization: 'Bearer private' },
    body: JSON.stringify({ text: 'clipboard text https://xhslink.cn/o/fixture', accountSecret: 'private' }),
  });
  for (const [path, engine] of [['/api/parse', 'node'], ['/api/python_parse', 'python']]) {
    const response = await call(path);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).engine, engine);
    assert.equal(response.headers.get('X-XHS-Parse-Backend'), 'vercel-fallback');
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  redirect = true;
  const response = await call('/api/parse');
  assert.equal(response.status, 422);
  assert.equal((await response.json()).message, 'upstream challenge');
  assert.deepEqual(calls, ['/api/parse', '/api/python_parse', '/api/parse']);
});
