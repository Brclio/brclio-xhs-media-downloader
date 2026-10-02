import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { verifyPackagedAndroidProxy } from '../scripts/verify-packaged-android-proxy.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const pinnedLock = JSON.parse(readFileSync(new URL('../desktop/resources/update-proxy/runtime.lock.json', import.meta.url), 'utf8'));
const launcherSource = readFileSync(new URL('../desktop/resources/update-proxy/android-parent-launcher.c', import.meta.url));
const license = readFileSync(new URL('../desktop/resources/update-proxy/LICENSE', import.meta.url));
const abis = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];

function elf(abi, content) {
  const [elfClass, machine] = { 'arm64-v8a': [2, 183], 'armeabi-v7a': [1, 40], x86_64: [2, 62] }[abi];
  const buffer = Buffer.alloc(128);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, elfClass, 1, 1]).copy(buffer);
  buffer.writeUInt16LE(3, 16); buffer.writeUInt16LE(machine, 18); buffer.writeUInt32LE(1, 20);
  buffer.write(content, 64);
  return buffer;
}

function zip(entries) {
  const records = [];
  const directories = [];
  let offset = 0;
  let index = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name);
    const method = index++ % 2 ? 0 : 8;
    const payload = method === 8 ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    records.push(local, filename, payload); directories.push(central, filename);
    offset += local.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, directory, end]);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'brclio-apk-proxy-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apk = join(root, 'fixture.apk');
  const runtimeLock = structuredClone(pinnedLock);
  const sourceTar = Buffer.from('upstream source tar fixture');
  const source = gzipSync(sourceTar);
  runtimeLock.source.sha256 = hash(source); runtimeLock.source.bytes = source.length;
  runtimeLock.source.tarSha256 = hash(sourceTar); runtimeLock.source.tarBytes = sourceTar.length;
  const expectedLaunchers = {};
  const buildInfo = { schemaVersion: 1, version: runtimeLock.version, sourceCommit: runtimeLock.sourceCommit,
    sourceUrl: runtimeLock.source.url, sourceSha256: runtimeLock.source.sha256, license: runtimeLock.license,
    binaries: {}, parentLaunchers: {} };
  const entries = new Map([
    ['assets/update-proxy/subscription.json', Buffer.from(JSON.stringify({ subscriptionUrls: [], subscriptionUrl: '' }))],
    ['assets/update-proxy/corresponding-source.tar.gz', source],
    ['assets/update-proxy/LICENSE', license],
    ['assets/update-proxy/NOTICE', Buffer.from(`GNU General Public License ${runtimeLock.version} ${runtimeLock.sourceCommit} corresponding-source.tar.gz`)],
    ['assets/update-proxy/android-parent-launcher.c', launcherSource],
  ]);
  for (const abi of abis) {
    const core = elf(abi, `core-${abi}`);
    const launcher = elf(abi, `launcher-${abi}`);
    expectedLaunchers[abi] = launcher;
    const pin = runtimeLock.targets[`android-${abi}`];
    pin.binarySha256 = hash(core); pin.binaryBytes = core.length;
    buildInfo.binaries[`android-${abi}`] = { asset: pin.asset, archiveSha256: pin.sha256,
      executable: 'libbrclio_update_proxy.so', upstreamBinarySha256: hash(core), upstreamBinaryBytes: core.length };
    buildInfo.parentLaunchers[abi] = { executable: 'libbrclio_update_proxy_launcher.so', ndkVersion: '27.2.12479018',
      androidApi: 26, sourceSha256: hash(launcherSource), binarySha256: hash(launcher), binaryBytes: launcher.length };
    entries.set(`lib/${abi}/libbrclio_update_proxy.so`, core);
    entries.set(`lib/${abi}/libbrclio_update_proxy_launcher.so`, launcher);
  }
  const save = () => {
    entries.set('assets/update-proxy/build-info.json', Buffer.from(JSON.stringify(buildInfo)));
    writeFileSync(apk, zip([...entries]));
  };
  const verify = () => { save(); return verifyPackagedAndroidProxy(apk, { runtimeLock, expectedLaunchers }); };
  return { apk, entries, runtimeLock, expectedLaunchers, buildInfo, sourceTar, save, verify };
}

test('APK archive gate verifies empty subscriptions, every ABI, source and current launchers without extraction', (t) => {
  const f = fixture(t);
  const report = f.verify();
  assert.equal(report.bundledSubscriptionsAbsent, true);
  assert.equal(report.configurationSource, 'management-api');
  assert.equal(report.coreCount, 3); assert.equal(report.launcherCount, 3);
  assert.equal(report.sourceArchiveVerified, true); assert.equal(report.licenseVerified, true);
  assert.deepEqual(report.binaries.map((binary) => binary.abi), abis);
  assert.equal(report.apkSha256, hash(readFileSync(f.apk)));
  f.entries.delete('assets/update-proxy/corresponding-source.tar.gz');
  f.entries.set('assets/update-proxy/corresponding-source.tar', f.sourceTar);
  assert.equal(f.verify().sourceArchiveVerified, true, 'Android asset merger decompresses gzip assets');
});

