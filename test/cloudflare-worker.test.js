import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { createWorker } from '../cloudflare/worker.js';
import { invokeHandler, MAX_API_BODY_BYTES, MAX_ACCOUNT_BODY_BYTES } from '../cloudflare/http-adapter.js';
import { createAccountHandler, ADMIN_COOKIE } from '../api/account.js';

const origin = 'https://xhs.example.test';
const sessionToken = 'a'.repeat(43);
const request = (path, options) => new Request(`${origin}${path}`, options);
const post = (path, body, headers = {}) => request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const accountEnv = { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: 'test-only-pepper-'.repeat(3) };

test('real Node routes retain method guards, parsing results and HEAD semantics', async () => {
  for (const [path, method, allow] of [
    ['/api/parse', 'GET', 'POST'], ['/api/image', 'POST', 'GET'],
    ['/api/video', 'POST', 'GET'], ['/api/account', 'GET', 'POST'],
  ]) {
    const response = await worker.fetch(request(path, { method }));
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get('allow'), allow, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  const parsed = await worker.fetch(post('/api/parse', { text: 'https://sns-webpic-qc.xhscdn.com/fixture-image-token' }));
  assert.equal(parsed.status, 200);
  const body = await parsed.json();
  assert.equal(body.engine, 'node');
  assert.equal(body.success, true);
  assert.equal(body.images[0].token, 'fixture-image-token');
  const head = await worker.fetch(request('/api/parse', { method: 'HEAD' }));
  assert.equal(head.status, 405);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('allow'), 'POST');
});

test('real image and video routes preserve bytes and download/range headers', async t => {
  const bytes = Uint8Array.from([0, 255, 128, 23]);
  const upstreamRequests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    upstreamRequests.push({ url, options });
    const video = String(url).includes('sns-video');
    const response = new Response(bytes, {
      status: video ? 206 : 200,
      headers: video ? { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4' }
        : { 'Content-Type': 'image/jpeg', 'Content-Length': '4' },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  });
  const image = await worker.fetch(request('/api/image?token=fixture-image-token&name=photo.jpg'));
  assert.equal(image.status, 200);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes);
  assert.equal(image.headers.get('content-disposition'), 'attachment; filename="photo.jpg"');
  assert.equal(image.headers.get('content-length'), '4');
  const source = encodeURIComponent('https://sns-video-bd.xhscdn.com/stream/fixture.mp4');
  const video = await worker.fetch(request(`/api/video?url=${source}&action=chunk&start=2&end=5`));
  assert.equal(video.status, 200);
  assert.deepEqual(new Uint8Array(await video.arrayBuffer()), bytes);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.equal(video.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(video.headers.get('x-video-total'), '10');
  assert.equal(video.headers.get('accept-ranges'), 'bytes');
  assert.equal(upstreamRequests[1].options.headers.range, 'bytes=2-5');
});

test('HTTP adapter preserves raw JSON, duplicate queries and multiple cookies', async () => {
  const response = await invokeHandler((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/example?x=one&x=two&__proto__=safe');
    assert.deepEqual(req.query.x, ['one', 'two']);
    assert.equal(req.query.__proto__, 'safe');
    assert.equal(req.headers.authorization, 'Bearer fixture');
    assert.equal(req.body, '{malformed');
    res.setHeader('Set-Cookie', ['first=1; Path=/', 'second=2; Path=/']);
    res.setHeader('X-Result', 'initial');
    res.setHeader('X-Result', 'final');
    assert.equal(res.getHeader('X-Result'), 'final');
    return res.status(201).json({ created: true });
  }, request('/api/example?x=one&x=two&__proto__=safe', { method: 'POST', body: '{malformed', headers: { Authorization: 'Bearer fixture' } }));
  assert.equal(response.status, 201);
  assert.deepEqual(response.headers.getSetCookie(), ['first=1; Path=/', 'second=2; Path=/']);
  assert.deepEqual(await response.json(), { created: true });
});

function withAccountService(execute) {
  return createWorker({ accountFactory: options => createAccountHandler({ ...options, service: { execute } }) });
}

test('account adapter reads per-request bindings and trusts only the Cloudflare IP header', async () => {
  const calls = [];
  const app = withAccountService(async input => { calls.push(input); return { account: {} }; });
  for (const [headers, expected] of [
    [{ 'cf-connecting-ip': '203.0.113.1', 'x-vercel-forwarded-for': '192.0.2.2', 'x-forwarded-for': '192.0.2.3' }, '203.0.113.1'],
    [{ 'x-vercel-forwarded-for': '192.0.2.2', 'x-forwarded-for': '192.0.2.3' }, 'unknown'],
  ]) {
    const response = await app.fetch(post('/api/account', { action: 'me', input: {} }, headers), accountEnv);
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).ip, expected);
  }
  const otherOrigin = 'https://other.example.test';
  const admin = bodyOrigin => post('/api/account', { action: 'admin-users', input: {} }, { Origin: bodyOrigin });
  assert.equal((await app.fetch(admin(origin), accountEnv)).status, 200);
  const otherEnv = { ...accountEnv, AUTH_SITE_ORIGIN: otherOrigin };
  assert.equal((await app.fetch(admin(origin), otherEnv)).status, 403);
  assert.equal((await app.fetch(admin(otherOrigin), otherEnv)).status, 200);
  assert.equal((await app.fetch(admin(origin), accountEnv)).status, 200, 'another request cannot overwrite the first environment');
});

