import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateArtifacts, createCompatibilityAssets, formatReleaseNotes, verifyReleaseTag, prepareDraftRelease, releaseApiError } from '../scripts/publish-desktop-release.mjs';

const version = '1.7.1';
const sourceSha = 'a'.repeat(40);
const tag = `v${version}`;
const draftOptions = { tag, sourceSha, name: 'Verified release', body: 'Release notes' };
function releaseApiFixture({ object = { type: 'commit', sha: sourceSha }, ref = `refs/tags/${tag}`, annotated = {}, releases = [] } = {}) {
  const calls = [];
  const api = async (endpoint, options = {}) => {
    calls.push({ endpoint, ...options });
    if (endpoint === `git/ref/tags/${tag}`) return { ref, object };
    if (endpoint.startsWith('git/tags/')) {
      const sha = endpoint.slice('git/tags/'.length);
      assert.ok(annotated[sha], `Unexpected annotated tag ${sha}`);
      return annotated[sha];
    }
    if (endpoint === 'releases?per_page=100') return releases;
    assert.equal(endpoint, 'releases');
    assert.equal(options.method, 'POST');
    return { id: 12, ...JSON.parse(options.body) };
  };
  return { api, calls };
}

test('release creates a draft only from the verified remote lightweight tag without target_commitish', async () => {
  const f = releaseApiFixture();
  const result = await prepareDraftRelease(f.api, draftOptions);
  assert.deepEqual(result, { id: 12, tag_name: tag, name: draftOptions.name, body: draftOptions.body, draft: true, prerelease: false });
  assert.deepEqual(f.calls.map(call => call.endpoint), [`git/ref/tags/${tag}`, 'releases?per_page=100', 'releases']);
  assert.equal(Object.hasOwn(JSON.parse(f.calls.at(-1).body), 'target_commitish'), false);
});

test('release resolves annotated and nested annotated tags to the build commit', async () => {
  const first = 'b'.repeat(40), second = 'c'.repeat(40);
  const f = releaseApiFixture({ object: { type: 'tag', sha: first }, annotated: {
    [first]: { sha: first, object: { type: 'tag', sha: second } },
    [second]: { sha: second, object: { type: 'commit', sha: sourceSha } }
  } });
  await prepareDraftRelease(f.api, draftOptions);
  assert.deepEqual(f.calls.map(call => call.endpoint), [`git/ref/tags/${tag}`, `git/tags/${first}`, `git/tags/${second}`, 'releases?per_page=100', 'releases']);
});

test('missing remote tags fail before any release operation or implicit tag creation', async () => {
  const missing = Object.assign(new Error('GitHub GET tag: HTTP 404'), { status: 404 });
  const calls = [];
  await assert.rejects(prepareDraftRelease(async endpoint => {
    calls.push(endpoint); throw missing;
  }, draftOptions), error => error === missing);
  assert.deepEqual(calls, [`git/ref/tags/${tag}`]);
});

for (const annotated of [false, true]) {
  test(`release rejects a ${annotated ? 'annotated' : 'lightweight'} tag pointing to a different build commit`, async () => {
    const wrong = 'd'.repeat(40), tagSha = 'b'.repeat(40);
    const f = releaseApiFixture(annotated ? { object: { type: 'tag', sha: tagSha }, annotated: {
      [tagSha]: { sha: tagSha, object: { type: 'commit', sha: wrong } }
    } } : { object: { type: 'commit', sha: wrong } });
    await assert.rejects(prepareDraftRelease(f.api, draftOptions), /Remote release tag must match/);
    assert.ok(f.calls.every(call => !call.endpoint.startsWith('releases')));
  });
}

test('existing drafts are checked against the remote tag and public releases remain immutable', async () => {
  const draft = { id: 21, tag_name: tag, draft: true };
  const f = releaseApiFixture({ releases: [draft] });
  assert.deepEqual(await prepareDraftRelease(f.api, draftOptions), draft);
  assert.deepEqual(f.calls.map(call => call.endpoint), [`git/ref/tags/${tag}`, 'releases?per_page=100']);
  const published = releaseApiFixture({ releases: [{ ...draft, draft: false }] });
  await assert.rejects(prepareDraftRelease(published.api, draftOptions), /Never replace already-published/);
  assert.ok(published.calls.every(call => !call.method));
});

test('tag resolution rejects branches, non-commit targets, cycles, and inconsistent tag objects', async () => {
  const annotatedSha = 'b'.repeat(40);
  for (const [fixture, message] of [
    [{ ref: `refs/heads/${tag}` }, /exact existing release tag/],
    [{ object: { type: 'tree', sha: sourceSha } }, /resolve to a commit/],
    [{ object: { type: 'commit', sha: 'invalid' } }, /Invalid remote tag object/],
    [{ object: { type: 'tag', sha: annotatedSha }, annotated: {
      [annotatedSha]: { sha: annotatedSha, object: { type: 'tag', sha: annotatedSha } }
    } }, /Invalid annotated tag chain/],
    [{ object: { type: 'tag', sha: annotatedSha }, annotated: {
      [annotatedSha]: { sha: 'c'.repeat(40), object: { type: 'commit', sha: sourceSha } }
    } }, /changed identity/]
  ]) {
    const f = releaseApiFixture(fixture);
    await assert.rejects(verifyReleaseTag(f.api, draftOptions), message);
    assert.ok(f.calls.every(call => !call.method));
  }
});

test('GitHub failure diagnostics retain only a bounded message and request ID without credentials', async () => {
  const token = 'fixture-token-not-a-real-secret';
  const response = new Response(JSON.stringify({ message: `Denied\n${token}${'x'.repeat(500)}`, other: 'excluded-response-field' }),
    { status: 403, headers: { 'x-github-request-id': 'ABC:123:DEF' } });
  const error = await releaseApiError(response, { method: 'POST', endpoint: 'releases', token });
  assert.match(error.message, /^GitHub POST releases: HTTP 403 \[request ABC:123:DEF\]: Denied \[REDACTED\]/);
  assert.ok(!error.message.includes(token) && !error.message.includes('excluded-response-field') && !error.message.includes('\n'));
  assert.ok(error.message.length < 400);
  const malformed = await releaseApiError(new Response('not JSON', { status: 502 }), { endpoint: 'releases' });
  assert.equal(malformed.message, 'GitHub GET releases: HTTP 502');
});

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
      ...(platform === 'darwin' ? { macCodeSignatureVerified: true, macCodeSigning: 'adhoc', packagedMacUpdateVerified: true } : {}), files
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
  test(`release rejects ${label} without successful packaged updater acceptance`, async t => {
    const directory = await fixture(t);
    const proofPath = path.join(directory, `release-proof-${label}.json`);
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    for (const value of [undefined, false, 'true']) {
      if (value === undefined) delete proof.packagedMacUpdateVerified;
      else proof.packagedMacUpdateVerified = value;
      await writeFile(proofPath, JSON.stringify(proof));
      await assert.rejects(validateArtifacts(directory, { version, sourceSha }), /Packaged macOS update and automatic relaunch must be verified/);
    }
  });
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
