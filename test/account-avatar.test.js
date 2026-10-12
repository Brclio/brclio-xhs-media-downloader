import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createAccountService } from '../server/auth/service.js';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';
import { createAccountHandler } from '../api/account.js';
import { createWorker } from '../cloudflare/worker.js';
import { avatarBinaryResponse, cleanupAvatarUploads, validateAvatarThumbnail, AVATAR_MAX_BYTES, AVATAR_PART_BYTES } from '../server/auth/avatar.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const origin = 'https://avatars.example.test';
const pepper = 'isolated-avatar-test-pepper-'.repeat(3);

class MemoryBucket {
  constructor() { this.objects = new Map(); this.reads = []; }
  async put(key, value, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes = Buffer.from(value);
    this.objects.set(key, { bytes, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata });
    return this.head(key);
  }
  async head(key) {
    const object = this.objects.get(key);
    return object ? { key, size: object.bytes.length, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata } : null;
  }
  async get(key) {
    this.reads.push(key);
    const object = this.objects.get(key);
    if (!object) return null;
    return { ...await this.head(key), body: new Response(object.bytes).body,
      arrayBuffer: async () => Uint8Array.from(object.bytes).buffer, text: async () => object.bytes.toString('utf8') };
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
  async list({ prefix = '', limit = 1000, cursor = '' } = {}) {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix) && key > cursor).sort();
    return { objects: await Promise.all(keys.slice(0, limit).map(key => this.head(key))), truncated: keys.length > limit, cursor: keys[Math.min(limit, keys.length) - 1] };
  }
}

function fixture({ storage = new MemoryBucket() } = {}) {
  let state = emptyState();
  const ownerId = randomUUID(), otherId = randomUUID(), adminId = randomUUID();
  const ownerToken = 'o'.repeat(43), otherToken = 'x'.repeat(43), adminToken = 'a'.repeat(43), desktopToken = 'd'.repeat(43);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  for (const [id, email] of [[ownerId, 'owner@example.test'], [otherId, 'other@example.test'], [adminId, 'admin@example.test']]) state.users[id] = { id, email, createdAt: new Date().toISOString(), membership: { type: 'none' } };
  for (const [token, id, client] of [[ownerToken, ownerId, 'browser'], [otherToken, otherId, 'browser'], [adminToken, adminId, 'admin'], [desktopToken, ownerId, 'desktop']]) {
    state.sessions[digest(pepper, 'session', token)] = { id: randomUUID(), userId: id, client, revokedAt: null, ...(client === 'desktop' ? { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) } : {}) };
  }
  const store = { read: async () => ({ state: structuredClone(state) }), transaction: async work => {
    const next = structuredClone(state), result = await work(next);
    if (result.changed !== false) state = next;
    return result.value;
  } };
  const config = { pepper, adminEmails: ['admin@example.test'], protectedFeatures: [], siteOrigin: origin };
  const service = createAccountService({ store, config, avatarStorage: storage });
  const env = { AUTH_SITE_ORIGIN: origin, AUTH_SECRET_PEPPER: pepper };
  const worker = createWorker({ accountFactory: () => createAccountHandler({ service, config }) });
  async function call(action, input = {}, who = 'owner', extraHeaders = {}) {
    const token = { owner: ownerToken, other: otherToken, admin: adminToken, desktop: desktopToken }[who];
    const headers = { 'Content-Type': 'application/json', Origin: origin, ...extraHeaders };
    let proof;
    if (who === 'desktop') {
      headers.Authorization = `Bearer ${token}`;
      const timestamp = Date.now(), nonce = randomUUID();
      proof = { timestamp, nonce, signature: sign(null, Buffer.from(`${action}\n${timestamp}\n${nonce}\n${JSON.stringify(input)}\n${token}`), privateKey).toString('base64') };
    } else if (token) headers.Cookie = `__Host-xhs-${who === 'admin' ? 'admin' : 'browser'}=${token}`;
    const response = await worker.fetch(new Request(`${origin}/api/account`, { method: 'POST', headers, body: JSON.stringify({ action, input, ...(proof ? { proof } : {}) }) }), env);
    return { response, body: await response.json() };
  }
  async function binary(url, init) {
    const response = await avatarBinaryResponse(new Request(new URL(url, origin), init), { storage, config });
    return response;
  }
  async function begin(bytes = PNG.length, overrides = {}) {
    const reply = await call('avatar-begin', { expectedUserId: ownerId, name: '收藏 原图.png', contentType: 'image/png', bytes, ...overrides });
    assert.equal(reply.response.status, 200, JSON.stringify(reply.body));
    return reply.body.upload;
  }
  async function put(upload, part, bytes) {
    const url = new URL(upload.url, origin); url.searchParams.set('part', String(part));
    return binary(url.href, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  }
  return { call, begin, put, binary, storage, config, state: () => state, ownerId, otherId };
}

