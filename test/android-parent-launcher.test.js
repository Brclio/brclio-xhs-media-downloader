import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { androidNdkVersion, buildAndroidParentLaunchers } from '../scripts/prepare-update-proxy.mjs';

test('Android parent-death launcher requires the pinned official NDK and host compiler', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brclio-parent-launcher-build-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => buildAndroidParentLaunchers({ root, env: {} }), /requires official Android NDK/);
  const ndk = join(root, 'ndk');
  mkdirSync(ndk);
  writeFileSync(join(ndk, 'source.properties'), 'Pkg.Revision = 0.0.1\n');
  assert.throws(() => buildAndroidParentLaunchers({ root, env: { ANDROID_NDK_HOME: ndk } }), /requires official Android NDK/);
  writeFileSync(join(ndk, 'source.properties'), `Pkg.Revision = ${androidNdkVersion}\n`);
  assert.throws(() => buildAndroidParentLaunchers({ root, env: { ANDROID_NDK_HOME: ndk } }), /missing its host Clang/);
});

test('native Linux parent-death hook survives exec and terminates the core after an owner crash', {
  skip: process.platform !== 'linux', timeout: 15000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brclio-parent-launcher-native-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'parent-launcher');
  const compilation = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    fileURLToPath(new URL('../desktop/resources/update-proxy/android-parent-launcher.c', import.meta.url)), '-o', executable],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(compilation.status, 0, compilation.error?.message || compilation.stderr);
  const rejectsRelativeCore = spawnSync(executable, ['relative-core-path'], { encoding: 'utf8' });
  assert.equal(rejectsRelativeCore.status, 64);
  const ownerSource = `
    const { spawn } = require('node:child_process');
    const core = spawn(${JSON.stringify(executable)}, [process.execPath, '-e',
      "process.stdout.write('CORE_READY ' + process.pid + '\\n'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    core.stdout.pipe(process.stdout);
    core.once('error', () => process.exit(1));
  `;
  const owner = spawn(process.execPath, ['-e', ownerSource], { stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise((resolve) => owner.once('close', resolve));
  let corePid;
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    if (corePid) { try { process.kill(corePid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    await closed;
  });
  corePid = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('The supervised native core did not become ready.')), 5000);
    owner.once('error', reject);
    owner.stdout.on('data', (data) => {
      output += data;
      const match = /CORE_READY (\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  assert.ok(corePid > 1);
  const stillRunning = () => {
    try {
      const stat = readFileSync(`/proc/${corePid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      return !['Z', 'X'].includes(state);
    } catch { return false; }
  };
  assert.equal(stillRunning(), true);
  owner.kill('SIGKILL');
  const deadline = Date.now() + 3000;
  while (stillRunning() && Date.now() < deadline) await delay(20);
  assert.equal(stillRunning(), false, 'The proxy core must stop when its application owner is killed.');
});
