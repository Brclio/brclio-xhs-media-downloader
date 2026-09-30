// Runs REAL, unmodified public v1.8.17 installers and the current build in a
// disposable GitHub Windows runner. Never run on a personal Windows account:
// NSIS registration/shortcuts are per-user, even with a temporary /D directory.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyAsar } from './verify-promoted-installer.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const repository = 'Brclio/brclio-xhs-media-downloader';
const previousVersion = '1.8.17';
const digest = async file => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
async function until(check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(250); }
  throw new Error(`Timed out: ${label}`);
}
const exists = file => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const ps = async (script, extra = {}) => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = "Stop"; ' + script],
{ encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 ** 2, windowsHide: true, env: { ...process.env, ...extra } })).stdout.trim();
const processes = async () => JSON.parse(await ps('@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress') || '[]');
const isMain = (p, executable) => p.ExecutablePath?.toLowerCase() === executable.toLowerCase() && !/--type[= ]/.test(p.CommandLine || '');
async function stopApp(pid) {
  await ps('$p = Get-Process -Id ([int]$env:VERIFY_PID) -ErrorAction SilentlyContinue; if ($p) { if (-not $p.CloseMainWindow()) { throw "Application has no closable window" } }', { VERIFY_PID: String(pid) });
  await until(async () => !(await processes()).some(p => p.ProcessId === pid), 'normal app shutdown', 30000);
}
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  let sequence = 0;
  return { close: () => socket.close(), evaluate: expression => new Promise((resolve, reject) => {
    const id = ++sequence;
    const finish = (error, value) => { clearTimeout(timer); socket.removeEventListener('message', message); socket.removeEventListener('close', closed); error ? reject(error) : resolve(value); };
    const closed = () => finish(new Error('CDP closed'));
    const timer = setTimeout(() => finish(new Error('CDP evaluation timeout')), 20000);
    const message = event => {
      const data = JSON.parse(event.data); if (data.id !== id) return;
      if (data.error || data.result?.exceptionDetails) finish(new Error(JSON.stringify(data.error || data.result.exceptionDetails)));
      else finish(null, data.result?.result?.value);
    };
    socket.addEventListener('message', message); socket.addEventListener('close', closed, { once: true });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  }) };
}

// Standard NSIS wizard controls, addressed by Win32 IDs, independent of language.
// A manual setup is cancelled BEFORE any install starts. A completed update's
// finish window is also closed here; no taskkill is used in successful checks.
async function closeWizard(pid, cancel) {
  await ps(`Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VerifyWindow {
  private delegate bool EnumCallback(IntPtr window, IntPtr unused);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr unused);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static void ConfirmCancel(uint target) {
    EnumWindows(delegate(IntPtr window, IntPtr unused) {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (pid == target) {
        IntPtr yes = GetDlgItem(window, 6);
        if (yes != IntPtr.Zero) SendMessage(yes, 0x00F5, IntPtr.Zero, IntPtr.Zero);
      }
      return true;
    }, IntPtr.Zero);
  }
}
'@;
$p = Get-Process -Id ([int]$env:VERIFY_PID) -ErrorAction SilentlyContinue;
if ($p) { [void]$p.CloseMainWindow() }
if ($env:VERIFY_CANCEL -eq '1') {
  $deadline = (Get-Date).AddSeconds(8);
  do {
    Start-Sleep -Milliseconds 100;
    $p = Get-Process -Id ([int]$env:VERIFY_PID) -ErrorAction SilentlyContinue;
    if (-not $p) { break }
    [VerifyWindow]::ConfirmCancel([uint32]$env:VERIFY_PID);
  } while ((Get-Date) -lt $deadline)
}`, { VERIFY_PID: String(pid), VERIFY_CANCEL: cancel ? '1' : '0' });
  await until(async () => !(await processes()).some(p => p.ProcessId === pid), 'installer window closed', 15000);
}

