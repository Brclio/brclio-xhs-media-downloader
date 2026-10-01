import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberVideoHandler } from '../lib/member-video-handler.js';
import { createMediaAuthorization } from '../server/media-authorization.js';
import { createWorker } from '../cloudflare/worker.js';
import videoHandler from '../api/video.js';
import { invokeHandler } from '../cloudflare/http-adapter.js';
import { BROWSER_COOKIE } from '../api/account.js';

const original = 'https://sns-video-bd.xhscdn.com/spectrum/original-source';
const note = 'https://www.xiaohongshu.com/explore/abcdef1234567890abcdef12';
const post = () => new Request('https://xhs.test/api/member_video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: note }) });

test('member originals use encrypted account-bound tickets with live checks on metadata and chunks', async () => {
  let userId = 'member-a', allowed = true, time = 1000, resolves = 0, checks = 0, downloads = 0;
  const handler = createMemberVideoHandler({ secret: 'x'.repeat(40), now: () => time,
    authorize: async () => { checks++; if (!allowed) throw Object.assign(new Error('会员已到期'), { status: 403 }); return { userId }; },
    resolve: async () => { resolves++; return { title: '测试', originalVideos: [{ url: original, source: 'origin-video-key', sourceWatermark: 'unknown' }] }; },
    video: async (req, res) => { downloads++; assert.equal(req.query.url, original); return res.status(200).json({ success: true, action: req.query.action }); },
  });
  allowed = false;
  assert.equal((await invokeHandler(handler, post())).status, 403);
  assert.equal(resolves, 0);
  allowed = true;
  const response = await invokeHandler(handler, post()), data = await response.json();
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(data.videos[0].sourceWatermark, 'unknown');
  assert.equal(JSON.stringify(data).includes(original), false);
  assert.equal(JSON.stringify(data).includes('member-a'), false);
  const ticket = data.videos[0].url.slice('member-video:'.length);
  const get = (action = 'meta', token = ticket) => new Request(`https://xhs.test/api/member_video?action=${action}&ticket=${token}`);
  assert.equal((await invokeHandler(handler, get())).status, 200);
  assert.equal((await invokeHandler(handler, get('chunk'))).status, 200);
  allowed = false;
  assert.equal((await invokeHandler(handler, get('chunk'))).status, 403);
  allowed = true; userId = 'member-b';
  assert.equal((await invokeHandler(handler, get())).status, 403);
  userId = 'member-a';
  assert.equal((await invokeHandler(handler, get('meta', ticket.slice(0, -3) + 'abc'))).status, 403);
  time += 30 * 60_000;
  assert.equal((await invokeHandler(handler, get())).status, 403);
  assert.equal(downloads, 2);
  assert.equal(checks, 8);
});

test('raw original CDN URLs and playback redirects cannot bypass the public video endpoint', async t => {
  const previousFetch = globalThis.fetch, previousError = console.error;
  t.after(() => { globalThis.fetch = previousFetch; console.error = previousError; });
  console.error = () => {};
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return new Response(null, { status: 302, headers: { location: original } }); };
  const request = url => new Request(`https://xhs.test/api/video?action=meta&url=${encodeURIComponent(url)}`);
  assert.equal((await invokeHandler(videoHandler, request(original))).status, 403);
  assert.equal(fetched, 0);
  assert.equal((await invokeHandler(videoHandler, request('https://sns-video-bd.xhscdn.com/stream/play.mp4'))).status, 403);
  assert.equal(fetched, 1);
});

test('member authorization reuses browser cookie and trusted account service, never the submitted entitlement', async () => {
  let called = 0;
  const authorize = createMediaAuthorization({ siteOrigin: 'https://xhs.test', accountHandler: async (req, res) => {
    called++; const body = JSON.parse(req.body);
    assert.equal(body.input.client, 'browser'); assert.equal(body.input.feature, 'watermark-free-video');
    assert.equal(req.headers.origin, 'https://xhs.test'); assert.equal(req.headers.authorization, undefined);
    res.status(200).json({ authorized: true, account: { user: { id: 'member' } } });
  } });
  await assert.rejects(authorize({ headers: {} }), { statusCode: 401 });
  assert.equal(called, 0);
  assert.deepEqual(await authorize({ headers: { cookie: `${BROWSER_COOKIE}=${'a'.repeat(40)}` }, body: { membership: true } }), { userId: 'member' });
});

test('Cloudflare member endpoint fails closed before fetching original media for guests', async () => {
  const worker = createWorker();
  const response = await worker.fetch(post(), { AUTH_SITE_ORIGIN: 'https://xhs.test', AUTH_SECRET_PEPPER: 'x'.repeat(40) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).success, false);
});
