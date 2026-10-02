import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackagedUpdateProxy } from '../scripts/verify-packaged-update-proxy.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const pinnedLock = JSON.parse(await readFile(new URL('../desktop/resources/update-proxy/runtime.lock.json', import.meta.url), 'utf8'));
const license = await readFile(new URL('../desktop/resources/update-proxy/LICENSE', import.meta.url));

async function fixture(t, { platform = 'darwin', arch = 'arm64' } = {}) {
  const resources = await mkdtemp(join(tmpdir(), 'brclio-packaged-proxy-test-'));
  t.after(() => rm(resources, { recursive: true, force: true }));
  const directory = join(resources, 'proxy');
  await mkdir(directory);
  const source = Buffer.from('corresponding upstream source fixture');
  const runtimeLock = structuredClone(pinnedLock);
  runtimeLock.source.sha256 = hash(source);
  runtimeLock.source.bytes = source.length;
  const target = `${platform === 'darwin' ? 'mac' : 'win'}-${arch}`;
  const executable = platform === 'win32' ? 'mihomo.exe' : 'mihomo';
  const binaryInfo = { asset: runtimeLock.targets[target].asset, archiveSha256: runtimeLock.targets[target].sha256,
    executable, upstreamBinarySha256: 'a'.repeat(64), upstreamBinaryBytes: 50000000 };
  const buildInfo = { schemaVersion: 1, version: runtimeLock.version, sourceCommit: runtimeLock.sourceCommit,
    sourceUrl: runtimeLock.source.url, sourceSha256: runtimeLock.source.sha256, license: runtimeLock.license,
    binaries: { [target]: binaryInfo } };
  await Promise.all([
    writeFile(join(directory, executable), 'binary bytes changed by code signing'),
    writeFile(join(directory, 'build-info.json'), JSON.stringify(buildInfo)),
    writeFile(join(directory, 'LICENSE'), license),
    writeFile(join(directory, 'NOTICE'), `GNU General Public License ${runtimeLock.version} ${runtimeLock.sourceCommit} corresponding-source.tar.gz`),
    writeFile(join(directory, 'corresponding-source.tar.gz'), source),
    writeFile(join(directory, 'subscription.json'), JSON.stringify({ subscriptionUrls: [], subscriptionUrl: '' })),
  ]);
  const commands = [];
  const runCommand = (command, args) => {
    commands.push([command, args]);
    return { status: 0, stdout: command === 'lipo' ? arch === 'x64' ? 'x86_64\n' : 'arm64\n'
      : command === 'codesign' ? '' : `Mihomo Meta ${runtimeLock.version} ${platform === 'darwin' ? 'darwin' : 'windows'} ${arch === 'x64' ? 'amd64' : 'arm64'} with go1.26.1\n` };
  };
  const options = { platform, arch, runtimeLock, runCommand };
  return { resources, directory, options, buildInfo, commands, verify: (overrides = {}) => verifyPackagedUpdateProxy(resources, { ...options, ...overrides }) };
}

test('packaged proxy gate verifies native architecture/signature/startup without requiring the unsigned binary hash', async (t) => {
  const f = await fixture(t);
  const report = await f.verify();
  assert.equal(report.nativeStartupVerified, true);
  assert.equal(report.codeSignatureVerified, true);
  assert.equal(report.bundledSubscriptionsAbsent, true);
  assert.equal(report.configurationSource, 'management-api');
  assert.doesNotMatch(JSON.stringify(report), /private-fixture-value|subscriptionUrl|example\.com/);
  assert.deepEqual(f.commands.map(([command, args]) => [command === 'lipo' || command === 'codesign' ? command : 'mihomo', args.slice(0, -1)]),
    [['lipo', ['-archs']], ['codesign', ['--verify', '--strict']], ['mihomo', []]]);
  assert.deepEqual(f.commands[2][1], ['-v']);
});

test('Windows packaged proxy requires native version/startup without macOS tools', async (t) => {
  const f = await fixture(t, { platform: 'win32', arch: 'x64' });
  const report = await f.verify();
  assert.equal(report.target, 'win-x64');
  assert.equal(report.codeSignatureVerified, undefined);
  assert.equal(f.commands.length, 1);
  assert.ok(f.commands[0][0].endsWith('mihomo.exe'));
  assert.equal(report.bundledSubscriptionsAbsent, true);
});

