import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { confirmMacUpdateStartup } from '../desktop/mac-update-cleanup.js';
import { confirmMacUpdateStartupWithRetry } from '../desktop/startup-ready.js';

// Cleanup deliberately requires POSIX ownership and private directory modes;
// its real filesystem tests apply to macOS/Linux, never Windows ACL emulation.
const check = (name, callback) => test(name, { skip: process.platform === 'win32' }, callback);
const appId = 'cn.bornforthis.xhs-downloader';
const inode = stat => `${stat.dev}:${stat.ino}`;

async function fixture(t, { modern = false, status = 'installed', targetVersion = modern ? '1.8.3' : '1.8.2' } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'xhs-cleanup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'Current.app'), cache = path.join(root, 'cache');
  const data = path.join(root, 'saved-user-download.txt'); await writeFile(data, 'keep downloaded media');
  const unrelated = path.join(root, 'User previous.app'); await mkdir(unrelated); await writeFile(path.join(unrelated, 'keep.txt'), 'keep this app');
  async function bundle(directory, version) {
    await mkdir(path.join(directory, 'Contents/MacOS'), { recursive: true });
    await writeFile(path.join(directory, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: appId,
      CFBundlePackageType: 'APPL', CFBundleExecutable: 'fixture', CFBundleShortVersionString: version }));
    await writeFile(path.join(directory, 'Contents/MacOS/fixture'), 'fixture executable');
  }
  await bundle(current, '1.8.3');
  await mkdir(cache, { mode: 0o700 });
  const work = await mkdtemp(path.join(cache, 'mac-install-'));
  const stage = await mkdtemp(path.join(root, '.brclio-update-'));
  const backup = path.join(stage, 'previous.app'); await bundle(backup, '1.8.1');
  const recordPath = path.join(work, 'install-result.json');
  const lock = path.join(root, `.brclio-update-${createHash('sha256').update(current).digest('hex').slice(0, 16)}.lock`);
  const record = { status, version: targetVersion, appId, currentAppPath: current, backupPath: backup,
    failedAppPath: path.join(stage, 'failed.app'), lockPath: lock, launchRequested: status === 'installed' };
  if (modern) Object.assign(record, { schemaVersion: 2, startupToken: '1'.repeat(64),
    installedIdentity: inode(await lstat(current)), stageIdentity: inode(await lstat(stage)),
    backupIdentity: inode(await lstat(backup)), backupVersion: '1.8.1',
    backupInfoHash: createHash('sha256').update(await readFile(path.join(backup, 'Contents/Info.plist'))).digest('hex') });
  const save = () => writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  await save();
  const run = async (command, args) => {
    if (command.endsWith('/plutil')) return { stdout: await readFile(args.at(-1), 'utf8') };
    if (command.endsWith('/codesign')) return { stdout: '' };
    assert.fail(`Unexpected native command ${command}`);
  };
  return { root, current, cache, stage, work, backup, recordPath, lock, record, save, data, unrelated,
    options: { cacheDirectory: cache, currentAppPath: current, currentVersion: '1.8.3' },
    dependencies: { platform: 'darwin', uid: (await lstat(root)).uid, run } };
}

check('a healthy newer app cleans its legacy successful record without the already-removed pointer', async t => {
  const f = await fixture(t);
  const result = await confirmMacUpdateStartup(f.options, f.dependencies);
  assert.equal(result.cleaned, true, JSON.stringify(result));
  assert.deepEqual(result.cleanedBackups, [f.backup]);
  await assert.rejects(lstat(f.stage), { code: 'ENOENT' });
  assert.equal(await readFile(f.data, 'utf8'), 'keep downloaded media');
  assert.equal(await readFile(path.join(f.unrelated, 'keep.txt'), 'utf8'), 'keep this app');
  assert.equal(JSON.parse(await readFile(f.recordPath, 'utf8')).backupRemoved, true);
  assert.equal((await confirmMacUpdateStartup(f.options, f.dependencies)).cleaned, false, 'completed cleanup is idempotent');
});

