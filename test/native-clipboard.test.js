import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeImageClipboard, MAX_DESKTOP_CLIPBOARD_IMAGES } from '../desktop/image-clipboard.js';

// A complete 1 × 1 PNG, so these tests exercise the real media download path.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNocFD4DwAEBAHg8uuA+QAAAABJRU5ErkJggg==', 'base64');
const image = (index = 1) => ({ index, url: `https://sns-webpic-qc.xhscdn.com/test-image-${index}` });
const selection = (indices = [1, 2]) => ({ title: '测试笔记', images: indices.map(image) });
const response = (body = PNG, headers = {}) => new Response(body, {
  headers: { 'content-type': 'image/png', 'content-length': String(PNG.length), ...headers }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-native-clipboard-test-')));
  const directory = path.join(base, 'clipboard');
  const requests = [];
  const writes = [];
  const progress = [];
  const authorization = [];
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const service = new NativeImageClipboard({
    directory,
    platform: 'darwin',
    fetchImpl: async (url, init) => { requests.push({ url, init }); return response(); },
    writeFiles: async files => { writes.push({ kind: 'files', files }); },
    writeImage: async file => { writes.push({ kind: 'image', files: [file] }); },
    authorize: async capability => { authorization.push(capability); },
    onProgress: event => { progress.push(event); },
    ...options
  });
  const batches = async () => {
    try { return await fs.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { base, directory, service, requests, writes, progress, authorization, batches };
}

test('native multi-image copy publishes all original files together and preserves source numbering', async t => {
  const f = await fixture(t);
  const stages = [];
  f.service.fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'manual');
    stages.push(`download:${url}`);
    assert.equal(f.writes.length, 0);
    return response();
  };
  f.service.writeFiles = async files => {
    assert.equal(stages.length, 3, 'native clipboard is only touched after all images download');
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), [PNG, PNG, PNG]);
    f.writes.push({ kind: 'files', files });
  };

  const result = await f.service.copy({
    title: '笔记/原图:精选?', images: [image(2), image(7), image(10)]
  });

  assert.deepEqual(result, { ok: true, count: 3, kind: 'files' });
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].files.map(file => path.basename(file)), [
    '002-笔记_原图_精选_.png', '007-笔记_原图_精选_.png', '010-笔记_原图_精选_.png'
  ]);
  assert.equal(new Set(f.writes[0].files.map(file => path.dirname(file))).size, 1);
  assert.deepEqual(f.authorization, ['single-download', 'single-download']);
  assert.deepEqual(f.progress, [
    { completed: 0, total: 3, phase: 'preparing' },
    { completed: 1, total: 3, phase: 'preparing' },
    { completed: 2, total: 3, phase: 'preparing' },
    { completed: 3, total: 3, phase: 'preparing' },
    { completed: 3, total: 3, phase: 'writing' }
  ]);
  // The OS clipboard holds paths; files must remain usable after copy returns.
  for (const file of f.writes[0].files) assert.deepEqual(await fs.readFile(file), PNG);
});

test('single-image copy uses the native image writer and retains the downloaded source', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.copy(selection([5])), { ok: true, count: 1, kind: 'image' });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].kind, 'image');
  assert.equal(path.basename(f.writes[0].files[0]), '005-测试笔记.png');
  assert.deepEqual(await fs.readFile(f.writes[0].files[0]), PNG);
});

test('single-image native fallback returns files and retains the referenced cache', async t => {
  const f = await fixture(t);
  f.service.writeImage = async file => {
    f.writes.push({ kind: 'files', files: [file] });
    return { kind: 'files' };
  };

  assert.deepEqual(await f.service.copy(selection([5])), { ok: true, count: 1, kind: 'files' });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].files.length, 1);
  const [file] = f.writes[0].files;
  assert.equal(path.basename(file), '005-测试笔记.png');
  assert.deepEqual(await fs.readFile(file), PNG);
  assert.deepEqual(await f.batches(), [path.basename(path.dirname(file))]);
});

