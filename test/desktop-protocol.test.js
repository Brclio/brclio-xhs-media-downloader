import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtocolHandler, isAppUrl } from '../desktop/protocol.js';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
const handler = createProtocolHandler({ rootDirectory });

test('desktop protocol serves the real web entry and all first-party JS imports', async () => {
  for (const name of ['index.html', 'app.js', 'account-ui.js', 'commerce-ui.js', 'lib/review-nicknames.js', 'lib/browser-account.js', 'lib/archive.js', 'lib/clipboard.js', 'lib/membership-plans.js', 'style.css', 'site-header.css', 'site-header.js', 'favicon.svg', 'download.html', 'download.css', 'download.js', 'ios-shortcut.js', 'ios-shortcut.css', 'product.html', 'product.css', 'product.js', 'payment-return.html', 'payment-return.js', 'payment-return.css']) {
    const response = await handler(new Request(`xhs-app://local/${name}`));
    assert.equal(response.status, 200, name);
    assert.ok((await response.text()).length > 0, name);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  }
});

test('the served desktop app can load every static relative module including the verification helper', async () => {
  const handle = createProtocolHandler({ rootDirectory, authorize: async () => assert.fail('Static modules must not request account authorization') });
  const appURL = 'xhs-app://local/app.js';
  const app = await handle(new Request(appURL, { referrer: 'xhs-app://local/index.html' }));
  assert.equal(app.status, 200);
  const source = await app.text();
  const imports = [...source.matchAll(/^import\s+[\s\S]*?\bfrom\s+["'](\.[^"']+)["'];/gm)].map(match => match[1]);
  const loaded = new Set();
  assert.ok(imports.length > 0, 'Use the imports of the actual app served by the protocol');
  for (const specifier of imports) {
    const url = new URL(specifier, appURL);
    const response = await handle(new Request(url, { referrer: appURL }));
    assert.equal(response.status, 200, `Desktop module import must load: ${specifier}`);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8', specifier);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(rootDirectory, url.pathname)), specifier);
    loaded.add(url.href);
  }
  assert.ok(loaded.has('xhs-app://local/lib/parse-verification.js'));
});

test('the account UI loads its local QR renderer and transitive encoder with the unchanged sandbox policy', async () => {
  const handle = createProtocolHandler({ rootDirectory, authorize: async () => assert.fail('Local QR modules must not request account authorization') });
  let parent = 'xhs-app://local/account-ui.js';
  const accountResponse = await handle(new Request(parent));
  assert.equal(accountResponse.status, 200);
  let source = await accountResponse.text();
  const csp = accountResponse.headers.get('content-security-policy');
  for (const specifier of ['./lib/payment-qr.js', './vendor/qrcodegen.js']) {
    const imports = [...source.matchAll(/^import\s+[\s\S]*?\bfrom\s+["'](\.[^"']+)["'];/gm)].map(match => match[1]);
    assert.ok(imports.includes(specifier), `Verify the actual module graph imports ${specifier}`);
    const url = new URL(specifier, parent);
    const response = await handle(new Request(url, { referrer: parent }));
    assert.equal(response.status, 200, url.href);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(response.headers.get('content-security-policy'), csp, 'The QR encoder needs no relaxed script/connect/frame policy');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, await readFile(path.join(rootDirectory, url.pathname)));
    source = bytes.toString('utf8'); parent = url.href;
  }
  for (const name of ['lib/vendor/not-allowed.js', 'lib/xhs.js', 'node_modules/jsqr/dist/jsQR.js']) {
    assert.equal((await handle(new Request('xhs-app://local/' + name))).status, 404, 'QR allowlisting cannot expose arbitrary modules: ' + name);
  }
});