check('modern startup acknowledges the exact transaction then waits for the helper to release its lock', async t => {
  const f = await fixture(t, { modern: true, status: 'awaiting_startup' });
  await writeFile(path.join(f.cache, 'mac-last-install.json'), JSON.stringify({ resultPath: f.recordPath }), { mode: 0o600 });
  await mkdir(f.lock, { mode: 0o700 });
  let acknowledged = false;
  const result = await confirmMacUpdateStartup(f.options, { ...f.dependencies, delay: async () => {
    const ready = JSON.parse(await readFile(path.join(f.work, 'startup-confirmed.json'), 'utf8'));
    assert.equal(ready.token, f.record.startupToken);
    assert.equal(ready.currentAppPath, f.current);
    assert.equal(ready.version, '1.8.3');
    assert.equal(ready.pid, process.pid);
    assert.equal((await lstat(f.backup)).isDirectory(), true, 'startup acknowledgement itself does not delete the backup');
    acknowledged = true;
    f.record.status = 'cleanup_pending'; await f.save(); await rm(f.lock, { recursive: true });
  } });
  assert.equal(acknowledged, true);
  assert.equal(result.cleaned, true, JSON.stringify(result));
  const installed = JSON.parse(await readFile(f.recordPath, 'utf8'));
  assert.equal(installed.startupConfirmed, true);
  assert.equal(installed.status, 'installed');
  assert.equal(installed.backupRemoved, true);
});

check('legacy helper launching race waits for installed success before cleaning this first upgrade', async t => {
  const f = await fixture(t, { status: 'launching', targetVersion: '1.8.3' });
  await mkdir(f.lock, { mode: 0o700 });
  const result = await confirmMacUpdateStartup(f.options, { ...f.dependencies, delay: async () => {
    await assert.rejects(lstat(path.join(f.work, 'startup-confirmed.json')), { code: 'ENOENT' });
    assert.equal((await lstat(f.backup)).isDirectory(), true);
    Object.assign(f.record, { status: 'installed', launchRequested: true }); await f.save();
    await rm(f.lock, { recursive: true });
  } });
  assert.equal(result.cleaned, true, JSON.stringify(result));
});

check('a healthy startup retries after the helper releases a lock later than the first cleanup timeout', async t => {
  const f = await fixture(t, { modern: true, status: 'awaiting_startup' });
  await mkdir(f.lock, { mode: 0o700 });
  let attempts = 0;
  const result = await confirmMacUpdateStartupWithRetry(f.options, {}, { retryDelayMs: 1,
    confirm: async options => {
      attempts++;
      const result = await confirmMacUpdateStartup(options, { ...f.dependencies, lockTimeoutMs: 0 });
      if (attempts === 1) {
        assert.equal(result.retained[0].code, 'MAC_UPDATE_LOCK_BUSY');
        assert.equal((await lstat(f.backup)).isDirectory(), true);
        const acknowledgement = JSON.parse(await readFile(path.join(f.work, 'startup-confirmed.json'), 'utf8'));
        assert.equal(acknowledgement.token, f.record.startupToken);
        // The real helper receives the acknowledgement, finishes its open
        // request, then releases the lock; the GUI must not need a restart.
        f.record.status = 'cleanup_pending'; await f.save();
        await rm(f.lock, { recursive: true });
      }
      return result;
    }
  });
  assert.equal(attempts, 2);
  assert.equal(result.cleaned, true, JSON.stringify(result));
  assert.equal(JSON.parse(await readFile(f.recordPath, 'utf8')).backupRemoved, true);
  assert.equal(await readFile(f.data, 'utf8'), 'keep downloaded media');
});

check('cleanup retries are bounded and never remove a held installation lock', async t => {
  const f = await fixture(t, { modern: true, status: 'awaiting_startup' });
  await mkdir(f.lock, { mode: 0o700 });
  let attempts = 0;
  const result = await confirmMacUpdateStartupWithRetry(f.options, {}, { retryDelayMs: 1,
    confirm: options => { attempts++; return confirmMacUpdateStartup(options, { ...f.dependencies, lockTimeoutMs: 0 }); }
  });
  assert.equal(attempts, 3);
  assert.equal(result.retained[0].code, 'MAC_UPDATE_LOCK_BUSY');
  assert.equal((await lstat(f.lock)).isDirectory(), true);
  assert.equal((await lstat(f.backup)).isDirectory(), true);
});

