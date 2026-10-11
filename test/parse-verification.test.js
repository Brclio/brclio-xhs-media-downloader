import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVerificationPopup, verificationDetails, waitForNoteVerification } from '../lib/parse-verification.js';

const now = 1_800_000_000_000;
const token = 'a'.repeat(64);
function viewUrl(socket = 'live.browser.run/api/devtools/browser/fixture-session/page/fixture-target?jwt=fixture-only') {
  const url = new URL('https://live.browser.run/ui/view');
  url.searchParams.set('mode', 'tab'); url.searchParams.set('wss', socket);
  return url.href;
}
const payload = overrides => ({ code: 'VERIFICATION_REQUIRED', verificationToken: token, engine: 'node', reason: 'captcha',
  verificationUrl: viewUrl(), expiresAt: now + 180_000, ...overrides });
const continuation = overrides => payload({ success: false, verificationToken: undefined, ...overrides });

test('verification details accept only a bounded current token and official tab Live View connection', t => {
  t.mock.method(Date, 'now', () => now);
  assert.deepEqual(verificationDetails(payload()), { token, expiresAt: now + 180_000, url: viewUrl(),
    connectionPath: '/api/devtools/browser/fixture-session/page/fixture-target', engine: 'node', reason: 'captcha' });
  assert.equal(verificationDetails(payload({ expiresAt: new Date(now + 180_000).toISOString() })).expiresAt, now + 180_000);
  for (const overrides of [{ verificationToken: '' }, { verificationToken: token.toUpperCase() },
    { verificationToken: [token] }, { expiresAt: now }, { expiresAt: now - 1 },
    { expiresAt: now + 185_001 }, { expiresAt: Infinity }, { expiresAt: 'not-a-date' },
    { engine: 'unknown' }, { engine: undefined }]) {
    assert.equal(verificationDetails(payload(overrides)), null);
  }
});

test('verification rejects untrusted outer URLs and forged nested websocket credentials', t => {
  t.mock.method(Date, 'now', () => now);
  for (const url of ['javascript:alert(1)', 'http://live.browser.run/ui/view?mode=tab',
    'https://live.browser.run.evil.test/ui/view?mode=tab', 'https://user:secret@live.browser.run/ui/view?mode=tab',
    'https://live.browser.run:8443/ui/view?mode=tab', 'https://live.browser.run/ui/inspector?mode=tab',
    'https://live.browser.run/ui/view?mode=full', 'https://live.browser.run/ui/view?mode=tab',
    viewUrl('evil.test/api/devtools/browser/fixture-session/page/fixture-target?jwt=fixture-only'),
    viewUrl('wss://live.browser.run.evil.test/api/devtools/browser/session/page/target?jwt=fixture-only'),
    viewUrl('wss://user:secret@live.browser.run/api/devtools/browser/session/page/target?jwt=fixture-only'),
    viewUrl('wss://live.browser.run:8443/api/devtools/browser/session/page/target?jwt=fixture-only'),
    viewUrl('live.browser.run/api/devtools/browser/session/page/target'), viewUrl() + '#fragment']) {
    assert.equal(verificationDetails(payload({ verificationUrl: url })), null, url);
  }
});

