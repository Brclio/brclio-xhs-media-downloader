import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ENDPOINT_PROBE_MS, FreeSubscriptionService, PROBE_URL, compatibleEndpoints, fetchFreshSubscription,
  fetchMedia, fetchNote, probeEndpoints, readBounded } from '../free-service.js';
import { LIMITS, parseSubscription } from '../src/policy.js';
import { NOTE, MEDIA, SUBSCRIPTION, proxyNode, subscription } from './fixtures.js';

const endpointNode = (index, extra = {}) => proxyNode(index, {
  server: `node${index}.example.com`, servername: `node${index}.example.com`,
  'ws-opts': { path: '/tunnel?key=private-node-token', headers: { Host: `node${index}.example.com` } }, ...extra,
});
const STREAM = 'https://sns-video-bd.xhscdn.com/stream/fixture.mp4';
const result = (status, headers = {}, body = '') => ({ status, headers: new Headers(headers), body: new TextEncoder().encode(body) });
const htmlResult = body => result(200, { 'Content-Type': 'text/html; charset=utf-8' }, body ?? '<title>笔记</title>');

function harness({ now = Date.now, transport, text = subscription([endpointNode(1), endpointNode(2)]) } = {}) {
  const calls = { subscriptions: [], probes: [], notes: [], media: [] };
  const service = new FreeSubscriptionService({ now,
    subscription: async (url, options) => { calls.subscriptions.push({ url, options }); return text; },
    transport: transport ?? (async (node, url, options) => {
      if (url === PROBE_URL) { calls.probes.push(node.id); return result(204); }
      if (new URL(url).hostname.endsWith('.xhscdn.com')) {
        calls.media.push({ nodeId: node.id, url, options }); return result(200, { 'Content-Type': 'image/jpeg' }, 'image');
      }
      calls.notes.push({ nodeId: node.id, url, options }); return htmlResult();
    }),
  });
  return { service, calls };
}

test('every note fetches a fresh subscription and probes; media cache expires at exactly 60 seconds', async () => {
  let now = 1_700_000_000_000;
  const { service, calls } = harness({ now: () => now });
  const first = await service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION });
  assert.equal(first.nodeCount, 2); assert.equal(first.endpointCount, 2);
  assert.equal(first.entrySelectionPreserved, true); assert.equal(first.nodeId, calls.notes[0].nodeId);
  assert.match(first.nodeId, /^[a-f0-9]{24}$/);
  assert.ok(!JSON.stringify(first).includes('private-node-token'));
  await service.media({ url: MEDIA, subscriptionUrl: SUBSCRIPTION });
  assert.equal(calls.subscriptions.length, 1); assert.equal(calls.probes.length, 2);
  now += 59_999;
  await service.media({ url: MEDIA, subscriptionUrl: SUBSCRIPTION });
  assert.equal(calls.subscriptions.length, 1);
  now++;
  await service.media({ url: MEDIA, subscriptionUrl: SUBSCRIPTION });
  assert.equal(calls.subscriptions.length, 2); assert.equal(calls.probes.length, 4);
  await service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION });
  assert.equal(calls.subscriptions.length, 3); assert.equal(calls.probes.length, 6);
  assert.equal(calls.subscriptions[0].options.signal instanceof AbortSignal, true);
});

test('cache is keyed by the full subscription URL and a failed fresh batch leaves no reusable cache', async () => {
  const { service, calls } = harness();
  await service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION });
  await service.media({ url: MEDIA, subscriptionUrl: SUBSCRIPTION + '-changed' });
  assert.equal(calls.subscriptions.length, 2);
  service.subscription = async () => { throw new Error('private-token-must-not-cache'); };
  await assert.rejects(service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION }));
  assert.equal(service.cache, null);
});