test('desktop protocol retains customer support and removes manual membership payment codes', async () => {
  for (const name of ['wechat-contact']) {
    const response = await handler(new Request(`xhs-app://local/assets/membership/${name}.png`));
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  for (const name of ['wechat-pay', 'alipay']) assert.equal((await handler(new Request(`xhs-app://local/assets/membership/${name}.png`))).status, 404);
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

test('direct Node and Python original-video admissions request fresh remote authorization', async t => {
  const original = 'https://sns-video-bd.xhscdn.com/original.mp4';
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Denied originals must not fetch media'));
  t.mock.method(console, 'error', () => {});
  const admissions = [];
  const handle = createProtocolHandler({ rootDirectory,
    authorize: async (feature, options) => {
      if (feature === 'single-download') return { authorized: true, free: true };
      admissions.push({ feature, options });
      throw Object.assign(new Error('Remote authorization denied'), { status: 403 });
    }, pythonBackend: { available: true, request: async () => assert.fail('Denied originals must not enter Python') } });
  for (const route of ['/api/video', '/api/video.js', '/api/python_video', '/api/python_video.py']) {
    assert.equal((await handle(new Request(`xhs-app://local${route}?url=${encodeURIComponent(original)}&action=meta`))).status, 403);
  }
  assert.deepEqual(admissions, Array.from({ length: 4 }, () => ({ feature: 'watermark-free-video', options: { forceRemote: true } })));
});

test('direct original responses recheck local authorization after CDN or Python buffering before releasing media', async t => {
  const original = 'https://sns-video-bd.xhscdn.com/original.mp4';
  for (const engine of ['node', 'python']) for (const action of ['meta', 'chunk']) {
    for (const change of ['expiry', 'logout', 'revocation', 'account-switch']) await t.test(`${engine} ${action} ${change}`, async child => {
      let invalidated = false, localChecks = 0, remoteChecks = 0, mediaRequests = 0;
      const response = () => new Response(Uint8Array.of(7), { status: 206,
        headers: { 'content-type': 'video/mp4', 'content-length': '1', 'content-range': 'bytes 0-0/1' } });
      child.mock.method(console, 'error', () => {});
      child.mock.method(globalThis, 'fetch', async () => { mediaRequests++; invalidated = true; return response(); });
      const handle = createProtocolHandler({ rootDirectory,
        authorize: async (feature, options) => {
          if (feature === 'single-download') return { authorized: true, free: true };
          remoteChecks++; assert.equal(options?.forceRemote, true);
          return { authorized: true, userId: 'member-a' };
        },
        checkAuthorization: feature => {
          assert.equal(feature, 'watermark-free-video'); localChecks++; assert.equal(invalidated, true);
          if (change === 'account-switch') return { authorized: true, userId: 'member-b' };
          throw Object.assign(new Error(change), { status: change === 'logout' ? 401 : 403,
            code: { expiry: 'ENTITLEMENT_EXPIRED', logout: 'ACCOUNT_AUTHORIZATION_REQUIRED', revocation: 'DEVICE_REVOKED' }[change] });
        },
        pythonBackend: { available: true, request: async () => { mediaRequests++; invalidated = true; return response(); } }
      });
      const route = engine === 'node' ? '/api/video' : '/api/python_video';
      const result = await handle(new Request(`xhs-app://local${route}?${new URLSearchParams({ url: original, action, start: '0', end: '0' })}`));
      assert.equal(result.status, ['logout', 'account-switch'].includes(change) ? 401 : 403);
      assert.equal((await result.json()).success, false);
      for (const header of ['content-length', 'content-range', 'x-video-total', 'accept-ranges']) assert.equal(result.headers.get(header), null, header);
      assert.equal(remoteChecks, 1, 'Post-buffer signed validation must not start another remote authorization');
      assert.equal(localChecks, 1); assert.equal(mediaRequests, 1);
    });
  }
});

test('direct original release stays local for signed grants and checks legacy authorization live', async t => {
  const original = 'https://sns-video-bd.xhscdn.com/original.mp4';
  for (const signed of [true, false]) await t.test(signed ? 'signed' : 'legacy', async child => {
    const calls = []; let localChecks = 0;
    child.mock.method(globalThis, 'fetch', async () => new Response(Uint8Array.of(7), { status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/1' } }));
    const handle = createProtocolHandler({ rootDirectory,
      authorize: async (feature, options) => {
        if (feature === 'single-download') return;
        calls.push(options); return { authorized: true, userId: 'member' };
      },
      checkAuthorization: () => { localChecks++; return signed ? { authorized: true, userId: 'member' } : null; }
    });
    const result = await handle(new Request(`xhs-app://local/api/video?${new URLSearchParams({ url: original, action: 'chunk', start: '0', end: '0' })}`));
    assert.equal(result.status, 200); assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [7]);
    assert.deepEqual(calls, signed ? [{ forceRemote: true }] : [{ forceRemote: true }, undefined]);
    assert.equal(localChecks, 1);
  });
});

test('free playback responses never check protected authorization, including prior to release', async t => {
  const playback = 'https://sns-video-bd.xhscdn.com/stream/playback.mp4';
  const response = () => new Response(Uint8Array.of(7), { status: 206, headers: { 'content-range': 'bytes 0-0/1' } });
  t.mock.method(globalThis, 'fetch', async () => response());
  const handle = createProtocolHandler({ rootDirectory,
    authorize: async feature => { assert.equal(feature, 'single-download'); },
    checkAuthorization: () => assert.fail('Free playback must not check membership'),
    pythonBackend: { available: true, request: async () => response() }
  });
  for (const route of ['/api/video', '/api/python_video']) {
    const result = await handle(new Request(`xhs-app://local${route}?${new URLSearchParams({ url: playback, action: 'chunk', start: '0', end: '0' })}`));
    assert.equal(result.status, route === '/api/python_video' ? 206 : 200); assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [7]);
  }
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
