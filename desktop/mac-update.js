import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startMacInstallProgress } from './mac-install-progress.js';

const execute = promisify(execFile);
const nativeFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;
const { constants } = nativeFs;
const { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } = nativeFs.promises;
const APP_ID = 'cn.bornforthis.xhs-downloader';
const fail = (code, message, cause) => { throw Object.assign(new Error(message, cause ? { cause } : undefined), { code }); };
const contained = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

// Static Node helper runs using the app's existing Electron executable in
// ELECTRON_RUN_AS_NODE mode. All native modules are loaded before the old app
// moves. Paths are arguments, never source interpolation; fs.rename cannot
// accidentally nest the new bundle inside an unexpected destination directory.
const HELPER = String.raw`'use strict';
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function guiEnvironment() {
  // This helper must stay in Node mode, but LaunchServices inherits open's
  // environment. Leaking that mode makes an Electron GUI exit successfully
  // without ever loading its main process, including during rollback.
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH']) delete env[name];
  return env;
}
const [current, staged, backup, failed, currentInode, stagedInode, infoHash,
  parentPidText, appId, version, architecture, work, result, lock] = process.argv.slice(2);
const parentPid = Number(parentPidText);
let ownsLock = false, replacementStarted = false, candidateExecutable;
async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function inode(filename) {
  const value = await fs.lstat(filename);
  return value.dev + ':' + value.ino;
}
async function status(name, detail = {}) {
  const record = JSON.parse(await fs.readFile(path.join(work, name + '.json'), 'utf8'));
  await fs.writeFile(result + '.next', JSON.stringify({ ...record, ...detail }), { mode: 0o600 });
  await fs.rename(result + '.next', result);
}
async function recoveryStatus(name, detail = {}) {
  // Journaling must never become a prerequisite for restoring the old app.
  // The original installation error may itself be a full disk or an
  // unwritable journal. Filesystem and process identity checks still throw.
  try { await status(name, detail); }
  catch (error) { console.error('Recovery journal write failed: ' + name + ' (' + (error.code || error.name) + ')'); }
}
function parentAlive() { try { process.kill(parentPid, 0); return true; } catch { return false; } }
async function verify(bundle) {
  const stat = await fs.lstat(bundle);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid application directory');
  const parsed = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')], { timeout: 30000 })).stdout);
  if (parsed.CFBundleIdentifier !== appId || parsed.CFBundleShortVersionString !== version
    || parsed.CFBundlePackageType !== 'APPL' || typeof parsed.CFBundleExecutable !== 'string'
    || !parsed.CFBundleExecutable || /[\/\\\0\r\n]/.test(parsed.CFBundleExecutable)
    || ['.', '..'].includes(parsed.CFBundleExecutable)) throw new Error('Application identity mismatch');
  const executable = path.join(bundle, 'Contents/MacOS', parsed.CFBundleExecutable);
  if (!(await fs.lstat(executable)).isFile() || !(await fs.realpath(executable)).startsWith((await fs.realpath(bundle)) + path.sep)) throw new Error('Invalid executable path');
  const architectures = (await run('/usr/bin/lipo', ['-archs', executable], { timeout: 30000 })).stdout.trim().split(/\s+/);
  if (!architectures.includes(architecture)) throw new Error('Application architecture mismatch');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { timeout: 120000 });
  return parsed.CFBundleExecutable;
}
async function candidateProcesses() {
  if (await inode(current) !== stagedInode) throw new Error('Installed application changed before rollback');
  // Use the executable name from the already verified staging bundle. A
  // damaged candidate plist must not prevent restoring the complete old app.
  const executable = path.join(current, 'Contents/MacOS', candidateExecutable);
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 10000 });
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    const pid = Number(match?.[1]);
    return match?.[2] === executable && pid > 1 && pid !== process.pid && pid !== parentPid ? [pid] : [];
  });
}
async function stopCandidate() {
  // An accepted open(1) request can leave a crashed or hung main process.
  // Only signal processes whose executable is this exact installed bundle;
  // never act on a PID merely supplied by a confirmation file.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of await candidateProcesses()) {
      try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const deadline = Date.now() + (signal === 'SIGTERM' ? 5000 : 2000);
    while (Date.now() < deadline) {
      if (!(await candidateProcesses()).length) return;
      await sleep(100);
    }
  }
  throw new Error('New application did not stop; rollback copy retained');
}
async function rollback(detail = {}) {
  try {
    await recoveryStatus('rolling_back', detail);
    if (await inode(backup) !== currentInode) throw new Error('Rollback application changed');
    if (await exists(current)) {
      if ((await fs.lstat(current)).isSymbolicLink() || await inode(current) !== stagedInode) {
        await recoveryStatus('rollback_blocked'); return;
      }
      await stopCandidate();
      if (await inode(current) !== stagedInode) throw new Error('Installed application changed during rollback');
      if (await exists(failed)) throw new Error('Recovery destination occupied');
      await fs.rename(current, failed);
    }
    await fs.rename(backup, current);
    if (await inode(current) !== currentInode) throw new Error('Restored application changed');
    await recoveryStatus('rolled_back', { ...detail, ...(detail.failureCode === 'MAC_UPDATE_STARTUP_TIMEOUT'
      ? { message: '新版未能在限定时间内完成启动，已恢复旧应用并请求重新打开。' } : {}) });
    await run('/usr/bin/open', ['-n', current], { timeout: 30000, env: guiEnvironment() }).catch(error => {
      console.error('Restored application launch request failed:', error.code || error.name);
    });
  } catch (error) { await recoveryStatus('rollback_failed', { ...detail, failureCode: error.code || 'MAC_UPDATE_ROLLBACK', failureDetail: error.message }); }
  finally { process.exitCode = 1; }
}
async function main() {
  await status('ready');
  const deadline = Date.now() + 30000;
  while (!await exists(path.join(work, 'commit'))) {
    if (await exists(path.join(work, 'cancel')) || !parentAlive()) { await status('cancelled'); return; }
    if (Date.now() >= deadline) { await status('readiness_timeout'); process.exitCode = 1; return; }
    await sleep(50);
  }
  // Without this explicit commit, a later ordinary app quit never installs.
  await status('waiting');
  const quitDeadline = Date.now() + 300000;
  while (parentAlive()) {
    if (Date.now() >= quitDeadline) { await status('parent_timeout'); process.exitCode = 1; return; }
    await sleep(100);
  }
  try { await fs.mkdir(lock, { mode: 0o700 }); ownsLock = true; }
  catch { await status('install_locked'); process.exitCode = 1; return; }
  try {
    const stat = await fs.lstat(current);
    const hash = crypto.createHash('sha256').update(await fs.readFile(path.join(current, 'Contents/Info.plist'))).digest('hex');
    if (!stat.isDirectory() || stat.isSymbolicLink() || await inode(current) !== currentInode || hash !== infoHash) {
      await status('current_changed'); process.exitCode = 1; return;
    }
    await status('validating');
    try { if (await inode(staged) !== stagedInode) throw new Error('Staging changed'); candidateExecutable = await verify(staged); }
    catch { await status('candidate_invalid'); process.exitCode = 1; return; }
    if (await exists(backup)) { await status('backup_exists'); process.exitCode = 1; return; }
    await status('replacing');
    try { await fs.rename(current, backup); replacementStarted = true; }
    catch { await status('replace_failed'); process.exitCode = 1; return; }
    try {
      if (await inode(backup) !== currentInode || await exists(current)) throw new Error('Concurrent application replacement');
      await fs.rename(staged, current);
      if (await inode(current) !== stagedInode) throw new Error('Unexpected installed application');
      await verify(current);
      await status('launching');
      // This helper still runs with the old bundle's Electron executable.
      // Force a new instance so LaunchServices cannot merely activate it.
      await run('/usr/bin/open', ['-n', current], { timeout: 30000, env: guiEnvironment() });
    } catch (error) { await rollback({ failureCode: error.code || 'MAC_UPDATE_LAUNCH', failureDetail: error.message }); return; }
    await status('awaiting_startup');
    const expected = JSON.parse(await fs.readFile(result, 'utf8'));
    const startupDeadline = Date.now() + expected.startupTimeoutMs;
    while (Date.now() < startupDeadline) {
      try {
        const filename = path.join(work, 'startup-confirmed.json');
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 4096) throw new Error('Invalid startup confirmation');
        const confirmed = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (confirmed.token !== expected.startupToken || confirmed.currentAppPath !== current
          || confirmed.version !== version || confirmed.appId !== appId || !Number.isSafeInteger(confirmed.pid)
          || confirmed.pid <= 1 || confirmed.pid === parentPid) throw new Error('Startup confirmation mismatch');
        process.kill(confirmed.pid, 0);
        if (await inode(current) !== stagedInode) throw new Error('Installed application changed');
        // The healthy new process performs guarded cleanup after this helper
        // releases its installation lock. open(1) succeeding is not readiness.
        await status('cleanup_pending');
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('Waiting for valid startup confirmation:', error.message);
      }
      await sleep(100);
    }
    await rollback({ failureCode: 'MAC_UPDATE_STARTUP_TIMEOUT' });
  } catch (error) {
    // Journal or startup-handshake errors after replacement must not strand
    // the user with an unconfirmed app merely because open(1) succeeded.
    if (replacementStarted) await rollback({ failureCode: error.code || 'MAC_UPDATE_HELPER', failureDetail: error.message });
    else { await status('helper_failed', { failureCode: error.code || 'MAC_UPDATE_HELPER', failureDetail: error.message }); process.exitCode = 1; }
  } finally { if (ownsLock) await fs.rmdir(lock).catch(() => {}); }
}
main().catch(async error => {
  console.error(error);
  await status('helper_failed').catch(() => {});
  if (ownsLock) await fs.rmdir(lock).catch(() => {});
  process.exitCode = 1;
});
`;

