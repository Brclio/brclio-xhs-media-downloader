import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { XhsBrowser } from '../desktop/profile-browser.js';

const ID = '5e413a430000000001000f4c';
const NOTE = '6a68c6d3000000001303f099';
const PROFILE = `https://www.xiaohongshu.com/user/profile/${ID}`;

function fixture({ snapshots = [], response, status = 200, responseAuthor = ID, preflight = false } = {}) {
  let window;
  let readCount = 0;
  const delays = [];
  class Window extends EventEmitter {
    constructor() {
      super(); window = this; this.shown = false;
      const debug = new EventEmitter();
      debug.isAttached = () => Boolean(debug.attached);
      debug.attach = () => { debug.attached = true; };
      debug.detach = () => { debug.attached = false; };
      debug.sendCommand = async (command, args) => {
        if (args?.requestId === 'preflight') throw new Error('No resource with given identifier found');
        return command === 'Network.getResponseBody' ? { body: JSON.stringify(response) } : {};
      };
      this.webContents = Object.assign(new EventEmitter(), {
        debugger: debug, setWindowOpenHandler() {}, getURL: () => this.url || '', stop() {},
        executeJavaScript: async script => {
          if (script.includes('readProfileSnapshot')) {
            return { list: [], cards: [], done: false, pageText: '', ...snapshots[Math.min(readCount++, snapshots.length - 1)] };
          }
        }
      });
    }
    isDestroyed() { return false; }
    async loadURL(url) {
      this.url = url;
      if (response) {
        if (preflight) {
          this.webContents.debugger.emit('message', {}, 'Network.responseReceived', {
            requestId: 'preflight', type: 'Preflight', response: { url: `https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${responseAuthor}`, status: 200 }
          });
          this.webContents.debugger.emit('message', {}, 'Network.loadingFinished', { requestId: 'preflight', encodedDataLength: 0 });
        }
        this.webContents.debugger.emit('message', {}, 'Network.responseReceived', {
          requestId: '1', response: { url: `https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${responseAuthor}`, status }
        });
        this.webContents.debugger.emit('message', {}, 'Network.loadingFinished', { requestId: '1', encodedDataLength: 200 });
      }
    }
    show() { this.shown = true; }
    hide() {}
    focus() {}
    destroy() {}
  }
  const browser = new XhsBrowser({ BrowserWindow: Window,
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    wait: async (ms, _, { signal }) => { signal?.throwIfAborted(); delays.push(ms); }
  });
  return { browser, getWindow: () => window, delays };
}

test('browser merges observed API and DOM notes, preserves token and waits for definitive end', async () => {
  const { browser, getWindow } = fixture({
    snapshots: [{ cards: [{ id: NOTE, url: `https://www.xiaohongshu.com/explore/${NOTE}` }] }],
    response: { success: true, data: { notes: [{ note_id: NOTE, xsec_token: 'token' }], has_more: false } }
  });
  const pages = [];
  for await (const page of browser.discover(PROFILE)) pages.push(page);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].notes.length, 1);
  assert.match(pages[0].notes[0].url, /xsec_token=token/);
  assert.equal(pages[0].done, true);
  assert.equal(getWindow().webContents.debugger.listenerCount('message'), 0);
});

test('CORS preflight with the same API URL is never read as a note response', async () => {
  const { browser } = fixture({ preflight: true, snapshots: [{}],
    response: { success: true, data: { notes: [{ note_id: NOTE }], has_more: false } } });
  const pages = [];
  for await (const page of browser.discover(PROFILE)) pages.push(page);
  assert.equal(pages[0].done, true);
  assert.equal(pages[0].notes[0].id, NOTE);
});

test('stalled profile is incomplete, never silently successful, and pagination obeys configured delay', async () => {
  const { browser, delays } = fixture({ snapshots: [{}] });
  const pages = [];
  await assert.rejects(async () => {
    for await (const page of browser.discover(PROFILE, { intervalSeconds: 12, jitterSeconds: 0 })) pages.push(page);
  }, { code: 'DISCOVERY_INCOMPLETE' });
  assert.ok(pages.every(page => !page.done));
  assert.equal(delays.filter(ms => ms === 12000).length, 4);
});

test('unrelated author response cannot complete requested profile', async () => {
  const { browser } = fixture({ snapshots: [{}], responseAuthor: NOTE,
    response: { success: true, data: { notes: [], has_more: false } } });
  await assert.rejects(async () => { for await (const _ of browser.discover(PROFILE)) {} }, { code: 'DISCOVERY_INCOMPLETE' });
});

