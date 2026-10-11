import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePythonWithSharedPage } from '../cloudflare/native-python-parse.js';
import { XhsError } from '../lib/xhs.js';

const noteId = '1234567890abcdef12345678';
const noteURL = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fixture-private`;
const html = '<script>window.__INITIAL_STATE__={"fixture":"private HTML"}</script>';
const parsed = { success: true, engine: 'python', count: 2, images: [{ token: 'python-result-only' }], videos: [] };

function fixture({ page = { finalUrl: noteURL, html }, failure, response = () => Response.json(parsed) } = {}) {
  const fetches = [], bindings = [];
  return {
    fetches, bindings,
    async call({ body = JSON.stringify({ text: noteURL }), method = 'POST', path = '/api/python_parse?preserved=1', origin = 'https://public.example' } = {}) {
      const request = new Request(`https://public.example${path}`, {
        method, headers: { Cookie: 'fixture-cookie', Authorization: 'Bearer fixture-secret',
          ...(origin === null ? {} : { Origin: origin }), 'Content-Type': 'application/json', 'X-Private': 'fixture-header' },
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      });
      return parsePythonWithSharedPage(request, {
        body, fetchPage: async (url, options) => {
          fetches.push({ url, options });
          if (failure) throw failure;
          return page;
        },
        pythonAPI: { async fetch(request) {
          bindings.push({ url: request.url, method: request.method, headers: [...request.headers], body: await request.text() });
          return response(request);
        } },
      });
    },
  };
}

test('valid note HTML is fetched through the shared transport and only the trusted private envelope reaches Python', async () => {
  const run = fixture();
  const response = await run.call({ body: JSON.stringify({ text: `share ${noteURL}`, html: 'forged', images: ['node-like'], engine: 'node' }) });
  assert.deepEqual(await response.json(), parsed, 'Python response is preserved rather than synthesized by the Node parser');
  assert.equal(run.fetches.length, 1);
  assert.equal(run.fetches[0].url, noteURL);
  assert.deepEqual(Object.keys(run.fetches[0].options), ['signal']);
  assert.ok(run.fetches[0].options.signal instanceof AbortSignal);
  assert.equal(run.bindings.length, 1);
  assert.equal(run.bindings[0].url, 'https://python.internal/__internal/parse-rendered-note');
  assert.equal(run.bindings[0].method, 'POST');
  assert.deepEqual(run.bindings[0].headers, [['content-type', 'application/json']]);
  assert.deepEqual(JSON.parse(run.bindings[0].body), { finalUrl: noteURL, noteId, html });
});

test('native clients retain the independent Python public path and exact response', async () => {
  const body = JSON.stringify({ text: noteURL });
  for (const origin of [null, '', 'null', 'https://other.example']) {
    for (const status of [200, 422, 502, 504]) {
      const original = Response.json({ success: status === 200, engine: 'python', message: 'native path sentinel' }, { status });
      const run = fixture({ failure: new Error('shared transport must not run'), response: () => original });
      assert.equal(await run.call({ origin, body }), original);
      assert.deepEqual(run.fetches, []);
      assert.equal(run.bindings.length, 1);
      assert.equal(run.bindings[0].url, 'https://python.internal/api/python_parse?preserved=1');
      assert.equal(run.bindings[0].body, body);
      assert.deepEqual(run.bindings[0].headers, [['content-type', 'application/json']]);
    }
  }
});

test('short links may establish their note ID and URL fragments are removed without changing signed query values', async () => {
  const run = fixture({ page: { finalUrl: `${noteURL}#browser-anchor`, html } });
  assert.equal((await run.call({ body: JSON.stringify({ text: 'https://xhslink.com/a/fixture-short' }) })).status, 200);
  assert.equal(run.fetches[0].url, 'https://xhslink.com/a/fixture-short');
  assert.deepEqual(JSON.parse(run.bindings[0].body), { finalUrl: noteURL, noteId, html });
});

test('direct images and invalid public inputs keep Python public validation without external note fetches or visitor headers', async () => {
  for (const body of [JSON.stringify({ text: 'https://sns-webpic-qc.xhscdn.com/fixture-image-token' }),
    '{invalid', 'null', '[]', JSON.stringify({ text: '' }), JSON.stringify({ text: 'x'.repeat(3001) }),
    JSON.stringify({ text: 'https://evil.test/explore/' + noteId }), JSON.stringify({ text: 12 })]) {
    const run = fixture({ response: () => Response.json({ success: false, engine: 'python', message: 'original public validation' }, { status: 400 }) });
    assert.equal((await run.call({ body })).status, 400);
    assert.equal(run.fetches.length, 0);
    assert.equal(run.bindings.length, 1);
    assert.equal(run.bindings[0].url, 'https://python.internal/api/python_parse?preserved=1');
    assert.deepEqual(run.bindings[0].headers, [['content-type', 'application/json']]);
    assert.equal(run.bindings[0].body, body);
  }
});

