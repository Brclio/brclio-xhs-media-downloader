import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPythonSource as actualSource, browserPythonMedia as actualMedia, loadProxySettings, publicBrowserPythonPage } from '../cloudflare/browser-python-source.js';
import { createWorker } from '../cloudflare/worker.js';
import { ParseRuntime } from '../cloudflare/parse-runtime.js';
import { parseNoteHtml, XhsError } from '../lib/xhs.js';

// Every test supplies a controlled direct transport, including failure paths.
// An accidental fallback must never contact the real upstream from this suite.
const directUnavailable = async () => { throw new Error('fixture-direct-unavailable'); };
const browserPythonSource = (request, env, options = {}) => actualSource(request, env, { direct: directUnavailable, ...options });
const browserPythonMedia = (request, env, options = {}) => actualMedia(request, env, { direct: directUnavailable, ...options });

const origin = 'https://xhs.example.com';
const noteId = '668d2967000000002500100a';
const noteUrl = `https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=note-share`;
const imageURL = 'https://sns-img-hw.xhscdn.com/safe-image!nd_dft_wlteh_webp_3';
const page = { html: `<html><script>window.__INITIAL_STATE__={"noteId":"${noteId}","imageList":[{"urlDefault":"${imageURL}"}]}</script></html>`, finalUrl: noteUrl };
const subscriptionUrl = 'https://vpn.example.com/sub?token=private-subscription';
const request = (body = { text: noteUrl }, headers = {}) => new Request(`${origin}/api/browser_python_source`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
});
const settings = async () => ({ enabled: true, subscriptionUrl });

