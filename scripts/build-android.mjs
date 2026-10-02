import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackagedAndroidProxy } from './verify-packaged-android-proxy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = join(root, 'android');
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(['--check', '--release']);
const windows = process.platform === 'win32';
const fail = (message) => { throw new Error(message); };

function findSdk() {
  const configured = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (configured) return resolve(configured);
  const localProperties = join(androidRoot, 'local.properties');
  if (existsSync(localProperties)) {
    const value = readFileSync(localProperties, 'utf8').match(/^\s*sdk\.dir\s*=\s*(.+)\s*$/m)?.[1];
    if (value) return resolve(androidRoot, value.trim().replace(/\\([\\:= ])/g, '$1'));
  }
  fail('未找到 Android SDK。请设置 ANDROID_HOME，或在 android/local.properties 中设置 sdk.dir。详见 android/README.md。');
}

function checkToolchain() {
  const java = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', windows ? 'java.exe' : 'java')
    : 'java';
  const result = spawnSync(java, ['-XshowSettings:properties', '-version'], { encoding: 'utf8' });
  const versionOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  const javaMajor = Number(versionOutput.match(/version\s+"(\d+)(?:\.|"|-)/)?.[1]);
  if (result.error || result.status !== 0 || javaMajor < 17 || !Number.isFinite(javaMajor)) {
    fail('构建需要 JDK 17 或更新版本。请将 JAVA_HOME 指向已安装的 JDK（推荐 17 或 21）。');
  }
  const javaHome = versionOutput.match(/^\s*java\.home\s*=\s*(.+)$/m)?.[1]?.trim();
  for (const executable of ['javac', 'jlink']) {
    if (!javaHome || !existsSync(join(javaHome, 'bin', `${executable}${windows ? '.exe' : ''}`))) {
      fail(`当前 Java 缺少 ${executable}。构建需要完整 JDK 17 或 21，只有 Java 运行时的 IDE 内置 JBR 不够。`);
    }
  }
  const sdk = findSdk();
  for (const sdkFile of ['platforms/android-35/android.jar', 'build-tools/35.0.0/source.properties']) {
    if (!existsSync(join(sdk, sdkFile))) {
      fail(`Android SDK 缺少 ${sdkFile}。请安装 platforms;android-35 与 build-tools;35.0.0。`);
    }
  }
  const jar = join(androidRoot, 'gradle/wrapper/gradle-wrapper.jar');
  const checksum = createHash('sha256').update(readFileSync(jar)).digest('hex');
  if (checksum !== '2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046') {
    fail('Gradle Wrapper JAR 校验失败。请从仓库恢复官方 Gradle 8.11.1 Wrapper。');
  }
  console.log(`Android 构建环境：JDK ${javaMajor}，SDK 35，Gradle Wrapper 校验通过。`);
  return sdk;
}

function checkSigning() {
  const required = ['ANDROID_SIGNING_STORE_FILE', 'ANDROID_SIGNING_STORE_PASSWORD',
    'ANDROID_SIGNING_KEY_ALIAS', 'ANDROID_SIGNING_KEY_PASSWORD'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) fail(`正式 APK 需要签名环境变量：${missing.join(', ')}。`);
  if (!existsSync(resolve(androidRoot, process.env.ANDROID_SIGNING_STORE_FILE))) {
    fail('ANDROID_SIGNING_STORE_FILE 指向的密钥库不存在。');
  }
}

