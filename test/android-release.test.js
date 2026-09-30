import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { androidVersion, validateReleaseProof, validateReleaseFiles } from '../scripts/publish-android-release.mjs';

const options = { tag: 'android-v1.0.0', sourceCommit: 'a'.repeat(40), certificateSha256: 'b'.repeat(64) };
const apk = Buffer.from('signed-apk-fixture');
const proof = () => ({ schemaVersion: 1, platform: 'android', version: '1.0.0', versionCode: 10000,
  applicationId: 'com.brclio.xhs', minSdk: 26, signingCertificateSha256: options.certificateSha256,
  sourceCommit: options.sourceCommit, sourceDirty: false,
  apk: { name: 'Brclio-XHS-Android-1.0.0-release.apk', bytes: apk.length,
    sha256: createHash('sha256').update(apk).digest('hex') } });

test('Android publication cannot use desktop, prerelease, leading-zero or injected tags', () => {
  assert.equal(androidVersion('android-v1.0.0'), '1.0.0');
  for (const tag of ['v1.0.0', 'desktop-v1.0.0', 'android-v01.0.0', 'android-v1.0.0-beta', 'android-v1.0.0\n', 'android-v1.0.0\n--latest']) {
    assert.throws(() => androidVersion(tag));
  }
});

test('Android release proof binds official package, version, certificate and clean source commit', () => {
  assert.equal(validateReleaseProof(proof(), options), '1.0.0');
  for (const [key, value] of Object.entries({ version: '1.0.1', versionCode: 0, applicationId: 'com.brclio.xhs.debug',
    minSdk: 23, signingCertificateSha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40), sourceDirty: true })) {
    assert.throws(() => validateReleaseProof({ ...proof(), [key]: value }, options), key);
  }
  assert.throws(() => validateReleaseProof({ ...proof(), apk: { ...proof().apk, name: '../wrong.apk' } }, options));
});

test('Android 1.0.3 publication requires an emulator acceptance result bound to the exact signed build', () => {
  const release = { ...proof(), version: '1.0.3', versionCode: 10003,
    apk: { ...proof().apk, name: 'Brclio-XHS-Android-1.0.3-release.apk' } };
  const checked = { ...options, tag: 'android-v1.0.3' };
  assert.throws(() => validateReleaseProof(release, checked), /emulator upgrade gate/);
  assert.equal(validateReleaseProof(release, { ...checked, requireEmulatorUpgrade: false }), '1.0.3',
    'The emulator gate must first be able to validate its signed input before testing it');
  release.emulatorUpgrade = {
    verifiedAt: '2026-09-30T00:00:00.000Z', method: 'adb install -r', apiLevel: 35,
    sourceCommit: options.sourceCommit, apkSha256: release.apk.sha256, targetVersion: '1.0.3', targetVersionCode: 10003,
    baselineVersion: '1.0.2', baselineVersionCode: 10002, signaturesVerified: true,
    oldAndNewLaunchVerified: true, uidPreserved: true, firstInstallTimePreserved: true,
    userSettingPreserved: true, updateCheckUiVerified: true, inAppInstallerConfirmationTested: false,
  };
  assert.equal(validateReleaseProof(release, checked), '1.0.3');
  const next = { ...release, version: '1.0.4', versionCode: 10004,
    apk: { ...release.apk, name: 'Brclio-XHS-Android-1.0.4-release.apk' },
    emulatorUpgrade: { ...release.emulatorUpgrade, targetVersion: '1.0.4', targetVersionCode: 10004 } };
  assert.throws(() => validateReleaseProof(next, { ...checked, tag: 'android-v1.0.4' }), /manual-fallback acceptance/);
  next.emulatorUpgrade.manualFallbackFixtureVerified = true;
  assert.equal(validateReleaseProof(next, { ...checked, tag: 'android-v1.0.4' }), '1.0.4');
  for (const [key, value] of Object.entries({ apkSha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40),
    targetVersionCode: 10002, baselineVersionCode: 10003, oldAndNewLaunchVerified: false,
    userSettingPreserved: false, inAppInstallerConfirmationTested: true })) {
    assert.throws(() => validateReleaseProof({ ...release, emulatorUpgrade: { ...release.emulatorUpgrade, [key]: value } }, checked), key);
  }
});

test('Android asset validation rejects modified APK bytes and checksums before any upload', () => {
  const directory = mkdtempSync(join(tmpdir(), 'android-release-test-'));
  const data = proof();
  try {
    writeFileSync(join(directory, data.apk.name), apk);
    writeFileSync(join(directory, 'android-update.json'), JSON.stringify(data));
    const line = `${data.apk.sha256}  ${data.apk.name}\n`;
    writeFileSync(join(directory, `${data.apk.name}.sha256`), line);
    writeFileSync(join(directory, 'SHA256SUMS.txt'), line);
    assert.equal(validateReleaseFiles(directory, options).names.length, 4);
    writeFileSync(join(directory, data.apk.name), Buffer.alloc(apk.length));
    assert.throws(() => validateReleaseFiles(directory, options), /APK checksum mismatch/);
    writeFileSync(join(directory, data.apk.name), apk);
    writeFileSync(join(directory, `${data.apk.name}.sha256`), `${'0'.repeat(64)}  ${data.apk.name}\n`);
    assert.throws(() => validateReleaseFiles(directory, options), /Checksum file mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
