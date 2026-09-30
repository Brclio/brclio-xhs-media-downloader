// Mach-O headers use the formats in Apple's mach-o/loader.h and mach-o/fat.h.
// Keep this function self-contained: the detached installer embeds the same
// reader so neither preparation nor replacement depends on Xcode / lipo.
export async function readMacArchitectures(filename, fs) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('Invalid Mach-O file');
    async function read(offset, size) {
      if (!Number.isSafeInteger(offset) || offset < 0 || size > stat.size - offset) throw new Error('Truncated Mach-O file');
      const buffer = Buffer.alloc(size);
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await file.read(buffer, filled, size - filled, offset + filled);
        if (!bytesRead) throw new Error('Truncated Mach-O header');
        filled += bytesRead;
      }
      return buffer;
    }
    async function thin(offset, size, expectedCpu) {
      const prefix = await read(offset, 8);
      const magic = prefix.readUInt32BE(0);
      const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
      const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
      if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) throw new Error('Invalid Mach-O magic');
      const headerSize = wide ? 32 : 28;
      if (size < headerSize) throw new Error('Truncated Mach-O slice');
      const header = await read(offset, headerSize);
      const number = position => little ? header.readUInt32LE(position) : header.readUInt32BE(position);
      const cpu = number(4);
      if (expectedCpu !== undefined && cpu !== expectedCpu) throw new Error('Mach-O slice architecture mismatch');
      if (number(12) !== 2 || number(20) > size - headerSize) throw new Error('Invalid Mach-O executable');
      return ({ 0x01000007: 'x86_64', 0x0100000c: 'arm64', 7: 'i386', 12: 'arm' })[cpu] || `cpu-${cpu}`;
    }
    const header = await read(0, 8);
    const magic = header.readUInt32BE(0);
    if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
      return [await thin(0, stat.size)];
    }
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
    if (count < 1 || count > 64) throw new Error('Invalid Mach-O slice count');
    const entrySize = wide ? 32 : 20;
    const tableEnd = 8 + count * entrySize;
    const table = await read(8, count * entrySize);
    const number = position => little ? table.readUInt32LE(position) : table.readUInt32BE(position);
    const wideNumber = position => Number(little ? table.readBigUInt64LE(position) : table.readBigUInt64BE(position));
    const ranges = [], architectures = [];
    for (let index = 0; index < count; index++) {
      const entry = index * entrySize;
      const offset = wide ? wideNumber(entry + 8) : number(entry + 8);
      const size = wide ? wideNumber(entry + 16) : number(entry + 12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 28
        || offset < tableEnd || size > stat.size - offset
        || ranges.some(range => offset < range.end && offset + size > range.start)) {
        throw new Error('Invalid Mach-O slice bounds');
      }
      ranges.push({ start: offset, end: offset + size });
      architectures.push(await thin(offset, size, number(entry)));
    }
    return [...new Set(architectures)];
  } finally {
    await file.close();
  }
}
