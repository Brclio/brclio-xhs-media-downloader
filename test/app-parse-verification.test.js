import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const verificationSource = await readFile(new URL('../lib/parse-verification.js', import.meta.url), 'utf8');
const now = 1_800_000_000_000;
const token = 'a'.repeat(64);
const noteURL = 'https://www.xiaohongshu.com/explore/abcdef1234567890abcdef12';
const viewURL = new URL('https://live.browser.run/ui/view');
viewURL.searchParams.set('mode', 'tab');
viewURL.searchParams.set('wss', 'live.browser.run/api/devtools/browser/fixture-session/page/fixture-target?jwt=fixture-only');
const verification = engine => ({ code: 'VERIFICATION_REQUIRED', engine, reason: 'captcha',
  verificationToken: token, verificationUrl: viewURL.href, expiresAt: now + 180_000 });
const success = engine => ({ success: true, engine, title: '解析完成', content: '正文', images: [], videos: [] });
const flush = () => new Promise(resolve => setImmediate(resolve));

class Element extends EventTarget {
  constructor(tag) {
    super(); this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {};
    this.listeners = new Map(); this.disabled = false; this.hidden = true; this.textContent = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(type, listener, options) {
    this.listeners.set(type, listener); super.addEventListener(type, listener, options);
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll() { return []; }
  closest() { return this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
  focus() {}
  load() {}
  scrollIntoView() {}
}

function page({ engine = 'node', desktop = false, fetchResult, allowPopup = true } = {}) {
  const nodes = new Map(), created = [], windows = [], calls = [], intervals = new Map();
  let userGesture = false;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(id));
    return nodes.get(id);
  };
  const engineInputs = ['node', 'python'].map(value => Object.assign(new Element('input'), { value, checked: value === engine }));
  const document = {
    activeElement: node('share-text'), body: new Element('body'),
    querySelector: selector => selector.startsWith('#') ? node(selector.slice(1)) : null,
    querySelectorAll: selector => selector === 'input[name="engine"]' ? engineInputs : [],
    createElement(tag) { const element = new Element(tag); created.push(element); return element; },
  };
  const window = new EventTarget();
  if (desktop) window.xhsDesktop = {};
  window.open = (url, ...options) => {
    calls.push({ type: 'open', url, userGesture, options });
    // Model a browser that only permits programmatic opening inside the submit gesture.
    if (!allowPopup || !userGesture) return null;
    const popup = { opener: window, closed: false, document: { title: '', createElement: tag => new Element(tag),
      head: new Element('head'), body: new Element('body') },
      location: { replace(value) { popup.url = value; calls.push({ type: 'navigate', url: value }); } },
      close() { this.closed = true; }, focus() {} };
    windows.push(popup); return popup;
  };
  const context = vm.createContext({
    document, window, navigator: { userAgent: '' }, localStorage: { getItem: () => engine, setItem() {} },
    URL, URLSearchParams, AbortSignal, AbortController, Blob, Uint8Array,
    Date: class extends Date { static now() { return now; } },
    setTimeout: () => Symbol(), clearTimeout() {},
    setInterval(callback) { const id = Symbol(); intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    initializeDesktopUI: async () => {},
    async fetch(url, options) {
      const call = { type: 'fetch', url, body: JSON.parse(options.body), userGesture };
      calls.push(call);
      return fetchResult ? fetchResult(call) : Response.json(success(engine));
    },
  });
  // Execute the real helper, app event registration, submit handler and parse function together.
  vm.runInContext(verificationSource.replace(/^export /gm, '') + '\n'
    + appSource.replace(/^import[\s\S]*?;\n/gm, '')
    + '\nglobalThis.app = { state, parseShareText };', context, { filename: 'app-with-verification.js' });
  return { calls, windows, intervals, node, ...context.app,
    submit(text = noteURL) {
      node('share-text').value = text; userGesture = true;
      try { return node('parse-form').listeners.get('submit')({ preventDefault() {} }); }
      finally { userGesture = false; }
    },
    button: label => created.find(element => element.tagName === 'button' && element.textContent === label),
    dialog: () => created.find(element => element.tagName === 'dialog'),
  };
}

test('web submit preserves the user gesture by opening before either engine request and reuses that window', async t => {
  for (const engine of ['node', 'python']) await t.test(engine, async () => {
    let deliver;
    const env = page({ engine, fetchResult: call => call.url === '/api/parse_verification'
      ? Response.json(success(engine)) : new Promise(resolve => { deliver = resolve; }) });
    const pending = env.submit();
    assert.deepEqual(env.calls.map(call => call.type), ['open', 'fetch']);
    assert.equal(env.calls[0].userGesture, true); assert.equal(env.calls[0].url, 'about:blank');
    assert.equal(env.calls[1].url, engine === 'python' ? '/api/python_parse' : '/api/parse');
    assert.equal(env.windows.length, 1); assert.equal(env.windows[0].opener, null);
    assert.match(env.windows[0].document.body.children[0].textContent, /正在打开/);
    deliver(Response.json(verification(engine), { status: 422 })); await flush();
    assert.equal(env.calls.filter(call => call.type === 'open').length, 1);
    assert.equal(env.windows[0].url, viewURL.href); assert.equal(env.windows[0].closed, false);
    env.button('已完成，继续解析').dispatchEvent(new Event('click')); await pending;
    assert.equal(env.windows[0].closed, true); assert.equal(env.dialog().removed, true);
    assert.equal(env.state.busy, false); assert.equal(env.state.title, '解析完成');
    assert.deepEqual(env.calls.filter(call => call.url === '/api/parse_verification').map(call => call.body), [{ token, action: 'resume' }]);
    assert.equal(env.intervals.size, 0);
  });
});

test('ordinary success closes the preopened window without opening a verification dialog', async () => {
  const env = page(); await env.submit();
  assert.equal(env.windows.length, 1); assert.equal(env.windows[0].closed, true);
  assert.equal(env.windows[0].url, undefined); assert.equal(env.dialog(), undefined);
  assert.equal(env.state.busy, false); assert.equal(env.state.title, '解析完成');
});

test('network, parse and invalid-handoff failures close the submitted operation window', async t => {
  for (const [name, fetchResult, message] of [
    ['network', () => { throw new Error('网络请求失败'); }, /网络请求失败/],
    ['parse', () => Response.json({ success: false, message: '解析未完成' }, { status: 422 }), /解析未完成/],
    ['invalid handoff', () => Response.json({ ...verification('node'), verificationUrl: 'https://evil.example/' }, { status: 422 }), /不可用或已过期/],
    ['malformed response', () => new Response('{invalid', { status: 502 }), /HTTP 502/],
  ]) await t.test(name, async () => {
    const env = page({ fetchResult }); await env.submit();
    assert.equal(env.windows.length, 1); assert.equal(env.windows[0].closed, true);
    assert.equal(env.calls.filter(call => call.type === 'open').length, 1);
    assert.equal(env.state.busy, false); assert.match(env.node('alert-toast').textContent, message);
    assert.equal(env.dialog(), undefined);
  });
});

test('cancelling verification closes the preopened window and lets the form parse again', async () => {
  let attempt = 0;
  const env = page({ fetchResult: call => call.url === '/api/parse_verification'
    ? Response.json({ success: true }) : ++attempt === 1
      ? Response.json(verification('node'), { status: 422 }) : Response.json(success('node')) });
  const pending = env.submit(); await flush();
  env.button('取消').dispatchEvent(new Event('click')); await pending;
  assert.equal(env.windows[0].closed, true); assert.equal(env.state.busy, false);
  assert.match(env.node('alert-toast').textContent, /已取消/);
  assert.deepEqual(env.calls.filter(call => call.url === '/api/parse_verification').map(call => call.body), [{ token, action: 'cancel' }]);
  await env.submit();
  assert.equal(env.windows.length, 2); assert.ok(env.windows.every(popup => popup.closed));
  assert.equal(env.state.title, '解析完成');
});

test('empty input and desktop parses never open a verification window', async t => {
  const empty = page(); await empty.submit('   ');
  assert.equal(empty.calls.length, 0); assert.equal(empty.state.busy, false);
  for (const payload of [success('node'), verification('node')]) await t.test(payload.code || 'success', async () => {
    const env = page({ desktop: true, fetchResult: () => Response.json(payload, { status: payload.success ? 200 : 422 }) });
    await env.submit();
    assert.equal(env.calls.filter(call => call.type === 'open').length, 0);
    assert.equal(env.dialog(), undefined); assert.equal(env.state.busy, false);
  });
});

test('parseShareText callers without a submitted popup retain normal request behavior', async () => {
  const env = page({ engine: 'python' });
  assert.equal((await env.parseShareText(noteURL, 'python')).success, true);
  assert.deepEqual(env.calls.map(call => call.type), ['fetch']);
  assert.equal(env.calls[0].url, '/api/python_parse'); assert.deepEqual(env.calls[0].body, { text: noteURL });
});
