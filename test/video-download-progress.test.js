import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
const playback = 'https://sns-video-bd.xhscdn.com/stream/progress.mp4';

function page(fetch = async () => { throw new Error('Unexpected network request'); }, { bridge, account } = {}) {
  const nodes = new Map(), intervals = new Map();
  let now = 1000;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      attributes: {}, dataset: {}, style: {}, hidden: true, disabled: false, textContent: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, focus() {}, querySelectorAll: () => [],
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      getAttribute(name) { return this.attributes[name] ?? null; },
      getBoundingClientRect: () => ({ top: 20, bottom: 200 }), scrollIntoView() {}
    });
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { querySelector: selector => selector.startsWith('#') ? node(selector.slice(1)) : null,
      querySelectorAll: () => [] },
    window: { innerHeight: 900, xhsDesktop: bridge }, navigator: { userAgent: '' }, localStorage: { getItem: () => null },
    crypto: { randomUUID: () => 'native-request' }, AbortController,
    getAccountBridge: () => account, openAccountUI: async () => {},
    initializeDesktopUI: async () => {}, Blob, URLSearchParams, Uint8Array, fetch,
    Date: class extends Date { static now() { return now; } },
    setTimeout: () => Symbol(), clearTimeout() {},
    setInterval(callback) { const id = Symbol(); intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id)
  });
  // Exercise the real renderer helpers; only the DOM, clock and network are fixtures.
  vm.runInContext(source.replace(/^import[\s\S]*?;\n/gm, '') + `
    globalThis.helpers = { responseBlobWithLimit, downloadVideoByChunks,
      tryDirectVideoDownload, fetchVideoBlobWithFallback, startVideoProgress,
      saveNativeVideo, downloadCurrentVideo, downloadOriginalVideo, downloadLiveVideo, state };
  `, context, { filename: 'app.js' });
  return { ...context.helpers, node, intervals, advance(ms) { now += ms; } };
}

function controlledResponse(headers = {}) {
  let controller, cancelled = 0;
  const response = new Response(new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled++; }
  }), { headers });
  return { response, get cancelled() { return cancelled; },
    push: bytes => controller.enqueue(Uint8Array.from(bytes)),
    close: () => controller.close(), fail: error => controller.error(error) };
}

test('response byte progress advances before EOF and keeps missing or invalid totals unknown', async t => {
  for (const length of ['4', null, 'not-a-size']) await t.test(String(length), async () => {
    const ui = page(), events = [];
    const stream = controlledResponse(length === null ? {} : { 'content-length': length });
    let completed = false;
    const result = ui.responseBlobWithLimit(stream.response, 10, null, value => events.push({ ...value }))
      .then(blob => { completed = true; return blob; });
    stream.push([1, 2]); await setImmediate();
    assert.equal(completed, false, 'Partial progress cannot wait for a complete response');
    assert.deepEqual(events.at(-1), { loadedBytes: 2, totalBytes: length === '4' ? 4 : 0 });
    stream.push([3, 4]); stream.close();
    const blob = await result;
    assert.equal(blob.size, 4);
    assert.deepEqual(events.at(-1), { loadedBytes: 4, totalBytes: length === '4' ? 4 : 0 });
    assert.equal(stream.response.body.locked, false);
  });
});

test('stream limits and callback failures cancel promptly and release the reader', async t => {
  await t.test('declared oversize cancels without consuming bytes', async () => {
    const ui = page(), stream = controlledResponse({ 'content-length': '5' });
    const error = new Error('too large');
    await assert.rejects(ui.responseBlobWithLimit(stream.response, 4, () => error), value => value === error);
    assert.equal(stream.cancelled, 1);
    assert.equal(stream.response.body.locked, false);
  });
  await t.test('undeclared oversize cancels before EOF without advertising excess bytes', async () => {
    const ui = page(), stream = controlledResponse(), events = [];
    const error = new Error('too large');
    const result = ui.responseBlobWithLimit(stream.response, 4, () => error, value => events.push({ ...value }));
    stream.push([1, 2]); await setImmediate();
    const rejection = assert.rejects(result, value => value === error);
    stream.push([3, 4, 5]); await rejection;
    assert.equal(stream.cancelled, 1);
    assert.equal(stream.response.body.locked, false);
    assert.equal(Math.max(...events.map(value => value.loadedBytes)), 2);
  });
  await t.test('progress callback failure stops the network read', async () => {
    const ui = page(), stream = controlledResponse(), error = new Error('observer stopped');
    const result = ui.responseBlobWithLimit(stream.response, 4, null, () => { throw error; });
    const rejection = assert.rejects(result, value => value === error);
    stream.push([1]); await rejection;
    assert.equal(stream.cancelled, 1);
    assert.equal(stream.response.body.locked, false);
  });
  await t.test('network failure preserves the failure and releases the reader', async () => {
    const ui = page(), stream = controlledResponse(), error = new Error('network disconnected');
    const result = ui.responseBlobWithLimit(stream.response, 4, null, () => {});
    const rejection = assert.rejects(result, value => value === error);
    stream.fail(error); await rejection;
    assert.equal(stream.response.body.locked, false);
  });
});