class Element extends EventTarget {
  constructor(tag, elements) { super(); this.tagName = tag; this.children = []; this.attributes = {}; this.style = {}; this.disabled = false; elements.push(this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
}
function environment(t, fetchResult, { allowPopup = false } = {}) {
  const elements = [], calls = [], window = new EventTarget(), openedWindows = [], openCalls = [], timeouts = [];
  let currentTime = now, interval, focused = false;
  const document = { activeElement: { focus() { focused = true; } },
    createElement: tag => new Element(tag, elements), body: { append() {} } };
  t.mock.method(Date, 'now', () => currentTime);
  t.mock.method(AbortSignal, 'timeout', value => { timeouts.push(value); return new AbortController().signal; });
  t.mock.method(globalThis, 'setInterval', callback => { interval = callback; return 7; });
  const clear = t.mock.method(globalThis, 'clearInterval', () => {});
  for (const [key, value] of Object.entries({ document, window })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return fetchResult ? fetchResult(calls.length) : Response.json({ success: true });
  });
  window.open = (...args) => {
    openCalls.push(args);
    if (!allowPopup) return null;
    const popupElements = [];
    const popup = { opener: window, closed: false, closeCalls: 0, focusCalls: 0,
      document: { createElement: tag => new Element(tag, popupElements),
        head: new Element('head', popupElements), body: new Element('body', popupElements) },
      location: { replace(url) { popup.url = url; } },
      close() { this.closeCalls++; this.closed = true; },
      focus() { this.focusCalls++; }, elements: popupElements };
    openedWindows.push(popup); return popup;
  };
  return { calls, elements, window, clear, openedWindows, openCalls, timeouts, focused: () => focused,
    setTime(value) { currentTime = value; },
    tick(value) { currentTime = value; interval(); },
    button: label => elements.find(element => element.tagName === 'button' && element.textContent === label),
    dialog: () => elements.find(element => element.tagName === 'dialog') };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('cancel closes its remote session once, removes the dialog and restores focus', async t => {
  const env = environment(t);
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /取消/);
  env.button('取消').dispatchEvent(new Event('click'));
  await rejected;
  assert.deepEqual(env.calls.map(call => call.body), [{ token, action: 'cancel' }]);
  assert.equal(env.calls[0].url, '/api/parse_verification');
  assert.equal(env.calls[0].options.keepalive, true);
  assert.equal(env.dialog().removed, true);
  assert.equal(env.focused(), true);
  assert.equal(env.clear.mock.callCount(), 1);
});

test('an unfinished verification keeps the same session and successful continuation returns the parsed result', async t => {
  const result = { success: true, engine: 'python', count: 1, images: [] };
  const env = environment(t, attempt => attempt === 1
    ? Response.json(continuation({ engine: 'python' }), { status: 422 }) : Response.json(result));
  const pending = waitForNoteVerification(payload({ engine: 'python' }));
  const link = env.elements.find(element => element.tagName === 'a');
  assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.referrerPolicy, 'no-referrer');
  const resume = env.button('已完成，继续解析');
  resume.dispatchEvent(new Event('click')); await flush();
  assert.equal(env.dialog().removed, undefined); assert.equal(resume.disabled, false);
  resume.dispatchEvent(new Event('click'));
  assert.deepEqual(await pending, result);
  assert.deepEqual(env.calls.map(call => call.body), [{ token, action: 'resume' }, { token, action: 'resume' }]);
  assert.equal(env.dialog().removed, true);
});

test('expiry cancels remotely and a late successful resume cannot complete a cancelled parse', async t => {
  let resolveResume;
  const env = environment(t, attempt => attempt === 1
    ? new Promise(resolve => { resolveResume = resolve; }) : Response.json({ success: true }));
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /过期/);
  env.button('已完成，继续解析').dispatchEvent(new Event('click'));
  await flush();
  env.tick(now + 180_001);
  await rejected;
  assert.equal(env.calls.at(-1).body.action, 'cancel');
  resolveResume(Response.json({ success: true, count: 100 }));
  await flush();
  assert.equal(env.dialog().removed, true);
  assert.deepEqual(env.calls.map(call => call.body.action), ['resume', 'cancel']);
});

test('a failed modal opening still cancels the remote session and cleans up focus and timers', async t => {
  const env = environment(t, null, { allowPopup: true });
  t.mock.method(Element.prototype, 'showModal', () => { throw new Error('fixture-dialog-disabled'); });
  await assert.rejects(waitForNoteVerification(payload()), /fixture-dialog-disabled/);
  assert.deepEqual(env.calls.map(call => call.body), [{ token, action: 'cancel' }]);
  assert.equal(env.dialog().removed, true);
  assert.equal(env.focused(), true);
  assert.equal(env.clear.mock.callCount(), 1);
  assert.equal(env.openedWindows[0].closed, true);
});

test('countdown ticks preserve the verification status so users can see why another attempt is needed', async t => {
  const env = environment(t, () => Response.json(continuation(), { status: 422 }));
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /取消/);
  env.button('已完成，继续解析').dispatchEvent(new Event('click'));
  await flush();
  const status = env.elements.find(element => element.attributes.role === 'status');
  const message = status.textContent;
  assert.match(message, /尚未完成/);
  env.tick(now + 1000);
  assert.equal(status.textContent, message);
  assert.ok(env.elements.some(element => element.textContent === '验证窗口剩余 179 秒。'));
  env.button('取消').dispatchEvent(new Event('click'));
  await rejected;
});

