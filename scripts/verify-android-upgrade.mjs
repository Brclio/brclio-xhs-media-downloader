// Run only against a disposable GitHub Actions emulator, using the real signed APKs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { androidVersion, validateReleaseFiles } from './publish-android-release.mjs';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'Brclio/brclio-xhs-media-downloader';
const APPLICATION = 'com.brclio.xhs';
const run = async (file, args, options = {}) => (await execute(file, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024, ...options,
})).stdout;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decodeXml = value => value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
  const named = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' };
  return named[entity] ?? String.fromCodePoint(entity[2].toLowerCase() === 'x'
    ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1)));
});

export function uiNodes(xml) {
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(([, attributes]) => {
    const node = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)]
      .map(([, name, value]) => [name, decodeXml(value)]));
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.bounds || '');
    if (bounds) node.rect = bounds.slice(1).map(Number);
    return node;
  });
}

const onScreen = node => node.rect && node.rect[2] > node.rect[0] && node.rect[3] > node.rect[1];

export function installSourceToggle(nodes) {
  const settings = nodes.filter(node => node.package === 'com.android.settings' && onScreen(node));
  if (!settings.some(node => node.text === 'Allow from this source')
    || !settings.some(node => node.text === 'Brclio 小红书下载器')) return undefined;
  // API 35 Settings uses a Compose checkable android.view.View, not Switch.
  const toggles = settings.filter(node => node.checkable === 'true' && node.enabled === 'true'
    && node.clickable === 'true');
  return toggles.length === 1 ? toggles[0] : undefined;
}

export function packageState(text) {
  const result = {
    versionCode: Number(text.match(/\bversionCode=(\d+)/)?.[1]),
    versionName: text.match(/\bversionName=([^\s]+)/)?.[1],
    // Android 15 labels this appId; on the primary user it is the app UID.
    // Older platform dumps use userId for the same package-level field.
    userId: Number(text.match(/^\s*(?:appId|userId)=(\d+)/m)?.[1]),
    firstInstallTime: text.match(/\bfirstInstallTime=([^\r\n]+)/)?.[1]?.trim(),
  };
  assert.ok(Number.isSafeInteger(result.versionCode) && result.versionCode > 0, 'Missing installed version');
  assert.ok(Number.isSafeInteger(result.userId) && result.userId > 0, 'Missing application UID');
  assert.ok(result.firstInstallTime && result.versionName, 'Missing installation identity');
  return result;
}

