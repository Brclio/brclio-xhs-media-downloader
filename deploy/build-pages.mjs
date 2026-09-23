import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildWeb } from './build-web.mjs';

export async function buildPages(root = fileURLToPath(new URL('../', import.meta.url))) {
  const source = await buildWeb(root);
  const gateway = path.join(root, 'cloudflare/pages');
  const output = path.join(gateway, 'dist');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(source, output, { recursive: true, dereference: false });
  for (const name of ['_worker.js', '_routes.json']) {
    await cp(path.join(gateway, name), path.join(output, name));
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Cloudflare Pages output: ${await buildPages()}`);
}
