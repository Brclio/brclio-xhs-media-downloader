import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertWindowsApplicationWindows, downloadGithubAsset, fetchGithubWithRetry, findWindowsMainProcess, findWindowsStartupEvidence,
  parseWindowsStartupDiagnostics, windowsProcessQuery } from '../scripts/verify-packaged-windows-update.mjs';

const longPath = String.raw`C:\Users\runneradmin\AppData\Local\Temp\upgrade\安装路径 with spaces\Brclio 小红书下载器.exe`;
const shortPath = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\upgrade\安装路径 with spaces\Brclio 小红书下载器.exe`;

function transportFixture(responses, overrides = {}) {
  let time = 0;
  const calls = [], pauses = [], retries = [];
  return { calls, pauses, retries, options: {
    now: () => time,
    sleep: async milliseconds => { pauses.push(milliseconds); time += milliseconds; },
    fetchImpl: async (_url, options) => {
      calls.push(options);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response() : response;
    },
    onRetry: evidence => retries.push(evidence), ...overrides
  } };
}

test('Windows verifier retries only temporary GitHub HTTP statuses within one deadline', async () => {
  for (const status of [429, 502, 503, 504]) {
    const fixture = transportFixture([new Response('temporary', { status, headers: { 'retry-after': '2' } }), Response.json({ assets: [] })]);
    assert.deepEqual(await fetchGithubWithRetry('https://fixture.invalid/release', fixture.options), { assets: [] });
    assert.equal(fixture.calls.length, 2);
    assert.deepEqual(fixture.pauses, [2000]);
    assert.notEqual(fixture.calls[0].signal, fixture.calls[1].signal);
  }
  const fixture = transportFixture([new Response('temporary', { status: 429, headers: { 'retry-after': '31' } })]);
  await assert.rejects(fetchGithubWithRetry('https://fixture.invalid/release', fixture.options), /HTTP 429/);
  assert.equal(fixture.calls.length, 1, 'Retry-After cannot extend the original 30 second deadline');
  assert.deepEqual(fixture.pauses, []);
});

test('Windows verifier does not retry permanent HTTP failures, invalid metadata or filesystem errors', async () => {
  for (const response of [new Response('denied', { status: 401 }), new Response('missing', { status: 404 }),
    new Response('error', { status: 500 }), new Response('invalid json', { status: 200 }), Object.assign(new Error('disk failure'), { code: 'ENOSPC' })]) {
    const fixture = transportFixture([response]);
    await assert.rejects(fetchGithubWithRetry('https://fixture.invalid/release', fixture.options));
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.pauses, []);
  }
});

test('Windows verifier bounds network failures by both attempt count and original deadline', async () => {
  const network = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const fixture = transportFixture(Array.from({ length: 4 }, network));
  await assert.rejects(fetchGithubWithRetry('https://fixture.invalid/release', fixture.options), /fetch failed/);
  assert.equal(fixture.calls.length, 4);
  assert.deepEqual(fixture.pauses, [1000, 2000, 4000]);
  const expired = transportFixture([network(), network()], { timeoutMs: 2500 });
  await assert.rejects(fetchGithubWithRetry('https://fixture.invalid/release', expired.options), /fetch failed/);
  assert.equal(expired.calls.length, 2);
  assert.deepEqual(expired.pauses, [1000]);
});

test('Windows verifier replaces interrupted downloads with a fresh verified asset and keeps integrity failures terminal', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'brclio-windows-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('complete public installer fixture');
  const asset = { browser_download_url: 'https://fixture.invalid/setup.exe', size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  const interrupted = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Uint8Array.from([1, 2, 3])); },
    pull(controller) { controller.error(new TypeError('terminated')); }
  }));
  const fixture = transportFixture([interrupted, new Response(bytes)]);
  const target = path.join(directory, 'setup.exe');
  assert.equal(await downloadGithubAsset(asset, target, fixture.options), target);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(fixture.calls.length, 2);

  for (const invalidAsset of [{ ...asset, size: bytes.length + 1 }, { ...asset, digest: `sha256:${'0'.repeat(64)}` }]) {
    const invalid = transportFixture([new Response(bytes)]);
    const failed = path.join(directory, 'failed.exe');
    await assert.rejects(downloadGithubAsset(invalidAsset, failed, invalid.options), /must match public release metadata/);
    assert.equal(invalid.calls.length, 1);
    await assert.rejects(readFile(failed), { code: 'ENOENT' });
  }
  await writeFile(target, 'existing installer');
  const existing = transportFixture([new Response(bytes)]);
  await assert.rejects(downloadGithubAsset(asset, target, existing.options), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'existing installer');
});

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
