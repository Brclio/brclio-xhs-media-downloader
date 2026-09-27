import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'Brclio/brclio-xhs-media-downloader';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function androidVersion(tag) {
  const version = /^android-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag)?.[1];
  assert.ok(version, 'Use an Android-only tag such as android-v1.0.0');
  assert.equal(tag, `android-v${version}`, 'Android release tags must be canonical');
  return version;
}

export function validateReleaseProof(proof, { tag, sourceCommit, certificateSha256 }) {
  const version = androidVersion(tag);
  assert.match(sourceCommit, /^[a-f\d]{40}$/);
  assert.match(certificateSha256, /^[a-f\d]{64}$/);
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.platform, 'android');
  assert.equal(proof.version, version, 'Tag and built Android version must agree');
  assert.ok(Number.isSafeInteger(proof.versionCode) && proof.versionCode > 0 && proof.versionCode <= 2100000000);
  assert.equal(proof.applicationId, 'com.brclio.xhs', 'Only the official package can be published');
  assert.equal(proof.minSdk, 26);
  assert.equal(proof.signingCertificateSha256, certificateSha256, 'The stable Android certificate must match');
  assert.equal(proof.sourceCommit, sourceCommit, 'The APK must be built from the exact release commit');
  assert.equal(proof.sourceDirty, false, 'Rebuild from a clean checkout after committing the final sources');
  assert.equal(proof.apk?.name, `Brclio-XHS-Android-${version}-release.apk`);
  assert.match(proof.apk.sha256, /^[a-f\d]{64}$/);
  assert.ok(Number.isSafeInteger(proof.apk.bytes) && proof.apk.bytes > 0);
  return version;
}

export function validateReleaseFiles(directory, options) {
  const proof = JSON.parse(readFileSync(join(directory, 'android-update.json'), 'utf8'));
  validateReleaseProof(proof, options);
  const apkPath = join(directory, proof.apk.name);
  assert.equal(statSync(apkPath).size, proof.apk.bytes, 'APK byte count mismatch');
  assert.equal(digest(readFileSync(apkPath)), proof.apk.sha256, 'APK checksum mismatch');
  const line = `${proof.apk.sha256}  ${proof.apk.name}`;
  for (const name of [`${proof.apk.name}.sha256`, 'SHA256SUMS.txt']) {
    assert.equal(readFileSync(join(directory, name), 'utf8').trim(), line, `Checksum file mismatch: ${name}`);
  }
  const names = [proof.apk.name, `${proof.apk.name}.sha256`, 'SHA256SUMS.txt', 'android-update.json'];
  return { proof, names };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function ghJson(path) {
  return JSON.parse(run('gh', ['api', path]));
}

function releaseOrNull(tag) {
  // The tag endpoint describes published releases. Listing also returns drafts
  // to authenticated maintainers, which makes retries and collision checks safe.
  for (let page = 1; page <= 100; page++) {
    const releases = ghJson(`repos/${REPOSITORY}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(releases), 'Unexpected GitHub releases response');
    const found = releases.find((release) => release.tag_name === tag);
    if (found) return found;
    if (releases.length < 100) return null;
  }
  throw new Error('Release listing exceeded the safe pagination limit');
}

function verifyTag(tag, sourceCommit) {
  assert.equal(run('git', ['rev-parse', `refs/tags/${tag}^{commit}`]), sourceCommit, 'Local release tag moved');
  const refs = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .split('\n').filter(Boolean).map((line) => line.split(/\s+/));
  const remote = refs.find(([, ref]) => ref.endsWith('^{}')) || refs.find(([, ref]) => ref === `refs/tags/${tag}`);
  assert.equal(remote?.[0], sourceCommit, 'Remote release tag must resolve to the built commit');
}

export async function publishAndroidRelease() {
  const tag = process.env.ANDROID_RELEASE_TAG || process.env.GITHUB_REF_NAME || '';
  const version = androidVersion(tag);
  const sourceCommit = run('git', ['rev-parse', 'HEAD']);
  const certificateSha256 = (process.env.ANDROID_SIGNING_CERT_SHA256 || '').replace(/:/g, '').toLowerCase().trim();
  assert.equal(run('git', ['status', '--porcelain']), '', 'Publish only from a clean checkout');
  verifyTag(tag, sourceCommit);
  const directory = join(ROOT, 'dist-android');
  const { proof, names } = validateReleaseFiles(directory, { tag, sourceCommit, certificateSha256 });
  const notes = join(ROOT, 'docs/releases', `${tag}.md`);
  assert.ok(readFileSync(notes, 'utf8').trim(), 'Version-specific release notes are required');
  const latestBefore = ghJson(`repos/${REPOSITORY}/releases/latest`).tag_name;
  assert.ok(/^(?:v|desktop-v)\d+\.\d+\.\d+$/.test(latestBefore), 'The existing desktop Latest release must be preserved');

  const existing = releaseOrNull(tag);
  if (existing) {
    assert.equal(existing.draft, true, 'An already published Android release is immutable; use a new version');
    assert.equal(existing.target_commitish, sourceCommit, 'Refuse a draft created for a different commit');
    assert.ok(existing.assets.every((asset) => names.includes(asset.name)), 'Refuse a draft containing unexpected assets');
  } else {
    run('gh', ['release', 'create', tag, '--repo', REPOSITORY, '--verify-tag', '--target', sourceCommit,
      '--draft', '--latest=false', '--title', `Android v${version}：Brclio 小红书下载器`, '--notes-file', notes]);
  }
  run('gh', ['release', 'upload', tag, '--repo', REPOSITORY, '--clobber', ...names.map((name) => join(directory, name))]);

  const draft = releaseOrNull(tag);
  assert.equal(draft?.draft, true, 'Release changed while its assets were being prepared');
  assert.deepEqual(draft.assets.map((asset) => asset.name).sort(), [...names].sort(), 'Expected exactly the verified Android assets');
  const downloaded = mkdtempSync(join(tmpdir(), 'brclio-android-release-'));
  try {
    run('gh', ['release', 'download', tag, '--repo', REPOSITORY, '--dir', downloaded]);
    for (const name of names) {
      assert.equal(digest(readFileSync(join(downloaded, name))), digest(readFileSync(join(directory, name))),
        `Uploaded asset bytes changed: ${name}`);
    }
    validateReleaseFiles(downloaded, { tag, sourceCommit, certificateSha256 });
  } finally {
    rmSync(downloaded, { recursive: true, force: true });
  }
  verifyTag(tag, sourceCommit);
  assert.equal(run('git', ['rev-parse', 'HEAD']), sourceCommit, 'Checkout changed during publication');
  assert.equal(run('git', ['status', '--porcelain']), '', 'Sources changed during publication');
  run('gh', ['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest=false']);
  const published = releaseOrNull(tag);
  assert.equal(published?.draft, false, 'GitHub did not confirm publication');
  assert.equal(published.prerelease, false);
  const latestAfter = ghJson(`repos/${REPOSITORY}/releases/latest`).tag_name;
  assert.ok(!latestAfter.startsWith('android-'), 'Android must not replace the desktop Latest release');
  console.log(JSON.stringify({ tag, sourceCommit, versionCode: proof.versionCode,
    releaseUrl: published.html_url, desktopLatestBefore: latestBefore, desktopLatestAfter: latestAfter }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishAndroidRelease().catch((error) => {
    console.error(`Android 发布失败：${error.message}`);
    process.exitCode = 1;
  });
}
