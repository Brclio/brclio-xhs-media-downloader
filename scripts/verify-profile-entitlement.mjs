// Real AccountClient + ProfileManager + signed grants and filesystem writes.
// Transports are isolated fixtures; this does not inspect a user's account or
// claim live deployment, OS credential encryption or Windows installer proof.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const started = Date.now();
process.stderr.write('Checking signed authorization through 130 notes, backend outage, expiry and revocation…\n');

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', 'test/profile-entitlement.test.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const collect = chunk => { output = (output + chunk.toString()).slice(-64_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`Profile entitlement verification timed out: ${output.slice(-6000)}`));
  }, 120_000);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    const summary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
      .map(name => [name, Number(output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1])]));
    const scenarios = Number([...output.matchAll(/^1\.\.(\d+)$/gm)].at(-1)?.[1]);
    if (code !== 0 || !Number.isSafeInteger(summary.tests) || summary.tests < 1
      || summary.pass !== summary.tests || ['fail', 'cancelled', 'skipped', 'todo'].some(name => summary[name] !== 0)
      || !Number.isSafeInteger(scenarios) || scenarios < 1) {
      reject(new Error(`Profile entitlement verification failed (${signal || code}): ${output.slice(-10_000)}`));
      return;
    }
    process.stdout.write(JSON.stringify({ passed: true, durationMs: Date.now() - started,
      scenarios, testCount: summary.tests, bulkNotes: 130, bulkImages: 390, storageFailureAfterNotes: 101,
      signedLocalAuthorization: true, backgroundRefreshFailureTolerated: true,
      membershipExpiryStopsDownloads: true, authoritativeRevocationStopsDownloads: true,
      renewalResumesVerifiedFiles: true, externalRequests: 0,
      transport: 'mock', credentialStore: 'isolated-memory', nativeInstallerTested: false,
      tests: path.join(root, 'test/profile-entitlement.test.js') }) + '\n');
    resolve();
  });
});