test('a verification response automatically opens an isolated no-referrer popup and closes it after success', async t => {
  const result = { success: true, engine: 'node', images: [] };
  const env = environment(t, () => Response.json(result), { allowPopup: true });
  const pending = waitForNoteVerification(payload());
  assert.deepEqual(env.openCalls, [['about:blank', '_blank', 'popup,width=1080,height=760']]);
  const popup = env.openedWindows[0];
  assert.equal(popup.opener, null);
  assert.equal(popup.url, viewUrl());
  assert.equal(popup.document.head.children[0].name, 'referrer');
  assert.equal(popup.document.head.children[0].content, 'no-referrer');
  assert.equal(popup.closed, false);
  env.button('已完成，继续解析').dispatchEvent(new Event('click'));
  assert.deepEqual(await pending, result);
  assert.equal(popup.closed, true);
  assert.equal(popup.closeCalls, 1);
});

test('popup blocking preserves a trusted user-click link and the dialog clearly describes the fallback', async t => {
  const env = environment(t);
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /取消/);
  const status = env.elements.find(element => element.attributes.role === 'status');
  assert.match(status.textContent, /浏览器阻止/);
  const link = env.elements.find(element => element.tagName === 'a');
  assert.equal(link.href, viewUrl());
  const click = new Event('click', { cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false);
  assert.equal(env.openCalls.length, 2);
  env.button('取消').dispatchEvent(new Event('click'));
  await rejected;
});

test('opening again navigates and focuses the same popup and expiry closes it and its server session', async t => {
  const env = environment(t, null, { allowPopup: true });
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /过期/);
  const popup = env.openedWindows[0];
  const link = env.elements.find(element => element.tagName === 'a');
  const click = new Event('click', { cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(env.openedWindows.length, 1);
  assert.equal(popup.focusCalls, 2);
  env.tick(now + 180_001);
  await rejected;
  assert.equal(popup.closed, true);
  assert.deepEqual(env.calls.map(call => call.body.action), ['cancel']);
});

test('an optional user-gesture popup can be supplied and unsafe navigation is never allowed', async t => {
  const env = environment(t, null, { allowPopup: true });
  const prepared = prepareVerificationPopup();
  assert.equal(prepared.isOpen(), true);
  assert.equal(prepared.navigate('https://evil.test/'), false);
  assert.equal(prepared.navigate('https://live.browser.run/ui/view?mode=tab'), false);
  assert.equal(env.openedWindows[0].url, undefined);
  const pending = waitForNoteVerification(payload(), { popup: prepared });
  const rejected = assert.rejects(pending, /取消/);
  assert.equal(env.openedWindows.length, 1);
  assert.equal(env.openedWindows[0].url, viewUrl());
  env.button('取消').dispatchEvent(new Event('click'));
  await rejected;
  assert.equal(prepared.isOpen(), false);
});

test('invalid verification payload closes a supplied popup without opening another window or contacting the server', async t => {
  const env = environment(t, null, { allowPopup: true });
  const prepared = prepareVerificationPopup();
  await assert.rejects(waitForNoteVerification(payload({ verificationUrl: 'https://evil.test/' }), { popup: prepared }), /不可用/);
  assert.equal(env.openedWindows[0].closed, true);
  assert.equal(env.openedWindows.length, 1);
  assert.equal(env.calls.length, 0);
});

for (const [reason, title, description] of [
  ['captcha', '完成小红书安全验证', /手动完成验证/],
  ['login', '在小红书窗口完成登录', /按页面提示完成登录/],
  ['access-error', '在窗口打开小红书笔记', /暂未打开.*按页面提示处理.*原网页继续/],
  ['unknown', '在窗口打开小红书笔记', /暂未打开/],
]) {
  test(`the ${reason} handoff describes its actual purpose without calling access errors a captcha`, async t => {
    const env = environment(t);
    const pending = waitForNoteVerification(payload({ reason }));
    const rejected = assert.rejects(pending, /取消/);
    const heading = env.elements.find(element => element.tagName === 'h2');
    assert.equal(heading.textContent, title);
    const paragraph = env.elements.find(element => element.tagName === 'p');
    assert.match(paragraph.textContent, description);
    if (reason === 'access-error' || reason === 'unknown') assert.doesNotMatch(paragraph.textContent, /安全验证|验证码|完成验证/);
    env.button('取消').dispatchEvent(new Event('click'));
    await rejected;
  });
}

test('a fresh same-session Live View URL is saved for one manual reopening without an automatic popup or a longer deadline', async t => {
  const freshUrl = viewUrl('live.browser.run/api/devtools/browser/fixture-session/page/fixture-target?jwt=fresh-fixture');
  const env = environment(t, () => Response.json(continuation({ verificationUrl: freshUrl, reason: 'access-error' }), { status: 422 }), { allowPopup: true });
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /过期/);
  const firstPopup = env.openedWindows[0];
  env.button('已完成，继续解析').dispatchEvent(new Event('click')); await flush();
  const link = env.elements.find(element => element.tagName === 'a');
  assert.equal(link.href, freshUrl);
  assert.equal(link.textContent, '打开小红书窗口');
  assert.equal(firstPopup.url, viewUrl());
  assert.equal(env.openedWindows.length, 1);
  firstPopup.close();
  link.dispatchEvent(new Event('click', { cancelable: true }));
  assert.equal(env.openedWindows.length, 2);
  assert.equal(env.openedWindows[1].url, freshUrl);
  env.tick(now + 180_001);
  await rejected;
  assert.equal(env.openedWindows[1].closed, true);
  assert.deepEqual(env.calls.map(call => call.body.action), ['resume', 'cancel']);
});

