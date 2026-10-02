import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';

test('desktop core lease terminates its child and removes private config when the application crashes', { skip: process.platform === 'win32' }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'brclio-proxy-lease-'));
  const privateDirectory = path.join(temporary, 'private'); await mkdir(privateDirectory);
  const fakeCore = path.join(temporary, 'fake-core');
  const ownerScript = path.join(temporary, 'owner.cjs');
  const identities = path.join(temporary, 'identities.json');
  const supervisor = fileURLToPath(new URL('../desktop/proxy-core-supervisor.cjs', import.meta.url));
  await writeFile(path.join(privateDirectory, 'config.json'), '{}');
  await writeFile(fakeCore, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(require('node:path').join(process.argv[process.argv.indexOf('-d') + 1], 'core.pid'), String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  await chmod(fakeCore, 0o755);
  await writeFile(ownerScript, `const { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, ${JSON.stringify([supervisor, fakeCore, privateDirectory, path.join(privateDirectory, 'config.json')])}, { stdio: ['pipe', 'ignore', 'ignore'] });\nrequire('node:fs').writeFileSync(${JSON.stringify(identities)}, JSON.stringify({ supervisor: child.pid }));\nsetInterval(() => {}, 1000);\n`);
  const owner = spawn(process.execPath, [ownerScript], { stdio: 'ignore' });
  let supervisorPid, corePid;
  const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 2) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => {
    for (const pid of [owner.pid, supervisorPid, corePid]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      supervisorPid = JSON.parse(await readFile(identities, 'utf8')).supervisor;
      corePid = Number(await readFile(path.join(privateDirectory, 'core.pid'), 'utf8'));
      if (alive(corePid)) break;
    } catch { /* owner and supervised core are still starting */ }
    await delay(20);
  }
  assert.ok(alive(corePid), 'The supervised core must actually run before testing owner death');
  owner.kill('SIGKILL');
  const stopped = Date.now() + 5000;
  while (Date.now() < stopped && (alive(supervisorPid) || alive(corePid))) await delay(20);
  assert.equal(alive(corePid), false, 'A hard application crash must stop the core');
  assert.equal(alive(supervisorPid), false, 'The lifetime supervisor must also exit');
  await assert.rejects(readFile(path.join(privateDirectory, 'config.json')), { code: 'ENOENT' });
});
