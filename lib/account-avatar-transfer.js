export const ACCOUNT_AVATAR_MAX_BYTES = 100 * 1024 * 1024;
export const ACCOUNT_AVATAR_THUMBNAIL_BYTES = 256 * 1024;

function avatarError(code, message) { return Object.assign(new Error(message), { code }); }
function byteView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw avatarError('INVALID_AVATAR_IMAGE', '头像图片数据无效。');
}
export function avatarTransferUrl(value, endpoint) {
  let url;
  try { url = new URL(value, endpoint); } catch { throw avatarError('INVALID_AVATAR_URL', '头像服务地址无效。'); }
  const base = new URL(endpoint);
  if (url.origin !== base.origin || url.pathname !== '/api/account_avatar' || url.username || url.password || url.hash) throw avatarError('INVALID_AVATAR_URL', '头像服务地址无效。');
  return url;
}

/** Original bytes are sliced unchanged. Only the separately supplied small derivative is used by the UI. */
export async function uploadAccountAvatarTransfer({ input, endpoint, request, fetchImpl, assertCurrent = () => {} }) {
  const original = byteView(input?.original), thumbnail = byteView(input?.thumbnail);
  if (!original.byteLength || original.byteLength > ACCOUNT_AVATAR_MAX_BYTES) throw avatarError('AVATAR_TOO_LARGE', '头像原图不得超过 100 MB。');
  if (!thumbnail.byteLength || thumbnail.byteLength > ACCOUNT_AVATAR_THUMBNAIL_BYTES) throw avatarError('INVALID_AVATAR_THUMBNAIL', '压缩头像不得超过 256 KB。');
  const common = { expectedUserId: input.expectedUserId };
  assertCurrent();
  const begun = await request('avatar-begin', { ...common, name: input.name, contentType: input.contentType, bytes: original.byteLength });
  const upload = begun.upload;
  if (!upload || !Number.isSafeInteger(upload.partBytes) || upload.partBytes < 1 || upload.partBytes > 3 * 1024 * 1024
    || upload.partCount !== Math.ceil(original.byteLength / upload.partBytes)) throw avatarError('AVATAR_UPLOAD_INVALID', '头像上传服务返回无效清单。');
  const uploadUrl = avatarTransferUrl(upload.url, endpoint);
  async function put(part, bytes) {
    assertCurrent();
    const url = new URL(uploadUrl); url.searchParams.set('part', String(part));
    const response = await fetchImpl(url.href, { method: 'PUT', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(60_000) });
    assertCurrent();
    const result = await response.json();
    if (!response.ok || !result.ok) throw avatarError(result.error?.code || 'AVATAR_UPLOAD_FAILED', result.error?.message || '头像上传失败，请重试。');
  }
  try {
    for (let index = 0; index < upload.partCount; index++) await put(index, original.subarray(index * upload.partBytes, Math.min(original.byteLength, (index + 1) * upload.partBytes)));
    await put('thumbnail', thumbnail);
    assertCurrent();
    return await request('avatar-complete', { ...common, uploadId: upload.id });
  } catch (error) {
    // Cleanup is best effort and scoped to the original account. A completed
    // collection is protected by the server even after an uncertain reply.
    try { assertCurrent(); await request('avatar-cancel', { ...common, uploadId: upload.id }); } catch {}
    throw error;
  }
}

export async function fetchAccountAvatarThumbnail({ url, endpoint, fetchImpl, assertCurrent = () => {} }) {
  assertCurrent();
  const target = avatarTransferUrl(url, endpoint);
  if (target.searchParams.get('action') !== 'thumbnail') throw avatarError('INVALID_AVATAR_URL', '压缩头像地址无效。');
  const response = await fetchImpl(target.href, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  assertCurrent();
  const contentType = response.headers.get('content-type')?.split(';')[0];
  if (!response.ok || !['image/webp', 'image/png'].includes(contentType)
    || Number(response.headers.get('content-length') || 0) > ACCOUNT_AVATAR_THUMBNAIL_BYTES) throw avatarError('AVATAR_THUMBNAIL_UNAVAILABLE', '暂时无法读取压缩头像。');
  const reader = response.body?.getReader();
  if (!reader) throw avatarError('AVATAR_THUMBNAIL_UNAVAILABLE', '压缩头像为空。');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > ACCOUNT_AVATAR_THUMBNAIL_BYTES) { await reader.cancel().catch(() => {}); throw avatarError('INVALID_AVATAR_THUMBNAIL', '压缩头像大小无效。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  assertCurrent();
  const thumbnail = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { thumbnail.set(chunk, offset); offset += chunk.byteLength; }
  return { thumbnail: thumbnail.buffer, contentType };
}
