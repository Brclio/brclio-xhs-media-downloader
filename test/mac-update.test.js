import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { prepareMacUpdate } from '../desktop/mac-update.js';
import { confirmMacUpdateStartup } from '../desktop/mac-update-cleanup.js';

const execute = promisify(execFile);
const appId = 'cn.bornforthis.xhs-downloader';
const metadata = version => ({ CFBundleIdentifier: appId, CFBundlePackageType: 'APPL', CFBundleExecutable: 'fixture', CFBundleShortVersionString: version });
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'xhs-mac-update-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'Current application.app'), source = path.join(root, 'fixture-source.app');
  async function bundle(directory, meta) {
    await mkdir(path.join(directory, 'Contents/MacOS'), { recursive: true });
    await writeFile(path.join(directory, 'Contents/Info.plist'), JSON.stringify(meta));
    await writeFile(path.join(directory, 'Contents/MacOS/fixture'), 'fixture');
  }
  await bundle(current, { ...metadata('1.7.1'), ...overrides.current });
  await bundle(source, { ...metadata('1.8.0'), ...overrides.target });
  const installer = path.join(root, 'fixture.dmg'); await writeFile(installer, 'already verified fixture');
  const calls = [], progressStates = [];
  let progressPath;
  const startProgress = async ({ resultPath }) => {
    progressPath = resultPath;
    progressStates.push(JSON.parse(await readFile(resultPath, 'utf8')).status);
    return { close: async () => { progressStates.push('closed'); } };
  };
  const run = async (command, args) => {
    calls.push({ command, args });
    if (progressPath) progressStates.push(JSON.parse(await readFile(progressPath, 'utf8')).status);
    if (command.endsWith('/plutil')) return { stdout: await readFile(args.at(-1), 'utf8') };
    if (command.endsWith('/hdiutil') && args[0] === 'attach') {
      if (overrides.mountFailure) throw new Error('mount failed');
      const mount = args[args.indexOf('-mountpoint') + 1];
      await cp(source, path.join(mount, 'New application.app'), { recursive: true });
      if (overrides.multiple) await cp(source, path.join(mount, 'Extra.app'), { recursive: true });
      return { stdout: JSON.stringify({ 'system-entities': [{ 'mount-point': mount, 'dev-entry': '/dev/fixture' }] }) };
    }
    if (command.endsWith('/hdiutil')) return { stdout: '' };
    if (command.endsWith('/lipo')) return { stdout: overrides.arch || 'arm64 x86_64' };
    if (command.endsWith('/codesign')) {
      if (overrides.signatureFailure === 'source' || (overrides.signatureFailure === 'staged' && args.at(-1).endsWith('next.app'))) throw new Error('code has no resources but signature indicates they must be present');
      return { stdout: '' };
    }
    if (command.endsWith('/ditto')) { await cp(args.at(-2), args.at(-1), { recursive: true }); return { stdout: '' }; }
    throw new Error(`Unexpected command ${command}`);
  };
  return { root, current, calls, progressStates, options: { installerPath: installer, currentAppPath: current, expectedVersion: '1.8.0', expectedArch: 'arm64', cacheDirectory: path.join(root, 'cache'), parentPid: process.pid }, dependencies: { platform: 'darwin', run, startProgress } };
}

