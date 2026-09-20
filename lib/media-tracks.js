// ISO BMFF/MP4 track inspection shared by the browser and desktop downloader.
// Read box headers and the bounded moov index; never load a large mdat into RAM.
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_BOXES = 20000;
const text = (bytes, start, length = 4) => String.fromCharCode(...bytes.subarray(start, start + length));
const u32 = (bytes, start) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(start);
const invalid = () => Object.assign(new Error('视频 MP4 结构不完整，未保存为成功文件。'), { code: 'VIDEO_INVALID' });

function boxHeader(bytes, offset, end) {
  if (end - offset < 8) throw invalid();
  let size = u32(bytes, offset), header = 8;
  const type = text(bytes, offset + 4);
  if (size === 1) {
    if (end - offset < 16) throw invalid();
    size = u32(bytes, offset + 8) * 2 ** 32 + u32(bytes, offset + 12);
    header = 16;
  } else if (size === 0) size = end - offset;
  if (!Number.isSafeInteger(size) || size < header || offset + size > end) throw invalid();
  return { type, size, header };
}

function inspectIndex(bytes) {
  const tracks = [];
  let boxCount = 0;
  const walk = (start, end, track = null, depth = 0) => {
    if (depth > 8) throw invalid();
    for (let offset = start; offset < end;) {
      if (++boxCount > MAX_BOXES) throw invalid();
      const box = boxHeader(bytes, offset, end);
      const content = offset + box.header, limit = offset + box.size;
      if (box.type === 'trak') {
        const current = { type: '', codecs: [] };
        walk(content, limit, current, depth + 1);
        if (current.type) tracks.push(current);
      } else if (['moov', 'mdia', 'minf', 'stbl'].includes(box.type)) {
        walk(content, limit, track, depth + 1);
      } else if (box.type === 'hdlr' && track) {
        if (limit - content < 12) throw invalid();
        const handler = text(bytes, content + 8);
        if (handler === 'vide') track.type = 'video';
        if (handler === 'soun') track.type = 'audio';
      } else if (box.type === 'stsd' && track) {
        if (limit - content < 8) throw invalid();
        const entries = u32(bytes, content + 4);
        if (entries > 64) throw invalid();
        let entry = content + 8;
        for (let i = 0; i < entries; i++) {
          const sample = boxHeader(bytes, entry, limit);
          track.codecs.push(sample.type);
          entry += sample.size;
        }
      }
      offset = limit;
    }
  };
  walk(0, bytes.byteLength);
  return { tracks, hasVideo: tracks.some(track => track.type === 'video'), hasAudio: tracks.some(track => track.type === 'audio') };
}

export async function inspectMp4Tracks(readRange, byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 8) throw invalid();
  let count = 0, sawFtyp = false, sawMedia = false, result;
  for (let offset = 0; offset < byteLength;) {
    if (++count > MAX_BOXES) throw invalid();
    const prefix = await readRange(offset, Math.min(16, byteLength - offset));
    if (!(prefix instanceof Uint8Array) || prefix.byteLength < 8) throw invalid();
    // The header buffer is short, but box sizes are relative to the full file.
    let size = u32(prefix, 0), header = 8;
    if (size === 1) {
      if (prefix.byteLength < 16) throw invalid();
      size = u32(prefix, 8) * 2 ** 32 + u32(prefix, 12); header = 16;
    } else if (size === 0) size = byteLength - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > byteLength) throw invalid();
    const type = text(prefix, 4);
    if (type === 'ftyp') sawFtyp = true;
    if (type === 'mdat' && size > header) sawMedia = true;
    if (type === 'moov') {
      if (result || size > MAX_INDEX_BYTES) throw invalid();
      const index = await readRange(offset, size);
      if (index.byteLength !== size) throw invalid();
      result = inspectIndex(index);
    }
    offset += size;
  }
  if (!sawFtyp || !sawMedia || !result?.hasVideo) throw invalid();
  return result;
}

export async function inspectVideoBlob(blob, { requireAudio = true } = {}) {
  const result = await inspectMp4Tracks(async (start, length) =>
    new Uint8Array(await blob.slice(start, start + length).arrayBuffer()), blob.size);
  requireVideoAudio(result, requireAudio);
  return result;
}

export function requireVideoAudio(result, required = true) {
  if (required && !result.hasAudio) throw Object.assign(new Error('该视频线路没有音轨，已停止保存；请更换视频线路后重试。'), { code: 'VIDEO_AUDIO_MISSING' });
}
