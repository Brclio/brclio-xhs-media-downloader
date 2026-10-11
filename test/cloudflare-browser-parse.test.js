import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeParseWithBrowser, BROWSER_BUDGET_STORAGE_KEY as KEY, BROWSER_ATTEMPT_RESERVATION_MS as RESERVE } from '../cloudflare/browser-parse.js';
import { BROWSER_VERIFICATION_REGISTRY_KEY as REGISTRY_KEY, verificationTokenDigest } from '../cloudflare/browser-verification.js';

const NOTE = 'https://www.xiaohongshu.com/explore/1234567890abcdef12345678?xsec_token=private-query-sentinel';
const request = (text = NOTE, { path = '/api/parse', method = 'POST', headers = {}, ...extra } = {}) => new Request(`https://fixture.example.test${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify({ text, ignoredCookie: 'private-body-sentinel' }) } : {}), ...extra,
});
const native = (status = 422) => Response.json({ success: false, message: 'original native error sentinel' }, { status });
const liveURL = `https://live.browser.run/ui/view?mode=tab&wss=${encodeURIComponent('live.browser.run/api/devtools/browser/fixture-session/page/fixture-target?jwt=private-jwt-sentinel')}`;
function storage() {
  const values = new Map(), writes = [];
  let tail = Promise.resolve();
  const store = { values, writes, transaction(fn) {
    const operation = tail.then(() => fn({ get: async key => values.has(key) ? structuredClone(values.get(key)) : undefined, put: async (key, value) => { values.set(key, structuredClone(value)); writes.push({ key, value: structuredClone(value) }); } }));
    tail = operation.catch(() => {}); return operation;
  } };
  return store;
}
function harness(response = () => Response.json({ success: true, engine: 'node', images: [], videos: [] })) {
  const store = storage(), calls = [], names = [];
  const env = { BROWSER: {}, PARSE_RUNTIME: { idFromName(name) { names.push(name); return name; }, get() { return { async fetch(req) {
    const payload = await req.json(); calls.push({ request: req, payload }); return response(payload, req);
  } }; } } };
  return { env, state: { storage: store }, store, calls, names };
}
function clock(t, initial = 1_800_000_000_000) { let value = initial; t.mock.method(Date, 'now', () => value); return { set: next => { value = next; }, advance: ms => { value += ms; }, now: () => value }; }

test('native success, absent binding, unrelated errors and invalid inputs never start a browser or read native body', async () => {
  const cases = [
    [request(), 200], [request(), 400], [request(), 403], [request(), 429], [request(), 500], [request(), 503],
    [request(NOTE, { method: 'GET' }), 422], [request(NOTE, { path: '/api/member_video' }), 422],
    [request(NOTE, { headers: { Origin: 'https://other.example.test' } }), 422],
    [request(NOTE, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 422],
    [request(NOTE, { headers: { 'Content-Type': 'text/plain' } }), 422],
    [request('https://sns-webpic-qc.xhscdn.com/direct-image-token'), 422],
    [request('https://xiaohongshu.com.attacker.test/explore/1234567890ab'), 422],
    [request('https://ci.xiaohongshu.com/explore/1234567890ab'), 422],
    [request('https://user:password@www.xiaohongshu.com/explore/1234567890ab'), 422],
    [request('https://www.xiaohongshu.com:8443/explore/1234567890ab'), 422],
    [request('https://www.xiaohongshu.com/login'), 422],
    [request('https://www.xiaohongshu.com/item/1234567890abcdef12345678'), 422],
    [request('https://www.xiaohongshu.com/explore/1234567890ab'), 422],
    [request('https://www.xiaohongshu.com/explore/abcdefghijklmno1234567890'), 422], [request('x'.repeat(3001)), 422],
    [request(NOTE, { body: '{invalid' }), 422], [request(NOTE, { body: JSON.stringify({ text: NOTE, padding: 'x'.repeat(16384) }) }), 422],
  ];
  for (const [req, status] of cases) {
    const h = harness(), original = native(status);
    assert.equal(await maybeParseWithBrowser(req, original, h), original);
    assert.equal(original.bodyUsed, false); assert.equal(h.calls.length, 0); assert.equal(h.store.writes.length, 0);
  }
  const h = harness(); delete h.env.BROWSER;
  assert.equal(await maybeParseWithBrowser(request(), native(), h).then(response => response.status), 422);
  assert.equal(h.calls.length, 0);
});

test('browser start preserves Python engine and forwards only private validated input to a unique session', async t => {
  const logs = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...values) => logs.push(values));
  const h = harness(payload => Response.json({ success: true, engine: payload.engine, images: [], videos: [] }, { headers: {
    'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '2500', 'X-XHS-Engine': 'python',
  } }));
  clock(t);
  const original = native(502);
  const response = await maybeParseWithBrowser(request(NOTE, { path: '/api/python_parse', headers: { Origin: 'https://fixture.example.test', Cookie: 'private-cookie', Authorization: 'Bearer private-auth' } }), original, h);
  assert.equal((await response.json()).engine, 'python');
  assert.equal(h.calls.length, 1); assert.match(h.names[0], /^browser:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(h.calls[0].payload).sort(), ['engine', 'noteId', 'sourceURL', 'token']);
  assert.equal(h.calls[0].payload.sourceURL, NOTE); assert.equal(h.calls[0].payload.noteId, '1234567890abcdef12345678');
  assert.equal(h.calls[0].payload.engine, 'python'); assert.equal(h.calls[0].payload.token, h.names[0].slice(8));
  assert.equal(h.calls[0].request.headers.get('cookie'), null); assert.equal(h.calls[0].request.headers.get('authorization'), null);
  assert.equal(response.headers.get('X-Browser-Closed'), null); assert.equal(response.headers.get('X-Browser-Elapsed-Ms'), null);
  assert.equal(response.headers.get('X-XHS-Engine'), 'python'); assert.equal(original.bodyUsed, false);
  assert.deepEqual(logs, []);
  for (const write of h.store.writes) { assert.equal(write.key, KEY); assert.ok(Object.values(write.value).every(value => typeof value === 'number')); }
  assert.equal(h.store.values.get(KEY).usedMs, 7500);
});

