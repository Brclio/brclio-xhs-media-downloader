// The launcher remains alive until Electron exits and its temporary private
// data is removed. Cleanup failures are failures of the verification command.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const output = await mkdtemp(path.join(os.tmpdir(), 'brclio-real-preload-retry-ui-'));
const token = randomUUID();
await writeFile(path.join(output, 'run.json'), JSON.stringify({
  kind: 'brclio-update-retry-verification', token, startedAt: new Date().toISOString()
}, null, 2));
const args = process.argv.slice(2);
const live = args.includes('--live');
const harness = fileURLToPath(new URL('./verify-update-retry-ui.cjs', import.meta.url));
const cleanupReport = path.join(output, 'cleanup.json');
let child, deadline, forceExit, interrupted, launchError;
let childResult = { code: 1, signal: null };

function stop(reason) {
  if (interrupted) return;
  interrupted = reason;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  // Allow the genuine manager and owned proxy to shut down before a hard stop.
  if (child.connected) child.send({ type: 'verification:shutdown', reason }, error => {
    if (error && child.exitCode === null && child.signalCode === null) child.kill();
  });
  else child.kill();
  forceExit = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 20000);
}
const onInterrupt = () => stop('Verification interrupted');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);

try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [harness, '--verification-output', output,
    '--verification-token', token, ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env, windowsHide: true });
  // The child has its own 90-second offline / 60-minute live scenario budget.
  // This outer bound also covers a stuck shutdown without skipping cleanup.
  deadline = setTimeout(() => stop('Electron verification exceeded its launcher deadline'), live ? 3630000 : 120000);
  childResult = await new Promise(resolve => {
    child.once('error', error => { launchError = error.message; });
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
} catch (error) {
  launchError = error.message;
} finally {
  clearTimeout(deadline); clearTimeout(forceExit);
}

// Chromium has fully exited, so neither a held profile lock nor shutdown writes
// can race this cleanup. Screenshots, network diagnostics and reports remain.
const cleanupErrors = [], privateDataRemoved = [];
for (const name of ['profile', 'updates']) {
  try {
    await rm(path.join(output, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    privateDataRemoved.push(name);
  } catch (error) { cleanupErrors.push(`${name}: ${error.message}`); }
}
await writeFile(cleanupReport, JSON.stringify({ status: cleanupErrors.length ? 'failed' : 'complete',
  privateDataRemoved, errors: cleanupErrors, electronExit: childResult }, null, 2));

let report;
for (const name of ['verification.json', 'failure.json']) {
  try { report = JSON.parse(await readFile(path.join(output, name), 'utf8')); break; }
  catch (error) { if (error.code !== 'ENOENT') launchError ||= `Invalid ${name}: ${error.message}`; }
}
const passed = childResult.code === 0 && report?.status === 'passed' && !launchError && !interrupted && !cleanupErrors.length;
const metadata = path.join(output, passed ? 'verification.json' : 'failure.json');
await writeFile(metadata, JSON.stringify({ ...report, status: passed ? 'passed' : 'failed', live,
  launcherError: launchError || interrupted || (!report ? 'Electron exited without a verification report' : null),
  electronExit: childResult, cleanupReport, cleanupErrors }, null, 2));
console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', live, metadata,
  screenshots: report?.screenshots || {}, cleanupReport, networkAfter: report?.networkAfter }));
process.removeListener('SIGINT', onInterrupt);
process.removeListener('SIGTERM', onInterrupt);
process.exitCode = passed && !interrupted ? 0 : 1;
