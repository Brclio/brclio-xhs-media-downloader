import test from 'node:test';
import assert from 'node:assert/strict';
import { createParseHandler } from '../api/parse.js';
import { createCloudflareParseHandler } from '../cloudflare/native-parse.js';
import { invokeHandler } from '../cloudflare/http-adapter.js';
import { XhsError } from '../lib/xhs.js';

const noteId = 'abcdef1234567890abcdef12';
const secret = 'PRIVATE_DIAGNOSTIC_SENTINEL';
const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${secret}`;
const request = (text = noteUrl) => new Request('https://fixture.example.test/api/parse', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: secret, Authorization: `Bearer ${secret}` },
  body: JSON.stringify({ text, private: secret }),
});
const html = (images = []) => `<title>${secret}</title><script>window.__INITIAL_STATE__=${JSON.stringify({
  note: { noteDetailMap: { [noteId]: { note: { noteId, title: secret, desc: secret, imageList: images } } } },
})}</script>`;
const assertPrivate = logs => {
  const text = JSON.stringify(logs);
  for (const value of [secret, noteId, 'xsec_token', 'https://', '<title>', 'Bearer', 'Cookie']) assert.ok(!text.includes(value), value);
};

test('parse factory injects page fetch and exposes only parsed strategy and counts to its hook', async () => {
  const calls = [], parsed = [], errors = [];
  const handler = createParseHandler({ fetchPage: async url => {
    calls.push(url); return { finalUrl: url, html: html([{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/fixture-token' }]) };
  }, onParsed: value => parsed.push(value), onError: error => errors.push(error) });
  const response = await invokeHandler(handler, request());
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(parsed, [{ strategy: 'exact-initial-state', imageCount: 1, videoCount: 0, originalVideoCount: 0 }]);
  assert.deepEqual(errors, []);
});

test('Cloudflare diagnostics describe existing redirect hops without extra fetches or sensitive log fields', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('injected request transport was not used'));
  const calls = [], logs = [];
  const handler = createCloudflareParseHandler({ log: value => logs.push(value), fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.redirect, 'manual');
    assert.equal(new Headers(options.headers).get('cookie'), null);
    assert.equal(new Headers(options.headers).get('authorization'), null);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: noteUrl } }) : new Response(html());
  } });
  const response = await invokeHandler(handler, request(`https://xhslink.cn/o/${secret}`));
  assert.equal(response.status, 422);
  assert.equal(calls.length, 2);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    event: 'xhs_native_parse_failure', engine: 'node', phase: 'parse', failureClass: 'no-media',
    upstream: [{ host: 'xhslink.cn', pathClass: 'shortlink', status: 302 },
      { host: 'www.xiaohongshu.com', pathClass: 'note', status: 200 }],
    finalHost: 'www.xiaohongshu.com', finalPathClass: 'note', htmlBytes: new TextEncoder().encode(html()).byteLength,
    noteIdPresent: true, initialStatePresent: true, currentNotePresent: true,
    challengeDetected: false, loginDetected: false, strategy: 'not-found',
    imageCount: 0, videoCount: 0, originalVideoCount: 0,
  });
  assertPrivate(logs);
});

test('only explicit upstream login or CAPTCHA paths and branded titles change a no-media error', async () => {
  for (const [finalUrl, pageHtml, failureClass] of [
    ['https://www.xiaohongshu.com/captcha/check', '<html>verify</html>', 'captcha'],
    ['https://www.xiaohongshu.com/website-login', '<html>login</html>', 'login'],
    [noteUrl, '<title>小红书 - 安全验证</title>', 'captcha'],
    [noteUrl, '<title>登录 - 小红书</title>', 'login'],
    [noteUrl, '<title>普通笔记提到安全验证和登录</title><div>captcha login signin</div>', 'no-media'],
  ]) {
    const logs = [];
    const handler = createCloudflareParseHandler({ log: value => logs.push(value),
      fetchPage: async () => ({ finalUrl, html: pageHtml }) });
    const response = await invokeHandler(handler, request());
    assert.equal(response.status, 422);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].failureClass, failureClass);
    const body = await response.json();
    assert.match(body.message, failureClass === 'captcha' ? /服务器完成安全验证/ : failureClass === 'login' ? /要求登录后查看/ : /没有解析到图片或视频/);
    assertPrivate(logs);
  }
});

test('missing note identity on an explicit login page has a safe friendly error', async () => {
  const logs = [];
  const handler = createCloudflareParseHandler({ log: value => logs.push(value),
    fetchPage: async () => ({ finalUrl: 'https://www.xiaohongshu.com/login', html: '<title>小红书登录</title>' }) });
  const response = await invokeHandler(handler, request('https://xhslink.cn/o/fixture'));
  assert.equal(response.status, 422);
  assert.match((await response.json()).message, /要求登录后查看/);
  assert.equal(logs[0].noteIdPresent, false);
  assert.equal(logs[0].failureClass, 'login');
});

test('current note presence requires a structural ID marker rather than an ID in prose or a URL', async () => {
  for (const [pageHtml, expected] of [[`<script>{"noteId":"${noteId}","imageList":[]}</script>`, true],
    [`<script>{"noteDetailMap":{"${noteId}":{}}}</script>`, true],
    [`<p>${noteId} ${noteUrl}</p>`, false]]) {
    const logs = [];
    const handler = createCloudflareParseHandler({ log: value => logs.push(value),
      fetchPage: async () => ({ finalUrl: noteUrl, html: pageHtml }) });
    assert.equal((await invokeHandler(handler, request())).status, 422);
    assert.equal(logs[0].currentNotePresent, expected);
    assertPrivate(logs);
  }
});

