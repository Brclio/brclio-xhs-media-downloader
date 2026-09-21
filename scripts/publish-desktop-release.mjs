import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { readFile, readdir, writeFile, lstat, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'Brclio/brclio-xhs-media-downloader';
const TARGETS = [
  { label: 'mac-arm64', platform: 'darwin', arch: 'arm64', suffixes: ['mac-arm64.dmg', 'mac-arm64.zip'] },
  { label: 'mac-x64', platform: 'darwin', arch: 'x64', suffixes: ['mac-x64.dmg', 'mac-x64.zip'] },
  { label: 'windows-x64', platform: 'win32', arch: 'x64', suffixes: ['windows-x64-setup.exe', 'windows-x64-portable.exe'] }
];
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function validateArtifacts(directory, { version, sourceSha }) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const allowedNames = TARGETS.flatMap(target => [`release-proof-${target.label}.json`, ...target.suffixes.map(suffix => `Brclio-XHS-Downloader-${version}-${suffix}`)]).sort();
  assert.deepEqual((await readdir(directory)).sort(), allowedNames, 'Expected exactly three verified platform artifacts');
  const files = [];
  const evidence = [];
  for (const target of TARGETS) {
    const proofPath = path.join(directory, `release-proof-${target.label}.json`);
    assert.ok((await lstat(proofPath)).isFile());
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    assert.equal(proof.version, version);
    assert.equal(proof.sourceSha, sourceSha, 'Builds must come from the release commit');
    assert.equal(proof.platform, target.platform);
    assert.equal(proof.arch, target.arch);
    assert.equal(proof.bundledPythonVerified, true);
    if (target.platform === 'darwin') {
      // The native build verifier sets these only after checking the complete
      // application signature, including sealed resources and nested code.
      // A linker-generated signature on the main binary is not sufficient.
      assert.equal(proof.macCodeSignatureVerified, true,
        `Complete macOS code signature must be verified before release: ${target.label}`);
      assert.ok(['adhoc', 'developer-id'].includes(proof.macCodeSigning),
        `Verified macOS signing kind must be adhoc or developer-id: ${target.label}`);
    }
    assert.ok(Number.isInteger(proof.comparedSources) && proof.comparedSources >= 27);
    const expected = target.suffixes.map(suffix => `Brclio-XHS-Downloader-${version}-${suffix}`).sort();
    assert.deepEqual(proof.files.map(file => file.name).sort(), expected);
    for (const file of proof.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      const local = path.join(directory, file.name);
      const info = await lstat(local);
      assert.ok(info.isFile() && info.size === file.bytes && info.size > 0);
      assert.equal(await digest(local), file.sha256, `Artifact checksum mismatch: ${file.name}`);
      files.push(file);
    }
    evidence.push(proof);
  }
  return { files: files.sort((a, b) => a.name.localeCompare(b.name)), evidence };
}

// Shipped clients through v1.8.0 require these exact legacy names. Keep
// byte-identical aliases until those clients no longer need to update directly.
export async function createCompatibilityAssets(directory, { version, files }) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const aliases = [];
  for (const suffix of ['mac-arm64.dmg', 'mac-x64.dmg', 'windows-x64-setup.exe']) {
    const sourceName = `Brclio-XHS-Downloader-${version}-${suffix}`;
    const matches = files.filter(file => file.name === sourceName);
    assert.equal(matches.length, 1, `Missing unique compatibility source: ${sourceName}`);
    const file = matches[0];
    const source = path.join(directory, sourceName);
    const info = await lstat(source);
    assert.ok(info.isFile() && info.size === file.bytes && file.bytes > 0);
    assert.equal(await digest(source), file.sha256, `Compatibility source checksum mismatch: ${sourceName}`);
    const name = sourceName.replace(/^Brclio-/, '');
    const destination = path.join(directory, name);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    assert.equal(await digest(destination), file.sha256);
    aliases.push({ name, sourceName, bytes: file.bytes, sha256: file.sha256 });
  }
  return aliases;
}

