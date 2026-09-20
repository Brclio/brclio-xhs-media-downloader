import { writeFile } from 'node:fs/promises';

const value = process.argv[2] || process.env.XHS_AUTH_ENDPOINT;
if (!value) throw new Error('Usage: node scripts/configure-account-endpoint.mjs https://YOUR_DOMAIN/api/account');
const url = new URL(value);
if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/api/account') {
  throw new Error('Use the HTTPS authorization URL ending in /api/account, without credentials or query parameters.');
}
await writeFile(new URL('../desktop/account-config.json', import.meta.url), JSON.stringify({ endpoint: url.href }, null, 2) + '\n');
console.log('Configured public account endpoint. Rebuild desktop installers to apply.');
