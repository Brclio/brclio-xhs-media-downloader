import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstaller } from '../desktop/migration/release.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const release = JSON.parse(await readFile(new URL('../desktop/migration/release.json', import.meta.url)));
const platform = process.platform;
const arch = process.argv[2] || process.arch;
const asset = release.assets[platform + '-' + arch];
if (!asset) throw new Error('迁移版请使用 macOS arm64/x64 或 Windows x64 构建。');
const os = platform === 'darwin' ? 'mac' : 'win';
const resources = path.join(root, 'desktop-runtime', 'migration', os + '-' + arch);
const installer = path.join(resources, asset.name);
await mkdir(resources, { recursive: true });
try {
  await verifyInstaller(installer, asset);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  execFileSync('gh', ['release', 'download', 'v' + release.version, '--repo', 'Brclio/Brclio',
    '--pattern', asset.name, '--dir', resources], { stdio: 'inherit' });
  await verifyInstaller(installer, asset);
}

const builder = require.resolve('electron-builder/cli.js');
execFileSync(process.execPath, [builder, '--config', 'desktop/migration-builder.cjs', '--' + os, '--' + arch,
  '--publish', 'never'], { cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