test('manual opening navigates an existing window to its refreshed same-session URL without extending its deadline', async t => {
  const freshUrl = viewUrl('live.browser.run/api/devtools/browser/fixture-session/page/fixture-target?jwt=fresh-fixture');
  const env = environment(t, () => Response.json(continuation({ verificationUrl: freshUrl }), { status: 422 }), { allowPopup: true });
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /过期/);
  const popup = env.openedWindows[0];
  env.setTime(now + 60_000);
  env.button('已完成，继续解析').dispatchEvent(new Event('click')); await flush();
  assert.equal(popup.closed, false);
  assert.equal(popup.url, viewUrl());
  const link = env.elements.find(element => element.tagName === 'a');
  assert.equal(link.href, freshUrl);
  const click = new Event('click', { cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(env.openedWindows.length, 1);
  assert.equal(popup.url, freshUrl);
  assert.equal(popup.focusCalls, 2);
  env.tick(now + 180_001);
  await rejected;
  assert.equal(popup.closed, true);
  assert.deepEqual(env.calls.map(call => call.body.action), ['resume', 'cancel']);
});

test('failed navigation closes the old window and synchronously opens a replacement', async t => {
  const env = environment(t, null, { allowPopup: true });
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /取消/);
  const popup = env.openedWindows[0];
  t.mock.method(popup.location, 'replace', () => { throw new Error('fixture-navigation-failed'); });
  const link = env.elements.find(element => element.tagName === 'a');
  const click = new Event('click', { cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(popup.closed, true);
  assert.equal(env.openedWindows.length, 2);
  assert.equal(env.openedWindows[1].url, viewUrl());
  env.button('取消').dispatchEvent(new Event('click'));
  await rejected;
  assert.equal(env.openedWindows[1].closed, true);
  assert.deepEqual(env.calls.map(call => call.body.action), ['cancel']);
});

test('failed navigation followed by a blocked replacement preserves the native trusted link', async t => {
  const env = environment(t, null, { allowPopup: true });
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /取消/);
  const popup = env.openedWindows[0];
  t.mock.method(popup.location, 'replace', () => { throw new Error('fixture-navigation-failed'); });
  const replacement = t.mock.method(env.window, 'open', () => null);
  const link = env.elements.find(element => element.tagName === 'a');
  const click = new Event('click', { cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false);
  assert.equal(popup.closed, true);
  assert.equal(replacement.mock.callCount(), 1);
  assert.equal(env.openedWindows.length, 1);
  assert.equal(link.href, viewUrl());
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  env.button('取消').dispatchEvent(new Event('click'));
  await rejected;
  assert.deepEqual(env.calls.map(call => call.body.action), ['cancel']);
});

for (const [label, overrides] of [
  ['owner token', { verificationToken: 'b'.repeat(64) }],
  ['invalid token', { verificationToken: null }],
  ['engine', { engine: 'python' }],
  ['unsafe URL', { verificationUrl: 'https://evil.test/' }],
  ['browser session', { verificationUrl: viewUrl('live.browser.run/api/devtools/browser/another-session/page/fixture-target?jwt=fixture') }],
  ['browser target', { verificationUrl: viewUrl('live.browser.run/api/devtools/browser/fixture-session/page/another-target?jwt=fixture') }],
  ['extended deadline', { expiresAt: now + 181_000 }],
  ['missing URL', { verificationUrl: undefined }],
]) {
  test(`a continuation cannot replace its ${label} and closes the original session on invalid response`, async t => {
    const env = environment(t, () => Response.json(continuation(overrides), { status: 422 }), { allowPopup: true });
    const pending = waitForNoteVerification(payload());
    const rejected = assert.rejects(pending, /信息已失效/);
    env.button('已完成，继续解析').dispatchEvent(new Event('click'));
    await rejected;
    assert.deepEqual(env.calls.map(call => call.body), [{ token, action: 'resume' }, { token, action: 'cancel' }]);
    assert.equal(env.openedWindows.length, 1);
    assert.equal(env.openedWindows[0].closed, true);
    assert.equal(env.dialog().removed, true);
  });
}

test('leaving the page settles the parse and removes its dialog before a possible BFCache return', async t => {
  const env = environment(t, null, { allowPopup: true });
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /离开页面/);
  env.window.dispatchEvent(new Event('pagehide'));
  await rejected;
  assert.equal(env.dialog().removed, true);
  assert.equal(env.openedWindows[0].closed, true);
  assert.deepEqual(env.calls.map(call => call.body.action), ['cancel']);
  env.window.dispatchEvent(new Event('pagehide'));
  assert.equal(env.calls.length, 1);
});

test('a background-throttled countdown cannot reopen or resume an expired session', async t => {
  const env = environment(t, null, { allowPopup: true });
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /过期/);
  env.openedWindows[0].close();
  env.setTime(now + 180_001);
  const link = env.elements.find(element => element.tagName === 'a');
  const click = new Event('click', { cancelable: true });
  link.dispatchEvent(click);
  await rejected;
  assert.equal(click.defaultPrevented, true);
  assert.equal(env.openedWindows.length, 1);
  assert.deepEqual(env.calls.map(call => call.body.action), ['cancel']);
});

