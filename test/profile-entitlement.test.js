import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AccountClient } from '../desktop/account-client.js';
import { ProfileManager } from '../desktop/profile-manager.js';
import { issueEntitlement, ENTITLEMENT_SYNC_INTERVAL_MS } from '../lib/entitlement.js';

const PROFILE = 'https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c';
const START = Date.parse('2026-10-12T00:00:00Z');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 4, 5, 6, 0xff, 0xd9]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < until, 'Expected background authorization transition did not arrive');
    await wait(1);
  }
}

// Real signing, client authorization, queue persistence and media writes; only
// the account HTTP transport, XHS page extraction and clock are simulated.
async function fixture(t, { notes = 3, images = 2, expiresAfter = 86_400_000, onSaved, onSleep,
  managerOptions = {} } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-entitlement-flow-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'downloads');
  await fs.mkdir(directory);
  const signing = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  let savedCredentials = {
    version: 1, privateKey: device.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: device.publicKey.export({ type: 'spki', format: 'pem' }),
    stableIdHash: 'a'.repeat(64), token: 'integration-fixture-session-000000000000', pendingLogoutTokens: []
  };
  let clock = START, membershipExpiresAt = START + expiresAfter, mode = 'healthy', saved = 0;
  const calls = [], media = [], diagnostics = [];
  const account = () => ({ user: { id: 'fixture-user', email: 'fixture@example.test', role: 'user' },
    device: { id: 'fixture-device', status: mode === 'revoked' ? 'revoked' : 'authorized' },
    membership: { type: 'duration', active: clock < membershipExpiresAt, expiresAt: new Date(membershipExpiresAt).toISOString() },
    serverTime: new Date(clock).toISOString() });
  const client = new AccountClient({
    store: { load: async () => structuredClone(savedCredentials), save: async next => { savedCredentials = structuredClone(next); } },
    endpoint: 'https://accounts.example.test/api/account', now: () => clock, monotonicNow: () => clock - START,
    sleep: async () => {}, entitlementPublicKeys: { fixture: signing.publicKey },
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      const token = init.headers.Authorization?.replace(/^Bearer /, '') || '';
      assert.equal(token, savedCredentials.token);
      const proof = `${request.action}\n${request.proof.timestamp}\n${request.proof.nonce}\n${JSON.stringify(request.input)}\n${token}`;
      assert.equal(verify(null, Buffer.from(proof), device.publicKey, Buffer.from(request.proof.signature, 'base64')), true);
      calls.push({ action: request.action, feature: request.input.feature, at: clock, mode });
      const serverTime = new Date(clock).toISOString();
      const fail = (code, status) => Response.json({ ok: false, error: { code, message: code }, serverTime }, { status });
      if (request.action === 'authorize') {
        if (mode === 'offline') throw new Error('injected transport failure');
        if (mode === 'storage-down') return fail('STORAGE_UNAVAILABLE', 503);
        if (mode === 'revoked') return fail('DEVICE_REVOKED', 403);
        if (clock >= membershipExpiresAt) return fail('MEMBERSHIP_EXPIRED', 403);
        return Response.json({ ok: true, authorized: true, account: account(), serverTime,
          entitlement: issueEntitlement({ privateKey: signing.privateKey, keyId: 'fixture', token,
            publicKey: savedCredentials.publicKey, userId: 'fixture-user', deviceId: 'fixture-device',
            feature: request.input.feature, membershipExpiresAt, now: clock, requestNonce: request.proof.nonce }) });
      }
      assert.equal(request.action, 'me');
      return Response.json({ ok: true, account: account(), serverTime });
    }
  });
  await client.initialize();
  await client.refresh();
  const descriptors = Array.from({ length: notes }, (_, index) => {
    const id = (index + 1).toString(16).padStart(24, '0');
    return { id, title: `Fixture ${index + 1}`, url: `https://www.xiaohongshu.com/explore/${id}` };
  });
  const stateDirectory = path.join(base, 'state');
  const f = {
    base, directory, stateDirectory, client, calls, media, diagnostics, descriptors,
    now: () => clock, advance: milliseconds => { clock += milliseconds; },
    setMode: next => { mode = next; }, renew: () => { membershipExpiresAt = clock + 86_400_000; mode = 'healthy'; },
    get saved() { return saved; }
  };
  const config = {
    stateDirectory, now: () => clock, random: () => 0,
    authorize: (feature, options) => client.authorize(feature, options),
    checkAuthorization: feature => client.checkLocalAuthorization(feature),
    authorizationIntervalMs: 5, localAuthorizationIntervalMs: 5,
    sleep: async (milliseconds, signal) => {
      signal?.throwIfAborted(); clock += milliseconds;
      await onSleep?.(f, signal);
      signal?.throwIfAborted();
    },
    browser: {
      async *discover() { yield { notes: descriptors, done: true }; },
      async resolveNote(item) {
        return { title: item.title, content: 'Fixture note', strategy: 'exact-initial-state', videos: [],
          images: Array.from({ length: images }, (_, index) => ({ url: `https://ci.xiaohongshu.com/fixture-${item.id}-${index}.jpg` })) };
      }
    },
    fetchImpl: async (url, init) => {
      init.signal?.throwIfAborted();
      media.push(url);
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) } });
    },
    onDiagnostic: (event, details) => {
      diagnostics.push({ event, details });
      if (event === 'media.saved') { saved++; onSaved?.(f, details); }
    },
    ...managerOptions
  };
  const manager = new ProfileManager(config);
  await manager.initialize();
  Object.assign(f, { manager, config,
    start: () => manager.start({ profileUrl: PROFILE, directory, intervalSeconds: 3, jitterSeconds: 0 }),
    settle: async () => { await manager._runTask; return manager.snapshot(); }
  });
  return f;
}

