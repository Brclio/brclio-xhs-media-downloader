import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserVerificationRegistry, BROWSER_VERIFICATION_REGISTRY_KEY as KEY,
  BROWSER_VERIFICATION_DISPATCH_MS as DISPATCH_MS, MAX_ACTIVE_BROWSER_VERIFICATIONS as MAX,
  verificationPayload, verificationTokenDigest } from '../cloudflare/browser-verification.js';

const token = 'a'.repeat(64), secondToken = 'b'.repeat(64);
const liveURL = `https://live.browser.run/ui/view?mode=tab&wss=${encodeURIComponent('live.browser.run/api/devtools/browser/session-fixture/page/target-fixture?jwt=private-jwt-sentinel')}`;
const handoff = (expiresAt, overrides = {}) => ({ success: false, engine: 'node', code: 'VERIFICATION_REQUIRED',
  reason: 'captcha', verificationUrl: liveURL, expiresAt, ...overrides });
function fixture(response = () => Response.json({ success: true })) {
  let time = 1_800_000_000_000;
  const values = new Map(), writes = [], calls = [], names = [];
  let tail = Promise.resolve();
  const storage = { transaction(operation) {
    const pending = tail.then(() => operation({
      async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
      async put(key, value) { values.set(key, structuredClone(value)); writes.push({ key, value: structuredClone(value) }); },
    }));
    tail = pending.catch(() => {}); return pending;
  } };
  const namespace = { idFromName(name) { names.push(name); return name; }, get(id) { return { async fetch(request) {
    const data = await request.json(); calls.push({ id, request, data }); return response(request, data);
  } }; } };
  const now = () => time;
  const registry = new BrowserVerificationRegistry(storage, namespace, { now });
  return { registry, values, writes, calls, names, storage, namespace, now, advance: ms => { time += ms; },
    register: (current = token, extra = {}) => registry.register(current, { engine: 'node', expiresAt: time + 180000, ...extra }),
    entry: () => values.get(KEY)?.[0] };
}
const waitFor = async predicate => { while (!predicate()) await new Promise(resolve => setImmediate(resolve)); };

test('only bounded hashed capabilities persist and their original deadline cannot be extended', async () => {
  const f = fixture();
  for (const invalid of [null, '', 'a'.repeat(63), token.toUpperCase(), [token]]) assert.equal(await f.register(invalid), false);
  for (const extra of [{ engine: 'other' }, { expiresAt: f.now() }, { expiresAt: f.now() + 180001 }]) assert.equal(await f.register(token, extra), false);
  assert.equal(f.writes.length, 0);
  assert.equal(await f.register(), true);
  const original = f.entry().expiresAt;
  assert.equal(f.entry().digest, await verificationTokenDigest(token));
  assert.equal(JSON.stringify(f.entry()).includes(token), false);
  assert.deepEqual(Object.keys(f.entry()).sort(), ['cancelLeaseUntil', 'digest', 'engine', 'expiresAt', 'leaseUntil', 'nextResumeAt', 'sequence', 'terminal']);
  f.advance(1000);
  assert.equal(await f.register(), false);
  assert.equal(await f.register(token, { expiresAt: original }), true);
  assert.equal(f.entry().expiresAt, original);
  for (let index = 1; index < MAX; index++) assert.equal(await f.register(index.toString(16).padStart(64, '0')), true);
  assert.equal(await f.register(secondToken), false); assert.equal(f.values.get(KEY).length, MAX);
  f.advance(180000);
  assert.equal(await f.register(secondToken), true); assert.equal(f.values.get(KEY).length, 1);
  assert.deepEqual(f.calls, []);
});

test('unknown, invalid and expired tokens never address an owner or create registry records', async () => {
  const f = fixture();
  for (let index = 0; index < 40; index++) {
    const response = await f.registry.dispatch({ token: index.toString(16).padStart(64, '0'), action: index % 2 ? 'resume' : 'cancel' });
    assert.equal(response.status, 410);
  }
  assert.equal((await f.registry.dispatch({ token, action: 'start' })).status, 400);
  assert.equal((await f.registry.dispatch({ token: 'invalid', action: 'resume' })).status, 400);
  assert.deepEqual(f.names, []); assert.deepEqual(f.writes, []);
  await f.register(); f.advance(180000);
  assert.equal((await f.registry.dispatch({ token, action: 'resume' })).status, 410);
  assert.deepEqual(f.values.get(KEY), []); assert.deepEqual(f.names, []);
});

