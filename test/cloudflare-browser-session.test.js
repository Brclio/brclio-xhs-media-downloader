import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionManager, BrowserSessionError, BROWSER_SESSION_KEY,
  BROWSER_SESSION_TTL_MS, MAX_BROWSER_HTML_BYTES } from '../cloudflare/browser-session.js';

const token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
const noteId = 'abcdef1234567890abcdef12', otherId = '1234567890abcdef12345678';
const sourceURL = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=PRIVATE_SOURCE`;
const noteHTML = `<html><script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {
  [noteId]: { note: { noteId, imageList: [{ urlDefault: 'https://ci.xiaohongshu.com/test/image' }] } },
} } })};</script></html>`;
const page = (finalUrl = sourceURL, html = noteHTML) => ({ finalUrl, html });
const gate = () => page('https://www.xiaohongshu.com/captcha/check', '<title>小红书安全验证</title>');
const privateSentinel = 'PRIVATE_RAW_EXCEPTION_OR_LIVE_TOKEN';

function fixture({ snapshots = [page()], callTimeoutMs = 30, waitMs = 100, socketBehavior,
  acquire, close, getSession, liveView, sleep, frameTrees, now = 1_000_000, storage: suppliedStorage } = {}) {
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
      if (command.method === 'Page.enable') {
        queueMicrotask(() => emit({ id: command.id, result: {} })); return;
      }
      if (command.method === 'Page.navigate') {
        queueMicrotask(() => emit({ id: command.id, result: { frameId: 'frame_1', loaderId: 'loader_1' } })); return;
      }
      if (command.method === 'Page.getFrameTree') {
        const frame = frameTrees ? (frameTrees.length > 1 ? frameTrees.shift() : frameTrees[0])
          : { id: 'frame_1', loaderId: calls.commands.some(value => value.method === 'Page.navigate') ? 'loader_1' : 'old_loader', url: sourceURL };
        queueMicrotask(() => emit({ id: command.id, result: { frameTree: { frame } } })); return;
      }
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

test('trusted nested CAPTCHA takes priority over login path and title', async () => {
  const f = fixture({ snapshots: [page('https://www.xiaohongshu.com/website-login/captcha?private=SECRET',
    '<title>小红书登录</title>')] });
  const result = await f.start();
  assert.equal(result.kind, 'verification'); assert.equal(result.reason, 'captcha');
  assert.equal(f.calls.liveView.length, 1); assert.equal(f.calls.close.length, 0);
  const ordinary = fixture({ snapshots: [page('https://www.xiaohongshu.com/website-login', '<title>小红书登录</title>')] });
  const loginResult = await ordinary.start();
  assert.equal(loginResult.kind, 'verification'); assert.equal(loginResult.reason, 'login');
  assert.equal(ordinary.calls.liveView.length, 1); assert.equal(ordinary.calls.close.length, 0);
  const untrusted = fixture({ snapshots: [page('https://evil.example/website-login/captcha', '<title>小红书安全验证</title>')] });
  await rejectsCode(untrusted.start(), 'BROWSER_PAGE_REJECTED');
  assert.equal(untrusted.calls.liveView.length, 0);
});

test('failure diagnostics project only fixed location classes, byte count and branded booleans', async () => {
  const cases = [
    [page('chrome-error://chromewebdata/?PRIVATE_LOCATION', '<title>PRIVATE_HTML</title>'), 'other', 'error', false, false],
    [page('https://www.xiaohongshu.com/website-login/unknown?PRIVATE_QUERY#PRIVATE_HASH', '<title>小红书登录</title>'), 'www', 'login', false, true],
    [page('https://xiaohongshu.com/?PRIVATE_QUERY', '<title>PRIVATE_HTML</title>'), 'apex', 'root', false, false],
    [page('https://xhslink.cn/o/PRIVATE_PATH', '<title>PRIVATE_HTML</title>'), 'shortlink', 'shortlink', false, false],
    [page('https://evil.example/PRIVATE_PATH?PRIVATE_QUERY', '<title>小红书安全验证</title>PRIVATE_HTML'), 'other', 'other', true, false],
    [page(`https://www.xiaohongshu.com/explore/${otherId}?PRIVATE_QUERY`, '<title>PRIVATE_HTML</title>'), 'www', 'note', false, false],
  ];
  for (const [snapshot, hostname, pathClass, brandedCaptcha, brandedLogin] of cases) {
    const f = fixture({ snapshots: [snapshot] });
    await assert.rejects(f.start(), error => {
      assert.equal(error.closed, true);
      assert.deepEqual(error.diagnostic, { finalLocation: { hostname, pathClass },
        htmlBytes: new TextEncoder().encode(snapshot.html).byteLength, brandedCaptcha, brandedLogin });
      assert.ok(!JSON.stringify(error).includes('PRIVATE_'));
      assert.ok(!JSON.stringify(error).includes(noteId)); assert.ok(!JSON.stringify(error).includes(otherId));
      return true;
    });
    assert.ok(f.puts.every(saved => !Object.hasOwn(saved, 'diagnostic')));
    assert.equal(f.data.size, 0);
  }
  const projected = new BrowserSessionError('BROWSER_FAILED', false, { finalLocation: { hostname: 'www', pathClass: 'login', url: 'PRIVATE_URL' },
    htmlBytes: 10, brandedCaptcha: false, brandedLogin: true, html: 'PRIVATE_HTML', token: 'PRIVATE_TOKEN' });
  assert.ok(!JSON.stringify(projected).includes('PRIVATE_'));
  assert.equal(new BrowserSessionError('BROWSER_FAILED', false, { ...projected.diagnostic,
    finalLocation: { hostname: 'PRIVATE_HOST', pathClass: 'login' } }).diagnostic, undefined);
  assert.equal(new BrowserSessionError('BROWSER_FAILED', false, { ...projected.diagnostic, htmlBytes: Infinity }).diagnostic, undefined);
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