async function fileBytes(f, sequence, name = 'image-001.jpg') {
  const item = f.manager.snapshot().items.find(item => item.sequence === sequence);
  return fs.readFile(path.join(f.directory, item.directoryName, name));
}

test('130-note download survives storage outage after note 101 using a signed grant, with bounded background traffic', async t => {
  let pollWindow = false;
  const f = await fixture(t, { notes: 130, images: 3,
    onSaved(f) {
      if (f.saved === 303) {
        f.setMode('storage-down');
        f.advance(ENTITLEMENT_SYNC_INTERVAL_MS + 1);
        pollWindow = true;
      }
    },
    async onSleep(f) {
      if (pollWindow) { pollWindow = false; await waitFor(() => f.calls.some(call => call.mode === 'storage-down')); }
    }
  });
  await f.start();
  const result = await f.settle();
  assert.equal(result.status, 'completed');
  assert.equal(result.completed, 130);
  assert.equal(result.failed, 0);
  assert.equal(f.media.length, 390);
  assert.equal(new Set(f.media).size, 390, 'Every image is saved once despite the account outage');
  const authorize = f.calls.filter(call => call.action === 'authorize');
  assert.ok(authorize.some(call => call.mode === 'storage-down'), 'A real background refresh observed the injected storage failure');
  assert.ok(authorize.length < 20, `${authorize.length} account calls must stay independent of 390 image requests`);
  assert.deepEqual(await fileBytes(f, 1), JPEG);
  assert.deepEqual(await fileBytes(f, 130, 'image-003.jpg'), JPEG);
  assert.equal(f.client.snapshot().authenticated, true);
});

test('membership expiry pauses a partly saved note and renewal resumes without redownloading verified files', async t => {
  const f = await fixture(t, { expiresAfter: 17_000 });
  await f.start();
  const paused = await f.settle();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.completed, 1);
  assert.equal(paused.failed, 0);
  assert.equal(f.media.length, 3);
  assert.deepEqual(await fileBytes(f, 1), JPEG);
  assert.deepEqual(await fileBytes(f, 2), JPEG);
  await assert.rejects(f.client.authorize('profile-download'), error => /EXPIRED/.test(error.code));
  f.renew();
  await f.manager.resume();
  const resumed = await f.settle();
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.completed + resumed.skipped, 3);
  assert.equal(f.media.length, 6);
  assert.equal(new Set(f.media).size, 6, 'Previously verified image and complete note are preserved on resume');
});

