import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const release = require('../desktop/migration/release.json');
const product = require('../package.json');
const isMac = process.platform === 'darwin';
const previous = '2.0.36';
const oldDigests = {
  'darwin-arm64': '3d297f841a17ec839aa40f56f4500a35c94a010340c56297306febdbfa302590',
  'darwin-x64': 'e0e1db6c61d042cb2083f323752ac6bc1cc5b9bd91393bcba303964f5fa10108',
  'win32-x64': '4285a43e6d29a9b70b8c9f2c3e9a2de28d284fb6b31eae9804bea643300b339c',
};

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This test installs real applications on a disposable GitHub-hosted desktop.');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const installer = path.resolve(process.argv[2]);
await access(installer);
if (!isMac && installer.endsWith('-portable.exe')) {
  await verifyPortable(installer);
  console.log('The portable launcher opened the existing official Windows installation.');
  process.exit(0);
}
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'brclio-migration-')));
const oldProfile = path.join(isMac ? path.join(homedir(), 'Library/Application Support') : process.env.APPDATA, product.productName);
await assert.rejects(access(oldProfile), {code: 'ENOENT'});
await mkdir(oldProfile, {recursive: true});
const marker = path.join(oldProfile, 'migration-test.txt');
await writeFile(marker, 'original data');
const key = process.platform + '-' + process.arch;
assert.ok(oldDigests[key], 'Unsupported test platform');
const suffix = isMac ? 'mac-' + process.arch + '.zip' : 'windows-x64-setup.exe';
const original = 'Brclio-XHS-' + previous + '-' + suffix;
const originalFile = path.join(temporary, original);
await run('gh', ['release', 'download', 'v' + previous, '--repo', 'Brclio/brclio-xhs-media-downloader',
  '--pattern', original, '--dir', temporary], {timeout: 300000});
const hash = createHash('sha256');
for await (const chunk of createReadStream(originalFile)) hash.update(chunk);
assert.equal(hash.digest('hex'), oldDigests[key]);

async function waitFor(label, probe) {
  const deadline = Date.now() + 180000;
  let last;
  do {
    last = await probe();
    if (last) return last;
    await delay(750);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}

function start(exe, args) {
  const child = spawn(exe, args, {stdio: 'ignore', shell: false});
  child.on('error', error => { throw error; });
  return child;
}

async function unpackUpdater(archive, files) {
  await writeFile(path.join(temporary, 'package.json'), '{"type":"module"}');
  for (const name of files) await writeFile(path.join(temporary, name), asar.extractFile(archive, path.join('desktop', name)));
  return import(pathToFileURL(path.join(temporary, files[0])).href);
}

async function mac() {
  const destination = '/Applications/Brclio.app';
  await assert.rejects(access(destination), {code: 'ENOENT'});
  const bundle = path.join(temporary, product.build.productName + '.app');
  await run('ditto', ['-x', '-k', originalFile, temporary]);
  const plist = path.join(bundle, 'Contents/Info.plist');
  const get = async (file, property) => (await run('/usr/bin/plutil', ['-extract', property, 'raw', '-o', '-', file])).stdout.trim();
  assert.equal(await get(plist, 'CFBundleShortVersionString'), previous);
  const exe = path.join(bundle, 'Contents/MacOS', await get(plist, 'CFBundleExecutable'));
  const old = start(exe, ['--use-mock-keychain']);
  const exited = once(old, 'exit');
  await delay(2000);
  assert.equal(old.exitCode, null);
  const cache = path.join(oldProfile, 'updates');
  const archive = path.join(bundle, 'Contents/Resources/app.asar');
  const {prepareMacUpdate} = await unpackUpdater(archive, ['mac-update.js', 'mac-install-progress.js', 'mac-architecture.js']);
  const update = await prepareMacUpdate({installerPath: installer, currentAppPath: bundle, expectedVersion: release.bridgeVersion,
    expectedArch: process.arch, cacheDirectory: cache, parentPid: old.pid}, {executable: exe});
  await writeFile(path.join(cache, 'mac-last-install.json'), JSON.stringify({resultPath: update.resultPath}), {mode: 0o600});
  await update.launch();
  old.kill('SIGTERM');
  await exited;
  await waitFor('legacy startup acknowledgment and backup cleanup', async () => {
    const state = JSON.parse(await readFile(update.resultPath));
    if (['rolled_back', 'helper_failed', 'rollback_failed'].includes(state.status)) throw new Error(JSON.stringify(state));
    return state.status === 'installed' && state.startupConfirmed && state.backupRemoved;
  });
  assert.equal(await get(plist, 'CFBundleShortVersionString'), release.bridgeVersion);
  const processPath = destination + '/Contents/MacOS/Brclio';
  await waitFor('official Brclio process', async () => (await run('ps', ['-axo', 'comm='])).stdout.split('\n').some(line => line.trim() === processPath));
  const targetPlist = path.join(destination, 'Contents/Info.plist');
  assert.equal(await get(targetPlist, 'CFBundleIdentifier'), 'com.brclio.toolbox');
  assert.equal(await get(targetPlist, 'CFBundleShortVersionString'), release.version);
  await run('codesign', ['--verify', '--deep', '--strict', destination]);
  return path.join(destination, 'Contents/Resources/app.asar');
}

async function ps(script, env = {}) {
  return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    {env: {...process.env, ...env}, windowsHide: true})).stdout.trim();
}