const RESULTS = {
  ready: '安装助手已准备好，尚未批准替换。', cancelled: '安装准备已取消，当前应用未修改。',
  readiness_timeout: '未收到安装批准，已取消替换。', helper_failed: '安装助手遇到错误，恢复记录已保留。',
  waiting: '等待旧应用退出，当前应用尚未修改。', replacing: '正在替换应用，旧版本暂存用于失败恢复。',
  validating: '正在确认新版应用完整性，准备覆盖安装。', launching: '覆盖安装已完成，正在自动打开新版应用。',
  awaiting_startup: '正在等待新版应用完成启动。', cleanup_pending: '新版已确认启动，正在清理临时旧版文件。',
  startup_unconfirmed: '新版启动尚未确认，临时旧版已保留供恢复。请尝试打开新版应用。',
  installed: '新版已成功启动，临时旧版文件已自动清理。',
  rolling_back: '新版未能完成安装或启动，正在关闭新版并恢复旧应用。',
  rolled_back: '安装或启动请求失败，已恢复旧应用并请求重新打开。',
  rollback_blocked: '应用路径被其他操作修改，未覆盖该路径。旧应用备份已保留，请手动恢复。',
  rollback_failed: '自动恢复未完成；旧应用备份已保留，请手动恢复。',
  parent_timeout: '旧应用未在 5 分钟内退出，取消替换。', current_changed: '当前应用在准备后发生变化，取消替换。',
  candidate_invalid: '待安装应用的身份、架构或签名校验失败，取消替换。',
  backup_exists: '备份路径已被占用，取消替换。', replace_failed: '无法移动当前应用，取消替换。',
  install_locked: '另一个安装助手正在处理此应用，取消本次替换。若上次安装异常退出，请根据安装记录手动处理。'
};

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) fail('MAC_UPDATE_PATH', `${label}路径无效，请手动安装更新。`);
  return path.resolve(value);
}