test('authoritative background device revocation invalidates a valid grant and pauses without losing saved media', async t => {
  let pollWindow = false;
  const f = await fixture(t, {
    onSaved(f) {
      if (f.saved === 3) {
        f.setMode('revoked');
        f.advance(ENTITLEMENT_SYNC_INTERVAL_MS + 1);
        pollWindow = true;
      }
    },
    async onSleep(f) {
      if (pollWindow) {
        pollWindow = false;
        await waitFor(() => {
          try { f.client.checkLocalAuthorization('profile-download'); return false; }
          catch { return true; }
        });
      }
    }
  });
  await f.start();
  const paused = await f.settle();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.completed, 1);
  assert.equal(paused.failed, 0);
  assert.equal(f.media.length, 3);
  assert.ok(f.calls.some(call => call.action === 'authorize' && call.mode === 'revoked'));
  await assert.rejects(f.client.authorize('profile-download'), { code: 'DEVICE_REVOKED' });
  assert.throws(() => f.client.checkLocalAuthorization('profile-download'));
  assert.deepEqual(await fileBytes(f, 1), JPEG);
  assert.deepEqual(await fileBytes(f, 2), JPEG);
  f.renew();
  await f.manager.resume();
  const resumed = await f.settle();
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.completed + resumed.skipped, 3);
  assert.equal(f.media.length, 6);
  assert.equal(new Set(f.media).size, 6);
});

test('profile media cannot publish or overwrite after signed authorization changes during final path validation', async t => {
  for (const change of ['expiry', 'revocation']) for (const existing of [false, true]) await t.test(`${change} ${existing ? 'existing target' : 'new target'}`, async child => {
    let f, target, armed = false, transitions = 0;
    const previous = Buffer.from('previous image remains untouched');
    f = await fixture(child, { notes: 1, images: 2,
      managerOptions: {
        // This regression exercises the commit guard independently of timers.
        authorizationIntervalMs: 60_000, localAuthorizationIntervalMs: 60_000,
        fetchImpl: async (url, init) => {
          init.signal?.throwIfAborted(); f.media.push(url);
          if (url.endsWith('-1.jpg') && transitions === 0) {
            target = path.join(f.directory, f.manager.snapshot().items[0].directoryName, 'image-002.jpg');
            if (existing) await fs.writeFile(target, previous);
            armed = true;
          }
          return new Response(JPEG, { headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) } });
        }
      }
    });
    const lstat = fs.lstat.bind(fs);
    child.mock.method(fs, 'lstat', async (filename, ...args) => {
      let result, error;
      try { result = await lstat(filename, ...args); } catch (failure) { error = failure; }
      if (filename === target && armed) {
        armed = false; transitions++;
        if (change === 'expiry') f.advance(86_400_000 + 1);
        else {
          f.setMode('revoked');
          await assert.rejects(f.client.authorize('profile-download', { forceRemote: true }), { code: 'DEVICE_REVOKED' });
        }
      }
      if (error) throw error;
      return result;
    });
    await f.start();
    const paused = await f.settle();
    assert.equal(transitions, 1, 'Authorization changes in the final awaited target check');
    assert.equal(paused.status, 'paused'); assert.equal(paused.pauseReason, 'ACCOUNT_AUTHORIZATION_REQUIRED');
    assert.equal(paused.items[0].status, 'pending'); assert.equal(paused.failed, 0);
    assert.deepEqual(await fileBytes(f, 1), JPEG);
    if (existing) assert.deepEqual(await fs.readFile(target), previous, 'An already existing target must never be replaced');
    else await assert.rejects(fs.stat(target), { code: 'ENOENT' }, 'New media must remain unpublished');
    const noteDirectory = path.dirname(target);
    assert.equal((await fs.readdir(noteDirectory)).some(name => name.endsWith('.part')), false);
    assert.deepEqual(paused.items[0].id, f.descriptors[0].id);
    const persisted = JSON.parse(await fs.readFile(path.join(f.stateDirectory, 'profile-job.json'), 'utf8'));
    assert.equal(persisted.status, 'paused', 'Recovery state remains writable after authorization is denied');
    f.renew(); await f.manager.resume();
    const complete = await f.settle();
    assert.equal(complete.status, 'completed'); assert.equal(f.media.length, 3);
    assert.deepEqual(await fs.readFile(target), JPEG);
    assert.deepEqual(await fileBytes(f, 1), JPEG, 'Previously committed media is verified and retained on resume');
  });
});
