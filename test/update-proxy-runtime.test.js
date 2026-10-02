import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { extractExecutable, prepareUpdateProxy, runtimeLock, sha256 } from '../scripts/prepare-update-proxy.mjs';

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'brclio-update-proxy-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runtimeZip(entries) {
  const files = [];
  const headers = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const payload = Buffer.from(content);
    const compressed = deflateRawSync(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    files.push(local, filename, compressed);
    headers.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(headers);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

test('runtime preparation never embeds previous environment or local subscription defaults', async (t) => {
  const root = temporaryRoot(t);
  const cache = join(root, 'desktop-runtime/.update-proxy-cache');
  mkdirSync(cache, { recursive: true });
  const source = Buffer.from('source fixture');
  const archive = gzipSync(Buffer.from('core fixture'));
  for (const data of [source, archive]) writeFileSync(join(cache, sha256(data)), data);
  const originalSource = runtimeLock.source;
  runtimeLock.source = { url: 'https://example.invalid/source', sha256: sha256(source), bytes: source.length };
  runtimeLock.targets['mac-fixture'] = { url: 'https://example.invalid/core', sha256: sha256(archive), bytes: archive.length,
    archive: 'gzip', asset: 'fixture.gz' };
  const privateUrl = 'https://example.com/sub?token=private-test-value';
  writeFileSync(join(root, 'update-proxy-subscription.local.json'), JSON.stringify({ subscriptionUrls: [privateUrl], subscriptionUrl: privateUrl }));
  try {
    await prepareUpdateProxy({ platform: 'mac', arch: 'fixture', root, env: {
      XHS_UPDATE_PROXY_SUBSCRIPTION_URLS: JSON.stringify([privateUrl]), XHS_UPDATE_PROXY_SUBSCRIPTION_URL: privateUrl,
    } });
    const directory = join(root, 'desktop-runtime/mac-fixture/proxy');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'subscription.json'), 'utf8')), { subscriptionUrls: [], subscriptionUrl: '' });
    for (const filename of ['subscription.json', 'build-info.json']) {
      assert.doesNotMatch(readFileSync(join(directory, filename), 'utf8'), /private-test-value|example\.com|token=/);
    }
    writeFileSync(join(root, 'update-proxy-subscription.local.json'), '{malformed private-test-value');
    await prepareUpdateProxy({ platform: 'mac', arch: 'fixture', root, env: {
      XHS_UPDATE_PROXY_SUBSCRIPTION_URLS: '[malformed private-test-value', XHS_UPDATE_PROXY_SUBSCRIPTION_URL: privateUrl,
    } });
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'subscription.json'), 'utf8')), { subscriptionUrls: [], subscriptionUrl: '' });
  } finally {
    runtimeLock.source = originalSource;
    delete runtimeLock.targets['mac-fixture'];
  }
});

test('ZIP preparation extracts only one official executable and rejects unexpected layouts', () => {
  const zip = runtimeZip([['README.txt', 'read me'], ['mihomo-windows-amd64.exe', 'executable']]);
  assert.equal(extractExecutable(zip, { archive: 'zip' }).toString(), 'executable');
  assert.throws(() => extractExecutable(runtimeZip([['../mihomo.exe', 'evil']]), { archive: 'zip' }), /exactly one/);
  assert.throws(() => extractExecutable(runtimeZip([['mihomo.exe', 'a'], ['mihomo-extra.exe', 'b']]), { archive: 'zip' }), /exactly one/);
  assert.throws(() => extractExecutable(zip.subarray(0, zip.length - 1), { archive: 'zip' }), /ZIP/);
  const encrypted = Buffer.from(zip);
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), 0);
  const executableCentral = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 4);
  encrypted.writeUInt16LE(1, executableCentral + 8);
  assert.throws(() => extractExecutable(encrypted, { archive: 'zip' }), /Invalid/);
});

test('gzip runtime extraction rejects corrupted archives', () => {
  const archive = gzipSync(Buffer.from('verified runtime'));
  assert.equal(extractExecutable(archive, { archive: 'gzip' }).toString(), 'verified runtime');
  archive[archive.length - 8] ^= 0xff;
  assert.throws(() => extractExecutable(archive, { archive: 'gzip' }));
});

test('pinned runtime lock contains checksums and corresponding-source/license for every supported target', () => {
  assert.deepEqual(Object.keys(runtimeLock.targets).sort(), ['android-arm64-v8a', 'android-armeabi-v7a', 'android-x86_64', 'mac-arm64', 'mac-x64', 'win-x64']);
  for (const spec of Object.values(runtimeLock.targets)) {
    assert.match(spec.sha256, /^[a-f0-9]{64}$/);
    assert.ok(spec.bytes > 0);
    assert.ok(spec.url.startsWith(`https://github.com/MetaCubeX/mihomo/releases/download/${runtimeLock.version}/`));
  }
  assert.match(runtimeLock.sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(runtimeLock.source.url.endsWith(runtimeLock.sourceCommit));
  assert.equal(sha256(readFileSync(new URL('../desktop/resources/update-proxy/LICENSE', import.meta.url))), runtimeLock.licenseSha256);
});