export function formatReleaseNotes(notes, tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  const lines = notes.replace(/^\uFEFF/, '').split(/\r?\n/);
  const heading = /^#\s+(.+?)\s*$/.exec(lines[0]);
  const name = heading ? heading[1] : tag;
  if (heading) lines.shift();
  let fence = null;
  const body = lines.map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/(\[[^\]\n]+\]\()((?:\.\.?\/)[^\s)]+\.md(?:#[^\s)]*)?)(\))/g,
      (_match, prefix, link, suffix) => {
        const url = new URL(link, 'https://release.invalid/docs/releases/');
        return `${prefix}https://github.com/${REPOSITORY}/blob/${tag}${url.pathname}${url.hash}${suffix}`;
      });
  }).join('\n').trim();
  return { name, body: `${body}\n` };
}

const compatibilityLabel = file => `Brclio 旧版自动更新兼容包 · ${file.name.replace(/^XHS-Downloader-/, '')}`;

export async function publishRelease() {
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(process.env.GITHUB_REF_TYPE, 'tag');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const tag = `v${pkg.version}`;
  assert.equal(process.env.GITHUB_REF_NAME, tag);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const directory = path.resolve('release-artifacts');
  const { files, evidence } = await validateArtifacts(directory, { version: pkg.version, sourceSha });
  const notes = await readFile(`docs/releases/${tag}.md`, 'utf8');
  const { name: releaseName, body: releaseBody } = formatReleaseNotes(notes, tag);
  assert.ok(process.env.GH_TOKEN, 'GitHub release token is required');
  const api = async (endpoint, options = {}) => {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${endpoint}`, {
      ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`GitHub ${options.method || 'GET'} ${endpoint}: HTTP ${response.status}`);
    return response.json();
  };
  // List also includes drafts, unlike the tag lookup endpoint.
  const releases = await api('releases?per_page=100');
  let release = releases.find(item => item.tag_name === tag);
  if (release) assert.equal(release.draft, true, 'Never replace already-published release assets');
  else release = await api('releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: sourceSha,
    name: releaseName, body: releaseBody, draft: true, prerelease: false }) });
  const compatibilityAssets = await createCompatibilityAssets(directory, { version: pkg.version, files });
  const publishedFiles = [...files, ...compatibilityAssets].sort((a, b) => a.name.localeCompare(b.name));
  const sums = publishedFiles.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n';
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums);
  await writeFile(path.join(directory, 'build-evidence.json'), JSON.stringify({ repository: REPOSITORY, tag, sourceSha, builds: evidence, compatibilityAssets }, null, 2) + '\n');
  const uploads = [...publishedFiles.map(file => file.name), 'SHA256SUMS.txt', 'build-evidence.json'];
  const uploadPaths = uploads.map(name => {
    const alias = compatibilityAssets.find(file => file.name === name);
    return path.join(directory, name) + (alias ? `#${compatibilityLabel(alias)}` : '');
  });
  execFileSync('gh', ['release', 'upload', tag, ...uploadPaths, '--repo', REPOSITORY, '--clobber'],
    { stdio: 'inherit', timeout: 300000 });
  release = await api(`releases/${release.id}`);
  assert.equal(release.draft, true);
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), [...uploads].sort());
  for (const name of uploads) {
    const asset = release.assets.find(item => item.name === name);
    assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, (await lstat(path.join(directory, name))).size);
    assert.equal(asset.digest, `sha256:${await digest(path.join(directory, name))}`, `GitHub upload digest mismatch: ${name}`);
    const alias = compatibilityAssets.find(file => file.name === name);
    if (alias) assert.equal(asset.label, compatibilityLabel(alias));
  }
  release = await api(`releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, prerelease: false, make_latest: 'true', name: releaseName, body: releaseBody }) });
  assert.equal(release.draft, false);
  console.log(`Published verified release: ${release.html_url}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publishRelease();
