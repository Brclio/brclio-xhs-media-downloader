import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeBrowserPythonResult, parseWithBrowserPython } from '../lib/browser-python.js';
import { buildWeb, PUBLIC_FILES, PYODIDE_FILES, PYODIDE_VERSION } from '../deploy/build-web.mjs';

const noteId = 'abcdef1234567890abcdef12';
const noteURL = `https://www.xiaohongshu.com/explore/${noteId}`;
const imageURL = 'https://sns-img-hw.xhscdn.com/fixture/original-image';
const playbackURL = 'https://sns-video-bd.xhscdn.com/stream/fixture.mp4';
const originalURL = 'https://sns-video-bd.xhscdn.com/original/fixture.mp4';
const source = (extra = {}) => ({ success: true, source: 'proxy', html: '<script>throw new Error("must never execute")</script>', noteId, finalUrl: noteURL, ...extra });
const parsed = () => ({ title: '独立解析', content: '正文', strategy: 'exact-initial-state',
  images: [{ token: 'fixture/original-image', url: imageURL, livePhoto: true,
    liveVideo: { url: originalURL, backupUrls: [playbackURL], codec: 'h264', duration: 3 } }],
  videos: [{ url: originalURL, backupUrls: [playbackURL, originalURL], width: 1080, height: 1920, hasAudio: true, label: '1080p' },
    { url: originalURL, backupUrls: [] }], originalVideos: [{ url: originalURL }] });

function workerFixture(reply = { success: true, parsed: parsed() }) {
  const workers = [];
  class WorkerFixture {
    constructor(url, options) { this.url = String(url); this.options = options; this.terminated = 0; workers.push(this); }
    postMessage(data) { this.received = data; queueMicrotask(() => this.onmessage?.({ data: reply })); }
    terminate() { this.terminated++; }
  }
  return { WorkerFixture, workers };
}

test('browser Python fetches one source and parses HTML only inside the fixed worker', async () => {
  const { WorkerFixture, workers } = workerFixture();
  const requests = [];
  const result = await parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture, fetchImpl: async (url, options) => {
    requests.push({ url, options }); return Response.json(source());
  } });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/browser_python_source');
  assert.deepEqual(JSON.parse(requests[0].options.body), { text: noteURL });
  assert.equal(requests[0].options.cache, 'no-store');
  assert.match(workers[0].url, /\/lib\/browser-python-worker\.js$/);
  assert.deepEqual(workers[0].options, { type: 'module' });
  assert.deepEqual(workers[0].received, { html: source().html, noteId });
  assert.equal(workers[0].terminated, 1); assert.equal(result.engine, 'python');
  assert.equal(result.strategy, 'exact-initial-state'); assert.equal(result.count, 1);
  assert.equal(result.videos[0].url, playbackURL); assert.equal(result.hasOriginalVideo, true);
  assert.ok(!JSON.stringify(result).includes(originalURL)); assert.ok(!('html' in result));
});

test('normalization applies the existing playback-only policy to video and live-photo backups', () => {
  const result = normalizeBrowserPythonResult(parsed(), noteId);
  assert.equal(result.videos.length, 1); assert.equal(result.videoCount, 1);
  assert.deepEqual(result.videos[0].backupUrls, []); assert.equal(result.videos[0].isDefault, true);
  assert.equal(result.images[0].liveVideo.url, playbackURL); assert.equal(result.livePhotoCount, 1);
  assert.equal(result.originalVideoCount, 1); assert.ok(!('originalVideos' in result));
  assert.throws(() => normalizeBrowserPythonResult({ images: [], videos: [], originalVideos: [] }, noteId), /没有解析到/);
});

