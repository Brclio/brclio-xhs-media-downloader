/** Run with Node: two fresh Electron processes, real OS encryption, mock account API.
 * This verifies process relaunch, not OS reboot, installer upgrades or Windows on macOS.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const script = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
if (!process.versions.electron) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-native-account-'));
  const electronBinary = createRequire(import.meta.url)('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  async function phase(name) {
    await new Promise((resolve, reject) => {
      const child = spawn(electronBinary, [script, name, directory], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Native ${name} timed out; last progress: ${output.slice(-1500) || "none"}. Check native startup or system credential access.`)); }, 45_000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => {
        clearTimeout(timeout);
        if (code === 0) resolve(); else reject(new Error(`Native ${name} failed: ${output.slice(-3000)}`));
      });
    });
  }
  try {
    await phase('write'); await phase('read');
    process.stdout.write(JSON.stringify({ passed: true, platform: process.platform, nativeSafeStorage: true, separateProcessRelaunch: true,
      stableDeviceIdentity: true, serverTransport: 'mock', osRebootTested: false, installerUpgradeTested: false }) + '\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
} else {
  const { app, safeStorage } = await import('electron');
  const { SecureAccountStore } = await import('../desktop/account-storage.js');
  const { AccountClient } = await import('../desktop/account-client.js');
  const phase = process.argv[2], directory = process.argv[3];
  if (!['write', 'read'].includes(phase) || !directory) throw new Error('Expected worker phase and temporary directory');
  await mkdir(path.join(directory, 'user-data'), { recursive: true });
  // Test identity is deliberately isolated from the user's production account and browser cookies.
  app.setName('Brclio Account Storage Verification');
  app.setPath('userData', path.join(directory, 'user-data'));
  process.stderr.write(`Native ${phase}: waiting for Electron ready\n`);
  void app.whenReady().then(async () => {
  process.stderr.write(`Native ${phase}: Electron ready\n`);
  try {
    const store = new SecureAccountStore({ directory: path.join(directory, 'account'), safeStorage });
    if (phase === 'write') {
      process.stderr.write(`Native ${phase}: loading secure store\n`);
      const credentials = await store.load();
      process.stderr.write(`Native ${phase}: secure store loaded\n`);
      credentials.token = `local-test-only-${randomUUID()}`;
      await store.save(credentials);
      const ciphertext = await readFile(store.filename);
      assert.equal(ciphertext.includes(Buffer.from(credentials.token)), false);
      assert.equal(ciphertext.includes(Buffer.from('PRIVATE KEY')), false);
      await writeFile(path.join(directory, 'expected.json'), JSON.stringify({ token: hash(credentials.token),
        key: hash(credentials.privateKey), publicKey: hash(credentials.publicKey), stableIdHash: credentials.stableIdHash }), { mode: 0o600 });
    } else {
      const expected = JSON.parse(await readFile(path.join(directory, 'expected.json'), 'utf8'));
      process.stderr.write(`Native ${phase}: loading secure store\n`);
      const credentials = await store.load();
      process.stderr.write(`Native ${phase}: secure store loaded\n`);
      assert.equal(hash(credentials.token), expected.token); assert.equal(hash(credentials.privateKey), expected.key);
      assert.equal(hash(credentials.publicKey), expected.publicKey); assert.equal(credentials.stableIdHash, expected.stableIdHash);
      const client = new AccountClient({ store, endpoint: 'https://native-test.invalid/api/account', fetchImpl: async (_url, request) => {
        assert.equal(request.headers.Authorization, `Bearer ${credentials.token}`);
        const body = JSON.parse(request.body), { timestamp, nonce, signature } = body.proof;
        assert.equal(verify(null, Buffer.from(`${body.action}\n${timestamp}\n${nonce}\n${JSON.stringify(body.input)}\n${credentials.token}`), credentials.publicKey, Buffer.from(signature, 'base64')), true);
        const serverTime = new Date().toISOString();
        return Response.json({ ok: true, serverTime, account: { user: { id: 'mock-user', email: 'test@example.invalid' },
          membership: { type: 'none', active: false }, device: { status: 'authorized' }, serverTime } });
      } });
      await client.initialize(); await client.refresh();
      assert.equal(client.snapshot().authenticated, true);
      assert.equal(JSON.stringify(client.snapshot()).includes(credentials.token), false);
    }
    app.exit(0);
  } catch (error) { process.stderr.write(`${error.message}\n`); app.exit(1); }
  });
}
