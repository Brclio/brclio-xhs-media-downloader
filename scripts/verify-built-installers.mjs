import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyAsar } from './verify-promoted-installer.mjs';
import { PythonBackend } from '../desktop/python-backend.js';
import { verifyPackagedMacLaunch } from './verify-packaged-mac.mjs';
import { verifyPackagedMacUpdate } from './verify-packaged-mac-update.mjs';

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
// An alternate output keeps verification builds separate from a locally
// installed app that may itself live in the default packaging directory.
const output = path.resolve(root, process.argv[2] || pkg.build.directories.output);
const names = platform === 'darwin'
  ? ['dmg', 'zip'].map(ext => `Brclio-XHS-${version}-${label}.${ext}`)
  : ['setup', 'portable'].map(kind => `Brclio-XHS-${version}-${label}-${kind}.exe`);
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
let temporary;
let resources;
let mountedDmg;
let dmgAttached = false;
let macCodeSigning;
const macApps = [];
function verifyMacSignature(appPath) {
  command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  command('codesign', ['--verify', '--strict', path.join(appPath, 'Contents/Resources/python/xhs-python')]);
  const signature = spawnSync('codesign', ['--display', '--verbose=4', appPath], { encoding: 'utf8', timeout: 30000 });
  assert.equal(signature.status, 0, signature.stderr);
  assert.ok(signature.stderr.includes(`Identifier=${pkg.build.appId}\n`), 'The full application must be signed with its own bundle identifier');
  assert.match(signature.stderr, /Sealed Resources version=2 /, 'Bundle resources must be sealed, not only the executable linker signature');
  assert.doesNotMatch(signature.stderr, /Info\.plist=not bound/);
  if (/^Signature=adhoc$/m.test(signature.stderr)) return 'adhoc';
  assert.match(signature.stderr, /^Authority=Developer ID Application:/m);
  return 'developer-id';
}
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
    const zipApp = path.join(temporary, apps[0].name);
    macCodeSigning = verifyMacSignature(zipApp);
    macApps.push(zipApp);
    // Inspect the actual DMG payload too; a valid ZIP does not establish its contents.
    mountedDmg = path.join(await mkdtemp(path.join(tmpdir(), 'xhs-dmg-verify-')), 'volume');
    command('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountedDmg, path.join(output, names[0])]);
    dmgAttached = true;
    const dmgApp = path.join(mountedDmg, apps[0].name);
    assert.equal(verifyMacSignature(dmgApp), macCodeSigning);
    assert.equal(await digest(path.join(dmgApp, 'Contents/Resources/app.asar')),
      await digest(path.join(zipApp, 'Contents/Resources/app.asar')), 'DMG and ZIP must contain identical application source');
    macApps.push(dmgApp);
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
  if (platform === 'darwin') {
    await verifyPackagedMacLaunch(macApps[0], { version, productName: pkg.build.productName });
    await verifyPackagedMacUpdate(macApps[0]);
    // Python and app startup must not invalidate the sealed bundle resources.
    for (const appPath of macApps) assert.equal(verifyMacSignature(appPath), macCodeSigning);
  }
  const files = [];
  for (const name of names) {
    const file = path.join(output, name);
    const info = await stat(file);
    assert.ok(info.isFile() && info.size > 10 * 1024 * 1024);
    files.push({ name, bytes: info.size, sha256: await digest(file) });
  }
  const proof = { version, sourceSha, sourceDirty, platform, arch, productName: pkg.build.productName, comparedSources, bundledPythonVerified: true,
    ...(platform === 'darwin' ? { macCodeSignatureVerified: true, macCodeSigning, macSignatureContainers: ['dmg', 'zip'],
      packagedMacLaunchVerified: true, packagedMacUpdateVerified: true, packagedUpdateHistoryVerified: true } : {}), files };
  await writeFile(path.join(output, `release-proof-${label}.json`), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof, null, 2));
} finally {
  if (mountedDmg) {
    if (dmgAttached) command('hdiutil', ['detach', mountedDmg]);
    await rm(path.dirname(mountedDmg), { recursive: true, force: true });
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