test('atomic concurrent reservations permit one start per 30 seconds across both engines', async t => {
  clock(t); const h = harness();
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => maybeParseWithBrowser(request(NOTE, { path: index % 2 ? '/api/python_parse' : '/api/parse' }), native(), h)));
  assert.equal(h.calls.length, 1); assert.equal(responses.filter(response => response.status === 200).length, 1);
  for (const response of responses.filter(response => response.status !== 200)) { assert.equal(response.status, 503); assert.equal((await response.json()).code, 'BROWSER_BUSY'); }
  assert.equal(h.store.values.get(KEY).usedMs, RESERVE);
});

test('unclosed attempts retain reservation and the daily budget permits at most three unresolved starts', async t => {
  const time = clock(t), h = harness();
  for (let index = 0; index < 3; index++) {
    assert.equal((await maybeParseWithBrowser(request(), native(), h)).status, 200); time.advance(30000);
  }
  const blocked = await maybeParseWithBrowser(request(), native(), h);
  assert.equal(blocked.status, 503); assert.equal((await blocked.json()).code, 'BROWSER_BUSY');
  assert.equal(h.calls.length, 3); assert.equal(h.store.values.get(KEY).usedMs, 540000);
  assert.equal(new Set(h.names).size, 3);
  time.set((Math.floor(time.now() / 86400000) + 1) * 86400000 + 30000);
  assert.equal((await maybeParseWithBrowser(request(), native(), h)).status, 200);
  assert.equal(h.store.values.get(KEY).usedMs, RESERVE);
});