test('trusted login and access-error pages stay open for manual action without automatically navigating', async () => {
  for (const hostname of ['www.xiaohongshu.com', 'xiaohongshu.com']) {
    for (const [path, reason] of [['/website-login', 'login'], ['/login/', 'login'], ['/signin', 'login'],
      ['/website-login/error', 'access-error'], ['/captcha/check', 'captcha']]) {
      const f = fixture({ snapshots: [page(`https://${hostname}${path}?private=PRIVATE_QUERY`, '<title>小红书</title>')] });
      const result = await f.start();
      assert.equal(result.kind, 'verification'); assert.equal(result.reason, reason);
      assert.equal(f.calls.acquire.length, 1); assert.equal(f.calls.newTarget.length, 1);
      assert.equal(f.calls.close.length, 0); assert.equal(f.calls.liveView.length, 1);
      assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 0);
      assert.equal(f.data.get(BROWSER_SESSION_KEY).deadline, result.expiresAt);
      assert.ok(f.puts.every(saved => Object.keys(saved).length === 6));
    }
  }
});

test('matching original note pages with branded CAPTCHA or login remain available to their owner', async () => {
  for (const [title, reason] of [['小红书安全验证', 'captcha'], ['小红书登录', 'login']]) {
    const f = fixture({ snapshots: [page(sourceURL, `<title>${title}</title>`)] });
    const result = await f.start(); assert.equal(result.kind, 'verification'); assert.equal(result.reason, reason);
    assert.equal(f.calls.close.length, 0);
  }
});

test('manual handoff does not broaden the trusted host, path or note identity boundary', async () => {
  for (const url of ['https://evil.example/website-login/error', 'https://www.xiaohongshu.com.evil.example/login',
    'https://foo.xiaohongshu.com/website-login/error', 'http://www.xiaohongshu.com/website-login/error',
    'https://www.xiaohongshu.com:8443/website-login/error', 'https://www.xiaohongshu.com/website-login/error/more',
    'https://www.xiaohongshu.com/arbitrary', 'https://xhslink.cn/login']) {
    const f = fixture({ snapshots: [page(url, '<title>小红书安全验证</title>')] });
    await rejectsCode(f.start(), 'BROWSER_PAGE_REJECTED');
    assert.equal(f.calls.liveView.length, 0); assert.equal(f.calls.close.length, 1);
  }
  const mismatch = fixture({ snapshots: [page(`https://www.xiaohongshu.com/explore/${otherId}`, '<title>小红书登录</title>')] });
  await rejectsCode(mismatch.start(), 'BROWSER_NOTE_MISMATCH'); assert.equal(mismatch.calls.liveView.length, 0);
});

