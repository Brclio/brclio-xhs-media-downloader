/** Run with Node: two fresh Electron processes, real OS encryption, mock account API.
 * This verifies process relaunch, not OS reboot, installer upgrades or Windows on macOS.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
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
    const signing = generateKeyPairSync('ed25519');
    await writeFile(path.join(directory, 'fixture-signing-private.pem'), signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(directory, 'fixture-signing-public.pem'), signing.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    await phase('write'); await phase('read');
    process.stdout.write(JSON.stringify({ passed: true, platform: process.platform, nativeSafeStorage: true, separateProcessRelaunch: true,
      stableDeviceIdentity: true, signedEntitlements: true, offlineSignedRelaunch: true,
      backgroundFailureTolerated: true, authoritativeInvalidationPersisted: true, legacyAccountUpgrade: true,
      serverTransport: 'mock', osRebootTested: false, installerUpgradeTested: false }) + '\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
} else {
  const { app, safeStorage } = await import('electron');
  const { SecureAccountStore } = await import('../desktop/account-storage.js');
  const { AccountClient } = await import('../desktop/account-client.js');
  const { issueEntitlement } = await import('../lib/entitlement.js');
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
    const fixturePublicKey = await readFile(path.join(directory, 'fixture-signing-public.pem'), 'utf8');
    const features = ['profile-download', 'watermark-free-video'];
    const account = () => ({ user: { id: 'mock-user', email: 'test@example.invalid' },
      membership: { type: 'permanent', active: true }, device: { id: 'mock-device', status: 'authorized' } });
    if (phase === 'write') {
      process.stderr.write(`Native ${phase}: loading secure store\n`);
      const credentials = await store.load();
      process.stderr.write(`Native ${phase}: secure store loaded\n`);
      credentials.token = `local-test-only-${randomUUID()}`;
      await store.save(credentials);
      // Start from the original v1 credential shape used by 2.0.7. Adding
      // signed receipts must preserve the existing token, keys and device.
      assert.equal(credentials.entitlements, undefined);
      const fixturePrivateKey = await readFile(path.join(directory, 'fixture-signing-private.pem'), 'utf8');
      const client = new AccountClient({ store, endpoint: 'https://native-test.invalid/api/account',
        entitlementPublicKeys: { 'native-fixture': fixturePublicKey },
        fetchImpl: async (_url, request) => {
          assert.ok(request.headers.Authorization === `Bearer ${credentials.token}`, 'The legacy fixture session must be preserved');
          const body = JSON.parse(request.body), { timestamp, nonce, signature } = body.proof;
          assert.equal(verify(null, Buffer.from(`${body.action}\n${timestamp}\n${nonce}\n${JSON.stringify(body.input)}\n${credentials.token}`), credentials.publicKey, Buffer.from(signature, 'base64')), true);
          assert.equal(body.action, 'authorize');
          return Response.json({ ok: true, authorized: true, account: account(),
            entitlement: issueEntitlement({ privateKey: fixturePrivateKey, keyId: 'native-fixture', token: credentials.token,
              publicKey: credentials.publicKey, userId: 'mock-user', deviceId: 'mock-device', feature: body.input.feature,
              requestNonce: nonce, now: Date.now() }) });
        } });
      await client.initialize();
      for (const feature of features) await client.authorize(feature, { forceRemote: true });
      const upgraded = await store.load();
      assert.equal(hash(upgraded.token), hash(credentials.token));
      assert.equal(hash(upgraded.privateKey), hash(credentials.privateKey));
      const ciphertext = await readFile(store.filename);
      assert.equal(ciphertext.includes(Buffer.from(credentials.token)), false);
      assert.equal(ciphertext.includes(Buffer.from('PRIVATE KEY')), false);
      for (const feature of features) {
        assert.equal(ciphertext.includes(Buffer.from(upgraded.entitlements[feature].entitlement.payload)), false);
        assert.equal(ciphertext.includes(Buffer.from(upgraded.entitlements[feature].entitlement.signature)), false);
      }
      await writeFile(path.join(directory, 'expected.json'), JSON.stringify({ token: hash(credentials.token),
        key: hash(credentials.privateKey), publicKey: hash(credentials.publicKey), stableIdHash: credentials.stableIdHash,
        grants: Object.fromEntries(features.map(feature => [feature, hash(JSON.stringify(upgraded.entitlements[feature].entitlement))])) }), { mode: 0o600 });
    } else {
      const expected = JSON.parse(await readFile(path.join(directory, 'expected.json'), 'utf8'));
      process.stderr.write(`Native ${phase}: loading secure store\n`);
      const credentials = await store.load();
      process.stderr.write(`Native ${phase}: secure store loaded\n`);
      assert.equal(hash(credentials.token), expected.token); assert.equal(hash(credentials.privateKey), expected.key);
      assert.equal(hash(credentials.publicKey), expected.publicKey); assert.equal(credentials.stableIdHash, expected.stableIdHash);
      for (const feature of features) assert.equal(hash(JSON.stringify(credentials.entitlements[feature].entitlement)), expected.grants[feature]);
      let requests = 0, revoked = false;
      const client = new AccountClient({ store, endpoint: 'https://native-test.invalid/api/account',
        entitlementPublicKeys: { 'native-fixture': fixturePublicKey }, sleep: async () => {},
        fetchImpl: async (_url, request) => {
          requests++;
          const body = JSON.parse(request.body);
          assert.ok(request.headers.Authorization === `Bearer ${credentials.token}`, 'Restored signed grants must keep the fixture session');
          const { timestamp, nonce, signature } = body.proof;
          assert.equal(verify(null, Buffer.from(`${body.action}\n${timestamp}\n${nonce}\n${JSON.stringify(body.input)}\n${credentials.token}`), credentials.publicKey, Buffer.from(signature, 'base64')), true);
          if (revoked) return Response.json({ ok: false, error: { code: 'DEVICE_REVOKED', message: 'Fixture device revoked' } }, { status: 403 });
          throw new Error('Isolated fixture offline');
        } });
      await client.initialize();
      for (const feature of features) {
        assert.equal(client.checkLocalAuthorization(feature).authorized, true);
        assert.equal((await client.authorize(feature)).authorized, true);
      }
      assert.equal(requests, 0, 'Restored signed grants must authorize without account transport');
      await assert.rejects(client.refresh(), { code: 'SERVICE_UNAVAILABLE' });
      assert.equal(client.snapshot().status, 'service_unavailable');
      const synchronized = await client.syncEntitlements();
      assert.ok(synchronized.every(result => result.status === 'fulfilled'));
      assert.equal(requests, 7, 'One me request and three bounded remote attempts per used feature');
      assert.equal(client.snapshot().status, 'ready', 'Valid signed fallback keeps membership usable');
      assert.equal(client.snapshot().authenticated, true);
      assert.equal(JSON.stringify(client.snapshot()).includes(credentials.token), false);
      revoked = true;
      await assert.rejects(client.authorize(features[0], { forceRemote: true }), { code: 'DEVICE_REVOKED' });
      for (const feature of features) assert.throws(() => client.checkLocalAuthorization(feature), { code: 'ENTITLEMENT_INVALID' });
      const invalidated = await store.load();
      assert.equal(Object.keys(invalidated.entitlements).length, 0);
      assert.equal(hash(invalidated.token), expected.token);
      assert.equal(hash(invalidated.privateKey), expected.key);
      assert.ok(features.every(feature => invalidated.signedAuthorizationUsed.includes(feature)));
    }
    app.exit(0);
  } catch (error) { process.stderr.write(`${error.message}\n`); app.exit(1); }
  });
}
