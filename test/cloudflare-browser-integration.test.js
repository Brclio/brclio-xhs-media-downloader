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
    '/__internal/browser/start', '/__internal/browser/resume', '/__internal/browser/cancel', '/__internal/browser-verification']) {
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

test('public bearer requests route only to the global verifier and drop caller headers and override fields', async () => {
  const fixture = namespaceFixture(() => Response.json({ success: true }, { headers: {
    'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '12', 'X-Browser-Failure-Code': 'private-boundary-sentinel',
  } }));
  for (const [currentToken, action] of [[token, 'resume'], [otherToken, 'cancel']]) {
    const response = await worker.fetch(post('/api/parse_verification', {
      token: currentToken, action, html: 'untrusted', sourceURL: 'https://evil.test', engine: 'python',
    }, { Origin: origin, Cookie: 'private-cookie', Authorization: 'private-authorization', 'X-Internal-Request': '1' }),
    { BROWSER: {}, PARSE_RUNTIME: fixture.binding });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-browser-closed'), null);
    assert.equal(response.headers.get('x-browser-elapsed-ms'), null);
    assert.equal(response.headers.get('x-browser-failure-code'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const forwarded = fixture.calls.at(-1);
    assert.equal(forwarded.id, 'parsing-v1');
    assert.equal(forwarded.url, 'https://browser.internal/__internal/browser-verification');
    assert.deepEqual(forwarded.body, { token: currentToken, action });
    assert.deepEqual(forwarded.headers, { 'content-type': 'application/json' });
  }
});

test('public parsing boundaries strip private diagnostics and retain only the fixed public failure code', async () => {
  for (const path of ['/api/parse', '/api/python_parse']) {
    const fixture = namespaceFixture(() => Response.json({ success: false }, { status: 422, headers: {
      'X-Browser-Failure-Code': 'private-boundary-sentinel', 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '1',
      'X-XHS-Browser-Failure-Code': 'BROWSER_ACQUIRE_FAILED',
    } }));
    const response = await worker.fetch(post(path, { text: noteUrl }), { BROWSER: {}, PARSE_RUNTIME: fixture.binding });
    assert.equal(response.status, 422); assert.deepEqual(await response.json(), { success: false });
    for (const header of ['X-Browser-Failure-Code', 'X-Browser-Closed', 'X-Browser-Elapsed-Ms']) assert.equal(response.headers.get(header), null);
    assert.equal(response.headers.get('X-XHS-Browser-Failure-Code'), 'BROWSER_ACQUIRE_FAILED');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

function globalVerificationFixture(ownerResponse = () => Response.json({ success: true, engine: 'node' })) {
  const values = new Map(), names = [], dispatches = [], writes = [];
  let tail = Promise.resolve(), runtime;
  const storage = { transaction(operation) {
    const pending = tail.then(() => operation({
      async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
      async put(key, value) { values.set(key, structuredClone(value)); writes.push({ key, value: structuredClone(value) }); },
    }));
    tail = pending.catch(() => {}); return pending;
  } };
  const binding = { idFromName(name) { names.push(name); return name; }, get(id) { return { async fetch(request) {
    dispatches.push({ id, url: request.url, headers: Object.fromEntries(request.headers), body: await request.clone().json() });
    return id === 'parsing-v1' ? runtime.fetch(request) : ownerResponse(request);
  } }; } };
  const env = { BROWSER: {}, PARSE_RUNTIME: binding };
  runtime = new ParseRuntime({ id: { equals: id => id === 'parsing-v1' }, storage }, env);
  return { runtime, env, names, dispatches, writes };
}

test('public unknown tokens reach only the existing global verifier and never create owner objects', async () => {
  const f = globalVerificationFixture();
  for (let index = 0; index < 24; index++) {
    const response = await worker.fetch(post('/api/parse_verification', {
      token: index.toString(16).padStart(64, '0'), action: index % 2 ? 'resume' : 'cancel',
    }), f.env);
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, 'VERIFICATION_EXPIRED');
  }
  assert.ok(f.names.every(name => name === 'parsing-v1'));
  assert.equal(f.dispatches.length, 24); assert.ok(f.dispatches.every(call => call.id === 'parsing-v1'));
  assert.deepEqual(f.writes, []);
});

test('an issued capability addresses its owner once and cannot be replayed after successful parsing', async () => {
  const f = globalVerificationFixture(() => Response.json({ success: true, engine: 'node', count: 1 }, {
    headers: { 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '3000' },
  }));
  await f.runtime.verifications.register(token, { engine: 'node', expiresAt: Date.now() + 180000 });
  const response = await worker.fetch(post('/api/parse_verification', {
    token, action: 'resume', html: '<p>forged</p>', engine: 'python', sourceURL: 'https://evil.test/',
  }, { Cookie: 'private-cookie', Authorization: 'Bearer private-auth', Origin: origin }), f.env);
  assert.equal(response.status, 200); assert.equal((await response.json()).count, 1);
  assert.equal(response.headers.get('x-browser-closed'), null); assert.equal(response.headers.get('x-browser-elapsed-ms'), null);
  const owners = f.dispatches.filter(call => call.id.startsWith('browser:'));
  assert.equal(owners.length, 1); assert.equal(owners[0].id, `browser:${token}`);
  assert.equal(owners[0].url, 'https://browser.internal/__internal/browser/resume');
  assert.deepEqual(owners[0].body, { token }); assert.deepEqual(owners[0].headers, { 'content-type': 'application/json' });
  for (const action of ['resume', 'cancel']) assert.equal((await worker.fetch(post('/api/parse_verification', { token, action }), f.env)).status, 410);
  assert.equal(f.dispatches.filter(call => call.id.startsWith('browser:')).length, 1);
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

test('private browser errors project only known failure codes and map unknown exceptions to BROWSER_FAILED', async t => {
  const fixture = runtimeFixture(), logs = [];
  t.mock.method(console, 'warn', (...values) => logs.push(values));
  let failure;
  t.mock.method(fixture.runtime.browser, 'start', async () => { throw failure; });
  for (const code of ['BROWSER_ACQUIRE_FAILED', 'BROWSER_CDP_PROTOCOL', 'private-code-sentinel', undefined]) {
    failure = Object.assign(new Error('private-error-url-token-sentinel'), { code, closed: true });
    const response = await fixture.runtime.fetch(internal('start'));
    const expected = ['BROWSER_ACQUIRE_FAILED', 'BROWSER_CDP_PROTOCOL'].includes(code) ? code : 'BROWSER_FAILED';
    assert.equal(response.status, 503); assert.equal(response.headers.get('X-Browser-Failure-Code'), expected);
    assert.equal(response.headers.get('X-Browser-Closed'), '1');
    assert.deepEqual(await response.json(), { success: false, code: 'BROWSER_UNAVAILABLE', message: '页面读取暂时不可用，请稍后重试。' });
    assert.equal(JSON.parse(logs.at(-1)[1]).code, expected);
    assert.equal(JSON.stringify(logs).includes('private-'), false);
  }
});

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

test('a browser owner cannot act as the global verification directory', async () => {
  const fixture = runtimeFixture();
  const response = await fixture.runtime.fetch(post('/__internal/browser-verification', { token, action: 'resume' }));
  assert.equal(response.status, 404); assert.deepEqual(fixture.calls, []);
});

test('the private owner response projects only supported manual handoff reason enums', async t => {
  const fixture = runtimeFixture();
  let reason = 'captcha';
  t.mock.method(fixture.runtime.browser, 'resume', async () => ({ kind: 'verification', engine: 'node', reason,
    verificationUrl: 'https://live.browser.run/private-fixture', expiresAt: Date.now() + 180000 }));
  for (reason of ['captcha', 'login', 'access-error', 'private-reason-sentinel']) {
    const response = await fixture.runtime.fetch(internal('resume'));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).reason, reason === 'private-reason-sentinel' ? undefined : reason);
  }
});