test('explicit resume from a login or access error retries the saved source once in the same target', async () => {
  for (const path of ['/website-login', '/website-login/error']) {
    const blocked = page(`https://www.xiaohongshu.com${path}`, '<title>小红书</title>');
    const f = fixture({ snapshots: [blocked, blocked, page()] });
    const first = await f.start();
    const next = new BrowserSessionManager(f.state, f.browser, f.options);
    const result = await next.resume({ token });
    assert.equal(result.kind, 'page'); assert.equal(result.noteId, noteId); assert.equal(result.closed, true);
    const navigations = f.calls.commands.filter(value => value.method === 'Page.navigate');
    assert.deepEqual(navigations.map(value => value.params), [{ url: sourceURL }]);
    assert.equal(f.calls.acquire.length, 1); assert.equal(f.calls.newTarget.length, 1);
    assert.ok(f.calls.connect.every(value => value.sessionId === 'session_1' && value.options.targetId === 'target_1'));
    assert.equal(f.puts[0].deadline, first.expiresAt); assert.equal(f.data.size, 0);
  }
});

test('known first-party root error pages hand off and explicitly resume the original note in the same target', async () => {
  for (const hostname of ['www.xiaohongshu.com', 'xiaohongshu.com']) {
    for (const path of ['/error', '/404', '/403', '/500', '/error/', '/404/', '/403/', '/500/']) {
      const blocked = page(`https://${hostname}${path}?private=PRIVATE_QUERY`, '<title>小红书</title>');
      const f = fixture({ snapshots: [blocked, blocked, page()] });
      const first = await f.start();
      assert.equal(first.kind, 'verification'); assert.equal(first.reason, 'access-error');
      assert.equal(f.calls.close.length, 0); assert.equal(f.calls.liveView.length, 1);
      assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 0);
      const next = new BrowserSessionManager(f.state, f.browser, f.options);
      f.advance(1_000);
      const result = await next.resume({ token });
      assert.equal(result.kind, 'page'); assert.equal(result.noteId, noteId); assert.equal(result.closed, true);
      assert.deepEqual(f.calls.commands.filter(value => value.method === 'Page.navigate').map(value => value.params), [{ url: sourceURL }]);
      assert.equal(f.calls.acquire.length, 1); assert.equal(f.calls.newTarget.length, 1);
      assert.ok(f.calls.connect.every(value => value.sessionId === 'session_1' && value.options.targetId === 'target_1'));
      assert.ok(f.puts.slice(0, -1).every(value => value.deadline === first.expiresAt));
      assert.deepEqual(f.calls.close, ['session_1']); assert.equal(f.data.size, 0);
    }
  }
});

test('root error handoff rejects unknown or extended paths and untrusted origins', async () => {
  for (const url of ['https://www.xiaohongshu.com/unknown', 'https://www.xiaohongshu.com/error/more',
    'https://www.xiaohongshu.com/404/more', 'https://www.xiaohongshu.com/403/extra',
    'https://www.xiaohongshu.com/500oops', 'https://www.xiaohongshu.com/errors',
    'https://www.xiaohongshu.com/error%2Fmore', 'https://www.xiaohongshu.com/ERROR',
    'http://www.xiaohongshu.com/error', 'https://foo.xiaohongshu.com/error',
    'https://evil.example/error', 'https://www.xiaohongshu.com.evil.example/404',
    'https://www.xiaohongshu.com:8443/500', 'https://user@www.xiaohongshu.com/403',
    'https://xhslink.cn/error']) {
    const f = fixture({ snapshots: [page(url, '<title>小红书安全验证</title>')] });
    await rejectsCode(f.start(), 'BROWSER_PAGE_REJECTED');
    assert.equal(f.calls.liveView.length, 0); assert.deepEqual(f.calls.close, ['session_1']);
    assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 0);
    assert.equal(f.data.size, 0);
  }
});

