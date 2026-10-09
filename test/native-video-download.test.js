import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeVideoDownload } from '../desktop/native-video-download.js';
import { createMemberVideoHandler, createMemberVideoTicketService } from '../lib/member-video-handler.js';
import { createProtocolHandler } from '../desktop/protocol.js';
import { mp4Fixture } from './fixtures/mp4.js';

const stream = 'https://sns-video-bd.xhscdn.com/stream/play.mp4';
const original = 'https://sns-video-bd.xhscdn.com/original.mp4';
const input = (url = stream, extra = {}) => ({ requestId: 'download-1', title: '视频标题', video: { url }, ...extra });
const payload = mp4Fixture();
const response = (body = payload) => new Response(body, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) } });

async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-video-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, '视频.mp4'), fetched = [], features = [], progress = [], dialogs = [];
  const downloader = new NativeVideoDownload({
    showSaveDialog: async value => { dialogs.push(value); return { canceled: false, filePath: target }; },
    fetchImpl: async url => { fetched.push(url); return response(); },
    authorize: async feature => { features.push(feature); }, onProgress: value => progress.push(value), ...options,
  });
  return { directory, target, fetched, features, progress, dialogs, downloader };
}

test('native single videos stream directly to an OS-approved file with no browser proxy or Blob', async t => {
  const f = await fixture(t);
  const result = await f.downloader.save(input(stream, { filename: '../unsafe\\name.mp4', outputPath: '/unapproved.mp4' }));
  assert.equal(result.ok, true);
  assert.equal(result.path, f.target);
  assert.equal(result.bytes, payload.length);
  assert.equal(result.mediaTracks.hasVideo, true);
  assert.equal(result.mediaTracks.hasAudio, true);
  assert.deepEqual(await fs.readFile(f.target), payload);
  assert.deepEqual(f.fetched, [stream]);
  assert.deepEqual(f.features, ['single-download', 'single-download']);
  assert.equal(path.basename(f.dialogs[0].defaultPath), f.dialogs[0].defaultPath);
  assert.ok(f.progress.every(item => item.requestId === 'download-1'));
  assert.ok(f.progress.some(item => item.phase === 'saved' && item.loadedBytes === payload.length));
  assert.deepEqual(await fs.readdir(f.directory), ['视频.mp4']);
});

test('native invalid inputs and cancelled dialogs return typed outcomes without network access', async t => {
  const f = await fixture(t, { showSaveDialog: async () => ({ canceled: true }) });
  for (const value of [input('https://attacker.example/video.mp4'), input('http://sns-video-bd.xhscdn.com/stream/a.mp4'),
    input('/api/video?url=anything'), { ...input(), requestId: '../escape' }, input(stream, { video: { url: stream, backupUrls: 'invalid' } })]) {
    const result = await f.downloader.save(value);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VIDEO_INPUT_INVALID');
    assert.equal(result.error.status, 400);
  }
  assert.deepEqual(await f.downloader.save(input()), { ok: true, cancelled: true });
  assert.deepEqual(f.fetched, []);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('native cancellation interrupts a stream, cleans staging, and retains the existing target', async t => {
  let entered, aborted = false;
  const reading = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(payload.subarray(0, 32));
      signal.addEventListener('abort', () => { aborted = true; controller.error(signal.reason); }, { once: true });
      entered();
    },
  }), { headers: { 'Content-Type': 'video/mp4' } }) });
  await fs.writeFile(f.target, 'previous download');
  const saving = f.downloader.save(input());
  await reading;
  assert.deepEqual(f.downloader.cancel('download-1'), { ok: true, cancelled: true });
  const result = await saving;
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, true);
  assert.equal(aborted, true);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous download');
  assert.deepEqual(await fs.readdir(f.directory), ['视频.mp4']);
});