test('invalid selections are rejected before authorization, downloads or clipboard changes', async t => {
  const f = await fixture(t);
  assert.equal(MAX_DESKTOP_CLIPBOARD_IMAGES, 50);
  const invalid = [
    undefined, {}, { images: [] }, { images: 'invalid' },
    { images: Array.from({ length: 51 }, (_, index) => image(index + 1)) },
    { images: [null] },
    { images: [{ ...image(), index: 0 }] },
    { images: [{ ...image(), index: -1 }] },
    { images: [{ ...image(), index: 1.5 }] },
    { images: [{ ...image(), index: '1' }] },
    { images: [{ ...image(), index: Number.MAX_SAFE_INTEGER + 1 }] },
    { images: [image(1), image(1)] },
    { images: [{ index: 1 }] },
    { images: [{ index: 1, url: 'https://example.com/image.png' }] },
    { images: [{ index: 1, url: 'https://xhscdn.com.evil.example/image.png' }] },
    { images: [{ index: 1, url: 'https://user:password@xhscdn.com/image.png' }] },
    { images: [{ index: 1, url: 'https://xhscdn.com:8443/image.png' }] },
    { images: [{ index: 1, url: 'file:///etc/passwd' }] },
    { images: [image()], title: {} },
    { images: [image()], title: 'a'.repeat(1001) }
  ];
  for (const input of invalid) await assert.rejects(f.service.copy(input));
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.authorization, []);
  assert.deepEqual(await f.batches(), []);
});

test('the full desktop selection limit is supported on Windows', async t => {
  const f = await fixture(t, { platform: 'win32' });
  const images = Array.from({ length: 50 }, (_, index) => image(index + 1));
  assert.deepEqual(await f.service.copy({ images }), { ok: true, count: 50, kind: 'files' });
  assert.equal(f.requests.length, 50);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].files.length, 50);
});

test('unsupported platforms fail before network or clipboard activity', async t => {
  const f = await fixture(t, { platform: 'linux' });
  await assert.rejects(f.service.copy(selection()), /macOS.*Windows/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.writes, []);
});

test('a later failed download never publishes a partial batch and removes incomplete cache', async t => {
  for (const [label, failedResponse] of [
    ['HTTP failure', () => new Response('unavailable', { status: 503 })],
    ['unexpected MIME type', () => response('<html>error</html>', { 'content-type': 'text/html' })],
    ['incomplete download', () => response(PNG.subarray(0, PNG.length - 1))],
    ['invalid image bytes', () => response(Buffer.alloc(PNG.length))]
  ]) {
    await t.test(label, async t => {
      const f = await fixture(t);
      let requests = 0;
      f.service.fetchImpl = async () => ++requests === 1 ? response() : failedResponse();
      await assert.rejects(f.service.copy(selection([1, 2, 3])));
      assert.equal(requests, 2);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(await f.batches(), []);
      assert.equal(f.progress.some(event => event.phase === 'writing'), false);
      // Failure releases the operation lock, so a new attempt can succeed.
      f.service.fetchImpl = async () => response();
      assert.equal((await f.service.copy(selection([3]))).ok, true);
    });
  }
});

test('both declared and streamed image size limits prevent native clipboard writes', async t => {
  for (const mode of ['declared', 'streamed']) {
    await t.test(mode, async t => {
      const maxImageBytes = 1024 ** 2;
      const f = await fixture(t, { maxImageBytes });
      f.service.fetchImpl = async () => mode === 'declared'
        ? response(PNG, { 'content-length': String(maxImageBytes + 1) })
        : new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(PNG);
            controller.enqueue(Buffer.alloc(maxImageBytes - PNG.length + 1));
            controller.close();
          }
        }), { headers: { 'content-type': 'image/png' } });
      await assert.rejects(f.service.copy(selection([1])), /超过 1 MiB 限制/);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(await f.batches(), []);
    });
  }
});

test('the combined byte budget applies across every selected image', async t => {
  const f = await fixture(t, { maxImageBytes: PNG.length + 10, maxTotalBytes: PNG.length * 2 - 1 });
  await assert.rejects(f.service.copy(selection()));
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await f.batches(), []);
});

