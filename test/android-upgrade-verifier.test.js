import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureUiHierarchy, installSourceToggle, packageState, uiNodes, verifyAndroidUpgrade } from '../scripts/verify-android-upgrade.mjs';
import { copyManualFallbackSources, FALLBACK_BUILD_DEPENDENCIES, FALLBACK_SHARED_ASSETS,
  hasManualBrowserIntent, manualDownloadControl, manualFallbackAttemptState,
  observeManualBrowserIntent, selectPublishedAndroid } from '../scripts/verify-android-manual-fallback.mjs';

test('isolated manual fallback fixture includes every shared asset required by the candidate Gradle bundle', async () => {
  const gradle = await readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  const assetList = gradle.match(/def learningFiles\s*=\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(assetList, 'Candidate Gradle shared promotion asset list must be explicit');
  const required = [...assetList.matchAll(/'([^']+)'/g)].map(([, file]) => file);
  assert.deepEqual([...FALLBACK_SHARED_ASSETS].sort(), required.sort(),
    'The disposable fixture must copy the complete candidate bundle before its debug build');
  for (const file of FALLBACK_SHARED_ASSETS) {
    assert.ok((await readFile(new URL(`../${file}`, import.meta.url))).length > 0, `Shared asset is missing: ${file}`);
  }
});

test('isolated manual fallback copies the real runtime provisioner and its pinned build dependencies', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fixture = await mkdtemp(path.join(tmpdir(), 'brclio-fallback-source-test-'));
  try {
    await copyManualFallbackSources(root, fixture);
    assert.deepEqual([...FALLBACK_BUILD_DEPENDENCIES].sort(), [
      'scripts/prepare-update-proxy.mjs', 'desktop/resources/update-proxy/runtime.lock.json',
      'desktop/resources/update-proxy/android-parent-launcher.c',
      'desktop/resources/update-proxy/LICENSE', 'desktop/resources/update-proxy/NOTICE',
    ].sort());
    for (const file of [...FALLBACK_SHARED_ASSETS, ...FALLBACK_BUILD_DEPENDENCIES]) {
      assert.deepEqual(await readFile(path.join(fixture, file)), await readFile(path.join(root, file)),
        `The isolated build must use the unchanged candidate dependency: ${file}`);
    }
    const provisioner = await import(pathToFileURL(path.join(fixture, 'scripts/prepare-update-proxy.mjs')).href);
    const lock = JSON.parse(await readFile(path.join(root, 'desktop/resources/update-proxy/runtime.lock.json'), 'utf8'));
    assert.deepEqual(provisioner.runtimeLock, lock, 'Copied provisioner must resolve its adjacent runtime lock');
    const gradle = await readFile(path.join(fixture, 'android/app/build.gradle'), 'utf8');
    assert.match(gradle, /dependsOn syncLearningAssets, prepareUpdateProxy/,
      'Fixture must retain the signed candidate runtime and shared-assets build steps');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('upgrade CI installs the SDK and pinned NDK required by the isolated candidate fixture', async () => {
  const workflow = await readFile(new URL('../.github/workflows/android-release.yml', import.meta.url), 'utf8');
  const upgradeJob = workflow.slice(workflow.indexOf('  upgrade-emulator:'));
  assert.match(upgradeJob, /sdkmanager 'platforms;android-35' 'build-tools;35\.0\.0' 'ndk;27\.2\.12479018'/);
  assert.match(upgradeJob, /script: node scripts\/verify-android-upgrade\.mjs/);
});

test('manual fallback selects the exact visible enabled Button instead of matching its release-note text', () => {
  // Reproduce run 36716769177: a visible TextView mentioned the button while
  // the real offscreen Button had an inverted vertical rectangle.
  const viewport = '<node text="" class="android.webkit.WebView" package="com.brclio.xhs.debug" bounds="[0,63][1080,1859]" />';
  const notes = '<node text="软件更新区新增「浏览器下载最新版 APK」按钮。" class="android.widget.TextView" package="com.brclio.xhs.debug" clickable="false" enabled="true" bounds="[49,1073][1031,1601]" />';
  const button = (bounds, enabled = 'true', clickable = 'true') => `<node text="浏览器下载最新版 APK ↗" class="android.widget.Button" package="com.brclio.xhs.debug" clickable="${clickable}" enabled="${enabled}" bounds="${bounds}" />`;
  assert.equal(manualDownloadControl(uiNodes(viewport + notes + button('[49,1911][580,1859]'))), undefined);
  assert.equal(manualDownloadControl(uiNodes(viewport + notes + button('[49,1700][580,1930]'))), undefined,
    'A valid rectangle extending outside the WebView must not be tapped');
  assert.equal(manualDownloadControl(uiNodes(viewport + notes + button('[49,1400][580,1516]', 'false'))), undefined);
  assert.equal(manualDownloadControl(uiNodes(viewport + notes + button('[49,1400][580,1516]', 'true', 'false'))), undefined);
  const visible = uiNodes(viewport + notes + button('[49,1400][580,1516]'));
  assert.equal(manualDownloadControl(visible), visible[2]);
  assert.equal(manualDownloadControl(uiNodes(viewport + notes + button('[49,1400][580,1516]').replace(' ↗', ''))), undefined,
    'Partial text cannot identify a control');
});

test('emulator acceptance reads signed package identity without confusing user or target SDK numbers', () => {
  const value = packageState('Package [com.brclio.xhs]\n userId=10176\n versionCode=10003 minSdk=26 targetSdk=35\n versionName=1.0.3\n firstInstallTime=2026-09-30 01:23:45\n');
  assert.deepEqual(value, { versionCode: 10003, versionName: '1.0.3', userId: 10176, firstInstallTime: '2026-09-30 01:23:45' });
  const android15 = 'Package [com.brclio.xhs]\n appId=10176\n versionCode=10003 minSdk=26 targetSdk=35\n versionName=1.0.3\n User 0: installed=true\n  firstInstallTime=2026-09-30 01:23:45\n';
  assert.deepEqual(packageState(android15), value, 'Android 15 package dumps label the app UID as appId');
  assert.throws(() => packageState('Unable to find package'), /Missing installed version/);
});

test('emulator UI clicks can use only observed node bounds, with decoded accessibility text', () => {
  const nodes = uiNodes('<hierarchy><node text="检查更新" class="android.widget.Button" bounds="[20,900][200,980]"/><node text="Allow &amp; install" checkable="true" checked="false" bounds="[25,50][200,80]" /></hierarchy>');
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0].rect, [20, 900, 200, 980]);
  assert.equal(nodes[1].text, 'Allow & install');
  assert.equal(nodes[1].checked, 'false');
  assert.equal(uiNodes('<node text="invalid" bounds="[-1,0][3,4]"/>')[0].rect, undefined);
});

test('UI capture restarts a crashed UiAutomation process and never reads its stale file', async () => {
  const calls = [], failures = [];
  let dumps = 0;
  const xml = '<hierarchy><node text="Fresh screen" /></hierarchy>';
  const value = await captureUiHierarchy({
    shell: async (...args) => { calls.push(args[0]); if (args[0] === 'uiautomator' && ++dumps === 1)
      throw Object.assign(new Error('dump failed'), { stderr: 'Bad file descriptor' }); },
    device: async () => { calls.push('read'); return xml; },
    onRetry: failure => failures.push(failure), wait: async () => {},
  });
  assert.equal(value, xml);
  assert.deepEqual(calls, ['rm', 'uiautomator', 'rm', 'uiautomator', 'read']);
  assert.match(failures[0].detail, /Bad file descriptor/);
});

test('UI capture fails closed after three unavailable or invalid fresh snapshots', async () => {
  let removals = 0, reads = 0;
  await assert.rejects(captureUiHierarchy({
    shell: async command => { if (command === 'rm') removals++; },
    device: async () => { reads++; return ''; }, wait: async () => {},
  }), /failed after 3 attempts.*Missing fresh Android UI hierarchy/s);
  assert.equal(removals, 3); assert.equal(reads, 3);
});

test('release upgrade fixture refuses to run outside disposable GitHub Actions', async () => {
  const previous = process.env.GITHUB_ACTIONS;
  try {
    process.env.GITHUB_ACTIONS = 'false';
    await assert.rejects(verifyAndroidUpgrade(), /restricted to GitHub Actions/);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  }
});

test('Android 15 Compose install-source control is recognized without assuming the Switch class', () => {
  // The relevant observed nodes from Android emulator run 36654435742.
  const nodes = uiNodes('<node text="Brclio 小红书下载器" package="com.android.settings" bounds="[307,740][773,815]"/>'
    + '<node text="Allow from this source" package="com.android.settings" bounds="[63,963][610,1025]"/>'
    + '<node text="" class="android.view.View" package="com.android.settings" checkable="true" checked="false" clickable="true" enabled="true" bounds="[0,916][1080,1072]"/>');
  assert.equal(installSourceToggle(nodes), nodes[2]);
  assert.equal(installSourceToggle(nodes.slice(1)), undefined, 'An unrelated application setting cannot be selected');
  assert.equal(installSourceToggle([...nodes, nodes[2]]), undefined, 'An ambiguous settings screen cannot be selected');
});

test('manual fallback acceptance selects a real stable Android APK and rejects a redirected asset URL', () => {
  const release = version => ({ tag_name: `android-v${version}`, draft: false, prerelease: false,
    assets: [{ name: `Brclio-XHS-Android-${version}-release.apk`, state: 'uploaded', size: 123,
      browser_download_url: `https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v${version}/Brclio-XHS-Android-${version}-release.apk` }] });
  assert.equal(selectPublishedAndroid([release('1.0.2'), release('1.0.10'),
    { ...release('1.0.11'), draft: true }, { ...release('1.0.12'), prerelease: true },
    { ...release('1.0.13'), tag_name: 'v1.0.13' }]).version, '1.0.10');
  const invalid = release('1.0.3'); invalid.assets[0].browser_download_url = 'https://attacker.test/app.apk';
  assert.throws(() => selectPublishedAndroid([invalid]));
  assert.throws(() => selectPublishedAndroid([{ ...release('1.0.3'), draft: undefined }]));
});

test('manual browser acceptance requires ACTION_VIEW, BROWSABLE, exact APK URL and browser component in one intent', () => {
  const url = 'https://github.com/Brclio/brclio-xhs-media-downloader/releases/download/android-v1.0.12/Brclio-XHS-Android-1.0.12-release.apk';
  const intent = `Intent { act=android.intent.action.VIEW cat=[android.intent.category.BROWSABLE] dat=${url} flg=0x800000 cmp=com.android.chrome/IntentDispatcher }`;
  assert.equal(hasManualBrowserIntent(intent, url, 'com.android.chrome'), true);
  for (const invalid of [intent.replace('action.VIEW', 'action.MAIN'),
    intent.replace('category.BROWSABLE', 'category.DEFAULT'), intent.replace(url, `${url}?other=1`),
    intent.replace('com.android.chrome/', 'com.android.chrome.attacker/'),
    intent.replace(' cmp=', '\n cmp=')]) {
    assert.equal(hasManualBrowserIntent(invalid, url, 'com.android.chrome'), false);
  }
});

test('completed native fallback network errors can be retried but running or security failures cannot', () => {
  const observed = { busy: false, tone: 'error', status: '手动下载链接未打开：更新服务连接失败，请检查网络后重试。' };
  assert.equal(manualFallbackAttemptState(observed).retryable, true);
  assert.equal(manualFallbackAttemptState({ ...observed, busy: true }).retryable, false);
  for (const status of ['公开安装包低于当前版本，已阻止打开旧版下载。', '校验文件无效。',
    '未找到可用浏览器，请先安装或启用浏览器后重试。', '更新安全连接失败，请检查设备时间和网络。']) {
    assert.equal(manualFallbackAttemptState({ ...observed, status: `手动下载链接未打开：${status}` }).retryable, false);
  }
  const state = manualFallbackAttemptState({ ...observed, status: '错误 https://private.test/?token=example password=example' });
  assert.doesNotMatch(state.status, /private\.test|example/);
});

test('native manual browser observer fails promptly with the actual completed callback error', async () => {
  let time = 0, reads = 0;
  await assert.rejects(observeManualBrowserIntent({
    expectedUrl: 'https://github.com/example.apk', browserPackage: 'com.android.chrome',
    readActivity: async () => '',
    readState: async () => ({ busy: ++reads === 1, tone: 'error',
      status: '手动下载链接未打开：更新操作超时，请检查网络后重试。' }),
    now: () => time, wait: async ms => { time += ms; }, timeoutMs: 5000,
  }), failure => {
    assert.match(failure.message, /Native manual download failed.*更新操作超时/);
    assert.equal(failure.retryable, true); assert.equal(reads, 2);
    return true;
  });
});

test('a successful JavaScript callback alone cannot satisfy the native browser intent gate', async () => {
  let time = 0;
  await assert.rejects(observeManualBrowserIntent({
    expectedUrl: 'https://github.com/example.apk', browserPackage: 'com.android.chrome',
    readActivity: async () => 'com.android.chrome',
    readState: async () => ({ busy: false, status: '已打开 Android 1.0.12 最新正式版下载链接。' }),
    now: () => time, wait: async ms => { time += ms; }, timeoutMs: 1000,
  }), /Timed out waiting for real native ACTION_VIEW/);
  const url = 'https://github.com/example.apk';
  const intent = `Intent { act=android.intent.action.VIEW cat=[android.intent.category.BROWSABLE] dat=${url} cmp=com.android.chrome/IntentDispatcher }`;
  const observed = await observeManualBrowserIntent({ expectedUrl: url, browserPackage: 'com.android.chrome',
    readActivity: async () => intent, readState: async () => { throw new Error('No renderer assertion can replace the intent'); } });
  assert.equal(observed.activity, intent);
});
