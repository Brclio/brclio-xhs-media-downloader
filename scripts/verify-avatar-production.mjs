// Read-only production verification. Never logs in, uploads or changes an account.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const origin = process.argv[2] || 'https://xhs.download.brclio.com';
const sourceSha = process.argv[3] || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const output = process.argv[4];
assert.equal(new URL(origin).origin, origin); assert.match(origin, /^https:\/\//); assert.match(sourceSha, /^[a-f\d]{40}$/);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const request = (name, options = {}) => fetch(new URL(name, origin), { redirect: 'error', signal: AbortSignal.timeout(30_000), ...options });
const healthResponse = await request('/api/health');
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.version, pkg.version); assert.equal(health.platform, 'cloudflare');
assert.equal(health.avatars?.builtinCount, 100); assert.equal(health.avatars?.customUploads, true); assert.equal(health.avatars?.maxOriginalBytes, 104857600);
const manifestResponse = await request('/assets/avatars/manifest.json'); assert.equal(manifestResponse.status, 200);
const manifest = await manifestResponse.json();
assert.deepEqual(manifest, JSON.parse(await readFile(path.join(root, 'assets/avatars/manifest.json'), 'utf8')));
assert.equal(manifest.length, 100);
const names = ['avatar-ui.js', 'account-ui.js', 'account-ui.css', 'desktop-ui.js', 'desktop-ui.css',
  'lib/avatar-client.js', 'lib/account-avatar-transfer.js', 'lib/browser-account.js', 'admin/admin.js', 'admin/admin.css', 'admin/index.html',
  'assets/avatars/manifest.json', ...manifest.map(item => `assets/avatars/${item.id}.webp`)];
const assets = new Array(names.length); let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  for (;;) {
    const index = next++; if (index >= names.length) return;
    const name = names[index]; const response = await request(`/${name}`); assert.equal(response.status, 200, name);
    const bytes = Buffer.from(await response.arrayBuffer()); const local = await readFile(path.join(root, 'dist-web', name));
    assert.equal(hash(bytes), hash(local), name);
    assets[index] = { path: name, status: response.status, bytes: bytes.length, sha256: hash(bytes), matchesBuild: true };
  }
}));
assert.equal(new Set(assets.filter(asset => asset.path.endsWith('.webp')).map(asset => asset.sha256)).size, 100);
const unauthenticated = [];
for (const action of ['avatar-select', 'admin-avatar-list']) {
  const response = await request('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ action, input: action === 'avatar-select' ? { client: 'browser', builtinId: 'avatar-001', expectedUserId: 'anonymous' } : { limit: 20 } }) });
  assert.equal(response.status, 401, action); const result = await response.json(); assert.equal(result.ok, false);
  unauthenticated.push({ action, status: response.status, errorCode: result.error?.code });
}
const binaryBoundaries = [];
for (const [query, expected] of [['action=original&token=invalid', 403], ['action=thumbnail&id=invalid', 404],
  ['action=thumbnail&id=00000000-0000-0000-0000-000000000000', 404]]) {
  const response = await request(`/api/account_avatar?${query}`); assert.equal(response.status, expected, query);
  assert.match(response.headers.get('cache-control'), /no-store/); binaryBoundaries.push({ query, status: response.status });
}
const result = { schemaVersion: 1, version: pkg.version, sourceSha, verifiedAt: new Date().toISOString(), origin,
  health, builtinCount: 100, distinctCompressedAssets: 100, assets, unauthenticated, binaryBoundaries,
  authenticatedProductionUpload: false, accountWrites: false,
  uploadValidation: 'Real local Workerd integration covers the complete 100MiB original, private persistence, exact SHA-256 retrieval and compression.' };
if (output) await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ result: 'PASS', origin, version: pkg.version, deploymentId: health.deploymentId, assets: assets.length, builtinCount: 100, accountWrites: false, output }));