check('quit cancels deferred cleanup retry and identity failures never retry', async t => {
  for (const reason of ['quit', 'identity']) {
    const f = await fixture(t, { modern: true, status: 'cleanup_pending' });
    const cancel = new AbortController();
    if (reason === 'quit') await mkdir(f.lock, { mode: 0o700 });
    else { f.record.backupIdentity = '0:1'; await f.save(); }
    let attempts = 0;
    const result = await confirmMacUpdateStartupWithRetry(f.options, { signal: cancel.signal }, { retryDelayMs: 1000,
      confirm: async options => {
        attempts++;
        const result = await confirmMacUpdateStartup(options, { ...f.dependencies, lockTimeoutMs: 0 });
        if (reason === 'quit') cancel.abort();
        return result;
      }
    });
    assert.equal(attempts, 1, reason);
    assert.equal(result.cleaned, false);
    assert.equal((await lstat(f.backup)).isDirectory(), true);
  }
});

for (const change of ['failed update', 'different application', 'future update', 'same backup version',
  'wrong bundle id', 'extra staging content', 'unsafe backup location', 'different inode', 'different staging inode',
  'different installed inode', 'different backup hash', 'untrusted staging permissions']) {
  check(`retains backup for ${change}`, async t => {
    const f = await fixture(t, { modern: true });
    if (change === 'failed update') f.record.status = 'rolled_back';
    if (change === 'different application') f.record.currentAppPath = f.unrelated;
    if (change === 'future update') f.record.version = '9.0.0';
    if (change === 'same backup version' || change === 'wrong bundle id') {
      const filename = path.join(f.backup, 'Contents/Info.plist');
      const info = JSON.parse(await readFile(filename, 'utf8'));
      if (change === 'same backup version') info.CFBundleShortVersionString = '1.8.3';
      else info.CFBundleIdentifier = 'some.other.application';
      await writeFile(filename, JSON.stringify(info));
    }
    if (change === 'extra staging content') await writeFile(path.join(f.stage, 'do-not-delete.txt'), 'unrelated');
    if (change === 'unsafe backup location') f.record.backupPath = f.unrelated;
    if (change === 'different inode') f.record.backupIdentity = '0:1';
    if (change === 'different staging inode') f.record.stageIdentity = '0:1';
    if (change === 'different installed inode') f.record.installedIdentity = '0:1';
    if (change === 'different backup hash') f.record.backupInfoHash = 'a'.repeat(64);
    if (change === 'untrusted staging permissions') await chmod(f.stage, 0o777);
    await f.save();
    const result = await confirmMacUpdateStartup(f.options, f.dependencies);
    assert.equal(result.cleaned, false, JSON.stringify(result));
    assert.equal((await lstat(f.backup)).isDirectory(), true);
    assert.equal(await readFile(f.data, 'utf8'), 'keep downloaded media');
  });
}

check('a symlink previous.app never grants deletion of its target', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'actual-old.app'); await rename(f.backup, outside); await symlink(outside, f.backup);
  const result = await confirmMacUpdateStartup(f.options, f.dependencies);
  assert.equal(result.cleaned, false);
  assert.equal((await lstat(outside)).isDirectory(), true);
  assert.equal((await lstat(f.backup)).isSymbolicLink(), true);
});

check('signature rejection and a foreign owner never remove a backup', async t => {
  const f = await fixture(t);
  assert.equal((await confirmMacUpdateStartup(f.options, { ...f.dependencies, uid: f.dependencies.uid + 1 })).cleaned, false);
  const result = await confirmMacUpdateStartup(f.options, { ...f.dependencies, run: async (command, args) => {
    if (command.endsWith('/codesign') && args.at(-1) === f.backup) throw new Error('invalid signature');
    return f.dependencies.run(command, args);
  } });
  assert.equal(result.cleaned, false);
  assert.equal((await lstat(f.backup)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(f.recordPath, 'utf8')).status, 'cleanup_failed', 'cleanup failure is a visible terminal state, not endless progress');
});

check('a live or stale installation lock is never removed by cleanup', async t => {
  const f = await fixture(t);
  await mkdir(f.lock, { mode: 0o700 });
  const result = await confirmMacUpdateStartup(f.options, { ...f.dependencies, lockTimeoutMs: 0 });
  assert.equal(result.cleaned, false);
  assert.equal((await lstat(f.lock)).isDirectory(), true);
  assert.equal((await lstat(f.backup)).isDirectory(), true);
});

