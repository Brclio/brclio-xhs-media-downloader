import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionManager, BrowserSessionError, BROWSER_SESSION_KEY,
  BROWSER_SESSION_TTL_MS, MAX_BROWSER_HTML_BYTES } from '../cloudflare/browser-session.js';

const token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
const noteId = 'abcdef1234567890abcdef12', otherId = '1234567890abcdef12345678';
const sourceURL = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=PRIVATE_SOURCE`;
const noteHTML = `<html><script>window.__INITIAL_STATE__={"noteId":"${noteId}"}</script></html>`;
const page = (finalUrl = sourceURL, html = noteHTML) => ({ finalUrl, html });
const gate = () => page('https://www.xiaohongshu.com/captcha/check', '<title>小红书安全验证</title>');
const privateSentinel = 'PRIVATE_RAW_EXCEPTION_OR_LIVE_TOKEN';

function fixture({ snapshots = [page()], callTimeoutMs = 30, waitMs = 100, socketBehavior,
  acquire, close, getSession, liveView, sleep, now = 1_000_000, storage: suppliedStorage } = {}) {
  const calls = { acquire: [], newTarget: [], connect: [], commands: [], close: [], liveView: [], sockets: [] };
  const data = new Map(), puts = [], alarms = [];
  let time = now;
  const storage = suppliedStorage || {
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { puts.push(structuredClone(value)); data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async setAlarm(value) { alarms.push(value); this.alarm = value; },
    async deleteAlarm() { this.alarm = null; },
  };
  class Socket extends EventTarget {
    accepted = false; closed = false;
    accept() { this.accepted = true; }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
    send(text) {
      const command = JSON.parse(text); calls.commands.push(command);
      const emit = value => this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }));
      if (socketBehavior) return socketBehavior({ command, emit, socket: this });
      const snapshot = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
      queueMicrotask(() => emit({ id: command.id, result: { result: { type: 'object', value: snapshot } } }));
    }
  }
  const browser = {
    async acquire(options) { calls.acquire.push(options); return acquire ? acquire(options) : { sessionId: `session_${calls.acquire.length}` }; },
    devtools: { async newTarget(sessionId, url) { calls.newTarget.push({ sessionId, url }); return { id: 'target_1' }; } },
    async connectSession(sessionId, options) {
      calls.connect.push({ sessionId, options });
      return { webSocket: { fetch: async (url, request) => {
        assert.equal(url, 'https://browser-binding.invalid'); assert.equal(request.headers.Upgrade, 'websocket');
        const socket = new Socket(); calls.sockets.push(socket); return { webSocket: socket };
      } } };
    },
    async closeSession(sessionId) { calls.close.push(sessionId); return close ? close(sessionId) : { status: 'closed' }; },
    async getSession(sessionId) { return getSession ? getSession(sessionId) : null; },
    async getLiveView(sessionId, options) {
      calls.liveView.push({ sessionId, options });
      return liveView ? liveView(sessionId, options) : {
        devtoolsFrontendUrl: `https://live.browser.run/ui/view?mode=tab&wss=${encodeURIComponent(`live.browser.run/api/devtools/browser/${sessionId}/page/${options.targetId}?jwt=${privateSentinel}`)}`,
      };
    },
  };
  const state = { storage };
  const options = { authorizeToken: value => value === token, now: () => time,
    sleep: sleep || (async ms => { time += ms; }), callTimeoutMs, waitMs, pollMs: 10 };
  const manager = new BrowserSessionManager(state, browser, options);
  return { manager, browser, state, options, calls, data, puts, alarms,
    get time() { return time; }, advance(ms) { time += ms; },
    start: overrides => manager.start({ token, engine: 'node', noteId, sourceURL, ...overrides }) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof BrowserSessionError
  && error.code === code && error.message === code && !error.stack.includes(privateSentinel));

