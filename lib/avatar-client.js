import { imageDimensionsFromHeader } from './image-dimensions.js';

export const AVATAR_MAX_ORIGINAL_BYTES = 100 * 1024 * 1024;
export const AVATAR_MAX_THUMBNAIL_BYTES = 256 * 1024;
export const AVATAR_THUMBNAIL_SIZE = 256;
const MAX_DECODE_PIXELS = 160_000_000;
const thumbnailCaches = new WeakMap();

export function builtinAvatarUrl(id) {
  return /^avatar-(?:00[1-9]|0[1-9]\d|100)$/.test(String(id || ''))
    ? new URL(`../assets/avatars/${id}.webp`, import.meta.url).href : '';
}

export function validateAvatarCatalog(value) {
  if (!Array.isArray(value) || value.length !== 100) throw new Error('内置头像暂时无法读取，请重试。');
  const seen = new Set();
  return value.map(item => {
    const url = builtinAvatarUrl(item?.id);
    if (!url || seen.has(item.id) || typeof item.name !== 'string' || !item.name.trim()) throw new Error('内置头像暂时无法读取，请重试。');
    seen.add(item.id);
    // Local paths are derived from the verified ID, never from remote metadata.
    return { id: item.id, name: item.name.trim().slice(0, 48), url };
  });
}

export function avatarFileType(bytes) {
  const has = (offset, signature) => offset + signature.length <= bytes.length && signature.every((byte, index) => bytes[offset + index] === byte);
  if (has(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (has(0, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (has(0, [71, 73, 70, 56, 55, 97]) || has(0, [71, 73, 70, 56, 57, 97])) return 'image/gif';
  if (has(0, [82, 73, 70, 70]) && has(8, [87, 69, 66, 80])) return 'image/webp';
  return '';
}

export async function inspectAvatarFile(file) {
  if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('请选择一张有效的图片。');
  if (file.size > AVATAR_MAX_ORIGINAL_BYTES) throw new Error('头像原图不能超过 100 MB，请选择更小的图片。');
  const header = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
  const contentType = avatarFileType(header);
  if (!contentType) throw new Error('请上传 JPG、PNG、WebP 或 GIF 图片；暂不支持 HEIC、SVG 等格式。');
  const dimensions = imageDimensionsFromHeader(header);
  if (!dimensions?.width || !dimensions?.height) throw new Error('无法读取这张图片，请重新导出为 JPG、PNG 或 WebP 后重试。');
  if (dimensions.width > 32768 || dimensions.height > 32768 || dimensions.height > Math.floor(MAX_DECODE_PIXELS / dimensions.width)) {
    throw new Error('这张图片的像素尺寸过大，当前设备无法安全处理，请缩小尺寸后重试。');
  }
  return { contentType, ...dimensions };
}

export function avatarCrop(width, height) {
  const side = Math.min(width, height);
  return { x: (width - side) / 2, y: (height - side) / 2, side };
}

export async function prepareAvatarFile(file, { onStage = () => {}, documentImpl = globalThis.document,
  createImageBitmapImpl = globalThis.createImageBitmap } = {}) {
  onStage('正在检查原图…');
  const info = await inspectAvatarFile(file);
  if (typeof createImageBitmapImpl !== 'function') throw new Error('当前环境暂不支持头像处理，请更新客户端或浏览器后重试。');
  let bitmap;
  try {
    onStage('正在生成压缩头像…');
    // One resize dimension preserves the oriented photo's aspect ratio. Giving
    // both header dimensions can stretch JPEGs whose EXIF rotates the image.
    bitmap = await createImageBitmapImpl(file, { imageOrientation: 'from-image',
      resizeWidth: Math.min(512, info.width, info.height), resizeQuality: 'high' });
    const canvas = documentImpl.createElement('canvas');
    canvas.width = canvas.height = AVATAR_THUMBNAIL_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('头像处理暂不可用，请重新打开应用后重试。');
    const crop = avatarCrop(bitmap.width, bitmap.height);
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, crop.x, crop.y, crop.side, crop.side, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
    if (!thumbnail || !['image/webp', 'image/png'].includes(thumbnail.type) || thumbnail.size > AVATAR_MAX_THUMBNAIL_BYTES) {
      throw new Error('无法生成压缩头像，请换一张图片重试。');
    }
    // Original bytes are read without canvas conversion; all display uses the derivative.
    return { original: await file.arrayBuffer(), thumbnail: await thumbnail.arrayBuffer(), name: file.name || 'avatar', contentType: info.contentType };
  } catch (error) {
    if (error instanceof Error && /头像|图片/.test(error.message)) throw error;
    throw new Error('这张图片无法解码，请重新导出为 JPG、PNG 或 WebP 后重试。');
  } finally { bitmap?.close?.(); }
}

export function resetAvatarImages(bridge) {
  const cache = thumbnailCaches.get(bridge);
  if (!cache) return;
  for (const entry of cache.values()) { entry.cancelled = true; if (entry.url) URL.revokeObjectURL(entry.url); }
  thumbnailCaches.delete(bridge);
}

export async function accountAvatarImage(user, bridge) {
  const avatar = user?.avatar;
  if (avatar?.kind === 'builtin') { resetAvatarImages(bridge); return builtinAvatarUrl(avatar.id); }
  if (avatar?.kind !== 'upload' || !avatar.id || !user?.id || !bridge?.getAccountAvatarThumbnail) { resetAvatarImages(bridge); return ''; }
  let cache = thumbnailCaches.get(bridge);
  if (!cache) { cache = new Map(); thumbnailCaches.set(bridge, cache); }
  const key = `${user.id}:${avatar.id}`;
  if (cache.has(key)) return cache.get(key).promise;
  // Keep only the current compressed avatar; obsolete Blob URLs and promises expire.
  for (const entry of cache.values()) { entry.cancelled = true; if (entry.url) URL.revokeObjectURL(entry.url); }
  cache.clear();
  const entry = { cancelled: false, url: '', promise: null };
  entry.promise = (async () => {
    try {
      const reply = await bridge.getAccountAvatarThumbnail({ expectedUserId: user.id });
      const result = reply?.result;
      const bytes = result?.thumbnail;
      if (entry.cancelled) return '';
      if (!reply?.ok || !bytes || !['image/webp', 'image/png'].includes(result.contentType)
        || !Number.isInteger(bytes.byteLength) || bytes.byteLength <= 0 || bytes.byteLength > AVATAR_MAX_THUMBNAIL_BYTES) throw new Error('Invalid thumbnail');
      entry.url = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
      return entry.url;
    } catch { if (cache.get(key) === entry) cache.delete(key); return ''; }
  })();
  cache.set(key, entry);
  return entry.promise;
}
