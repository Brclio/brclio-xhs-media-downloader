import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyInstaller } from './release.js';

const execute = promisify(execFile);

// Keep the installation and registry checks in sync with the official Brclio
// downloader's lite/brclio-windows.ps1. Read as text since it lives in app.asar.
export async function migrateWindows({ installer, asset, version, arch }) {
  if (process.platform !== 'win32' || arch !== 'x64') throw new Error('迁移安装包仅支持 Windows x64。');
  const script = await readFile(new URL('./brclio-windows.ps1', import.meta.url), 'utf8');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = { ...process.env, BRCLIO_LITE_VERSION: version, BRCLIO_LITE_FILE: installer };
  for (const name of Object.keys(env)) {
    if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|PSModulePath|PORTABLE_EXECUTABLE_.*)$/i.test(name)) delete env[name];
  }
  const run = async action => {
    const { stdout } = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...env, BRCLIO_LITE_ACTION: action }, timeout: 900000, windowsHide: true, encoding: 'utf8'
    }).catch(error => {
      throw new Error(error.stderr?.trim() || '无法执行 Brclio 的 Windows 安装程序。', { cause: error });
    });
    return stdout.trim();
  };
  // Also handle a newer version installed while we were validating the package.
  // The installation script reads the registry again just before launching NSIS.
  const installed = await run('version');
  const numeric = new Intl.Collator('en', { numeric: true });
  if (installed && numeric.compare(installed, version) >= 0) {
    await run('open');
    return;
  }
  await verifyInstaller(installer, asset);
  await run('install');
}