test('preferred IP variants of the same verified WSS route are one endpoint and do not claim IP preservation', () => {
  const shared = endpointNode(1, { server: '1.1.1.1' });
  const variant = { ...structuredClone(shared), server: '1.0.0.1' };
  const other = endpointNode(2);
  const nodes = parseSubscription(subscription([shared, variant, other]));
  assert.equal(nodes.length, 3);
  const endpoints = compatibleEndpoints(nodes);
  assert.equal(endpoints.length, 2);
  assert.deepEqual(endpoints.map(node => node.entrySelectionPreserved), [false, true]);
  assert.throws(() => compatibleEndpoints(parseSubscription(subscription([endpointNode(1, { servername: 'other.example.com' })]))),
    { code: 'SUBSCRIPTION_NO_COMPATIBLE_ENDPOINTS' });
});

test('only bodyless HTTP 204 qualifies; two-at-a-time probes rank measured fastest first', async () => {
  let clock = 0, active = 0, maxActive = 0;
  const completions = new Map();
  const nodes = ['slow', 'fast', 'html', 'body', 'offline'].map(id => ({ id }));
  const pending = probeEndpoints(nodes, { now: () => clock, transport: async (node, url, options) => {
    assert.equal(url, PROBE_URL); assert.equal(options.maxBytes, 16_384);
    assert.equal(options.headers.Accept, '*/*'); assert.equal(options.signal instanceof AbortSignal, true);
    active++; maxActive = Math.max(maxActive, active);
    try {
      if (node.id === 'offline') throw new Error('private-node-token');
      if (node.id === 'html') return result(200);
      if (node.id === 'body') return result(204, {}, 'not-empty');
      return await new Promise(resolve => completions.set(node.id, resolve));
    } finally { active--; }
  } });
  assert.equal(completions.size, 2); assert.equal(maxActive, 2);
  clock = 5; completions.get('fast')(result(204));
  await new Promise(setImmediate);
  clock = 30; completions.get('slow')(result(204));
  const healthy = await pending;
  assert.deepEqual(healthy.map(node => [node.id, node.latencyMs]), [['fast', 5], ['slow', 30]]);
  assert.equal(maxActive, 2);
  await assert.rejects(probeEndpoints(nodes, { transport: async () => result(204, {}, 'unexpected') }), { code: 'PROXY_NO_HEALTHY_NODES' });
});

test('verification and login stop on the selected node without rotating or re-fetching subscription', async t => {
  for (const response of [result(403), result(429), htmlResult('<title>安全验证</title>'), htmlResult('<title>登录</title>')]) {
    await t.test(`status ${response.status}`, async () => {
      let subscriptionCalls = 0, noteCalls = 0;
      const service = new FreeSubscriptionService({ subscription: async () => { subscriptionCalls++; return subscription([endpointNode(1), endpointNode(2)]); },
        transport: async (_node, url) => { if (url === PROBE_URL) return result(204); noteCalls++; return response; } });
      await assert.rejects(service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION }),
        error => ['UPSTREAM_VERIFICATION_REQUIRED', 'UPSTREAM_LOGIN_REQUIRED'].includes(error.code));
      assert.equal(subscriptionCalls, 1); assert.equal(noteCalls, 1);
    });
  }
});

test('subscription retrieval is no-store, bounded, and does not redirect its token to another origin', async () => {
  const requests = [];
  const text = await fetchFreshSubscription(SUBSCRIPTION, { fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options }); return requests.length === 1
      ? new Response('', { status: 302, headers: { Location: '/fresh?token=private-test-token' } }) : new Response('proxies: []');
  } });
  assert.equal(text, 'proxies: []'); assert.equal(requests.length, 2);
  assert.equal(requests[0].options.cache, 'no-store'); assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[0].options.headers.Authorization, undefined); assert.equal(requests[0].options.headers.Cookie, undefined);
  let calls = 0;
  await assert.rejects(fetchFreshSubscription(SUBSCRIPTION, { fetchImpl: async () => { calls++; return new Response('',
    { status: 302, headers: { Location: 'https://other.example.com/?token=private-test-token' } }); } }), { code: 'SUBSCRIPTION_REDIRECT_REJECTED' });
  assert.equal(calls, 1);
  await assert.rejects(fetchFreshSubscription(SUBSCRIPTION, { fetchImpl: async () => new Response('x',
    { headers: { 'Content-Length': String(LIMITS.subscriptionBytes + 1) } }) }), { code: 'UPSTREAM_BODY_TOO_LARGE' });
});

