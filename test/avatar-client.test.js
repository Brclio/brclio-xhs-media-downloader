import test from 'node:test';
import assert from 'node:assert/strict';
import { accountAvatarImage, avatarCrop, avatarFileType, AVATAR_MAX_ORIGINAL_BYTES, builtinAvatarUrl,
  inspectAvatarFile, prepareAvatarFile, resetAvatarImages, validateAvatarCatalog } from '../lib/avatar-client.js';

function pngHeader(width = 1200, height = 800) {
  const bytes = new Uint8Array(32); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function imageFile(bytes = pngHeader()) { const blob = new Blob([bytes], { type: 'image/png' }); blob.name = '收藏原图.png'; return blob; }

test('the client permits only the 100 verified local built-in asset IDs', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `avatar-${String(i + 1).padStart(3, '0')}`, name: `头像 ${i + 1}`, url: 'https://untrusted.test/original.png' }));
  const catalog = validateAvatarCatalog(items);
  assert.equal(new Set(catalog.map(item => item.url)).size, 100);
  for (const item of catalog) assert.match(item.url, /\/assets\/avatars\/avatar-\d{3}\.webp$/);
  for (const id of ['avatar-000', 'avatar-101', 'avatar-999', '../original', 'avatar-001?token=secret', 'https://untrusted.test']) assert.equal(builtinAvatarUrl(id), '');
  assert.throws(() => validateAvatarCatalog(items.slice(1)), /内置头像/);
  assert.throws(() => validateAvatarCatalog([...items.slice(0, 99), items[0]]), /内置头像/);
});

test('custom avatar validation checks actual raster signatures and accepts the 100 MiB boundary', async () => {
  assert.equal(avatarFileType(pngHeader()), 'image/png');
  assert.equal(avatarFileType(new Uint8Array([255, 216, 255])), 'image/jpeg');
  assert.equal(avatarFileType(new TextEncoder().encode('GIF89a')), 'image/gif');
  assert.equal(avatarFileType(new TextEncoder().encode('RIFFxxxxWEBP')), 'image/webp');
  assert.equal(avatarFileType(new TextEncoder().encode('<svg onload="alert(1)">')), '');
  const file = imageFile();
  assert.deepEqual(await inspectAvatarFile({ size: AVATAR_MAX_ORIGINAL_BYTES, slice: (...args) => file.slice(...args) }), { contentType: 'image/png', width: 1200, height: 800 });
  await assert.rejects(inspectAvatarFile({ size: AVATAR_MAX_ORIGINAL_BYTES + 1, slice: () => { throw new Error('must not read oversized original'); } }), /100 MB/);
  await assert.rejects(inspectAvatarFile(imageFile(new TextEncoder().encode('<svg/>'))), /JPG.*PNG.*WebP.*GIF/);
  await assert.rejects(inspectAvatarFile(imageFile(pngHeader(32768, 32768))), /像素尺寸过大/);
  await assert.rejects(inspectAvatarFile(imageFile(pngHeader(0, 300))), /无法读取/);
});

test('compression center-crops only the derivative and uploads the unchanged original bytes', async () => {
  const file = imageFile(), original = await file.arrayBuffer(), stages = [], draws = [];
  let closed = false;
  const thumbnail = new Blob([new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80])], { type: 'image/webp' });
  const canvas = { getContext: () => ({ drawImage: (...args) => draws.push(args) }), toBlob: (done, type, quality) => { assert.equal(type, 'image/webp'); assert.equal(quality, .82); done(thumbnail); } };
  const input = await prepareAvatarFile(file, { onStage: value => stages.push(value), documentImpl: { createElement: name => { assert.equal(name, 'canvas'); return canvas; } },
    createImageBitmapImpl: async (source, options) => { assert.equal(source, file); assert.equal(options.resizeWidth, 512); assert.equal(options.resizeHeight, undefined, 'one resize dimension preserves EXIF-oriented aspect ratio'); return { width: 512, height: 341, close: () => { closed = true; } }; } });
  assert.equal(canvas.width, 256); assert.equal(canvas.height, 256);
  assert.deepEqual(draws[0].slice(1), [85.5, 0, 341, 341, 0, 0, 256, 256]);
  assert.deepEqual(input.original, original); assert.deepEqual(input.thumbnail, await thumbnail.arrayBuffer());
  assert.equal(input.contentType, 'image/png'); assert.equal(input.name, '收藏原图.png'); assert.equal(closed, true);
  assert.deepEqual(stages, ['正在检查原图…', '正在生成压缩头像…']);
  assert.deepEqual(avatarCrop(400, 800), { x: 0, y: 200, side: 400 });
});