test('APK gate rejects a missing core or launcher for any supported ABI', (t) => {
  for (const abi of abis) {
    const f = fixture(t);
    const corePath = `lib/${abi}/libbrclio_update_proxy.so`;
    const core = f.entries.get(corePath);
    f.entries.delete(corePath);
    assert.throws(f.verify, /Missing APK update proxy resource/);
    f.entries.set(corePath, core);
    f.entries.delete(`lib/${abi}/libbrclio_update_proxy_launcher.so`);
    assert.throws(f.verify, /Missing APK update proxy resource/);
  }
});

test('APK gate rejects preset plural or legacy URLs without revealing their values', (t) => {
  const f = fixture(t);
  const privateUrl = 'https://example.com/sub?token=private-fixture-value';
  for (const bootstrap of [{ subscriptionUrls: [privateUrl], subscriptionUrl: '' },
    { subscriptionUrls: [], subscriptionUrl: privateUrl }, { subscriptionUrls: [], subscriptionUrl: '', extra: privateUrl }]) {
    f.entries.set('assets/update-proxy/subscription.json', Buffer.from(JSON.stringify(bootstrap)));
    assert.throws(f.verify, (error) => {
      assert.doesNotMatch(error.message, /private-fixture-value|example\.com|token=/);
      return /must not contain preset subscriptions/.test(error.message);
    });
  }
});

test('APK gate rejects a tampered core even when its embedded checksum is rewritten', (t) => {
  const f = fixture(t);
  const core = Buffer.from(f.entries.get('lib/arm64-v8a/libbrclio_update_proxy.so'));
  core[100] ^= 1;
  f.entries.set('lib/arm64-v8a/libbrclio_update_proxy.so', core);
  f.buildInfo.binaries['android-arm64-v8a'].upstreamBinarySha256 = hash(core);
  assert.throws(f.verify, /pinned core checksum verification/);
});

test('APK gate rejects a changed launcher despite rewritten embedded hash, plus wrong ELF architecture', (t) => {
  const f = fixture(t);
  const launcher = Buffer.from(f.entries.get('lib/x86_64/libbrclio_update_proxy_launcher.so'));
  launcher[100] ^= 1;
  f.entries.set('lib/x86_64/libbrclio_update_proxy_launcher.so', launcher);
  f.buildInfo.parentLaunchers.x86_64.binarySha256 = hash(launcher);
  assert.throws(f.verify, /differs from the current compiler output/);
  const g = fixture(t);
  const core = Buffer.from(g.entries.get('lib/armeabi-v7a/libbrclio_update_proxy.so'));
  core.writeUInt16LE(183, 18);
  g.entries.set('lib/armeabi-v7a/libbrclio_update_proxy.so', core);
  g.runtimeLock.targets['android-armeabi-v7a'].binarySha256 = hash(core);
  g.buildInfo.binaries['android-armeabi-v7a'].upstreamBinarySha256 = hash(core);
  assert.throws(g.verify, /ELF architecture mismatch/);
});

test('APK gate rejects stale version, altered corresponding source, license and launcher source', (t) => {
  const f = fixture(t);
  f.buildInfo.version = 'v0.0.1';
  assert.throws(f.verify, /source\/version metadata/);
  f.buildInfo.version = f.runtimeLock.version;
  for (const [name, message] of [['corresponding-source.tar.gz', /corresponding-source checksum/],
    ['LICENSE', /license checksum/], ['android-parent-launcher.c', /launcher source does not match/]]) {
    const entry = `assets/update-proxy/${name}`;
    const original = f.entries.get(entry);
    f.entries.set(entry, Buffer.from('tampered resource'));
    assert.throws(f.verify, message);
    f.entries.set(entry, original);
  }
});

test('APK gate rejects truncated, duplicate, encrypted and oversized ZIP resources', (t) => {
  const f = fixture(t);
  f.save();
  const original = readFileSync(f.apk);
  const options = { runtimeLock: f.runtimeLock, expectedLaunchers: f.expectedLaunchers };
  writeFileSync(f.apk, original.subarray(0, original.length - 1));
  assert.throws(() => verifyPackagedAndroidProxy(f.apk, options), /ZIP directory/);
  writeFileSync(f.apk, zip([...f.entries, ['assets/update-proxy/subscription.json', Buffer.from('{}')]]));
  assert.throws(() => verifyPackagedAndroidProxy(f.apk, options), /duplicate/);
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  for (const change of [(buffer) => buffer.writeUInt16LE(1, central + 8), (buffer) => buffer.writeUInt32LE(0xffffffff, central + 24)]) {
    const malformed = Buffer.from(original); change(malformed); writeFileSync(f.apk, malformed);
    assert.throws(() => verifyPackagedAndroidProxy(f.apk, options), /Invalid or missing APK update proxy subscription/);
  }
});
