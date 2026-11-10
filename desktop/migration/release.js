import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export async function verifyInstaller(file, asset) {
  const stat = await lstat(file);
  if (!stat.isFile() || path.basename(file) !== asset.name || stat.size !== asset.size) {
    throw new Error('内置的 Brclio 安装包缺失或大小不匹配，请重新下载迁移版。');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('安装包已被其他程序替换。');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest('hex') !== asset.sha256) throw new Error('Brclio 安装包 SHA-256 校验失败，请重新下载迁移版。');
  } finally {
    await handle.close();
  }
}