test('preparation leaves current app untouched, verifies source and staged copy, then disposes', async t => {
  const f = await fixture(t);
  const before = await lstat(f.current);
  const prepared = await prepareMacUpdate(f.options, f.dependencies);
  assert.equal(prepared.mode, 'replace');
  assert.equal((await lstat(f.current)).ino, before.ino);
  assert.equal(JSON.parse(await readFile(path.join(f.current, 'Contents/Info.plist'))).CFBundleShortVersionString, '1.7.1');
  assert.equal(f.calls.filter(call => call.command.endsWith('/codesign')).length, 2);
  const attach = f.calls.find(call => call.args[0] === 'attach');
  assert.ok(attach.args.includes('-readonly'));
  assert.equal(f.calls.at(-1).args[0], 'detach');
  assert.deepEqual([...new Set(f.progressStates)], ['preparing', 'opening', 'verifying', 'copying', 'checking'], 'visible progress follows the actual preparation operations');
  const helper = await readFile(path.join(path.dirname(prepared.resultPath), 'install.cjs'), 'utf8');
  assert.ok(helper.includes('process.argv.slice(2)'));
  assert.equal(helper.match(/run\('\/usr\/bin\/open', \['-n', current\]/g)?.length, 2, 'replacement and rollback explicitly start a new app instance while the Electron helper still lives');
  assert.ok(!helper.includes(f.current), 'paths are not interpolated into helper source');
  assert.ok(!/sudo|spctl|xattr.*(?:-d|-c)/.test(helper), 'does not disable platform security');
  await prepared.dispose();
  assert.equal(f.progressStates.at(-1), 'closed', 'cancelled preparation closes its progress window');
  await assert.rejects(lstat(path.dirname(prepared.backupPath)), { code: 'ENOENT' });
  await assert.rejects(prepared.launch(), { code: 'MAC_UPDATE_DISPOSED' });
  assert.equal((await lstat(f.current)).ino, before.ino);
});

test('a failed progress window prevents starting an invisible overwrite installation', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareMacUpdate(f.options, { ...f.dependencies, startProgress: async () => {
    throw Object.assign(new Error('native progress unavailable'), { code: 'MAC_UPDATE_PROGRESS' });
  } }), { code: 'MAC_UPDATE_PROGRESS' });
  assert.equal(f.calls.some(call => call.command.endsWith('/hdiutil')), false);
  assert.equal(JSON.parse(await readFile(path.join(f.current, 'Contents/Info.plist'))).CFBundleShortVersionString, '1.7.1');
});

for (const [description, overrides, code] of [
  ['wrong current app identity', { current: { CFBundleIdentifier: 'other.application' } }, 'MAC_UPDATE_IDENTITY'],
  ['wrong target identity', { target: { CFBundleIdentifier: 'other.application' } }, 'MAC_UPDATE_IDENTITY'],
  ['wrong target version', { target: { CFBundleShortVersionString: '9.0.0' } }, 'MAC_UPDATE_VERSION'],
  ['executable path traversal', { target: { CFBundleExecutable: '../outside' } }, 'MAC_UPDATE_IDENTITY'],
  ['wrong architecture', { arch: 'x86_64' }, 'MAC_UPDATE_ARCH'],
  ['invalid source signature', { signatureFailure: 'source' }, 'MAC_UPDATE_SIGNATURE'],
  ['invalid copied signature', { signatureFailure: 'staged' }, 'MAC_UPDATE_SIGNATURE'],
  ['ambiguous DMG contents', { multiple: true }, 'MAC_UPDATE_CONTENTS'],
  ['failed DMG mount', { mountFailure: true }, 'MAC_UPDATE_MOUNT']
]) test(`rejects ${description} without modifying current application`, async t => {
  const f = await fixture(t, overrides);
  const before = await readFile(path.join(f.current, 'Contents/Info.plist'));
  await assert.rejects(prepareMacUpdate(f.options, f.dependencies), { code });
  assert.deepEqual(await readFile(path.join(f.current, 'Contents/Info.plist')), before);
  assert.equal((await readdir(f.root)).some(name => name.startsWith('.brclio-update-')), false, 'failed preparation cleans its staging directory');
});

test('rejects invalid paths, symlink installers, caller identity, architecture, and unsafe process IDs', async t => {
  const f = await fixture(t);
  for (const override of [{ expectedAppId: 'other.app' }, { expectedArch: 'arm' }, { expectedVersion: '1.8.0;touch x' }, { parentPid: 1 }]) {
    await assert.rejects(prepareMacUpdate({ ...f.options, ...override }, f.dependencies), { code: 'MAC_UPDATE_METADATA' });
  }
  await assert.rejects(prepareMacUpdate({ ...f.options, currentAppPath: 'relative.app' }, f.dependencies), { code: 'MAC_UPDATE_PATH' });
  await assert.rejects(prepareMacUpdate({ ...f.options, currentAppPath: path.join(f.root, 'missing.app') }, f.dependencies), { code: 'MAC_UPDATE_PATH' });
  await assert.rejects(prepareMacUpdate({ ...f.options, cacheDirectory: path.join(f.current, 'cache') }, f.dependencies), { code: 'MAC_UPDATE_PATH' });
  if (process.platform !== 'win32') {
    const link = path.join(f.root, 'linked.dmg'); await symlink(f.options.installerPath, link);
    await assert.rejects(prepareMacUpdate({ ...f.options, installerPath: link }, f.dependencies), { code: 'MAC_UPDATE_SYMLINK' });
  }
  await assert.rejects(prepareMacUpdate(f.options, { ...f.dependencies, platform: 'win32' }), { code: 'MAC_UPDATE_PLATFORM' });
});