// Each test verifies externally observable lifecycle/security behavior, not just shape.
test('ordinary browser success closes the remote session and deletes all lifecycle state', async () => {
  const f = fixture();
  const result = await f.start();
  assert.deepEqual(result, { kind: 'page', engine: 'node', noteId, finalUrl: sourceURL, html: noteHTML, closed: true });
  assert.equal(f.calls.acquire.length, 1); assert.deepEqual(f.calls.close, ['session_1']);
  assert.equal(f.data.size, 0); assert.equal(f.state.storage.alarm, null);
  assert.ok(f.calls.sockets.every(socket => socket.closed));
  assert.equal(f.calls.acquire[0].recording, false);
  assert.equal(f.calls.acquire[0].keepAlive, BROWSER_SESSION_TTL_MS);
  assert.deepEqual(f.calls.acquire[0].guardrails.allowedDomains, [
    'xiaohongshu.com', '*.xiaohongshu.com', 'xhslink.com', '*.xhslink.com',
    'xhslink.cn', '*.xhslink.cn', 'xhscdn.com', '*.xhscdn.com']);
  for (const saved of f.puts) {
    assert.deepEqual(Object.keys(saved).sort(), ['deadline','engine','noteId','sessionId','sourceURL','targetId']);
    assert.ok(!JSON.stringify(saved).includes(noteHTML)); assert.ok(!JSON.stringify(saved).includes(privateSentinel));
    assert.ok(!JSON.stringify(saved).includes(token));
  }
  for (const command of f.calls.commands) {
    assert.equal(command.method, 'Runtime.evaluate');
    assert.match(command.params.expression, /document\.documentElement\?\.outerHTML/);
    assert.match(command.params.expression, /location\.href/);
    assert.ok(!command.params.expression.includes(noteId));
    assert.ok(!command.params.expression.includes('PRIVATE_SOURCE'));
    assert.equal(command.params.returnByValue, true); assert.equal(command.params.throwOnSideEffect, undefined);
  }
});

test('concurrent identical start requests share one acquisition and completed result', async () => {
  const f = fixture();
  const results = await Promise.all([f.start(), f.start(), f.start()]);
  assert.equal(f.calls.acquire.length, 1); assert.equal(f.calls.newTarget.length, 1);
  assert.ok(results.every(value => value.kind === 'page' && value.closed));
});

test('CAPTCHA prompts only after an ordinary navigation and persists no HTML or Live View credential', async () => {
  const f = fixture({ snapshots: [gate()] });
  const result = await f.start();
  assert.equal(result.kind, 'verification'); assert.equal(result.engine, 'node');
  assert.equal(result.expiresAt, 1_180_000);
  assert.equal(f.calls.newTarget[0].url, sourceURL);
  assert.equal(f.calls.close.length, 0); assert.equal(f.calls.liveView.length, 1);
  assert.equal(f.state.storage.alarm, result.expiresAt);
  assert.equal(f.data.get(BROWSER_SESSION_KEY).sourceURL, sourceURL);
  assert.equal(f.calls.liveView[0].options.mode, 'tab');
  assert.ok(f.calls.liveView[0].options.expiresInMs <= BROWSER_SESSION_TTL_MS);
  assert.ok(!JSON.stringify([...f.data.values()]).includes(privateSentinel));
  assert.ok(!JSON.stringify([...f.data.values()]).includes('<title>'));
  assert.ok(f.calls.sockets.every(socket => socket.closed));
});

test('resume after eviction reads the same target, preserves deadline and never navigates or acquires again', async () => {
  const f = fixture({ snapshots: [gate()] });
  const first = await f.start();
  const next = new BrowserSessionManager(f.state, f.browser, f.options);
  await rejectsCode(next.resume({ token: otherToken }), 'BROWSER_OWNER_REJECTED');
  f.advance(5_000);
  const stillGate = await next.resume({ token });
  assert.equal(stillGate.expiresAt, first.expiresAt);
  // Simulate the human completing the challenge; replace only the mocked page read.
  f.browser.connectSession = async () => ({ webSocket: { fetch: async () => ({ webSocket: new class extends EventTarget {
    accept() {} close() {}
    send(text) { const { id } = JSON.parse(text); queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ id, result: { result: { type: 'object', value: page() } } }),
    }))); }
  } }) } });
  const result = await next.resume({ token });
  assert.equal(result.kind, 'page'); assert.equal(result.closed, true);
  assert.equal(f.calls.acquire.length, 1); assert.equal(f.calls.newTarget.length, 1); assert.equal(f.data.size, 0);
});