test('bounded reads enforce actual streamed bytes even when length is missing or false', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(3)); }, cancel() { cancelled++; } });
  await assert.rejects(readBounded(new Response(body, { headers: { 'Content-Length': '1' } }), 6), { code: 'UPSTREAM_BODY_TOO_LARGE' });
  assert.equal(cancelled, 1);
});

test('note redirects preserve the exact note identity and reject outside, private and challenge targets before fetching', async t => {
  for (const [location, code] of [
    ['https://evil.example.com/steal', 'UPSTREAM_REDIRECT_REJECTED'],
    ['https://127.0.0.1/steal', 'UPSTREAM_REDIRECT_REJECTED'],
    [NOTE.replace('2500100a', '2500100b'), 'UPSTREAM_NOTE_MISMATCH'],
    ['https://www.xiaohongshu.com/website-login/error', 'UPSTREAM_VERIFICATION_REQUIRED'],
  ]) await t.test(code, async () => {
    let calls = 0;
    await assert.rejects(fetchNote(NOTE, {}, { transport: async () => { calls++; return result(302, { Location: location }); } }), { code });
    assert.equal(calls, 1);
  });
  let calls = 0;
  await assert.rejects(fetchNote(NOTE, {}, { transport: async () => { calls++; return result(302, { Location: NOTE }); } }), { code: 'UPSTREAM_REDIRECT_REJECTED' });
  assert.equal(calls, 6);
  calls = 0;
  await assert.rejects(fetchNote('https://xhslink.com/a/fixture', {}, { transport: async () => {
    calls++; return result(302, { Location: calls === 1 ? NOTE : NOTE.replace('2500100a', '2500100b') });
  } }), { code: 'UPSTREAM_NOTE_MISMATCH' });
  assert.equal(calls, 2);
});