test('built-in avatar selection survives unavailable custom storage and keeps membership untouched', async () => {
  const f = fixture();
  const before = structuredClone(f.state().users[f.ownerId].membership);
  const selected = await f.call('avatar-select', { builtinId: 'avatar-100', expectedUserId: f.ownerId }, 'desktop');
  assert.equal(selected.response.status, 200); assert.deepEqual(selected.body.profile.avatar, { kind: 'builtin', id: 'avatar-100' });
  const me = await f.call('me', { client: 'browser' });
  assert.deepEqual(me.body.account.user.avatar, selected.body.profile.avatar);
  assert.deepEqual(f.state().users[f.ownerId].membership, before);
  const noStorage = fixture({ storage: null });
  assert.equal((await noStorage.call('avatar-select', { builtinId: 'avatar-001', expectedUserId: noStorage.ownerId })).response.status, 200);
  assert.equal((await noStorage.call('avatar-capabilities', { expectedUserId: noStorage.ownerId })).body.customUploads, false);
  assert.equal((await noStorage.call('avatar-begin', { expectedUserId: noStorage.ownerId, bytes: 10, contentType: 'image/png' })).body.error.code, 'AVATAR_STORAGE_UNAVAILABLE');
  for (const id of ['avatar-000', 'avatar-101', '../other', '<svg>']) assert.equal((await f.call('avatar-select', { builtinId: id, expectedUserId: f.ownerId })).response.status, 400);
  assert.equal((await f.call('avatar-select', { builtinId: 'avatar-001', expectedUserId: f.otherId })).response.status, 409);
  assert.equal((await f.call('avatar-select', { builtinId: 'avatar-001', expectedUserId: f.ownerId }, 'owner', { Origin: 'https://untrusted.test' })).response.status, 403);
});

test('custom original uploads remain byte-exact, private and archived; every displayed image is the small derivative', async () => {
  const f = fixture(), original = Buffer.alloc(AVATAR_PART_BYTES + 137);
  PNG.copy(original); original[original.length - 1] = 254;
  const upload = await f.begin(original.length);
  assert.equal(upload.partBytes, AVATAR_PART_BYTES); assert.equal(upload.partCount, 2);
  const incomplete = await f.call('avatar-complete', { uploadId: upload.id, expectedUserId: f.ownerId });
  assert.equal(incomplete.response.status, 409);
  for (let index = 0; index < upload.partCount; index++) assert.equal((await f.put(upload, index, original.subarray(index * AVATAR_PART_BYTES, (index + 1) * AVATAR_PART_BYTES))).status, 200);
  assert.equal((await f.put(upload, 'thumbnail', PNG)).status, 200);
  assert.equal((await f.put(upload, 'thumbnail', PNG)).status, 200, 'identical immutable chunk retries are safe');
  const changed = Buffer.from(PNG); changed[40] ^= 1;
  assert.equal((await f.put(upload, 'thumbnail', changed)).status, 400, 'damaged PNG bytes fail server validation');
  const complete = await f.call('avatar-complete', { uploadId: upload.id, expectedUserId: f.ownerId }, 'desktop');
  assert.equal(complete.response.status, 409, 'an upload capability belongs to the initiating session');
  const accepted = await f.call('avatar-complete', { uploadId: upload.id, expectedUserId: f.ownerId });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.profile.avatar.kind, 'upload');
  assert.equal((await f.put(upload, 'thumbnail', PNG)).status, 409, 'completed uploads reject all further writes');
  f.storage.reads.length = 0;
  const thumbnail = await f.binary(accepted.body.profile.avatar.url);
  assert.equal(thumbnail.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()), PNG);
  assert.ok(f.storage.reads.every(key => !key.startsWith('originals/')), 'thumbnail display never loads the original');
  assert.equal((await f.binary(`${origin}/api/account_avatar?action=original&id=${upload.id}`)).status, 403);
  const ownerOriginal = await f.call('avatar-original', { expectedUserId: f.ownerId });
  assert.equal(ownerOriginal.response.status, 200); assert.equal(ownerOriginal.body.bytes, original.length);
  const download = await f.binary(ownerOriginal.body.url);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('cache-control'), /\bno-store\b/);
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
  assert.equal(ownerOriginal.body.sha256, createHash('sha256').update(original).digest('hex'));
  await f.call('avatar-select', { builtinId: 'avatar-087', expectedUserId: f.ownerId });
  await cleanupAvatarUploads(f.storage, { now: () => Date.now() + 86_400_000 });
  assert.ok(f.storage.objects.has(`collection/${upload.id}.json`));
  assert.ok(f.storage.objects.has(`originals/${upload.id}/part-000`));
  assert.equal((await f.call('avatar-original', { expectedUserId: f.ownerId })).response.status, 404);
  const list = await f.call('admin-avatar-list', { limit: 1 }, 'admin');
  assert.equal(list.response.status, 200); assert.equal(list.body.avatars.length, 1);
  assert.deepEqual(Object.keys(list.body.avatars[0]).sort(), ['id', 'userId', 'ownerEmail', 'name', 'contentType', 'bytes', 'sha256', 'collectedAt', 'thumbnailUrl'].sort());
  assert.equal(list.body.avatars[0].id, upload.id);
  const adminOriginal = await f.call('admin-avatar-original', { avatarId: upload.id }, 'admin');
  assert.deepEqual(Buffer.from(await (await f.binary(adminOriginal.body.url)).arrayBuffer()), original);
  for (const who of ['owner', 'desktop', 'other', 'anonymous']) assert.notEqual((await f.call('admin-avatar-list', {}, who)).response.status, 200);
  const expired = await avatarBinaryResponse(new Request(new URL(adminOriginal.body.url, origin)), { storage: f.storage, config: f.config, now: () => Date.now() + 121_000 });
  assert.equal(expired.status, 403);
  assert.ok(Buffer.byteLength(JSON.stringify(f.state())) < 10_000, 'account JSON contains only metadata, never image bytes');
});