test('one manual retry that remains gated returns the same deadline and does not loop navigation', async () => {
  const blocked = page('https://www.xiaohongshu.com/website-login/error', '<title>小红书</title>');
  const f = fixture({ snapshots: [blocked] }); const first = await f.start(); f.advance(1_000);
  const result = await f.manager.resume({ token });
  assert.equal(result.kind, 'verification'); assert.equal(result.reason, 'access-error');
  assert.equal(result.expiresAt, first.expiresAt); assert.equal(f.calls.close.length, 0);
  assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 1);
  assert.equal(f.calls.acquire.length, 1); assert.equal(f.calls.newTarget.length, 1);
});

test('manual CAPTCHA resume only observes the current page and never navigates the challenge', async () => {
  const f = fixture({ snapshots: [gate()] }); await f.start();
  const result = await f.manager.resume({ token });
  assert.equal(result.kind, 'verification'); assert.equal(result.reason, 'captcha');
  assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 0);
});

test('manual retry rejects a changed note and revalidates the stored source before navigation', async () => {
  const blocked = page('https://www.xiaohongshu.com/website-login/error', '<title>小红书</title>');
  const f = fixture({ snapshots: [blocked, blocked, page(`https://www.xiaohongshu.com/explore/${otherId}`)] });
  await f.start(); await rejectsCode(f.manager.resume({ token }), 'BROWSER_NOTE_MISMATCH');
  assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
  const corrupt = fixture({ snapshots: [blocked] }); await corrupt.start();
  corrupt.data.get(BROWSER_SESSION_KEY).sourceURL = 'https://evil.example/';
  await rejectsCode(corrupt.manager.resume({ token }), 'BROWSER_PAGE_REJECTED');
  assert.equal(corrupt.calls.commands.filter(value => value.method === 'Page.navigate').length, 0);
  assert.equal(corrupt.calls.close.length, 1);
  const wrongSource = fixture({ snapshots: [blocked] }); await wrongSource.start();
  wrongSource.data.get(BROWSER_SESSION_KEY).sourceURL = `https://www.xiaohongshu.com/explore/${otherId}`;
  await rejectsCode(wrongSource.manager.resume({ token }), 'BROWSER_NOTE_MISMATCH');
  assert.equal(wrongSource.calls.commands.filter(value => value.method === 'Page.navigate').length, 0);
  assert.equal(wrongSource.calls.close.length, 1);
});

test('manual navigation failures are bounded, close the session and expose no provider text', async () => {
  const blocked = page('https://www.xiaohongshu.com/website-login/error', '<title>小红书</title>');
  for (const stalled of [false, true]) {
    const f = fixture({ callTimeoutMs: 10, socketBehavior: ({ command, emit }) => {
      if (command.method === 'Page.navigate') {
        if (!stalled) queueMicrotask(() => emit({ id: command.id, result: { errorText: privateSentinel } }));
      } else if (command.method === 'Page.enable') {
        queueMicrotask(() => emit({ id: command.id, result: {} }));
      } else if (command.method === 'Page.getFrameTree') {
        queueMicrotask(() => emit({ id: command.id, result: { frameTree: { frame: { id: 'frame_1', loaderId: 'old_loader', url: blocked.finalUrl } } } }));
      } else queueMicrotask(() => emit({ id: command.id, result: { result: { type: 'object', value: blocked } } }));
    } });
    await f.start();
    await rejectsCode(f.manager.resume({ token }), stalled ? 'BROWSER_TIMEOUT' : 'BROWSER_PAGE_UNAVAILABLE');
    assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 1);
    assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
    assert.ok(f.calls.sockets.every(socket => socket.closed));
  }
});

