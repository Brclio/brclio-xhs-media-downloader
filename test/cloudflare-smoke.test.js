import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChecks, parseArgs, runSmoke } from '../scripts/verify-cloudflare.mjs';
import { createAccountHandler } from '../api/account.js';
import { createHostedMemberVideoHandler } from '../api/member_video.js';
import videoHandler from '../api/video.js';
import { invokeHandler } from '../cloudflare/http-adapter.js';
import { isMemberVideoUrl } from '../lib/video-policy.js';

const baseUrl = 'https://deployment.example.test';
const checkedJson = (value, status = 200) => ({ status, headers: new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }), text: JSON.stringify(value) });

test('all account smoke cases are rejected before reading configuration or invoking account service', async () => {
  const accountChecks = buildChecks().filter(check => check.path === '/api/account');
  assert.equal(accountChecks.length, 5);
  const handler = createAccountHandler({
    env: new Proxy({}, { get() { assert.fail('Smoke request reached account configuration'); } }),
    service: { execute() { assert.fail('Smoke request reached account service'); } },
  });
  for (const check of accountChecks) {
    let body;
    const headers = new Headers();
    const res = { statusCode: 200, setHeader(key, value) { headers.set(key, value); }, status(code) { this.statusCode = code; return this; }, json(value) { body = value; return this; } };
    await handler({ method: check.init.method || 'GET', headers: check.init.headers || {}, body: check.init.body }, res);
    check.verify({ status: res.statusCode, headers, text: JSON.stringify(body) });
  }
});

test('the default plan has no authorization, cookies, mail or successful account actions', () => {
  const checks = buildChecks();
  for (const check of checks) {
    assert.match(check.path, /^\/(?!\/)/);
    const headers = new Headers(check.init.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    assert.doesNotMatch(check.init.body || '', /send-code|verify-code|admin-|feedback-|redeem|logout/);
    assert.ok(!check.name.includes('/upstream/'));
  }
});

test('rejects credential-bearing origins and unsafe optional media arguments without echoing input', () => {
  for (const args of [
    ['https://user:DO_NOT_PRINT@example.test'],
    ['https://example.test?token=DO_NOT_PRINT'],
    ['--note-url', 'https://example.test/DO_NOT_PRINT'],
    ['--image-token', '../DO_NOT_PRINT'],
    ['--video-url', 'https://xhscdn.com.evil.test/DO_NOT_PRINT'],
  ]) {
    assert.throws(() => parseArgs(args), error => !error.message.includes('DO_NOT_PRINT'));
  }
  assert.equal(parseArgs(['http://127.0.0.1:8787']).baseUrl, 'http://127.0.0.1:8787');
});

test('only explicitly supplied real media is requested and video chunks are bounded', () => {
  const options = parseArgs([baseUrl, '--video-url', 'https://sns-video-bd.xhscdn.com/stream/example.mp4']);
  const upstream = buildChecks(options).filter(check => check.name.includes('/upstream/'));
  assert.equal(upstream.length, 4);
  for (const check of upstream.filter(check => check.name.endsWith('video-chunk'))) {
    const url = new URL(check.path, baseUrl);
    assert.equal(url.searchParams.get('start'), '0');
    assert.equal(url.searchParams.get('end'), '4095');
    assert.equal(check.maxBytes, 4096);
  }
});

test('playback range checks remain public while both engines reject original proxy metadata and chunks', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Smoke rejection made an upstream request'));
  t.mock.method(console, 'error', () => {});
  const checks = buildChecks();
  for (const engine of ['node', 'python']) {
    const ranges = checks.filter(check => check.name.startsWith(`${engine}/video/`) && check.name.endsWith('-range'));
    assert.equal(ranges.length, 2);
    for (const check of ranges) assert.equal(isMemberVideoUrl(new URL(check.path, baseUrl).searchParams.get('url')), false);
    const protectedChecks = checks.filter(check => check.name.startsWith(`${engine}/video/original-`));
    assert.equal(protectedChecks.length, 2);
    for (const check of protectedChecks) {
      assert.equal(isMemberVideoUrl(new URL(check.path, baseUrl).searchParams.get('url')), true);
      check.verify(checkedJson({ success: false, engine }, 403));
      assert.throws(() => check.verify(checkedJson({ success: true, engine })), /Expected HTTP 403/);
    }
  }
  for (const check of checks.filter(check => check.name.startsWith('node/video/') && /original-|invalid-range|oversize-range/.test(check.name))) {
    const response = await invokeHandler(videoHandler, new Request(baseUrl + check.path));
    check.verify({ status: response.status, headers: response.headers, text: await response.text() });
  }
});

test('guest member gateway smoke rejects before account configuration, resolver or upstream access', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Guest smoke reached an upstream request'));
  const handler = createHostedMemberVideoHandler({
    env: new Proxy({}, { get() { assert.fail('Guest smoke reached account configuration'); } }),
    accountFetch() { assert.fail('Guest smoke reached account storage'); },
    resolve() { assert.fail('Guest smoke reached note resolver'); },
  });
  const checks = buildChecks().filter(check => check.name.startsWith('member-video/guest-'));
  assert.equal(checks.length, 3);
  for (const check of checks) {
    const response = await invokeHandler(handler, new Request(baseUrl + check.path, check.init));
    check.verify({ status: response.status, headers: response.headers, text: await response.text() });
    check.verify(checkedJson({ success: false }, 403));
    assert.throws(() => check.verify(checkedJson({ success: false }, 503)), /401 or 403/);
    assert.throws(() => check.verify(checkedJson({ success: false, videos: [{ url: 'member-video:DO_NOT_PRINT' }] }, 401)), /exposed/);
  }
});