test('native fallback keeps validating audio and never saves an invalid first rendition', async t => {
  const urls = [];
  const fallback = 'https://sns-video-bd.xhscdn.com/stream/audible.mp4';
  const f = await fixture(t, { fetchImpl: async url => { urls.push(url); return response(mp4Fixture({ audio: url === fallback })); } });
  assert.equal((await f.downloader.save(input(stream, { video: { url: stream, backupUrls: [fallback] } }))).ok, true);
  assert.deepEqual(urls, [stream, fallback]);
  assert.deepEqual(await fs.readFile(f.target), payload);
  const live = await f.downloader.save({ ...input(), requestId: 'silent-live', requireAudio: false });
  assert.equal(live.ok, true);
  assert.equal(live.mediaTracks.hasAudio, false);
});

test('protocol-issued encrypted member tickets work only in the shared trusted native service', async t => {
  let userId = 'member-a', allowed = true, time = 1000;
  const authorize = async () => {
    if (!allowed) throw Object.assign(new Error('会员已到期'), { code: 'MEMBERSHIP_EXPIRED', status: 403 });
    return { userId };
  };
  const ticketService = createMemberVideoTicketService({ authorize, now: () => time });
  const memberHandler = createMemberVideoHandler({ ticketService, resolve: async () => ({ originalVideos: [{ url: original }] }) });
  const protocol = createProtocolHandler({ rootDirectory: process.cwd(), memberVideoTicketService: ticketService,
    nodeHandlers: { '/api/member_video': memberHandler } });
  const parsed = await protocol(new Request('xhs-app://local/api/member_video', { method: 'POST', body: JSON.stringify({ text: 'https://www.xiaohongshu.com/explore/1234567890abcdef12345678' }) }));
  const data = await parsed.json(), ticket = data.videos[0].url;
  assert.doesNotMatch(JSON.stringify(data), /original\.mp4|member-a/);
  const f = await fixture(t, { ticketService });
  const value = input(ticket, { video: { url: ticket, requiresMembership: true } });
  assert.equal((await f.downloader.save(value)).ok, true);
  assert.deepEqual(f.fetched, [original]);
  await fs.unlink(f.target);
  userId = 'member-b';
  assert.equal((await f.downloader.save(value)).error.status, 403);
  userId = 'member-a'; allowed = false;
  assert.equal((await f.downloader.save(value)).error.code, 'MEMBERSHIP_EXPIRED');
  allowed = true; time += 30 * 60_000;
  assert.equal((await f.downloader.save(value)).error.status, 403);
  assert.equal(f.fetched.length, 1);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('member account switching and revocation during native streaming block final publication', async t => {
  for (const change of ['switch', 'revoke']) await t.test(change, async t => {
    let userId = 'member-a', allowed = true, time = 1000;
    const ticketService = createMemberVideoTicketService({ now: () => time, authorize: async () => {
      if (!allowed) throw Object.assign(new Error('会员已撤销'), { code: 'MEMBERSHIP_REVOKED', status: 403 });
      return { userId };
    } });
    const session = await ticketService.session();
    const ticket = session.seal(original, session.expiresAt());
    const f = await fixture(t, { ticketService, fetchImpl: async () => {
      if (change === 'switch') userId = 'member-b';
      if (change === 'revoke') allowed = false;
      return response();
    } });
    await fs.writeFile(f.target, 'existing');
    const result = await f.downloader.save(input(ticket));
    assert.equal(result.ok, false);
    assert.equal(result.error.status, change === 'switch' ? 401 : 403);
    if (change === 'revoke') assert.equal(result.error.code, 'MEMBERSHIP_REVOKED');
    assert.equal(await fs.readFile(f.target, 'utf8'), 'existing');
    assert.deepEqual(await fs.readdir(f.directory), ['视频.mp4']);
  });
});

test('an admitted member stream may finish after its ticket expires while live membership stays valid', async t => {
  let time = 1000;
  const ticketService = createMemberVideoTicketService({ now: () => time, authorize: async () => ({ userId: 'member-a' }) });
  const session = await ticketService.session();
  const ticket = session.seal(original, session.expiresAt());
  const f = await fixture(t, { ticketService, fetchImpl: async () => { time += 2 * 60 * 60_000; return response(); } });
  assert.equal((await f.downloader.save(input(ticket))).ok, true);
  assert.deepEqual(await fs.readFile(f.target), payload);
  assert.equal((await f.downloader.save(input(ticket))).error.status, 403, 'A fresh use of the expired ticket is rejected');
});

test('native publishes to the exact OS-selected name and atomically replaces an approved regular file', async t => {
  const f = await fixture(t);
  const chosen = path.join(f.directory, 'video-without-extension');
  const adjacent = `${chosen}.mp4`;
  await fs.writeFile(chosen, 'replace me');
  await fs.writeFile(adjacent, 'untouched');
  f.downloader.showSaveDialog = async () => ({ canceled: false, filePath: chosen });
  const result = await f.downloader.save(input());
  assert.equal(result.path, chosen);
  assert.deepEqual(await fs.readFile(chosen), payload);
  assert.equal(await fs.readFile(adjacent, 'utf8'), 'untouched');
});

test('native shutdown aborts pending streams and dialogs and waits for stage cleanup', async t => {
  const f = await fixture(t, { showSaveDialog: () => new Promise(() => {}) });
  const waiting = f.downloader.save(input());
  await new Promise(resolve => setImmediate(resolve));
  await f.downloader.shutdown();
  assert.deepEqual(await waiting, { ok: true, cancelled: true });
  assert.equal(f.downloader.requests.size, 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal((await f.downloader.save(input())).error.code, 'DOWNLOAD_SHUTDOWN');
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  const active = await fixture(t, { fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(payload.subarray(0, 32));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      entered();
    },
  }), { headers: { 'Content-Type': 'video/mp4' } }) });
  await fs.writeFile(active.target, 'previous completed video');
  let settled = false;
  const saving = active.downloader.save(input()).then(result => { settled = true; return result; });
  await reading;
  await active.downloader.shutdown();
  assert.equal(settled, true, 'Shutdown waits until the stalled transfer has settled');
  assert.deepEqual(await saving, { ok: true, cancelled: true });
  assert.equal(await fs.readFile(active.target, 'utf8'), 'previous completed video');
  assert.deepEqual(await fs.readdir(active.directory), ['视频.mp4'], 'Shutdown removes every staging directory');
});

