import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertWindowsApplicationWindows, findWindowsMainProcess, findWindowsStartupEvidence,
  parseWindowsStartupDiagnostics, windowsProcessQuery } from '../scripts/verify-packaged-windows-update.mjs';

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

test('Windows automatic relaunch requires current process renderer readiness rather than a visible window or an earlier app launch', () => {
  const startedAfter = Date.parse('2026-10-01T11:33:00Z');
  const ready = { at: '2026-10-01T11:33:46Z', event: 'app.desktop_ready', details: {
    pid: 7676, version: '1.8.25', platform: 'win32', arch: 'x64', pythonAvailable: true, portable: false
  } };
  const expected = { pid: 7676, version: '1.8.25', startedAfter };
  assert.equal(findWindowsStartupEvidence([{ ...ready, event: 'app.started' }], expected), undefined);
  assert.equal(findWindowsStartupEvidence([{ ...ready, at: '2026-10-01T11:32:46Z' }], expected), undefined);
  for (const [key, value] of Object.entries({ pid: 2312, version: '1.8.17', platform: 'darwin', arch: 'arm64', pythonAvailable: false, portable: true })) {
    assert.equal(findWindowsStartupEvidence([{ ...ready, details: { ...ready.details, [key]: value } }], expected), undefined, key);
  }
  assert.equal(findWindowsStartupEvidence([ready], expected), ready);
});

test('Windows native startup diagnostics tolerate only an incomplete final append', () => {
  const entry = { event: 'app.started', details: { version: '1.8.25' } };
  const complete = `${JSON.stringify(entry)}\r\n`;
  assert.deepEqual(parseWindowsStartupDiagnostics(complete + '{"event":'), [entry]);
  assert.deepEqual(parseWindowsStartupDiagnostics(complete), [entry]);
  assert.throws(() => parseWindowsStartupDiagnostics(complete + 'malformed\n'), SyntaxError);
});

test('Windows upgrade verifier preserves and fails unknown native error dialogs before any close request', () => {
  const main = { ProcessId: 7676, Title: 'Brclio 小红书下载器', ClassName: 'Chrome_WidgetWin_1', Controls: [] };
  const error = { ProcessId: 7676, Title: 'Error', ClassName: '#32770', Controls: [
    { Title: 'ERR_FAILED (-2) loading xhs-app://local/', ClassName: 'Static' }, { Title: 'OK', ClassName: 'Button' }
  ] };
  assertWindowsApplicationWindows([main], 7676, main.Title);
  assertWindowsApplicationWindows([], 7676, main.Title, { requireMain: false });
  assert.throws(() => assertWindowsApplicationWindows([], 7676, main.Title), /must be visible/);
  for (const options of [{}, { requireMain: false }]) {
    assert.throws(() => assertWindowsApplicationWindows([main, error], 7676, main.Title, options), /Unexpected application window.*ERR_FAILED/);
  }
  // The installer has a separate PID and never becomes an application target.
  assertWindowsApplicationWindows([main, { ...error, ProcessId: 8132 }], 7676, main.Title);
});

test('Windows PowerShell process polling succeeds when the expected PID has exited', { skip: process.platform !== 'win32' }, async () => {
  // Windows process IDs are multiples of four; this odd PID cannot be alive.
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; $p = ${windowsProcessQuery}; if ($p) { throw 'Unexpected process' }`],
  { env: { ...process.env, VERIFY_PID: '2147483647' }, timeout: 15000, encoding: 'utf8', windowsHide: true });
  assert.equal(result.stdout.trim(), '');
  assert.equal(result.stderr.trim(), '');
});