test('success stays silent and concurrent failures keep their traces separate', async () => {
  const logs = [];
  let calls = 0;
  const handler = createCloudflareParseHandler({ log: value => logs.push(value), fetchImpl: async url => {
    calls++;
    await Promise.resolve();
    return new Response(String(url).includes('success=1') ? html([{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/fixture-token' }]) : html());
  } });
  assert.equal((await invokeHandler(handler, request(noteUrl + '&success=1'))).status, 200);
  assert.deepEqual(logs, []);
  const failures = await Promise.all([invokeHandler(handler, request()), invokeHandler(handler, request())]);
  assert.deepEqual(failures.map(response => response.status), [422, 422]);
  assert.equal(calls, 3);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(value => value.upstream.length), [1, 1]);
  assertPrivate(logs);
});

test('network errors never print raw exception details and diagnostic failures preserve native responses', async t => {
  const printed = [], logs = [];
  t.mock.method(console, 'error', (...values) => printed.push(values));
  const handler = createCloudflareParseHandler({ log: value => logs.push(value), fetchImpl: async () => { throw new Error(secret); } });
  assert.equal((await invokeHandler(handler, request())).status, 502);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].failureClass, 'fetch-failed');
  assert.equal(logs[0].finalHost, 'www.xiaohongshu.com');
  assert.equal(logs[0].noteIdPresent, true);
  assert.deepEqual(logs[0].upstream, [{ host: 'www.xiaohongshu.com', pathClass: 'note', status: 0 }]);
  assert.deepEqual(printed, []);
  assertPrivate(logs);
  const brokenLogger = createCloudflareParseHandler({ log: () => { throw new Error(secret); },
    fetchPage: async () => ({ finalUrl: noteUrl, html: '<html>unavailable</html>' }) });
  assert.equal((await invokeHandler(brokenLogger, request())).status, 422);
});

test('invalid input does not fetch or log and unrecognized hosts cannot enter diagnostics', async () => {
  const logs = [];
  const handler = createCloudflareParseHandler({ log: value => logs.push(value), fetchImpl: () => assert.fail('invalid input fetched') });
  assert.equal((await invokeHandler(handler, request('https://example.com/private'))).status, 400);
  assert.deepEqual(logs, []);
  const injected = createCloudflareParseHandler({ log: value => logs.push(value),
    fetchPage: async () => ({ finalUrl: `https://${secret}.example/login`, html: '<title>小红书登录</title>' }) });
  assert.equal((await invokeHandler(injected, request())).status, 422);
  assert.equal(logs[0].finalHost, 'other');
  assert.equal(logs[0].finalPathClass, 'other');
  assert.equal(logs[0].loginDetected, false);
  assertPrivate(logs);
});

test('explicit upstream auth and rate responses become Browser-eligible only in the Cloudflare adapter', async () => {
  for (const status of [401, 403, 429, 461, 471]) {
    const logs = []; let fetches = 0;
    const handler = createCloudflareParseHandler({ log: value => logs.push(value), fetchImpl: async (_url, options) => {
      fetches++; assert.equal(new Headers(options.headers).get('cookie'), null);
      assert.equal(new Headers(options.headers).get('authorization'), null);
      return new Response(null, { status });
    } });
    const response = await invokeHandler(handler, request());
    assert.equal(response.status, 422); assert.equal(fetches, 1); assert.equal(logs.length, 1);
    assert.match((await response.json()).message, status === 401 ? /要求登录/ : /安全验证|限制/);
    assert.deepEqual(logs[0].upstream.map(value => value.status), [status]); assertPrivate(logs);
  }
  for (const code of ['AUTH_REQUIRED', 'RATE_LIMITED']) {
    const failure = Object.assign(new XhsError(secret, 400), { code });
    const adapter = createCloudflareParseHandler({ fetchPage: async () => { throw failure; }, log() {} });
    const response = await invokeHandler(adapter, request());
    assert.equal(response.status, 422); assert.doesNotMatch(JSON.stringify(await response.json()), new RegExp(secret));
    const desktop = createParseHandler({ fetchPage: async () => { throw failure; }, onError() {} });
    assert.equal((await invokeHandler(desktop, request())).status, 400);
  }
});

test('ordinary 400 errors and unrelated upstream client errors never become browser-eligible', async () => {
  for (const status of [400, 404]) {
    let fetches = 0;
    const adapter = createCloudflareParseHandler({ log() {}, fetchImpl: async () => { fetches++; return new Response(null, { status }); } });
    assert.equal((await invokeHandler(adapter, request())).status, 400); assert.equal(fetches, 1);
  }
  for (const failure of [new XhsError('Unsupported redirect.', 400),
    Object.assign(new XhsError('Unrelated validation.', 400), { code: 'OTHER' }),
    Object.assign(new Error(secret), { code: 'RATE_LIMITED', statusCode: 400 })]) {
    const adapter = createCloudflareParseHandler({ log() {}, fetchPage: async () => { throw failure; } });
    assert.equal((await invokeHandler(adapter, request())).status, failure instanceof XhsError ? 400 : 500);
  }
});
