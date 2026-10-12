import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountClient } from '../desktop/account-client.js';
import { NativeVideoDownload } from '../desktop/native-video-download.js';
import { createMemberVideoHandler, createMemberVideoTicketService } from '../lib/member-video-handler.js';
import { issueEntitlement } from '../lib/entitlement.js';
import { invokeHandler } from '../cloudflare/http-adapter.js';
import { mp4Fixture } from './fixtures/mp4.js';

const ORIGINAL = 'https://sns-video-bd.xhscdn.com/original.mp4';
const NOTE = 'https://www.xiaohongshu.com/explore/abcdef1234567890abcdef12';
const START = Date.parse('2026-10-12T00:00:00Z');
const VIDEO = mp4Fixture();
const post = () => new Request('https://xhs.test/api/member_video', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: NOTE })
});
const chunk = ticket => new Request(`https://xhs.test/api/member_video?action=chunk&ticket=${encodeURIComponent(ticket.replace(/^member-video:/, ''))}`);

async function accountFixture() {
  const signing = generateKeyPairSync('ed25519'), device = generateKeyPairSync('ed25519');
  let stored = { version: 1, token: 'desktop-member-fixture-session-0000000000',
    privateKey: device.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: device.publicKey.export({ type: 'spki', format: 'pem' }), pendingLogoutTokens: [] };
  let clock = START, revoked = false;
  const expiresAt = START + 60_000, calls = [];
  const account = () => ({ user: { id: 'fixture-member' }, device: { id: 'fixture-device', status: revoked ? 'revoked' : 'authorized' },
    membership: { type: 'duration', active: clock < expiresAt, expiresAt: new Date(expiresAt).toISOString() }, serverTime: new Date(clock).toISOString() });
  const client = new AccountClient({ endpoint: 'https://accounts.example.test/api/account',
    store: { load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); } },
    now: () => clock, monotonicNow: () => clock - START, sleep: async () => {}, entitlementPublicKeys: { fixture: signing.publicKey },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body), token = init.headers.Authorization?.replace(/^Bearer /, '') || '';
      const proof = `${request.action}\n${request.proof.timestamp}\n${request.proof.nonce}\n${JSON.stringify(request.input)}\n${token}`;
      assert.equal(verify(null, Buffer.from(proof), device.publicKey, Buffer.from(request.proof.signature, 'base64')), true);
      calls.push(request.action);
      const serverTime = new Date(clock).toISOString();
      const fail = code => Response.json({ ok: false, error: { code, message: code }, serverTime }, { status: 403 });
      if (request.action === 'authorize') {
        if (revoked) return fail('DEVICE_REVOKED');
        if (clock >= expiresAt) return fail('MEMBERSHIP_EXPIRED');
        return Response.json({ ok: true, authorized: true, account: account(), serverTime,
          entitlement: issueEntitlement({ privateKey: signing.privateKey, keyId: 'fixture',
            token, publicKey: stored.publicKey, userId: 'fixture-member', deviceId: 'fixture-device',
            feature: request.input.feature, now: clock, membershipExpiresAt: expiresAt, requestNonce: request.proof.nonce }) });
      }
      if (request.action === 'logout') return Response.json({ ok: true, revoked: true, serverTime });
      assert.equal(request.action, 'me');
      return Response.json({ ok: true, account: account(), serverTime });
    }
  });
  await client.initialize(); await client.refresh();
  const ticketService = createMemberVideoTicketService({ now: () => clock, secret: 'fixture-ticket-secret'.repeat(3),
    authorize: (_req, options) => client.authorize('watermark-free-video', options) });
  return { client, ticketService, calls, now: () => clock,
    remoteCalls: () => calls.filter(action => action === 'authorize').length,
    async invalidate(change) {
      if (change === 'expiry') clock = expiresAt + 1;
      if (change === 'logout') await client.logout();
      if (change === 'device') {
        revoked = true;
        await assert.rejects(client.authorize('watermark-free-video', { forceRemote: true }), { code: 'DEVICE_REVOKED' });
      }
    }
  };
}

test('desktop member parsing checks remotely once and forty buffered chunks recheck signed grants locally', async () => {
  const f = await accountFixture();
  let fetched = 0;
  const handler = createMemberVideoHandler({ ticketService: f.ticketService,
    resolve: async () => ({ title: 'Fixture video', originalVideos: [{ url: ORIGINAL }] }),
    video: async (_req, res) => { fetched++; res.setHeader('content-type', 'video/mp4'); return res.status(200).send(VIDEO); }
  });
  const parsed = await invokeHandler(handler, post());
  assert.equal(parsed.status, 200);
  const ticket = (await parsed.json()).videos[0].url;
  assert.equal(f.remoteCalls(), 1, 'The parse trigger performs one fresh remote check');
  for (let index = 0; index < 40; index++) {
    const response = await invokeHandler(handler, chunk(ticket));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), VIDEO);
  }
  assert.equal(fetched, 40);
  assert.equal(f.remoteCalls(), 1, 'Neither chunk admission nor post-buffer recheck reaches the account backend');
  assert.equal((await invokeHandler(handler, post())).status, 200);
  assert.equal(f.remoteCalls(), 2, 'A new parse trigger refreshes the remote grant again');
});