test('same-note source count preserves the member-video hint after original addresses are removed', async () => {
  const sanitized = { title: '会员视频', content: '', strategy: 'exact-initial-state', images: [], videos: [], originalVideos: [] };
  const { WorkerFixture, workers } = workerFixture({ success: true, parsed: sanitized });
  const result = await parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture,
    fetchImpl: async () => Response.json(source({ originalVideoCount: 2 })) });
  assert.equal(result.originalVideoCount, 2); assert.equal(result.hasOriginalVideo, true);
  assert.equal(result.type, 'video'); assert.equal(result.videoCount, 0);
  assert.deepEqual(result.images, []); assert.deepEqual(result.videos, []);
  assert.ok(!('originalVideos' in result)); assert.ok(!JSON.stringify(result).includes(originalURL));
  assert.deepEqual(workers[0].received, { html: source().html, noteId });
  assert.equal(normalizeBrowserPythonResult(parsed(), noteId, 3).originalVideoCount, 3);
  assert.equal(normalizeBrowserPythonResult({ ...parsed(), originalVideos: [{}, {}] }, noteId, 1).originalVideoCount, 2);
});

test('source count accepts only finite integers within the bounded member hint contract', async t => {
  for (const value of [-1, 1.5, 21, Infinity, NaN, '2', null, {}, true, []]) await t.test(String(value), async () => {
    const { WorkerFixture } = workerFixture();
    const result = await parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture,
      fetchImpl: async () => Response.json(source({ originalVideoCount: value })) });
    assert.equal(result.originalVideoCount, 1);
    assert.equal(normalizeBrowserPythonResult(parsed(), noteId, value).originalVideoCount, 1);
  });
  for (const value of [0, 20]) {
    assert.equal(normalizeBrowserPythonResult(parsed(), noteId, value).originalVideoCount, Math.max(1, value));
  }
});

test('member hint cannot bypass a mismatched note envelope or promote a direct image', async () => {
  const sanitized = { images: [], videos: [], originalVideos: [] };
  const { WorkerFixture, workers } = workerFixture({ success: true, parsed: sanitized });
  const otherId = '123456789012345678901234';
  await assert.rejects(parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture,
    fetchImpl: async () => Response.json(source({ noteId: otherId, finalUrl: noteURL.replace(noteId, otherId), originalVideoCount: 2 })) }), /笔记页面信息无效/);
  assert.equal(workers.length, 0);
  await assert.rejects(parseWithBrowserPython(imageURL, { WorkerImpl: WorkerFixture,
    fetchImpl: async () => Response.json({ success: true, source: 'direct', kind: 'direct-image', directImageUrl: imageURL, originalVideoCount: 2 }) }), /没有解析到/);
  assert.deepEqual(workers[0].received, { kind: 'direct-image', directImageUrl: imageURL });
  assert.equal(workers[0].terminated, 1);
});

test('source final URL, identity, host, size and source type are checked before a worker starts', async t => {
  for (const invalid of [
    { finalUrl: noteURL.replace('https:', 'http:') }, { finalUrl: noteURL.replace('www.', 'evil.') },
    { finalUrl: noteURL.replace('www.xiaohongshu.com', 'www.xiaohongshu.com.evil.example') },
    { finalUrl: noteURL + '/more' }, { finalUrl: 'https://www.xiaohongshu.com/website-login/error' },
    { finalUrl: noteURL.replace(noteId, '123456789012345678901234'), noteId: '123456789012345678901234' },
    { noteId: '123456789012345678901234' }, { source: 'untrusted' }, { html: '中'.repeat(2 * 1024 * 1024 + 1) },
  ]) await t.test(Object.keys(invalid).join(','), async () => {
    const { WorkerFixture, workers } = workerFixture();
    await assert.rejects(parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture,
      fetchImpl: async () => Response.json(source(invalid)) }), /笔记页面信息无效/);
    assert.equal(workers.length, 0);
  });
});

test('direct and manual browser source both stay in browser Python with no backend parse fallback', async t => {
  for (const transport of ['direct', 'browser']) await t.test(transport, async () => {
    const { WorkerFixture, workers } = workerFixture();
    let fetched = 0, verified = 0;
    const result = await parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture,
      fetchImpl: async () => { fetched++; return transport === 'browser'
        ? Response.json({ code: 'VERIFICATION_REQUIRED', engine: 'browser-python' }, { status: 422 })
        : Response.json(source({ source: 'direct' })); },
      verify: async value => { verified++; assert.equal(value.engine, 'browser-python'); return source({ source: 'browser' }); },
    });
    assert.equal(result.engine, 'python'); assert.equal(fetched, 1); assert.equal(verified, transport === 'browser' ? 1 : 0);
    assert.equal(workers.length, 1); assert.equal(workers[0].terminated, 1);
  });
});