test('server enforces original size, actual streamed part lengths, raster magic and static thumbnail bounds', async () => {
  const f = fixture();
  for (const bytes of [0, -1, AVATAR_MAX_BYTES + 1, 1.1]) assert.equal((await f.call('avatar-begin', { expectedUserId: f.ownerId, contentType: 'image/png', bytes })).response.status, 413);
  const boundary = await f.begin(AVATAR_MAX_BYTES); assert.equal(boundary.partCount, 34);
  const upload = await f.begin(PNG.length);
  assert.equal((await f.put(upload, 0, Buffer.alloc(PNG.length + 1))).status, 413);
  assert.equal((await f.put(upload, 0, PNG.subarray(0, -1))).status, 400);
  assert.equal((await f.put(upload, 0, Buffer.alloc(PNG.length))).status, 400);
  assert.equal((await f.put(upload, -1, PNG)).status, 400);
  assert.equal((await f.put(upload, 1, PNG)).status, 400);
  assert.equal((await f.put(upload, 'thumbnail', Buffer.from('<svg onload="alert(1)"></svg>'))).status, 400);
  const oversized = Buffer.from(PNG); oversized.writeUInt32BE(1024, 16); oversized.writeUInt32BE(1024, 20);
  assert.throws(() => validateAvatarThumbnail(oversized), { code: 'INVALID_AVATAR_THUMBNAIL' });
  const rectangular = Buffer.from(PNG); rectangular.writeUInt32BE(2, 16);
  assert.throws(() => validateAvatarThumbnail(rectangular), { code: 'INVALID_AVATAR_THUMBNAIL' });
  const url = new URL(upload.url, origin); url.searchParams.set('part', '0');
  const token = url.searchParams.get('token'); url.searchParams.set('token', `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`);
  assert.equal((await f.binary(url.href, { method: 'PUT', body: PNG })).status, 403);
  await f.call('avatar-cancel', { uploadId: upload.id, expectedUserId: f.ownerId });
  assert.equal((await f.put(upload, 0, PNG)).status, 409);
  await cleanupAvatarUploads(f.storage, { now: () => Date.now() + 86_400_000 });
  assert.equal(f.storage.objects.size, 0, 'expired unfinished manifests and all orphan chunks are removed');
});

