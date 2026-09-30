import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { createFixtureArchive } from '../scripts/verify-packaged-mac-update.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const wrappedFs = require(path.join(path.dirname(require.resolve('@electron/asar')), 'wrapped-fs.js')).default;

test('packaged Mac fixture waits for real ASAR payload writes before byte verification', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'brclio-asar-finish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source);
  const marker = 'support-fixture-delayed-payload';
  const bytes = Buffer.from(`/* ${marker} */\n.support { display: flex; }\n`.repeat(16));
  await writeFile(path.join(source, 'support.css'), bytes);

  const gates = [], secondGate = Promise.withResolvers();
  t.mock.method(wrappedFs, 'createWriteStream', (destination, options) => {
    // Delay only the payload's real disk write; ASAR's header is already on disk.
    // This reproduces a slow final write without timers or changing ASAR bytes.
    const pending = Promise.withResolvers(), blocked = Promise.withResolvers();
    const gate = { release: pending.resolve, blocked: blocked.promise };
    gates.push(gate);
    if (gates.length === 2) secondGate.resolve(gate);
    const deferPayload = (buffers, write) => {
      if (buffers.some(buffer => buffer.includes(marker))) {
        blocked.resolve(); void pending.promise.then(write);
      } else write();
    };
    return fs.createWriteStream(destination, { ...options, fs: {
      open: fs.open, close: fs.close,
      write(fd, buffer, ...args) { deferPayload([buffer], () => fs.write(fd, buffer, ...args)); },
      writev(fd, buffers, ...args) { deferPayload(buffers, () => fs.writev(fd, buffers, ...args)); }
    } });
  });

  const earlyArchive = path.join(root, 'early.asar');
  const earlyOutput = await asar.createPackage(source, earlyArchive);
  try {
    await gates[0].blocked;
    assert.equal(earlyOutput.writableFinished, false, 'the dependency resolves before its output finishes');
    assert.equal(asar.extractFile(earlyArchive, 'support.css').equals(bytes), false, 'an immediate reader sees the incomplete tail');
  } finally { gates[0].release(); await finished(earlyOutput); }
  assert.deepEqual(asar.extractFile(earlyArchive, 'support.css'), bytes);

  const completeArchive = path.join(root, 'complete.asar');
  let completed = false;
  const completion = createFixtureArchive(source, completeArchive).then(() => { completed = true; });
  const finalGate = await secondGate.promise;
  try {
    await finalGate.blocked;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'the fixture must keep waiting while its payload write is blocked');
  } finally { finalGate.release(); await completion; }
  assert.deepEqual(asar.extractFile(completeArchive, 'support.css'), bytes);
});