test('a shortlink with no known ID establishes identity only on a final valid note page', async () => {
  const f = fixture();
  const result = await f.start({ noteId: null, sourceURL: 'https://xhslink.cn/o/fixture' });
  assert.equal(result.kind, 'page'); assert.equal(result.noteId, noteId); assert.equal(result.closed, true);
  assert.ok(f.puts.some(value => value.noteId === noteId));
});

test('known note ID mismatches and homepage or recommendation pages are rejected and closed', async () => {
  for (const [snapshot, expected] of [
    [page(`https://www.xiaohongshu.com/explore/${otherId}`), 'BROWSER_NOTE_MISMATCH'],
    [page('https://www.xiaohongshu.com/', noteHTML), 'BROWSER_PAGE_REJECTED'],
    [page('https://www.xiaohongshu.com/explore/'), 'BROWSER_PAGE_REJECTED'],
    [page('https://www.xiaohongshu.com/website-login'), 'BROWSER_PAGE_REJECTED'],
    [page(sourceURL, '<title>小红书登录</title>'), 'BROWSER_PAGE_REJECTED'],
  ]) {
    const f = fixture({ snapshots: [snapshot] });
    await rejectsCode(f.start(), expected);
    assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
  }
});

test('strict navigation validation rejects lookalikes, protocols, credentials, ports and non-note sources', async () => {
  for (const invalid of [
    'http://www.xiaohongshu.com/explore/' + noteId,
    'https://www.xiaohongshu.com.evil.example/explore/' + noteId,
    'https://user:password@www.xiaohongshu.com/explore/' + noteId,
    'https://www.xiaohongshu.com:8443/explore/' + noteId,
    'https://127.0.0.1/explore/' + noteId,
    'https://www.xiaohongshu.com/',
    'https://www.xiaohongshu.com/explore/' + noteId + ';extra',
  ]) {
    const f = fixture(); await assert.rejects(f.start({ sourceURL: invalid }), BrowserSessionError);
    assert.equal(f.calls.acquire.length, 0);
    const redirected = fixture({ snapshots: [page(invalid)] });
    await assert.rejects(redirected.start(), BrowserSessionError);
    assert.equal(redirected.calls.close.length, 1);
  }
});

test('owner authorization is required for every action and prevents cross-user resource operations', async () => {
  assert.throws(() => new BrowserSessionManager({}, {}), /BROWSER_OWNER_REQUIRED/);
  const f = fixture({ snapshots: [gate()] }); await f.start();
  for (const value of [otherToken, token.slice(1), 'not-a-token']) {
    await rejectsCode(f.manager.start({ token: value, engine: 'node', noteId, sourceURL }), 'BROWSER_OWNER_REJECTED');
    await rejectsCode(f.manager.resume({ token: value }), 'BROWSER_OWNER_REJECTED');
    await rejectsCode(f.manager.cancel({ token: value }), 'BROWSER_OWNER_REJECTED');
  }
  assert.equal(f.calls.close.length, 0); assert.equal(f.calls.acquire.length, 1);
});

test('independent owners get independent acquisitions and no session or cookie reuse', async () => {
  const first = fixture({ snapshots: [gate()] }), second = fixture({ snapshots: [gate()] });
  await first.start(); await second.start({ engine: 'python' });
  assert.equal(first.calls.acquire.length, 1); assert.equal(second.calls.acquire.length, 1);
  assert.equal(first.data.get(BROWSER_SESSION_KEY).engine, 'node');
  assert.equal(second.data.get(BROWSER_SESSION_KEY).engine, 'python');
  assert.notEqual(first.data, second.data);
});

test('HTML limit uses UTF-8 bytes and rejects oversize before returning a page', async () => {
  for (const html of [null, 'a'.repeat(MAX_BROWSER_HTML_BYTES + 1), '汉'.repeat(MAX_BROWSER_HTML_BYTES / 3 + 1)]) {
    const f = fixture({ snapshots: [page(sourceURL, html)] });
    await rejectsCode(f.start(), 'BROWSER_HTML_TOO_LARGE');
    assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
  }
});

test('ordinary hydration waits are bounded, do not prompt without a gate, and clean up connections', async () => {
  const f = fixture({ snapshots: [page(sourceURL, '<html>loading</html>')], waitMs: 80 });
  const result = await f.start();
  assert.equal(result.kind, 'page'); assert.equal(result.html, '<html>loading</html>');
  assert.equal(f.time, 1_000_080); assert.equal(f.calls.liveView.length, 0);
  assert.ok(f.calls.commands.length <= 9); assert.ok(f.calls.sockets.every(socket => socket.closed));
});