test('a later hydrated token upgrades a previously discovered unsigned note', async () => {
  const { browser } = fixture({ snapshots: [
    { list: [{ id: NOTE }], cards: [{ id: NOTE, url: `https://www.xiaohongshu.com/explore/${NOTE}` }] },
    { list: [{ note_id: NOTE, xsec_token: 'hydrated-token' }], done: true }
  ] });
  const pages = [];
  for await (const page of browser.discover(PROFILE)) pages.push(page);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].notes[0].id, pages[1].notes[0].id);
  assert.match(pages[1].notes[0].url, /xsec_token=hydrated-token/);
  assert.equal(pages[1].done, true);
});

test('unconfirmed DOM recommendations never enter the authored download queue', async () => {
  const { browser } = fixture({ snapshots: [{ done: true,
    cards: [{ id: NOTE, url: `https://www.xiaohongshu.com/explore/${NOTE}?xsec_token=other` }] }] });
  const pages = [];
  for await (const page of browser.discover(PROFILE)) pages.push(page);
  assert.deepEqual(pages[0].notes, []);
});

test('malformed hydrated notes cannot be silently dropped from a completed list', async () => {
  const { browser } = fixture({ snapshots: [{ list: [{ id: 'invalid' }], done: true }] });
  await assert.rejects(async () => { for await (const _ of browser.discover(PROFILE)) {} }, { code: 'DISCOVERY_INCOMPLETE' });
});

test('visible login gate or rate limit pauses and exposes the isolated browser', async () => {
  for (const options of [
    { snapshots: [{ login: true }], code: 'AUTH_REQUIRED' },
    { snapshots: [{}], response: {}, status: 429, code: 'RATE_LIMITED' }
  ]) {
    const { browser, getWindow } = fixture(options);
    await assert.rejects(async () => { for await (const _ of browser.discover(PROFILE)) {} }, { code: options.code });
    assert.equal(getWindow().shown, true);
    assert.equal(getWindow().webContents.debugger.listenerCount('message'), 0);
  }
});

test('a stalled renderer can be aborted without blocking pause forever', async () => {
  const browser = new XhsBrowser();
  const controller = new AbortController();
  let stopped = false;
  const pending = browser.execute({ webContents: {
    executeJavaScript: () => new Promise(() => {}), stop: () => { stopped = true; }
  } }, '1', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stopped, true);
});

function detailFixture({ state, challenge = false, login = false, onWait } = {}) {
  const details = { reads: 0, waits: [], navigations: [] };
  const win = {
    shown: false,
    show() { this.shown = true; },
    webContents: {
      stop() {},
      async executeJavaScript(script) {
        details.reads++;
        return vm.runInNewContext(script, {
          window: { __INITIAL_STATE__: state }, TextEncoder,
          document: { querySelectorAll(selector) {
            const isVisible = selector.includes('captcha') ? challenge : login;
            return isVisible ? [{ getClientRects: () => [1] }] : [];
          } }
        });
      }
    }
  };
  const browser = new XhsBrowser({ wait: async (ms, _value, { signal }) => {
    signal?.throwIfAborted();
    details.waits.push(ms);
    onWait?.(details.waits.length);
  } });
  browser.window = async kind => { assert.equal(kind, 'detail'); return win; };
  browser.navigate = async (_win, url, signal) => {
    assert.equal(_win, win);
    signal?.throwIfAborted();
    details.navigations.push(url);
  };
  return { browser, win, details };
}

const detailNote = overrides => ({
  noteId: NOTE, title: '目标详情', desc: '目标正文 <script>作为文字保留</script>',
  imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/202609200000/fixture/target!nd_dft_wlteh_webp_3' }],
  ...overrides
});
const detailUrl = `https://www.xiaohongshu.com/explore/${NOTE}`;

test('resolveNote executes the targeted helper and parses exact media despite circular store siblings', async () => {
  const state = { note: { noteDetailMap: {
    [NOTE]: { note: detailNote() },
    [ID]: { note: detailNote({ noteId: ID, title: '不能返回的其他作者',
      imageList: [{ urlDefault: 'https://ci.xiaohongshu.com/other-image' }] }) }
  } } };
  state.note.dep = { computed: state.note };
  state.note.noteDetailMap[NOTE].comments = state.note;
  const { browser, details } = detailFixture({ state });
  const result = await browser.resolveNote({ id: NOTE, url: detailUrl });
  assert.equal(result.strategy, 'exact-initial-state');
  assert.equal(result.title, '目标详情');
  assert.equal(result.content, '目标正文 <script>作为文字保留</script>');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].token, 'target');
  assert.deepEqual(details.navigations, [detailUrl]);
  assert.equal(details.reads, 1);
  assert.deepEqual(details.waits, []);
});

