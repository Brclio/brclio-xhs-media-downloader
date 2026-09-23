import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMacFixtureDmg } from '../scripts/create-mac-fixture-dmg.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xhs-fixture-dmg-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'payload'); await mkdir(source);
  await writeFile(path.join(source, 'source.txt'), 'unchanged source');
  return { directory, source, destination: path.join(directory, 'update.dmg') };
}

test('fixture DMG retries a failed create and failed verification without publishing partial images', async t => {
  const f = await fixture(t);
  const reports = [], pauses = [], candidates = [];
  let creates = 0, verifies = 0;
  const result = await createMacFixtureDmg(f, {
    async command(file, args) {
      assert.equal(file, '/usr/bin/hdiutil');
      assert.equal(args.includes('-quiet'), false);
      if (args[0] === 'create') {
        creates++; const candidate = args.at(-1); candidates.push(candidate);
        await writeFile(candidate, creates === 3 ? 'verified image' : 'partial image');
        if (creates === 1) throw Object.assign(new Error('Resource busy'), { code: 1, stdout: 'create phase output', stderr: 'DiskImages resource busy' });
      } else {
        assert.equal(args[0], 'verify'); verifies++;
        assert.equal(await readFile(args[1], 'utf8'), creates === 3 ? 'verified image' : 'partial image');
        await assert.rejects(readFile(f.destination), { code: 'ENOENT' });
        if (creates === 2) throw Object.assign(new Error('Image checksum failed'), { code: 1, stderr: 'bad image checksum' });
      }
      return { stdout: '', stderr: '' };
    },
    sleep: async ms => { pauses.push(ms); assert.deepEqual(await readdir(f.directory), ['payload']); },
    diagnose: async () => ({ filesystem: { availableBytes: 12345 } }), report: value => reports.push(value),
  });
  assert.deepEqual(result, { attempts: 3, verified: true });
  assert.equal(creates, 3); assert.equal(verifies, 2);
  assert.equal(new Set(candidates).size, 3, 'each create uses a fresh path');
  assert.deepEqual(pauses, [1000, 3000]);
  assert.equal(reports[0].fixtureDmgFailure.stderr, 'DiskImages resource busy');
  assert.equal(reports[1].fixtureDmgFailure.phase, 'verify');
  assert.equal(await readFile(f.destination, 'utf8'), 'verified image');
  assert.equal(await readFile(path.join(f.source, 'source.txt'), 'utf8'), 'unchanged source');
  assert.deepEqual((await readdir(f.directory)).sort(), ['payload', 'update.dmg']);
});

test('fixture DMG stops after three failures and retains command and resource diagnostics', async t => {
  const f = await fixture(t); let attempts = 0;
  await assert.rejects(createMacFixtureDmg(f, {
    async command(_file, args) {
      assert.equal(args[0], 'create'); attempts++;
      await writeFile(args.at(-1), 'incomplete');
      throw Object.assign(new Error('create failed'), { code: 1, stdout: 'progress', stderr: 'No space left on device' });
    },
    sleep: async () => {}, report: () => {}, diagnose: async () => ({ filesystem: { availableBytes: 0 } }),
  }), error => {
    assert.match(error.message, /failed after 3 attempt/);
    assert.match(error.message, /No space left on device/);
    assert.match(error.message, /availableBytes.*0/);
    assert.equal(error.cause.code, 1);
    return true;
  });
  assert.equal(attempts, 3);
  await assert.rejects(readFile(f.destination), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.directory), ['payload']);
});

test('fixture DMG never overwrites an existing destination', async t => {
  const f = await fixture(t); await writeFile(f.destination, 'existing image');
  await assert.rejects(createMacFixtureDmg(f, { command: async () => { assert.fail('must not invoke hdiutil'); } }), /Refusing to replace/);
  assert.equal(await readFile(f.destination, 'utf8'), 'existing image');
});
