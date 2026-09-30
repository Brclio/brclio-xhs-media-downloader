// Isolated debug-only acceptance. No release sources or signed APKs are modified.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function selectPublishedAndroid(releases) {
  const stable = releases.filter(release => release.draft === false && release.prerelease === false
    && /^android-v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(release.tag_name));
  stable.sort((a, b) => {
    const left = a.tag_name.slice(9).split('.').map(Number), right = b.tag_name.slice(9).split('.').map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i] - left[i];
    return 0;
  });
  const release = stable[0];
  assert.ok(release, 'A real public Android release is required for browser fallback acceptance');
  const version = release.tag_name.slice(9), filename = `Brclio-XHS-Android-${version}-release.apk`;
  const url = `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/${release.tag_name}/${filename}`;
  const apk = release.assets.find(asset => asset.name === filename);
  assert.equal(apk?.state, 'uploaded'); assert.equal(apk.browser_download_url, url); assert.ok(apk.size > 0);
  return { tag: release.tag_name, version, url };
}

async function waitFor(check, label, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function cdpConnection(url) {
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Debug WebView CDP connection timed out')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Debug WebView CDP connection failed')); }, { once: true });
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    close() { socket.close(); for (const request of pending.values()) clearTimeout(request.timer); },
  };
}

export async function verifyManualFallback({ root, output, run, device, shell, snapshot, screenshot, findText, tap }) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal((await shell('getprop', 'ro.kernel.qemu')).trim(), '1');
  const fixtureApp = 'com.brclio.xhs.debug';
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'brclio-android-fallback-fixture-'));
  await cp(path.join(root, 'android'), path.join(fixtureRoot, 'android'), {
    recursive: true,
    filter: source => !path.relative(path.join(root, 'android'), source).split(path.sep)
      .some(part => ['build', '.gradle', 'local.properties'].includes(part)),
  });
  for (const file of ['learn.html', 'learn.css', 'learn.js', 'aiyc.svg', 'favicon.svg',
    'assets/learning/book-promo.png', 'assets/support/wechat-personal-qr.png']) {
    await mkdir(path.dirname(path.join(fixtureRoot, file)), { recursive: true });
    await cp(path.join(root, file), path.join(fixtureRoot, file));
  }
  const gradleFile = path.join(fixtureRoot, 'android/app/build.gradle');
  let gradle = await readFile(gradleFile, 'utf8');
  assert.equal((gradle.match(/versionCode\s+\d+/g) || []).length, 1);
  assert.equal((gradle.match(/versionName\s+'[^']+'/g) || []).length, 1);
  // The unpublished candidate is newer than every public APK. Lower only this
  // disposable debug copy's version so the real native no-downgrade check can pass.
  gradle = gradle.replace(/versionCode\s+\d+/, 'versionCode 1').replace(/versionName\s+'[^']+'/, "versionName '0.0.0'");
  await writeFile(gradleFile, gradle);
  const buildLog = await run('./gradlew', ['--no-daemon', ':app:assembleDebug'], {
    cwd: path.join(fixtureRoot, 'android'), timeout: 300000,
  });
  await writeFile(path.join(output, 'manual-fallback-debug-build.txt'), buildLog);
  const sourceFiles = ['app/src/main/java/com/brclio/xhs/UpdateManager.java',
    'app/src/main/java/com/brclio/xhs/MainActivity.java', 'app/src/main/assets/www/client.js',
    'app/src/main/assets/www/index.html'];
  for (const file of sourceFiles) {
    assert.deepEqual(await readFile(path.join(fixtureRoot, 'android', file)), await readFile(path.join(root, 'android', file)),
      `Debug acceptance must use the candidate's unchanged source: ${file}`);
  }
  const debugApk = path.join(fixtureRoot, 'android/app/build/outputs/apk/debug/app-debug.apk');
  assert.match(await device(['install', debugApk]), /Success/);
  const installed = await shell('dumpsys', 'package', fixtureApp);
  assert.match(installed, /versionName=0\.0\.0-debug/);
  assert.match(installed, /\bDEBUGGABLE\b/);
  const expected = selectPublishedAndroid(JSON.parse(await run('gh', ['api',
    'repos/Brclio/brclio-xhs-media-downloader/releases?per_page=100'])));
  const browser = (await shell('cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.VIEW',
    '-c', 'android.intent.category.BROWSABLE', '-d', expected.url)).trim().split('\n').at(-1);
  assert.match(browser, /^[\w.]+\/[\w.$]+$/, 'A browser handler must be available');
  assert.ok(!browser.startsWith('com.brclio.') && !browser.startsWith('android/'), 'Must route to a real installed browser');
  assert.match(await shell('am', 'start', '-W', '-n', `${fixtureApp}/com.brclio.xhs.MainActivity`), /Status: ok/);
  await waitFor(() => findText('保存一篇笔记'), 'debug fixture WebView');
  const pid = (await shell('pidof', fixtureApp)).trim(); assert.match(pid, /^\d+$/);
  const port = (await device(['forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`])).trim();
  assert.match(port, /^\d+$/);
  let cdp;
  try {
    const page = await waitFor(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find(item => item.url === 'https://appassets.androidplatform.net/assets/www/index.html'); }
      catch { return null; }
    }, 'debug-only WebView inspector');
    cdp = await cdpConnection(page.webSocketDebuggerUrl);
    await waitFor(() => cdp.evaluate(`!document.getElementById('update-details').hidden && !document.getElementById('check-update').disabled`),
      'real public release lookup in debug fixture');
    // This failure is an explicitly injected UI fixture, not a claimed real
    // Package Installer failure. The following click and native network/intent are real.
    await cdp.evaluate(`window.brclioEvent(${JSON.stringify({ type: 'update', status: 'error', canInstallBuild: true,
      error: '验收夹具：安装失败', installerClosed: true, installerResult: 'failed', downloadReady: false })})`);
    const button = await findText('浏览器下载最新版 APK', true);
    assert.ok(button, 'The injected failure must expose the real manual download button');
    const failureUi = await cdp.evaluate(`({ status: document.getElementById('update-status').textContent,
      help: document.getElementById('manual-update-help').textContent,
      visible: !document.getElementById('manual-update-help').hidden })`);
    assert.equal(failureUi.visible, true); assert.match(failureUi.status, /系统返回安装失败/);
    assert.match(failureUi.help, /覆盖安装.*不要卸载.*保留应用数据/);
    await snapshot(); await screenshot('manual-fallback-injected-failure');
    await tap(button);
    const activityDump = await waitFor(async () => {
      const dump = await shell('dumpsys', 'activity', 'activities');
      return dump.includes(expected.url) && dump.includes(browser.split('/')[0]) ? dump : null;
    }, 'real native ACTION_VIEW intent carrying the latest public APK URL', 90000);
    await writeFile(path.join(output, 'manual-fallback-browser-activities.txt'), activityDump);
    await snapshot(); await screenshot('manual-fallback-browser');
    const result = {
      verifiedAt: new Date().toISOString(), fixture: { applicationId: fixtureApp, version: '0.0.0-debug',
        sourceCopyOnly: true, productionApkModified: false, injectedInstallationFailure: true,
        injectedCanInstallBuildUiState: true, nativeNetworkMocked: false, nativeUrlOverride: false },
      failureUi, expectedPublicRelease: expected, browserComponent: browser,
      actualBrowserIntentVerified: true, sourceJavaAndWebUiUnmodified: true,
      debugApkSha256: createHash('sha256').update(await readFile(debugApk)).digest('hex'),
      limitations: ['The installer failure was a debug-WebView UI fixture. No production installer failure or browser download completion is claimed.',
        'The real native method fetched public release metadata and its checksum and dispatched the observed browser APK intent.'],
    };
    await writeFile(path.join(output, 'manual-fallback-verification.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    cdp?.close();
    await device(['forward', '--remove', `tcp:${port}`]).catch(() => {});
  }
}