test('in-flight resumes are rejected across runtime eviction and handoff retains its fixed deadline', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  await f.register(); const deadline = f.entry().expiresAt;
  const first = f.registry.dispatch({ token, action: 'resume' });
  await waitFor(() => f.calls.length === 1);
  const afterEviction = new BrowserVerificationRegistry(f.storage, f.namespace, { now: f.now });
  const duplicate = await Promise.all(Array.from({ length: 8 }, () => afterEviction.dispatch({ token, action: 'resume' })));
  assert.ok(duplicate.every(response => response.status === 429)); assert.equal(f.calls.length, 1);
  finish(Response.json(handoff(deadline, { reason: 'access-error', private: 'private-cookie-sentinel' }), {
    status: 422, headers: { 'X-Browser-Closed': '1', 'X-Browser-Elapsed-Ms': '1' },
  }));
  const response = await first, body = await response.json();
  assert.equal(response.status, 422); assert.equal(body.reason, 'access-error'); assert.equal(body.verificationToken, token);
  assert.equal(body.expiresAt, deadline); assert.equal(body.private, undefined);
  assert.equal(response.headers.get('X-Browser-Closed'), null); assert.equal(response.headers.get('X-Browser-Elapsed-Ms'), null);
  assert.equal(f.entry().leaseUntil, 0); assert.equal(f.entry().expiresAt, deadline);
  assert.equal((await afterEviction.dispatch({ token, action: 'resume' })).status, 429);
  f.advance(2000);
  const next = afterEviction.dispatch({ token, action: 'resume' }); await waitFor(() => f.calls.length === 2);
  finish(Response.json({ success: true }, { headers: { 'X-Browser-Closed': '1' } }));
  assert.equal((await next).status, 200); assert.deepEqual(f.values.get(KEY), []);
  assert.equal((await afterEviction.dispatch({ token, action: 'resume' })).status, 410); assert.equal(f.calls.length, 2);
});

test('cancellation interrupts one resume, duplicate cancels do not queue, and late results cannot revive it', async () => {
  let finishResume, finishCancel;
  const f = fixture(request => new Promise(resolve => {
    if (request.url.endsWith('/resume')) finishResume = resolve; else finishCancel = resolve;
  }));
  await f.register();
  const resume = f.registry.dispatch({ token, action: 'resume' }); await waitFor(() => finishResume);
  const cancel = f.registry.dispatch({ token, action: 'cancel' }); await waitFor(() => finishCancel);
  assert.equal((await f.registry.dispatch({ token, action: 'cancel' })).status, 429);
  assert.equal((await f.registry.dispatch({ token, action: 'resume' })).status, 410);
  assert.equal(f.calls.length, 2);
  finishCancel(Response.json({ success: true, cancelled: true }, { headers: { 'X-Browser-Closed': '1' } }));
  assert.equal((await cancel).status, 200);
  finishResume(Response.json({ success: true, private: 'late-private-page' }));
  const late = await resume; assert.equal(late.status, 410); assert.equal((await late.text()).includes('late-private-page'), false);
  assert.deepEqual(f.values.get(KEY), []);
  assert.equal((await f.registry.dispatch({ token, action: 'cancel' })).status, 410); assert.equal(f.calls.length, 2);
});

test('unconfirmed failures forbid resume but permit cleanup without refunding or renewing the deadline', async () => {
  let result = () => Response.json({ success: false }, { status: 503 });
  const f = fixture(() => result()); await f.register(); const deadline = f.entry().expiresAt;
  f.values.set('browser-parse-budget-v1', { day: 1, usedMs: 180000, lastStartMs: f.now() });
  assert.equal((await f.registry.dispatch({ token, action: 'resume' })).status, 503);
  assert.equal(f.entry().terminal, true); assert.equal(f.entry().expiresAt, deadline);
  assert.equal((await f.registry.dispatch({ token, action: 'resume' })).status, 410); assert.equal(f.calls.length, 1);
  result = () => Response.json({ success: true, cancelled: true }, { headers: { 'X-Browser-Closed': '1' } });
  assert.equal((await f.registry.dispatch({ token, action: 'cancel' })).status, 200); assert.equal(f.calls.length, 2);
  assert.equal(f.values.get('browser-parse-budget-v1').usedMs, 180000); assert.deepEqual(f.values.get(KEY), []);
});

