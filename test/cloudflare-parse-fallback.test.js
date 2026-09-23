import test from 'node:test';
import assert from 'node:assert/strict';
import { createParseFallback, PARSE_FALLBACK_ORIGIN, MAX_FALLBACK_RESPONSE_BYTES } from '../cloudflare/parse-fallback.js';

const env = { XHS_PARSE_FALLBACK_ORIGIN: PARSE_FALLBACK_ORIGIN };
const note = 'https://xhslink.cn/o/public-test';
const primaryFailure = () => Response.json({ success: false, message: '无法从分享链接中识别当前笔记 ID。' }, { status: 422 });
const payload = engine => ({ success: true, engine, title: 'test', type: 'image', count: 1, videoCount: 0,
  images: [{ index: 1, token: 'image', url: 'https://ci.xiaohongshu.com/image' }], videos: [] });
const input = (path = '/api/parse', body = { text: note }, headers = {}) => new Request('https://xhs.download.brclio.com' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('same-engine fallback preserves payload and isolates credentials, request fields and response headers', async () => {
  for (const [path, engine] of [['/api/parse', 'node'], ['/api/python_parse', 'python']]) {
    let nativeCalls = 0;
    let fallbackCalls = 0;
    const run = createParseFallback({ fetchImpl: async (url, options) => {
      fallbackCalls++;
      assert.equal(nativeCalls, 1, 'native must run first');
      assert.equal(url, PARSE_FALLBACK_ORIGIN + path);
      assert.deepEqual(JSON.parse(options.body), { text: note });
      assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Accept: 'application/json' });
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'manual', 'Workers rejects redirect:error; 3xx must be checked explicitly');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(payload(engine), { headers: { 'Set-Cookie': 'session=wrong', 'Access-Control-Allow-Origin': '*' } });
    } });
    const response = await run(input(path, { text: 'surrounding clipboard text ' + note, password: 'never-forward' }, {
      Cookie: 'admin=sensitive', Authorization: 'Bearer sensitive', 'X-Account-Token': 'sensitive',
    }), env, async request => {
      nativeCalls++;
      assert.equal(request.headers.get('Cookie'), 'admin=sensitive', 'native request unchanged');
      assert.equal((await request.json()).password, 'never-forward');
      return primaryFailure();
    });
    assert.equal(fallbackCalls, 1);
    assert.deepEqual(await response.json(), payload(engine));
    assert.equal(response.headers.get('X-XHS-Engine'), engine);
    assert.equal(response.headers.get('X-XHS-Parse-Backend'), 'vercel-fallback');
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('successful native results never use Vercel and keep their exact response', async () => {
  let calls = 0;
  const run = createParseFallback({ fetchImpl: () => { calls++; return Response.json(payload('node')); } });
  const primary = Response.json(payload('node'));
  assert.equal(await run(input(), env, async () => primary), primary);
  assert.deepEqual(await primary.json(), payload('node'));
  assert.equal(calls, 0);
});

test('disabled, arbitrary, credentialed, path/query and recursive origins cannot proxy requests', async () => {
  let calls = 0;
  const run = createParseFallback({ fetchImpl: () => { calls++; return Response.json(payload('node')); } });
  for (const value of [undefined, '', 'https://example.com', 'http://xhs-images-video-vercel-downloader.vercel.app',
    PARSE_FALLBACK_ORIGIN + '/api', PARSE_FALLBACK_ORIGIN + '?query=x',
    'https://user:pass@xhs-images-video-vercel-downloader.vercel.app',
    PARSE_FALLBACK_ORIGIN + '.example.com']) {
    const primary = primaryFailure();
    assert.equal(await run(input(), { XHS_PARSE_FALLBACK_ORIGIN: value }, async () => primary), primary);
  }
  const primary = primaryFailure();
  const recursive = new Request(PARSE_FALLBACK_ORIGIN + '/api/parse', input());
  assert.equal(await run(recursive, env, async () => primary), primary);
  assert.equal(calls, 0);
});

test('only bounded valid JSON note requests can fallback, never media, accounts or direct assets', async () => {
  let calls = 0;
  const run = createParseFallback({ fetchImpl: () => { calls++; return Response.json(payload('node')); } });
  for (const [path, body, headers] of [
    ['/api/account', { text: note }], ['/api/image', { text: note }], ['/api/video', { text: note }],
    ['/api/python_image', { text: note }], ['/api/python_video', { text: note }],
    ['/api/parse', '{'], ['/api/parse', { text: 'https://example.com/note' }],
    ['/api/parse', { text: 'https://ci.xiaohongshu.com/image' }],
    ['/api/parse', { text: 'https://user:pass@xhslink.cn/o/test' }],
    ['/api/parse', { text: 'https://xhslink.cn:8443/o/test' }],
    ['/api/parse', { text: 'x'.repeat(3001) }], ['/api/parse', { text: [note] }],
    ['/api/parse', { text: note }, { 'Content-Type': 'text/plain' }],
  ]) {
    const primary = primaryFailure();
    assert.equal(await run(input(path, body, headers), env, async () => primary), primary);
  }
  await assert.rejects(run(input('/api/parse', 'x'.repeat(16_385)), env, () => assert.fail('oversized input reached native')), { name: 'RequestTooLargeError' });
  const get = new Request('https://xhs.download.brclio.com/api/parse');
  const primary = primaryFailure();
  assert.equal(await run(get, env, async () => primary), primary);
  assert.equal(calls, 0);
});

test('native validation/method statuses are never retried', async () => {
  let calls = 0;
  const run = createParseFallback({ fetchImpl: () => { calls++; return Response.json(payload('node')); } });
  for (const status of [200, 204, 401, 404, 405, 413, 415]) {
    const primary = new Response(null, { status });
    assert.equal(await run(input(), env, async () => primary), primary);
  }
  assert.equal(calls, 0);
});

test('failed, redirecting, non-JSON, malformed and wrong-engine fallback preserves native error', async () => {
  for (const getResponse of [
    () => { throw new Error('network failure'); },
    () => new Response(null, { status: 302, headers: { Location: 'https://example.com' } }),
    () => Response.json({ success: false }, { status: 500 }),
    () => new Response('binary', { headers: { 'Content-Type': 'image/jpeg' } }),
    () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    () => Response.json(payload('python')),
    () => Response.json({ ...payload('node'), count: 8 }),
    () => Response.json({ ...payload('node'), images: [], count: 0 }),
  ]) {
    const run = createParseFallback({ fetchImpl: async () => getResponse() });
    const primary = primaryFailure();
    assert.equal(await run(input(), env, async () => primary), primary);
    assert.equal((await primary.json()).success, false);
  }
});

test('fallback response has both declared and streaming byte limits', async () => {
  for (const declared of [true, false]) {
    let canceled = false;
    const run = createParseFallback({ fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_FALLBACK_RESPONSE_BYTES + 1)); },
      cancel() { canceled = true; },
    }), { headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': String(MAX_FALLBACK_RESPONSE_BYTES + 1) } : {}) } }) });
    const primary = primaryFailure();
    assert.equal(await run(input(), env, async () => primary), primary);
    assert.equal(canceled, true);
  }
});

test('fallback timeout aborts its fetch and returns the untouched native failure', async () => {
  const run = createParseFallback({ timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const primary = primaryFailure();
  // AbortSignal.timeout uses an unref'ed timer in Node.
  const keepAlive = setTimeout(() => {}, 100);
  try { assert.equal(await run(input(), env, async () => primary), primary); }
  finally { clearTimeout(keepAlive); }
});

test('a failed Python service binding can fallback, and a failed fallback retains the native exception', async () => {
  const nativeError = new Error('binding temporarily unavailable');
  const run = createParseFallback({ fetchImpl: async () => Response.json(payload('python')) });
  const response = await run(input('/api/python_parse'), env, async () => { throw nativeError; });
  assert.deepEqual(await response.json(), payload('python'));
  const failing = createParseFallback({ fetchImpl: async () => { throw new Error('upstream down'); } });
  await assert.rejects(failing(input('/api/python_parse'), env, async () => { throw nativeError; }), error => error === nativeError);
});
