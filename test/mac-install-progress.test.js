import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMacInstallProgress } from '../desktop/mac-install-progress.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'brclio-progress-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resultPath = path.join(directory, 'install-result.json');
  await writeFile(resultPath, JSON.stringify({ status: 'preparing' }));
  return { resultPath, version: '1.8.2' };
}

function fakeProcess(onSource) {
  let call;
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = source => { call.source = source; Promise.resolve().then(() => onSource?.(call, child)).catch(error => child.emit('error', error)); };
  child.killCount = 0;
  child.kill = () => { child.killCount++; child.emit('exit', null, 'SIGTERM'); return true; };
  child.unref = () => { child.unreferenced = true; };
  return { child, get call() { return call; }, spawn(command, args, options) { call = { command, args, options }; return child; } };
}

test('native progress uses detached system JXA with argument paths and waits for a visible window handshake', async t => {
  const input = await fixture(t);
  const fake = fakeProcess(async ({ args }) => {
    await delay(35);
    await writeFile(args[4], JSON.stringify({ ready: true, windowNumber: 18 }));
  });
  const progress = await startMacInstallProgress(input, { platform: 'darwin', spawn: fake.spawn });
  t.after(() => progress.close());
  assert.equal(fake.call.command, '/usr/bin/osascript');
  assert.deepEqual(fake.call.args.slice(0, 4), ['-l', 'JavaScript', '-', input.resultPath]);
  assert.equal(fake.call.args[5], input.version);
  assert.equal(fake.call.options.detached, true);
  assert.deepEqual(fake.call.options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(fake.call.source.includes(input.resultPath), false, 'result path cannot become executable JXA source');
  assert.equal(fake.child.unreferenced, true, 'old Electron process can exit independently');
  assert.deepEqual(JSON.parse(await readFile(input.resultPath, 'utf8')), { status: 'preparing' }, 'viewer never changes installation state');
  await progress.close();
  await progress.close();
  assert.equal(fake.child.killCount, 1, 'closing is idempotent');
  await assert.rejects(lstat(path.dirname(fake.call.args[4])), { code: 'ENOENT' });
});

for (const mode of ['missing ready file', 'invalid window acknowledgement', 'spawn error', 'premature exit', 'cancelled']) {
  test(`native progress ${mode} fails promptly and cleans child and handshake files`, async t => {
    const input = await fixture(t);
    const controller = new AbortController();
    const fake = fakeProcess(async ({ args }, child) => {
      if (mode === 'invalid window acknowledgement') await writeFile(args[4], JSON.stringify({ ready: true, windowNumber: 0 }));
      if (mode === 'spawn error') child.emit('error', new Error('fixture spawn failure'));
      if (mode === 'premature exit') child.emit('exit', 1);
      if (mode === 'cancelled') controller.abort(new Error('fixture cancellation'));
    });
    await assert.rejects(startMacInstallProgress(input, {
      platform: 'darwin', spawn: fake.spawn, readinessTimeoutMs: 100, signal: controller.signal
    }), { code: 'MAC_UPDATE_PROGRESS' });
    assert.equal(fake.child.killCount, mode === 'premature exit' ? 0 : 1);
    await assert.rejects(lstat(path.dirname(fake.call.args[4])), { code: 'ENOENT' });
  });
}

test('unsupported platform and invalid metadata cannot start a progress process', async t => {
  const input = await fixture(t);
  for (const [change, platform] of [[{}, 'win32'], [{ resultPath: 'relative.json' }, 'darwin'], [{ resultPath: '/tmp/bad\npath' }, 'darwin'], [{ version: '1.8.2; exit' }, 'darwin']]) {
    await assert.rejects(startMacInstallProgress({ ...input, ...change }, {
      platform, spawn() { assert.fail('invalid request must not spawn'); }
    }), { code: 'MAC_UPDATE_PROGRESS' });
  }
});

const native = process.platform === 'darwin' && process.env.MAC_INSTALL_PROGRESS_NATIVE === '1';
test('native AppKit window survives all installer stages and closes only after installed', { skip: !native, timeout: 15000 }, async t => {
  const input = await fixture(t);
  let child, stderr = '';
  const progress = await startMacInstallProgress(input, { spawn(command, args, options) {
    child = spawn(command, args, { ...options, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return child;
  } });
  t.after(() => progress.close());
  child.ref();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  for (const status of ['opening', 'verifying', 'copying', 'checking', 'prepared', 'ready', 'waiting', 'validating', 'replacing', 'launching']) {
    await writeFile(input.resultPath, JSON.stringify({ status }));
    await delay(130);
    assert.equal(child.exitCode, null, `${status} must keep the progress viewer alive`);
  }
  await writeFile(input.resultPath, JSON.stringify({ status: 'installed', message: '安装成功，正在自动打开新版应用。' }));
  const outcome = await Promise.race([exited, delay(4000, { timeout: true })]);
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
});

test('native failure and rollback windows retain their explanation until closed', { skip: !native, timeout: 15000 }, async t => {
  for (const status of ['helper_failed', 'rolled_back', 'cancelled']) {
    const input = await fixture(t);
    await writeFile(input.resultPath, JSON.stringify({ status, message: '安装测试未完成。当前应用未修改。' }));
    let child;
    const progress = await startMacInstallProgress(input, { spawn(command, args, options) { child = spawn(command, args, options); return child; } });
    t.after(() => progress.close());
    await delay(1200);
    assert.equal(child.exitCode, null, `${status} must not look like an automatically dismissed success`);
    await progress.close();
    assert.equal(child.signalCode, 'SIGTERM', 'explicit close waits for the native window process to end');
  }
});