test('resolveNote propagates targeted-helper errors explicitly instead of reporting generic unavailable', async () => {
  for (const [data, code] of [
    [detailNote({ noteId: ID }), 'NOTE_ID_MISMATCH'],
    [detailNote({ desc: 'x'.repeat(8 * 1024 * 1024 + 1) }), 'NOTE_STATE_TOO_LARGE']
  ]) {
    const { browser, details, win } = detailFixture({ state: { note: { noteDetailMap: { [NOTE]: { note: data } } } } });
    await assert.rejects(browser.resolveNote({ id: NOTE, url: detailUrl }), { code });
    assert.equal(details.reads, 1);
    assert.deepEqual(details.waits, []);
    assert.equal(win.shown, false);
  }
});

test('resolveNote prioritizes visible auth and challenge gates over helper serialization errors', async () => {
  for (const gate of [{ login: true, code: 'AUTH_REQUIRED' }, { challenge: true, login: true, code: 'RATE_LIMITED' }]) {
    const { browser, details, win } = detailFixture({ ...gate,
      state: { note: { noteDetailMap: { [NOTE]: { note: detailNote({ noteId: ID }) } } } }
    });
    await assert.rejects(browser.resolveNote({ id: NOTE, url: detailUrl }), { code: gate.code });
    assert.equal(win.shown, true);
    assert.equal(browser.blockedWindow, win);
    assert.equal(details.reads, 1);
    assert.deepEqual(details.waits, []);
  }
});

test('resolveNote waits for the requested entry to hydrate without falling back to another note', async () => {
  const state = { note: { noteDetailMap: { [ID]: { note: detailNote({ noteId: ID, title: '其他帖子' }) } } } };
  const { browser, details } = detailFixture({ state, onWait: () => { state.note.noteDetailMap[NOTE] = { note: detailNote() }; } });
  const result = await browser.resolveNote({ id: NOTE, url: detailUrl });
  assert.equal(result.title, '目标详情');
  assert.equal(details.reads, 2);
  assert.deepEqual(details.waits, [500]);
});

test('resolveNote waits until a marked live image has its hydrated paired video stream', async () => {
  const data = detailNote({ imageList: [{
    urlDefault: 'https://ci.xiaohongshu.com/live-still', livePhoto: true
  }] });
  const state = { note: { noteDetailMap: { [NOTE]: { note: data } } } };
  const { browser, details } = detailFixture({ state, onWait: () => {
    data.imageList[0].stream = { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/paired-live.mp4', width: 720, height: 1280 }] };
  } });
  const result = await browser.resolveNote({ id: NOTE, url: detailUrl });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].livePhoto, true);
  assert.equal(result.images[0].liveVideo?.url, 'https://sns-video-bd.xhscdn.com/paired-live.mp4');
  assert.equal(details.reads, 2);
  assert.deepEqual(details.waits, [500]);
});

test('resolveNote waits for the real video stream when a video note initially has only its cover', async () => {
  const data = detailNote({ type: 'video', video: {} });
  const state = { note: { noteDetailMap: { [NOTE]: { note: data } } } };
  const { browser, details } = detailFixture({ state, onWait: () => {
    data.video = { media: { stream: { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/full-video.mp4', width: 1920, height: 1080 }] } } };
  } });
  const result = await browser.resolveNote({ id: NOTE, url: detailUrl });
  assert.equal(result.images.length, 1);
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].url, 'https://sns-video-bd.xhscdn.com/full-video.mp4');
  assert.equal(details.reads, 2);
  assert.deepEqual(details.waits, [500]);
});

test('resolveNote reports an error when paired-live or main-video hydration never completes', async () => {
  for (const data of [
    detailNote({ imageList: [{ urlDefault: 'https://ci.xiaohongshu.com/live-still', livePhoto: true }] }),
    detailNote({ type: 'video', video: {} })
  ]) {
    const { browser, details } = detailFixture({ state: { note: { noteDetailMap: { [NOTE]: { note: data } } } } });
    await assert.rejects(browser.resolveNote({ id: NOTE, url: detailUrl }), { code: 'NOTE_UNAVAILABLE' });
    assert.equal(details.reads, 20);
    assert.equal(details.waits.length, 20);
  }
});