test('a response arriving after the absolute deadline is rejected even when its countdown timer was throttled', async t => {
  let resolveResume;
  const env = environment(t, attempt => attempt === 1
    ? new Promise(resolve => { resolveResume = resolve; }) : Response.json({ success: true }));
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /过期/);
  env.button('已完成，继续解析').dispatchEvent(new Event('click'));
  await flush();
  env.setTime(now + 180_001);
  resolveResume(Response.json({ success: true, engine: 'node', images: [] }));
  await rejected;
  assert.deepEqual(env.calls.map(call => call.body.action), ['resume', 'cancel']);
  assert.equal(env.dialog().removed, true);
});

for (const [label, response] of [
  ['resume throttle', () => Response.json({ success: false, code: 'VERIFICATION_BUSY' }, { status: 429 })],
  ['generic rate limit', () => Response.json({ success: false }, { status: 429 })],
  ['busy code', () => Response.json({ success: false, code: 'VERIFICATION_BUSY' }, { status: 503 })],
]) {
  test(`a fast retry receiving ${label} keeps the same verification session and can continue successfully`, async t => {
    const result = { success: true, engine: 'node', images: [] };
    const env = environment(t, attempt => attempt === 1 ? Response.json(continuation(), { status: 422 })
      : attempt === 2 ? response() : Response.json(result), { allowPopup: true });
    const pending = waitForNoteVerification(payload());
    const resume = env.button('已完成，继续解析');
    resume.dispatchEvent(new Event('click')); await flush();
    resume.dispatchEvent(new Event('click')); await flush();
    assert.equal(env.dialog().removed, undefined);
    assert.equal(env.openedWindows[0].closed, false);
    assert.equal(resume.disabled, false);
    assert.match(env.elements.find(element => element.attributes.role === 'status').textContent, /稍后/);
    assert.deepEqual(env.calls.map(call => call.body.action), ['resume', 'resume']);
    resume.dispatchEvent(new Event('click'));
    assert.deepEqual(await pending, result);
    assert.deepEqual(env.calls.map(call => call.body.action), ['resume', 'resume', 'resume']);
  });
}

test('resume waits up to 30 seconds for the 25-second server dispatch and cancel remains a bounded 5-second request', async t => {
  const env = environment(t, () => Response.json(continuation(), { status: 422 }));
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /取消/);
  env.button('已完成，继续解析').dispatchEvent(new Event('click')); await flush();
  assert.deepEqual(env.timeouts, [30000]);
  env.button('取消').dispatchEvent(new Event('click'));
  await rejected;
  assert.deepEqual(env.timeouts, [30000, 5000]);
});

test('resume timeout never exceeds the remaining absolute session lifetime', async t => {
  const env = environment(t, () => Response.json(continuation(), { status: 422 }));
  const pending = waitForNoteVerification(payload());
  const rejected = assert.rejects(pending, /取消/);
  env.setTime(now + 175_000);
  env.button('已完成，继续解析').dispatchEvent(new Event('click')); await flush();
  assert.deepEqual(env.timeouts, [5000]);
  env.button('取消').dispatchEvent(new Event('click'));
  await rejected;
  assert.deepEqual(env.timeouts, [5000, 5000]);
});