test('manual retry waits for its new main-frame loader before reading the old login page again', async () => {
  const blocked = page('https://www.xiaohongshu.com/website-login/error', '<title>小红书</title>');
  const f = fixture({ snapshots: [blocked, blocked, page()], frameTrees: [
    { id: 'frame_1', loaderId: 'old_loader', url: blocked.finalUrl },
    { id: 'frame_1', loaderId: 'old_loader', url: blocked.finalUrl },
    { id: 'frame_1', loaderId: 'old_loader', url: blocked.finalUrl },
    { id: 'frame_1', loaderId: 'loader_1', url: sourceURL },
  ] });
  await f.start(); const result = await f.manager.resume({ token });
  assert.equal(result.kind, 'page'); assert.equal(result.closed, true);
  assert.equal(f.calls.commands.filter(value => value.method === 'Page.getFrameTree').length, 4);
  assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 1);
  const methods = f.calls.commands.map(value => value.method);
  assert.deepEqual(methods.slice(2), ['Page.enable', 'Page.getFrameTree', 'Page.navigate', 'Page.getFrameTree',
    'Page.getFrameTree', 'Page.getFrameTree', 'Runtime.evaluate']);
  assert.equal(f.time, 1_000_020);
});

test('a safe same-target script redirect can finish after its loader supersedes the navigation loader', async () => {
  const blocked = page('https://www.xiaohongshu.com/website-login/error', '<title>小红书</title>');
  const f = fixture({ snapshots: [blocked, blocked, page()], frameTrees: [
    { id: 'frame_1', loaderId: 'old_loader', url: blocked.finalUrl },
    { id: 'frame_1', loaderId: 'redirect_loader', url: sourceURL },
  ] });
  await f.start(); const result = await f.manager.resume({ token });
  assert.equal(result.kind, 'page'); assert.equal(result.closed, true);
  assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 1);
});

test('a committed first-party CAPTCHA redirect returns manual handoff with the original absolute deadline', async () => {
  const blocked = page('https://www.xiaohongshu.com/website-login/error', '<title>小红书</title>');
  const f = fixture({ snapshots: [blocked, blocked, gate()], frameTrees: [
    { id: 'frame_1', loaderId: 'old_loader', url: blocked.finalUrl },
    { id: 'frame_1', loaderId: 'loader_1', url: gate().finalUrl },
  ] });
  const first = await f.start(); const result = await f.manager.resume({ token });
  assert.equal(result.kind, 'verification'); assert.equal(result.reason, 'captcha');
  assert.equal(result.expiresAt, first.expiresAt); assert.equal(f.calls.close.length, 0);
  assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 1);
});

test('a navigation context destroyed response is retried within the existing wait budget', async () => {
  const blocked = page('https://www.xiaohongshu.com/website-login', '<title>小红书</title>');
  let reads = 0;
  let navigated = false;
  const f = fixture({ socketBehavior: ({ command, emit }) => {
    let result;
    if (command.method === 'Page.enable') result = {};
    else if (command.method === 'Page.navigate') { navigated = true; result = { frameId: 'frame_1', loaderId: 'loader_1' }; }
    else if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'frame_1', loaderId: navigated ? 'loader_1' : 'old_loader', url: sourceURL } } };
    else {
      reads++;
      if (reads === 3) {
        queueMicrotask(() => emit({ id: command.id, error: { code: -32000, message: 'Execution context was destroyed.' } })); return;
      }
      result = { result: { type: 'object', value: reads <= 2 ? blocked : page() } };
    }
    queueMicrotask(() => emit({ id: command.id, result }));
  } });
  await f.start(); const result = await f.manager.resume({ token });
  assert.equal(result.kind, 'page'); assert.equal(result.closed, true);
  assert.equal(reads, 4); assert.equal(f.calls.close.length, 1);
  assert.equal(f.time, 1_000_010);
});

