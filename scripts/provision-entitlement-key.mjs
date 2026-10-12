import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Only the public key enters the app. The private PEM stays in ignored data/,
// ready to upload as a platform secret without printing it to a terminal.
export async function provisionEntitlementKey({ root = process.cwd(), keyId = 'v1',
  privateFile = path.join(root, 'data/entitlement-signing-key.pem'),
  configFile = path.join(root, 'desktop/account-config.json') } = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new Error('Invalid entitlement key ID.');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  let pem, created = false;
  try {
    const stat = await lstat(privateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o077)) {
      throw new Error('Private key must be a single private file with mode 600.');
    }
    pem = await readFile(privateFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path.dirname(privateFile), { recursive: true, mode: 0o700 });
    pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(privateFile, pem, { flag: 'wx', mode: 0o600 });
    created = true;
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Only Ed25519 signing keys are accepted.');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const keys = config.entitlementPublicKeys || {};
  if (Object.hasOwn(keys, keyId) && keys[keyId] !== publicKey) throw new Error('Key ID already pins a different public key; use a new key ID for rotation.');
  config.entitlementPublicKeys = { ...keys, [keyId]: publicKey };
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
  return { keyId, privateFile: path.resolve(privateFile), configFile: path.resolve(configFile), created };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--key-id')) throw new Error('Usage: node scripts/provision-entitlement-key.mjs [--key-id v1]');
    console.log(JSON.stringify(await provisionEntitlementKey({ keyId: args[1] || 'v1' })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