test('stalled CDP and remote exceptions are bounded and never expose raw provider errors', async () => {
  for (const socketBehavior of [() => {}, ({ command, emit }) => queueMicrotask(() => emit({ id: command.id, error: { message: privateSentinel } }))]) {
    const f = fixture({ socketBehavior, callTimeoutMs: 10 });
    await assert.rejects(f.start(), error => error instanceof BrowserSessionError && !JSON.stringify(error).includes(privateSentinel)
      && error.closed === true);
    assert.equal(f.calls.close.length, 1); assert.ok(f.calls.sockets.every(socket => socket.closed));
  }
  const f = fixture({ acquire: () => { throw new Error(privateSentinel); } });
  await rejectsCode(f.start(), 'BROWSER_ACQUIRE_FAILED');
});

test('malformed CDP responses and exceptions fail closed and remove listeners', async () => {
  for (const payload of ['{malformed', { result: { result: { type: 'object', value: page() }, exceptionDetails: { text: privateSentinel } } }]) {
    const f = fixture({ socketBehavior: ({ command, emit }) => queueMicrotask(() => emit(typeof payload === 'string' ? payload : { id: command.id, ...payload })) });
    await assert.rejects(f.start(), BrowserSessionError);
    assert.ok(f.calls.sockets.every(socket => socket.closed)); assert.equal(f.data.size, 0);
  }
});

test('unsafe or cross-target Live View URLs are never returned and force remote cleanup', async () => {
  for (const url of [
    'https://evil.example/ui/view?mode=tab&wss=live.browser.run',
    'https://live.browser.run/ui/view?mode=devtools&wss=live.browser.run',
    'https://live.browser.run/ui/view?mode=tab&wss=evil.example/api/devtools/browser/session_1/page/target_1',
    'https://live.browser.run/ui/view?mode=tab&wss=live.browser.run/api/devtools/browser/another/page/target_1',
  ]) {
    const f = fixture({ snapshots: [gate()], liveView: () => ({ devtoolsFrontendUrl: url }) });
    await rejectsCode(f.start(), 'BROWSER_LIVE_VIEW_INVALID');
    assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
  }
});

test('absolute deadline rejects resume and alarm really closes a live session', async () => {
  const f = fixture({ snapshots: [gate()] }); const first = await f.start();
  f.advance(BROWSER_SESSION_TTL_MS);
  await rejectsCode(f.manager.resume({ token }), 'BROWSER_EXPIRED');
  assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
  const alarm = fixture({ snapshots: [gate()] }); await alarm.start();
  alarm.advance(BROWSER_SESSION_TTL_MS - 1); await alarm.manager.alarm();
  assert.equal(alarm.calls.close.length, 0); assert.equal(alarm.state.storage.alarm, first.expiresAt);
  alarm.advance(1); await alarm.manager.alarm();
  assert.equal(alarm.calls.close.length, 1); assert.equal(alarm.data.size, 0);
});

test('closing is not closed: only an observed null/closed session permits a closed result', async () => {
  const confirmed = fixture({ close: () => ({ status: 'closing' }), getSession: () => null });
  assert.equal((await confirmed.start()).closed, true);
  const uncertain = fixture({ close: () => ({ status: 'closing' }), getSession: () => ({ status: 'running' }) });
  assert.equal((await uncertain.start()).closed, false);
  assert.equal(uncertain.data.get(BROWSER_SESSION_KEY).deadline, uncertain.time);
  assert.ok(uncertain.state.storage.alarm > uncertain.time);
  await rejectsCode(uncertain.manager.resume({ token }), 'BROWSER_EXPIRED');
});

test('close failure retains expired metadata, retries on alarms and stops retrying at the hard cap', async () => {
  let canClose = false;
  const f = fixture({ close: () => { if (!canClose) throw new Error(privateSentinel); return { status: 'closed' }; } });
  assert.equal((await f.start()).closed, false);
  f.advance(10_000); await f.manager.alarm(); assert.equal(f.calls.close.length, 2);
  canClose = true; f.advance(10_000); await f.manager.alarm(); assert.equal(f.data.size, 0);
  const capped = fixture({ close: () => { throw new Error(privateSentinel); } });
  await capped.start(); const attempts = capped.calls.close.length;
  capped.advance(60_000); await capped.manager.alarm();
  assert.equal(capped.calls.close.length, attempts); assert.equal(capped.data.size, 0);
});