test('direct image is sent to pure Python and cannot substitute an unrelated image address', async () => {
  const { WorkerFixture, workers } = workerFixture();
  const payload = { success: true, source: 'direct', kind: 'direct-image', directImageUrl: imageURL };
  await parseWithBrowserPython(imageURL, { WorkerImpl: WorkerFixture, fetchImpl: async () => Response.json(payload) });
  assert.deepEqual(workers[0].received, { kind: 'direct-image', directImageUrl: imageURL });
  await assert.rejects(parseWithBrowserPython(imageURL, { WorkerImpl: WorkerFixture,
    fetchImpl: async () => Response.json({ ...payload, directImageUrl: imageURL + '-other' }) }), /笔记页面信息无效/);
  assert.equal(workers.length, 1);
});

test('source rejection and verification cancellation never start Python or retry another backend', async () => {
  const { WorkerFixture, workers } = workerFixture(); let requests = 0;
  await assert.rejects(parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture,
    fetchImpl: async () => { requests++; return Response.json({ success: false, message: '受限' }, { status: 422 }); } }), /受限/);
  await assert.rejects(parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture,
    fetchImpl: async () => { requests++; return Response.json({ code: 'VERIFICATION_REQUIRED' }, { status: 422 }); },
    verify: async () => { throw new Error('已取消验证'); } }), /已取消验证/);
  assert.equal(requests, 2); assert.equal(workers.length, 0);
});

test('worker failure terminates its process without exposing HTML or raw traceback', async () => {
  const { WorkerFixture, workers } = workerFixture({ success: false, detail: source().html });
  await assert.rejects(parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture,
    fetchImpl: async () => Response.json(source()) }), /运行环境暂时不可用/);
  assert.equal(workers[0].terminated, 1);
});

test('an unresponsive worker is terminated once when its fixed parsing deadline expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let worker;
  class WorkerFixture {
    constructor() { worker = this; this.terminated = 0; }
    postMessage() {}
    terminate() { this.terminated++; }
  }
  const pending = parseWithBrowserPython(noteURL, { WorkerImpl: WorkerFixture, fetchImpl: async () => Response.json(source()) });
  await new Promise(setImmediate);
  t.mock.timers.tick(60_000);
  await assert.rejects(pending, /超时/);
  worker.onerror(); assert.equal(worker.terminated, 1);
});

test('public build self-hosts the pinned runtime and exact pure parser under every Pages file limit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'brclio-browser-python-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Keep output isolated while serving the real dynamic-import module sources.
  const repository = path.resolve(new URL('../', import.meta.url).pathname);
  for (const name of PUBLIC_FILES) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    if (['assets', 'admin'].includes(name)) {
      await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'public.txt'), 'public');
    } else await cp(path.join(repository, name), path.join(root, name));
  }
  const output = await buildWeb(root);
  for (const name of [...PYODIDE_FILES, 'parser_core.py']) {
    const asset = path.join(output, 'assets/vendor/pyodide', PYODIDE_VERSION, name);
    assert.ok((await stat(asset)).size <= 25 * 1024 * 1024);
    const sourcePath = name === 'parser_core.py' ? path.join(repository, 'cloudflare/python/src/parser_core.py') : path.join(repository, 'node_modules/pyodide', name);
    assert.deepEqual(await readFile(asset), await readFile(sourcePath));
  }
  for (const module of ['browser-python.js', 'browser-python-worker.js', 'video-policy.js', 'xhs.js']) {
    assert.deepEqual(await readFile(path.join(output, 'lib', module)), await readFile(path.join(repository, 'lib', module)));
  }
});