test('rejects unwritable installation directory and translocated app before mounting', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    await chmod(f.root, 0o500);
    try { await assert.rejects(prepareMacUpdate(f.options, f.dependencies), { code: 'MAC_UPDATE_PERMISSION' }); }
    finally { await chmod(f.root, 0o700); }
  }
  const directory = path.join(f.root, 'AppTranslocation'); await mkdir(directory);
  const moved = path.join(directory, 'Current.app'); await rename(f.current, moved);
  await assert.rejects(prepareMacUpdate({ ...f.options, currentAppPath: moved }, f.dependencies), { code: 'MAC_UPDATE_LOCATION' });
  assert.equal(f.calls.filter(call => call.command.endsWith('/hdiutil')).length, 0);
});

for (const mode of ['timeout', 'malformed', 'early-exit']) test(`readiness ${mode} cancels and confirms helper stopped before rejecting`, async t => {
  const f = await fixture(t);
  const signals = [];
  let child;
  const spawnFixture = (_executable, args, options) => {
    child = new EventEmitter();
    child.unref = () => {};
    child.kill = signal => {
      signals.push(signal);
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(args[0].endsWith('install.cjs'), true);
    setImmediate(async () => {
      if (mode === 'malformed') await writeFile(args[13], '{not json');
      child.emit('spawn');
      if (mode === 'early-exit') child.emit('exit', 1, null);
    });
    return child;
  };
  const prepared = await prepareMacUpdate(f.options, { ...f.dependencies, spawn: spawnFixture, readinessTimeoutMs: 40 });
  await assert.rejects(prepared.launch(), { code: 'MAC_UPDATE_HELPER' });
  assert.equal(JSON.parse(await readFile(prepared.resultPath, 'utf8')).status, 'cancelled');
  await assert.rejects(lstat(path.join(path.dirname(prepared.resultPath), 'commit')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(path.dirname(prepared.resultPath), 'cancel'), 'utf8'), 'cancelled\n');
  if (mode !== 'early-exit') assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(JSON.parse(await readFile(path.join(f.current, 'Contents/Info.plist'))).CFBundleShortVersionString, '1.7.1');
  await prepared.dispose();
  await assert.rejects(lstat(path.dirname(prepared.resultPath)), { code: 'ENOENT' });
});

const nativeEnabled = process.platform === 'darwin' && process.env.XHS_MAC_UPDATE_NATIVE === '1';
test('native temporary signed app: read-only DMG preparation, replacement, and rollback', { skip: !nativeEnabled, timeout: 240000 }, async t => {
  // Electron 44 downloads its executable lazily from the package entry point.
  // npm ci alone does not create dist/. Resolve it before starting short-lived
  // fixture parent processes, and honor the package's platform/override paths.
  const electronExecutable = createRequire(import.meta.url)('electron');
  assert.equal((await lstat(electronExecutable)).isFile(), true, 'Electron executable is initialized');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'xhs-mac-update-native-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const payload = path.join(root, 'payload'); await mkdir(payload);
  const launchLog = path.join(root, 'launches.log');
  const hangFlag = path.join(root, 'hang-new-app');
  const candidatePidPath = path.join(root, 'candidate.pid');
  async function appBundle(directory, version) {
    await mkdir(path.join(directory, 'Contents/MacOS'), { recursive: true });
    await mkdir(path.join(directory, 'Contents/Resources'));
    const value = { ...metadata(version), CFBundleName: 'Brclio Update Fixture', CFBundleVersion: version, LSUIElement: true };
    const json = path.join(directory, 'Contents/Info.json'); await writeFile(json, JSON.stringify(value));
    await execute('/usr/bin/plutil', ['-convert', 'xml1', '-o', path.join(directory, 'Contents/Info.plist'), json]);
    await rm(json);
    const code = path.join(root, 'fixture.c');
    await writeFile(code, `#include <stdio.h>\n#include <unistd.h>\nint main(void) {\n  FILE *file = fopen(${JSON.stringify(launchLog)}, "a");\n  if (!file) return 2;\n  fputs("${version}\\n", file);\n  fclose(file);\n${version === '1.8.0' ? `  FILE *pidfile = fopen(${JSON.stringify(candidatePidPath)}, "w");\n  if (pidfile) { fprintf(pidfile, "%d", getpid()); fclose(pidfile); }\n  while (access(${JSON.stringify(hangFlag)}, F_OK) == 0) sleep(1);\n` : ''}  return 0;\n}\n`);
    await execute('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-arch', arch, code, '-o', path.join(directory, 'Contents/MacOS/fixture')]);
    await writeFile(path.join(directory, 'Contents/Resources/version.txt'), version);
    await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', directory]);
  }
  const source = path.join(payload, 'New application.app'); await appBundle(source, '1.8.0');
  const dmg = path.join(root, 'fixture.dmg');
  await execute('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Brclio Update Test', '-srcfolder', payload, '-format', 'UDZO', dmg], { timeout: 60000 });
  async function waitResult(filename, states) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const result = JSON.parse(await readFile(filename, 'utf8'));
      if (states.includes(result.status)) return result;
      if (!['prepared', 'ready', 'waiting', 'validating', 'replacing', 'launching', 'awaiting_startup', 'rolling_back', 'cleanup_pending', 'cleaning'].includes(result.status)) assert.fail(`Unexpected native result ${JSON.stringify(result)}`);
      await delay(100);
    }
    assert.fail('Native helper did not finish');
  }
  for (const outcome of ['installed', 'startup_timeout', 'startup_timeout_hung', 'rolled_back', 'candidate_corrupted', 'journal_unwritable', 'rollback_blocked', 'cancelled']) {
    const previousLaunches = await readFile(launchLog, 'utf8').catch(() => '');
    const fault = outcome === 'rolled_back';
    const startupTimeout = outcome.startsWith('startup_timeout');
    const candidateCorrupted = outcome === 'candidate_corrupted';
    const journalUnwritable = outcome === 'journal_unwritable';
    if (outcome === 'startup_timeout_hung') await writeFile(hangFlag, 'hang only this synthetic candidate');
    else await rm(hangFlag, { force: true });
    const current = path.join(root, outcome === 'installed' ? 'Fixture with quotes \' $().app' : `${outcome} fixture.app`);
    await appBundle(current, '1.7.1');
    const oldPid = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    t.after(() => { try { oldPid.kill(); } catch {} });
    await new Promise((resolve, reject) => { oldPid.once('spawn', resolve); oldPid.once('error', reject); });
    const prepared = await prepareMacUpdate({ installerPath: dmg, currentAppPath: current, expectedVersion: '1.8.0', expectedArch: process.arch,
      cacheDirectory: path.join(root, 'cache'), parentPid: oldPid.pid }, { startProgress: async () => ({ close: async () => {} }),
      ...(startupTimeout ? { startupTimeoutMs: 1500 } : {}),
      ...(fault ? { executable: electronExecutable } : {}), ...(outcome === 'cancelled' ? { readinessTimeoutMs: 0 } : {}) });
    await writeFile(path.join(root, 'cache/mac-last-install.json'), JSON.stringify({ resultPath: prepared.resultPath }), { mode: 0o600 });
    if (fault) {
      // Test-only fault injection: the real helper still performs both atomic
      // filesystem moves and codesign checks, then experiences an open failure.
      const helper = path.join(path.dirname(prepared.resultPath), 'install.cjs');
      const sourceText = await readFile(helper, 'utf8');
      assert.ok(sourceText.includes("await run('/usr/bin/open', ['-n', current], { timeout: 30000 });"));
      await writeFile(helper, sourceText.replace("await run('/usr/bin/open', ['-n', current], { timeout: 30000 });", "throw new Error('Injected open failure');"));
    }
    if (outcome === 'rollback_blocked') {
      const helper = path.join(path.dirname(prepared.resultPath), 'install.cjs');
      const sourceText = await readFile(helper, 'utf8');
      const original = 'await fs.rename(staged, current);';
      assert.ok(sourceText.includes(original));
      // Simulate another process creating a nonempty app between the absence
      // check and rename. A POSIX rename must refuse, never nest next.app.
      await writeFile(helper, sourceText.replace(original, "await fs.mkdir(current); await fs.writeFile(path.join(current, 'concurrent-owner'), 'preserve me'); " + original));
    }
    if (candidateCorrupted) {
      const helper = path.join(path.dirname(prepared.resultPath), 'install.cjs');
      const sourceText = await readFile(helper, 'utf8');
      const original = 'await fs.rename(staged, current);';
      assert.ok(sourceText.includes(original));
      await writeFile(helper, sourceText.replace(original, original + " await fs.writeFile(path.join(current, 'Contents/Info.plist'), 'damaged fixture plist');"));
    }
    if (journalUnwritable) {
      const helper = path.join(path.dirname(prepared.resultPath), 'install.cjs');
      const sourceText = await readFile(helper, 'utf8');
      const original = 'await fs.rename(staged, current);';
      assert.ok(sourceText.includes(original));
      // The replacement has happened, then every result journal write fails,
      // including rolling_back/rolled_back. Recovery must still run in full.
      await writeFile(helper, sourceText.replace(original, original + " await fs.mkdir(result + '.next');"));
    }
    if (outcome === 'cancelled') {
      await assert.rejects(prepared.launch(), { code: 'MAC_UPDATE_HELPER' });
      oldPid.kill();
      await delay(200);
      assert.equal(JSON.parse(await readFile(prepared.resultPath, 'utf8')).status, 'cancelled');
      assert.equal(await readFile(path.join(current, 'Contents/Resources/version.txt'), 'utf8'), '1.7.1', 'ordinary parent exit after failed launch cannot install later');
      await assert.rejects(lstat(path.join(path.dirname(prepared.resultPath), 'commit')), { code: 'ENOENT' });
      await prepared.dispose();
      continue;
    }
    const launching = prepared.launch();
    await assert.rejects(prepared.launch(), { code: 'MAC_UPDATE_LAUNCHED' });
    try { await launching; }
    catch (error) {
      // Print only this synthetic fixture's diagnostics, before cleanup removes
      // them. Node 22's TAP reporter omits Error.cause by default.
      t.diagnostic(JSON.stringify({ outcome, node: process.version, arch: process.arch,
        cause: error.cause && { name: error.cause.name, code: error.cause.code, message: error.cause.message, stack: error.cause.stack } }));
      t.diagnostic(`helper log: ${(await readFile(path.join(path.dirname(prepared.resultPath), 'helper.log'), 'utf8').catch(() => '')).slice(-6000)}`);
      t.diagnostic(`helper result: ${await readFile(prepared.resultPath, 'utf8').catch(() => 'unavailable')}`);
      throw error;
    }
    assert.ok(['ready', 'waiting'].includes(JSON.parse(await readFile(prepared.resultPath, 'utf8')).status));
    assert.equal(await readFile(path.join(path.dirname(prepared.resultPath), 'commit'), 'utf8'), 'approved\n');
    assert.equal(await readFile(path.join(current, 'Contents/Resources/version.txt'), 'utf8'), '1.7.1', 'helper cannot replace while old PID remains');
    oldPid.kill();
    if (journalUnwritable) {
      const expectedLaunches = `${previousLaunches}1.7.1\n`;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await readFile(launchLog, 'utf8').catch(() => '') === expectedLaunches) break;
        await delay(100);
      }
      assert.equal(await readFile(launchLog, 'utf8'), expectedLaunches, 'journal failure cannot prevent restoring and actually opening the old app');
      assert.equal(await readFile(path.join(current, 'Contents/Resources/version.txt'), 'utf8'), '1.7.1');
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', current]);
      await assert.rejects(lstat(prepared.backupPath), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(path.dirname(prepared.backupPath), 'failed.app/Contents/Resources/version.txt'), 'utf8'), '1.8.0');
      const log = await readFile(path.join(path.dirname(prepared.resultPath), 'helper.log'), 'utf8');
      assert.match(log, /Recovery journal write failed: rolling_back \(EISDIR\)/);
      assert.match(log, /Recovery journal write failed: rolled_back \(EISDIR\)/);
      assert.equal((await lstat(`${prepared.resultPath}.next`)).isDirectory(), true, 'rollback does not delete the obstructing path to fabricate a successful receipt');
      assert.equal(JSON.parse(await readFile(prepared.resultPath, 'utf8')).status, 'replacing', 'receipt is unavailable, so success is proven from app identity and actual relaunch');
      await prepared.dispose();
      continue;
    }
    if (outcome === 'installed') {
      await waitResult(prepared.resultPath, ['awaiting_startup']);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await readFile(launchLog, 'utf8').catch(() => '') === `${previousLaunches}1.8.0\n`) break;
        await delay(100);
      }
      assert.equal(await readFile(launchLog, 'utf8'), `${previousLaunches}1.8.0\n`, 'the new executable must actually run before readiness is confirmed');
      assert.equal(await readFile(path.join(prepared.backupPath, 'Contents/Resources/version.txt'), 'utf8'), '1.7.1', 'open success alone cannot delete the rollback copy');
      const completion = await confirmMacUpdateStartup({ cacheDirectory: path.join(root, 'cache'), currentAppPath: current, currentVersion: '1.8.0' });
      assert.equal(completion.cleaned, true, JSON.stringify(completion));
    }
    const result = await waitResult(prepared.resultPath, [startupTimeout || candidateCorrupted ? 'rolled_back' : outcome]);
    if (outcome === 'rollback_blocked') {
      assert.equal(await readFile(path.join(current, 'concurrent-owner'), 'utf8'), 'preserve me');
      assert.deepEqual(await readdir(current), ['concurrent-owner'], 'unknown concurrent app does not gain a nested replacement');
      assert.equal(await readFile(path.join(prepared.backupPath, 'Contents/Resources/version.txt'), 'utf8'), '1.7.1');
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', prepared.backupPath]);
    } else {
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', current]);
      assert.equal(await readFile(path.join(current, 'Contents/Resources/version.txt'), 'utf8'), fault || startupTimeout || candidateCorrupted ? '1.7.1' : '1.8.0');
      if (outcome === 'installed') {
        await assert.rejects(lstat(prepared.backupPath), { code: 'ENOENT' });
        await assert.rejects(lstat(path.dirname(prepared.backupPath)), { code: 'ENOENT' });
        assert.equal(result.backupRemoved, true);
        assert.equal(result.startupConfirmed, true);
      } else assert.equal(await readFile(path.join(result.failedAppPath, 'Contents/Resources/version.txt'), 'utf8'), '1.8.0');
      if (startupTimeout) assert.equal(result.failureCode, 'MAC_UPDATE_STARTUP_TIMEOUT');
      if (outcome === 'startup_timeout_hung') {
        const candidatePid = Number(await readFile(candidatePidPath, 'utf8'));
        assert.throws(() => process.kill(candidatePid, 0), { code: 'ESRCH' }, 'hung replacement main process stops before rollback');
      }
      const expectedLaunches = `${previousLaunches}${startupTimeout ? '1.8.0\n1.7.1' : fault || candidateCorrupted ? '1.7.1' : '1.8.0'}\n`;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await readFile(launchLog, 'utf8').catch(() => '') === expectedLaunches) break;
        await delay(100);
      }
      assert.equal(await readFile(launchLog, 'utf8'), expectedLaunches, 'the installed or restored application actually executes without any user click');
    }
    await prepared.dispose();
    assert.equal(JSON.parse(await readFile(prepared.resultPath, 'utf8')).status, result.status, 'post-launch disposal preserves recovery evidence');
  }
  // A real post-signing mutation must fail before replacing anything.
  await writeFile(path.join(source, 'Contents/Resources/version.txt'), 'tampered');
  const invalid = path.join(root, 'invalid.dmg');
  await execute('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Invalid Update Test', '-srcfolder', payload, '-format', 'UDZO', invalid], { timeout: 60000 });
  const current = path.join(root, 'Signature rejection.app'); await appBundle(current, '1.7.1');
  await assert.rejects(prepareMacUpdate({ installerPath: invalid, currentAppPath: current, expectedVersion: '1.8.0', expectedArch: process.arch,
    cacheDirectory: path.join(root, 'cache'), parentPid: process.pid }, { startProgress: async () => ({ close: async () => {} }) }), { code: 'MAC_UPDATE_SIGNATURE' });
  assert.equal(await readFile(path.join(current, 'Contents/Resources/version.txt'), 'utf8'), '1.7.1');
  t.diagnostic('Real local signed-app replacement, actual app execution, startup confirmation, temporary-backup removal and rollback passed. Crashed/hung candidates, corrupted candidate metadata and an unwritable recovery journal all restored and relaunched the old app; open failure and concurrent path replacement were also exercised. Temporary fixture apps only, no notarization or another Mac acceptance claim.');
});