test('failed compression frees decoded images and never sends the original as an avatar', async () => {
  let closed = false;
  await assert.rejects(prepareAvatarFile(imageFile(), { documentImpl: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: done => done(null) }) },
    createImageBitmapImpl: async () => ({ width: 10, height: 10, close: () => { closed = true; } }) }), /无法生成压缩头像/);
  assert.equal(closed, true);
});

test('custom display fetches only the compressed thumbnail once and ignores stale identity responses', async () => {
  let calls = 0, resolve;
  const bridge = { getAccountAvatarThumbnail: async input => { calls++; assert.equal(input.expectedUserId, 'user-a'); return new Promise(done => { resolve = done; }); } };
  const user = { id: 'user-a', avatar: { kind: 'upload', id: 'private-upload-a', url: 'https://untrusted.test/original' } };
  const first = accountAvatarImage(user, bridge), second = accountAvatarImage(user, bridge);
  assert.equal(calls, 1);
  resetAvatarImages(bridge);
  resolve({ ok: true, result: { thumbnail: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/webp' } });
  assert.equal(await first, ''); assert.equal(await second, '');
  assert.equal(await accountAvatarImage({ id: 'user-b', avatar: { kind: 'builtin', id: 'avatar-100' } }, bridge), builtinAvatarUrl('avatar-100'));
  assert.equal(calls, 1, 'built-in avatars never request archived original bytes');
});

test('only bounded compressed raster bytes become Blob display URLs; failures can retry', async () => {
  let calls = 0;
  const bridge = { getAccountAvatarThumbnail: async () => ({ ok: true, result: ++calls === 1
    ? { thumbnail: 'not binary', contentType: 'image/webp' }
    : { thumbnail: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/webp' } }) };
  const user = { id: 'user', avatar: { kind: 'upload', id: 'private' } };
  assert.equal(await accountAvatarImage(user, bridge), '');
  assert.match(await accountAvatarImage(user, bridge), /^blob:/);
  assert.match(await accountAvatarImage(user, bridge), /^blob:/);
  assert.equal(calls, 2);
  resetAvatarImages(bridge);
});

test('an old failed thumbnail cannot evict the replacement cache entry for the same avatar', async () => {
  const pending = [];
  const bridge = { getAccountAvatarThumbnail: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
  const user = id => ({ id: 'owner', avatar: { kind: 'upload', id } });
  const first = accountAvatarImage(user('avatar-a'), bridge);
  const middle = accountAvatarImage(user('avatar-b'), bridge);
  const replacement = accountAvatarImage(user('avatar-a'), bridge);
  pending[0].reject(new Error('old request failed')); assert.equal(await first, '');
  pending[2].resolve({ ok: true, result: { thumbnail: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/webp' } });
  const url = await replacement; assert.match(url, /^blob:/);
  assert.equal(await accountAvatarImage(user('avatar-a'), bridge), url);
  assert.equal(pending.length, 3, 'current compressed thumbnail stays cached');
  pending[1].resolve({ ok: true, result: { thumbnail: new Uint8Array([4]).buffer, contentType: 'image/webp' } });
  assert.equal(await middle, ''); resetAvatarImages(bridge);
});
