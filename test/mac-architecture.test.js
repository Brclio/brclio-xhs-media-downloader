import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMacArchitectures } from '../desktop/mac-architecture.js';

function thin(cpu, little = true) {
  const buffer = Buffer.alloc(32);
  const write = (number, offset) => little ? buffer.writeUInt32LE(number, offset) : buffer.writeUInt32BE(number, offset);
  write(0xfeedfacf, 0);
  write(cpu, 4);
  write(2, 12);
  return buffer;
}

function universal({ wide = false, little = false } = {}) {
  const entrySize = wide ? 32 : 20;
  const buffer = Buffer.alloc(128);
  const write = (number, offset) => little ? buffer.writeUInt32LE(number, offset) : buffer.writeUInt32BE(number, offset);
  const writeSize = (number, offset) => wide
    ? (little ? buffer.writeBigUInt64LE(BigInt(number), offset) : buffer.writeBigUInt64BE(BigInt(number), offset))
    : write(number, offset);
  // Leave space for both FAT64 table entries as well as both thin headers.
  const output = Buffer.alloc(160);
  write(wide ? 0xcafebabf : 0xcafebabe, 0);
  write(2, 4);
  for (const [index, cpu] of [0x01000007, 0x0100000c].entries()) {
    const entry = 8 + index * entrySize;
    write(cpu, entry);
    writeSize(80 + index * 32, entry + 8);
    writeSize(32, entry + (wide ? 16 : 12));
  }
  buffer.copy(output, 0, 0, 8 + 2 * entrySize);
  thin(0x01000007).copy(output, 80);
  thin(0x0100000c).copy(output, 112);
  return output;
}

async function fixture(t, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-mach-o-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'app executable');
  await fs.writeFile(filename, bytes);
  return filename;
}

for (const [cpu, architecture] of [[0x01000007, 'x86_64'], [0x0100000c, 'arm64']]) {
  for (const little of [false, true]) test(`reads ${architecture} ${little ? 'little' : 'big'} endian executable without developer tools`, async t => {
    assert.deepEqual(await readMacArchitectures(await fixture(t, thin(cpu, little)), fs), [architecture]);
  });
}

for (const wide of [false, true]) for (const little of [false, true]) {
  test(`reads FAT${wide ? 64 : 32} ${little ? 'little' : 'big'} endian universal executable`, async t => {
    assert.deepEqual(await readMacArchitectures(await fixture(t, universal({ wide, little })), fs), ['x86_64', 'arm64']);
  });
}

for (const [name, mutate] of [
  ['truncated header', () => Buffer.alloc(7)],
  ['non Mach-O data', () => Buffer.alloc(32)],
  ['non-executable', () => { const b = thin(0x0100000c); b.writeUInt32LE(6, 12); return b; }],
  ['oversized commands', () => { const b = thin(0x0100000c); b.writeUInt32LE(100, 20); return b; }],
  ['unbounded slice count', b => { b.writeUInt32BE(0xffffffff, 4); return b; }],
  ['empty universal file', b => { b.writeUInt32BE(0, 4); return b; }],
  ['truncated slice table', b => b.subarray(0, 20)],
  ['slice outside file', b => { b.writeUInt32BE(1000, 16); return b; }],
  ['slice inside table', b => { b.writeUInt32BE(8, 16); return b; }],
  ['overlapping slices', b => { b.writeUInt32BE(80, 36); return b; }],
  ['mislabelled slice', b => { b.writeUInt32BE(0x0100000c, 8); return b; }],
  ['unsafe 64-bit offset', () => { const b = universal({ wide: true }); b.writeBigUInt64BE(2n ** 63n, 16); return b; }],
]) test(`rejects ${name}`, async t => {
  await assert.rejects(readMacArchitectures(await fixture(t, mutate(universal())), fs));
});

test('closes malformed files and bounds every read', async t => {
  const filename = await fixture(t, Buffer.alloc(32));
  let closed = false;
  const handle = await fs.open(filename, 'r');
  const originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle);
  handle.read = (...args) => { assert.ok(args[2] <= 2048); return originalRead(...args); };
  handle.close = async () => { closed = true; await originalClose(); };
  await assert.rejects(readMacArchitectures(filename, { open: async () => handle }));
  assert.equal(closed, true);
});
