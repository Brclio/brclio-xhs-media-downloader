import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'Brclio/brclio-xhs-media-downloader';
const SOURCE_FILES = [
  'api/image.js', 'api/parse.js', 'api/video.js', 'app.js',
  'changelog.css', 'changelog.html', 'desktop-ui.css', 'desktop-ui.js',
  'desktop/login-state.js', 'desktop/main.js', 'desktop/media-download.js',
  'desktop/note-state.js', 'desktop/preload.cjs', 'desktop/profile-browser.js',
  'desktop/profile-manager.js', 'desktop/profile-source.js', 'desktop/protocol.js',
  'desktop/python-backend.js', 'index.html', 'lib/archive.js', 'lib/clipboard.js',
  'lib/xhs.js', 'style.css', 'support.css', 'visit-counter.css', 'visit-counter.js',
].sort();

const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

export function expectedInstallerNames(version, tag) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  assert.ok(tag === `v${version}` || tag === `desktop-v${version}`, 'Tag must match package version');
  return ['dmg', 'zip'].map(extension => `XHS-Downloader-${version}-mac-x64.${extension}`);
}

export async function verifyAsar(archive, sourceDirectory, version) {
  const require = createRequire(path.join(sourceDirectory, 'package.json'));
  const asar = require('@electron/asar');
  const expectedSources = [...SOURCE_FILES];
  // Historical v1.5 artifacts predate the update manager.
  try { await stat(path.join(sourceDirectory, 'desktop/update-manager.js')); expectedSources.push('desktop/update-manager.js'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  expectedSources.sort();
  const actualSources = asar.listPackage(archive)
    .map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
    .filter(name => /\.(?:js|cjs|html|css)$/.test(name)).sort();
  assert.deepEqual(actualSources, expectedSources, 'Packaged source must contain exactly the reviewed application files');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(packaged.version, version, 'ASAR package version mismatch');
  assert.equal(packaged.name, 'brclio-xhs-media-downloader');
  assert.equal(packaged.repository?.url, `git+https://github.com/${REPOSITORY}.git`);
  for (const name of expectedSources) {
    assert.ok(asar.extractFile(archive, name).equals(await readFile(path.join(sourceDirectory, name))),
      `Packaged source differs from release tag: ${name}`);
  }
  return expectedSources.length;
}

export function verifyArchitecture(executable) {
  const architectures = command('lipo', ['-archs', executable]).trim().split(/\s+/);
  assert.deepEqual(architectures, ['x86_64'], 'Intel installer must contain an x86_64 executable');
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyPromotion(env = process.env) {
  assert.equal(process.platform, 'darwin', 'Installer verification requires macOS');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.match(env.SOURCE_SHA || '', /^[a-f0-9]{40}$/);
  assert.match(env.RUN_ID || '', /^\d+$/);
  const sourceDirectory = path.resolve(env.SOURCE_DIRECTORY || 'source');
  const artifactDirectory = path.resolve(env.ARTIFACT_DIRECTORY || 'dist-promote');
  const output = path.resolve(env.VERIFICATION_OUTPUT || 'promotion-verification.json');
  assert.equal(command('git', ['-C', sourceDirectory, 'rev-parse', 'HEAD']).trim(), env.SOURCE_SHA);
  const pkg = JSON.parse(await readFile(path.join(sourceDirectory, 'package.json'), 'utf8'));
  const names = expectedInstallerNames(pkg.version, env.TAG);
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const proofName = 'release-proof-mac-x64.json';
  const hasProof = entries.some(entry => entry.name === proofName);
  assert.deepEqual(entries.map(entry => entry.name).sort(), [...names, ...(hasProof ? [proofName] : [])].sort(), 'Artifact must contain the two Intel installers and optional build evidence');
  assert.ok(entries.every(entry => entry.isFile()), 'Installer entries must be regular files');
  const [dmg, zip] = names.map(name => path.join(artifactDirectory, name));
  command('unzip', ['-tqq', zip]);
  command('hdiutil', ['verify', dmg]);
  const archivePaths = command('unzip', ['-Z1', zip]).trim().split('\n');
  assert.ok(archivePaths.every(name => !path.posix.isAbsolute(name) && !name.split('/').includes('..')), 'ZIP contains unsafe paths');

  const temporary = await mkdtemp(path.join(tmpdir(), 'xhs-intel-verification-'));
  let comparedSources;
  try {
    command('ditto', ['-x', '-k', zip, temporary]);
    const applications = (await readdir(temporary, { withFileTypes: true })).filter(entry => entry.name.endsWith('.app'));
    assert.equal(applications.length, 1, 'ZIP must contain one application');
    assert.ok(applications[0].isDirectory());
    const contents = path.join(temporary, applications[0].name, 'Contents');
    const plist = path.join(contents, 'Info.plist');
    const plistValue = key => command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).trim();
    assert.equal(plistValue('CFBundleShortVersionString'), pkg.version, 'Info.plist version mismatch');
    const executable = plistValue('CFBundleExecutable');
    assert.equal(executable, path.basename(executable), 'Invalid executable basename');
    verifyArchitecture(path.join(contents, 'MacOS', executable));
    verifyArchitecture(path.join(contents, 'Resources/python/xhs-python'));
    comparedSources = await verifyAsar(path.join(contents, 'Resources/app.asar'), sourceDirectory, pkg.version);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const files = [];
  for (const name of names) {
    const file = path.join(artifactDirectory, name);
    files.push({ name, bytes: (await stat(file)).size, sha256: await digest(file) });
  }
  if (hasProof) {
    const proof = JSON.parse(await readFile(path.join(artifactDirectory, proofName), 'utf8'));
    assert.equal(proof.version, pkg.version);
    assert.equal(proof.sourceSha, env.SOURCE_SHA);
    assert.equal(proof.platform, 'darwin');
    assert.equal(proof.arch, 'x64');
    assert.deepEqual(proof.files, files);
  }
  const evidence = {
    repository: REPOSITORY, tag: env.TAG, version: pkg.version,
    sourceSha: env.SOURCE_SHA, buildRunId: env.RUN_ID,
    architecture: 'x86_64', comparedSources, files,
  };
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyPromotion();
}