test('an avatar changed during upload cannot be overwritten by late completion; its original is still collected', async () => {
  const f = fixture(), upload = await f.begin();
  await f.put(upload, 0, PNG); await f.put(upload, 'thumbnail', PNG);
  await f.call('avatar-select', { builtinId: 'avatar-008', expectedUserId: f.ownerId });
  const late = await f.call('avatar-complete', { uploadId: upload.id, expectedUserId: f.ownerId });
  assert.equal(late.body.error.code, 'AVATAR_CHANGED');
  assert.equal(f.state().users[f.ownerId].avatar.id, 'avatar-008');
  assert.equal((await f.call('admin-avatar-list', {}, 'admin')).body.avatars.length, 1);
  assert.equal(f.state().users[f.ownerId].avatarPendingUploads.length, 0, 'already-collected conflicts release unfinished quota');
  assert.equal((await f.storage.list({ prefix: 'uploads/' })).objects.length, 0, 'already-collected conflicts remove temporary manifests');
  assert.equal((await f.begin()).partCount, 1, 'a conflicting completion cannot block the next original upload');
});

test('unfinished uploads and custom-avatar frequency are bounded independently of builtin selection', async () => {
  const f = fixture(), pending = [];
  for (let index = 0; index < 3; index++) pending.push(await f.begin());
  const blocked = await f.call('avatar-begin', { expectedUserId: f.ownerId, contentType: 'image/png', bytes: PNG.length });
  assert.equal(blocked.response.status, 429); assert.equal(blocked.body.error.code, 'AVATAR_UPLOAD_LIMIT');
  for (const upload of pending) await f.call('avatar-cancel', { uploadId: upload.id, expectedUserId: f.ownerId });
  for (let index = 0; index < 3; index++) {
    const upload = await f.begin();
    await f.call('avatar-cancel', { uploadId: upload.id, expectedUserId: f.ownerId });
  }
  const hourly = await f.call('avatar-begin', { expectedUserId: f.ownerId, contentType: 'image/png', bytes: PNG.length });
  assert.equal(hourly.body.error.code, 'AVATAR_UPLOAD_RATE_LIMITED');
  f.state().users[f.ownerId].avatarUploadTimes = Array.from({ length: 10 }, () => Date.now() - 3_600_001);
  const daily = await f.call('avatar-begin', { expectedUserId: f.ownerId, contentType: 'image/png', bytes: PNG.length });
  assert.equal(daily.body.error.code, 'AVATAR_UPLOAD_RATE_LIMITED');
  assert.equal((await f.call('avatar-select', { builtinId: 'avatar-099', expectedUserId: f.ownerId })).response.status, 200);
});

test('exactly 100 MiB survives all upload chunks and streamed original retrieval without changing a byte', async () => {
  const f = fixture(), upload = await f.begin(AVATAR_MAX_BYTES), originalHash = createHash('sha256');
  for (let index = 0; index < upload.partCount; index++) {
    const bytes = Buffer.alloc(Math.min(AVATAR_PART_BYTES, AVATAR_MAX_BYTES - index * AVATAR_PART_BYTES), index);
    if (index === 0) PNG.copy(bytes);
    originalHash.update(bytes);
    assert.equal((await f.put(upload, index, bytes)).status, 200);
  }
  await f.put(upload, 'thumbnail', PNG);
  const completed = await f.call('avatar-complete', { expectedUserId: f.ownerId, uploadId: upload.id });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  const collection = await f.call('avatar-original', { expectedUserId: f.ownerId });
  const digest = originalHash.digest('hex'); assert.equal(collection.body.sha256, digest);
  const response = await f.binary(collection.body.url), downloadedHash = createHash('sha256');
  const reader = response.body.getReader(); let received = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    received += value.byteLength; downloadedHash.update(value);
  }
  assert.equal(received, AVATAR_MAX_BYTES); assert.equal(downloadedHash.digest('hex'), digest);
  assert.equal(Number(response.headers.get('content-length')), AVATAR_MAX_BYTES);
});

test('a failed object-store manifest write releases its unfinished-upload reservation', async () => {
  const storage = new MemoryBucket();
  storage.put = async () => { throw new Error('PRIVATE_OBJECT_STORE_FAILURE'); };
  const f = fixture({ storage });
  const result = await f.call('avatar-begin', { expectedUserId: f.ownerId, contentType: 'image/png', bytes: PNG.length });
  assert.equal(result.response.status, 503); assert.ok(!JSON.stringify(result.body).includes('PRIVATE_OBJECT_STORE_FAILURE'));
  assert.equal(f.state().users[f.ownerId].avatarPendingUploads.length, 0);
  assert.equal(f.state().users[f.ownerId].avatarUploadTimes.length, 1, 'abuse quota remains bounded even if a storage write fails');
});