export async function verifyPackagedWindowsUpdate(root = process.cwd()) {
  assert.equal(process.platform, 'win32', 'Requires native Windows');
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Only a disposable GitHub runner may install test packages');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Self-hosted/personal Windows machines are not supported');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const output = path.resolve(root, pkg.build.directories.output);
  const target = path.join(output, `Brclio-XHS-${pkg.version}-windows-x64-setup.exe`);
  const portable = path.join(output, `Brclio-XHS-${pkg.version}-windows-x64-portable.exe`);
  const proofPath = path.join(output, 'release-proof-windows-x64.json');
  const proof = JSON.parse(await readFile(proofPath, 'utf8'));
  assert.equal(proof.version, pkg.version);
  for (const file of [target, portable]) {
    const entry = proof.files.find(item => item.name === path.basename(file));
    assert.ok(entry); assert.equal(await digest(file), entry.sha256);
  }
  const profile = path.join(process.env.APPDATA, pkg.productName);
  assert.equal(await exists(profile), false, 'Refuse to touch an existing application profile');
  const { UUID } = require('builder-util-runtime');
  const guid = pkg.build.nsis.guid || UUID.v5(pkg.build.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  for (const hive of ['HKCU', 'HKLM']) {
    assert.equal(await ps(`Test-Path -LiteralPath '${hive}:\\Software\\${guid}'`), 'False', 'Refuse to change an existing installation');
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'brclio-windows-upgrade-'));
  // Deliberately omit APP_FILENAME: an update must preserve even a custom /D
  // destination, instead of appending a new package-name subdirectory.
  const installDirectory = path.join(temporary, '安装路径 with spaces');
  const executable = path.join(installDirectory, `${pkg.build.productName}.exe`);
  const archive = path.join(installDirectory, 'resources/app.asar');
  const running = new Set();
  let connection;
  const assetEvidence = [];
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH']) delete env[name];
  function start(file, args, options = {}) {
    const child = spawn(file, args, { env, stdio: 'ignore', shell: false, windowsHide: false, ...options });
    running.add(child); child.on('error', error => { child.launchError = error; });
    return child;
  }
  async function oldAsset(kind) {
    const metadata = await fetch(`https://api.github.com/repos/${repository}/releases/tags/v${previousVersion}`, {
      headers: { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) }, signal: AbortSignal.timeout(30000)
    }).then(response => { assert.equal(response.status, 200); return response.json(); });
    assert.equal(metadata.draft, false); assert.equal(metadata.prerelease, false);
    const name = `Brclio-XHS-${previousVersion}-windows-x64-${kind}.exe`;
    const matches = metadata.assets.filter(asset => asset.name === name); assert.equal(matches.length, 1);
    const asset = matches[0]; assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/);
    assert.equal(asset.browser_download_url, `https://github.com/${repository}/releases/download/v${previousVersion}/${name}`);
    const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) });
    assert.equal(response.status, 200);
    const destination = path.join(temporary, name);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
    assert.equal((await lstat(destination)).size, asset.size);
    assert.equal(await digest(destination), asset.digest.slice(7));
    assetEvidence.push({ name, bytes: asset.size, sha256: asset.digest.slice(7) });
    return destination;
  }
  async function launch(file, version, isPortable) {
    const debugPort = await port();
    start(file, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`]);
    const page = await until(async () => {
      try {
        const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) }).then(response => response.json());
        return pages.find(p => p.type === 'page' && p.url.startsWith('xhs-app://local/'));
      } catch { return false; }
    }, 'actual packaged renderer');
    connection = await connect(page.webSocketDebuggerUrl);
    await until(async () => {
      try { return await connection.evaluate("document.body?.dataset.desktopReady === 'true' && !!window.xhsDesktop"); }
      catch { return false; }
    }, 'packaged preload readiness', 30000);
    const info = await connection.evaluate('window.xhsDesktop.getInfo()');
    assert.equal(info.version, version); assert.equal(info.portable, isPortable); assert.equal(info.pythonAvailable, true);
    const p = await until(async () => (await processes()).find(p => p.Name === `${pkg.build.productName}.exe`
      && !/--type[= ]/.test(p.CommandLine || '') && (p.CommandLine || '').includes(`--remote-debugging-port=${debugPort}`)), 'packaged main PID');
    await until(async () => (await connection.evaluate('window.xhsDesktop.getAccountState()')).status === 'signed_out', 'DPAPI credential initialization');
    return p.ProcessId;
  }
  async function assertState(accountBytes) {
    assert.deepEqual(await readFile(path.join(profile, 'account/account-v1.enc')), accountBytes, 'DPAPI credentials must survive byte-for-byte');
    const state = await connection.evaluate('window.xhsDesktop.getProfileState()');
    assert.equal(state.status, 'paused'); assert.equal(state.profileName, 'Windows upgrade fixture');
    assert.equal(state.items[0].id, '65aabbccddeeff0011223344'); assert.equal(state.items[0].status, 'completed');
    assert.equal(state.intervalSeconds, 23);
    assert.equal(await connection.evaluate("localStorage.getItem('windows-upgrade-fixture')"), 'preserved');
  }
  async function upgrade(pid, oldLauncher, beforeDigest) {
    let installer;
    await oldLauncher(target, { parentPid: pid }, { spawn: (file, args, options) => {
      installer = spawn(file, args, { ...options, env }); running.add(installer); return installer;
    } });
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(1000);
      const current = await processes();
      assert.ok(current.some(p => p.ProcessId === installer.pid), 'Installer must remain active while waiting');
      assert.ok(current.some(p => p.ProcessId === pid), 'Installer must not force-kill the old parent');
      assert.equal(await digest(archive), beforeDigest, 'Installer must wait before modifying installed files');
    }
    connection.close(); connection = null;
    await stopApp(pid);
    const restarted = await until(async () => (await processes()).find(p => isMain(p, executable) && p.ProcessId !== pid), 'successful NSIS automatic app relaunch', 180000);
    assert.ok((restarted.CommandLine || '').includes('--updated'), 'Automatic relaunch carries update marker');
    assert.equal(await digest(archive), await digest(path.join(output, 'win-unpacked/resources/app.asar')), 'Installed payload is the reviewed new archive');
    await until(async () => Number(await ps('$p = Get-Process -Id ([int]$env:VERIFY_PID) -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowHandle.ToInt64() }', { VERIFY_PID: String(restarted.ProcessId) })) > 0, 'restarted app window');
    await stopApp(restarted.ProcessId);
    await closeWizard(installer.pid, false);
  }
  try {
    const oldSetup = await oldAsset('setup');
    const oldPortable = await oldAsset('portable');
    // NSIS /D consumes the complete remaining raw command line: Node's normal
    // argument quoting would leave a literal trailing quote in the directory.
    const setup = start(oldSetup, ['/S', '/currentuser', `/D=${installDirectory}`], {
      windowsVerbatimArguments: true, argv0: `"${oldSetup}"`
    });
    await until(() => { if (setup.launchError) throw setup.launchError; return setup.exitCode !== null; }, 'old silent installation', 180000);
    assert.equal(setup.exitCode, 0);
    const extract = name => asar.extractFile(archive, path.normalize(name));
    assert.equal(JSON.parse(extract('package.json')).version, previousVersion);
    const originalLauncher = path.join(temporary, 'old-windows-update.mjs');
    await writeFile(originalLauncher, extract('desktop/windows-update.js'));
    const { launchWindowsUpdate: oldLauncher } = await import(pathToFileURL(originalLauncher).href);
    await mkdir(path.join(profile, 'profile-jobs'), { recursive: true });
    await writeFile(path.join(profile, 'profile-jobs/profile-job.json'), JSON.stringify({ version: 1, status: 'paused', phase: 'download',
      profileUrl: 'https://www.xiaohongshu.com/user/profile/65aabbccddeeff0011223344', profileName: 'Windows upgrade fixture',
      directory: temporary, intervalSeconds: 23, jitterSeconds: 2, discoveryComplete: true,
      items: [{ id: '65aabbccddeeff0011223344', title: 'Saved fixture', status: 'completed', complete: true, sequence: 1, files: [] }] }));
    let pid = await launch(executable, previousVersion, false);
    await connection.evaluate("localStorage.setItem('windows-upgrade-fixture', 'preserved')");
    const accountBytes = await readFile(path.join(profile, 'account/account-v1.enc'));
    assert.ok(accountBytes.length > 100);
    await assertState(accountBytes);
    await upgrade(pid, oldLauncher, await digest(archive));
    await verifyAsar(archive, root, pkg.version);
    pid = await launch(executable, pkg.version, false);
    await assertState(accountBytes);
    connection.close(); connection = null; await stopApp(pid);
    // Actual published portable v1.8.17 migrates through the SAME setup launcher.
    // Its original exe remains untouched; the registered installed app restarts.
    const portableBefore = await digest(oldPortable);
    pid = await launch(oldPortable, previousVersion, true);
    await assertState(accountBytes);
    await upgrade(pid, oldLauncher, await digest(archive));
    assert.equal(await digest(oldPortable), portableBefore);
    pid = await launch(portable, pkg.version, true);
    await assertState(accountBytes);
    connection.close(); connection = null; await stopApp(pid);
    await until(async () => !(await processes()).some(p => p.ExecutablePath?.toLowerCase() === portable.toLowerCase()), 'portable wrapper cleanup');
    // Cancel a visible manual reinstall on its first page, before extraction.
    const beforeCancel = await digest(archive);
    const cancelled = start(target, ['/currentuser']);
    await until(async () => Number(await ps('$p = Get-Process -Id ([int]$env:VERIFY_PID) -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowHandle.ToInt64() }', { VERIFY_PID: String(cancelled.pid) })) > 0, 'manual installer first page');
    await closeWizard(cancelled.pid, true);
    assert.equal(await digest(archive), beforeCancel, 'Cancellation before install leaves installed files intact');
    assert.deepEqual(await readFile(path.join(profile, 'account/account-v1.enc')), accountBytes);
    assert.equal((await processes()).filter(p => isMain(p, executable)).length, 0, 'Cancelled installer must not launch the app');
    const result = { previousVersion, version: pkg.version, oldAssets: assetEvidence,
      realPublishedOldInstallers: true, realCurrentInstallers: true, sourceArchivesModified: false,
      oldParentWaitVerified: true, installedInPlaceVerified: true, automaticRelaunchVerified: true,
      dpapiCredentialsPreserved: true, pausedTaskPreserved: true, rendererStoragePreserved: true,
      existingInstallationPortableUpdateVerified: true, standalonePortableMigrationTested: false,
      portableOriginalPreserved: true, currentPortableLaunchVerified: true,
      cancelBeforeInstallVerified: true, rollbackImplemented: false, powerLossRecoveryTested: false,
      machineWideUacTested: false, profileIsolation: 'fresh disposable GitHub runner account', installDirectoryIsolation: 'temporary' };
    await writeFile(proofPath, JSON.stringify({ ...proof, packagedWindowsUpdateVerified: true, packagedWindowsPortableVerified: true, windowsUpdate: result }, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    connection?.close();
    // Cleanup is restricted to this disposable runner's fixture processes.
    for (const p of await processes()) {
      if (p.ExecutablePath?.toLowerCase().startsWith(temporary.toLowerCase() + path.sep)
        || p.Name === `${pkg.build.productName}.exe`) {
        await run('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true }).catch(() => {});
      }
    }
    for (const child of running) if (child.exitCode === null) child.kill();
    await delay(1000);
    // The ephemeral runner owns NSIS registration and its shortcuts; do not
    // emulate uninstall or claim this is installer rollback.
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyPackagedWindowsUpdate();
}
