import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationDetails, waitForNoteVerification } from '../lib/parse-verification.js';

const now = 1_800_000_000_000;
const token = 'a'.repeat(64);
function viewUrl(socket = 'live.browser.run/api/devtools/browser/fixture-session/page/fixture-target?jwt=fixture-only') {
  const url = new URL('https://live.browser.run/ui/view');
  url.searchParams.set('mode', 'tab'); url.searchParams.set('wss', socket);
  return url.href;
}
const payload = overrides => ({ code: 'VERIFICATION_REQUIRED', verificationToken: token,
  verificationUrl: viewUrl(), expiresAt: now + 180_000, ...overrides });

test('verification details accept only a bounded current token and official tab Live View connection', t => {
  t.mock.method(Date, 'now', () => now);
  assert.deepEqual(verificationDetails(payload()), { token, expiresAt: now + 180_000, url: viewUrl() });
  assert.equal(verificationDetails(payload({ expiresAt: new Date(now + 180_000).toISOString() })).expiresAt, now + 180_000);
  for (const overrides of [{ verificationToken: '' }, { verificationToken: token.toUpperCase() },
    { verificationToken: [token] }, { expiresAt: now }, { expiresAt: now - 1 },
    { expiresAt: now + 185_001 }, { expiresAt: Infinity }, { expiresAt: 'not-a-date' }]) {
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
  constructor(tag, elements) { super(); this.tagName = tag; this.children = []; this.attributes = {}; this.disabled = false; elements.push(this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
}
function environment(t, fetchResult) {
  const elements = [], calls = [], window = new EventTarget();
  let currentTime = now, interval, focused = false;
  const document = { activeElement: { focus() { focused = true; } },
    createElement: tag => new Element(tag, elements), body: { append() {} } };
  t.mock.method(Date, 'now', () => currentTime);
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
  return { calls, elements, window, clear, focused: () => focused,
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
    ? Response.json({ success: false, code: 'VERIFICATION_REQUIRED' }, { status: 422 }) : Response.json(result));
  const pending = waitForNoteVerification(payload());
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
  const env = environment(t);
  t.mock.method(Element.prototype, 'showModal', () => { throw new Error('fixture-dialog-disabled'); });
  await assert.rejects(waitForNoteVerification(payload()), /fixture-dialog-disabled/);
  assert.deepEqual(env.calls.map(call => call.body), [{ token, action: 'cancel' }]);
  assert.equal(env.dialog().removed, true);
  assert.equal(env.focused(), true);
  assert.equal(env.clear.mock.callCount(), 1);
});

test('countdown ticks preserve the verification status so users can see why another attempt is needed', async t => {
  const env = environment(t, () => Response.json({ success: false, code: 'VERIFICATION_REQUIRED' }, { status: 422 }));
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
