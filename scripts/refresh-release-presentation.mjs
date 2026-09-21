// Explicit maintenance operation for existing releases. New releases use the
// normal publisher. Never replace installer bytes or move a published tag.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatReleaseNotes } from './publish-desktop-release.mjs';

const repository = 'Brclio/brclio-xhs-media-downloader';
const tag = process.env.RELEASE_TAG;
assert.match(tag || '', /^v\d+\.\d+\.\d+$/);
assert.equal(process.env.GITHUB_REPOSITORY, repository);
assert.ok(process.env.GH_TOKEN);
const version = tag.slice(1);
const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
const api = (endpoint, payload) => JSON.parse(gh(['api', `repos/${repository}/${endpoint}`,
  ...(payload ? ['--method', 'PATCH', '--input', payload] : [])]));
const directory = await mkdtemp(path.join(tmpdir(), 'brclio-release-refresh-'));
const payload = async (name, data) => {
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify(data));
  return file;
};
const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
let release = api(`releases/tags/${tag}`);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);
assert.notEqual(release.immutable, true);
await writeFile(path.join(directory, 'release-before.json'), JSON.stringify(release, null, 2));
gh(['release', 'download', tag, '--repo', repository, '--pattern', 'build-evidence.json', '--dir', directory]);
const evidenceFile = path.join(directory, 'build-evidence.json');
const evidenceAsset = release.assets.find(asset => asset.name === 'build-evidence.json');
assert.equal(evidenceAsset.digest, `sha256:${await sha256(evidenceFile)}`);
const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
assert.equal(evidence.repository, repository);
assert.equal(evidence.tag, tag);
const sourceSha = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
assert.equal(evidence.sourceSha, sourceSha);
assert.equal(evidence.builds.length, 3);
for (const proof of evidence.builds) {
  assert.equal(proof.sourceSha, sourceSha);
  assert.equal(proof.version, version);
  assert.equal(proof.bundledPythonVerified, true);
  if (proof.platform === 'darwin') assert.equal(proof.macCodeSignatureVerified, true);
}
const proofFiles = evidence.builds.flatMap(proof => proof.files);
const suffixes = ['mac-arm64.dmg', 'mac-arm64.zip', 'mac-x64.dmg', 'mac-x64.zip',
  'windows-x64-setup.exe', 'windows-x64-portable.exe'];
assert.equal(proofFiles.length, 6);
const plans = suffixes.map(suffix => {
  const legacyName = `XHS-Downloader-${version}-${suffix}`;
  const name = `Brclio-${legacyName}`;
  const matches = proofFiles.filter(file => [legacyName, name].includes(file.name));
  assert.equal(matches.length, 1);
  const proof = matches[0];
  assert.match(proof.sha256, /^[a-f0-9]{64}$/);
  const legacy = release.assets.find(asset => asset.name === legacyName);
  const branded = release.assets.find(asset => asset.name === name);
  const compatibility = suffix.endsWith('.dmg') || suffix.endsWith('-setup.exe');
  assert.ok(legacy || branded, `Missing original asset: ${name}`);
  if (compatibility) assert.ok(legacy, `Keep old updater URL: ${legacyName}`);
  for (const asset of [legacy, branded].filter(Boolean)) {
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, proof.bytes);
    assert.equal(asset.digest, `sha256:${proof.sha256}`);
  }
  return { name, legacyName, proof, legacy, branded, compatibility };
});
// Complete and verify every necessary download before changing public metadata.
for (const plan of plans.filter(plan => plan.compatibility && !plan.branded)) {
  gh(['release', 'download', tag, '--repo', repository, '--pattern', plan.legacyName, '--dir', directory]);
  const original = path.join(directory, plan.legacyName);
  assert.equal(await sha256(original), plan.proof.sha256);
  await copyFile(original, path.join(directory, plan.name));
}
for (const plan of plans) {
  if (!plan.branded) {
    if (plan.compatibility) {
      gh(['release', 'upload', tag, path.join(directory, plan.name), '--repo', repository]);
    } else {
      api(`releases/assets/${plan.legacy.id}`, await payload('rename.json', { name: plan.name, label: '' }));
    }
  }
  if (plan.compatibility) {
    api(`releases/assets/${plan.legacy.id}`, await payload('label.json', {
      label: `Brclio 旧版自动更新兼容包 · ${plan.legacyName.replace(/^XHS-Downloader-/, '')}`
    }));
  }
}
release = api(`releases/${release.id}`);
const publishedAssets = [];
const compatibilityAssets = [];
for (const plan of plans) {
  for (const name of [plan.name, ...(plan.compatibility ? [plan.legacyName] : [])]) {
    const matches = release.assets.filter(asset => asset.name === name);
    assert.equal(matches.length, 1);
    const asset = matches[0];
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, plan.proof.bytes);
    assert.equal(asset.digest, `sha256:${plan.proof.sha256}`);
    assert.equal(asset.browser_download_url, `https://github.com/${repository}/releases/download/${tag}/${name}`);
    publishedAssets.push({ name, sourceName: plan.proof.name, bytes: plan.proof.bytes, sha256: plan.proof.sha256 });
  }
  if (plan.compatibility) compatibilityAssets.push({ name: plan.legacyName, sourceName: plan.name,
    bytes: plan.proof.bytes, sha256: plan.proof.sha256 });
}
// Preserve the original source/build evidence; append distribution-name mappings.
evidence.publishedAssets = publishedAssets;
evidence.compatibilityAssets = compatibilityAssets;
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
const sums = path.join(directory, 'SHA256SUMS.txt');
await writeFile(sums, publishedAssets.sort((a, b) => a.name.localeCompare(b.name))
  .map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
gh(['release', 'upload', tag, evidenceFile, sums, '--repo', repository, '--clobber']);
release = api(`releases/${release.id}`);
for (const file of [evidenceFile, sums]) {
  const asset = release.assets.find(asset => asset.name === path.basename(file));
  assert.equal(asset.digest, `sha256:${await sha256(file)}`);
}
const { name, body } = formatReleaseNotes(await readFile(`docs/releases/${tag}.md`, 'utf8'), tag);
const links = [...body.matchAll(/\]\((https:\/\/github\.com\/[^)]+\/releases\/download\/[^)]+)\)/g)].map(match => match[1]);
assert.equal(new Set(links).size, 6);
for (const link of links) assert.ok(release.assets.some(asset => asset.browser_download_url === link));
release = api(`releases/${release.id}`, await payload('notes.json', { name, body }));
assert.equal(release.body, body);
assert.equal(release.name, name);
assert.equal(execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim(), sourceSha);
console.log(`Updated ${release.html_url}: 6 Brclio downloads + 3 legacy updater aliases, unchanged installer digests and source tag.`);