test('native raw originals cannot use free authorization, including a playback redirect to an original', async t => {
  const features = [], fetched = [];
  const ticketService = createMemberVideoTicketService({ authorize: async () => {
    features.push('watermark-free-video');
    throw Object.assign(new Error('请先开通会员'), { code: 'MEMBERSHIP_REQUIRED', status: 403 });
  } });
  const f = await fixture(t, { ticketService, fetchImpl: async url => {
    fetched.push(url); return new Response(null, { status: 302, headers: { location: original } });
  } });
  assert.equal((await f.downloader.save(input(original))).error.code, 'MEMBERSHIP_REQUIRED');
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(fetched, []);
  assert.equal((await f.downloader.save(input())).error.code, 'MEMBERSHIP_REQUIRED');
  assert.deepEqual(fetched, [stream]);
  assert.deepEqual(features, ['watermark-free-video', 'watermark-free-video']);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('native output refuses symlinks and hard links chosen as the save target', async t => {
  for (const link of ['symbolic', 'hard']) await t.test(link, async t => {
    const f = await fixture(t);
    const other = path.join(f.directory, 'private.txt');
    await fs.writeFile(other, 'keep');
    if (link === 'symbolic') await fs.symlink(other, f.target); else await fs.link(other, f.target);
    const result = await f.downloader.save(input());
    assert.equal(result.ok, false);
    assert.deepEqual(f.fetched, []);
    assert.equal(await fs.readFile(other, 'utf8'), 'keep');
  });
});
