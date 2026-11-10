import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCompatibilityAssets, createReleaseApi, prepareDraftRelease, verifyReleaseTag } from './publish-desktop-release.mjs';
import { compareVersions, installerName } from '../desktop/update-manager.js';
import { verifyInstaller } from '../desktop/migration/release.js';

const repo = 'Brclio/brclio-xhs-media-downloader';
const pinned = JSON.parse(await readFile('desktop/migration/release.json'));
const version = pinned.bridgeVersion;
const tag = 'v' + version;
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(process.env.GITHUB_REPOSITORY, repo);
assert.equal(process.env.GITHUB_SHA, sourceSha);
assert.equal(tag, 'v2.0.37');
assert.ok(process.env.GH_TOKEN);
const api = createReleaseApi({ token: process.env.GH_TOKEN });
const dispatch = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.MIGRATION_PUBLISH === 'true';
const mainDispatch = dispatch && process.env.GITHUB_REF === 'refs/heads/main';
const taggedRun = process.env.GITHUB_REF === 'refs/tags/' + tag && (dispatch || process.env.GITHUB_EVENT_NAME === 'push');
assert.ok(mainDispatch || taggedRun, 'Publish only from main with an explicit publish dispatch, or from the matching version tag.');

async function verifyLatestTarget() {
  const latest = JSON.parse(execFileSync('gh', ['api', 'repos/Brclio/Brclio/releases/latest'], { encoding: 'utf8' }));
  assert.equal(latest.tag_name, 'v' + pinned.version, 'Brclio stable has changed. Refresh the pinned installers and rebuild.');
  for (const asset of Object.values(pinned.assets)) {
    const matches = latest.assets.filter(item => item.name === asset.name);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].digest, 'sha256:' + asset.sha256);
    assert.equal(matches[0].size, asset.size);
  }
  const old = await api('releases/latest');
  assert.ok(compareVersions(old.tag_name.slice(1), version) < 0, 'A newer desktop version is already published.');
}

const directory = path.resolve('release-artifacts');
async function describe(name) {
  const file = path.join(directory, name);
  const stat = await lstat(file);
  assert.ok(stat.isFile() && stat.size > 0);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { name, bytes: stat.size, sha256: hash.digest('hex') };
}

const names = Object.keys(pinned.assets).map(key => installerName(version, ...key.split('-')));
names.push('Brclio-XHS-' + version + '-windows-x64-portable.exe');
assert.deepEqual((await readdir(directory)).sort(), names.sort());
const files = await Promise.all(names.map(describe));
const aliases = await createCompatibilityAssets(directory, { version, files });
const originals = Object.values(pinned.assets);
await verifyLatestTarget();
for (const original of originals) {
  execFileSync('gh', ['release', 'download', 'v' + pinned.version, '--repo', 'Brclio/Brclio', '--dir', directory,
    '--pattern', original.name], { stdio: 'inherit', timeout: 300000 });
  await verifyInstaller(path.join(directory, original.name), original);
}
const mirrors = originals.map(({ name, size, sha256 }) => ({ name, bytes: size, sha256 }));
const assets = [...files, ...aliases, ...mirrors].sort((a, b) => a.name.localeCompare(b.name));
await writeFile(path.join(directory, 'SHA256SUMS.txt'), assets.map(file => file.sha256 + '  ' + file.name).join('\n') + '\n');
await writeFile(path.join(directory, 'build-evidence.json'), JSON.stringify({
  repository: repo, tag, sourceSha, nativeVerificationRun: process.env.GITHUB_RUN_ID, embeddedOfficialRelease: pinned, files, aliases
}, null, 2) + '\n');
const uploads = [...assets, await describe('SHA256SUMS.txt'), await describe('build-evidence.json')];
const title = '小红书下载器 ' + tag + ' · 迁移至 Brclio';
const labels = { 'darwin-arm64': 'macOS · Apple 芯片', 'darwin-x64': 'macOS · Intel', 'win32-x64': 'Windows x64' };
const directLinks = Object.entries(pinned.assets).map(([platform, asset]) =>
  '- [' + labels[platform] + '](https://github.com/Brclio/Brclio/releases/download/v' + pinned.version + '/' + asset.name + ')').join('\n');
const body = [
  '新用户可直接下载 Brclio ' + pinned.version + '。下方安装包由 Brclio 官方发布，本页同名附件是通过 SHA-256 校验的相同文件。',
  directLinks,
  '后续版本请前往 [Brclio 最新正式版](https://github.com/Brclio/Brclio/releases/latest)。',
  '已安装旧桌面版的用户可在软件内检查更新。首次迁移使用 Brclio ' + pinned.version + ' 的官方安装包，此后在 Brclio 内更新。已安装同版或更高版本时直接打开。',
  'Windows 便携迁移程序运行后会安装并打开 Brclio 官方 x64 客户端。',
  '带 XHS 或 XHS-Downloader 的附件供旧客户端迁移。旧账号、会员、小红书登录会话与批量任务记录不会导入 Brclio，已保存的媒体文件可继续使用。'
].join('\n\n');

if (mainDispatch) {
  const main = await api('git/ref/heads/main');
  assert.equal(main.object.sha, sourceSha, 'main changed since this run started. Rebuild its current commit.');
  const ref = 'refs/tags/' + tag;
  const matching = await api('git/matching-refs/tags/' + tag);
  if (!matching.some(item => item.ref === ref)) {
    // Only this explicit main dispatch can create a tag, after every native
    // platform and the pinned upstream assets have passed verification.
    await verifyLatestTarget();
    try {
      await api('git/refs', { method: 'POST', body: JSON.stringify({ ref, sha: sourceSha }) });
    } catch (error) {
      // Concurrent matching tag creation or a response lost after success.
      await verifyReleaseTag(api, { tag, sourceSha }).catch(() => { throw error; });
    }
  }
}
let release = await prepareDraftRelease(api, { tag, sourceSha, name: title, body });
execFileSync('gh', ['release', 'upload', tag, '--repo', repo, '--clobber',
  ...uploads.map(file => path.join(directory, file.name))], { stdio: 'inherit', timeout: 600000 });
release = await api('releases/' + release.id);
assert.equal(release.draft, true);
assert.deepEqual(release.assets.map(asset => asset.name).sort(), uploads.map(file => file.name).sort());
for (const file of uploads) {
  const remote = release.assets.find(asset => asset.name === file.name);
  assert.equal(remote.state, 'uploaded');
  assert.equal(remote.size, file.bytes);
  assert.equal(remote.digest, 'sha256:' + file.sha256);
}
await verifyReleaseTag(api, { tag, sourceSha });
await verifyLatestTarget();
const published = await api('releases/' + release.id, {
  method: 'PATCH', body: JSON.stringify({ name: title, body, draft: false, prerelease: false, make_latest: 'true' })
});
assert.equal(published.draft, false);
assert.equal((await api('releases/latest')).tag_name, tag);
console.log('已发布 ' + published.html_url);
