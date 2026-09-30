import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findWindowsMainProcess, windowsProcessQuery } from '../scripts/verify-packaged-windows-update.mjs';

const longPath = String.raw`C:\Users\runneradmin\AppData\Local\Temp\upgrade\安装路径 with spaces\Brclio 小红书下载器.exe`;
const shortPath = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\upgrade\安装路径 with spaces\Brclio 小红书下载器.exe`;

test('native Windows verifier recognizes one installed executable through short and long path aliases', async () => {
  const main = { ProcessId: 21, ExecutablePath: longPath, CommandLine: `"${longPath}" --updated` };
  const resolve = async value => value.toLowerCase() === shortPath.toLowerCase() ? longPath : value;
  assert.equal(await findWindowsMainProcess([main], shortPath, resolve), main);
  assert.equal(await findWindowsMainProcess([{ ...main, ExecutablePath: shortPath }], longPath, resolve).then(p => p.ProcessId), 21);
});

test('native Windows verifier rejects sibling installs and Electron renderer/GPU processes', async () => {
  const list = [
    { ExecutablePath: longPath, CommandLine: `"${longPath}" --type=renderer` },
    { ExecutablePath: longPath, CommandLine: `"${longPath}" --type gpu-process` },
    { ExecutablePath: longPath.replace('upgrade', 'other-upgrade'), CommandLine: '--updated' },
    { ExecutablePath: null, CommandLine: '--updated' }
  ];
  assert.equal(await findWindowsMainProcess(list, longPath, async value => value), undefined);
});

test('native Windows verifier tolerates files missing during installer replacement without accepting them', async () => {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  assert.equal(await findWindowsMainProcess([], longPath, async () => { throw missing; }), undefined);
  const main = { ExecutablePath: longPath, CommandLine: '--updated' };
  let calls = 0;
  assert.equal(await findWindowsMainProcess([main], longPath, async value => { if (calls++) throw missing; return value; }), undefined);
  await assert.rejects(findWindowsMainProcess([], longPath, async () => { throw new Error('unexpected filesystem failure'); }), /unexpected filesystem/);
});

test('Windows PowerShell process polling succeeds when the expected PID has exited', { skip: process.platform !== 'win32' }, async () => {
  // Windows process IDs are multiples of four; this odd PID cannot be alive.
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; $p = ${windowsProcessQuery}; if ($p) { throw 'Unexpected process' }`],
  { env: { ...process.env, VERIFY_PID: '2147483647' }, timeout: 15000, encoding: 'utf8', windowsHide: true });
  assert.equal(result.stdout.trim(), '');
  assert.equal(result.stderr.trim(), '');
});