test('web Python source only returns bounded inert HTML and never subscription/node credentials', async () => {
  let calls = 0;
  const response = await browserPythonSource(request(), {}, { settings,
    proxy: async (_env, operation, body) => {
      calls++;
      assert.equal(operation, 'fetch-note');
      assert.deepEqual(body, { url: noteUrl, subscriptionUrl });
      return Response.json({ ...page, subscriptionUrl, nodeId: 'private-node' });
    },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true); assert.equal(result.source, 'proxy'); assert.equal(result.noteId, noteId); assert.equal(result.finalUrl, noteUrl);
  assert.equal(result.originalVideoCount, 0); assert.ok(!result.html.includes('<html>')); assert.ok(result.html.includes('browserPublicNotes'));
  assert.equal(JSON.stringify(result).includes('private-subscription'), false);
  assert.equal(JSON.stringify(result).includes('private-node'), false);
  assert.equal(calls, 1);
});

test('a disabled proxy uses direct HTML fetch without executing server Python', async () => {
  let directCalls = 0;
  const response = await browserPythonSource(request(), {}, {
    settings: async () => ({ enabled: false, subscriptionUrl: '' }),
    direct: async url => { directCalls++; assert.equal(url, noteUrl); return page; },
    proxy: () => { throw new Error('must-not-proxy'); },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'direct');
  assert.equal(directCalls, 1);
});

test('browser source excludes native and cross-origin requests before loading credentials', async () => {
  for (const headers of [{ Origin: 'null' }, { Origin: 'https://other.example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await browserPythonSource(request(undefined, headers), {}, { settings: () => { throw new Error('must-not-read'); } });
    assert.equal(response.status, 403);
  }
  const native = request(); native.headers.delete('Origin');
  assert.equal((await browserPythonSource(native, {})).status, 403);
});

test('only actual XHS note links can enter the private subscription fetch service', async () => {
  for (const text of ['https://127.0.0.1/', 'https://www.xiaohongshu.com.evil.example/explore/'+noteId,
    'https://www.xiaohongshu.com/captcha', 'https://www.xiaohongshu.com/explore/'+noteId+'#fragment']) {
    const response = await browserPythonSource(request({ text }), {}, { settings: () => { throw new Error('must-not-read'); } });
    assert.equal(response.status, 400);
  }
});

test('source rejects mismatched note identity and preserves the human verification fallback', async () => {
  for (const finalUrl of ['https://www.xiaohongshu.com/explore/ffffffffffffffffffffffff',
    'https://www.xiaohongshu.com/website-login/error', 'https://evil.example.com/explore/'+noteId]) {
    const response = await browserPythonSource(request(), {}, { settings,
      proxy: async () => Response.json({ ...page, finalUrl }),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'UPSTREAM_VERIFICATION_REQUIRED');
  }
  const response = await browserPythonSource(request(), {}, { settings,
    proxy: async () => Response.json({ code: 'UPSTREAM_VERIFICATION_REQUIRED', message: subscriptionUrl }, { status: 422 }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.text()).includes(subscriptionUrl), false);
});

test('oversized HTML is rejected before browser Python receives it', async () => {
  const response = await browserPythonSource(request(), {}, { settings,
    proxy: async () => Response.json({ ...page, html: 'x'.repeat(6*1024*1024+1) }),
  });
  assert.equal(response.status, 502);
});

test('direct images are validated by browser Python without credentials or server parsing', async () => {
  const url = 'https://sns-img-hw.xhscdn.com/abc123!nd_dft_wlteh_webp_3';
  const response = await browserPythonSource(request({ text: url }), {}, { settings: () => { throw new Error('must-not-read'); } });
  assert.deepEqual(await response.json(), { success: true, kind: 'direct-image', directImageUrl: url, source: 'direct' });
});

test('private config access is through the account binding and public internal route is inaccessible', async () => {
  const env = { ACCOUNT_RUNTIME: { idFromName: name => name, get: id => ({ fetch: async req => {
    assert.equal(id, 'accounts-v1'); assert.equal(new URL(req.url).pathname, '/__internal/web-parse-proxy-settings');
    return Response.json({ ok: true, proxyConfig: { enabled: true, subscriptionUrl } });
  } }) } };
  assert.equal((await loadProxySettings(env)).subscriptionUrl, subscriptionUrl);
  const response = await createWorker().fetch(new Request(origin+'/__internal/web-parse-proxy-settings'), env);
  assert.equal(response.status, 404);
  assert.equal((await response.text()).includes('private-subscription'), false);
});

test('web Python media keeps the member-video guard ahead of any proxy access', async () => {
  const url = 'https://sns-video.xhscdn.com/spectrum/private-original.mp4';
  const response = await browserPythonMedia(new Request(origin+'/api/browser_python_video?url='+encodeURIComponent(url)), {}, {
    settings: () => { throw new Error('must-not-load'); }, proxy: () => { throw new Error('must-not-proxy'); },
  });
  assert.equal(response.status, 403);
});

test('web Python video validates returned byte ranges and proxies only public playback', async () => {
  const url = 'https://sns-video.xhscdn.com/stream/public.mp4';
  const response = await browserPythonMedia(new Request(origin+'/api/browser_python_video?'+new URLSearchParams({ url, action:'chunk', start:'0', end:'3' })), {}, {
    settings, proxy: async (_env, operation, body) => {
      assert.equal(operation, 'fetch-media'); assert.equal(body.range, 'bytes=0-3');
      return new Response(new Uint8Array([0,0,0,4]), { status:206, headers:{ 'Content-Type':'video/mp4', 'Content-Range':'bytes 0-3/100', 'Content-Length':'4' } });
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test('private media service URL is not mistaken for a CDN redirect by the existing video guard', async () => {
  const upstream = new Response(new Uint8Array([0, 0, 0, 4]), { status: 206, statusText: 'Partial Content',
    headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/100', 'Content-Length': '4' } });
  Object.defineProperty(upstream, 'url', { value: 'https://proxy.internal/fetch-media' });
  const response = await browserPythonMedia(new Request(origin+'/api/browser_python_video?'+new URLSearchParams({
    url: 'https://sns-video.xhscdn.com/stream/public.mp4', action: 'chunk', start: '0', end: '3',
  })), {}, { settings, proxy: async () => upstream, direct: async () => assert.fail('valid private range must not use direct') });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Range'), 'bytes 0-3/100');
  assert.equal(response.headers.get('Content-Length'), '4'); assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 0, 0, 4]);
});

test('a browser Python verification page returns HTML without calling server Python', async () => {
  const state={ id:{ equals:()=>true }, storage:{} };
  const env={ PARSE_RUNTIME:{idFromName:()=>({})}, PYTHON_API:{fetch:()=>{throw new Error('must-not-run-server-python')}}, BROWSER:{} };
  const runtime=new ParseRuntime(state,env);
  runtime.browser.resume=async()=>({kind:'page',engine:'browser-python',noteId,...page,closed:true});
  const response=await runtime.fetch(new Request('https://browser.internal/__internal/browser/resume', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'a'.repeat(64)})}));
  assert.equal(response.status,200);
  const result=await response.json(); assert.equal(result.success,true); assert.equal(result.source,'browser'); assert.equal(result.noteId,noteId); assert.ok(result.html.includes('browserPublicNotes')); assert.ok(!result.html.includes('<html>')); assert.equal(result.originalVideoCount,0);
});

const playbackURL = 'https://sns-video-bd.xhscdn.com/stream/safe-playback.mp4';
function notePage(note, extra = '') {
  return { noteId, finalUrl: noteUrl, html: `${extra}<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: { note } } } })}</script>` };
}

test('public source projection preserves Python image, video and paired-live inputs but strips protected sources', () => {
  const original = 'https://sns-video-bd.xhscdn.com/spectrum/protected-original';
  const undeclared = 'https://sns-video-bd.xhscdn.com/root-protected-upload';
  const originalKey = 'legacy/protected-key';
  const note = { noteId, title: '有效标题', desc: '有效正文', imageList: [
    { urlDefault: imageURL, livePhoto: true, stream: { h264: [{ masterUrl: original, backupUrls: [playbackURL, undeclared], width: 1080, height: 1920, audioCodec: 'aac' }] } },
    { urlDefault: imageURL, livePhoto: true, stream: { h264: [{ masterUrl: original }] } },
  ], video: { consumer: { originVideoKey: originalKey }, origin_video_key: original,
    mediaV2: JSON.stringify({ video: { secret: original, originVideoKey: originalKey } }),
    media: { stream: { h264: [{ masterUrl: original, backupUrls: [playbackURL, undeclared], width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, videoBitrate: 1000 }] } } } };
  const result = publicBrowserPythonPage(notePage(note, `<meta property="og:video" content="${original}"><script>globalThis.privateSourceSentinel='private-script';</script>`), { source: 'proxy' });
  assert.equal(result.originalVideoCount, 2);
  for (const secret of [original, undeclared, originalKey, 'originVideoKey', 'origin_video_key', 'mediaV2', 'privateSourceSentinel', 'private-script']) assert.ok(!result.html.includes(secret), `withhold ${secret}`);
  const parsed = parseNoteHtml(result.html, { noteId });
  assert.equal(parsed.title, '有效标题'); assert.equal(parsed.content, '有效正文'); assert.equal(parsed.images.length, 2);
  assert.equal(parsed.images[0].liveVideo.url, playbackURL); assert.equal(parsed.images[1].liveVideo, null);
  assert.equal(parsed.videos[0].url, playbackURL); assert.equal(parsed.videos[0].width, 1080); assert.equal(parsed.videos[0].hasAudio, true);
  assert.deepEqual(parsed.originalVideos, []);
});

test('projection drops unknown and encoded JSON fields and removes original URLs from preserved text/meta', () => {
  const original = 'https://sns-video-bd.xhscdn.com/s%70ectrum/encoded-private-key';
  const note = { noteId, title: '标题 '+encodeURIComponent(original), desc: 'JSON '+JSON.stringify({ url: original.replaceAll('/', '\\u002f') }),
    imageList: [{ infoList: [{ imageScene: 'WB_DFT', url: imageURL }], customSecrets: JSON.stringify({ url: original }), encoded: Buffer.from(original).toString('base64') }],
    encodedJSON: JSON.stringify({ originVideoKey: original, url: original }),
    video: { originVideoKey: original, media: { stream: { h264: [{ masterUrl: playbackURL, backup_urls: [original], customSecrets: JSON.stringify({ url: original }) }] } } } };
  const input = notePage(note, `<title>https:&#47;&#47;sns-video-bd.xhscdn.com/spectrum/encoded-private-key</title><meta property="og:video" content="${original}">`);
  input.html = input.html.replace('"originVideoKey"', '"origin\\u0056ideoKey"');
  const result = publicBrowserPythonPage(input, { source: 'browser' });
  assert.equal(result.originalVideoCount, 1);
  for (const secret of ['encoded-private-key', 'originVideoKey', 'encodedJSON', 'customSecrets', Buffer.from(original).toString('base64')]) assert.ok(!result.html.includes(secret));
  const parsed = parseNoteHtml(result.html, { noteId }); assert.equal(parsed.images.length, 1); assert.equal(parsed.videos[0].url, playbackURL);
});

test('raw HTML and unrelated note states never pass through the public source projection', () => {
  const foreignId = 'ffffffffffffffffffffffff';
  const result = publicBrowserPythonPage({ ...page, html: `<script>throw Error('upstream-executable')</script><script>window.__INITIAL_STATE__=${JSON.stringify({ notes: [{ noteId: foreignId, imageList: [{ urlDefault: imageURL }], video: { originVideoKey: 'spectrum/unrelated-private-key' } }, { noteId, imageList: [{ urlDefault: imageURL }], title: '</script><img src=x onerror=alert(1)>' }] })}</script>` }, { source: 'direct' });
  assert.ok(!result.html.includes('upstream-executable')); assert.ok(!result.html.includes('unrelated-private-key')); assert.ok(!result.html.includes(foreignId));
  assert.ok(!result.html.includes('<img')); assert.ok(!result.html.includes('</script><img'));
  const parsed = parseNoteHtml(result.html, { noteId }); assert.equal(parsed.images.length, 1); assert.equal(parsed.title, '</script><img src=x onerror=alert(1)>');
  assert.throws(() => publicBrowserPythonPage({ ...page, html: `<script>throw Error('no-json')</script>` }), /没有可公开解析/);
});

test('safe primary metadata is retained only for actual image and public playback addresses', () => {
  const result = publicBrowserPythonPage({ ...page, html: `<title>测试笔记</title><meta property="og:image" content="${imageURL}"><meta property="og:video" content="${playbackURL}"><meta property="og:video" content="https://sns-video-bd.xhscdn.com/spectrum/private-meta">` }, { source: 'direct' });
  assert.ok(!result.html.includes('private-meta'));
  const parsed = parseNoteHtml(result.html, { noteId }); assert.equal(parsed.images.length, 1); assert.equal(parsed.videos.length, 1);
});

test('declared origins resembling public streams never become public via live streams, metadata or CDN aliases', () => {
  for (const key of ['stream/ambiguous-original.mp4', '/stream/ambiguous-original.mp4',
    'https://sns-video-bd.xhscdn.com/stream/ambiguous-original.mp4',
    'https://sns-video-bd.xhscdn.com/%73tream/ambiguous-original.mp4']) {
    const ambiguous = 'https://sns-video-bd.xhscdn.com/stream/ambiguous-original.mp4';
    const alias = 'https://sns-video-hw.xhscdn.com/stream/ambiguous-original.mp4?signature=alias';
    const note = { noteId, title: key, imageList: [{ urlDefault: imageURL, livePhoto: true,
      stream: { h264: [{ masterUrl: ambiguous, backupUrls: [alias, playbackURL] }] } }],
      video: { consumer: { originVideoKey: key }, media: { stream: { h264: [{ masterUrl: alias, backupUrls: [ambiguous, playbackURL] }] } } } };
    const result = publicBrowserPythonPage(notePage(note, `<meta property="og:video" content="${alias}">`), { source: 'proxy' });
    assert.equal(result.originalVideoCount, 0); assert.ok(!result.html.includes('ambiguous-original'));
    const parsed = parseNoteHtml(result.html, { noteId });
    assert.equal(parsed.images[0].liveVideo.url, playbackURL); assert.equal(parsed.videos.length, 1); assert.equal(parsed.videos[0].url, playbackURL);
    assert.deepEqual(parsed.originalVideos, []);
  }
});

test('origin declarations in another exact-note state also constrain public output and excessive candidates fail closed', () => {
  const ambiguous = 'https://sns-video-bd.xhscdn.com/stream/cross-state-original.mp4';
  const states = [{ noteId, imageList: [{ urlDefault: imageURL }], title: ambiguous,
    video: { media: { stream: { h264: [{ masterUrl: ambiguous, backupUrls: [playbackURL] }] } } } },
  { noteId, video: { originVideoKey: ambiguous } }];
  const result = publicBrowserPythonPage({ ...page, html: states.map(note => `<script>window.__INITIAL_STATE__=${JSON.stringify({ note })}</script>`).join('') });
  assert.ok(!result.html.includes('cross-state-original'));
  assert.equal(parseNoteHtml(result.html, { noteId }).videos[0].url, playbackURL);
  assert.throws(() => publicBrowserPythonPage({ ...page, html: `<script>window.__INITIAL_STATE__=${JSON.stringify({ notes: Array.from({ length: 25 }, () => ({ noteId, imageList: [{ urlDefault: imageURL }] })) })}</script>` }), /信息过大/);
});

test('new web media responses discard all raw settings, transport and upstream exception text', async () => {
  for (const type of ['image', 'video']) for (const operation of ['settings', 'proxy']) {
    const query = type === 'image' ? 'token=fixture_image' : 'url='+encodeURIComponent(playbackURL)+'&action=meta';
    const response = await browserPythonMedia(new Request(origin+'/api/browser_python_'+type+'?'+query), {}, {
      settings: async () => { if (operation === 'settings') throw new Error(subscriptionUrl); return { enabled: true, subscriptionUrl }; },
      proxy: async () => { throw new Error(subscriptionUrl); },
    });
    assert.ok(response.status >= 500); const body = await response.text(); assert.ok(!body.includes('private-subscription')); assert.ok(!body.includes(subscriptionUrl));
  }
});

test('source configuration outages return 503 and cannot trigger the billable verification fallback', async () => {
  const response = await browserPythonSource(request(), {}, { settings: async () => { throw new Error(subscriptionUrl); }, proxy: () => assert.fail('configuration outage must stop before proxy access') });
  assert.equal(response.status, 503); const body = await response.json(); assert.equal(body.code, 'WEB_PROXY_SETTINGS_UNAVAILABLE'); assert.ok(!JSON.stringify(body).includes('private-subscription'));
  const noBinding = await browserPythonSource(request(), {}, { settings }); assert.equal(noBinding.status, 503);
});

test('manual browser Python also withholds origin keys and leaves server Python unused', async () => {
  const original = 'spectrum/manual-private-key';
  const protectedPage = notePage({ noteId, imageList: [{ urlDefault: imageURL }], video: { consumer: { originVideoKey: original } } });
  const state = { id: { equals: () => true }, storage: {} }, env = { PARSE_RUNTIME: { idFromName: () => ({}) }, PYTHON_API: { fetch: () => assert.fail('server Python was invoked') }, BROWSER: {} };
  const runtime = new ParseRuntime(state, env); runtime.browser.resume = async () => ({ kind: 'page', engine: 'browser-python', ...protectedPage, closed: true });
  const response = await runtime.fetch(new Request('https://browser.internal/__internal/browser/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(64) }) }));
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.originalVideoCount, 1); assert.ok(!result.html.includes(original)); assert.ok(!result.html.includes('originVideoKey'));
});

test('proxy failures, challenges and unusable pages get exactly one safe direct source attempt', async t => {
  const safePage = notePage({ noteId, imageList: [{ urlDefault: imageURL }], video: { originVideoKey: 'spectrum/direct-private-original',
    media: { stream: { h264: [{ masterUrl: playbackURL }] } } } }, '<script>throw Error("raw-direct-script")</script>');
  for (const [name, attempt] of [
    ['challenge', async () => Response.json({ code: 'UPSTREAM_VERIFICATION_REQUIRED', message: subscriptionUrl }, { status: 422 })],
    ['proxy offline', async () => Response.json({ code: subscriptionUrl }, { status: 502 })],
    ['proxy exception', async () => { throw new Error(subscriptionUrl); }],
    ['invalid JSON', async () => new Response('not-json')],
    ['empty HTML', async () => Response.json({ ...page, html: '' })],
    ['oversized HTML', async () => Response.json({ ...page, html: 'x'.repeat(6*1024*1024+1) })],
    ['wrong note identity', async () => Response.json({ ...page, finalUrl: noteUrl.replace(noteId, 'ffffffffffffffffffffffff') })],
    ['same note without media', async () => Response.json(notePage({ noteId, title: 'title only', imageList: [{}] }))],
    ['ambiguous declared origin without public media', async () => Response.json(notePage({ noteId, video: { originVideoKey: 'stream/ambiguous', media: { stream: { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/stream/ambiguous' }] } } } }))],
  ]) await t.test(name, async () => {
    const order = [];
    const response = await browserPythonSource(request(), {}, { settings,
      proxy: async (...args) => { order.push('proxy'); return attempt(...args); },
      direct: async (url, options) => { order.push('direct'); assert.equal(url, noteUrl); assert.ok(options.signal instanceof AbortSignal); return safePage; },
    });
    assert.equal(response.status, 200); assert.deepEqual(order, ['proxy', 'direct']);
    const result = await response.json(); assert.equal(result.source, 'direct'); assert.equal(result.originalVideoCount, 1);
    for (const secret of ['private-subscription', 'direct-private-original', 'originVideoKey', 'raw-direct-script']) assert.ok(!JSON.stringify(result).includes(secret));
    const parsed = parseNoteHtml(result.html, { noteId }); assert.equal(parsed.images.length, 1); assert.equal(parsed.videos[0].url, playbackURL); assert.deepEqual(parsed.originalVideos, []);
  });
});

test('valid proxy data and origin-only membership hints never invoke direct source', async () => {
  for (const validPage of [page, notePage({ noteId, video: { originVideoKey: 'spectrum/member-only-original' } })]) {
    let directCalls = 0;
    const response = await browserPythonSource(request(), {}, { settings, proxy: async () => Response.json(validPage),
      direct: async () => { directCalls++; throw new Error('must-not-direct'); },
    });
    assert.equal(response.status, 200); assert.equal((await response.json()).source, 'proxy'); assert.equal(directCalls, 0);
  }
});

test('both source routes fail with fixed accurate manual-fallback status and no raw error details', async t => {
  for (const [name, proxyResult, directError, status, code] of [
    ['proxy challenge survives direct outage', () => Response.json({ code: 'UPSTREAM_LOGIN_REQUIRED' }, { status: 422 }), new Error(subscriptionUrl), 422, 'UPSTREAM_VERIFICATION_REQUIRED'],
    ['direct challenge', () => Response.json({}, { status: 502 }), Object.assign(new XhsError(subscriptionUrl, 400), { code: 'RATE_LIMITED' }), 422, 'UPSTREAM_VERIFICATION_REQUIRED'],
    ['both network errors', () => Response.json({}, { status: 502 }), new Error(subscriptionUrl), 502, 'SOURCE_UNAVAILABLE'],
    ['direct timeout', () => Response.json({}, { status: 502 }), new DOMException(subscriptionUrl, 'TimeoutError'), 504, 'SOURCE_UNAVAILABLE'],
    ['proxy timeout', () => Response.json({}, { status: 504 }), new Error(subscriptionUrl), 504, 'SOURCE_UNAVAILABLE'],
  ]) await t.test(name, async () => {
    let directCalls = 0, proxyCalls = 0;
    const response = await browserPythonSource(request(), {}, { settings,
      proxy: async () => { proxyCalls++; return proxyResult(); }, direct: async () => { directCalls++; throw directError; },
    });
    assert.equal(response.status, status); const body = await response.json(); assert.equal(body.code, code);
    assert.equal(proxyCalls, 1); assert.equal(directCalls, 1); assert.ok(!JSON.stringify(body).includes('private-subscription'));
  });
  const invalid = await browserPythonSource(request(), {}, { settings,
    proxy: async () => Response.json(notePage({ noteId })), direct: async () => ({ ...page, finalUrl: 'https://evil.example.com/'+noteId }),
  });
  assert.equal(invalid.status, 422); assert.equal((await invalid.json()).code, 'UPSTREAM_VERIFICATION_REQUIRED');
});

test('configuration failure and caller cancellation never start a direct source attempt', async () => {
  let calls = 0;
  const response = await browserPythonSource(request(), {}, { settings: async () => { throw new Error(subscriptionUrl); },
    direct: async () => { calls++; return page; }, proxy: async () => { calls++; return Response.json(page); },
  });
  assert.equal(response.status, 503); assert.equal(calls, 0);
  const missing = await browserPythonSource(request(), {}, { settings, direct: async () => { calls++; return page; } });
  assert.equal(missing.status, 503); assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  const cancelled = await browserPythonSource(new Request(request(), { signal: controller.signal }), {}, {
    settings, proxy: async () => { throw controller.signal.reason; }, direct: async () => { calls++; return page; },
  });
  assert.equal(cancelled.status, 504); assert.equal(calls, 0);
});

test('new media uses a single direct fallback after proxy rejection or exception and retains range validation', async t => {
  for (const type of ['image', 'video']) for (const failure of ['non-ok', 'exception']) await t.test(type+' '+failure, async () => {
    let proxyCalls = 0, directCalls = 0;
    const query = type === 'image' ? 'token=fixture_image' : new URLSearchParams({ url: playbackURL, action: 'chunk', start: '0', end: '3' });
    const response = await browserPythonMedia(new Request(origin+'/api/browser_python_'+type+'?'+query), {}, { settings,
      proxy: async () => { proxyCalls++; if (failure === 'exception') throw new Error(subscriptionUrl); return Response.json({ message: subscriptionUrl }, { status: 502 }); },
      direct: async (url, options) => {
        directCalls++; assert.equal(options.redirect, 'manual'); assert.ok(options.signal instanceof AbortSignal);
        if (type === 'image') { assert.equal(new URL(url).hostname, 'ci.xiaohongshu.com'); return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }); }
        assert.equal(url, playbackURL); assert.equal(options.headers.range, 'bytes=0-3');
        return new Response(new Uint8Array(4), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/100' } });
      },
    });
    assert.equal(response.status, 200); assert.equal(proxyCalls, 1); assert.equal(directCalls, 1);
  });
  const invalidRange = await browserPythonMedia(new Request(origin+'/api/browser_python_video?'+new URLSearchParams({ url: playbackURL, action: 'chunk', start: '0', end: '3' })), {}, {
    settings, proxy: async () => new Response('', { status: 502 }), direct: async () => new Response('xxxx', { status: 206,
      headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 1-4/100' } }),
  });
  assert.equal(invalidRange.status, 502);
});

test('direct media redirects preserve image allowlist and existing member-video guards without proxy retry', async () => {
  let imageCalls = 0, videoCalls = 0, proxyCalls = 0;
  const proxy = async () => { proxyCalls++; return new Response('', { status: 502 }); };
  const image = await browserPythonMedia(new Request(origin+'/api/browser_python_image?token=fixture_image'), {}, { settings, proxy,
    direct: async () => { imageCalls++; return new Response('', { status: 302, headers: { Location: 'https://169.254.169.254/private' } }); },
  });
  assert.equal(image.status, 502); assert.equal(imageCalls, 1);
  const video = await browserPythonMedia(new Request(origin+'/api/browser_python_video?'+new URLSearchParams({ url: playbackURL, action: 'chunk', start: '0', end: '3' })), {}, { settings, proxy,
    direct: async () => { videoCalls++; return new Response('', { status: 302, headers: { Location: 'https://sns-video-bd.xhscdn.com/spectrum/private-original' } }); },
  });
  assert.equal(video.status, 403); assert.equal(videoCalls, 1); assert.equal(proxyCalls, 2);
  let healthyCalls = 0, healthyProxyCalls = 0;
  const healthy = await browserPythonMedia(new Request(origin+'/api/browser_python_video?'+new URLSearchParams({ url: playbackURL, action: 'chunk', start: '0', end: '3' })), {}, { settings,
    proxy: async () => { healthyProxyCalls++; return new Response('', { status: 502 }); },
    direct: async () => ++healthyCalls === 1 ? new Response('', { status: 302, headers: { Location: 'https://sns-video-hw.xhscdn.com/stream/redirected.mp4' } })
      : new Response(new Uint8Array(4), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/100' } }),
  });
  assert.equal(healthy.status, 200); assert.equal(healthyCalls, 2); assert.equal(healthyProxyCalls, 1);
});

test('direct media enforces actual body limits and cancellation before returning headers to native handlers', async t => {
  for (const [type, limit] of [['image', 4_200_000], ['video', 3_500_000]]) await t.test(type+' body limit', async () => {
    let cancelled = 0;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limit + 1)); }, cancel() { cancelled++; } });
    const query = type === 'image' ? 'token=fixture_image' : new URLSearchParams({ url: playbackURL, action: 'chunk', start: '0', end: '3' });
    const response = await browserPythonMedia(new Request(origin+'/api/browser_python_'+type+'?'+query), {}, { settings,
      proxy: async () => new Response('', { status: 502 }), direct: async () => new Response(stream, {
        headers: { 'Content-Type': type+'/jpeg', 'Content-Length': '1' },
      }),
    });
    assert.ok(response.status >= 500); assert.equal(cancelled, 1);
  });
  let cancelled = 0, ready;
  const connected = new Promise(resolve => { ready = resolve; });
  const controller = new AbortController();
  const stream = new ReadableStream({ cancel() { cancelled++; } });
  const pending = browserPythonMedia(new Request(origin+'/api/browser_python_image?token=fixture_image', { signal: controller.signal }), {}, { settings,
    proxy: async () => new Response('', { status: 502 }), direct: async () => { ready(); return new Response(stream, { headers: { 'Content-Type': 'image/jpeg' } }); },
  });
  await connected; controller.abort(new DOMException(subscriptionUrl, 'AbortError'));
  const response = await pending; assert.ok(response.status >= 500); assert.equal(cancelled, 1); assert.ok(!(await response.text()).includes('private-subscription'));
});

test('direct metadata cancels unneeded video data and configuration outages never attempt media fallback', async () => {
  let cancelled = 0, directCalls = 0;
  const query = new URLSearchParams({ url: playbackURL, action: 'meta' });
  const metadata = await browserPythonMedia(new Request(origin+'/api/browser_python_video?'+query), {}, { settings,
    proxy: async () => new Response('', { status: 502 }), direct: async () => {
      directCalls++; return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': '100000000' },
      });
    },
  });
  assert.equal(metadata.status, 200); assert.equal((await metadata.json()).size, 100000000); assert.equal(cancelled, 1); assert.equal(directCalls, 1);
  const failed = await browserPythonMedia(new Request(origin+'/api/browser_python_image?token=fixture_image'), {}, {
    settings: async () => { throw new Error(subscriptionUrl); }, direct: async () => { directCalls++; throw new Error('must-not-direct'); },
    proxy: async () => assert.fail('configuration failure must not fetch'),
  });
  assert.ok(failed.status >= 500); assert.equal(directCalls, 1);
});
