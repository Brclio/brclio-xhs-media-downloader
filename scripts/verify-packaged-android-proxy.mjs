import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinnedLock = JSON.parse(readFileSync(join(projectRoot, 'desktop/resources/update-proxy/runtime.lock.json'), 'utf8'));
const abis = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
const maximumApkBytes = 512 * 1024 * 1024;
const maximumBinaryBytes = 150 * 1024 * 1024;
const coreName = 'libbrclio_update_proxy.so';
const launcherName = 'libbrclio_update_proxy_launcher.so';
const ndkVersion = '27.2.12479018';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

// APKs use regular ZIP central directories and an optional APK signing block
// before the directory. Read only named resources; never extract to disk.
function apkReader(bytes) {
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (bytes.readUInt32LE(position) === 0x06054b50 && position + 22 + bytes.readUInt16LE(position + 20) === bytes.length) {
      end = position; break;
    }
  }
  requireCondition(end >= 0, 'Invalid APK ZIP directory.');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  requireCondition(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0
    && bytes.readUInt16LE(end + 8) === count && count !== 0xffff
    && directoryOffset !== 0xffffffff && directorySize !== 0xffffffff
    && directoryOffset + directorySize === end, 'Unsupported or truncated APK ZIP directory.');
  const entries = new Map();
  let position = directoryOffset;
  for (let index = 0; index < count; index++) {
    requireCondition(position + 46 <= end && bytes.readUInt32LE(position) === 0x02014b50, 'Invalid APK ZIP entry.');
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    requireCondition(position + 46 + nameLength + extraLength + commentLength <= end, 'Truncated APK ZIP entry.');
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
    catch { throw new Error('Invalid APK ZIP entry name.'); }
    requireCondition(name && !name.startsWith('/') && !/[\\\x00]/.test(name) && !name.split('/').includes('..')
      && !entries.has(name), 'Unsafe or duplicate APK ZIP entry.');
    entries.set(name, { nameBytes, flags: bytes.readUInt16LE(position + 8), method: bytes.readUInt16LE(position + 10),
      compressedBytes: bytes.readUInt32LE(position + 20), uncompressedBytes: bytes.readUInt32LE(position + 24),
      localOffset: bytes.readUInt32LE(position + 42), mode: bytes.readUInt32LE(position + 38) >>> 16,
      disk: bytes.readUInt16LE(position + 34) });
    position += 46 + nameLength + extraLength + commentLength;
  }
  requireCondition(position === end, 'APK ZIP entry count does not match the directory.');
  const resource = (name, maximumBytes) => {
    const entry = entries.get(name);
    requireCondition(Boolean(entry), `Missing APK update proxy resource ${name}.`);
    const { localOffset, compressedBytes, uncompressedBytes, method, flags } = entry;
    requireCondition(!(flags & 1) && entry.disk === 0 && (entry.mode & 0xf000) !== 0xa000
      && [0, 8].includes(method) && uncompressedBytes <= maximumBytes && compressedBytes <= maximumApkBytes
      && localOffset + 30 <= directoryOffset && bytes.readUInt32LE(localOffset) === 0x04034b50,
    'Unsupported or oversized APK update proxy resource.');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const payloadOffset = localOffset + 30 + localNameLength + bytes.readUInt16LE(localOffset + 28);
    requireCondition(bytes.readUInt16LE(localOffset + 6) === flags && bytes.readUInt16LE(localOffset + 8) === method
      && bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(entry.nameBytes)
      && payloadOffset + compressedBytes <= directoryOffset, 'Inconsistent APK update proxy ZIP headers.');
    const compressed = bytes.subarray(payloadOffset, payloadOffset + compressedBytes);
    let result;
    try { result = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maximumBytes }); }
    catch { throw new Error('Damaged APK update proxy compressed resource.'); }
    requireCondition(result.length === uncompressedBytes, 'APK update proxy resource size mismatch.');
    return result;
  };
  resource.has = (name) => entries.has(name);
  return resource;
}

function jsonResource(resource, filename) {
  try { return JSON.parse(resource(`assets/update-proxy/${filename}`, 65536).toString('utf8')); }
  catch { throw new Error(`Invalid or missing APK update proxy ${filename}; resource contents are omitted.`); }
}

function verifyElf(binary, abi) {
  const [elfClass, machine] = { 'arm64-v8a': [2, 183], 'armeabi-v7a': [1, 40], x86_64: [2, 62] }[abi];
  requireCondition(binary.length >= (elfClass === 2 ? 64 : 52) && binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && binary[4] === elfClass && binary[5] === 1 && binary[6] === 1
    && [2, 3].includes(binary.readUInt16LE(16)) && binary.readUInt16LE(18) === machine
    && binary.readUInt32LE(20) === 1, `APK update proxy ELF architecture mismatch for ${abi}.`);
}