async function verifyPortable(file) {
  const folder = await ps("(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\c8f079c5-a346-5aee-a72f-5280717e7b26').InstallLocation");
  assert.ok(folder, 'Run the setup migration test first');
  const exe = path.join(folder, 'Brclio.exe');
  const env = {BRCLIO_TEST_APP: exe};
  const marker = '(Get-Item -LiteralPath $env:BRCLIO_TEST_APP).LastWriteTimeUtc.Ticks';
  const timestamp = await ps(marker, env);
  const processes = 'Get-Process -Name Brclio -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:BRCLIO_TEST_APP }';
  await ps(processes + ' | Stop-Process -Force; exit 0', env);
  await waitFor('prior application to exit', async () => !(await ps(processes + ' | Select-Object -ExpandProperty Id; exit 0', env)));
  const launcher = start(file, []);
  const completed = once(launcher, 'exit');
  await waitFor('portable launcher to open the installed official Brclio window', async () =>
    ps(processes + ' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty Id; exit 0', env));
  const [exitCode] = await completed;
  assert.equal(exitCode, 0, 'Portable migration must finish after the official window opens');
  assert.equal(await ps(marker, env), timestamp);
}

async function windows() {
  const installDir = path.join(temporary, 'LegacyXHS');
  const official = "HKCU:\\Software\\c8f079c5-a346-5aee-a72f-5280717e7b26";
  assert.equal(await ps("Test-Path -LiteralPath '" + official + "'"), 'False');
  await run(originalFile, ['/S', '/currentuser', '/D=' + installDir], {timeout: 240000, windowsVerbatimArguments: true});
  const exe = path.join(installDir, product.build.productName + '.exe');
  const version = () => ps('(Get-Item -LiteralPath $env:BRCLIO_TEST_APP).VersionInfo.ProductVersion', {BRCLIO_TEST_APP: exe});
  assert.equal((await version()).replace(/\.0$/, ''), previous);
  const archive = path.join(installDir, 'resources/app.asar');
  const {launchWindowsUpdate} = await unpackUpdater(archive, ['windows-update.js']);
  const old = start(exe, []);
  await delay(2000);
  assert.equal(old.exitCode, null);
  await launchWindowsUpdate(installer, {parentPid: old.pid});
  old.kill();
  const officialExe = await waitFor('registered and running Brclio', async () => {
    const folder = await ps("(Get-ItemProperty -LiteralPath '" + official + "' -ErrorAction SilentlyContinue).InstallLocation; exit 0");
    if (!folder) return false;
    const file = path.join(folder, 'Brclio.exe');
    const running = await ps("Get-Process -Name Brclio -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:BRCLIO_TEST_APP } | Select-Object -ExpandProperty Id; exit 0", {BRCLIO_TEST_APP: file});
    return running && file;
  });
  await waitFor('migration launcher to finish', async () => {
    const running = await ps("Get-Process | Where-Object { $_.Path -eq $env:BRCLIO_TEST_APP } | Select-Object -ExpandProperty Id; exit 0", {BRCLIO_TEST_APP: exe});
    return !running;
  });
  assert.equal((await version()).replace(/\.0$/, ''), release.bridgeVersion);
  assert.equal(await ps('(Get-Item -LiteralPath $env:BRCLIO_TEST_APP).VersionInfo.ProductName', {BRCLIO_TEST_APP: officialExe}), 'Brclio');
  return path.join(path.dirname(officialExe), 'resources/app.asar');
}

const officialArchive = await (isMac ? mac() : windows());
assert.equal(JSON.parse(asar.extractFile(officialArchive, 'package.json')).version, release.version);
assert.equal(await readFile(marker, 'utf8'), 'original data');
console.log('Published v' + previous + ' updater installed the migration release and opened official Brclio v' + release.version + ' on ' + key);