test('desktop buffered member chunks withhold bytes and video headers when authorization changes during fetch', async t => {
  for (const change of ['expiry', 'logout', 'device']) await t.test(change, async () => {
    const f = await accountFixture();
    let fetched = 0;
    const handler = createMemberVideoHandler({ ticketService: f.ticketService,
      resolve: async () => ({ originalVideos: [{ url: ORIGINAL }] }),
      video: async (_req, res) => {
        fetched++;
        res.setHeader('content-type', 'video/mp4'); res.setHeader('content-length', String(VIDEO.length));
        res.setHeader('content-range', `bytes 0-${VIDEO.length - 1}/${VIDEO.length}`);
        await f.invalidate(change);
        return res.status(200).send(VIDEO);
      }
    });
    const ticket = (await (await invokeHandler(handler, post())).json()).videos[0].url;
    const response = await invokeHandler(handler, chunk(ticket));
    assert.equal(response.status, change === 'logout' ? 401 : 403);
    assert.equal(fetched, 1);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('content-range'), null);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await response.json()).success, false);
    assert.equal((await invokeHandler(handler, chunk(ticket))).status, change === 'logout' ? 401 : 403);
    assert.equal(fetched, 1, 'The next chunk is denied before fetching media');
  });
});

async function nativeFixture(t, options = {}) {
  const f = await accountFixture();
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-member-grant-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'video.mp4');
  let fetched = 0;
  const downloader = new NativeVideoDownload({ ticketService: f.ticketService,
    showSaveDialog: async () => ({ canceled: false, filePath: target }),
    authorize: (feature, input) => f.client.authorize(feature, input),
    checkAuthorization: feature => f.client.checkLocalAuthorization(feature),
    fetchImpl: async () => {
      fetched++; await options.onFetch?.(f);
      return new Response(VIDEO, { headers: { 'content-type': 'video/mp4', 'content-length': String(VIDEO.length) } });
    }
  });
  return { ...f, downloader, directory, target, fetched: () => fetched,
    save: () => downloader.save({ requestId: 'member-fixture', title: 'Fixture video', video: { url: ORIGINAL, requiresMembership: true } }) };
}

test('native original video starts with one fresh grant and publishes after local rechecks', async t => {
  const f = await nativeFixture(t);
  const result = await f.save();
  assert.equal(result.ok, true);
  assert.equal(f.remoteCalls(), 1, 'Native session creation checks remotely once; streaming and publication checks stay local');
  assert.equal(f.fetched(), 1);
  assert.deepEqual(await fs.readFile(f.target), VIDEO);
  assert.deepEqual(await fs.readdir(f.directory), ['video.mp4']);
});

test('native original video retains the existing file when grant expiry, logout or device revocation happens during streaming', async t => {
  for (const change of ['expiry', 'logout', 'device']) await t.test(change, async t => {
    const f = await nativeFixture(t, { onFetch: client => client.invalidate(change) });
    await fs.writeFile(f.target, 'previous complete video');
    const result = await f.save();
    assert.equal(result.ok, false);
    assert.equal(result.error.status, change === 'logout' ? 401 : 403);
    assert.equal(f.fetched(), 1);
    assert.equal(await fs.readFile(f.target, 'utf8'), 'previous complete video');
    assert.deepEqual(await fs.readdir(f.directory), ['video.mp4'], 'Unpublished staging files are removed');
  });
});

test('native original publication rejects authorization changes during the final asynchronous target check', async t => {
  for (const change of ['expiry', 'logout', 'device']) await t.test(change, async t => {
    const f = await nativeFixture(t);
    await fs.writeFile(f.target, 'previous complete video');
    const originalLstat = fs.lstat;
    let targetChecks = 0, callsAfterInvalidation;
    t.mock.method(fs, 'lstat', async function (file, ...args) {
      const result = await originalLstat.call(this, file, ...args);
      if (file === f.target && ++targetChecks === 2) {
        await f.invalidate(change);
        callsAfterInvalidation = f.remoteCalls();
      }
      return result;
    });
    const result = await f.save();
    assert.equal(targetChecks, 2, 'Invalidation occurs after streaming, in the final target validation');
    assert.equal(result.ok, false);
    assert.equal(result.error.status, change === 'logout' ? 401 : 403);
    assert.equal(f.remoteCalls(), callsAfterInvalidation, 'The final signed authorization guard never contacts the backend');
    assert.equal(await fs.readFile(f.target, 'utf8'), 'previous complete video');
    assert.deepEqual(await fs.readdir(f.directory), ['video.mp4'], 'Unpublished staging files are removed');
  });
});

test('native original publication checks the signed grant synchronously after its final awaited session check', async t => {
  const f = await nativeFixture(t);
  await fs.writeFile(f.target, 'previous complete video');
  const originalLstat = fs.lstat, originalSession = f.ticketService.session;
  let targetChecks = 0;
  t.mock.method(fs, 'lstat', async function (file, ...args) {
    const result = await originalLstat.call(this, file, ...args);
    if (file === f.target) targetChecks++;
    return result;
  });
  t.mock.method(f.ticketService, 'session', async function (...args) {
    const session = await originalSession.apply(this, args), originalRecheck = session.recheck;
    session.recheck = async function (...values) {
      await originalRecheck.apply(this, values);
      if (targetChecks === 2) await f.invalidate('expiry');
    };
    return session;
  });
  const result = await f.save();
  assert.equal(targetChecks, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 403);
  assert.equal(f.remoteCalls(), 1, 'Expiry at commit is rejected locally without renewing the grant');
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous complete video');
  assert.deepEqual(await fs.readdir(f.directory), ['video.mp4']);
});
