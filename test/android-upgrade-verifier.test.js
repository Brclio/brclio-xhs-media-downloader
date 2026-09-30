import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { captureUiHierarchy, installSourceToggle, packageState, uiNodes, verifyAndroidUpgrade } from '../scripts/verify-android-upgrade.mjs';
import { FALLBACK_SHARED_ASSETS, manualDownloadControl, selectPublishedAndroid } from '../scripts/verify-android-manual-fallback.mjs';

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