test('account login cookie, CSRF rejection, bearer proof and logout survive the Fetch adapter', async () => {
  const calls = [];
  const app = withAccountService(async input => { calls.push(input); return { token: sessionToken, account: {} }; });
  const login = await app.fetch(post('/api/account', { action: 'verify-code', input: { client: 'admin' } }, { Origin: origin }), accountEnv);
  assert.equal(login.status, 200);
  assert.equal((await login.json()).token, undefined);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie.startsWith(`${ADMIN_COOKIE}=${sessionToken};`));
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag));
  assert.equal(login.headers.get('vary'), 'Origin, Cookie, Authorization');
  const forbidden = await app.fetch(post('/api/account', { action: 'me', input: {} }, { Cookie: `${ADMIN_COOKIE}=${sessionToken}` }), accountEnv);
  assert.equal(forbidden.status, 403);
  assert.equal(calls.length, 1);
  const proof = { nonce: 'fixture', timestamp: 1, signature: 'fixture' };
  const desktop = await app.fetch(post('/api/account', { action: 'authorize', input: {}, proof }, { Authorization: `Bearer ${sessionToken}` }), accountEnv);
  assert.equal(desktop.status, 200);
  assert.equal(calls.at(-1).token, sessionToken);
  assert.deepEqual(calls.at(-1).proof, proof);
  const logout = await app.fetch(post('/api/account', { action: 'logout', input: {} }, { Origin: origin, Cookie: `${ADMIN_COOKIE}=${sessionToken}` }), accountEnv);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('chunked and declared oversized bodies are rejected before handlers or service bindings run', async () => {
  const app = createWorker({ nodeRoutes: { '/api/parse': () => assert.fail('oversized request reached handler') } });
  for (const [path, limit] of [['/api/parse', MAX_API_BODY_BYTES], ['/api/python_parse', MAX_API_BODY_BYTES], ['/api/account', MAX_ACCOUNT_BODY_BYTES]]) {
    const env = { PYTHON_API: { fetch: () => assert.fail('oversized request reached Python') } };
    for (const declared of [false, true]) {
      let canceled = false;
      const oversized = request(path, {
        method: 'POST', duplex: 'half',
        headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': String(limit + 1) } : {}) },
        body: new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); },
          cancel() { canceled = true; },
        }),
      });
      const response = await app.fetch(oversized, env);
      assert.equal(response.status, 413, `${path}: declared=${declared}`);
      assert.ok(canceled);
      const body = await response.json();
      assert.equal(path === '/api/account' ? body.error.code : body.success, path === '/api/account' ? 'REQUEST_TOO_LARGE' : false);
    }
  }
});

test('account feedback can exceed media limits while ordinary account actions stay bounded', async () => {
  let callCount = 0;
  const app = withAccountService(async () => { callCount++; return {}; });
  const input = { content: '中'.repeat(10000) };
  assert.equal((await app.fetch(post('/api/account', { action: 'feedback-upload-part', input }), accountEnv)).status, 200);
  assert.equal((await app.fetch(post('/api/account', { action: 'me', input }), accountEnv)).status, 413);
  assert.equal(callCount, 1);
  const malformed = await app.fetch(request('/api/account', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }), accountEnv);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
});

test('Python service binding receives original method, URL, headers and body, and returns binary responses intact', async () => {
  const calls = [];
  const env = { PYTHON_API: { async fetch(req) {
    calls.push({ method: req.method, url: req.url, cookie: req.headers.get('cookie'), body: await req.text() });
    return new Response(Uint8Array.from([0, 128, 255]), { headers: { 'Content-Type': 'video/mp4', 'X-XHS-Engine': 'python', 'Content-Range': 'bytes 0-2/3' } });
  } } };
  const payload = { text: '分享链接' };
  const response = await worker.fetch(post('/api/python_parse?variant=1', payload, { Cookie: 'test=1' }), env);
  assert.deepEqual(calls[0], { method: 'POST', url: `${origin}/api/python_parse?variant=1`, cookie: 'test=1', body: JSON.stringify(payload) });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([0, 128, 255]));
  assert.equal(response.headers.get('x-xhs-engine'), 'python');
  assert.equal(response.headers.get('content-range'), 'bytes 0-2/3');
  for (const path of ['/api/python_image', '/api/python_video']) assert.equal((await worker.fetch(request(path), env)).status, 200);
  assert.equal(calls.at(-1).body, '');
  const missing = await worker.fetch(request('/api/python_video'));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).engine, 'python');
});

test('unknown APIs never fall through to assets; admin pages retain security headers and asset status', async () => {
  let assetCalls = 0;
  const env = { ASSETS: { async fetch(req) { assetCalls++; return new Response(new URL(req.url).pathname, { status: 404, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' } }); } } };
  assert.equal((await worker.fetch(request('/api/unknown'), env)).status, 404);
  assert.equal(assetCalls, 0);
  for (const path of ['/admin', '/admin/', '/admin/index.html', '/admin/admin.js']) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  const publicAsset = await worker.fetch(request('/app.js'), env);
  assert.equal(publicAsset.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(publicAsset.headers.get('content-security-policy'), null);
});

test('health supports HEAD and unexpected failures never expose internal messages', async () => {
  const healthy = await worker.fetch(request('/api/health'), { VERSION: 'test-version', PYTHON_API: { fetch() {} } });
  assert.deepEqual(await healthy.json(), { ok: true, platform: 'cloudflare', version: 'test-version', pythonBinding: true });
  assert.equal(await (await worker.fetch(request('/api/health', { method: 'HEAD' }))).text(), '');
  assert.equal((await worker.fetch(request('/api/health', { method: 'POST' }))).status, 405);
  const fail = () => { throw new Error('internal-secret-sentinel'); };
  const app = createWorker({ nodeRoutes: { '/api/parse': fail }, accountFactory: fail });
  for (const path of ['/api/parse', '/api/account', '/api/python_parse']) {
    const response = await app.fetch(post(path, {}), { PYTHON_API: { fetch: fail } });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('internal-secret-sentinel'));
  }
});
