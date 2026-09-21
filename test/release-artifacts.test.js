import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateArtifacts, createCompatibilityAssets, formatReleaseNotes } from '../scripts/publish-desktop-release.mjs';

const version = '1.7.1';
const sourceSha = 'a'.repeat(40);
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xhs-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [label, platform, arch, suffixes] of [
    ['mac-arm64', 'darwin', 'arm64', ['mac-arm64.dmg', 'mac-arm64.zip']],
    ['mac-x64', 'darwin', 'x64', ['mac-x64.dmg', 'mac-x64.zip']],
    ['windows-x64', 'win32', 'x64', ['windows-x64-setup.exe', 'windows-x64-portable.exe']]
  ]) {
    const files = [];
    for (const suffix of suffixes) {
      const name = `Brclio-XHS-Downloader-${version}-${suffix}`;
      const data = Buffer.from(`test artifact ${name}`);
      await writeFile(path.join(directory, name), data);
      files.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
    await writeFile(path.join(directory, `release-proof-${label}.json`), JSON.stringify({
      version, sourceSha, platform, arch, comparedSources: 27, bundledPythonVerified: true,
      ...(platform === 'darwin' ? { macCodeSignatureVerified: true, macCodeSigning: 'adhoc' } : {}), files
    }));
  }
  return directory;
}

test('release accepts only all six installers built and verified from one commit', async t => {
  const directory = await fixture(t);
  const result = await validateArtifacts(directory, { version, sourceSha });
  assert.equal(result.files.length, 6);
  assert.equal(result.evidence.length, 3);
  assert.ok(result.evidence.filter(proof => proof.platform === 'darwin').every(proof => proof.macCodeSignatureVerified === true && proof.macCodeSigning === 'adhoc'));
  assert.equal(result.evidence.find(proof => proof.platform === 'win32').macCodeSignatureVerified, undefined);
});

test('compatibility aliases preserve the three updater installers, checksums and original proofs', async t => {
  const directory = await fixture(t);
  const { files, evidence } = await validateArtifacts(directory, { version, sourceSha });
  const before = JSON.stringify({ files, evidence });
  const aliases = await createCompatibilityAssets(directory, { version, files });
  assert.equal(aliases.length, 3);
  assert.deepEqual(aliases.map(file => file.name), [
    `XHS-Downloader-${version}-mac-arm64.dmg`, `XHS-Downloader-${version}-mac-x64.dmg`,
    `XHS-Downloader-${version}-windows-x64-setup.exe`
  ]);
  for (const alias of aliases) {
    const bytes = await readFile(path.join(directory, alias.name));
    assert.deepEqual(bytes, await readFile(path.join(directory, alias.sourceName)));
    assert.equal(bytes.length, alias.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), alias.sha256);
  }
  assert.equal(JSON.stringify({ files, evidence }), before);
  for (const proof of evidence) {
    const label = proof.platform === 'darwin' ? `mac-${proof.arch}` : 'windows-x64';
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, `release-proof-${label}.json`))), proof);
  }
  await assert.rejects(createCompatibilityAssets(directory, { version, files }), { code: 'EEXIST' });
});

test('compatibility aliases reject changed source bytes and ambiguous source metadata', async t => {
  const directory = await fixture(t);
  const { files } = await validateArtifacts(directory, { version, sourceSha });
  const first = files.find(file => file.name.endsWith('mac-arm64.dmg'));
  await assert.rejects(createCompatibilityAssets(directory, { version, files: [...files, first] }), /unique compatibility source/);
  const file = path.join(directory, first.name);
  const bytes = await readFile(file);
  bytes[0] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(createCompatibilityAssets(directory, { version, files }), /source checksum mismatch/);
});

