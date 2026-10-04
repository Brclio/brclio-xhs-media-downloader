import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtocolHandler, isAppUrl } from '../desktop/protocol.js';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const handler = createProtocolHandler({ rootDirectory });

test('desktop protocol serves the real web entry and all first-party JS imports', async () => {
  for (const name of ['index.html', 'app.js', 'account-ui.js', 'lib/browser-account.js', 'lib/archive.js', 'lib/clipboard.js', 'lib/membership-plans.js', 'style.css', 'site-header.css', 'favicon.svg', 'download.html', 'download.css', 'download.js', 'ios-shortcut.js', 'ios-shortcut.css', 'product.html', 'product.css', 'product.js']) {
    const response = await handler(new Request(`xhs-app://local/${name}`));
    assert.equal(response.status, 200, name);
    assert.ok((await response.text()).length > 0, name);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  }
});

test('desktop protocol serves the cropped membership QR images locally', async () => {
  for (const name of ['wechat-pay', 'alipay', 'wechat-contact']) {
    const response = await handler(new Request(`xhs-app://local/assets/membership/${name}.png`));
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
});

test('Live Photo maker and its complete local encoding graph are served under the sandbox policy', async () => {
  for (const name of ['live.html', 'live.css', 'live.js', 'lib/live-photo-maker.js', 'lib/live-photo-format.js',
    'lib/live-photo-heic.js', 'lib/live-photo-heic-encoder.js', 'lib/live-photo-heic-worker.js', 'assets/vendor/heic/heic-encoder.js']) {
    const response = await handler(new Request(`xhs-app://local/${name}`));
    assert.equal(response.status, 200, name);
    assert.ok((await response.text()).length > 0, name);
    assert.match(response.headers.get('content-security-policy'), /media-src 'self' blob:/);
    if (['live.html', 'lib/live-photo-heic-worker.js'].includes(name))
      assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval';/);
    else assert.match(response.headers.get('content-security-policy'), /script-src 'self';/);
  }
  const wasm = await handler(new Request('xhs-app://local/assets/vendor/heic/heic-encoder.wasm'));
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()).slice(0, 4), new Uint8Array([0, 97, 115, 109]));
  const home = await handler(new Request('xhs-app://local/index.html'));
  assert.doesNotMatch(home.headers.get('content-security-policy'), /wasm-unsafe-eval|script-src[^;]*'unsafe-eval'/);
});

test('only the workspace can embed its local learning page and all learning assets are packaged', async () => {
  const workspace = await handler(new Request('xhs-app://local/'));
  assert.match(workspace.headers.get('content-security-policy'), /frame-src 'self';/);
  assert.doesNotMatch(workspace.headers.get('content-security-policy'), /frame-src[^;]*https?:/);
  for (const name of ['learn.html', 'learn.css', 'learn.js', 'assets/learning/book-promo.png', 'assets/support/wechat-personal-qr.png']) {
    const response = await handler(new Request(`xhs-app://local/${name}`));
    assert.equal(response.status, 200, name);
    assert.match(response.headers.get('content-security-policy'), /frame-src 'none';/);
    assert.ok((await response.arrayBuffer()).byteLength > 0, name);
  }
});

test('desktop protocol hides source/backend files and rejects foreign origins', async () => {
  for (const name of ['package.json', 'desktop/main.js', 'api/python_parse.py', 'lib/xhs.js', '.git/config', 'assets/%2e%2e/package.json']) {
    assert.notEqual((await handler(new Request(`xhs-app://local/${name}`))).status, 200, name);
  }
  assert.equal((await handler(new Request('xhs-app://evil/index.html'))).status, 403);
  assert.equal((await handler(new Request('xhs-app://local/index.html', { referrer: 'https://evil.test/' }))).status, 403);
  assert.equal(isAppUrl('xhs-app://user@local/'), false);
  assert.equal(isAppUrl('xhs-app://local:8080/'), false);
});

test('desktop protocol cannot read static symlinks outside its root', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'xhs-protocol-'));
  try {
    await mkdir(path.join(temporary, 'web'));
    await writeFile(path.join(temporary, 'private.html'), 'private');
    try { await symlink(path.join(temporary, 'private.html'), path.join(temporary, 'web/index.html')); }
    catch (error) { if (error.code === 'EPERM') return; throw error; }
    const response = await createProtocolHandler({ rootDirectory: path.join(temporary, 'web') })(new Request('xhs-app://local/'));
    assert.equal(response.status, 404);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('desktop API adapter preserves existing node parse behavior and limits request size', async () => {
  const direct = await handler(new Request('xhs-app://local/api/parse', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'https://ci.xiaohongshu.com/abc123?imageView2/format/jpg' }) }));
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).engine, 'node');
  assert.equal((await handler(new Request('xhs-app://local/api/parse'))).status, 405);
  const large = await handler(new Request('xhs-app://local/api/parse', { method: 'POST', body: 'a'.repeat(17000) }));
  assert.equal(large.status, 413);
  assert.equal((await handler(new Request('xhs-app://local/api/python_parse', { method: 'POST', body: '{}' }))).status, 503);
});

