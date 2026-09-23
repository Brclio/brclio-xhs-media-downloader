import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
// Electron treats app.asar as a virtual directory. Recursive removal through
// its patched fs can leave the physical archive behind with ENOTEMPTY. Keep
// this operation on native filesystem APIs without changing global noAsar.
const nativeFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;
const { constants } = nativeFs;
const { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } = nativeFs.promises;
const APP_ID = 'cn.bornforthis.xhs-downloader';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const identity = stat => `${stat.dev}:${stat.ino}`;
const older = (left, right) => {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
};
const reject = message => { throw new Error(message); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);

/** Call only after the packaged app and its renderer have successfully started.
 * All deletion is restricted to this app's recorded private update staging
 * directories. The cache, downloaded installers, user data, failed candidates,
 * and unrelated bundles are never recursively removed by this function.
 */
export async function confirmMacUpdateStartup({ cacheDirectory, currentAppPath, currentVersion }, dependencies = {}) {
  const result = { confirmed: false, cleaned: false, status: 'none', cleanedBackups: [], retained: [] };
  if ((dependencies.platform || process.platform) !== 'darwin' || !absolute(cacheDirectory)
    || !absolute(currentAppPath) || !versionPattern.test(currentVersion || '')) return result;
  const uid = dependencies.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid)) return result;
  const run = dependencies.run || ((command, args) => execute(command, args, { timeout: 120000, maxBuffer: 1024 * 1024 }));
  const pause = dependencies.delay || delay;
  async function safeStat(filename, directory = false, privateDirectory = false) {
    const stat = await lstat(filename);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== uid
      || stat.mode & (privateDirectory ? 0o077 : 0o022) || await realpath(filename) !== filename
      || (!directory && stat.nlink !== 1)) reject('更新记录或应用路径的类型、所有者或权限不匹配。');
    return stat;
  }
  async function json(filename) {
    const stat = await safeStat(filename);
    if (stat.size > 16000) reject('更新记录过大。');
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (identity(await file.stat()) !== identity(stat)) reject('更新记录发生变化。');
      return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  }
  async function store(filename, value) {
    const next = `${filename}.${randomBytes(12).toString('hex')}.next`;
    try { await writeFile(next, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await rename(next, filename); }
    finally { await rm(next, { force: true }).catch(() => {}); }
  }
  async function bundleInfo(bundle) {
    const stat = await safeStat(bundle, true);
    const plist = path.join(bundle, 'Contents/Info.plist');
    await safeStat(plist);
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
    const info = JSON.parse(stdout);
    if (info.CFBundleIdentifier !== APP_ID || info.CFBundlePackageType !== 'APPL'
      || !versionPattern.test(info.CFBundleShortVersionString || '')
      || typeof info.CFBundleExecutable !== 'string' || !info.CFBundleExecutable
      || /[\/\\\0\r\n]/.test(info.CFBundleExecutable) || ['.', '..'].includes(info.CFBundleExecutable)) reject('应用身份或版本不匹配。');
    const executable = path.join(bundle, 'Contents/MacOS', info.CFBundleExecutable);
    await safeStat(executable);
    if (!(await realpath(executable)).startsWith(`${bundle}${path.sep}`)) reject('应用可执行文件超出其目录。');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
    return { stat, version: info.CFBundleShortVersionString,
      infoHash: createHash('sha256').update(await readFile(plist)).digest('hex') };
  }
  let cache, current;
  try {
    cache = await realpath(cacheDirectory);
    current = await realpath(currentAppPath);
    // realpath may normalize /var or a user's home; the bundle itself must not
    // be a symlink and a cache cannot live inside an application being deleted.
    if ((await lstat(currentAppPath)).isSymbolicLink() || !current.endsWith('.app')
      || cache === current || cache.startsWith(`${current}${path.sep}`)) return result;
    await safeStat(cache, true);
    await safeStat(current, true);
  } catch { return result; }
  const parent = path.dirname(current);
  const lock = path.join(parent, `.brclio-update-${createHash('sha256').update(current).digest('hex').slice(0, 16)}.lock`);
  const records = new Set();
  const validRecordPath = file => absolute(file) && path.basename(file) === 'install-result.json'
    && path.dirname(path.dirname(file)) === cache && /^mac-install-[a-zA-Z0-9]{6}$/.test(path.basename(path.dirname(file)));
  try {
    const pointer = await json(path.join(cache, 'mac-last-install.json'));
    if (validRecordPath(pointer.resultPath)) { records.add(pointer.resultPath); result.resultPath = pointer.resultPath; }
  } catch { /* Older successful startups already removed the pointer. */ }
  try {
    for (const entry of await readdir(cache, { withFileTypes: true })) {
      if (entry.isDirectory() && /^mac-install-[a-zA-Z0-9]{6}$/.test(entry.name)) records.add(path.join(cache, entry.name, 'install-result.json'));
    }
  } catch { return result; }
  let running;
  for (const recordPath of records) {
    let ownsLock = false, record;
    try {
      const work = path.dirname(recordPath);
      await safeStat(work, true, true);
      record = await json(recordPath);
      if (record.appId !== APP_ID || record.currentAppPath !== current || !versionPattern.test(record.version || '')
        || older(currentVersion, record.version) || record.backupRemoved === true) continue;
      const sameVersion = record.version === currentVersion;
      const modern = record.schemaVersion >= 2;
      const pending = ['launching', 'awaiting_startup', 'startup_unconfirmed', 'cleanup_pending'].includes(record.status);
      const interrupted = record.startupConfirmed === true && ['cleaning', 'cleanup_failed'].includes(record.status);
      const legacyLaunching = sameVersion && !modern && record.status === 'launching';
      if (!(record.status === 'installed' && (modern || record.launchRequested === true))
        && !(sameVersion && modern && pending) && !legacyLaunching && !interrupted) continue;
      if (!running) running = await bundleInfo(current);
      if (running.version !== currentVersion) reject('正在运行的版本与磁盘应用版本不匹配。');
      result.confirmed = true;
      if (modern && sameVersion && record.installedIdentity !== identity(running.stat)) reject('当前应用已被其他操作替换。');
      if (modern && sameVersion && ['launching', 'awaiting_startup'].includes(record.status)) {
        if (!/^[a-f0-9]{64}$/.test(record.startupToken || '')) reject('缺少有效的启动确认标识。');
        await store(path.join(work, 'startup-confirmed.json'), { token: record.startupToken,
          currentAppPath: current, version: currentVersion, appId: APP_ID, pid: process.pid, confirmedAt: new Date().toISOString() });
      }
      const deadline = Date.now() + (dependencies.lockTimeoutMs ?? 15000);
      while (true) {
        try { await mkdir(lock, { mode: 0o700 }); ownsLock = true; break; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (Date.now() >= deadline) reject('安装助手尚未完成，已保留临时恢复文件。');
          await pause(50);
        }
      }
      record = await json(recordPath);
      if (record.appId !== APP_ID || record.currentAppPath !== current || !versionPattern.test(record.version || '')
        || older(currentVersion, record.version) || record.backupRemoved === true) continue;
      if (!(record.status === 'installed' && (modern || record.launchRequested === true))
        && !(modern && sameVersion && ['cleanup_pending', 'startup_unconfirmed'].includes(record.status))
        && !(record.startupConfirmed === true && ['cleaning', 'cleanup_failed'].includes(record.status))) {
        reject('本次安装没有成功完成，已保留临时恢复文件。');
      }
      if (record.lockPath !== lock || !absolute(record.backupPath) || path.basename(record.backupPath) !== 'previous.app') reject('恢复文件路径与安装记录不匹配。');
      const stage = path.dirname(record.backupPath);
      if (path.dirname(stage) !== parent || !/^\.brclio-update-[a-zA-Z0-9]{6}$/.test(path.basename(stage))
        || record.failedAppPath !== path.join(stage, 'failed.app')) reject('恢复文件不在本应用的临时安装目录。');
      let stageStat;
      const proof = record.cleanupProof;
      const resumeCleanup = record.startupConfirmed === true && ['cleaning', 'cleanup_failed'].includes(record.status) && proof
        && /^[0-9]+:[0-9]+$/.test(proof.stageIdentity || '') && /^[0-9]+:[0-9]+$/.test(proof.backupIdentity || '')
        && versionPattern.test(proof.backupVersion || '') && older(proof.backupVersion, record.version)
        && /^\.removing-[a-f0-9]{32}\.app$/.test(proof.removingName || '');
      const finish = async () => {
        // A previous attempt may have deleted the app and crashed before its
        // final journal write. Finishing that receipt never deletes new paths.
        await store(recordPath, { ...record, status: 'installed', startupConfirmed: true, backupRemoved: true,
          cleanupFailure: null, cleanedAt: new Date().toISOString(), message: '新版已成功启动，临时旧版文件已自动清理。' });
        result.cleanedBackups.push(record.backupPath);
      };
      try { stageStat = await safeStat(stage, true, true); }
      catch (error) { if (error.code === 'ENOENT' && resumeCleanup) { await finish(); continue; } throw error; }
      if (modern && record.stageIdentity !== identity(stageStat)) reject('临时安装目录已发生变化。');
      const entries = await readdir(stage);
      let previous, source = record.backupPath;
      if (resumeCleanup) {
        if (proof.stageIdentity !== identity(stageStat)) reject('上次清理的临时目录已发生变化。');
        if (!entries.length) { await rmdir(stage); await finish(); continue; }
        if (entries.length !== 1 || !['previous.app', proof.removingName].includes(entries[0])) reject('上次清理目录包含其他内容，已保留。');
        source = path.join(stage, entries[0]);
        const stat = await safeStat(source, true);
        if (identity(stat) !== proof.backupIdentity) reject('上次清理的旧版目录已被替换。');
        // Its code signature was checked before writing this private receipt;
        // an interrupted recursive removal may already have deleted the seal.
        previous = { stat, version: proof.backupVersion };
      } else {
        if (entries.length !== 1 || entries[0] !== 'previous.app') reject('临时安装目录包含其他内容，已保留。');
        previous = await bundleInfo(source);
        if (!older(previous.version, record.version)) reject('恢复文件不是本次更新之前的版本。');
        if (modern && (record.backupIdentity !== identity(previous.stat) || record.backupInfoHash !== previous.infoHash
          || record.backupVersion !== previous.version)) reject('恢复文件已被其他操作替换。');
      }
      if (identity(await safeStat(current, true)) !== identity(running.stat)
        || identity(await safeStat(stage, true, true)) !== identity(stageStat)
        || identity(await safeStat(source, true)) !== identity(previous.stat)) reject('应用目录在清理前发生变化。');
      const removingName = resumeCleanup ? proof.removingName : `.removing-${randomBytes(16).toString('hex')}.app`;
      record = { ...record, status: 'cleaning', startupConfirmed: true, message: '新版已成功启动，正在清理临时旧版文件。',
        cleanupProof: { stageIdentity: identity(stageStat), backupIdentity: identity(previous.stat), backupVersion: previous.version, removingName } };
      await store(recordPath, record);
      const removing = path.join(stage, removingName);
      if (source !== removing) await rename(source, removing);
      try {
        if (identity(await safeStat(removing, true)) !== identity(previous.stat)) reject('清理目标在移动时发生变化。');
        await rm(removing, { recursive: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        // Never remove another directory if the validated inode changed.
        await rename(removing, record.backupPath).catch(() => {});
        throw error;
      }
      await rmdir(stage); // Only an empty staging directory can be removed.
      await finish();
    } catch (error) {
      const failure = { code: error.code || 'MAC_UPDATE_CLEANUP', message: error.message };
      result.retained.push({ resultPath: recordPath, ...failure });
      if (ownsLock && record?.currentAppPath === current && running?.version === currentVersion
        && ['installed', 'cleanup_pending', 'startup_unconfirmed', 'cleaning', 'cleanup_failed'].includes(record.status)) {
        await store(recordPath, { ...record, status: 'cleanup_failed', startupConfirmed: true, cleanupFailure: failure,
          message: '新版已启动，临时旧版未能完成清理，已保留记录以便重试。' }).catch(() => {});
      }
    }
    finally { if (ownsLock) await rmdir(lock).catch(() => {}); }
  }
  result.cleaned = result.cleanedBackups.length > 0;
  result.status = result.cleaned ? 'cleaned' : result.retained.length ? 'retained' : 'none';
  return result;
}
