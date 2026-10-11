import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';
import { ParseRuntime } from '../cloudflare/parse-runtime.js';
import { MAX_API_BODY_BYTES } from '../cloudflare/http-adapter.js';

const origin = 'https://xhs.example.test';
const token = 'a'.repeat(64);
const otherToken = 'b'.repeat(64);
const noteId = 'abcdef1234567890abcdef12';
const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
const post = (path, data, headers = {}) => new Request(`${origin}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
});

function namespaceFixture(response = () => Response.json({ success: true })) {
  const calls = [];
  return { calls, binding: {
    idFromName(name) { calls.push({ kind: 'id', name }); return name; },
    get(id) { return { async fetch(request) {
      calls.push({ kind: 'fetch', id, url: request.url, method: request.method,
        headers: Object.fromEntries(request.headers), body: await request.json() });
      return response();
    } }; },
  } };
}

test('public requests cannot address private browser or rendered-HTML routes through headers', async () => {
  const fixture = namespaceFixture();
  let pythonCalls = 0, assetCalls = 0;
  const env = { BROWSER: {}, PARSE_RUNTIME: fixture.binding,
    PYTHON_API: { fetch() { pythonCalls++; throw new Error('Private binding was reached'); } },
    ASSETS: { fetch() { assetCalls++; return new Response('asset'); } },
  };
  for (const path of ['/__internal/parse-rendered-note', '/__internal/parse-rendered-note/',
    '/__internal/browser/start', '/__internal/browser/resume', '/__internal/browser/cancel']) {
    const response = await worker.fetch(post(path, { token, finalUrl: noteUrl, html: '<p>private</p>', noteId }, {
      Authorization: `Bearer ${token}`, 'X-Internal-Rendered': 'true', 'X-Internal-Request': '1',
    }), env);
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(fixture.calls, []);
  assert.equal(pythonCalls, 0);
  assert.equal(assetCalls, 0);
});

test('verification rejects cross-site sources before body or owner DO dispatch', async () => {
  const fixture = namespaceFixture();
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await worker.fetch(post('/api/parse_verification', { token, action: 'resume' }, headers),
      { BROWSER: {}, PARSE_RUNTIME: fixture.binding });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.deepEqual(fixture.calls, []);
});

test('verification validates token type, action, JSON and bounded request body', async () => {
  const fixture = namespaceFixture();
  for (const data of [{ token: '', action: 'resume' }, { token: 'a'.repeat(63), action: 'resume' },
    { token: token.toUpperCase(), action: 'resume' }, { token: [token], action: 'resume' },
    { token, action: 'start' }, { token, action: 'resume/../start' }, null, []]) {
    assert.equal((await worker.fetch(post('/api/parse_verification', data), { BROWSER: {}, PARSE_RUNTIME: fixture.binding })).status, 400);
  }
  assert.equal((await worker.fetch(new Request(`${origin}/api/parse_verification`, {
    method: 'POST', body: '{',
  }), { BROWSER: {}, PARSE_RUNTIME: fixture.binding })).status, 400);
  assert.equal((await worker.fetch(post('/api/parse_verification', { token, action: 'resume', padding: 'x'.repeat(MAX_API_BODY_BYTES) }),
    { BROWSER: {}, PARSE_RUNTIME: fixture.binding })).status, 413);
  assert.deepEqual(fixture.calls, []);
});

test('verification has a POST guard and fails safely without a runtime binding', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'OPTIONS']) {
    const response = await worker.fetch(new Request(`${origin}/api/parse_verification`, { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    if (method === 'HEAD') assert.equal(await response.text(), '');
  }
  assert.equal((await worker.fetch(post('/api/parse_verification', { token, action: 'resume' }))).status, 503);
  assert.equal((await worker.fetch(post('/api/parse_verification', { token, action: 'resume' }), { BROWSER: {} })).status, 503);
});

test('inactive browser verification rejects valid tokens before namespace lookup or owner DO dispatch', async () => {
  const fixture = namespaceFixture();
  for (const [currentToken, action] of [[token, 'resume'], [otherToken, 'cancel']]) {
    const response = await worker.fetch(post('/api/parse_verification', { token: currentToken, action },
      { Origin: origin, 'Sec-Fetch-Site': 'same-origin' }), { PARSE_RUNTIME: fixture.binding });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(fixture.calls, []);
});

test('each bearer token routes only to its owner DO and forwarding drops caller headers and override fields', async () => {
  const fixture = namespaceFixture(() => Response.json({ success: true }, { headers: {
    'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '12',
  } }));
  for (const [currentToken, action] of [[token, 'resume'], [otherToken, 'cancel']]) {
    const response = await worker.fetch(post('/api/parse_verification', {
      token: currentToken, action, html: 'untrusted', sourceURL: 'https://evil.test', engine: 'python',
    }, { Origin: origin, Cookie: 'private-cookie', Authorization: 'private-authorization', 'X-Internal-Request': '1' }),
    { BROWSER: {}, PARSE_RUNTIME: fixture.binding });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-browser-closed'), null);
    assert.equal(response.headers.get('x-browser-elapsed-ms'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const forwarded = fixture.calls.at(-1);
    assert.equal(forwarded.id, `browser:${currentToken}`);
    assert.equal(forwarded.url, `https://browser.internal/__internal/browser/${action}`);
    assert.deepEqual(forwarded.body, { token: currentToken });
    assert.deepEqual(forwarded.headers, { 'content-type': 'application/json' });
  }
});