/** Prepare an already SHA256-verified DMG. The caller must be a packaged Mac
 * main process, confirm with the user, and quit only after launch() resolves.
 * Ad hoc signatures verify integrity, not Developer ID or notarization.
 * No security assessment or quarantine is disabled by this module.
 */
export async function prepareMacUpdate({ installerPath, currentAppPath, expectedVersion,
  expectedAppId = APP_ID, expectedArch, cacheDirectory, parentPid = process.pid }, dependencies = {}) {
  const run = dependencies.run || ((command, args, options = {}) => execute(command, args, {
    timeout: 120000, maxBuffer: 4 * 1024 ** 2, ...options
  }));
  const spawnHelper = dependencies.spawn || spawn;
  const helperExecutable = dependencies.executable || process.execPath;
  const readinessTimeoutMs = dependencies.readinessTimeoutMs ?? 5000;
  if ((dependencies.platform || process.platform) !== 'darwin') fail('MAC_UPDATE_PLATFORM', '原位更新仅适用于 macOS。');
  if (expectedAppId !== APP_ID || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expectedVersion || '')
    || !['arm64', 'x64'].includes(expectedArch) || !Number.isSafeInteger(parentPid) || parentPid <= 1) {
    fail('MAC_UPDATE_METADATA', '更新身份、版本、架构或进程信息无效，请重新检查更新。');
  }
  const arch = expectedArch === 'x64' ? 'x86_64' : 'arm64';
  let current = absolute(currentAppPath, '当前应用');
  let installer = absolute(installerPath, '安装包');
  let cache = absolute(cacheDirectory, '更新缓存');
  if (!current.endsWith('.app') || !installer.toLowerCase().endsWith('.dmg')) fail('MAC_UPDATE_PATH', '请选择已安装的应用和完整 DMG 安装包。');
  if (contained(current, cache)) fail('MAC_UPDATE_PATH', '更新缓存不能放在待替换应用内部。');
  try {
    if ((await lstat(current)).isSymbolicLink() || (await lstat(installer)).isSymbolicLink()) fail('MAC_UPDATE_SYMLINK', '应用或安装包不能是符号链接，请手动安装更新。');
    current = await realpath(current); installer = await realpath(installer);
    if (!(await lstat(current)).isDirectory() || !(await lstat(installer)).isFile()) fail('MAC_UPDATE_PATH', '当前应用或安装包不存在，请重新下载安装包。');
  } catch (cause) {
    if (cause.code?.startsWith('MAC_UPDATE_')) throw cause;
    fail('MAC_UPDATE_PATH', '无法读取当前应用或安装包，请重新下载安装包或手动安装。', cause);
  }
  if (contained('/Volumes', current) || current.includes('/AppTranslocation/')) fail('MAC_UPDATE_LOCATION', '请先将应用移到“应用程序”文件夹并从那里打开，再使用在线覆盖更新。');
  const parent = path.dirname(current);
  try { await access(parent, constants.W_OK); }
  catch (cause) { fail('MAC_UPDATE_PERMISSION', '当前应用所在文件夹不可写。请手动打开 DMG 安装更新；应用不会请求管理员密码。', cause); }
  async function info(bundle) {
    try {
      const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')]);
      const value = JSON.parse(stdout);
      if (value.CFBundleIdentifier !== expectedAppId || value.CFBundlePackageType !== 'APPL') throw new Error('Bundle identity mismatch');
      const executable = value.CFBundleExecutable;
      if (typeof executable !== 'string' || !executable || ['.', '..'].includes(executable) || /[\/\\\0\r\n]/.test(executable)) throw new Error('Invalid bundle executable');
      return value;
    } catch (cause) { fail('MAC_UPDATE_IDENTITY', '应用标识不匹配或 Info.plist 无效，已停止覆盖更新。', cause); }
  }
  async function verify(bundle) {
    const metadata = await info(bundle);
    if (metadata.CFBundleShortVersionString !== expectedVersion) fail('MAC_UPDATE_VERSION', '安装包中的版本与更新版本不一致，已停止安装。');
    let architectures;
    try {
      const executable = path.join(bundle, 'Contents/MacOS', metadata.CFBundleExecutable);
      if (!(await lstat(executable)).isFile() || !contained(await realpath(bundle), await realpath(executable))) throw new Error('Executable must be inside the app bundle');
      architectures = (await run('/usr/bin/lipo', ['-archs', executable])).stdout.trim().split(/\s+/);
    }
    catch (cause) { fail('MAC_UPDATE_ARCH', '无法确认应用处理器架构，已停止安装。', cause); }
    if (!architectures.includes(arch)) fail('MAC_UPDATE_ARCH', '此安装包不支持当前处理器，请下载对应版本。');
    try { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]); }
    catch (cause) { fail('MAC_UPDATE_SIGNATURE', '应用完整签名校验失败，已停止安装。请重新下载完整安装包。', cause); }
  }
  const previousInfo = await info(current);
  await mkdir(cache, { recursive: true, mode: 0o700 }); cache = await realpath(cache);
  if (contained(current, cache)) fail('MAC_UPDATE_PATH', '更新缓存不能放在待替换应用内部。');
  let stageDirectory, work, mountpoint, mounted = false, committed = false, launching = false, disposed = false;
  let child, childExited, childStopped = true, progressWindow;
  const detach = async () => {
    if (!mounted) return;
    await run('/usr/bin/hdiutil', ['detach', mountpoint], { timeout: 30000 }); mounted = false;
  };
  try {
    try { stageDirectory = await mkdtemp(path.join(parent, '.brclio-update-')); await chmod(stageDirectory, 0o700); }
    catch (cause) { fail('MAC_UPDATE_PERMISSION', '无法在当前应用旁准备更新。请移到可写文件夹，或手动打开 DMG 安装。', cause); }
    work = await mkdtemp(path.join(cache, 'mac-install-')); await chmod(work, 0o700);
    const resultPath = path.join(work, 'install-result.json');
    async function progress(status, message) {
      await writeFile(`${resultPath}.next`, JSON.stringify({ status, message, version: expectedVersion,
        currentAppPath: current }), { mode: 0o600 });
      await rename(`${resultPath}.next`, resultPath);
    }
    await progress('preparing', '正在准备覆盖安装，请保持设备开启。');
    progressWindow = await (dependencies.startProgress || startMacInstallProgress)({ resultPath, version: expectedVersion });
    mountpoint = path.join(work, 'mount'); await mkdir(mountpoint, { mode: 0o700 });
    try {
      await progress('opening', '正在打开更新安装包。');
      mounted = true;
      const attached = await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, '-plist', installer]);
      const plist = path.join(work, 'attach.plist'); await writeFile(plist, attached.stdout, { mode: 0o600 });
      const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
      const volumes = JSON.parse(stdout)['system-entities']?.filter(entity => entity['mount-point']);
      if (!Array.isArray(volumes) || volumes.length !== 1 || path.resolve(volumes[0]['mount-point']) !== mountpoint) throw new Error('Unexpected mounted volumes');
    } catch (cause) { fail('MAC_UPDATE_MOUNT', '无法只读打开 DMG，或安装包包含意外的卷。请重新下载或手动安装。', cause); }
    const entries = (await readdir(mountpoint, { withFileTypes: true })).filter(entry => entry.name.endsWith('.app'));
    if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].isSymbolicLink()) fail('MAC_UPDATE_CONTENTS', 'DMG 必须只包含一个完整应用，已停止安装。');
    await progress('verifying', '正在校验新版应用的版本、架构和完整性。');
    const source = path.join(mountpoint, entries[0].name); await verify(source);
    const staged = path.join(stageDirectory, 'next.app'), backup = path.join(stageDirectory, 'previous.app'), failed = path.join(stageDirectory, 'failed.app');
    await progress('copying', '正在复制新版应用文件，请稍候。');
    await run('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', source, staged], { timeout: 300000 });
    await progress('checking', '正在检查复制结果，确保新版应用完整。');
    await verify(staged); await detach();
    const currentStat = await lstat(current), stagedStat = await lstat(staged);
    const stageStat = await lstat(stageDirectory);
    const inode = value => `${value.dev}:${value.ino}`;
    if (currentStat.dev !== stagedStat.dev) fail('MAC_UPDATE_VOLUME', '更新临时文件与当前应用不在同一磁盘，已停止安装。');
    const infoHash = createHash('sha256').update(await readFile(path.join(current, 'Contents/Info.plist'))).digest('hex');
    const startupToken = randomBytes(32).toString('hex');
    const startupTimeoutMs = dependencies.startupTimeoutMs ?? 120000;
    if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 300000) fail('MAC_UPDATE_METADATA', '启动确认等待时间无效。');
    const lockPath = path.join(parent, `.brclio-update-${createHash('sha256').update(current).digest('hex').slice(0, 16)}.lock`);
    for (const [status, message] of Object.entries(RESULTS)) await writeFile(path.join(work, `${status}.json`), JSON.stringify({
      status, message, version: expectedVersion, appId: expectedAppId, currentAppPath: current,
      backupPath: backup, failedAppPath: failed, lockPath, preparedAt: new Date().toISOString(),
      launchRequested: ['awaiting_startup', 'startup_unconfirmed', 'cleanup_pending', 'installed'].includes(status), signature: 'integrity-verified-not-notarization',
      schemaVersion: 3, startupToken, startupTimeoutMs, installedIdentity: inode(stagedStat),
      stageIdentity: inode(stageStat), backupIdentity: inode(currentStat), backupInfoHash: infoHash,
      backupVersion: previousInfo.CFBundleShortVersionString
    }, null, 2), { mode: 0o600 });
    const helperPath = path.join(work, 'install.cjs'); await writeFile(helperPath, HELPER, { mode: 0o700 });
    await progress('prepared', '新版已准备好，正在启动覆盖安装助手。');
    async function cancelHelper() {
      if (committed) return;
      await writeFile(path.join(work, 'cancel'), 'cancelled\n', { mode: 0o600 });
      if (child && !childStopped) {
        child.kill('SIGTERM');
        if (!await Promise.race([childExited.then(() => true), delay(2000, false, { ref: false })])) {
          child.kill('SIGKILL');
          if (!await Promise.race([childExited.then(() => true), delay(2000, false, { ref: false })])) {
            fail('MAC_UPDATE_HELPER_STOP', '安装助手尚未停止；没有批准替换，临时文件已保留。请保持当前应用打开。');
          }
        }
      }
      await copyFile(path.join(work, 'cancelled.json'), `${resultPath}.next`);
      await rename(`${resultPath}.next`, resultPath);
    }
    return {
      mode: 'replace', resultPath, backupPath: backup,
      async launch() {
        if (disposed) fail('MAC_UPDATE_DISPOSED', '更新准备已取消，请重新点击安装。');
        if (committed || launching || child) fail('MAC_UPDATE_LAUNCHED', '安装已启动或此准备已取消，请重新准备安装。');
        launching = true;
        try {
          try { process.kill(parentPid, 0); } catch (cause) { fail('MAC_UPDATE_PARENT', '原应用进程已退出，无法安全启动更新。', cause); }
          const log = await open(path.join(work, 'helper.log'), 'a', 0o600);
          try {
            const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
            delete env.NODE_OPTIONS; delete env.NODE_PATH;
            for (const name of Object.keys(env)) if (name.startsWith('DYLD_') || name === 'LD_PRELOAD') delete env[name];
            child = spawnHelper(helperExecutable, [helperPath, current, staged, backup, failed,
              inode(currentStat), inode(stagedStat), infoHash, String(parentPid), expectedAppId,
              expectedVersion, arch, work, resultPath, lockPath], {
              detached: true, cwd: work, env, stdio: ['ignore', log.fd, log.fd]
            });
            childStopped = false;
            childExited = new Promise(resolve => child.once('exit', () => { childStopped = true; resolve(); }));
            await new Promise((resolve, reject) => {
              child.once('error', error => { childStopped = true; reject(error); }); child.once('spawn', resolve);
            });
            child.unref();
          } finally { await log.close(); }
          const deadline = Date.now() + readinessTimeoutMs;
          while (Date.now() < deadline) {
            if (childStopped) fail('MAC_UPDATE_HELPER', '安装助手提前退出，已取消本次替换。');
            const result = JSON.parse(await readFile(resultPath, 'utf8'));
            if (result.status === 'ready') {
              if (disposed) fail('MAC_UPDATE_DISPOSED', '安装准备已取消。');
              // Atomic authorization point. There are no fallible awaits after
              // the commit rename: success returns directly and main may quit.
              await writeFile(path.join(work, 'commit.next'), 'approved\n', { mode: 0o600 });
              await rename(path.join(work, 'commit.next'), path.join(work, 'commit'));
              committed = true;
              return;
            }
            if (result.status !== 'prepared') fail('MAC_UPDATE_HELPER', result.message || '安装助手未进入就绪状态。');
            await delay(25);
          }
          fail('MAC_UPDATE_HELPER', '安装助手未确认就绪，已取消本次替换。');
        } catch (error) {
          await cancelHelper();
          if (error.code?.startsWith('MAC_UPDATE_')) throw error;
          fail('MAC_UPDATE_HELPER', '安装助手启动或就绪校验失败，已取消本次替换。', error);
        } finally { launching = false; }
      },
      async dispose() {
        if (committed || disposed) return;
        if (launching) fail('MAC_UPDATE_BUSY', '安装助手正在确认就绪，请等待后再取消。');
        await cancelHelper();
        await progressWindow.close();
        disposed = true;
        await rm(stageDirectory, { recursive: true, force: true }); await rm(work, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await progressWindow?.close().catch(() => {});
    let detached = !mounted;
    try { await detach(); detached = true; } catch { /* Retain mountpoint for manual cleanup. */ }
    if (stageDirectory) await rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
    if (work && detached) await rm(work, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