test('confirmed close and expired responses retire capabilities, including failure results', async () => {
  for (const response of [() => Response.json({ success: false }, { status: 503, headers: { 'X-Browser-Closed': '1' } }),
    () => Response.json({ success: false, code: 'VERIFICATION_EXPIRED' }, { status: 410 })]) {
    const f = fixture(response); await f.register();
    const result = await f.registry.dispatch({ token, action: 'resume' });
    assert.equal(result.headers.get('X-Browser-Closed'), null); assert.deepEqual(f.values.get(KEY), []);
    assert.equal((await f.registry.dispatch({ token, action: 'resume' })).status, 410); assert.equal(f.calls.length, 1);
  }
});

test('a request timeout keeps the lease and reservation conservative while allowing one cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(request => request.url.endsWith('/cancel') ? Response.json({ success: true, cancelled: true }) : new Promise(() => {}));
  await f.register(); const pending = f.registry.dispatch({ token, action: 'resume' });
  await waitFor(() => f.calls.length === 1);
  t.mock.timers.tick(DISPATCH_MS);
  assert.equal((await pending).status, 503); assert.equal(f.calls[0].request.signal.aborted, true);
  assert.equal(f.entry().terminal, true); assert.equal(f.entry().leaseUntil, f.now() + DISPATCH_MS);
  assert.equal((await f.registry.dispatch({ token, action: 'resume' })).status, 410);
  assert.equal((await f.registry.dispatch({ token, action: 'cancel' })).status, 200); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.values.get(KEY), []);
});

test('corrupt storage and invalid verification replies fail closed without issuing new capabilities', async () => {
  const corrupt = fixture(); corrupt.values.set(KEY, [{ digest: token, expiresAt: corrupt.now() + 180000 }]);
  assert.equal((await corrupt.registry.dispatch({ token, action: 'resume' })).status, 503);
  assert.deepEqual(corrupt.calls, []); await assert.rejects(corrupt.register());
  for (const override of [{ expiresAt: 1_800_000_180_001 }, { engine: 'python' }, { verificationUrl: 'https://evil.test/' }]) {
    const f = fixture(() => Response.json(handoff(f.now() + 180000, override), { status: 422 }));
    await f.register(); const response = await f.registry.dispatch({ token, action: 'resume' });
    assert.equal(response.status, 503); assert.equal(f.entry().terminal, true);
    assert.equal((await f.registry.dispatch({ token, action: 'resume' })).status, 410); assert.equal(f.calls.length, 1);
  }
});

test('verification projection rejects forged connection destinations and exposes only reason enums', () => {
  const now = 1_800_000_000_000, body = handoff(now + 180000);
  for (const verificationUrl of ['https://evil.test/ui/view', liveURL.replace('mode=tab', 'mode=full'), `${liveURL}#private`,
    `https://live.browser.run/ui/view?mode=tab&wss=${encodeURIComponent('evil.test/api/devtools/browser/session/page/target?jwt=token')}`,
    `https://live.browser.run/ui/view?mode=tab&wss=${encodeURIComponent('live.browser.run/api/devtools/browser/session/page/target?jwt=token&jwt=second')}`]) {
    assert.equal(verificationPayload({ ...body, verificationUrl }, 'node', { now }), null);
  }
  for (const reason of ['captcha', 'login', 'access-error']) assert.equal(verificationPayload({ ...body, reason }, 'node', { now }).reason, reason);
  const projected = verificationPayload({ ...body, reason: 'private-note-sentinel', secret: 'private-secret-sentinel' }, 'node', { now });
  assert.equal(projected.reason, undefined); assert.equal(projected.secret, undefined);
  assert.equal(verificationPayload(body, 'node', { now, expiresAt: body.expiresAt - 1 }), null);
});