test('method guards remain on the public Python path and keep its Allow header', async () => {
  const run = fixture({ response: () => new Response(null, { status: 405, headers: { Allow: 'POST' } }) });
  const response = await run.call({ method: 'GET', body: '' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal(run.fetches.length, 0);
  assert.equal(run.bindings[0].method, 'GET');
  assert.equal(run.bindings[0].body, '');
});

test('Python Unicode length validation remains compatible for an ordinary share string', async () => {
  const run = fixture();
  const text = '😀'.repeat(1500) + ' ' + noteURL;
  assert.ok(text.length > 3000 && Array.from(text).length < 3000);
  assert.equal((await run.call({ body: JSON.stringify({ text }) })).status, 200);
  assert.equal(run.fetches.length, 1);
});

test('final note identity, host, scheme and canonical path are checked before the private parser', async () => {
  for (const finalUrl of [`https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`, 'https://evil.test/explore/' + noteId,
    'http://www.xiaohongshu.com/explore/' + noteId, 'https://user:password@www.xiaohongshu.com/explore/' + noteId,
    'https://www.xiaohongshu.com:8443/explore/' + noteId, 'https://www.xiaohongshu.com/',
    'https://www.xiaohongshu.com/explore/' + noteId + '/extra']) {
    const run = fixture({ page: { finalUrl, html } });
    const response = await run.call();
    assert.equal(response.status, 422);
    assert.equal((await response.json()).engine, 'python');
    assert.equal(run.bindings.length, 0);
  }
});

test('explicit CAPTCHA and login are eligible 422 failures without calling the private note schema', async () => {
  for (const page of [{ finalUrl: 'https://www.xiaohongshu.com/captcha', html },
    { finalUrl: 'https://www.xiaohongshu.com/login', html },
    { finalUrl: noteURL, html: '<title>小红书安全验证</title>' },
    { finalUrl: noteURL, html: '<title>小红书登录</title>' }]) {
    const run = fixture({ page });
    const response = await run.call();
    assert.equal(response.status, 422);
    assert.match((await response.json()).message, /验证|登录/);
    assert.equal(run.bindings.length, 0);
  }
});

test('only explicit upstream rate/auth codes turn 400 into a Browser-eligible 422', async () => {
  for (const code of ['RATE_LIMITED', 'AUTH_REQUIRED']) {
    const run = fixture({ failure: Object.assign(new XhsError('private error sentinel', 400), { code }) });
    const response = await run.call();
    const body = await response.json();
    assert.equal(response.status, 422); assert.equal(body.code, code);
    assert.doesNotMatch(JSON.stringify(body), /private error sentinel|fixture-private/);
    assert.equal(run.bindings.length, 0);
  }
  const run = fixture({ failure: new XhsError('private invalid-redirect sentinel', 400) });
  const response = await run.call();
  assert.equal(response.status, 400);
  assert.doesNotMatch(JSON.stringify(await response.json()), /sentinel/);
});

test('shared transport timeout and byte limits retain their status without leaking exceptions', async () => {
  for (const [failure, expected] of [[new XhsError('private timeout', 504), 504],
    [new XhsError('private body-size', 413), 413], [new Error('private transport'), 502]]) {
    const run = fixture({ failure });
    const response = await run.call();
    assert.equal(response.status, expected);
    assert.doesNotMatch(JSON.stringify(await response.json()), /private/);
    assert.equal(run.bindings.length, 0);
  }
  const run = fixture({ page: { finalUrl: noteURL, html: 'x'.repeat(6 * 1024 * 1024 + 1) } });
  assert.equal((await run.call()).status, 413);
  assert.equal(run.bindings.length, 0);
});

test('Python no-media response stays intact so its caller can choose exactly one browser fallback', async () => {
  const original = { success: false, engine: 'python', message: 'fixture no media' };
  const run = fixture({ response: () => Response.json(original, { status: 422 }) });
  const response = await run.call();
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), original);
  assert.equal(run.fetches.length, 1); assert.equal(run.bindings.length, 1);
});
