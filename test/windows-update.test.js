import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchWindowsUpdate } from '../desktop/windows-update.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xhs-windows-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installer = path.join(directory, "Installer ' $() & space.exe");
  await writeFile(installer, 'checksum-verified test fixture');
  return { directory, installer };
}

test('Windows update launches existing-install upgrade with success-only relaunch, no command shell, and waits for spawn before application exit', async t => {
  const { installer } = await fixture(t);
  let child, unreferenced = false, finished = false;
  const pending = launchWindowsUpdate(installer, { parentPid: 12345 }, { platform: 'win32', spawn(file, args, options) {
    assert.equal(file, installer, 'quoted and metacharacter paths stay a single executable path');
    assert.deepEqual(args, ['--updated', '--force-run', '--brclio-update-parent=12345']);
    assert.equal(args.includes('/S'), false, 'installation progress stays visible');
    assert.deepEqual(options, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child = new EventEmitter();
    child.unref = () => { unreferenced = true; };
    setImmediate(() => {
      assert.equal(finished, false, 'caller must not quit until Windows has accepted the installer process');
      child.emit('spawn');
    });
    return child;
  } }).then(() => { finished = true; });
  await pending;
  assert.equal(unreferenced, true, 'installer survives the old application exit');
});

test('Windows spawn failure propagates so update manager keeps the old application open', async t => {
  const { installer } = await fixture(t);
  const failure = Object.assign(new Error('access denied'), { code: 'EACCES' });
  await assert.rejects(launchWindowsUpdate(installer, {}, { platform: 'win32', spawn() {
    const child = new EventEmitter();
    child.unref = () => assert.fail('failed installer must not be handed off');
    queueMicrotask(() => child.emit('error', failure));
    return child;
  } }), failure);
});

test('Windows installer rejects unsupported platforms, invalid processes and non-file executable paths', async t => {
  const { directory, installer } = await fixture(t);
  const dependencies = { platform: 'win32', spawn: () => assert.fail('invalid input must never launch') };
  await assert.rejects(launchWindowsUpdate(installer, {}, { ...dependencies, platform: 'darwin' }), { code: 'WINDOWS_UPDATE_PLATFORM' });
  for (const value of [1, 0, -1, 1.5, '123']) {
    await assert.rejects(launchWindowsUpdate(installer, { parentPid: value }, dependencies), { code: 'WINDOWS_UPDATE_INPUT' });
  }
  for (const value of ['installer.exe', `${installer}\n`, directory, installer.replace('.exe', '.dmg')]) {
    await assert.rejects(launchWindowsUpdate(value, {}, dependencies), { code: 'WINDOWS_UPDATE_INPUT' });
  }
  const missing = path.join(directory, 'missing.exe');
  await assert.rejects(launchWindowsUpdate(missing, {}, dependencies), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    const linked = path.join(directory, 'linked.exe'); await symlink(installer, linked);
    await assert.rejects(launchWindowsUpdate(linked, {}, dependencies), { code: 'WINDOWS_UPDATE_INPUT' });
  }
  assert.equal((await lstat(installer)).isFile(), true);
});

test('NSIS assisted installer wiring covers successful visible completion and explicit silent forced relaunch', async () => {
  const config = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(config.build.nsis.oneClick, false);
  assert.equal(config.build.nsis.runAfterFinish, true);
  assert.equal(config.build.nsis.include, 'desktop/resources/installer.nsh');
  const custom = await readFile(new URL('../desktop/resources/installer.nsh', import.meta.url), 'utf8');
  assert.match(custom, /WaitForSingleObject\(p R2, i 300000\)/, 'normal app shutdown completes before NSIS can replace files');
  assert.match(custom, /Function BrclioFinishPagePre\s+IfAbort brclio_finish_done/);
  assert.match(custom, /\$BrclioInstallSucceeded == "1"[\s\S]+\$\{StdUtils.ExecShellAsUser\}/);
  assert.doesNotMatch(custom, /MUI_FINISHPAGE_RUN/, 'manual finish does not add a second launch checkbox');
  const section = await readFile(new URL('../node_modules/app-builder-lib/templates/nsis/installSection.nsh', import.meta.url), 'utf8');
  assert.match(section, /\$\{if\} \$\{isForceRun\}\s+\$\{andIf\} \$\{Silent\}\s+!insertmacro doStartApp/, 'pinned builder only performs its own launch for explicit silent invocations, so visible installation launches once');
});
