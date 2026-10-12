import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { AccountError, fail } from './errors.js';
import { digest, equalDigest } from './crypto.js';

export const AVATAR_MAX_BYTES = 100 * 1024 * 1024;
export const AVATAR_PART_BYTES = 3 * 1024 * 1024;
export const AVATAR_THUMBNAIL_BYTES = 256 * 1024;
const UPLOAD_TTL = 2 * 60 * 60 * 1000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const jsonHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const originalKey = (id, index) => `originals/${id}/part-${String(index).padStart(3, '0')}`;
const collectionKey = id => `collection/${id}.json`;
const thumbnailKey = id => `thumbnails/${id}`;
const uploadKey = (userId, id) => `uploads/${userId}/${id}.json`;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function avatarView(avatar) {
  if (avatar?.kind === 'builtin' && /^avatar-(?:00[1-9]|0[1-9]\d|100)$/.test(avatar.id)) return { kind: 'builtin', id: avatar.id };
  if (avatar?.kind === 'upload' && UUID.test(avatar.id)) return { kind: 'upload', id: avatar.id, url: `/api/account_avatar?action=thumbnail&id=${avatar.id}`, originalName: avatar.originalName, originalAvailable: true };
  return { kind: 'default' };
}

/** Only inert raster formats are accepted. SVG/HTML and MIME-only claims never pass. */
export function imageType(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (b.length >= 16 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  fail('INVALID_AVATAR_IMAGE', '头像仅支持 JPG、PNG、WebP 和 GIF 图片。');
}

export function validateAvatarThumbnail(bytes) {
  const b = Buffer.from(bytes);
  if (!b.length || b.length > AVATAR_THUMBNAIL_BYTES) fail('INVALID_AVATAR_THUMBNAIL', '压缩头像不得超过 256 KB。');
  const type = imageType(b);
  let width, height, compressed;
  if (type === 'image/png' && b.length >= 45 && b.readUInt32BE(8) === 13 && b.subarray(12, 16).toString('ascii') === 'IHDR') {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
    const chunks = []; let offset = 8, ended = false;
    while (offset + 12 <= b.length) {
      const length = b.readUInt32BE(offset), end = offset + 12 + length;
      if (end > b.length || crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) fail('INVALID_AVATAR_THUMBNAIL', '压缩头像图片损坏，请重新选择。');
      const kind = b.subarray(offset + 4, offset + 8).toString('ascii');
      if (kind === 'acTL') fail('INVALID_AVATAR_THUMBNAIL', '请使用静态压缩头像。');
      if (kind === 'IDAT') chunks.push(b.subarray(offset + 8, end - 4));
      if (kind === 'IEND') { ended = length === 0 && end === b.length; break; }
      offset = end;
    }
    if (!ended || !chunks.length || b[24] !== 8 || ![2, 4, 6].includes(b[25]) || b[26] || b[27] || b[28]) fail('INVALID_AVATAR_THUMBNAIL', '请使用标准静态 PNG 压缩头像。');
    compressed = Buffer.concat(chunks);
  } else if (type === 'image/webp' && b.length >= 30 && b.readUInt32LE(4) + 8 === b.length) {
    let offset = 12, frames = 0, extended;
    while (offset + 8 <= b.length) {
      const chunk = b.subarray(offset, offset + 4).toString('ascii'), length = b.readUInt32LE(offset + 4), start = offset + 8, end = start + length;
      if (end > b.length) fail('INVALID_AVATAR_THUMBNAIL', '压缩头像图片损坏，请重新选择。');
      if (chunk === 'ANIM' || chunk === 'ANMF') fail('INVALID_AVATAR_THUMBNAIL', '请使用静态压缩头像。');
      if (chunk === 'VP8X' && length === 10 && !(b[start] & 2)) extended = { width: 1 + b.readUIntLE(start + 4, 3), height: 1 + b.readUIntLE(start + 7, 3) };
      if (chunk === 'VP8 ' && length > 10 && !(b[start] & 1) && b[start + 3] === 0x9d && b[start + 4] === 0x01 && b[start + 5] === 0x2a) {
        width = b.readUInt16LE(start + 6) & 0x3fff; height = b.readUInt16LE(start + 8) & 0x3fff; frames++;
      } else if (chunk === 'VP8L' && length > 5 && b[start] === 0x2f && !(b[start + 4] & 0xe0)) {
        width = 1 + (((b[start + 2] & 0x3f) << 8) | b[start + 1]);
        height = 1 + (((b[start + 4] & 0xf) << 10) | (b[start + 3] << 2) | ((b[start + 2] & 0xc0) >> 6)); frames++;
      }
      offset = end + (length % 2);
    }
    if (offset !== b.length || frames !== 1 || (extended && (extended.width !== width || extended.height !== height))) fail('INVALID_AVATAR_THUMBNAIL', '压缩头像图片损坏，请重新选择。');
  }
  if (!Number.isInteger(width) || width < 1 || width !== height || width > 512) fail('INVALID_AVATAR_THUMBNAIL', '压缩头像必须为不超过 512 像素的正方形 PNG 或 WebP。');
  if (compressed) {
    const channels = { 2: 3, 4: 2, 6: 4 }[b[25]], rowBytes = width * channels + 1, expected = height * rowBytes;
    let pixels;
    try { pixels = inflateSync(compressed, { maxOutputLength: expected }); } catch { fail('INVALID_AVATAR_THUMBNAIL', '压缩头像无法解码，请重新选择。'); }
    if (pixels.length !== expected || Array.from({ length: height }, (_, row) => pixels[row * rowBytes]).some(filter => filter > 4)) fail('INVALID_AVATAR_THUMBNAIL', '压缩头像无法解码，请重新选择。');
  }
  return { type, width, height, bytes: b.length };
}

function requireStorage(bucket) {
  if (!bucket?.get || !bucket?.put || !bucket?.list || !bucket?.delete) fail('AVATAR_STORAGE_UNAVAILABLE', '头像收藏存储尚未配置，请稍后重试。', 503);
  return bucket;
}
async function objectJson(bucket, key) {
  const object = await bucket.get(key);
  return object ? JSON.parse(await object.text()) : null;
}
const putJson = (bucket, key, value) => bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

function capability(config, value) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${digest(config.pepper, 'avatar-capability-v1', body)}`;
}
function readCapability(config, token, now) {
  if (typeof token !== 'string' || token.length > 2500) fail('AVATAR_TOKEN_INVALID', '头像访问凭据无效。', 403);
  const [body, signature, extra] = token.split('.');
  if (extra || !equalDigest(signature, digest(config.pepper, 'avatar-capability-v1', body || ''))) fail('AVATAR_TOKEN_INVALID', '头像访问凭据无效。', 403);
  let value;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { fail('AVATAR_TOKEN_INVALID', '头像访问凭据无效。', 403); }
  if (!UUID.test(value.id) || !UUID.test(value.userId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < now) fail('AVATAR_TOKEN_EXPIRED', '头像访问凭据已过期，请重试。', 403);
  return value;
}
function binaryUrl(config, params) {
  const url = new URL('/api/account_avatar', config.avatarOrigin || config.siteOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  // Resolve against the caller's trusted account endpoint in both browser and
  // native bridges. A stored canonical hostname must not leak into alias URLs.
  return `${url.pathname}${url.search}`;
}
function expectedOwner(state, request, authenticate, time, admin = false) {
  const identity = authenticate(state, request, time, admin);
  if (!admin && identity.session.client === 'admin') fail('ACCOUNT_REQUIRED', '请使用软件账号登录。', 403);
  if (!admin && request.input.expectedUserId !== identity.user.id) fail('ACCOUNT_CHANGED', '软件账号已切换，请重新选择头像。', 409);
  return identity;
}

/** Account state contains only the current avatar pointer. All original bytes and collection records stay private in object storage. */
export function createAvatarService({ store, config, storage, now = Date.now, authenticate, hash }) {
  async function execute(request) {
    const { state } = await store.read();
    const admin = request.action.startsWith('admin-');
    const { user } = expectedOwner(state, request, authenticate, now(), admin);
    const profile = user => ({ avatar: avatarView(user.avatar) });
    if (request.action === 'avatar-capabilities') return { builtinCount: 100, customUploads: Boolean(storage?.get && storage?.put), maxOriginalBytes: AVATAR_MAX_BYTES };
    if (request.action === 'avatar-select') {
      if (!/^avatar-(?:00[1-9]|0[1-9]\d|100)$/.test(request.input.builtinId || '')) fail('INVALID_AVATAR_ID', '请选择内置头像。');
      return store.transaction(latest => {
        const { user: current } = expectedOwner(latest, request, authenticate, now());
        current.avatar = { kind: 'builtin', id: request.input.builtinId };
        current.avatarRevision = (current.avatarRevision || 0) + 1;
        return { value: { profile: profile(current) } };
      });
    }
    const bucket = requireStorage(storage);
    if (request.action === 'avatar-begin') {
      const { bytes, contentType } = request.input;
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > AVATAR_MAX_BYTES) fail('AVATAR_TOO_LARGE', '头像原图不得超过 100 MB。', 413);
      if (!TYPES.has(contentType)) fail('INVALID_AVATAR_IMAGE', '头像仅支持 JPG、PNG、WebP 和 GIF 图片。');
      const name = String(request.input.name || 'avatar').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200) || 'avatar';
      const time = now(), id = randomUUID(), expiresAt = time + UPLOAD_TTL;
      const reservation = await store.transaction(latest => {
        const time = now(), { user: current } = expectedOwner(latest, request, authenticate, time);
        const times = (current.avatarUploadTimes || []).filter(at => Number.isSafeInteger(at) && at > time - 86_400_000);
        if (times.length >= 10 || times.filter(at => at > time - 3_600_000).length >= 6) fail('AVATAR_UPLOAD_RATE_LIMITED', '自定义头像上传较频繁，请稍后再试；内置头像仍可正常选择。', 429);
        const reservations = (current.avatarPendingUploads || []).filter(item => item.expiresAt > time);
        if (reservations.length >= 3) fail('AVATAR_UPLOAD_LIMIT', '尚有头像上传未完成，请稍后重试。', 429);
        current.avatarPendingUploads = [...reservations, { id, expiresAt }];
        current.avatarUploadTimes = [...times, time];
        return { value: { previousRevision: current.avatarRevision || 0 } };
      });
      const manifest = { id, userId: user.id, ownerEmail: user.email, name, contentType, bytes, partCount: Math.ceil(bytes / AVATAR_PART_BYTES), createdAt: new Date(time).toISOString(), expiresAt, sessionHash: hash('avatar-upload-session', request.token), previousRevision: reservation.previousRevision };
      try {
        if (bucket.beginUpload) await bucket.beginUpload(manifest);
        else await putJson(bucket, uploadKey(user.id, id), manifest);
      }
      catch (error) {
        // A temporary object-store failure must not consume an unfinished
        // upload slot for two hours after storage becomes available again.
        try {
          await store.transaction(latest => {
            const { user: current } = expectedOwner(latest, request, authenticate, now());
            current.avatarPendingUploads = (current.avatarPendingUploads || []).filter(item => item.id !== id && item.expiresAt > now());
            return { value: {} };
          });
        } catch { /* An uncertain account write still expires automatically. */ }
        throw error;
      }
      const token = capability(config, { id, userId: user.id, purpose: 'upload', expiresAt, sessionHash: manifest.sessionHash });
      return { upload: { id, url: binaryUrl(config, { action: 'upload', token }), partBytes: AVATAR_PART_BYTES, partCount: manifest.partCount, maxBytes: AVATAR_MAX_BYTES, expiresAt } };
    }
    if (request.action === 'avatar-complete') {
      const id = request.input.uploadId;
      if (!UUID.test(id || '')) fail('AVATAR_UPLOAD_INVALID', '头像上传编号无效。');
      const manifest = await objectJson(bucket, uploadKey(user.id, id)) || await objectJson(bucket, collectionKey(id));
      if (!manifest || manifest.userId !== user.id || manifest.sessionHash !== hash('avatar-upload-session', request.token) || manifest.expiresAt < now()) fail('AVATAR_UPLOAD_EXPIRED', '头像上传已过期，请重新上传。', 409);
      let originalSha256 = manifest.sha256;
      if (!originalSha256) {
        const hasher = createHash('sha256');
        for (let index = 0; index < manifest.partCount; index++) {
          const part = await bucket.get(originalKey(id, index));
          const expected = Math.min(AVATAR_PART_BYTES, manifest.bytes - index * AVATAR_PART_BYTES);
          if (!part || part.size !== expected) fail('AVATAR_UPLOAD_INCOMPLETE', '头像原图尚未完整上传，请重试。', 409);
          const bytes = Buffer.from(await part.arrayBuffer());
          if (index === 0 && imageType(bytes) !== manifest.contentType) fail('INVALID_AVATAR_IMAGE', '头像图片内容与格式不匹配。');
          hasher.update(bytes);
        }
        originalSha256 = hasher.digest('hex');
      }
      const thumbnail = await bucket.get(thumbnailKey(id));
      if (!thumbnail) fail('AVATAR_UPLOAD_INCOMPLETE', '压缩头像尚未上传，请重试。', 409);
      const checked = validateAvatarThumbnail(await thumbnail.arrayBuffer());
      const final = { ...manifest, sha256: originalSha256, thumbnail: checked, collectedAt: manifest.collectedAt || new Date(now()).toISOString() };
      if (bucket.completeUpload) await bucket.completeUpload(final);
      else await putJson(bucket, collectionKey(id), final);
      const result = await store.transaction(latest => {
        const { user: current } = expectedOwner(latest, request, authenticate, now());
        if (current.avatar?.id === id) return { changed: false, value: { profile: profile(current), replayed: true } };
        current.avatarPendingUploads = (current.avatarPendingUploads || []).filter(item => item.id !== id && item.expiresAt > now());
        if ((current.avatarRevision || 0) !== manifest.previousRevision) return { value: { avatarChanged: true } };
        current.avatar = { kind: 'upload', id, url: binaryUrl(config, { action: 'thumbnail', id }), originalName: manifest.name };
        current.avatarRevision = (current.avatarRevision || 0) + 1;
        return { value: { profile: profile(current) } };
      });
      if (!bucket.completeUpload) await bucket.delete(uploadKey(user.id, id));
      if (result.avatarChanged) fail('AVATAR_CHANGED', '头像已在另一处更新，原图已收藏，请重新选择头像。', 409);
      return result;
    }
    if (request.action === 'avatar-cancel') {
      const id = request.input.uploadId;
      if (!UUID.test(id || '')) fail('AVATAR_UPLOAD_INVALID', '头像上传编号无效。');
      const pending = await objectJson(bucket, uploadKey(user.id, id));
      if (pending && !await objectJson(bucket, collectionKey(id))) {
        // Keep the cancelled manifest until the daily sweep. An already
        // in-flight object write must still have a cleanup record afterwards.
        await putJson(bucket, uploadKey(user.id, id), { ...pending, expiresAt: now() - 1, cancelledAt: new Date(now()).toISOString() });
      }
      await store.transaction(latest => {
        const { user: current } = expectedOwner(latest, request, authenticate, now());
        current.avatarPendingUploads = (current.avatarPendingUploads || []).filter(item => item.id !== id && item.expiresAt > now());
        return { value: {} };
      });
      return { cancelled: true };
    }
    if (request.action === 'avatar-original' || request.action === 'admin-avatar-original') {
      const id = admin ? request.input.avatarId : user.avatar?.kind === 'upload' ? user.avatar.id : '';
      if (!UUID.test(id || '')) fail('AVATAR_ORIGINAL_NOT_FOUND', '当前头像没有收藏的原图。', 404);
      const manifest = await objectJson(bucket, collectionKey(id));
      if (!manifest || (!admin && manifest.userId !== user.id)) fail('AVATAR_ORIGINAL_NOT_FOUND', '没有找到该头像原图。', 404);
      const token = capability(config, { id, userId: manifest.userId, purpose: 'original', expiresAt: now() + 120_000 });
      return { url: binaryUrl(config, { action: 'original', token }), name: manifest.name, bytes: manifest.bytes, contentType: manifest.contentType, sha256: manifest.sha256 };
    }
    if (request.action === 'admin-avatar-list') {
      const limit = request.input.limit === undefined ? 20 : request.input.limit, cursor = request.input.cursor;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2000))) fail('INVALID_AVATAR_FILTER', '头像收藏分页参数无效。');
      // Bound directory calls plus record reads beneath Workers Free's 50
      // external-request limit, even when an older admin asks for 50 records.
      const page = await bucket.list({ prefix: 'collection/', limit: Math.min(limit, 30), ...(cursor ? { cursor } : {}) });
      const records = await Promise.all(page.objects.map(object => objectJson(bucket, object.key)));
      return { avatars: records.filter(Boolean).map(({ id, userId, ownerEmail, name, contentType, bytes, sha256, collectedAt }) => ({ id, userId, ownerEmail, name, contentType, bytes, sha256, collectedAt, thumbnailUrl: binaryUrl(config, { action: 'thumbnail', id }) })), cursor: page.truncated ? page.cursor : null };
    }
    fail('UNKNOWN_ACTION', '未知头像操作。', 404);
  }
  return { execute };
}

async function boundedBytes(request, limit) {
  if (Number(request.headers.get('content-length') || 0) > limit) fail('AVATAR_TOO_LARGE', '头像上传分块过大。', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('INVALID_AVATAR_IMAGE', '头像上传内容为空。');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); fail('AVATAR_TOO_LARGE', '头像上传分块过大。', 413); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/** A scoped, expiring capability writes immutable chunks; account cookies/tokens never enter object URLs. */
export async function avatarBinaryResponse(request, { storage, config, now = Date.now }) {
  try {
    const bucket = requireStorage(storage), url = new URL(request.url), action = url.searchParams.get('action');
    if (action === 'thumbnail') {
      if (!['GET', 'HEAD'].includes(request.method)) fail('METHOD_NOT_ALLOWED', '只支持 GET 请求。', 405);
      const id = url.searchParams.get('id');
      if (!UUID.test(id || '') || !await objectJson(bucket, collectionKey(id))) fail('AVATAR_NOT_FOUND', '没有找到该头像。', 404);
      const image = await bucket.get(thumbnailKey(id));
      if (!image) fail('AVATAR_NOT_FOUND', '没有找到该头像。', 404);
      return new Response(request.method === 'HEAD' ? null : image.body, { headers: { ...jsonHeaders, 'Content-Type': image.httpMetadata?.contentType || 'image/webp', 'Content-Length': String(image.size) } });
    }
    const ticket = readCapability(config, url.searchParams.get('token'), now());
    if (action === 'original' && ticket.purpose === 'original') {
      if (!['GET', 'HEAD'].includes(request.method)) fail('METHOD_NOT_ALLOWED', '只支持 GET 请求。', 405);
      const manifest = await objectJson(bucket, collectionKey(ticket.id));
      if (!manifest || manifest.userId !== ticket.userId) fail('AVATAR_ORIGINAL_NOT_FOUND', '没有找到该头像原图。', 404);
      let index = 0;
      const stream = new ReadableStream({ async pull(controller) {
        if (index === manifest.partCount) { controller.close(); return; }
        try {
          const part = await bucket.get(originalKey(ticket.id, index++));
          if (!part) throw new Error('Missing original chunk');
          controller.enqueue(new Uint8Array(await part.arrayBuffer()));
        } catch (error) { controller.error(error); }
      } });
      return new Response(request.method === 'HEAD' ? null : stream, { headers: { ...jsonHeaders, 'Cache-Control': 'private, no-store', 'Content-Type': 'application/octet-stream', 'Content-Length': String(manifest.bytes), 'Content-Disposition': `attachment; filename="avatar-original"; filename*=UTF-8''${encodeURIComponent(manifest.name).replaceAll("'", '%27')}`, 'X-Avatar-Sha256': manifest.sha256 } });
    }
    if (action !== 'upload' || ticket.purpose !== 'upload' || request.method !== 'PUT') fail('METHOD_NOT_ALLOWED', '头像上传请求无效。', 405);
    const manifest = await objectJson(bucket, uploadKey(ticket.userId, ticket.id));
    if (!manifest || manifest.sessionHash !== ticket.sessionHash || manifest.expiresAt < now()) fail('AVATAR_UPLOAD_EXPIRED', '头像上传已过期，请重试。', 409);
    if (await objectJson(bucket, collectionKey(ticket.id))) fail('AVATAR_UPLOAD_COMPLETE', '该头像上传已完成。', 409);
    const thumbnail = url.searchParams.get('part') === 'thumbnail';
    const index = Number(url.searchParams.get('part'));
    if (!thumbnail && (!/^\d+$/.test(url.searchParams.get('part') || '') || !Number.isSafeInteger(index) || index < 0 || index >= manifest.partCount)) fail('INVALID_AVATAR_PART', '头像上传分块序号无效。');
    const expected = thumbnail ? AVATAR_THUMBNAIL_BYTES : Math.min(AVATAR_PART_BYTES, manifest.bytes - index * AVATAR_PART_BYTES);
    const bytes = await boundedBytes(request, expected);
    // A slow request body may finish after its account upload was cancelled
    // or expired. Revalidate before attempting any immutable binary write.
    if (ticket.expiresAt < now()) fail('AVATAR_UPLOAD_EXPIRED', '头像上传已过期，请重新上传。', 409);
    const currentManifest = await objectJson(bucket, uploadKey(ticket.userId, ticket.id));
    if (!currentManifest || currentManifest.expiresAt < now() || currentManifest.sessionHash !== ticket.sessionHash) fail('AVATAR_UPLOAD_EXPIRED', '头像上传已取消或过期，请重新上传。', 409);
    if (await objectJson(bucket, collectionKey(ticket.id))) fail('AVATAR_UPLOAD_COMPLETE', '该头像上传已完成。', 409);
    let type = 'application/octet-stream';
    if (thumbnail) type = validateAvatarThumbnail(bytes).type;
    else {
      if (bytes.length !== expected) fail('INVALID_AVATAR_PART', '头像分块大小与原图清单不符。');
      if (index === 0 && imageType(bytes) !== manifest.contentType) fail('INVALID_AVATAR_IMAGE', '头像图片内容与格式不匹配。');
    }
    const key = thumbnail ? thumbnailKey(ticket.id) : originalKey(ticket.id, index);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const object = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: type }, customMetadata: { sha256 } });
    if (!object) {
      const prior = await bucket.head(key);
      if (prior?.size !== bytes.length || prior?.customMetadata?.sha256 !== sha256) fail('AVATAR_PART_CONFLICT', '已上传的头像分块不可替换，请重新上传。', 409);
    }
    return Response.json({ ok: true, bytes: bytes.length, sha256 }, { headers: jsonHeaders });
  } catch (error) {
    const known = error instanceof AccountError;
    return Response.json({ ok: false, error: { code: known ? error.code : 'AVATAR_STORAGE_UNAVAILABLE', message: known ? error.message : '头像存储暂时不可用，请重试。' } }, { status: known ? error.status : 503, headers: jsonHeaders });
  }
}

async function deleteIncomplete(bucket, manifest) {
  if (bucket.deleteIncomplete) return bucket.deleteIncomplete(manifest);
  const keys = Array.from({ length: manifest.partCount }, (_, index) => originalKey(manifest.id, index));
  await bucket.delete([...keys, thumbnailKey(manifest.id), uploadKey(manifest.userId, manifest.id)]);
}

/** Daily cleanup removes only expired unfinished uploads, never collected originals. */
export async function cleanupAvatarUploads(bucket, { now = Date.now, limit = 100, maxPages = 1 } = {}) {
  if (!bucket) return;
  let cursor = await bucket.getCleanupCursor?.() || undefined, pages = 0;
  do {
    const page = await bucket.list({ prefix: 'uploads/', limit: Math.min(limit, bucket.cleanupPageLimit || limit), ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      const manifest = await objectJson(bucket, object.key);
      if (!manifest || manifest.expiresAt + 300_000 >= now()) continue;
      if (await objectJson(bucket, collectionKey(manifest.id))) await bucket.delete(object.key);
      else await deleteIncomplete(bucket, manifest);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && ++pages < maxPages);
  await bucket.setCleanupCursor?.(cursor || null);
}
