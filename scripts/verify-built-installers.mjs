import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAsar } from './verify-promoted-installer.mjs';
import { PythonBackend } from '../desktop/python-backend.js';

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const { version } = pkg;
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
const platform = process.platform;
const arch = process.arch;
assert.ok((platform === 'darwin' && ['arm64', 'x64'].includes(arch)) || (platform === 'win32' && arch === 'x64'));
if (process.env.GITHUB_REF_TYPE === 'tag') assert.ok([`v${version}`, `desktop-v${version}`].includes(process.env.GITHUB_REF_NAME));
const label = platform === 'darwin' ? `mac-${arch}` : 'windows-x64';
const output = path.join(root, 'dist-desktop');
const names = platform === 'darwin'
  ? ['dmg', 'zip'].map(ext => `XHS-Downloader-${version}-${label}.${ext}`)
  : ['setup', 'portable'].map(kind => `XHS-Downloader-${version}-${label}-${kind}.exe`);
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
let temporary;
let resources;
try {
  if (platform === 'darwin') {
    command('hdiutil', ['verify', path.join(output, names[0])]);
    const zip = path.join(output, names[1]);
    command('unzip', ['-tqq', zip]);
    const archiveNames = command('unzip', ['-Z1', zip]).trim().split('\n');
    assert.ok(archiveNames.every(name => !path.posix.isAbsolute(name) && !name.split('/').includes('..')));
    temporary = await mkdtemp(path.join(tmpdir(), 'xhs-release-verify-'));
    command('ditto', ['-x', '-k', zip, temporary]);
    const apps = (await readdir(temporary, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    assert.equal(apps.length, 1);
    assert.equal(apps[0].name, `${pkg.build.productName}.app`);
    const contents = path.join(temporary, apps[0].name, 'Contents');
    const value = key => command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(contents, 'Info.plist')]).trim();
    assert.equal(value('CFBundleShortVersionString'), version);
    assert.equal(value('CFBundleName'), pkg.build.productName);
    assert.equal(value('CFBundleDisplayName'), pkg.build.productName);
    assert.equal(value('CFBundleIdentifier'), pkg.build.appId);
    const executable = value('CFBundleExecutable');
    assert.equal(executable, path.basename(executable));
    resources = path.join(contents, 'Resources');
    for (const binary of [path.join(contents, 'MacOS', executable), path.join(resources, 'python/xhs-python')]) {
      assert.equal(command('lipo', ['-archs', binary]).trim(), arch === 'x64' ? 'x86_64' : 'arm64');
    }
  } else {
    resources = path.join(output, 'win-unpacked/resources');
    const executable = path.join(output, 'win-unpacked', `${pkg.build.productName}.exe`);
    assert.ok((await stat(executable)).isFile());
    const versionInfo = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (Get-Item -LiteralPath $env:XHS_VERIFY_EXECUTABLE).VersionInfo | Select-Object ProductName, FileDescription | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, XHS_VERIFY_EXECUTABLE: executable } }));
    assert.equal(versionInfo.ProductName, pkg.build.productName);
    assert.equal(versionInfo.FileDescription, pkg.build.productName);
    for (const name of names) command('7z', ['t', path.join(output, name)]);
  }
  const comparedSources = await verifyAsar(path.join(resources, 'app.asar'), root, version);
  const backend = new PythonBackend({ appDirectory: root, resourcesDirectory: resources, packaged: true });
  try {
    assert.equal(await backend.initialize(), true, 'The packaged Python runtime must start without system Python');
    const response = await backend.request({ path: '/api/python_parse', method: 'POST', headers: {},
      body: JSON.stringify({ text: 'https://ci.xiaohongshu.com/desktop-build-check?imageView2/format/jpg' }) });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.engine, 'python');
    assert.equal(payload.count, 1);
  } finally { backend.close(); }
  const files = [];
  for (const name of names) {
    const file = path.join(output, name);
    const info = await stat(file);
    assert.ok(info.isFile() && info.size > 10 * 1024 * 1024);
    files.push({ name, bytes: info.size, sha256: await digest(file) });
  }
  const proof = { version, sourceSha, sourceDirty, platform, arch, productName: pkg.build.productName, comparedSources, bundledPythonVerified: true, files };
  await writeFile(path.join(output, `release-proof-${label}.json`), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof, null, 2));
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
