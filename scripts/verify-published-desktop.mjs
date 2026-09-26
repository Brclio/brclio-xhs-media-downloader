// Read-only post-publication audit. No installer downloads or GitHub mutations.
// node scripts/verify-published-desktop.mjs VERSION SOURCE_SHA [RUN_ID]
//   [--current-version 1.8.11] [--workflow-sha SHA] [--output docs/releases/vVERSION-publication-verification.json]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { allowedAssetRedirect, installerName, LATEST_RELEASE_URL, parseRelease } from '../desktop/update-manager.js';
import { verifyReleaseTag } from './publish-desktop-release.mjs';

const REPOSITORY = 'Brclio/brclio-xhs-media-downloader';
const TARGETS = [
  { platform: 'darwin', arch: 'arm64', job: 'mac-arm64', suffixes: ['mac-arm64.dmg', 'mac-arm64.zip'] },
  { platform: 'darwin', arch: 'x64', job: 'mac-intel', suffixes: ['mac-x64.dmg', 'mac-x64.zip'] },
  { platform: 'win32', arch: 'x64', job: 'windows-x64', suffixes: ['windows-x64-setup.exe', 'windows-x64-portable.exe'] }
];
const SMALL_LIMIT = 1024 * 1024;
const LEGACY_VERSION = '1.8.13';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function api(endpoint, { paginate = false } = {}) {
  const args = ['api', `repos/${REPOSITORY}/${endpoint}`, '-H', 'Accept: application/vnd.github+json'];
  if (paginate) args.push('--paginate', '--slurp');
  try {
    const { stdout } = await promisify(execFile)('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * SMALL_LIMIT });
    return JSON.parse(stdout);
  } catch {
    // Avoid retaining gh stderr, environment credentials, or signed redirects.
    throw new Error(`Authenticated GitHub metadata request failed: ${endpoint}`);
  }
}

async function publicResponse(initialUrl, { method = 'GET', headers = {} } = {}) {
  let url = initialUrl;
  const signal = AbortSignal.timeout(30000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      method, redirect: 'manual', signal,
      headers: { 'User-Agent': 'Brclio-Public-Release-Verification', ...headers }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    assert.ok(location && redirects < 5, 'Public download redirect is missing or exceeds the limit');
    url = allowedAssetRedirect(new URL(location, url).href, initialUrl);
  }
  throw new Error('Public download redirect limit exceeded');
}

async function smallDocument(url, maximum = SMALL_LIMIT) {
  const response = await publicResponse(url, { headers: { Accept: '*/*' } });
  const reader = response.body?.getReader();
  try {
    assert.equal(response.status, 200, `Anonymous document unavailable: HTTP ${response.status}`);
    const length = response.headers.get('content-length');
    if (length !== null) assert.ok(Number.isSafeInteger(Number(length)) && Number(length) > 0 && Number(length) <= maximum,
      'Public document exceeds its size limit');
    assert.ok(reader, 'Public document is empty');
    let bytes = 0;
    const chunks = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert.ok(bytes <= maximum, 'Public document exceeds its streamed size limit');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader?.cancel().catch(() => {}); }
}

async function probeInstaller(asset) {
  const response = await publicResponse(asset.browser_download_url, { method: 'HEAD' });
  try {
    assert.equal(response.status, 200, `Public installer unavailable: ${asset.name} (HTTP ${response.status})`);
    assert.equal(Number(response.headers.get('content-length')), asset.size, `Public download size mismatch: ${asset.name}`);
    return { name: asset.name, bytes: asset.size, sha256: asset.digest.slice(7), method: 'HEAD', status: response.status };
  } finally { await response.body?.cancel(); }
}

function verifyRelease(release, { tag, names }) {
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.equal(release.html_url, `https://github.com/${REPOSITORY}/releases/tag/${tag}`);
  assert.ok(typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)));
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), [...names].sort(), 'Expected all 11 published assets exactly once');
  for (const asset of release.assets) {
    assert.equal(asset.state, 'uploaded');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
    assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/);
    assert.equal(asset.browser_download_url, `https://github.com/${REPOSITORY}/releases/download/${tag}/${asset.name}`);
  }
}