test('verified close refunds actual elapsed plus five seconds while verification keeps the full reservation', async t => {
  clock(t);
  const h = harness(payload => Response.json({ success: false, engine: payload.engine, code: 'VERIFICATION_REQUIRED', reason: 'access-error', message: 'ignored internal wording', verificationUrl: liveURL, expiresAt: Date.now() + 180000 }, { status: 422, headers: { 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '1000' } }));
  const response = await maybeParseWithBrowser(request('https://xhslink.cn/arbitrary/path?private=value'), native(504), h);
  const body = await response.json();
  assert.equal(response.status, 422); assert.equal(body.code, 'VERIFICATION_REQUIRED'); assert.equal(body.engine, 'node');
  assert.equal(body.verificationToken, h.calls[0].payload.token); assert.equal(h.calls[0].payload.noteId, null);
  assert.equal(body.verificationUrl, liveURL); assert.equal(body.reason, 'access-error');
  assert.equal(h.store.values.get(KEY).usedMs, RESERVE); assert.equal(response.headers.get('X-Browser-Closed'), null);
  const entries = h.store.values.get(REGISTRY_KEY);
  assert.equal(entries.length, 1); assert.equal(entries[0].digest, await verificationTokenDigest(body.verificationToken));
  assert.equal(entries[0].expiresAt, body.expiresAt); assert.equal(entries[0].engine, 'node');
  const serialized = JSON.stringify(entries);
  for (const privateValue of [body.verificationToken, 'private-jwt-sentinel', 'arbitrary/path', 'private=value']) assert.equal(serialized.includes(privateValue), false);
});

test('a verification registry failure cancels the untracked owner and retains the complete budget', async t => {
  clock(t);
  const h = harness((payload, req) => req.url.endsWith('/cancel')
    ? Response.json({ success: true, cancelled: true }, { headers: { 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '1' } })
    : Response.json({ success: false, engine: payload.engine, code: 'VERIFICATION_REQUIRED', verificationUrl: liveURL, expiresAt: Date.now() + 180000 }, { status: 422 }));
  const originalTransaction = h.store.transaction.bind(h.store);
  h.store.transaction = operation => originalTransaction(transaction => operation({ ...transaction, put: async (key, value) => {
    if (key === REGISTRY_KEY) throw new Error('private-storage-error');
    return transaction.put(key, value);
  } }));
  const original = native();
  assert.equal(await maybeParseWithBrowser(request(), original, h), original);
  assert.equal(original.bodyUsed, false); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].request.url, 'https://browser.internal/__internal/browser/cancel');
  assert.deepEqual(h.calls[1].payload, { token: h.calls[0].payload.token });
  assert.equal(h.store.values.get(KEY).usedMs, RESERVE); assert.equal(h.store.values.has(REGISTRY_KEY), false);
});

test('invalid close evidence, internal failures and corrupt counters fail safely without reading original error', async t => {
  const time = clock(t);
  for (const headers of [{ 'X-Browser-Elapsed-Ms': '10' }, { 'X-Browser-Closed': 'closing', 'X-Browser-Elapsed-Ms': '10' }, { 'X-Browser-Closed': '1' }, { 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '-1' }, { 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '180001' }]) {
    const h = harness(() => Response.json({ success: true }, { headers }));
    await maybeParseWithBrowser(request(), native(), h); assert.equal(h.store.values.get(KEY).usedMs, RESERVE); time.advance(30000);
  }
  for (const response of [() => { throw new Error('private URL/cookie/token error sentinel'); }, () => Response.json({ success: false }, { status: 503 }), () => new Response('invalid internal JSON', { status: 422 }), () => Response.json({ success: false, code: 'VERIFICATION_REQUIRED', engine: 'python', verificationUrl: 'private', expiresAt: Date.now() }, { status: 422 })]) {
    const h = harness(response), original = native();
    assert.equal(await maybeParseWithBrowser(request(), original, h), original); assert.equal(original.bodyUsed, false); assert.equal(h.store.values.get(KEY).usedMs, RESERVE);
  }
  const h = harness(); h.store.values.set(KEY, { day: Math.floor(time.now() / 86400000), usedMs: -10, lastStartMs: 0 });
  assert.equal((await maybeParseWithBrowser(request(), native(), h)).status, 503); assert.equal(h.calls.length, 0);
  const failed = harness(); failed.state.storage.transaction = async () => { throw new Error('private storage error'); };
  const original = native(); assert.equal(await maybeParseWithBrowser(request(), original, failed), original); assert.equal(failed.calls.length, 0);
});

