import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { readMacArchitectures } from '../mac-architecture.js';
import { verifyInstaller } from './release.js';

const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs').promises : nodeFs.promises;
const execute = promisify(execFile);
const runNative = (command, args) => execute(command, args, { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
const identity = stat => `${stat.dev}:${stat.ino}`;
const bundleId = 'com.brclio.toolbox';
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

// macOS exposes the same app path used by Launch Services without requiring
// Accessibility or Apple Events permission from the user.
const queryApplications = `
ObjC.import('AppKit');
const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.brclio.toolbox');
const result = [];
for (let i = 0; i < apps.count; ++i) {
  const app = apps.objectAtIndex(i);
  result.push({ path: ObjC.unwrap(app.bundleURL.path), ready: Boolean(app.finishedLaunching) });
}
JSON.stringify(result);`;

async function runningApplications(run) {
  return JSON.parse((await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', queryApplications])).stdout);
}

async function openApplication(appPath, run) {
  await run('/usr/bin/open', [appPath]);
  const deadline = Date.now() + 60000;
  do {
    if ((await runningApplications(run)).some(app => app.path === appPath && app.ready)) return;
    await delay(300);
  } while (Date.now() < deadline);
  throw new Error('Brclio 尚未完成启动，请检查系统安全提示后重试。');
}

// renamex_np is a system call provided by macOS. RENAME_EXCL (4) publishes
// a first install only if the destination is absent. RENAME_SWAP (2) atomically
// exchanges two whole bundles. A crash never leaves a half-copied Brclio.app.
async function commitBundle(staged, target, existing, run) {
  const script = `ObjC.bindFunction('renamex_np', ['int', ['string', 'string', 'unsigned int']]);
    function run(args) {
      if ($.renamex_np(args[0], args[1], Number(args[2])) !== 0) throw Error('无法提交安装，请确认应用目录可写后重试。');
    }`;
  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, staged, target, existing ? '2' : '4']);
}

async function bundleInfo(bundle, run, arch) {
  const stat = await fs.lstat(bundle);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Brclio 应用目录无效。');
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const info = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout);
  if (info.CFBundleIdentifier !== bundleId || info.CFBundlePackageType !== 'APPL'
      || info.CFBundleExecutable !== 'Brclio' || !versionPattern.test(info.CFBundleShortVersionString)) {
    throw new Error('应用程序文件夹中的 Brclio 身份或版本无效，请检查后重试。');
  }
  const executable = path.join(bundle, 'Contents', 'MacOS', 'Brclio');
  if (!(await fs.lstat(executable)).isFile() || !(await fs.realpath(executable)).startsWith(await fs.realpath(bundle) + path.sep)) {
    throw new Error('Brclio 可执行文件不在应用目录内。');
  }
  if (arch && !(await readMacArchitectures(executable, fs)).includes(arch === 'x64' ? 'x86_64' : arch)) {
    throw new Error('Brclio 安装包与处理器架构不匹配。');
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  return { id: identity(stat), version: info.CFBundleShortVersionString };
}

function atLeast(installed, required) {
  const a = installed.split('.').map(Number), b = required.split('.').map(Number);
  for (let i = 0; i < 3; ++i) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

async function copyFromImage(installer, staged, version, arch, run) {
  const parent = await fs.realpath(os.tmpdir());
  const mount = await fs.mkdtemp(path.join(parent, 'brclio-dmg-'));
  let mounted = false;
  try {
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, installer]);
    mounted = true;
    const source = path.join(mount, 'Brclio.app');
    if ((await bundleInfo(source, run, arch)).version !== version) throw new Error('DMG 中的版本与正式发布记录不一致。');
    await run('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', source, staged]);
    const candidate = await bundleInfo(staged, run, arch);
    if (candidate.version !== version) throw new Error('复制后的 Brclio 版本不正确。');
    return candidate;
  } finally {
    try {
      if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]);
    } finally {
      // Never recursively remove the contents of a mount point.
      await fs.rmdir(mount).catch(() => {});
    }
  }
}

export async function migrateMac({ installer, asset, version, arch }, dependencies = {}) {
  const run = dependencies.run || runNative;
  const target = path.join(await fs.realpath(dependencies.applications || '/Applications'), 'Brclio.app');
  const openTarget = dependencies.openTarget || (() => openApplication(target, run));
  const running = dependencies.running || (() => runningApplications(run));
  const previous = await fs.lstat(target).then(() => bundleInfo(target, run), error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (previous && atLeast(previous.version, version)) return openTarget();
  await verifyInstaller(installer, asset);
  const work = await fs.mkdtemp(path.join(path.dirname(target), '.brclio-migration-'));
  const staged = path.join(work, 'Brclio.app');
  let keepBackup = false;
  try {
    const candidate = await copyFromImage(installer, staged, version, arch, run);
    // The toolbox's own updater holds this lock while it replaces its bundle.
    const lockName = '.brclio-update-' + createHash('sha256').update(target).digest('hex').slice(0, 16) + '.lock';
    const lock = path.join(path.dirname(target), lockName);
    const updating = await fs.lstat(lock).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (updating || (await running()).length) throw new Error('请等待 Brclio 自身的更新完成，然后完全退出已打开的 Brclio 并重试。');
    if (previous && previous.id !== identity(await fs.lstat(target))) throw new Error('现有 Brclio 已发生变化，请重试。');
    await commitBundle(staged, target, previous, run);
    keepBackup = Boolean(previous);
    if (candidate.id !== identity(await fs.lstat(target)) || (previous && previous.id !== identity(await fs.lstat(staged)))) {
      throw new Error(`应用目录在安装期间被修改，请检查 ${work} 后再试。`);
    }
    try {
      await openTarget();
    } catch (error) {
      if (previous && !(await running()).length && identity(await fs.lstat(target)) === candidate.id
          && identity(await fs.lstat(staged)) === previous.id) {
        await commitBundle(staged, target, true, run);
        keepBackup = false;
      }
      if (keepBackup) throw new Error(`${error.message} 原 Brclio 已保存在 ${staged}。`);
      throw error;
    }
    keepBackup = false;
  } finally {
    if (!keepBackup) await fs.rm(work, { recursive: true, force: true });
  }
}
