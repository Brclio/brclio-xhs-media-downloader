import { makeZipBlob } from './archive.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('ascii');
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
const METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PFVideoComplementMetadataVersionKey</key>
  <string>1</string>
</dict>
</plist>
`;

function requireBytes(value, label) {
  if (!(value instanceof Uint8Array) || !value.byteLength) {
    throw new TypeError(`${label} must be a nonempty Uint8Array.`);
  }
  return value;
}

// This is a container-type check, not a replacement for the maker's media and
// pairing validation. Walking complete top-level boxes also rejects truncated
// bytes that happen to begin with a plausible file-type signature.
function container(data, label) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxes = [];
  for (let offset = 0; offset < data.length;) {
    if (offset + 8 > data.length) throw new TypeError(`${label} has a truncated box header.`);
    let size = view.getUint32(offset), header = 8;
    if (size === 1) {
      if (offset + 16 > data.length) throw new TypeError(`${label} has a truncated extended box header.`);
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) size = data.length - offset;
    if (!Number.isSafeInteger(size) || size < header || size > data.length - offset) {
      throw new TypeError(`${label} has an invalid box size.`);
    }
    boxes.push({ type: decoder.decode(data.subarray(offset + 4, offset + 8)), start: offset + header, end: offset + size });
    offset += size;
  }
  const types = new Set(boxes.map(box => box.type));
  const fileTypes = boxes.filter(box => box.type === 'ftyp');
  if (fileTypes.length !== 1) throw new TypeError(`${label} must have one file-type box.`);
  const fileType = fileTypes[0];
  if (fileType.end - fileType.start < 8 || (fileType.end - fileType.start) % 4) {
    throw new TypeError(`${label} has an invalid file-type box.`);
  }
  const brands = [decoder.decode(data.subarray(fileType.start, fileType.start + 4))];
  for (let offset = fileType.start + 8; offset < fileType.end; offset += 4) {
    brands.push(decoder.decode(data.subarray(offset, offset + 4)));
  }
  if (!boxes.some(box => box.type === 'mdat' && box.end > box.start)) {
    throw new TypeError(`${label} must contain media bytes.`);
  }
  return { types, brands };
}

/** Wrap an already-paired createLivePhoto result for Apple .pvt transfer.
 * The ZIP contains one .pvt directory and an adjacent README.txt. No user file
 * names become archive paths, and the original photo/MOV bytes are preserved.
 * Device import remains a separate compatibility check.
 */
export function makeLivePhotoPackage(result, { date = new Date() } = {}) {
  if (!result || typeof result !== 'object' || typeof result.assetIdentifier !== 'string' || result.assetIdentifier.length !== 36 || !UUID.test(result.assetIdentifier)) {
    throw new TypeError('assetIdentifier must be a UUID.');
  }
  const extension = result.photoFormat === 'jpeg' ? 'JPG' : result.photoFormat === 'heic' ? 'HEIC' : undefined;
  if (!extension || result.photoExtension !== extension) {
    throw new TypeError('photoFormat and photoExtension must agree (jpeg/JPG or heic/HEIC).');
  }
  const photo = requireBytes(result.photo, 'photo');
  const mov = requireBytes(result.mov, 'mov');
  if (result.photoFormat === 'jpeg') {
    if (photo.length < 4 || photo[0] !== 0xff || photo[1] !== 0xd8 || photo.at(-2) !== 0xff || photo.at(-1) !== 0xd9) {
      throw new TypeError('photo bytes do not match the JPG format.');
    }
  } else {
    const { types, brands } = container(photo, 'HEIC photo');
    if (!brands.some(brand => HEIC_BRANDS.has(brand)) || !types.has('meta') || types.has('moov')) {
      throw new TypeError('photo bytes do not match the HEIC format.');
    }
  }
  const video = container(mov, 'MOV');
  if (!video.brands.includes('qt  ') || !video.types.has('moov')) {
    throw new TypeError('mov bytes must be a QuickTime MOV container.');
  }
  const stem = `Brclio-Live-${result.assetIdentifier}`;
  const bundleName = `${stem}.pvt`;
  const readme = [
    'Brclio 实况照片包', '',
    `配对标识：${result.assetIdentifier}`,
    `照片格式：${extension}`, '',
    '1. 在 Mac 解压此 ZIP，保留整个 .pvt 包及包内文件名。',
    '2. 在 Finder 选中整个 .pvt → 共享 → 隔空投送 → 选择 iPhone 或 iPad。',
    '3. 接收后在照片 App 中检查 LIVE / 实况标记，并长按播放。', '',
    '发送的是整个 .pvt 包；不要发送 ZIP，也不要打开包后分开发送照片和 MOV。',
    '如果手机收到两个独立文件，请确认发送的是完整 .pvt。',
    '隔空投送与照片 App 的识别效果仍需在目标设备上确认。', ''
  ].join('\n');
  const files = [
    { name: `${bundleName}/${stem}.${extension}`, data: photo },
    { name: `${bundleName}/${stem}.MOV`, data: mov },
    { name: `${bundleName}/metadata.plist`, data: encoder.encode(METADATA) },
    { name: 'README.txt', data: encoder.encode(`\uFEFF${readme}`) }
  ];
  return { stem, bundleName, files, zip: makeZipBlob(files, date), readme };
}