for (const interruption of ['renamed partial deletion', 'empty staging directory', 'removed staging directory', 'replaced cleanup inode']) {
  check(`cleanup resumes safely after ${interruption}`, async t => {
    const f = await fixture(t, { modern: true });
    const removingName = `.removing-${'a'.repeat(32)}.app`;
    Object.assign(f.record, { status: 'cleaning', startupConfirmed: true, cleanupProof: {
      stageIdentity: f.record.stageIdentity, backupIdentity: f.record.backupIdentity, backupVersion: '1.8.1', removingName
    } });
    const removing = path.join(f.stage, removingName);
    await rename(f.backup, removing);
    if (interruption === 'renamed partial deletion') await rm(path.join(removing, 'Contents'), { recursive: true });
    if (interruption === 'empty staging directory') await rm(removing, { recursive: true });
    if (interruption === 'removed staging directory') await rm(f.stage, { recursive: true });
    if (interruption === 'replaced cleanup inode') f.record.cleanupProof.backupIdentity = '0:1';
    await f.save();
    const result = await confirmMacUpdateStartup(f.options, f.dependencies);
    assert.equal(result.cleaned, interruption !== 'replaced cleanup inode', JSON.stringify(result));
    if (interruption === 'replaced cleanup inode') assert.equal((await lstat(removing)).isDirectory(), true);
    else {
      await assert.rejects(lstat(f.stage), { code: 'ENOENT' });
      assert.equal(JSON.parse(await readFile(f.recordPath, 'utf8')).backupRemoved, true);
    }
  });
}

test('unsupported platform or invalid startup metadata has no filesystem side effects', async () => {
  for (const options of [{ cacheDirectory: '.', currentAppPath: '/not-an-app', currentVersion: '1.8.3' },
    { cacheDirectory: '/unrelated', currentAppPath: '/App.app', currentVersion: 'invalid' }]) {
    assert.equal((await confirmMacUpdateStartup(options, { platform: 'darwin' })).cleaned, false);
    assert.equal((await confirmMacUpdateStartup(options, { platform: 'win32' })).cleaned, false);
  }
});

test('real Electron removes an archived bundle and resumes a legacy app.asar-only failed cleanup', {
  skip: process.platform !== 'darwin' || process.env.XHS_MAC_UPDATE_NATIVE !== '1', timeout: 45000
}, async t => {
  const require = createRequire(import.meta.url);
  const { createPackage } = require('@electron/asar');
  for (const legacyPartial of [false, true]) {
    const f = await fixture(t, { modern: !legacyPartial });
    const source = path.join(f.root, 'archive-source');
    await mkdir(source); await writeFile(path.join(source, 'entry.js'), 'module.exports = "archive fixture";');
    if (legacyPartial) {
      Object.assign(f.record, { status: 'cleanup_failed', startupConfirmed: true, cleanupProof: {
        stageIdentity: inode(await lstat(f.stage)), backupIdentity: inode(await lstat(f.backup)),
        backupVersion: '1.8.1', removingName: `.removing-${'a'.repeat(32)}.app`
      }, cleanupFailure: { code: 'ENOTEMPTY', message: 'previous archive deletion failed' } });
      await rm(path.join(f.backup, 'Contents'), { recursive: true });
      await f.save();
    }
    const resources = path.join(f.backup, 'Contents/Resources');
    await mkdir(resources, { recursive: true });
    await createPackage(source, path.join(resources, 'app.asar'));
    const runner = path.join(f.root, 'run-electron.cjs');
    const moduleUrl = new URL('../desktop/mac-update-cleanup.js', import.meta.url).href;
    await writeFile(runner, `const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(f.root, 'electron-profile'))});
app.dock?.hide();
app.whenReady().then(async () => {
  const { confirmMacUpdateStartup } = await import(${JSON.stringify(moduleUrl)});
  const fs = require('original-fs').promises;
  const result = await confirmMacUpdateStartup(${JSON.stringify(f.options)}, {
    run: async (command, args) => command.endsWith('/plutil')
      ? { stdout: await fs.readFile(args.at(-1), 'utf8') } : { stdout: '' }
  });
  process.stdout.write(JSON.stringify(result) + '\\n');
  app.exit(result.cleaned ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(require('electron'), [runner], { env, timeout: 20000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.cleaned, true, stdout);
    await assert.rejects(lstat(f.stage), { code: 'ENOENT' });
    const final = JSON.parse(await readFile(f.recordPath, 'utf8'));
    assert.equal(final.status, 'installed');
    assert.equal(final.cleanupFailure, null);
    assert.equal(await readFile(f.data, 'utf8'), 'keep downloaded media');
  }
});
