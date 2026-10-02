import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportDirectory = join(projectRoot, 'desktop/resources/update-proxy');
export const runtimeLock = JSON.parse(readFileSync(join(supportDirectory, 'runtime.lock.json'), 'utf8'));
const maximumArchiveBytes = 100 * 1024 * 1024;
const maximumBinaryBytes = 150 * 1024 * 1024;
export const androidNdkVersion = '27.2.12479018';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Compatibility resource only. Runtime configuration comes from the management
// API; build environments and previous private local files cannot add defaults.
export function bootstrapConfiguration() {
  return { subscriptionUrls: [], subscriptionUrl: '' };
}

// Release ZIPs contain one executable. Extract that entry directly with Node so
// the provisioner works on Windows without a system unzip or Python dependency.
export function extractExecutable(archive, specification) {
  if (specification.archive === 'gzip') {
    return gunzipSync(archive, { maxOutputLength: maximumBinaryBytes });
  }
  if (specification.archive !== 'zip') throw new Error('Unsupported runtime archive format.');
  let centralOffset = -1;
  const start = Math.max(0, archive.length - 65557);
  for (let position = archive.length - 22; position >= start; position--) {
    if (archive.readUInt32LE(position) === 0x06054b50 && position + 22 + archive.readUInt16LE(position + 20) === archive.length) {
      if (archive.readUInt16LE(position + 4) || archive.readUInt16LE(position + 6)) throw new Error('Multi-disk runtime ZIPs are unsupported.');
      centralOffset = archive.readUInt32LE(position + 16);
      break;
    }
  }
  if (centralOffset < 0) throw new Error('Invalid runtime ZIP directory.');
  const executables = [];
  while (centralOffset + 46 <= archive.length && archive.readUInt32LE(centralOffset) === 0x02014b50) {
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const name = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    if (/^mihomo[^/\\]*\.exe$/i.test(name)) {
      const flags = archive.readUInt16LE(centralOffset + 8);
      const compression = archive.readUInt16LE(centralOffset + 10);
      const compressedBytes = archive.readUInt32LE(centralOffset + 20);
      const bytes = archive.readUInt32LE(centralOffset + 24);
      const localOffset = archive.readUInt32LE(centralOffset + 42);
      if ((flags & 1) || bytes > maximumBinaryBytes || localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('Invalid runtime ZIP executable entry.');
      }
      const payloadOffset = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
      if (payloadOffset + compressedBytes > archive.length) throw new Error('Truncated runtime ZIP executable.');
      const compressed = archive.subarray(payloadOffset, payloadOffset + compressedBytes);
      const executable = compression === 0 ? compressed : compression === 8
        ? inflateRawSync(compressed, { maxOutputLength: maximumBinaryBytes }) : null;
      if (!executable || executable.length !== bytes) throw new Error('Invalid runtime ZIP compression or executable size.');
      executables.push(executable);
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  if (executables.length !== 1) throw new Error('Expected exactly one Mihomo executable in the runtime ZIP.');
  return executables[0];
}

async function downloadArchive(specification, cacheDirectory) {
  // Node 22 fetch does not inherit HTTPS_PROXY. Keep build-host connectivity
  // working without making the installed application's updater depend on curl.
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) {
    const temporary = join(cacheDirectory, `${specification.sha256}.${process.pid}.download`);
    try {
      await new Promise((resolveDownload, reject) => {
        const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [
          '--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15',
          '--max-time', '180', '--max-filesize', String(specification.bytes), '--output', temporary, specification.url,
        ], { stdio: 'ignore', windowsHide: true });
        child.once('error', () => reject(new Error('The configured build network proxy requires curl to download the pinned runtime.')));
        child.once('exit', (code) => code === 0 ? resolveDownload() : reject(new Error('Official runtime download through the configured build network proxy failed.')));
      });
      return readFileSync(temporary);
    } finally { rmSync(temporary, { force: true }); }
  }
  const response = await fetch(specification.url, {
    headers: { 'User-Agent': 'Brclio-update-runtime-build', Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`Official runtime download returned HTTP ${response.status}.`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maximumArchiveBytes || bytes > specification.bytes) throw new Error('Official runtime archive exceeded its pinned size.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadedFile(specification, cacheDirectory) {
  const destination = join(cacheDirectory, specification.sha256);
  if (existsSync(destination)) {
    const cached = readFileSync(destination);
    if (cached.length === specification.bytes && sha256(cached) === specification.sha256) return cached;
    rmSync(destination, { force: true });
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const archive = await downloadArchive(specification, cacheDirectory);
      if (archive.length !== specification.bytes || sha256(archive) !== specification.sha256) {
        throw new Error('Official runtime archive failed its pinned SHA256/size verification.');
      }
      atomicWrite(destination, archive);
      return archive;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

function atomicWrite(destination, data, executable = false) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: executable ? 0o755 : destination.endsWith('subscription.json') ? 0o600 : 0o644 });
    renameSync(temporary, destination);
    if (executable && process.platform !== 'win32') chmodSync(destination, 0o755);
  } finally { rmSync(temporary, { force: true }); }
}

function androidNdk(root, env) {
  let sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const properties = join(root, 'android/local.properties');
  if (!sdk && existsSync(properties)) {
    sdk = readFileSync(properties, 'utf8').match(/^\s*sdk\.dir\s*=\s*(.+)\s*$/m)?.[1]
      ?.trim().replace(/\\([\\:= ])/g, '$1');
  }
  const ndk = env.ANDROID_NDK_HOME || env.ANDROID_NDK_ROOT || (sdk && join(sdk, 'ndk', androidNdkVersion));
  if (!ndk || !existsSync(join(ndk, 'source.properties'))
    || readFileSync(join(ndk, 'source.properties'), 'utf8').match(/^Pkg\.Revision\s*=\s*(.+)$/m)?.[1]?.trim() !== androidNdkVersion) {
    throw new Error(`Android update proxy launcher requires official Android NDK ${androidNdkVersion}. Install sdkmanager 'ndk;${androidNdkVersion}' and set ANDROID_NDK_HOME or ANDROID_HOME.`);
  }
  return resolve(ndk);
}

export function buildAndroidParentLaunchers({ root = projectRoot, env = process.env,
  abis = ['arm64-v8a', 'armeabi-v7a', 'x86_64'] } = {}) {
  const ndk = androidNdk(root, env);
  const host = { darwin: 'darwin-x86_64', win32: 'windows-x86_64', linux: 'linux-x86_64' }[process.platform];
  if (!host) throw new Error('Unsupported build host for the Android update proxy launcher.');
  const toolchain = join(ndk, 'toolchains/llvm/prebuilt', host);
  const compiler = join(toolchain, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
  if (!existsSync(compiler)) throw new Error('The pinned Android NDK is missing its host Clang compiler.');
  const sourcePath = join(supportDirectory, 'android-parent-launcher.c');
  const sourceSha256 = sha256(readFileSync(sourcePath));
  const targets = { 'arm64-v8a': 'aarch64-linux-android26', 'armeabi-v7a': 'armv7a-linux-androideabi26', x86_64: 'x86_64-linux-android26' };
  const metadata = {};
  for (const abi of abis) {
    if (!targets[abi]) throw new Error(`Unsupported Android update proxy launcher ABI ${abi}.`);
    const directory = join(root, 'android/app/build/generated/updateProxy/jniLibs', abi);
    mkdirSync(directory, { recursive: true });
    const executable = 'libbrclio_update_proxy_launcher.so';
    const destination = join(directory, executable);
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      const result = spawnSync(compiler, [`--target=${targets[abi]}`, `--sysroot=${join(toolchain, 'sysroot')}`,
        '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-fPIE', '-pie', '-s', '-ffunction-sections', '-fdata-sections',
        '-Wl,--build-id=none', '-Wl,--gc-sections', '-Wl,-z,max-page-size=16384', '-Wl,-z,common-page-size=16384',
        sourcePath, '-o', temporary], { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 });
      if (result.error || result.status !== 0) {
        throw new Error(`Android update proxy launcher compilation failed for ${abi}: ${(result.error?.message || result.stderr || 'unknown compiler failure').slice(0, 2000)}`);
      }
      const binary = readFileSync(temporary);
      atomicWrite(destination, binary, true);
      metadata[abi] = { executable, ndkVersion: androidNdkVersion, androidApi: 26,
        sourceSha256, binarySha256: sha256(binary), binaryBytes: binary.length };
    } finally { rmSync(temporary, { force: true }); }
  }
  return metadata;
}

export async function prepareUpdateProxy({ platform = process.platform, arch = process.arch,
  androidAbis = ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
  root = projectRoot, env = process.env } = {}) {
  const osName = { darwin: 'mac', mac: 'mac', win32: 'win', win: 'win', android: 'android' }[platform];
  if (!osName) throw new Error(`No pinned update proxy runtime for platform ${platform}.`);
  const targets = osName === 'android' ? androidAbis.map((abi) => `android-${abi}`) : [`${osName}-${arch}`];
  for (const target of targets) if (!runtimeLock.targets[target]) throw new Error(`No pinned update proxy runtime for target ${target}.`);
  const parentLaunchers = osName === 'android' ? buildAndroidParentLaunchers({ root, env, abis: androidAbis }) : null;
  const license = readFileSync(join(supportDirectory, 'LICENSE'));
  if (sha256(license) !== runtimeLock.licenseSha256) throw new Error('Mihomo license checksum does not match the pinned release.');
  const notice = readFileSync(join(supportDirectory, 'NOTICE'));
  const cacheDirectory = join(root, 'desktop-runtime/.update-proxy-cache');
  mkdirSync(cacheDirectory, { recursive: true });
  const source = await downloadedFile(runtimeLock.source, cacheDirectory);
  const binaries = {};
  for (const target of targets) {
    const specification = runtimeLock.targets[target];
    const archive = await downloadedFile(specification, cacheDirectory);
    const binary = extractExecutable(archive, specification);
    const abi = target.slice('android-'.length);
    const directory = osName === 'android'
      ? join(root, 'android/app/build/generated/updateProxy/jniLibs', abi)
      : join(root, 'desktop-runtime', target, 'proxy');
    const executable = osName === 'android' ? 'libbrclio_update_proxy.so' : osName === 'win' ? 'mihomo.exe' : 'mihomo';
    atomicWrite(join(directory, executable), binary, true);
    binaries[target] = { asset: specification.asset, archiveSha256: specification.sha256,
      upstreamBinarySha256: sha256(binary), upstreamBinaryBytes: binary.length, executable };
    if (osName !== 'android' && ({ darwin: 'mac', win32: 'win' }[process.platform]) === osName && process.arch === arch) {
      const result = spawnSync(join(directory, executable), ['-v'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      if (result.error || result.status !== 0 || !result.stdout.includes(runtimeLock.version)) {
        throw new Error('The bundled update proxy failed its native version/startup check.');
      }
    }
    console.log(`Prepared update proxy ${runtimeLock.version} for ${target}; official SHA256 verified.`);
  }
  const resourceDirectories = osName === 'android'
    ? [join(root, 'android/app/build/generated/updateProxy/assets/update-proxy')]
    : targets.map((target) => join(root, 'desktop-runtime', target, 'proxy'));
  const buildInfo = { schemaVersion: 1, version: runtimeLock.version, sourceCommit: runtimeLock.sourceCommit,
    sourceUrl: runtimeLock.source.url, sourceSha256: runtimeLock.source.sha256, license: runtimeLock.license, binaries,
    ...(parentLaunchers ? { parentLaunchers } : {}) };
  for (const directory of resourceDirectories) {
    atomicWrite(join(directory, 'subscription.json'), `${JSON.stringify(bootstrapConfiguration())}\n`);
    atomicWrite(join(directory, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
    atomicWrite(join(directory, 'LICENSE'), license);
    atomicWrite(join(directory, 'NOTICE'), notice);
    atomicWrite(join(directory, 'corresponding-source.tar.gz'), source);
    if (parentLaunchers) atomicWrite(join(directory, 'android-parent-launcher.c'), readFileSync(join(supportDirectory, 'android-parent-launcher.c')));
  }
  return buildInfo;
}

function cliOptions(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--platform') result.platform = args[++i];
    else if (arg === '--arch') result.arch = args[++i];
    else if (arg === '--android-abis') result.androidAbis = args[++i]?.split(',');
    else throw new Error(`Unknown update proxy preparation option: ${arg}`);
    if (!args[i]) throw new Error(`Missing value for ${arg}.`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => prepareUpdateProxy(cliOptions(process.argv.slice(2)))).catch((error) => {
    console.error(`Update proxy preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
