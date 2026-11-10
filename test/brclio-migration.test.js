import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrateMac } from '../desktop/migration/mac.js';
import { verifyInstaller } from '../desktop/migration/release.js';

async function bundle(directory, version, identifier = 'com.brclio.toolbox') {
  const executable = path.join(directory, 'Contents/MacOS/Brclio');
  await mkdir(path.dirname(executable), { recursive: true });
  const mach = Buffer.alloc(32);
  mach.writeUInt32BE(0xcffaedfe);
  mach.writeUInt32LE(0x0100000c, 4);
  mach.writeUInt32LE(2, 12);
  await writeFile(executable, mach);
  await writeFile(path.join(directory, 'Contents/Info.plist'), JSON.stringify({
    CFBundleIdentifier: identifier, CFBundleExecutable: 'Brclio', CFBundlePackageType: 'APPL', CFBundleShortVersionString: version
  }));
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brclio-migration-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const applications = path.join(directory, 'Applications');
  await mkdir(applications);
  const version = '0.2.9';
  const target = path.join(applications, 'Brclio.app');
  const payload = Buffer.from('Brclio installer fixture');
  const asset = { name: 'Brclio-0.2.9-mac-arm64.dmg', size: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex') };
  const installer = path.join(directory, asset.name);
  await writeFile(installer, payload);
  const commands = [];
  let opened = 0;
  const deps = { applications, openTarget: async () => { opened++; }, running: async () => [],
    run: async (command, args) => {
      commands.push(command);
      if (command.endsWith('/plutil')) return { stdout: await readFile(args.at(-1), 'utf8') };
      if (command.endsWith('/hdiutil')) {
        if (args[0] === 'attach') await bundle(path.join(args.at(-2), 'Brclio.app'), version);
        else await rm(path.join(args[1], 'Brclio.app'), { recursive: true });
      } else if (command.endsWith('/ditto')) {
        await cp(args.at(-2), args.at(-1), { recursive: true });
      } else if (command.endsWith('/osascript')) {
        const [from, to, mode] = args.slice(-3);
        if (mode === '2') {
          const temp = path.join(directory, 'exchange');
          await rename(to, temp);
          await rename(from, to);
          await rename(temp, from);
        } else {
          await assert.rejects(lstat(to), { code: 'ENOENT' });
          await rename(from, to);
        }
      } else assert.equal(command, '/usr/bin/codesign');
      return { stdout: '' };
    } };
  return { options: { installer, version, arch: 'arm64', asset }, deps, commands, target, opened: () => opened,
    version: async () => JSON.parse(await readFile(path.join(target, 'Contents/Info.plist'), 'utf8')).CFBundleShortVersionString };
}

test('a fresh migration publishes the pinned bundle and repeated launches are offline', async t => {
  const f = await fixture(t);
  await migrateMac(f.options, f.deps);
  assert.equal(await f.version(), f.options.version);
  await rm(f.options.installer);
  await migrateMac(f.options, f.deps);
  assert.equal(f.opened(), 2);
  assert.equal(f.commands.filter(command => command.endsWith('/ditto')).length, 1);
});

test('an existing newer toolbox opens without touching the pinned installer', async t => {
  const f = await fixture(t);
  await bundle(f.target, '0.10.0');
  await rm(f.options.installer);
  await migrateMac(f.options, f.deps);
  assert.equal(f.opened(), 1);
  assert.equal(await f.version(), '0.10.0');
});

test('an older running toolbox can be retried after quit', async t => {
  const f = await fixture(t);
  await bundle(f.target, '0.2.8');
  await assert.rejects(migrateMac(f.options, { ...f.deps, running: async () => [{ ready: true }] }), /退出/);
  assert.equal(await f.version(), '0.2.8');
  assert.deepEqual(await readdir(f.deps.applications), ['Brclio.app']);
  await migrateMac(f.options, f.deps);
  assert.equal(await f.version(), '0.2.9');
});

test('a launch failure restores the original bundle if no new process is running', async t => {
  const f = await fixture(t);
  await bundle(f.target, '0.2.8');
  await assert.rejects(migrateMac(f.options, { ...f.deps, openTarget: async () => { throw Error('launch failed'); } }), /launch failed/);
  assert.equal(await f.version(), '0.2.8');
  assert.deepEqual(await readdir(f.deps.applications), ['Brclio.app']);
});

test('an unrelated application is preserved, and a corrupted embedded installer is refused', async t => {
  const f = await fixture(t);
  await bundle(f.target, '0.2.8', 'org.example.unrelated');
  await assert.rejects(migrateMac(f.options, f.deps), /身份/);
  assert.equal(await f.version(), '0.2.8');
  await rm(f.target, { recursive: true });
  await writeFile(f.options.installer, Buffer.alloc(f.options.asset.size));
  await assert.rejects(migrateMac(f.options, f.deps), /SHA-256/);
  assert.deepEqual(await readdir(f.deps.applications), []);
});

test('an installer symlink cannot be accepted', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rename(f.options.installer, f.options.installer + '.real');
  await symlink(f.options.installer + '.real', f.options.installer);
  await assert.rejects(verifyInstaller(f.options.installer, f.options.asset));
});