test('late acquire is closed after timeout and never claims a confirmed close before its ID arrives', async () => {
  let deliver;
  const f = fixture({ callTimeoutMs: 10, acquire: () => new Promise(resolve => { deliver = resolve; }) });
  await assert.rejects(f.start(), error => error.code === 'BROWSER_ACQUIRE_FAILED' && error.closed === false);
  assert.equal(f.calls.close.length, 0);
  deliver({ sessionId: 'late_session' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(f.calls.close, ['late_session']); assert.equal(f.data.size, 0);
});

test('cancellation interrupts a polling operation, then closes and deletes its session', async () => {
  let release, started;
  const sleeping = new Promise(resolve => { started = resolve; });
  const f = fixture({ snapshots: [page(sourceURL, '<html>loading</html>')], sleep: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const opening = f.start(); const rejected = rejectsCode(opening, 'BROWSER_CANCELLED');
  await sleeping; const cancellation = f.manager.cancel({ token }); await Promise.resolve(); release();
  await rejected; const result = await cancellation;
  assert.equal(result.kind, 'cancelled'); assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
});

test('generic initial state alone does not finish before the current note hydrates', async () => {
  const generic = '<script>window.__INITIAL_STATE__={"recommendations":[]}</script>';
  const f = fixture({ snapshots: [page(sourceURL, generic), page()] });
  const result = await f.start();
  assert.equal(result.html, noteHTML); assert.equal(f.calls.commands.length, 2);
  assert.equal(f.time, 1_000_010);
});

test('valid primary media can finish a matching note page without an initial-state marker', async () => {
  const html = '<meta property="og:image" content="https://sns-webpic-qc.xhscdn.com/fixture-valid-media">';
  const f = fixture({ snapshots: [page(sourceURL, html)] });
  const result = await f.start();
  assert.equal(result.html, html); assert.equal(f.calls.commands.length, 1);
});

test('Live View minimum URL lifetime never extends the absolute session deadline', async () => {
  const f = fixture({ snapshots: [gate()] }); const first = await f.start();
  f.advance(125_000);
  const resumed = await f.manager.resume({ token });
  assert.equal(resumed.expiresAt, first.expiresAt);
  assert.equal(f.calls.liveView.at(-1).options.expiresInMs, 60_000);
  assert.equal(f.state.storage.alarm, first.expiresAt);
  f.advance(55_000); await f.manager.alarm(); assert.equal(f.data.size, 0);
});

test('Live View outer and nested fragments, missing or ambiguous jwt are rejected', async () => {
  const socket = 'live.browser.run/api/devtools/browser/session_1/page/target_1';
  const view = nested => `https://live.browser.run/ui/view?mode=tab&wss=${encodeURIComponent(nested)}`;
  for (const url of [view(socket + '?jwt=valid') + '#fragment', view(socket + '?jwt=valid#fragment'),
    view(socket), view(socket + '?jwt='), view(socket + '?jwt=one&jwt=two')]) {
    const f = fixture({ snapshots: [gate()], liveView: () => ({ devtoolsFrontendUrl: url }) });
    await rejectsCode(f.start(), 'BROWSER_LIVE_VIEW_INVALID'); assert.equal(f.calls.close.length, 1);
  }
});

test('close and confirmation share one call budget and uncertainty never refunds as closed', async () => {
  let f;
  f = fixture({ callTimeoutMs: 10, close: () => { f.advance(9); return { status: 'closing' }; }, getSession: () => new Promise(() => {}) });
  const result = await f.start();
  assert.equal(result.closed, false); assert.ok(f.state.storage.alarm > f.time);
});

test('public session errors allow only fixed codes, including errors supplied by a provider', async () => {
  assert.equal(new BrowserSessionError(privateSentinel).message, 'BROWSER_FAILED');
  const f = fixture({ acquire: () => { throw new BrowserSessionError(privateSentinel); } });
  await rejectsCode(f.start(), 'BROWSER_FAILED');
});
