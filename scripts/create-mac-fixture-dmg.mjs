// Only builds an isolated updater-test image. Release installers and the actual
// updater still pass their own signature, checksum, mounting and launch checks.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, lstat, mkdtemp, rm, statfs } from 'node:fs/promises';
import { freemem, loadavg, totalmem } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const RETRY_DELAYS = [1000, 3000];
const outputTail = value => String(value || '').slice(-16000);

async function resources(source, directory) {
  const filesystem = await statfs(directory).then(value => ({
    availableBytes: value.bavail * value.bsize, freeBytes: value.bfree * value.bsize,
    freeInodes: value.ffree,
  })).catch(error => ({ error: error.message }));
  const payload = await execute('/usr/bin/du', ['-sk', source], { timeout: 10000, maxBuffer: 16384 })
    .then(({ stdout }) => ({ allocatedKiB: Number.parseInt(stdout, 10) }))
    .catch(error => ({ error: error.message }));
  return { filesystem, payload, memory: { freeBytes: freemem(), totalBytes: totalmem() }, loadAverage: loadavg() };
}

export async function createMacFixtureDmg({ source, destination, volumeName = 'Packaged Update Fixture' }, {
  command = execute, sleep = delay, diagnose = resources,
  report = value => console.warn(JSON.stringify(value)),
} = {}) {
  const directory = path.dirname(destination);
  assert.ok((await lstat(source)).isDirectory(), 'Fixture payload must be a directory');
  try {
    await lstat(destination);
    throw new Error(`Refusing to replace an existing fixture image: ${destination}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const failures = [];
  const maxAttempts = RETRY_DELAYS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A failed create can leave a partial image. Keep every attempt outside the
    // payload and in its own directory so it cannot contaminate the next image.
    const temporary = await mkdtemp(path.join(directory, '.fixture-dmg-'));
    const candidate = path.join(temporary, 'candidate.dmg');
    let phase = 'create';
    try {
      // Do not use -quiet: DiskImages errors otherwise vanish from CI output.
      await command('/usr/bin/hdiutil', ['create', '-verbose', '-volname', volumeName,
        '-srcfolder', source, '-format', 'UDZO', candidate], { timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
      phase = 'verify';
      assert.ok((await lstat(candidate)).size > 0, 'Fixture image is empty');
      await command('/usr/bin/hdiutil', ['verify', candidate], { timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
      phase = 'publish';
      // Hard-link within the same temporary filesystem: no extra full image copy
      // and no overwrite if a destination unexpectedly appeared in the meantime.
      await link(candidate, destination);
      return { attempts: attempt, verified: true };
    } catch (error) {
      const diagnostic = { attempt, phase, code: error.code ?? null, signal: error.signal ?? null,
        killed: Boolean(error.killed), message: error.message,
        stdout: outputTail(error.stdout), stderr: outputTail(error.stderr),
        resources: await diagnose(source, directory).catch(problem => ({ error: problem.message })) };
      failures.push(diagnostic);
      report({ fixtureDmgFailure: diagnostic, maxAttempts });
      // File publication failures are not DiskImages transients; in particular,
      // never replace another file or accept an unverified/partial image.
      if (phase === 'publish' || attempt === maxAttempts) {
        throw new Error(`Fixture DMG ${phase} failed after ${attempt} attempt(s): ${JSON.stringify(failures)}`, { cause: error });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    await sleep(RETRY_DELAYS[attempt - 1]);
  }
}
