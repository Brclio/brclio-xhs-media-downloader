import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

/** Launch an already checksum-verified NSIS installer. The installer waits for
 * this process to finish saving its state, then reopens the installed app only
 * after successful installation. No command shell or extra runtime is needed.
 */
export async function launchWindowsUpdate(installerPath, { parentPid = process.pid } = {}, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'win32') {
    throw Object.assign(new Error('此安装方式仅适用于 Windows。'), { code: 'WINDOWS_UPDATE_PLATFORM' });
  }
  if (typeof installerPath !== 'string' || !path.isAbsolute(installerPath)
    || !installerPath.toLowerCase().endsWith('.exe') || /[\0\r\n]/.test(installerPath)
    || !Number.isSafeInteger(parentPid) || parentPid <= 1) {
    throw Object.assign(new Error('安装包路径或应用进程信息无效，请重新检查更新。'), { code: 'WINDOWS_UPDATE_INPUT' });
  }
  const stat = await lstat(installerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('安装包不是完整文件，请重新下载。'), { code: 'WINDOWS_UPDATE_INPUT' });
  }
  const start = dependencies.spawn || spawn;
  const child = start(installerPath, ['--updated', '--force-run', `--brclio-update-parent=${parentPid}`], {
    detached: true, stdio: 'ignore', windowsHide: false, shell: false
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
}