test('cancelled request never consumes budget or starts browser', async () => {
  const controller = new AbortController(); controller.abort(); const h = harness(), original = native();
  assert.equal(await maybeParseWithBrowser(request(NOTE, { signal: controller.signal }), original, h), original);
  assert.equal(h.calls.length, 0); assert.equal(h.store.writes.length, 0);
});

test('start deadline and caller cancellation preserve native error and unconfirmed reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const cancel of [false, true]) {
    const h = harness((_payload, req) => req.url.endsWith('/cancel')
      ? Response.json({ success: true, cancelled: true }, { headers: { 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '1' } })
      : new Promise(() => {})), original = native();
    const controller = new AbortController();
    const pending = maybeParseWithBrowser(request(NOTE, { signal: controller.signal }), original, h);
    while (h.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
    if (cancel) controller.abort(); else t.mock.timers.tick(20_000);
    assert.equal(await pending, original);
    assert.equal(h.calls[0].request.signal.aborted, true);
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].request.url, 'https://browser.internal/__internal/browser/cancel');
    assert.deepEqual(h.calls[1].payload, { token: h.calls[0].payload.token });
    assert.equal(h.calls[1].request.signal.aborted, false);
    assert.equal(h.store.values.get(KEY).usedMs, RESERVE);
    assert.equal(h.store.values.has(REGISTRY_KEY), false);
    assert.equal(original.bodyUsed, false);
  }
});

test('a late handoff result after pending-start cancellation cannot register or expose a verification token', async () => {
  let finishStart;
  const h = harness((_payload, req) => req.url.endsWith('/cancel')
    ? Response.json({ success: true, cancelled: true }) : new Promise(resolve => { finishStart = resolve; }));
  const controller = new AbortController(), original = native();
  const pending = maybeParseWithBrowser(request(NOTE, { signal: controller.signal }), original, h);
  while (!finishStart) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const response = await pending;
  assert.equal(response, original); assert.equal(response.bodyUsed, false);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].request.url, 'https://browser.internal/__internal/browser/cancel');
  finishStart(Response.json({ success: false, engine: 'node', code: 'VERIFICATION_REQUIRED', reason: 'captcha',
    verificationUrl: liveURL, expiresAt: Date.now() + 180000 }, { status: 422 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.store.values.has(REGISTRY_KEY), false);
  assert.equal(h.store.values.get(KEY).usedMs, RESERVE);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(await response.json(), { success: false, message: 'original native error sentinel' });
});

test('a prior-day close cannot refund another day reservation and midnight does not reset start cooldown', async t => {
  const start = 1_800_000_000_000;
  const midnight = (Math.floor(start / 86400000) + 1) * 86400000;
  const time = clock(t, midnight - 10000);
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const first = maybeParseWithBrowser(request(), native(), h);
  while (h.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  time.set(midnight + 10000);
  const cooldown = await maybeParseWithBrowser(request(), native(), h);
  assert.equal(cooldown.status, 503); assert.equal(h.calls.length, 1);
  time.set(midnight + 30000);
  // Simulate the same global DO's next UTC-day transaction while the old session closes.
  h.store.values.set(KEY, { day: Math.floor(midnight / 86400000), usedMs: RESERVE, lastStartMs: midnight + 30000 });
  finish(Response.json({ success: true }, { headers: { 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '40000' } }));
  assert.equal((await first).status, 200);
  assert.equal(h.store.values.get(KEY).usedMs, RESERVE);
});
