export function mp4Box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

export function mp4Fixture({ audio = true, video = true, payloadBytes = 32 } = {}) {
  const track = (type, codec) => mp4Box('trak', mp4Box('mdia',
    mp4Box('hdlr', Buffer.alloc(8), Buffer.from(type), Buffer.alloc(12)),
    mp4Box('minf', mp4Box('stbl', mp4Box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), mp4Box(codec))))));
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom\0\0\0\0isomiso2', 'binary')),
    mp4Box('mdat', Buffer.alloc(payloadBytes)),
    mp4Box('moov', ...(video ? [track('vide', 'avc1')] : []), ...(audio ? [track('soun', 'mp4a')] : []))
  ]);
}