// The APK signer is verified by build-android before this gate. Runtime pins
// and current compiler output independently establish the packaged resources.
export function verifyPackagedAndroidProxy(apk, { root = projectRoot, runtimeLock = pinnedLock,
  expectedLaunchers } = {}) {
  const size = statSync(apk).size;
  requireCondition(size > 0 && size <= maximumApkBytes, 'APK exceeds the update proxy verification size limit.');
  const archive = readFileSync(apk);
  const resource = apkReader(archive);
  const bootstrap = jsonResource(resource, 'subscription.json');
  requireCondition(bootstrap && typeof bootstrap === 'object' && !Array.isArray(bootstrap)
    && Array.isArray(bootstrap.subscriptionUrls) && bootstrap.subscriptionUrls.length === 0 && bootstrap.subscriptionUrl === ''
    && Object.keys(bootstrap).every((key) => ['subscriptionUrls', 'subscriptionUrl'].includes(key)),
  'APK must not contain preset subscriptions; resource contents are omitted.');
  const buildInfo = jsonResource(resource, 'build-info.json');
  requireCondition(buildInfo.schemaVersion === 1 && buildInfo.version === runtimeLock.version
    && buildInfo.sourceCommit === runtimeLock.sourceCommit && buildInfo.sourceUrl === runtimeLock.source.url
    && buildInfo.sourceSha256 === runtimeLock.source.sha256 && buildInfo.license === runtimeLock.license,
  'APK update proxy source/version metadata does not match the pinned runtime.');
  // Android's asset merger strips .gz after decompressing gzip assets. Both
  // layouts have independent pins derived from the verified official archive.
  const gzipSource = resource.has('assets/update-proxy/corresponding-source.tar.gz');
  const source = resource(`assets/update-proxy/corresponding-source.tar${gzipSource ? '.gz' : ''}`, 20 * 1024 * 1024);
  requireCondition(source.length === (gzipSource ? runtimeLock.source.bytes : runtimeLock.source.tarBytes)
    && hash(source) === (gzipSource ? runtimeLock.source.sha256 : runtimeLock.source.tarSha256),
    'APK update proxy corresponding-source checksum verification failed.');
  requireCondition(hash(resource('assets/update-proxy/LICENSE', 1024 * 1024)) === runtimeLock.licenseSha256,
    'APK update proxy license checksum verification failed.');
  const notice = resource('assets/update-proxy/NOTICE', 65536).toString('utf8');
  requireCondition(notice.includes(runtimeLock.version) && notice.includes(runtimeLock.sourceCommit)
    && notice.includes('GNU General Public License') && notice.includes('corresponding-source.tar.gz'),
  'APK update proxy attribution/source notice is incomplete.');
  const launcherSource = readFileSync(join(projectRoot, 'desktop/resources/update-proxy/android-parent-launcher.c'));
  const launcherSourceSha256 = hash(launcherSource);
  requireCondition(resource('assets/update-proxy/android-parent-launcher.c', 65536).equals(launcherSource),
    'APK update proxy launcher source does not match the current source.');
  requireCondition(Object.keys(buildInfo.binaries || {}).sort().join(',') === abis.map((abi) => `android-${abi}`).sort().join(',')
    && Object.keys(buildInfo.parentLaunchers || {}).sort().join(',') === [...abis].sort().join(','),
  'APK update proxy must contain metadata for exactly three supported ABIs.');
  const binaries = [];
  for (const abi of abis) {
    const pin = runtimeLock.targets?.[`android-${abi}`];
    const core = resource(`lib/${abi}/${coreName}`, maximumBinaryBytes);
    requireCondition(pin && /^[a-f0-9]{64}$/.test(pin.binarySha256 || '') && pin.binaryBytes === core.length
      && hash(core) === pin.binarySha256, `APK update proxy pinned core checksum verification failed for ${abi}.`);
    const coreInfo = buildInfo.binaries[`android-${abi}`];
    requireCondition(coreInfo.asset === pin.asset && coreInfo.archiveSha256 === pin.sha256 && coreInfo.executable === coreName
      && coreInfo.upstreamBinarySha256 === pin.binarySha256 && coreInfo.upstreamBinaryBytes === pin.binaryBytes,
    'APK update proxy official core metadata does not match the pinned runtime.');
    verifyElf(core, abi);
    const launcher = resource(`lib/${abi}/${launcherName}`, 1024 * 1024);
    const expectedLauncher = expectedLaunchers?.[abi]
      || readFileSync(join(root, 'android/app/build/generated/updateProxy/jniLibs', abi, launcherName));
    requireCondition(launcher.equals(expectedLauncher), `APK update proxy launcher differs from the current compiler output for ${abi}.`);
    const launcherInfo = buildInfo.parentLaunchers[abi];
    const launcherSha256 = hash(launcher);
    requireCondition(launcherInfo.executable === launcherName && launcherInfo.ndkVersion === ndkVersion && launcherInfo.androidApi === 26
      && launcherInfo.sourceSha256 === launcherSourceSha256 && launcherInfo.binaryBytes === launcher.length
      && launcherInfo.binarySha256 === launcherSha256, 'APK update proxy launcher checksum/source metadata verification failed.');
    verifyElf(launcher, abi);
    binaries.push({ abi, coreSha256: pin.binarySha256, launcherSha256, elfVerified: true });
  }
  return { version: runtimeLock.version, sourceCommit: runtimeLock.sourceCommit, apkSha256: hash(archive),
    bundledSubscriptionsAbsent: true, configurationSource: 'management-api', sourceArchiveVerified: true,
    licenseVerified: true, launcherSourceVerified: true, coreCount: 3, launcherCount: 3, binaries };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(Boolean(process.argv[2]), 'Usage: node scripts/verify-packaged-android-proxy.mjs <APK path>');
    console.log(JSON.stringify(verifyPackagedAndroidProxy(resolve(process.argv[2])), null, 2));
  } catch (error) {
    console.error(`APK update proxy verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