test('media ranges are bounded and exact; response projects only safe headers', async () => {
  const response = await fetchMedia(STREAM, {}, { range: 'bytes=2-6', accept: 'video/*', transport: async (_node, _url, options) => {
    assert.equal(options.maxBytes, 5); assert.deepEqual(options.headers, { Accept: 'video/*', Referer: 'https://www.xiaohongshu.com/', Range: 'bytes=2-6' });
    return result(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-6/100', 'Set-Cookie': 'private-cookie', Server: 'private-server' }, 'video');
  } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 2-6/100');
  assert.equal(response.headers.get('Content-Length'), '5'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Set-Cookie'), null); assert.equal(response.headers.get('Server'), null);
  for (const [upstream, code] of [
    [result(200, { 'Content-Type': 'video/mp4' }, 'video'), 'UPSTREAM_RANGE_REQUIRED'],
    [result(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 3-7/100' }, 'video'), 'UPSTREAM_RANGE_REJECTED'],
    [result(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-6/6' }, 'video'), 'UPSTREAM_RANGE_REJECTED'],
    [result(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-6/100' }, 'toolong'), 'UPSTREAM_BODY_TOO_LARGE'],
    [result(206, { 'Content-Type': 'text/html', 'Content-Range': 'bytes 2-6/100' }, 'video'), 'UPSTREAM_MEDIA_CONTENT_REJECTED'],
    [result(416), 'UPSTREAM_RANGE_UNAVAILABLE'],
  ]) await assert.rejects(fetchMedia(STREAM, {}, { range: 'bytes=2-6', transport: async () => upstream }), { code });
});

test('media member paths, unsafe ranges, unknown hosts and redirected member paths fail before they are fetched', async () => {
  const { service, calls } = harness();
  for (const input of [
    { url: 'https://sns-video-bd.xhscdn.com/spectrum/member' },
    { url: 'https://sns-video-bd.xhscdn.com/%73pectrum%2fmember' },
    { url: 'https://sns-video-bd.xhscdn.com/original/member.mp4' },
    { url: 'https://evil.example.com/video.mp4' },
    { url: MEDIA, range: 'bytes=0-' }, { url: MEDIA, range: 'bytes=0-3500000' },
    { url: MEDIA, range: 'bytes=0-1,5-6' }, { url: MEDIA, accept: 'video/*\r\nCookie: private' },
  ]) assert.throws(() => service.media({ subscriptionUrl: SUBSCRIPTION, ...input }));
  assert.equal(calls.subscriptions.length, 0);
  let redirects = 0;
  await assert.rejects(fetchMedia(MEDIA, {}, { transport: async () => { redirects++; return result(302,
    { Location: 'https://sns-video-bd.xhscdn.com/spectrum/member' }); } }), { code: 'MEDIA_PATH_REJECTED' });
  assert.equal(redirects, 1);
  await assert.rejects(fetchMedia(MEDIA, {}, { transport: async () => result(200, { 'Content-Type': 'video/mp4' }, 'video') }),
    { code: 'MEDIA_PATH_REJECTED' });
});

test('a cancelled queued request never starts and queue overflow is bounded', async () => {
  const { service, calls } = harness();
  let release;
  const pendingWork = service.enqueue(() => new Promise(resolve => { release = resolve; }));
  const controllers = Array.from({ length: LIMITS.queue }, () => new AbortController());
  const queued = controllers.map(controller => service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION }, { signal: controller.signal }));
  await assert.rejects(service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION }), { code: 'PROXY_BUSY' });
  const rejections = queued.map(promise => assert.rejects(promise, { name: 'AbortError' }));
  controllers.forEach(controller => controller.abort()); await Promise.all(rejections);
  release('done'); assert.equal(await pendingWork, 'done');
  assert.equal(calls.subscriptions.length, 0);
});

test('one total operation abort cancels both active probes, stops later probes and releases the queued operation', async t => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController(); timeouts.push({ ms, controller }); return controller.signal;
  });
  let subscriptions = 0, noteCalls = 0;
  const activeProbes = [];
  const service = new FreeSubscriptionService({
    subscription: async () => { subscriptions++; return subscription([endpointNode(1), endpointNode(2), endpointNode(3)]); },
    transport: async (_node, url, options) => {
      if (url !== PROBE_URL) { noteCalls++; return htmlResult(); }
      if (subscriptions > 1) return result(204);
      activeProbes.push(options.signal);
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    },
  });
  const first = service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION });
  const checked = assert.rejects(first, { name: 'TimeoutError' });
  const queued = service.note({ url: NOTE, subscriptionUrl: SUBSCRIPTION });
  await new Promise(setImmediate);
  assert.equal(activeProbes.length, 2);
  assert.equal(timeouts[0].ms, 60_000);
  assert.deepEqual(timeouts.slice(1).map(timeout => timeout.ms), [ENDPOINT_PROBE_MS, ENDPOINT_PROBE_MS]);
  timeouts[0].controller.abort(new DOMException('private-timeout-detail', 'TimeoutError'));
  await checked;
  assert.ok(activeProbes.every(signal => signal.aborted)); assert.equal(activeProbes.length, 2);
  assert.equal((await queued).html, '<title>笔记</title>');
  assert.equal(subscriptions, 2); assert.equal(noteCalls, 1); assert.equal(service.active, false);
});

test('spectrum image cover downloads and safe image redirects succeed; video, audio and opaque MIME never become covers', async () => {
  const cover = 'https://ci.xiaohongshu.com/spectrum/fixture-cover';
  let calls = 0;
  const image = await fetchMedia(cover, {}, { transport: async (_node, url) => {
    calls++; assert.equal(url, cover); return result(200, { 'Content-Type': 'image/jpeg' }, 'jpeg');
  } });
  assert.equal(calls, 1); assert.equal(image.status, 200); assert.equal(image.body.length, 4);
  assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
  calls = 0;
  const redirected = await fetchMedia(MEDIA, {}, { transport: async () => {
    calls++; return calls === 1 ? result(302, { Location: cover }) : result(200, { 'Content-Type': 'image/webp' }, 'webp');
  } });
  assert.equal(calls, 2); assert.equal(redirected.headers.get('Content-Type'), 'image/webp');
  for (const path of ['/spectrum/fixture-cover', '/%73pectrum%2ffixture-cover', '/stream/spectrum/fixture-cover']) {
    for (const type of ['video/mp4', 'audio/mp4', 'application/octet-stream']) {
      await assert.rejects(fetchMedia(`https://ci.xiaohongshu.com${path}`, {}, { transport: async () => result(200,
        { 'Content-Type': type }, 'not-an-image') }), { code: type.startsWith('application/') ? 'UPSTREAM_MEDIA_CONTENT_REJECTED' : 'MEDIA_PATH_REJECTED' });
    }
  }
  calls = 0;
  await assert.rejects(fetchMedia(cover, {}, { transport: async () => {
    calls++; return result(302, { Location: 'https://sns-video-bd.xhscdn.com/spectrum/member.mp4' });
  } }), { code: 'MEDIA_PATH_REJECTED' });
  assert.equal(calls, 1);
});


test('note requests match the existing client UA, accept and language without authentication or changing media/probe headers', async () => {
  const source = await readFile(new URL('../../../lib/xhs.js', import.meta.url), 'utf8');
  const literal = source.match(/const PAGE_HEADERS = (\{[\s\S]*?\n\});/)[1];
  const client = runInNewContext(`(${literal})`);
  const expected = Object.fromEntries(['user-agent', 'accept', 'accept-language'].map(key => [key, client[key]]));
  let calls = 0;
  await fetchNote(NOTE, {}, { transport: async (_node, _url, options) => {
    calls++; assert.deepEqual(options.headers, expected);
    assert.equal(new Headers(options.headers).get('cookie'), null);
    assert.equal(new Headers(options.headers).get('authorization'), null);
    return calls === 1 ? result(302, { Location: NOTE }) : htmlResult();
  } });
  assert.equal(calls, 2);
  await probeEndpoints([{ id: 'fixture' }], { transport: async (_node, _url, options) => {
    assert.deepEqual(options.headers, { Accept: '*/*' }); return result(204);
  } });
  await fetchMedia(MEDIA, {}, { transport: async (_node, _url, options) => {
    assert.deepEqual(options.headers, { Accept: '*/*', Referer: 'https://www.xiaohongshu.com/' });
    return result(200, { 'Content-Type': 'image/jpeg' }, 'image');
  } });
});


test('media transport allows 30 seconds while note, probe and total operation budgets stay independent', async () => {
  await fetchMedia(MEDIA, {}, { transport: async (_node, _url, options) => {
    assert.equal(options.timeoutMs, 30_000);
    return result(200, { 'Content-Type': 'image/jpeg' }, 'image');
  } });
  await fetchNote(NOTE, {}, { transport: async (_node, _url, options) => {
    assert.equal(options.timeoutMs, undefined);
    return htmlResult();
  } });
  await probeEndpoints([{ id: 'fixture' }], { transport: async (_node, _url, options) => {
    assert.equal(options.timeoutMs, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return result(204);
  } });
  assert.equal(ENDPOINT_PROBE_MS, 6_000);
  assert.equal(LIMITS.operationMs, 60_000);
});
