import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { LIMITS, isPublicAddress, safeHostname, subscriptionURL, noteURL, noteRedirect, mediaURL, mediaRange, mediaAccept, parseSubscription, classifyNote, publicError, ProxyError } from '../src/policy.js';
import { NOTE, MEDIA, SUBSCRIPTION, proxyNode, subscription } from './fixtures.js';

test('supported nodes use anonymous stable ids; provider/rules/extra headers are never executed', () => {
  const input = proxyNode(1);
  input['ws-opts'].headers.Authorization = 'secret';
  const nodes = parseSubscription(subscription([input, structuredClone(input)]));
  assert.equal(nodes.length, 1);
  assert.match(nodes[0].id, /^[a-f0-9]{24}$/);
  assert.equal(nodes[0].config.name, undefined);
  assert.deepEqual(nodes[0].config['ws-opts'].headers, { Host: 'ws.example.com' });
  assert.ok(!JSON.stringify(nodes).includes('PRIVATE_NAME'));
});

for (const [description, override] of [
  ['non-vless', { type: 'ss' }], ['non-ws', { network: 'tcp' }], ['no TLS', { tls: false }],
  ['unverified TLS', { 'skip-cert-verify': true }], ['private server', { server: '127.0.0.1' }],
  ['invalid uuid', { uuid: 'secret' }], ['flow', { flow: 'xtls-rprx-vision' }], ['reality', { 'reality-opts': {} }],
  ['dialer injection', { 'dialer-proxy': 'DIRECT' }], ['nonstandard encryption', { encryption: 'secret' }],
  ['port range', { port: 65536 }], ['WS header injection', { 'ws-opts': { path: '/x', headers: { Host: 'ws.example.com\r\nSecret: x' } } }],
  ['WS path injection', { 'ws-opts': { path: '/x\r\nAuthorization: secret' } }],
]) test(`reject ${description}`, () => assert.throws(() => parseSubscription(subscription([proxyNode(1, override)])), { code: 'SUBSCRIPTION_NO_SUPPORTED_NODES' }));

test('YAML aliases, duplicate keys, unsupported structures and excessive input are rejected', () => {
  for (const input of ['proxies: &nodes []\nx: *nodes', 'proxies: []\nproxies: []', '[]', 'proxies: no']) assert.throws(() => parseSubscription(input), { code: 'SUBSCRIPTION_INVALID' });
  assert.throws(() => parseSubscription('x'.repeat(LIMITS.subscriptionBytes + 1)), { code: 'SUBSCRIPTION_TOO_LARGE' });
  assert.throws(() => parseSubscription(subscription(Array.from({ length: 65 }, (_, index) => proxyNode(index + 1)))), { code: 'SUBSCRIPTION_NODE_LIMIT' });
  assert.throws(() => parseSubscription(`proxies: []\nx: ${'['.repeat(300)}0${']'.repeat(300)}`));
});

for (const address of ['127.0.0.1', '10.1.1.1', '172.31.1.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
  test(`private/nonpublic address ${address} rejected`, () => assert.equal(isPublicAddress(address), false));
}
test('public addresses and only plausible public hostnames pass', () => {
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const host of ['localhost', 'metadata.google.internal', 'host.local', 'host.test', '127.0.0.1', 'user@example.com', 'host.example\n']) assert.equal(safeHostname(host), false);
  assert.equal(safeHostname('ws.example.com'), true);
});