async function until(check, label, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function verifyAndroidUpgrade() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This destructive install fixture is restricted to GitHub Actions');
  const serial = process.env.ANDROID_SERIAL || `emulator-${process.env.EMULATOR_PORT || '5554'}`;
  assert.match(serial, /^emulator-\d+$/, 'Never install this fixture on a physical device');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  assert.ok(sdk, 'Android SDK is required');
  const adb = path.join(sdk, 'platform-tools/adb');
  const device = (args, options) => run(adb, ['-s', serial, ...args], options);
  const shell = (...args) => device(['shell', ...args]);
  assert.equal((await shell('getprop', 'ro.kernel.qemu')).trim(), '1', 'Only a disposable Android emulator is allowed');
  assert.equal((await shell('am', 'get-current-user')).trim(), '0', 'Package appId must refer to the primary emulator user');
  const output = path.join(ROOT, 'dist-android/emulator-upgrade');
  const baselineDirectory = path.join(output, 'baseline');
  await mkdir(baselineDirectory, { recursive: true });
  const tag = process.env.ANDROID_RELEASE_TAG;
  const version = androidVersion(tag);
  const sourceCommit = (await run('git', ['rev-parse', 'HEAD'])).trim();
  const certificate = (process.env.ANDROID_SIGNING_CERT_SHA256 || '').replace(/:/g, '').toLowerCase().trim();
  const { proof } = validateReleaseFiles(path.join(ROOT, 'dist-android'), {
    tag, sourceCommit, certificateSha256: certificate, requireEmulatorUpgrade: false,
  });
  const baselineTag = process.env.ANDROID_UPGRADE_BASELINE_TAG || 'android-v1.0.2';
  const baselineVersion = androidVersion(baselineTag);
  const release = JSON.parse(await run('gh', ['api', `repos/${REPOSITORY}/releases/tags/${baselineTag}`]));
  assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  await run('gh', ['release', 'download', baselineTag, '--repo', REPOSITORY, '--dir', baselineDirectory,
    '--pattern', `Brclio-XHS-Android-${baselineVersion}-release.apk`, '--pattern', '*.apk.sha256',
    '--pattern', 'SHA256SUMS.txt', '--pattern', 'android-update.json']);
  const baselineProof = JSON.parse(await readFile(path.join(baselineDirectory, 'android-update.json'), 'utf8'));
  validateReleaseFiles(baselineDirectory, { tag: baselineTag, sourceCommit: baselineProof.sourceCommit, certificateSha256: certificate });
  assert.ok(baselineProof.versionCode < proof.versionCode, 'The fixture must perform a real upgrade');
  const oldApk = path.join(baselineDirectory, baselineProof.apk.name);
  const newApk = path.join(ROOT, 'dist-android', proof.apk.name);
  const apksigner = path.join(sdk, 'build-tools/35.0.0/apksigner');
  for (const apk of [oldApk, newApk]) {
    const signature = await run(apksigner, ['verify', '--verbose', '--print-certs', apk]);
    assert.equal(signature.match(/Signer #1 certificate SHA-256 digest: ([a-f\d]+)/i)?.[1]?.toLowerCase(), certificate);
    assert.doesNotMatch(signature, /Signer #2 certificate/);
  }

  let lastXml = '';
  const snapshot = async () => {
    await shell('uiautomator', 'dump', '/sdcard/brclio-upgrade-ui.xml');
    lastXml = await device(['exec-out', 'cat', '/sdcard/brclio-upgrade-ui.xml']);
    return uiNodes(lastXml);
  };
  const screenshot = async name => {
    const png = await device(['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
    await writeFile(path.join(output, `${name}.png`), png);
    await writeFile(path.join(output, `${name}.xml`), lastXml);
  };
  const tap = async node => {
    assert.ok(onScreen(node), 'Only tap an observed UI element with usable bounds');
    const [left, top, right, bottom] = node.rect;
    await shell('input', 'tap', String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2)));
  };
  const screen = (await shell('wm', 'size')).match(/(?:Physical|Override) size: (\d+)x(\d+)/);
  assert.ok(screen); const width = Number(screen[1]), height = Number(screen[2]);
  const findText = async (text, scroll = false) => {
    for (let attempt = 0; attempt < (scroll ? 9 : 1); attempt++) {
      const nodes = await snapshot();
      const found = nodes.find(node => onScreen(node) && [node.text, node['content-desc']].includes(text))
        || nodes.find(node => onScreen(node) && [node.text, node['content-desc']].some(value => value?.includes(text)));
      if (found) return found;
      if (scroll) await shell('input', 'swipe', String(Math.floor(width / 2)), String(Math.floor(height * .78)),
        String(Math.floor(width / 2)), String(Math.floor(height * .28)), '350');
    }
    return null;
  };
  const launch = async (label, expectedVersion) => {
    await shell('am', 'force-stop', APPLICATION);
    const result = await shell('am', 'start', '-W', '-n', `${APPLICATION}/.MainActivity`);
    assert.match(result, /Status: ok/);
    await until(() => findText('保存一篇笔记'), `${label} real WebView startup`);
    assert.match((await shell('pidof', APPLICATION)).trim(), /^\d/);
    const dump = await shell('dumpsys', 'package', APPLICATION);
    await writeFile(path.join(output, `${label}-package.txt`), dump);
    const installed = packageState(dump);
    assert.equal(installed.versionName, expectedVersion);
    await screenshot(`${label}-startup`);
    return installed;
  };
  const checkUpdateUi = async label => {
    const control = await findText('检查更新', true);
    assert.ok(control, 'The real software-update control must be accessible');
    await tap(control);
    const result = await until(async () => {
      const nodes = await snapshot();
      const text = nodes.map(node => `${node.text || ''} ${node['content-desc'] || ''}`).join('\n');
      if (/检查失败|版本服务请求受限|无法连接 GitHub/.test(text)) throw new Error(`${label} update check failed: ${text}`);
      return /当前已是最新正式版|发现新版本，可查看说明后下载/.test(text) ? text : null;
    }, `${label} native update-check response`, 90000);
    await screenshot(`${label}-update-check`);
    return { clicked: true, nativeResponseVisible: true, installButtonVisible: result.includes('安装更新') };
  };

  try {
    assert.equal((await shell('pm', 'list', 'packages', APPLICATION)).trim(), '', 'The emulator must start without an installed Brclio app');
    await device(['logcat', '-c']);
    assert.match(await device(['install', oldApk]), /Success/);
    const before = await launch('before', baselineVersion);
    assert.equal(before.versionCode, baselineProof.versionCode);
    const beforeUi = await checkUpdateUi('before');

    // Set a real user-controlled setting through Android's UI. No adb root,
    // run-as, appops mutation or release-app debugging/private-data injection.
    await shell('am', 'start', '-W', '-a', 'android.settings.MANAGE_UNKNOWN_APP_SOURCES', '-d', `package:${APPLICATION}`);
    const toggle = await until(async () => installSourceToggle(await snapshot()), 'install-source permission switch');
    if (toggle.checked !== 'true') await tap(toggle);
    await until(async () => /REQUEST_INSTALL_PACKAGES:\s*allow/.test(await shell('appops', 'get', APPLICATION, 'REQUEST_INSTALL_PACKAGES')),
      'user-authorized install-source setting');
    await snapshot(); await screenshot('before-user-setting');
    const userSettingBefore = (await shell('appops', 'get', APPLICATION, 'REQUEST_INSTALL_PACKAGES')).trim();

    // The -r command performs Package Manager's actual signed replacement and
    // preservation of package data. It does not stand in for in-app installer UI.
    assert.match(await device(['install', '-r', newApk]), /Success/);
    const after = await launch('after', version);
    assert.equal(after.versionCode, proof.versionCode);
    assert.equal(after.userId, before.userId, 'Upgrade changed the application UID');
    assert.equal(after.firstInstallTime, before.firstInstallTime, 'This was a reinstall rather than an in-place upgrade');
    const userSettingAfter = (await shell('appops', 'get', APPLICATION, 'REQUEST_INSTALL_PACKAGES')).trim();
    assert.match(userSettingAfter, /REQUEST_INSTALL_PACKAGES:\s*allow/, 'Upgrade lost the user-selected install-source permission');
    const afterUi = await checkUpdateUi('after');
    const crashes = await device(['logcat', '-d', '-b', 'crash']);
    assert.ok(!crashes.includes(APPLICATION), 'The old or replacement application crashed');
    const report = {
      verifiedAt: new Date().toISOString(), emulator: { api: (await shell('getprop', 'ro.build.version.sdk')).trim(),
        abi: (await shell('getprop', 'ro.product.cpu.abi')).trim(), disposable: true },
      baseline: { tag: baselineTag, ...before, sha256: hash(await readFile(oldApk)), checksumAndSignatureVerified: true },
      candidate: { tag, ...after, sha256: proof.apk.sha256, sourceCommit, signatureVerified: true },
      installation: { method: 'adb install -r', succeeded: true, uidPreserved: true, firstInstallTimePreserved: true },
      retainedUserSetting: { name: 'Allow from this source', setThroughSystemUi: true,
        before: userSettingBefore, after: userSettingAfter, preserved: true },
      updateUi: { before: beforeUi, after: afterUi }, oldAndNewLaunchVerified: true, appCrashDetected: false,
      limitations: ['The actual system Package Manager replacement was tested. In-app APK download and system installer confirmation were not automated; no newer public release exists for the unpublished candidate.'],
    };
    await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
    // The publishing job receives only this post-gate manifest and the same APK.
    // Bind the acceptance result to the precise signed bytes and source commit.
    proof.emulatorUpgrade = {
      verifiedAt: report.verifiedAt, method: 'adb install -r', apiLevel: Number(report.emulator.api),
      sourceCommit, apkSha256: proof.apk.sha256, targetVersion: version, targetVersionCode: proof.versionCode,
      baselineVersion, baselineVersionCode: baselineProof.versionCode,
      signaturesVerified: true, oldAndNewLaunchVerified: true, uidPreserved: true,
      firstInstallTimePreserved: true, userSettingPreserved: true, updateCheckUiVerified: true,
      inAppInstallerConfirmationTested: false,
    };
    await writeFile(path.join(ROOT, 'dist-android/android-update.json'), JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify(report));
    return report;
  } finally {
    await writeFile(path.join(output, 'last-ui.xml'), lastXml).catch(() => {});
    await screenshot('last-screen').catch(() => {});
    await device(['logcat', '-d']).then(log => writeFile(path.join(output, 'logcat.txt'), log)).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyAndroidUpgrade().catch(error => { console.error(error.message); process.exitCode = 1; });
}