test('release formatting removes only the leading title and resolves relative documentation links', () => {
  const result = formatReleaseNotes('# v1.8.0：更新\r\n\r\n## 下载安装\r\n\r\n[说明](../feedback-diagnostics.md#日志)\r\n[下载](https://github.com/example/file.dmg)\r\n[本页](#下载)\r\n\r\n# 附加标题\r\n```md\r\n[示例](../example.md)\r\n```\r\n', 'v1.8.0');
  assert.equal(result.name, 'v1.8.0：更新');
  assert.ok(result.body.startsWith('## 下载安装\n'));
  assert.ok(!result.body.includes('# v1.8.0：更新'));
  assert.ok(result.body.includes('https://github.com/Brclio/brclio-xhs-media-downloader/blob/v1.8.0/docs/feedback-diagnostics.md#%E6%97%A5%E5%BF%97'));
  assert.ok(result.body.includes('[下载](https://github.com/example/file.dmg)'));
  assert.ok(result.body.includes('[本页](#下载)'));
  assert.ok(result.body.includes('# 附加标题\n```md\n[示例](../example.md)\n```'));
  assert.deepEqual(formatReleaseNotes('正文\n# 保留标题', 'v1.8.0'), { name: 'v1.8.0', body: '正文\n# 保留标题\n' });
});

test('release rejects modified installer bytes before upload', async t => {
  const directory = await fixture(t);
  const name = path.join(directory, `Brclio-XHS-Downloader-${version}-mac-arm64.dmg`);
  const original = await readFile(name);
  original[0] ^= 1;
  await writeFile(name, original);
  await assert.rejects(validateArtifacts(directory, { version, sourceSha }), /checksum mismatch/);
});

test('release rejects a build from a different source revision', async t => {
  const directory = await fixture(t);
  await assert.rejects(validateArtifacts(directory, { version, sourceSha: 'b'.repeat(40) }), /release commit/);
});

test('release rejects incomplete and unexpected platform assets', async t => {
  const directory = await fixture(t);
  await rm(path.join(directory, `Brclio-XHS-Downloader-${version}-windows-x64-setup.exe`));
  await assert.rejects(validateArtifacts(directory, { version, sourceSha }), /three verified/);
});

for (const label of ['mac-arm64', 'mac-x64']) {
  for (const [description, value] of [['missing', undefined], ['failed', false], ['string instead of boolean', 'true']]) {
    test(`release rejects ${label} when complete signature verification is ${description}`, async t => {
      const directory = await fixture(t);
      const proofPath = path.join(directory, `release-proof-${label}.json`);
      const proof = JSON.parse(await readFile(proofPath, 'utf8'));
      if (value === undefined) delete proof.macCodeSignatureVerified;
      else proof.macCodeSignatureVerified = value;
      await writeFile(proofPath, JSON.stringify(proof));
      await assert.rejects(validateArtifacts(directory, { version, sourceSha }), /Complete macOS code signature must be verified before release/);
    });
  }
  for (const kind of [undefined, 'linker-adhoc', 'unsigned', 'notarized']) {
    test(`release rejects ${label} with signing kind ${kind ?? 'missing'}`, async t => {
      const directory = await fixture(t);
      const proofPath = path.join(directory, `release-proof-${label}.json`);
      const proof = JSON.parse(await readFile(proofPath, 'utf8'));
      if (kind === undefined) delete proof.macCodeSigning;
      else proof.macCodeSigning = kind;
      await writeFile(proofPath, JSON.stringify(proof));
      await assert.rejects(validateArtifacts(directory, { version, sourceSha }), /Verified macOS signing kind must be adhoc or developer-id/);
    });
  }
}

test('release accepts verified Developer ID signatures without assuming notarization', async t => {
  const directory = await fixture(t);
  for (const label of ['mac-arm64', 'mac-x64']) {
    const proofPath = path.join(directory, `release-proof-${label}.json`);
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    proof.macCodeSigning = 'developer-id';
    await writeFile(proofPath, JSON.stringify(proof));
  }
  const result = await validateArtifacts(directory, { version, sourceSha });
  assert.equal(result.files.length, 6);
  assert.ok(result.evidence.filter(proof => proof.platform === 'darwin').every(proof => proof.macCodeSigning === 'developer-id' && !Object.hasOwn(proof, 'notarized')));
});