function runtimeFixture({ ownerToken = token, record, pythonFetch } = {}) {
  const entries = new Map(record ? [['browser-session', record]] : []);
  const calls = [];
  const state = { id: { equals: id => id === `browser:${ownerToken}` }, storage: {
    async get(key) { return entries.get(key); }, async put(key, value) { entries.set(key, structuredClone(value)); },
    async delete(key) { entries.delete(key); }, async setAlarm(value) { calls.push(['alarm', value]); },
    async deleteAlarm() { calls.push(['deleteAlarm']); },
  } };
  const browser = { async closeSession(id) { calls.push(['close', id]); return 'closed'; } };
  const env = { BROWSER: browser, PARSE_RUNTIME: { idFromName: name => name },
    PYTHON_API: { fetch: pythonFetch || (() => { throw new Error('Unexpected Python call'); }) } };
  return { runtime: new ParseRuntime(state, env), calls, entries };
}
const internal = (operation, data = { token }, headers) => post(`/__internal/browser/${operation}`, data, headers);

test('rendered Python parsing calls its private independent endpoint with only the trusted HTML contract', async t => {
  let forwarded;
  const page = { kind: 'page', engine: 'python', noteId, finalUrl: noteUrl, html: '<p>trusted page</p>', closed: true };
  const fixture = runtimeFixture({ pythonFetch: async request => {
    forwarded = { url: request.url, headers: Object.fromEntries(request.headers), body: await request.json() };
    return Response.json({ success: true, engine: 'python', count: 1 });
  } });
  t.mock.method(fixture.runtime.browser, 'resume', async () => page);
  const response = await fixture.runtime.fetch(internal('resume', { token }, { Cookie: 'private-cookie', 'X-Internal-Rendered': 'forged' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).engine, 'python');
  assert.equal(forwarded.url, 'https://python.internal/__internal/parse-rendered-note');
  assert.deepEqual(forwarded.headers, { 'content-type': 'application/json' });
  assert.deepEqual(forwarded.body, { finalUrl: noteUrl, html: page.html, noteId });
  assert.equal(response.headers.get('x-browser-closed'), '1');
});

test('rendered Node parsing uses its own parser and never calls the Python binding', async t => {
  const fixture = runtimeFixture();
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {
    [noteId]: { note: { noteId, title: 'fixture', imageList: [{ urlDefault: 'https://ci.xiaohongshu.com/test/image' }] } },
  } } })};</script>`;
  t.mock.method(fixture.runtime.browser, 'resume', async () => ({ kind: 'page', engine: 'node', noteId, finalUrl: noteUrl, html, closed: true }));
  const response = await fixture.runtime.fetch(internal('resume'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.engine, 'node');
  assert.equal(body.strategy, 'exact-initial-state');
  assert.equal(body.count, 1);
  assert.equal(body.images[0].token, 'test/image');
});

test('a valid-looking token cannot resume another owner DO or expose its page', async () => {
  const fixture = runtimeFixture();
  const response = await fixture.runtime.fetch(internal('resume', { token: otherToken }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).success, false);
  assert.deepEqual(fixture.calls, []);
});

test('actual expired manager session closes and maps to the public expired response', async () => {
  const fixture = runtimeFixture({ record: { sessionId: 'fixture-session', targetId: 'fixture-target',
    deadline: Date.now() - 100, engine: 'node', noteId, sourceURL: noteUrl } });
  const response = await fixture.runtime.fetch(internal('resume'));
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code, 'VERIFICATION_EXPIRED');
  assert.deepEqual(fixture.calls.filter(([kind]) => kind === 'close'), [['close', 'fixture-session']]);
  assert.equal(fixture.entries.has('browser-session'), false);
});

test('cancel is idempotent without a session and never parses or acquires', async () => {
  const fixture = runtimeFixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fixture.runtime.fetch(internal('cancel'));
    assert.deepEqual(await response.json(), { success: true, cancelled: true });
  }
  assert.deepEqual(fixture.calls, []);
});