function assetSnapshot(release) {
  return release.assets.map(({ id, name, size, digest, browser_download_url }) => ({ id, name, size, digest, browser_download_url }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function verifyWorkflow(runId, expectedSourceSha) {
  const [run, pages] = await Promise.all([
    api(`actions/runs/${runId}`), api(`actions/runs/${runId}/jobs?per_page=100`, { paginate: true })
  ]);
  assert.equal(String(run.id), runId);
  assert.equal(run.head_sha, expectedSourceSha);
  assert.equal(run.path, '.github/workflows/desktop-build.yml');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  const jobs = pages.flatMap(page => page.jobs);
  assert.deepEqual(jobs.map(job => job.name).sort(), [...TARGETS.map(target => target.job), 'Publish verified installers'].sort());
  for (const job of jobs) {
    assert.equal(job.status, 'completed', `Incomplete CI job: ${job.name}`);
    assert.equal(job.conclusion, 'success', `Failed CI job: ${job.name}`);
    if (TARGETS.some(target => target.job === job.name)) {
      const step = job.steps.find(item => item.name === 'Verify native image clipboard and multi-file paste');
      assert.equal(step?.conclusion, 'success', `Native clipboard was not verified on ${job.name}`);
    }
  }
  return { url: run.html_url, workflowSha: run.head_sha, event: run.event,
    conclusion: run.conclusion, jobs: jobs.map(job => job.name), nativeClipboardVerified: true };
}

async function loadLegacyUpdater() {
  const tag = `v${LEGACY_VERSION}`;
  const options = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 30000,
    maxBuffer: SMALL_LIMIT };
  const { stdout } = await promisify(execFile)('git', ['rev-parse', `${tag}^{commit}`], options);
  const sourceSha = stdout.trim();
  await verifyReleaseTag(api, { tag, sourceSha });
  const { stdout: source } = await promisify(execFile)('git', ['show', `${sourceSha}:desktop/update-manager.js`], options);
  // This shipped module imports only node: built-ins. Import its exact source
  // without replacing the working-tree updater or writing an executable file.
  const updater = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(typeof updater.parseRelease, 'function');
  assert.equal(typeof updater.checksumFromManifest, 'function');
  return { version: LEGACY_VERSION, tag, sourceSha, updater };
}

export async function verifyPublishedDesktop({ version, expectedSourceSha, runId, expectedWorkflowSha = expectedSourceSha, currentVersion = '1.8.11', output }) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(currentVersion, /^\d+\.\d+\.\d+$/);
  assert.match(expectedSourceSha, /^[a-f0-9]{40}$/);
  // workflow_dispatch can run a newer CI definition while checking out an
  // immutable release tag. Verify both explicitly; build proofs still require
  // expectedSourceSha for every platform and the release tag.
  assert.match(expectedWorkflowSha, /^[a-f0-9]{40}$/);
  if (runId !== undefined) assert.match(runId, /^\d+$/);
  const tag = `v${version}`;
  const brandedNames = TARGETS.flatMap(target => target.suffixes.map(suffix => `Brclio-XHS-${version}-${suffix}`));
  const aliasNames = TARGETS.map(target => `XHS-Downloader-${version}-${target.suffixes[0]}`);
  const installerNames = [...brandedNames, ...aliasNames];
  const names = [...installerNames, 'SHA256SUMS.txt', 'build-evidence.json'];
  const [resolvedSha, release, latest, anonymousBytes, workflow, legacy] = await Promise.all([
    verifyReleaseTag(api, { tag, sourceSha: expectedSourceSha }),
    api(`releases/tags/${tag}`), api('releases/latest'),
    smallDocument(LATEST_RELEASE_URL),
    runId === undefined ? undefined : verifyWorkflow(runId, expectedWorkflowSha),
    loadLegacyUpdater()
  ]);
  const anonymous = JSON.parse(anonymousBytes.toString('utf8'));
  for (const value of [release, latest, anonymous]) verifyRelease(value, { tag, names });
  assert.equal(latest.id, release.id, 'Authenticated latest release differs');
  assert.equal(anonymous.id, release.id, 'Anonymous updater does not see this release');
  assert.deepEqual(assetSnapshot(latest), assetSnapshot(release));
  assert.deepEqual(assetSnapshot(anonymous), assetSnapshot(release), 'Anonymous updater asset data differs');
  const byName = new Map(release.assets.map(asset => [asset.name, asset]));
  const documents = await Promise.all(['SHA256SUMS.txt', 'build-evidence.json'].map(async name => {
    const asset = byName.get(name);
    const bytes = await smallDocument(asset.browser_download_url, name === 'SHA256SUMS.txt' ? 128 * 1024 : SMALL_LIMIT);
    assert.equal(bytes.length, asset.size, `Public manifest size mismatch: ${name}`);
    assert.equal(`sha256:${sha256(bytes)}`, asset.digest, `Public manifest hash mismatch: ${name}`);
    return bytes;
  }));
  const sums = new Map();
  for (const line of documents[0].toString('utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match && !sums.has(match[2]), 'Malformed or duplicate SHA256SUMS entry');
    sums.set(match[2], match[1]);
  }
  assert.deepEqual([...sums.keys()].sort(), [...installerNames].sort());
  const evidence = JSON.parse(documents[1].toString('utf8'));
  assert.equal(evidence.repository, REPOSITORY);
  assert.equal(evidence.tag, tag);
  assert.equal(evidence.sourceSha, resolvedSha);
  assert.equal(evidence.builds.length, TARGETS.length);
  const proofFiles = new Map();
  const builds = TARGETS.map(target => {
    const matches = evidence.builds.filter(build => build.platform === target.platform && build.arch === target.arch);
    assert.equal(matches.length, 1, 'Expected one build proof for each platform');
    const [build] = matches;
    assert.equal(build.version, version);
    assert.equal(build.sourceSha, resolvedSha);
    assert.equal(build.sourceDirty, false, 'Build source must be clean');
    assert.equal(build.bundledPythonVerified, true);
    assert.ok(Number.isInteger(build.comparedSources) && build.comparedSources >= 27);
    if (target.platform === 'darwin') {
      for (const flag of ['macCodeSignatureVerified', 'packagedMacLaunchVerified', 'packagedMacUpdateVerified', 'packagedUpdateHistoryVerified']) {
        assert.equal(build[flag], true, `Unverified Mac build property: ${flag}`);
      }
      assert.ok(['adhoc', 'developer-id'].includes(build.macCodeSigning));
    }
    assert.deepEqual(build.files.map(file => file.name).sort(), target.suffixes.map(suffix => `Brclio-XHS-${version}-${suffix}`).sort());
    for (const file of build.files) proofFiles.set(file.name, file);
    return { platform: build.platform, arch: build.arch, comparedSources: build.comparedSources, sourceDirty: false };
  });
  assert.deepEqual(evidence.compatibilityAssets.map(file => file.name).sort(), [...aliasNames].sort());
  for (const file of evidence.compatibilityAssets) {
    assert.equal(file.sourceName, file.name.replace(/^XHS-Downloader-/, 'Brclio-XHS-'));
    const original = proofFiles.get(file.sourceName);
    assert.ok(original, 'Compatibility alias has no original');
    assert.equal(file.bytes, original.bytes);
    assert.equal(file.sha256, original.sha256);
    proofFiles.set(file.name, file);
  }
  for (const name of installerNames) {
    const proof = proofFiles.get(name);
    const asset = byName.get(name);
    assert.equal(proof.bytes, asset.size, `Remote installer size differs from proof: ${name}`);
    assert.equal(`sha256:${proof.sha256}`, asset.digest, `Remote installer digest differs from proof: ${name}`);
    assert.equal(sums.get(name), proof.sha256, `Manifest hash differs from proof: ${name}`);
  }
  const updates = TARGETS.map(({ platform, arch }) => {
    const { metadata, candidate } = parseRelease(anonymous, { currentVersion, platform, arch });
    const name = installerName(version, platform, arch);
    assert.equal(metadata.latestVersion, version);
    assert.equal(candidate?.version, version);
    assert.equal(candidate.name, name);
    assert.equal(candidate.size, byName.get(name).size);
    assert.equal(candidate.sha256, sums.get(name));
    return { platform, arch, fromVersion: currentVersion, asset: candidate.name, bytes: candidate.size };
  });
  const legacyUpdates = TARGETS.map(({ platform, arch }, index) => {
    const { metadata, candidate } = legacy.updater.parseRelease(anonymous,
      { currentVersion: legacy.version, platform, arch });
    const name = aliasNames[index];
    assert.equal(metadata.latestVersion, version);
    assert.equal(candidate?.version, version, `The shipped ${legacy.tag} updater must find this release`);
    assert.equal(candidate.name, name, `The shipped ${legacy.tag} updater must select the compatibility asset`);
    assert.equal(candidate.url, byName.get(name).browser_download_url);
    assert.equal(candidate.size, byName.get(name).size);
    assert.equal(candidate.sha256, sums.get(name));
    assert.equal(legacy.updater.checksumFromManifest(documents[0].toString('utf8'), name), candidate.sha256);
    return { platform, arch, fromVersion: legacy.version, asset: candidate.name, bytes: candidate.size,
      sha256: candidate.sha256, manifestChecksumVerified: true };
  });
  // HEAD follows the public installer links without consuming large bodies.
  const probes = [];
  for (let offset = 0; offset < installerNames.length; offset += 3) {
    probes.push(...await Promise.all(installerNames.slice(offset, offset + 3).map(name => probeInstaller(byName.get(name)))));
  }
  const report = {
    version, tag, sourceSha: resolvedSha, url: release.html_url,
    publishedAt: release.published_at, verifiedAt: new Date().toISOString(), assetCount: release.assets.length,
    builds, updates, legacyUpdater: { version: legacy.version, tag: legacy.tag, sourceSha: legacy.sourceSha },
    legacyUpdates, compatibilityAliasesVerified: true, remoteDigestsVerified: true,
    publicManifestsVerified: true, anonymousUpdaterVisible: true, publicInstallerProbes: probes,
    ...(workflow ? { workflow } : {})
  };
  const destination = path.resolve(output || `docs/releases/${tag}-publication-verification.json`);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  return { report, output: destination };
}

function argumentsFrom(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--output' || value === '--current-version' || value === '--workflow-sha') {
      assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing value for ${value}`);
      const key = { '--output': 'output', '--current-version': 'currentVersion', '--workflow-sha': 'expectedWorkflowSha' }[value];
      assert.equal(options[key], undefined, `Duplicate option: ${value}`);
      options[key] = argv[++index];
    } else {
      assert.ok(!value.startsWith('--'), `Unknown option: ${value}`);
      positional.push(value);
    }
  }
  assert.ok(positional.length === 2 || positional.length === 3,
    'Usage: node scripts/verify-published-desktop.mjs VERSION SOURCE_SHA [RUN_ID] [--output PATH] [--current-version VERSION] [--workflow-sha SHA]');
  return { version: positional[0], expectedSourceSha: positional[1], runId: positional[2], ...options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, output } = await verifyPublishedDesktop(argumentsFrom(process.argv.slice(2)));
    console.log(JSON.stringify({ verified: true, version: report.version, sourceSha: report.sourceSha,
      assetCount: report.assetCount, publicInstallerCount: report.publicInstallerProbes.length, output }));
  } catch (error) {
    console.error(`Published release verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
