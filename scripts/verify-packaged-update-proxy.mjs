import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pinnedRuntimeLock = JSON.parse(readFileSync(new URL('../desktop/resources/update-proxy/runtime.lock.json', import.meta.url), 'utf8'));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

async function regularFile(directory, filename) {
  const path = join(directory, filename);
  let info;
  try { info = await lstat(path); } catch { /* Sanitize missing file diagnostics. */ }
  requireCondition(info?.isFile() && !info.isSymbolicLink(), `Missing or invalid packaged update proxy ${filename}.`);
  return path;
}

async function jsonResource(directory, filename) {
  const path = await regularFile(directory, filename);
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`Invalid packaged update proxy ${filename}; resource contents are omitted.`); }
}

function nativeCommand(runCommand, executable, args, description) {
  let result;
  try { result = runCommand(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error(`Packaged update proxy ${description} failed.`); }
  requireCondition(result && !result.error && result.status === 0 && !result.signal, `Packaged update proxy ${description} failed.`);
  return typeof result.stdout === 'string' ? result.stdout : '';
}

// This is a read-only native gate. Mihomo -v exits without starting a proxy,
// reading a subscription, or making a network request. Injected commands/locks
// allow portable negative-fixture tests; release callers use the pinned defaults.
export async function verifyPackagedUpdateProxy(resources, { platform = process.platform, arch = process.arch,
  runCommand = spawnSync, runtimeLock = pinnedRuntimeLock } = {}) {
  const osName = { darwin: 'mac', win32: 'win' }[platform];
  const target = `${osName}-${arch}`;
  const pinned = runtimeLock.targets?.[target];
  requireCondition(Boolean(osName && pinned), 'Unsupported packaged update proxy platform/architecture.');
  const directory = join(resources, 'proxy');
  let directoryInfo;
  try { directoryInfo = await lstat(directory); } catch { /* Missing package resource. */ }
  requireCondition(directoryInfo?.isDirectory() && !directoryInfo.isSymbolicLink(), 'Missing or invalid packaged update proxy resource directory.');
  const executableName = platform === 'win32' ? 'mihomo.exe' : 'mihomo';
  const executable = await regularFile(directory, executableName);
  const buildInfo = await jsonResource(directory, 'build-info.json');
  requireCondition(buildInfo.schemaVersion === 1 && buildInfo.version === runtimeLock.version
    && buildInfo.sourceCommit === runtimeLock.sourceCommit && buildInfo.sourceUrl === runtimeLock.source.url
    && buildInfo.sourceSha256 === runtimeLock.source.sha256 && buildInfo.license === runtimeLock.license,
  'Packaged update proxy source/version metadata does not match the pinned runtime.');
  const binaryInfo = buildInfo.binaries?.[target];
  requireCondition(binaryInfo?.asset === pinned.asset && binaryInfo.archiveSha256 === pinned.sha256
    && binaryInfo.executable === executableName && /^[a-f0-9]{64}$/.test(binaryInfo.upstreamBinarySha256 || '')
    && Number.isSafeInteger(binaryInfo.upstreamBinaryBytes) && binaryInfo.upstreamBinaryBytes > 0,
  'Packaged update proxy archive/architecture metadata does not match the pinned runtime.');
  const sourcePath = await regularFile(directory, 'corresponding-source.tar.gz');
  const source = await readFile(sourcePath);
  requireCondition(source.length === runtimeLock.source.bytes && hash(source) === runtimeLock.source.sha256,
    'Packaged update proxy corresponding-source checksum/size verification failed.');
  const license = await readFile(await regularFile(directory, 'LICENSE'));
  requireCondition(hash(license) === runtimeLock.licenseSha256, 'Packaged update proxy license checksum verification failed.');
  const notice = await readFile(await regularFile(directory, 'NOTICE'), 'utf8');
  requireCondition(notice.includes(runtimeLock.version) && notice.includes(runtimeLock.sourceCommit)
    && notice.includes('corresponding-source.tar.gz') && notice.includes('GNU General Public License'),
  'Packaged update proxy attribution/source notice is incomplete.');
  // Older resource layouts can keep an empty bootstrap. It is optional and must
  // never carry URLs: subscriptions are exclusively managed by the remote API.
  let bootstrapInfo;
  try { bootstrapInfo = await lstat(join(directory, 'subscription.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot inspect packaged update proxy compatibility resource.'); }
  if (bootstrapInfo) {
    const bootstrap = await jsonResource(directory, 'subscription.json');
    requireCondition(bootstrap && typeof bootstrap === 'object' && !Array.isArray(bootstrap)
      && (bootstrap.subscriptionUrls === undefined || Array.isArray(bootstrap.subscriptionUrls) && bootstrap.subscriptionUrls.length === 0)
      && (bootstrap.subscriptionUrl === undefined || bootstrap.subscriptionUrl === '')
      && Object.keys(bootstrap).every((key) => ['subscriptionUrls', 'subscriptionUrl'].includes(key)),
    'Packaged update proxy must not contain subscription URLs; resource contents are omitted.');
  }
  if (platform === 'darwin') {
    const architecture = nativeCommand(runCommand, 'lipo', ['-archs', executable], 'architecture check').trim();
    requireCondition(architecture === (arch === 'x64' ? 'x86_64' : 'arm64'), 'Packaged update proxy Mach-O architecture does not match the package.');
    nativeCommand(runCommand, 'codesign', ['--verify', '--strict', executable], 'code signature verification');
  }
  const versionOutput = nativeCommand(runCommand, executable, ['-v'], 'native version/startup check');
  const words = versionOutput.trim().split(/\s+/);
  requireCondition(words.includes('Mihomo') && words.includes(runtimeLock.version), 'Packaged update proxy native version does not match the pinned runtime.');
  const expectedOs = platform === 'darwin' ? 'darwin' : 'windows';
  const expectedArch = arch === 'x64' ? 'amd64' : 'arm64';
  requireCondition(words.includes(expectedOs) && words.includes(expectedArch), 'Packaged update proxy native platform/architecture does not match the package.');
  // macOS signing can change executable bytes after beforePack. Validate its
  // sealed native signature and startup rather than comparing a pre-sign hash.
  return { version: runtimeLock.version, target, sourceCommit: runtimeLock.sourceCommit,
    archiveSha256: pinned.sha256, sourceArchiveVerified: true, licenseVerified: true,
    bundledSubscriptionsAbsent: true, configurationSource: 'management-api', nativeStartupVerified: true,
    ...(platform === 'darwin' ? { codeSignatureVerified: true } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resources = process.argv[2];
  Promise.resolve().then(() => {
    requireCondition(Boolean(resources), 'Usage: node scripts/verify-packaged-update-proxy.mjs <Resources directory>');
    return verifyPackagedUpdateProxy(resolve(resources));
  }).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
    console.error(`Packaged update proxy verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
