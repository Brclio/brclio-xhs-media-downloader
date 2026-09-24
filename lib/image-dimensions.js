export function validateImageDimensions(width, height, maxPixels = 20_000_000) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    height > Math.floor(maxPixels / width)
  ) {
    throw new Error("单张图片像素过大，无法安全写入剪贴板，请下载原图。");
  }
}

export function imageDimensionsFromHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (offset, values) =>
    offset + values.length <= bytes.length &&
    values.every((value, index) => bytes[offset + index] === value);

  if (has(0, [0x89, 0x50, 0x4e, 0x47]) && bytes.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (
    bytes.length >= 10 &&
    (has(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      has(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
  ) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (has(0, [0xff, 0xd8])) {
    const startOfFrameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
    ]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return {
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3)
        };
      }
      offset += segmentLength;
    }
  }

  if (
    bytes.length >= 30 &&
    has(0, [0x52, 0x49, 0x46, 0x46]) &&
    has(8, [0x57, 0x45, 0x42, 0x50])
  ) {
    if (has(12, [0x56, 0x50, 0x38, 0x58])) {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
      };
    }
    if (has(12, [0x56, 0x50, 0x38, 0x4c]) && bytes[20] === 0x2f) {
      return {
        width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
        height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6))
      };
    }
    if (has(12, [0x56, 0x50, 0x38, 0x20]) && has(23, [0x9d, 0x01, 0x2a])) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff
      };
    }
  }

  // AVIF / HEIF 的 ispe 属性在解码前就能提供画布尺寸。
  for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
    if (has(offset, [0x69, 0x73, 0x70, 0x65])) {
      const boxSize = view.getUint32(offset - 4);
      if (boxSize < 20) continue;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (width && height) return { width, height };
    }
  }

  return null;
}