test('target allowlists reject credentials, private hosts, unsafe schemes and redirects', () => {
  assert.equal(noteURL(NOTE).hostname, 'www.xiaohongshu.com');
  assert.equal(subscriptionURL(SUBSCRIPTION).searchParams.get('token'), 'private-test-token');
  assert.equal(noteURL('https://xhslink.com/a/abc').hostname, 'xhslink.com');
  for (const value of ['http://www.xiaohongshu.com/explore/668d2967000000002500100a', 'https://www.xiaohongshu.com.evil.com/explore/668d2967000000002500100a', 'https://user:secret@www.xiaohongshu.com/explore/668d2967000000002500100a', 'https://www.xiaohongshu.com:8443/explore/668d2967000000002500100a', 'https://www.xiaohongshu.com/login']) assert.throws(() => noteURL(value));
  assert.throws(() => noteRedirect('https://www.xiaohongshu.com/error?secret=ignored'), { code: 'UPSTREAM_VERIFICATION_REQUIRED' });
  assert.throws(() => noteRedirect('https://evil.example.com/x'), { code: 'UPSTREAM_REDIRECT_REJECTED' });
  assert.throws(() => subscriptionURL('https://127.0.0.1/secret'), { code: 'INVALID_SUBSCRIPTION_URL' });
});

test('media whitelist excludes member spectrum paths and range has a bounded single interval', () => {
  assert.equal(mediaURL(MEDIA).hostname, 'sns-webpic-qc.xhscdn.com');
  for (const value of ['https://evil.example.com/image', 'https://xhscdn.com.evil.com/x', 'https://sns-video-bd.xhscdn.com/spectrum/member', 'https://sns-video-bd.xhscdn.com/%73pectrum%2fmember', 'https://sns-video-bd.xhscdn.com/x%2f..%2fy']) assert.throws(() => mediaURL(value));
  assert.deepEqual(mediaRange('bytes=0-3499999'), { header: 'bytes=0-3499999', start: 0, end: 3499999, bytes: 3500000 });
  for (const range of ['bytes=0-', 'bytes=-100', 'bytes=0-3500000', 'bytes=0-1,4-5', 'bytes=8-7', 'bytes=9007199254740992-9007199254740992', 'bytes=0-1\r\nSecret: x']) assert.throws(() => mediaRange(range), { code: 'INVALID_RANGE' });
  assert.throws(() => mediaAccept('video/*\r\nCookie: secret'), { code: 'INVALID_ACCEPT' });
});

test('captcha/login classification and unknown error projection contain only fixed codes', () => {
  assert.throws(() => classifyNote('<title>小红书 - 安全验证</title>'), { code: 'UPSTREAM_VERIFICATION_REQUIRED' });
  assert.throws(() => classifyNote('<title>登录</title>'), { code: 'UPSTREAM_LOGIN_REQUIRED' });
  assert.deepEqual(publicError(new Error('https://private.example/?token=secret')), { code: 'PROXY_UNAVAILABLE', status: 502 });
  assert.deepEqual(publicError(new ProxyError('PROXY_BUSY', 503)), { code: 'PROXY_BUSY', status: 503 });
});

test('public spectrum covers are confined to the six exact image CDNs; video and unlisted hosts remain rejected', () => {
  for (const host of ['sns-webpic-qc.xhscdn.com', 'sns-webpic.xhscdn.com', 'sns-img-hw.xhscdn.com',
    'sns-img-bd.xhscdn.com', 'sns-img-al.xhscdn.com', 'ci.xiaohongshu.com']) {
    assert.equal(mediaURL(`https://${host}/spectrum/fixture-cover`).hostname, host);
    assert.equal(mediaURL(`https://${host}/%73pectrum%2ffixture-cover`).hostname, host);
  }
  for (const host of ['sns-video-bd.xhscdn.com', 'sns-video-hw.xhscdn.com', 'xhscdn.com',
    'other.xhscdn.com', 'sns-img-unlisted.xhscdn.com', 'sns-webpic-qc.xhscdn.com.evil.example']) {
    for (const path of ['/spectrum/fixture', '/%73pectrum%2ffixture', '/stream/SPECTRUM/fixture']) {
      assert.throws(() => mediaURL(`https://${host}${path}`));
    }
  }
  assert.throws(() => mediaURL('https://ci.xiaohongshu.com/spectrum%2f..%2fprivate'), { code: 'MEDIA_PATH_REJECTED' });
  assert.throws(() => mediaURL('https://ci.xiaohongshu.com/spectrum%5cprivate'), { code: 'MEDIA_PATH_REJECTED' });
});
