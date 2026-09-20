import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Only this allowlist becomes public static content. Vercel builds /api
// functions separately and traces their server-side imports.
export const PUBLIC_FILES = [
  'index.html', 'changelog.html', 'app.js', 'style.css', 'changelog.css',
  'support.css', 'visit-counter.js', 'visit-counter.css', 'favicon.svg', 'aiyc.svg',
  'desktop-ui.js', 'desktop-ui.css', 'account-ui.js', 'account-ui.css',
  'lib/archive.js', 'lib/clipboard.js', 'lib/media-tracks.js', 'assets', 'admin'
];

export async function buildWeb(root = fileURLToPath(new URL('../', import.meta.url))) {
  const output = path.join(root, 'dist-web');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const name of PUBLIC_FILES) {
    await mkdir(path.dirname(path.join(output, name)), { recursive: true });
    await cp(path.join(root, name), path.join(output, name), { recursive: true, dereference: false });
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Public web output: ${await buildWeb()}`);
}