test('chunk progress includes in-flight bytes exactly once across different chunk sizes', async () => {
  const events = [], first = controlledResponse(), ranges = [];
  const ui = page(async value => {
    const url = new URL(value, 'https://fixture.test');
    if (url.searchParams.get('action') === 'meta') return Response.json({ size: 5, chunkSize: 3 });
    ranges.push([url.searchParams.get('start'), url.searchParams.get('end')]);
    return ranges.length === 1 ? first.response : new Response(Uint8Array.from([4, 5]));
  });
  const result = ui.downloadVideoByChunks(playback, {}, { maxBytes: 5, onProgress: value => events.push({ ...value }) });
  await setImmediate(); first.push([1]); await setImmediate();
  assert.equal(events.at(-1).loadedBytes, 1);
  assert.equal(events.at(-1).totalBytes, 5);
  assert.equal(events.at(-1).chunkIndex, 0);
  first.push([2, 3]); first.close();
  const blob = await result;
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4, 5]);
  assert.deepEqual(ranges, [['0', '2'], ['3', '4']]);
  assert.equal(events.at(-1).loadedBytes, 5);
  assert.equal(events.at(-1).chunkIndex, 2);
  assert.ok(events.every((value, index) => value.loadedBytes <= 5 && (!index || value.loadedBytes >= events[index - 1].loadedBytes)));
});

test('short or excessive chunk bodies never become a downloadable merged video', async t => {
  for (const bytes of [[1, 2], [1, 2, 3, 4]]) await t.test(`${bytes.length} of 3 bytes`, async () => {
    const stream = controlledResponse();
    const ui = page(async value => new URL(value, 'https://fixture.test').searchParams.get('action') === 'meta'
      ? Response.json({ size: 3, chunkSize: 3 }) : stream.response);
    const result = ui.downloadVideoByChunks(playback, {}, { maxBytes: 3, onProgress() {} });
    const rejection = assert.rejects(result, /长度异常/);
    await setImmediate(); stream.push(bytes);
    if (bytes.length < 3) stream.close();
    await rejection;
    assert.equal(stream.response.body.locked, false);
    if (bytes.length > 3) assert.equal(stream.cancelled, 1, 'Excess bytes must stop before EOF');
  });
});

test('ordinary direct fallback preserves byte callbacks while protected tickets never fetch directly', async () => {
  const events = [], requests = [];
  const ui = page(async value => {
    requests.push(value);
    if (String(value).startsWith('/api/')) return Response.json({ message: 'range unavailable' }, { status: 409 });
    return new Response(Uint8Array.from([1, 2, 3]));
  });
  const blob = await ui.fetchVideoBlobWithFallback({ url: playback }, {
    maxBytes: 5, onProgress: value => events.push({ ...value })
  });
  assert.equal(blob.size, 3);
  assert.deepEqual(events.at(-1), { loadedBytes: 3, totalBytes: 0 });
  assert.equal(requests.at(-1), playback);
  const count = requests.length;
  await assert.rejects(ui.tryDirectVideoDownload('member-video:opaque', { onProgress() {} }), /授权下载接口/);
  assert.equal(requests.length, count);
});

test('video progress retains terminal status, clears timers, and isolates a new attempt', () => {
  const ui = page(), panel = ui.node('video-download-progress');
  const first = ui.startVideoProgress('preparing', '准备读取视频');
  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.indeterminate, 'true');
  assert.equal(ui.node('video-download-percent').textContent, '—');
  const firstTimer = [...ui.intervals.values()][0];
  ui.advance(2500); firstTimer();
  assert.match(ui.node('video-download-detail').textContent, /已耗时 2 秒/);
  first.report({ loadedBytes: 2, totalBytes: 5 });
  assert.equal(ui.node('video-download-percent').textContent, '40%');
  assert.equal(ui.node('video-download-bar').style.width, '40%');
  first.checking(new Blob([Uint8Array.from([1, 2, 3, 4, 5])]));
  assert.equal(panel.dataset.phase, 'checking');
  assert.equal(panel.getAttribute('aria-busy'), 'true');
  first.finish('failed', '保存已停止', '检查未通过');
  assert.equal(ui.intervals.size, 0);
  assert.equal(panel.getAttribute('aria-busy'), 'false');
  assert.equal(panel.hidden, false);
  const retry = ui.startVideoProgress('preparing', '重新读取视频');
  assert.equal(ui.intervals.size, 1);
  assert.match(ui.node('video-download-detail').textContent, /等待视频信息 · 已耗时 0 秒/);
  first.report({ loadedBytes: 5, totalBytes: 5 }); firstTimer();
  assert.equal(ui.node('video-download-percent').textContent, '—', 'A queued old timer cannot overwrite the retry');
  assert.equal(panel.dataset.phase, 'preparing');
  retry.report({ loadedBytes: 2, totalBytes: 0 });
  assert.equal(ui.node('video-download-percent').textContent, '—');
  assert.equal(ui.node('video-download-track').getAttribute('aria-valuenow'), null);
  assert.match(ui.node('video-download-detail').textContent, /已读取 2 B · 总大小待确认/);
  retry.finish('complete', '已开始保存'); retry.dispose();
  assert.equal(ui.intervals.size, 0);
  assert.equal(panel.dataset.phase, 'complete');
  assert.equal(panel.getAttribute('aria-busy'), 'false');
});