test('browser account static module must be served as JavaScript with its account bridge export', () => {
  const check = buildChecks().find(check => check.name === 'static/browser-account-module');
  assert.equal(check.path, '/lib/browser-account.js');
  check.verify({ status: 200, headers: new Headers({ 'content-type': 'text/javascript' }), bytes: Buffer.from('export function getAccountBridge() {}'), text: 'export function getAccountBridge() {}' });
  assert.throws(() => check.verify({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), bytes: Buffer.from('<html>'), text: '<html>' }), /content type/);
});

test('optional note smoke accepts images and original-only availability without leaking original source URLs', () => {
  const checks = buildChecks({ noteUrl: 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa' }).filter(check => check.name.endsWith('/upstream/note'));
  assert.equal(checks.length, 2);
  const original = 'https://sns-video-bd.xhscdn.com/spectrum/DO_NOT_PRINT.mp4';
  const playback = { url: 'https://sns-video-bd.xhscdn.com/stream/playback.mp4', backupUrls: ['https://sns-video-hw.xhscdn.com/stream/playback.mp4'] };
  for (const check of checks) {
    const engine = check.name.split('/')[0];
    const payload = overrides => ({ success: true, engine, images: [], videos: [], originalVideoCount: 0, hasOriginalVideo: false, ...overrides });
    for (const valid of [
      { images: [{ url: 'https://ci.xiaohongshu.com/image-token?imageView2/format/jpg' }] },
      { images: [{ url: 'https://sns-webpic-qc.xhscdn.com/image-token' }] },
      { videos: [playback] },
      { originalVideoCount: 1, hasOriginalVideo: true },
    ]) check.verify(checkedJson(payload(valid)));
    for (const leaked of [
      { videos: [{ url: original }] },
      { videos: [{ ...playback, backupUrls: [original] }] },
      { images: [{ url: 'https://ci.xiaohongshu.com/image-token', liveVideo: { url: original } }] },
      { images: [{ url: original }] },
      { originalVideoCount: 1, hasOriginalVideo: true, originalVideos: [{ url: original }] },
      { originalVideoCount: 1, hasOriginalVideo: true, originVideoKey: 'DO_NOT_PRINT' },
    ]) assert.throws(() => check.verify(checkedJson(payload(leaked))), error => /original video source/.test(error.message) && !error.message.includes('DO_NOT_PRINT'));
  }
});

test('explicit original-video URL checks verify anonymous denial instead of attempting ordinary playback', () => {
  const options = parseArgs([baseUrl, '--video-url', 'https://sns-video-bd.xhscdn.com/spectrum/original.mp4']);
  const checks = buildChecks(options).filter(check => check.name.includes('/upstream/video-'));
  assert.equal(checks.length, 4);
  for (const check of checks) {
    check.verify(checkedJson({ success: false }, 403));
    assert.throws(() => check.verify(checkedJson({ success: true })), /Expected HTTP 403/);
  }
});

test('foreign redirects are never followed and thrown fetch messages are redacted', async () => {
  const seen = [];
  const checks = [
    { name: 'redirect', path: '/', init: {}, allowRedirect: true, verify() { assert.fail('Should reject redirect'); } },
    { name: 'network', path: '/api/parse', init: {}, verify() { assert.fail('Should reject network failure'); } },
  ];
  const report = await runSmoke({ baseUrl }, { checks, fetchImpl: async (url, init) => {
    seen.push(url.href);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    if (url.pathname === '/') return new Response(null, { status: 302, headers: { location: 'https://DO_NOT_PRINT.example.test/token' } });
    throw new Error('DO_NOT_PRINT secret request details');
  } });
  assert.equal(seen.length, 2);
  assert.equal(report.passed, 0);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT|secret request/);
  assert.match(report.results[0].reason, /origin/);
});

test('oversized streaming responses are canceled and omitted from reports', async () => {
  let canceled = false;
  const report = await runSmoke({ baseUrl }, {
    checks: [{ name: 'bounded-media', path: '/', init: {}, maxBytes: 16, verify() { assert.fail('Oversize reached validator'); } }],
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('DO_NOT_PRINT_RESPONSE_BODY')); },
      cancel() { canceled = true; },
    })),
  });
  assert.equal(canceled, true);
  assert.equal(report.passed, 0);
  assert.equal(report.results[0].reason, 'Response exceeded byte limit.');
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT_RESPONSE_BODY/);
});

test('timeouts include a bounded failure and execution continues to the next check', async () => {
  const report = await runSmoke({ baseUrl }, {
    timeoutMs: 10,
    checks: [
      { name: 'timeout', path: '/slow', init: {}, verify() { assert.fail('Timeout reached validator'); } },
      { name: 'next', path: '/next', init: {}, verify(response) { assert.equal(response.status, 200); } },
    ],
    fetchImpl: (url, { signal }) => url.pathname === '/slow'
      ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('internal details')), { once: true }))
      : Promise.resolve(new Response('ok')),
  });
  assert.equal(report.passed, 1);
  assert.equal(report.results[0].reason, 'Request failed or timed out.');
  assert.equal(report.results[1].ok, true);
});