test('desktop python routing preserves body, query, bytes, and HTTP status', async () => {
  const handle = createProtocolHandler({ rootDirectory, pythonBackend: { available: true,
    async request(request) {
      assert.equal(request.path, '/api/python_image?token=example');
      assert.equal(request.method, 'GET');
      return new Response(new Uint8Array([0, 255, 127]), { headers: { 'Content-Type': 'image/jpeg' } });
    }
  } });
  const response = await handle(new Request('xhs-app://local/api/python_image?token=example'));
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 127]);
});

test('raw original-video routes and the member gateway cannot use the free single-download authority', async t => {
  const original = 'https://sns-video-bd.xhscdn.com/original.mp4';
  let fetched = 0, pythonRequests = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetched++; throw Error('must not fetch an unauthorized original'); });
  t.mock.method(console, 'error', () => {});
  const features = [];
  const handle = createProtocolHandler({ rootDirectory, authorize: async feature => {
    features.push(feature);
    if (feature === 'watermark-free-video') throw Object.assign(new Error('会员已到期'), { code: 'MEMBERSHIP_EXPIRED', status: 403 });
    return { authorized: true, free: true };
  }, pythonBackend: { available: true, request: async () => { pythonRequests++; return Response.json({ success: true }); } } });
  for (const route of ['/api/video', '/api/video.js', '/api/python_video', '/api/python_video.py']) {
    const response = await handle(new Request(`xhs-app://local${route}?url=${encodeURIComponent(original)}&action=meta`));
    assert.equal(response.status, 403, route);
  }
  for (const route of ['/api/member_video', '/api/member_video.js']) {
    const response = await handle(new Request(`xhs-app://local${route}`, { method: 'POST', body: JSON.stringify({ text: `https://www.xiaohongshu.com/explore/${'1'.repeat(24)}` }) }));
    assert.equal(response.status, 403, route);
  }
  assert.equal(fetched, 0);
  assert.equal(pythonRequests, 0);
  assert.equal(features.filter(feature => feature === 'watermark-free-video').length, 6);
});

test('ordinary desktop stream metadata stays free and a redirect to an original rechecks membership', async t => {
  const stream = 'https://sns-video-bd.xhscdn.com/stream/playback.mp4';
  const original = 'https://sns-video-bd.xhscdn.com/original.mp4';
  let redirect = false;
  const fetched = [], features = [];
  t.mock.method(globalThis, 'fetch', async url => {
    fetched.push(url);
    if (redirect) return new Response(null, { status: 302, headers: { location: original } });
    return new Response(new Uint8Array([0]), { status: 206, headers: { 'content-range': 'bytes 0-0/100', 'content-type': 'video/mp4' } });
  });
  t.mock.method(console, 'error', () => {});
  const handle = createProtocolHandler({ rootDirectory, authorize: async feature => {
    features.push(feature);
    if (feature === 'watermark-free-video') throw Object.assign(new Error('请先开通会员'), { status: 403 });
  } });
  const request = () => new Request(`xhs-app://local/api/video?url=${encodeURIComponent(stream)}&action=meta`);
  const free = await handle(request());
  assert.equal(free.status, 200);
  assert.equal((await free.json()).size, 100);
  assert.deepEqual(features, ['single-download']);
  redirect = true;
  assert.equal((await handle(request())).status, 403);
  assert.deepEqual(features, ['single-download', 'single-download', 'watermark-free-video']);
  assert.deepEqual(fetched, [stream, stream]);
});

test('desktop member gateway resolves original-only pages to account-bound tickets and checks every read', async t => {
  const id = '1234567890abcdef12345678';
  const noteUrl = `https://www.xiaohongshu.com/explore/${id}`;
  const original = 'https://sns-video-bd.xhscdn.com/spectrum/member-original';
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ noteData: { data: {
    noteId: id, title: 'Original-only note', video: { consumer: { originVideoKey: original } }, imageList: []
  } } })}</script>`;
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async url => {
    fetched.push(String(url));
    if (String(url) === noteUrl) return new Response(html, { headers: { 'content-type': 'text/html' } });
    assert.equal(String(url), original);
    return new Response(new Uint8Array([0]), { status: 206, headers: { 'content-range': 'bytes 0-0/100', 'content-type': 'video/mp4' } });
  });
  let userId = 'member-a', allowed = true, checks = 0;
  const handle = createProtocolHandler({ rootDirectory, authorize: async feature => {
    if (feature === 'single-download') return { authorized: true, free: true };
    assert.equal(feature, 'watermark-free-video'); checks++;
    if (!allowed) throw Object.assign(new Error('会员授权已撤销'), { status: 403 });
    return { authorized: true, userId };
  } });
  const post = await handle(new Request('xhs-app://local/api/member_video', { method: 'POST', body: JSON.stringify({ text: noteUrl }) }));
  assert.equal(post.status, 200);
  assert.equal(checks, 2, 'Resolution checks membership before reading the page and before issuing tickets');
  const data = await post.json();
  assert.equal(JSON.stringify(data).includes(original), false);
  const ticket = data.videos[0].url.slice('member-video:'.length);
  const read = () => new Request(`xhs-app://local/api/member_video?ticket=${ticket}&action=meta`);
  assert.equal((await handle(read())).status, 200);
  assert.equal(checks, 4, 'Metadata checks membership before fetching and before responding');
  userId = 'member-b';
  assert.equal((await handle(read())).status, 403);
  userId = 'member-a'; allowed = false;
  assert.equal((await handle(read())).status, 403);
  assert.deepEqual(fetched, [noteUrl, original]);
  assert.equal(checks, 6);
});
