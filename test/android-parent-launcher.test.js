import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { androidNdkVersion, buildAndroidParentLaunchers, findPinnedAndroidNdk } from '../scripts/prepare-update-proxy.mjs';

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

test('stale runner NDK environment cannot hide the pinned NDK installed in an SDK', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brclio-parent-launcher-ndk-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stale = join(root, 'preinstalled-ndk');
  const sdk = join(root, 'sdk');
  const pinned = join(sdk, 'ndk', androidNdkVersion);
  mkdirSync(stale, { recursive: true }); mkdirSync(pinned, { recursive: true });
  writeFileSync(join(stale, 'source.properties'), 'Pkg.Revision = 29.0.14206865\n');
  writeFileSync(join(pinned, 'source.properties'), `Pkg.Revision = ${androidNdkVersion}\n`);
  const env = { ANDROID_NDK_HOME: stale, ANDROID_NDK_ROOT: join(root, 'missing-ndk'), ANDROID_HOME: sdk };
  assert.equal(findPinnedAndroidNdk({ root, env }), pinned);
  assert.throws(() => buildAndroidParentLaunchers({ root, env }), /missing its host Clang/,
    'The build must reach the selected pinned toolchain instead of failing on the stale version');
  assert.equal(findPinnedAndroidNdk({ root, env: { ...env, ANDROID_HOME: join(root, 'missing-sdk'), ANDROID_SDK_ROOT: sdk } }), pinned);
  mkdirSync(join(root, 'android'));
  writeFileSync(join(root, 'android/local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`);
  assert.equal(findPinnedAndroidNdk({ root, env: { ANDROID_NDK_HOME: stale } }), pinned);
  rmSync(join(pinned, 'source.properties'));
  assert.throws(() => findPinnedAndroidNdk({ root, env }), /requires official Android NDK/,
    'An installed stale NDK must never satisfy the fixed-version requirement');
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
  // Use a saved child script: nesting two Node -e string literals decodes the
  // newline escape twice and can make the core fail before its ready message.
  const coreScript = join(root, 'core.cjs');
  writeFileSync(coreScript, "process.stdout.write('CORE_READY ' + process.pid + '\\n'); setInterval(() => {}, 1000);\n");
  const ownerSource = `
    const { spawn } = require('node:child_process');
    const core = spawn(${JSON.stringify(executable)}, [process.execPath, ${JSON.stringify(coreScript)}],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    core.stdout.pipe(process.stdout);
    core.once('error', error => { console.error(error.message); process.exit(1); });
    core.once('close', (code, signal) => {
      console.error('Supervised core exited before owner shutdown: ' + code + '/' + signal);
      process.exit(1);
    });
  `;
  const owner = spawn(process.execPath, ['-e', ownerSource], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  owner.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-4096); });
  const closed = new Promise((resolve) => owner.once('close', resolve));
  let corePid;
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    if (corePid) { try { process.kill(corePid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    await closed;
  });
  corePid = await new Promise((resolve, reject) => {
    let output = '';
    const fail = error => { clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => fail(new Error('The supervised native core did not become ready. ' + diagnostics)), 5000);
    owner.once('error', fail);
    owner.once('close', (code, signal) => fail(new Error(`The native fixture owner exited before readiness: ${code}/${signal}. ${diagnostics}`)));
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
  assert.equal(owner.kill('SIGKILL'), true);
  await closed;
  assert.equal(owner.signalCode, 'SIGKILL');
  const deadline = Date.now() + 3000;
  while (stillRunning() && Date.now() < deadline) await delay(20);
  assert.equal(stillRunning(), false, 'The proxy core must stop when its application owner is killed.');
});
