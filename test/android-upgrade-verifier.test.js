import assert from 'node:assert/strict';
import test from 'node:test';
import { installSourceToggle, packageState, uiNodes, verifyAndroidUpgrade } from '../scripts/verify-android-upgrade.mjs';
import { selectPublishedAndroid } from '../scripts/verify-android-manual-fallback.mjs';

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