test('packaged proxy permits an absent or empty legacy compatibility resource', async (t) => {
  const f = await fixture(t);
  for (const bootstrap of [{}, { subscriptionUrl: '' }, { subscriptionUrls: [] }, { subscriptionUrls: [], subscriptionUrl: '' }]) {
    await writeFile(join(f.directory, 'subscription.json'), JSON.stringify(bootstrap));
    assert.equal((await f.verify()).bundledSubscriptionsAbsent, true);
  }
  await rm(join(f.directory, 'subscription.json'));
  assert.equal((await f.verify()).bundledSubscriptionsAbsent, true);
});

test('packaged proxy rejects missing resources, stale versions, and wrong official archive metadata before starting a native process', async (t) => {
  const f = await fixture(t);
  f.buildInfo.version = 'v0.0.1';
  await writeFile(join(f.directory, 'build-info.json'), JSON.stringify(f.buildInfo));
  await assert.rejects(f.verify(), /source\/version metadata/);
  f.buildInfo.version = f.options.runtimeLock.version;
  f.buildInfo.binaries['mac-arm64'].archiveSha256 = '0'.repeat(64);
  await writeFile(join(f.directory, 'build-info.json'), JSON.stringify(f.buildInfo));
  await assert.rejects(f.verify(), /archive\/architecture metadata/);
  await rm(join(f.directory, 'mihomo'));
  await assert.rejects(f.verify(), /Missing or invalid/);
  assert.equal(f.commands.length, 0);
});

test('packaged proxy rejects damaged source and license plus missing attribution', async (t) => {
  const f = await fixture(t);
  const source = await readFile(join(f.directory, 'corresponding-source.tar.gz'));
  await writeFile(join(f.directory, 'corresponding-source.tar.gz'), 'tampered source');
  await assert.rejects(f.verify(), /corresponding-source checksum/);
  await writeFile(join(f.directory, 'corresponding-source.tar.gz'), source);
  await writeFile(join(f.directory, 'LICENSE'), 'wrong license');
  await assert.rejects(f.verify(), /license checksum/);
  await writeFile(join(f.directory, 'LICENSE'), license);
  await writeFile(join(f.directory, 'NOTICE'), 'unattributed executable');
  await assert.rejects(f.verify(), /attribution\/source notice/);
  assert.equal(f.commands.length, 0);
});

test('packaged proxy rejects every embedded default, including plural and legacy URLs, without exposing private contents', async (t) => {
  const f = await fixture(t);
  const privateUrl = 'https://example.com/sub?token=private-fixture-value';
  for (const bootstrap of [{ subscriptionUrl: privateUrl }, { subscriptionUrls: [privateUrl], subscriptionUrl: '' },
    { subscriptionUrls: [], subscriptionUrl: privateUrl }, { subscriptionUrls: privateUrl },
    { subscriptionUrls: [], alternate: privateUrl }, [], null]) {
    await writeFile(join(f.directory, 'subscription.json'), JSON.stringify(bootstrap));
    await assert.rejects(f.verify(), (error) => {
      assert.doesNotMatch(error.message, /private-fixture-value|example\.com|token=/);
      return /must not contain subscription URLs/.test(error.message);
    });
  }
  await writeFile(join(f.directory, 'subscription.json'), '{malformed private-fixture-value');
  await assert.rejects(f.verify(), (error) => {
    assert.doesNotMatch(error.message, /private-fixture-value/);
    return /Invalid packaged/.test(error.message);
  });
  assert.equal(f.commands.length, 0);
});

test('packaged proxy rejects native architecture mismatch, unsigned binary, failed startup, and stale native version', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.verify({ runCommand: () => ({ status: 0, stdout: 'x86_64' }) }), /Mach-O architecture/);
  await assert.rejects(f.verify({ runCommand: (command) => command === 'lipo'
    ? { status: 0, stdout: 'arm64' } : { status: 1, stderr: 'private-fixture-value' } }), /code signature verification failed/);
  for (const runResult of [{ status: null, error: new Error('private-fixture-value') },
    { status: 0, stdout: 'Mihomo Meta v0.0.1 darwin arm64' },
    { status: 0, stdout: `Mihomo Meta ${f.options.runtimeLock.version} windows amd64` }]) {
    await assert.rejects(f.verify({ runCommand: (command, args, options) => command === 'lipo' || command === 'codesign'
      ? f.options.runCommand(command, args, options) : runResult }), (error) => {
      assert.doesNotMatch(error.message, /private-fixture-value/);
      return /native/.test(error.message);
    });
  }
});