function runChecked(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', cwd: root, ...options });
  if (result.error || result.status !== 0) {
    fail(`${command} 校验失败：${result.error?.message || result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

function verifyApk(sdk, apk, { release, version, versionCode }) {
  const buildTools = join(sdk, 'build-tools/35.0.0');
  const signature = runChecked(join(buildTools, windows ? 'apksigner.bat' : 'apksigner'),
    ['verify', '--verbose', '--print-certs', apk], { shell: windows });
  const certificates = [...signature.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f\d]{64})\r?$/gim)];
  if (certificates.length !== 1) fail('APK 必须具有一个可验证的签名证书。');
  const certificateSha256 = certificates[0][1].toLowerCase();
  if (release && /certificate DN:.*CN=Android Debug/i.test(signature)) fail('正式 APK 不能使用 Android Debug 证书。');
  const expectedCertificate = process.env.ANDROID_SIGNING_CERT_SHA256?.replace(/:/g, '').trim().toLowerCase();
  if (release && expectedCertificate && certificateSha256 !== expectedCertificate) {
    fail('APK 签名证书与 ANDROID_SIGNING_CERT_SHA256 不符。');
  }
  const badging = runChecked(join(buildTools, windows ? 'aapt.exe' : 'aapt'), ['dump', 'badging', apk]);
  const packageInfo = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  const applicationId = release ? 'com.brclio.xhs' : 'com.brclio.xhs.debug';
  if (!packageInfo || packageInfo[1] !== applicationId || Number(packageInfo[2]) !== versionCode
      || packageInfo[3] !== `${version}${release ? '' : '-debug'}`) fail('APK 包名或版本与构建元数据不符。');
  const minSdk = Number(badging.match(/^sdkVersion:'(\d+)'/m)?.[1]);
  if (minSdk !== 26) fail('APK 最低 Android API 与项目要求不符。');
  return { applicationId, minSdk, certificateSha256 };
}

async function main() {
  for (const arg of args) if (!allowedArgs.has(arg)) fail(`未知选项：${arg}`);
  const sdk = checkToolchain();
  const release = args.has('--release');
  if (release) checkSigning();
  if (args.has('--check')) return;

  const sourceCommit = runChecked('git', ['rev-parse', 'HEAD']).trim();
  const initiallyDirty = Boolean(runChecked('git', ['status', '--porcelain']).trim());

  const nodeTests = readdirSync(join(root, 'test'))
    .filter((filename) => /^android.*\.test\.js$/.test(filename))
    .sort().map((filename) => join(root, 'test', filename));
  if (nodeTests.length === 0) fail('未找到 Android 客户端的 Node.js 测试。');
  const nodeTestResult = spawnSync(process.execPath, ['--test', ...nodeTests], { cwd: root, stdio: 'inherit' });
  if (nodeTestResult.error || nodeTestResult.status !== 0) fail('Android 客户端 Node.js 测试未通过，已停止构建。');

  const variant = release ? 'Release' : 'Debug';
  const command = windows ? 'gradlew.bat' : './gradlew';
  const gradleArgs = ['--no-daemon', `:app:test${variant}UnitTest`, `:app:lint${variant}`, `:app:assemble${variant}`];
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(command, gradleArgs, {
      cwd: androidRoot,
      stdio: 'inherit',
      shell: windows,
      env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
    });
    child.on('error', reject);
    child.on('close', (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) fail(`Gradle 构建未通过（退出码 ${exitCode}）。未导出新的 APK。`);

  const buildType = variant.toLowerCase();
  const apkDir = join(androidRoot, 'app/build/outputs/apk', buildType);
  const metadata = JSON.parse(readFileSync(join(apkDir, 'output-metadata.json'), 'utf8'));
  const output = metadata.elements?.find((element) => element.type === 'SINGLE');
  if (!output?.outputFile || !output.versionName) fail('未找到单 APK 构建输出，请检查 Gradle 输出元数据。');
  const version = String(output.versionName).replace(/-debug$/, '');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) fail('Android 版本号格式无效。');
  const versionCode = Number(output.versionCode);
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) fail('Android versionCode 必须是正整数。');
  const sourceApk = join(apkDir, output.outputFile);
  const verification = verifyApk(sdk, sourceApk, { release, version, versionCode });
  const bundledUpdateProxy = verifyPackagedAndroidProxy(sourceApk, { root });
  if (runChecked('git', ['rev-parse', 'HEAD']).trim() !== sourceCommit) fail('构建过程中 Git 提交发生变化，请重新构建。');
  const sourceDirty = initiallyDirty || Boolean(runChecked('git', ['status', '--porcelain']).trim());
  const filename = `Brclio-XHS-Android-${version}-${buildType}.apk`;
  const dist = join(root, 'dist-android');
  mkdirSync(dist, { recursive: true });
  const destination = join(dist, filename);
  copyFileSync(sourceApk, destination);
  const checksum = createHash('sha256').update(readFileSync(destination)).digest('hex');
  writeFileSync(`${destination}.sha256`, `${checksum}  ${filename}\n`);
  if (release) {
    writeFileSync(join(dist, 'SHA256SUMS.txt'), `${checksum}  ${filename}\n`);
    writeFileSync(join(dist, 'android-update.json'), `${JSON.stringify({
      schemaVersion: 1, platform: 'android', version, versionCode,
      applicationId: verification.applicationId, minSdk: verification.minSdk,
      signingCertificateSha256: verification.certificateSha256,
      sourceCommit, sourceDirty, builtAt: new Date().toISOString(),
      bundledUpdateProxyVerified: true, bundledSubscriptionsAbsent: true, bundledUpdateProxy,
      apk: { name: filename, bytes: statSync(destination).size, sha256: checksum },
    }, null, 2)}\n`);
  }
  console.log(`\nAPK：${destination}\nSHA256：${checksum}`);
  console.log(`签名证书 SHA256：${verification.certificateSha256}`);
  console.log(release ? '正式 APK 已使用提供的密钥库签名。' : '这是 debug 测试包，使用构建机的调试密钥签名。');
}

main().catch((error) => {
  console.error(`Android 构建失败：${error.message}`);
  process.exitCode = 1;
});
