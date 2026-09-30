import assert from 'node:assert/strict';
import test from 'node:test';
import { packageState, uiNodes, verifyAndroidUpgrade } from '../scripts/verify-android-upgrade.mjs';

test('emulator acceptance reads signed package identity without confusing user or target SDK numbers', () => {
  const value = packageState('Package [com.brclio.xhs]\n userId=10176\n versionCode=10003 minSdk=26 targetSdk=35\n versionName=1.0.3\n firstInstallTime=2026-09-30 01:23:45\n');
  assert.deepEqual(value, { versionCode: 10003, versionName: '1.0.3', userId: 10176, firstInstallTime: '2026-09-30 01:23:45' });
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