function nativeBridge(save) {
  let listener;
  const calls = [], cancellations = [];
  return { calls, cancellations, get subscribed() { return Boolean(listener); },
    onVideoDownloadProgress(callback) { listener = callback; return () => { listener = null; }; },
    async saveVideo(input) {
      calls.push(input);
      return save(input, event => listener?.({ requestId: input.requestId, ...event }));
    },
    async cancelVideoDownload(requestId) { cancellations.push(requestId); }
  };
}

test('desktop ordinary and live MP4 downloads bypass browser caps and Blob/proxy downloads', async t => {
  for (const live of [false, true]) await t.test(live ? 'live MP4' : 'ordinary video', async () => {
    const bytes = 2 * 1024 ** 3 + 1;
    const bridge = nativeBridge(async (_input, report) => {
      report({ phase: 'downloading', loadedBytes: bytes - 1, totalBytes: bytes });
      report({ phase: 'checking', loadedBytes: bytes, totalBytes: bytes });
      report({ phase: 'saving', loadedBytes: bytes, totalBytes: bytes });
      return { ok: true, bytes, path: '/Downloads/video.mp4' };
    });
    const ui = page(undefined, { bridge });
    const video = { index: 1, url: playback, size: bytes, backupUrls: [playback + '?backup'], hasAudio: true };
    ui.state.videos = [video]; ui.state.title = '大视频';
    if (live) await ui.downloadLiveVideo({ index: 1, liveVideo: video });
    else await ui.downloadCurrentVideo();
    assert.equal(bridge.calls.length, 1);
    assert.equal(bridge.calls[0].video.url, playback);
    assert.equal(bridge.calls[0].requireAudio, !live);
    assert.match(bridge.calls[0].filename, /\.mp4$/);
    assert.equal(ui.node('video-download-progress').dataset.phase, 'complete');
    assert.equal(ui.state.busy, false);
    assert.equal(ui.intervals.size, 0);
    assert.equal(bridge.subscribed, false);
  });
});

test('desktop member originals send encrypted tickets to native saving without chunk requests', async () => {
  const requests = [], bytes = 3 * 1024 ** 3;
  const bridge = nativeBridge(async input => {
    assert.equal(input.video.url, 'member-video:opaque');
    assert.equal(input.requireAudio, true);
    return { ok: true, bytes, path: '/Downloads/original.mp4' };
  });
  const account = { getAccountState: async () => ({ authenticated: true, verified: true,
    account: { user: { id: 'member' }, membership: { active: true } } }) };
  const ui = page(async (url, init) => {
    requests.push(url);
    assert.equal(url, '/api/member_video'); assert.equal(init.method, 'POST');
    return Response.json({ success: true, videos: [{ url: 'member-video:opaque', hasAudio: true, size: bytes }] });
  }, { bridge, account });
  ui.state.shareText = 'https://www.xiaohongshu.com/explore/fixture';
  await ui.downloadOriginalVideo();
  assert.deepEqual(requests, ['/api/member_video']);
  assert.equal(bridge.calls.length, 1);
  assert.equal(ui.node('video-download-progress').dataset.phase, 'complete');
});

test('native cancel and errors preserve status and remove progress listeners', async t => {
  for (const result of [{ ok: true, cancelled: true }, { ok: false, error: { code: 'DISK_FULL', message: '磁盘空间不足。' } }]) {
    await t.test(result.cancelled ? 'cancel' : 'disk failure', async () => {
      const bridge = nativeBridge(async () => result), ui = page(undefined, { bridge });
      ui.state.videos = [{ index: 1, url: playback }];
      await ui.downloadCurrentVideo();
      assert.equal(ui.node('video-download-progress').dataset.phase, result.cancelled ? 'cancelled' : 'error');
      assert.equal(bridge.subscribed, false); assert.equal(ui.state.busy, false); assert.equal(ui.intervals.size, 0);
    });
  }
});

test('account loss cancels a native original download instead of saving through a browser fallback', async () => {
  let observe;
  const account = { getAccountState: async () => ({ authenticated: true, verified: true,
    account: { user: { id: 'member' }, membership: { active: true } } }),
    onAccountUpdate(callback) { observe = callback; return () => { observe = null; }; } };
  const bridge = nativeBridge(async () => {
    observe({ authenticated: false });
    return { ok: true, cancelled: true };
  });
  const ui = page(async () => Response.json({ success: true, videos: [{ url: 'member-video:opaque' }] }), { bridge, account });
  ui.state.shareText = 'https://www.xiaohongshu.com/explore/fixture';
  await ui.downloadOriginalVideo();
  assert.deepEqual(bridge.cancellations, ['native-request']);
  assert.equal(ui.node('video-download-progress').dataset.phase, 'error');
  assert.match(ui.node('video-download-detail').textContent, /退出或切换/);
  assert.equal(bridge.subscribed, false); assert.equal(observe, null);
});
