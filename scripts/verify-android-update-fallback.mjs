// A disposable debug copy forces the direct metadata attempt to fail; proxy traffic remains real.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { copyManualFallbackSources } from './verify-android-manual-fallback.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const managerPath = 'android/app/src/main/java/com/brclio/xhs/UpdateManager.java';

export function forceDirectMetadataFailure(source) {
  const anchor = 'UpdateCheckNetwork.run(() -> latestRelease(job), () -> {';
  assert.equal(source.split(anchor).length, 2, 'The isolated fixture must change exactly one direct check callback.');
  return source.replace(anchor, 'UpdateCheckNetwork.run(() -> { throw new UpdateCheckNetwork.Failure("Isolated direct metadata failure fixture."); }, () -> {');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Android fallback acceptance command exited ${code}.`)));
  });
}

export async function verifyAndroidUpdateFallback(serial = 'emulator-5558') {
  assert.match(serial, /^emulator-\d+$/, 'Use a disposable emulator for this debug fixture.');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  assert.ok(sdk, 'Android SDK is required.');
  const temporary = await mkdtemp(path.join(tmpdir(), 'brclio-android-direct-failure-'));
  const candidate = path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');
  const original = await readFile(path.join(root, managerPath), 'utf8');
  const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const execute = promisify(execFile);
  const device = async (...args) => (await execute(adb, ['-s', serial, ...args])).stdout.trim();
  assert.equal(await device('shell', 'getprop', 'ro.kernel.qemu'), '1', 'This fixture requires a disposable emulator.');
  let originalProxy, proxyAdjusted = false, verified = false;
  try {
    await copyManualFallbackSources(root, temporary);
    await writeFile(path.join(temporary, managerPath), forceDirectMetadataFailure(original));
    await cp(path.join(root, 'desktop-runtime/.update-proxy-cache'), path.join(temporary, 'desktop-runtime/.update-proxy-cache'), { recursive: true });
    await run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', ['--no-daemon', ':app:assembleDebug'], {
      cwd: path.join(temporary, 'android'), shell: process.platform === 'win32',
    });
    const artifact = path.join(root, 'dist-android/update-routing-direct-failure-fixture.apk');
    await mkdir(path.dirname(artifact), { recursive: true });
    await cp(path.join(temporary, 'android/app/build/outputs/apk/debug/app-debug.apk'), artifact);
    // Isolate the internal fallback from a saved emulator proxy; restore it even after a failed check.
    originalProxy = await device('shell', 'settings', 'get', 'global', 'http_proxy');
    await device('shell', 'settings', 'put', 'global', 'http_proxy', ':0');
    proxyAdjusted = true;
    assert.ok(['null', ''].includes(await device('shell', 'settings', 'get', 'global', 'global_http_proxy_host')),
      'The effective emulator HTTP proxy must be cleared for internal fallback acceptance.');
    await run(process.execPath, [path.join(root, 'scripts/verify-android-update-proxy.mjs'), serial], {
      cwd: root, env: { ...process.env, ANDROID_UPDATE_PROXY_TEST_APK: artifact,
        ANDROID_UPDATE_PROXY_EXPECT_MODE: 'proxy', ANDROID_UPDATE_PROXY_SOURCE_FIXTURE: 'true' },
    });
    verified = true;
  } finally {
    if (proxyAdjusted) {
      if (originalProxy === 'null') await device('shell', 'settings', 'delete', 'global', 'http_proxy');
      else await device('shell', 'settings', 'put', 'global', 'http_proxy', originalProxy);
      assert.equal(await device('shell', 'settings', 'get', 'global', 'http_proxy'), originalProxy, 'The emulator proxy must be restored.');
    }
    if (verified) {
      const proof = path.join(root, 'dist-android/update-proxy-emulator-verification.json');
      const report = JSON.parse(await readFile(proof, 'utf8'));
      report.emulatorSystemProxyTemporarilyDisabled = true;
      report.emulatorSystemProxyRestored = true;
      await writeFile(proof, `${JSON.stringify(report, null, 2)}\n`);
    }
    await run(adb, ['-s', serial, 'install', '-r', candidate]);
    await rm(temporary, { recursive: true, force: true });
    assert.equal(await readFile(path.join(root, managerPath), 'utf8'), original, 'The production updater source must remain untouched.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyAndroidUpdateFallback(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