test('unsafe redirect targets are blocked without requesting their content', async t => {
  for (const target of ['https://127.0.0.1/private', 'https://xhscdn.com.evil.example/image', 'http://xhscdn.com/image']) {
    await t.test(target, async t => {
      const f = await fixture(t);
      const requests = [];
      f.service.fetchImpl = async (url, init) => {
        requests.push(url);
        assert.equal(init.redirect, 'manual');
        return new Response(null, { status: 302, headers: { location: target } });
      };
      await assert.rejects(f.service.copy(selection([1])), /媒体链接或重定向/);
      assert.deepEqual(requests, [image().url]);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(await f.batches(), []);
    });
  }
});

test('an overlapping request cannot replace a batch that is still being prepared', async t => {
  const f = await fixture(t);
  const started = deferred();
  const release = deferred();
  let requests = 0;
  f.service.fetchImpl = async () => {
    requests += 1;
    started.resolve();
    await release.promise;
    return response();
  };
  const first = f.service.copy(selection());
  try {
    await started.promise;
    await assert.rejects(f.service.copy(selection([3])), /上一批|稍候|正在/);
    assert.equal(requests, 1);
    assert.deepEqual(f.writes, []);
  } finally { release.resolve(); }
  assert.equal((await first).count, 2);
  assert.equal(f.writes.length, 1);
});

test('authorization failure prevents downloads and clipboard changes', async t => {
  const f = await fixture(t, { authorize: async () => { throw new Error('membership required'); } });
  await assert.rejects(f.service.copy(selection()), /membership required/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await f.batches(), []);
});

test('authorization expiring during download prevents publishing prepared files', async t => {
  let authorizations = 0;
  const f = await fixture(t, {
    authorize: async () => { if (++authorizations === 2) throw new Error('membership expired'); }
  });
  await assert.rejects(f.service.copy(selection()), /membership expired/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await f.batches(), []);
});

test('native writer failure removes only its new batch and retains earlier clipboard files', async t => {
  const f = await fixture(t);
  await f.service.copy(selection());
  const previousFiles = [...f.writes[0].files];
  const previousBatches = await f.batches();
  f.service.writeFiles = async () => { throw new Error('native clipboard unavailable'); };
  await assert.rejects(f.service.copy(selection([3, 4])), /native clipboard unavailable/);
  assert.deepEqual(await f.batches(), previousBatches);
  for (const file of previousFiles) assert.deepEqual(await fs.readFile(file), PNG);
});

test('stale cache is pruned only after success, keeping recent and unrelated directories', async t => {
  const now = Date.now();
  const f = await fixture(t, { now: () => now });
  await fs.mkdir(f.directory);
  const older = new Date(now - 25 * 60 * 60 * 1000);
  const recent = new Date(now - 23 * 60 * 60 * 1000);
  for (const [name, date] of [['batch-old123', older], ['batch-recent123', recent], ['unrelated', older]]) {
    const directory = path.join(f.directory, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'keep.png'), PNG);
    await fs.utimes(directory, date, date);
  }
  f.service.fetchImpl = async () => new Response(null, { status: 503 });
  await assert.rejects(f.service.copy(selection()));
  assert.deepEqual((await f.batches()).sort(), ['batch-old123', 'batch-recent123', 'unrelated']);

  f.service.fetchImpl = async () => response();
  await f.service.copy(selection());
  const remaining = await f.batches();
  assert.equal(remaining.includes('batch-old123'), false);
  assert.equal(remaining.includes('batch-recent123'), true);
  assert.equal(remaining.includes('unrelated'), true);
  assert.equal(remaining.length, 3);
  for (const file of f.writes[0].files) assert.deepEqual(await fs.readFile(file), PNG);
});

test('progress listener failure cannot interrupt a native clipboard copy', async t => {
  const f = await fixture(t, { onProgress: () => { throw new Error('renderer disconnected'); } });
  assert.equal((await f.service.copy(selection())).ok, true);
  assert.equal(f.writes.length, 1);
});