test('only specific Runtime.evaluate context errors are retried and repeated context errors remain bounded', async () => {
  for (const [code, message, expected] of [[-32000, privateSentinel, 'BROWSER_CDP_FAILED'],
    [-1, 'Execution context was destroyed.', 'BROWSER_CDP_FAILED'],
    [-32000, 'Cannot find context with specified id', 'BROWSER_PAGE_UNAVAILABLE']]) {
    const f = fixture({ waitMs: 50, socketBehavior: ({ command, emit }) => {
      queueMicrotask(() => emit({ id: command.id, error: { code, message } }));
    } });
    await rejectsCode(f.start(), expected);
    assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
    assert.ok(f.time <= 1_000_050);
  }
});

test('navigation commitment is bounded and failed or unsafe commits close the session', async () => {
  const blocked = page('https://www.xiaohongshu.com/website-login/error', '<title>小红书</title>');
  for (const [frame, expected] of [
    [{ id: 'frame_1', loaderId: 'old_loader', url: blocked.finalUrl }, 'BROWSER_TIMEOUT'],
    [{ id: 'frame_1', loaderId: 'loader_1', url: 'https://evil.example/' }, 'BROWSER_PAGE_REJECTED'],
    [{ id: 'frame_1', loaderId: 'loader_1', url: `https://www.xiaohongshu.com/explore/${otherId}` }, 'BROWSER_NOTE_MISMATCH'],
  ]) {
    const f = fixture({ snapshots: [blocked], frameTrees: [
      { id: 'frame_1', loaderId: 'old_loader', url: blocked.finalUrl }, frame,
    ], waitMs: 50 });
    await f.start(); await rejectsCode(f.manager.resume({ token }), expected);
    assert.equal(f.calls.close.length, 1); assert.equal(f.data.size, 0);
    assert.equal(f.calls.commands.filter(value => value.method === 'Page.navigate').length, 1);
    assert.ok(f.calls.sockets.every(socket => socket.closed));
    assert.ok(f.time <= 1_000_050);
  }
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
    [page('https://www.xiaohongshu.com/website-login/unknown'), 'BROWSER_PAGE_REJECTED'],
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

test('ordinary hydration without target media is bounded, never claimed as complete, and cleans up', async () => {
  const f = fixture({ snapshots: [page(sourceURL, '<html>loading</html>')], waitMs: 80 });
  await rejectsCode(f.start(), 'BROWSER_PAGE_UNAVAILABLE');
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

test('close failure retains expired metadata with bounded backoff until the provider confirms closure', async () => {
  let canClose = false;
  const f = fixture({ close: () => { if (!canClose) throw new Error(privateSentinel); return { status: 'closed' }; } });
  assert.equal((await f.start()).closed, false);
  f.advance(10_000); await f.manager.alarm(); assert.equal(f.calls.close.length, 2);
  canClose = true; f.advance(10_000); await f.manager.alarm(); assert.equal(f.data.size, 0);
  let trackedClosed = false;
  const tracked = fixture({ close: () => { if (!trackedClosed) throw new Error(privateSentinel); return { status: 'closed' }; } });
  assert.equal((await tracked.start()).closed, false);
  tracked.advance(60_000); await tracked.manager.alarm();
  assert.equal(tracked.calls.close.length, 2); assert.equal(tracked.data.size, 1);
  assert.equal(tracked.data.get(BROWSER_SESSION_KEY).sourceURL, '');
  assert.equal(tracked.data.get(BROWSER_SESSION_KEY).noteId, null);
  assert.equal(Object.keys(tracked.data.get(BROWSER_SESSION_KEY)).length, 6);
  assert.equal(tracked.state.storage.alarm, tracked.time + 60_000);
  tracked.advance(300_000); await tracked.manager.alarm();
  assert.equal(tracked.calls.close.length, 3); assert.equal(tracked.data.size, 1);
  assert.equal(tracked.state.storage.alarm, tracked.time + 300_000);
  await rejectsCode(tracked.manager.resume({ token }), 'BROWSER_EXPIRED');
  assert.equal(tracked.data.size, 1);
  trackedClosed = true; tracked.advance(300_000); await tracked.manager.alarm();
  assert.equal(tracked.data.size, 0); assert.equal(tracked.state.storage.alarm, null);
});

test('failed cleanup storage never reports a confirmed close and retries without retaining a share query', async () => {
  const values = new Map(); let failDelete = true, alarm;
  const storage = { async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { if (failDelete) throw new Error(privateSentinel); return values.delete(key); },
    async setAlarm(value) { alarm = value; }, async deleteAlarm() { alarm = null; } };
  const f = fixture({ storage }); const result = await f.start();
  assert.equal(result.closed, false); assert.equal(values.size, 1);
  assert.equal(values.get(BROWSER_SESSION_KEY).sourceURL, '');
  assert.equal(values.get(BROWSER_SESSION_KEY).noteId, null);
  assert.ok(alarm > f.time);
  await rejectsCode(f.manager.resume({ token }), 'BROWSER_EXPIRED');
  failDelete = false; f.advance(10_000); await f.manager.alarm();
  assert.equal(values.size, 0); assert.equal(alarm, null);
});

test('failed expiration writes block in-memory resume and recover cleanup when storage returns', async () => {
  const values = new Map(); let puts = 0, failWrites = true, confirmed = false;
  const storage = { async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { puts++; if (puts >= 4 && failWrites) throw new Error(privateSentinel); values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); }, async setAlarm() {}, async deleteAlarm() {} };
  const f = fixture({ storage, close: () => ({ status: confirmed ? 'closed' : 'closing' }),
    getSession: () => ({ status: 'running' }) });
  assert.equal((await f.start()).closed, false);
  await rejectsCode(f.manager.resume({ token }), 'BROWSER_EXPIRED');
  failWrites = false; confirmed = true; f.advance(10_000); await f.manager.alarm();
  assert.equal(values.size, 0);
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

test('a late acquired session whose close fails retains sanitized cleanup metadata until confirmation', async () => {
  let deliver, confirmed = false;
  const f = fixture({ callTimeoutMs: 10, acquire: () => new Promise(resolve => { deliver = resolve; }),
    close: () => { if (!confirmed) throw new Error(privateSentinel); return { status: 'closed' }; } });
  await rejectsCode(f.start(), 'BROWSER_ACQUIRE_FAILED');
  deliver({ sessionId: 'late_session' }); await new Promise(resolve => setTimeout(resolve, 5));
  const saved = f.data.get(BROWSER_SESSION_KEY);
  assert.equal(saved.sessionId, 'late_session'); assert.equal(saved.sourceURL, ''); assert.equal(saved.noteId, null);
  assert.equal(Object.keys(saved).length, 6); assert.ok(saved.deadline <= f.time);
  confirmed = true; f.advance(10_000); await f.manager.alarm();
  assert.equal(f.data.size, 0);
});

test('a temporary lifecycle write failure cannot skip closing a known late-acquired session', async () => {
  let deliver;
  const f = fixture({ callTimeoutMs: 10, acquire: () => new Promise(resolve => { deliver = resolve; }) });
  await rejectsCode(f.start(), 'BROWSER_ACQUIRE_FAILED');
  const put = f.state.storage.put;
  f.state.storage.put = async () => { throw new Error(privateSentinel); };
  deliver({ sessionId: 'late_session' }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(f.calls.close, ['late_session']); assert.equal(f.data.size, 0);
  f.state.storage.put = put;
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

test('a matching note ID with empty media waits for that note media instead of closing early', async () => {
  const empty = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {
    [noteId]: { note: { noteId, imageList: [], video: {} } },
  } } })};</script>`;
  const f = fixture({ snapshots: [page(sourceURL, empty), page()] });
  const result = await f.start();
  assert.equal(result.html, noteHTML); assert.equal(result.closed, true);
  assert.equal(f.calls.commands.length, 2); assert.equal(f.time, 1_000_010);
  const unavailable = fixture({ snapshots: [page(sourceURL, empty)], waitMs: 50 });
  await rejectsCode(unavailable.start(), 'BROWSER_PAGE_UNAVAILABLE');
  assert.equal(unavailable.calls.close.length, 1); assert.equal(unavailable.data.size, 0);
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
