import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APP_ID = 'cn.bornforthis.xhs-downloader';
const version = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value : null;
const outcomes = {
  cleanup_failed: ['该次安装的临时旧版文件尚未清理。', '恢复记录已保留，应用启动时会继续尝试清理；无需因此重复安装。'],
  rolled_back: ['该次安装未完成，安装器已恢复当时的旧应用。', '如仍需升级，可下载完整 DMG，退出应用后覆盖安装。'],
  startup_unconfirmed: ['该次安装没有确认应用成功启动，恢复记录已保留。', '请以当前运行版本为准；如仍需升级，可使用完整 DMG 安装。'],
  rollback_failed: ['该次安装的自动恢复未完成，旧应用备份已保留。', '请通过“问题反馈”提供诊断日志以协助恢复，保留原有备份。'],
  rollback_blocked: ['该次安装因应用位置发生变化而停止恢复，旧应用备份已保留。', '请通过“问题反馈”提供诊断日志以协助恢复，保留原有备份。'],
  helper_failed: ['该次安装助手遇到错误，恢复记录已保留。', '如仍需升级，可使用完整 DMG；也可通过“问题反馈”提供诊断日志。'],
  parent_timeout: ['该次安装因旧应用未退出而取消。', '如仍需升级，请先结束下载任务，再重新安装更新。'],
  current_changed: ['该次安装因当前应用发生变化而取消。', '请重新检查更新，或使用完整 DMG 安装。'],
  candidate_invalid: ['该次安装的应用校验未通过，已停止替换。', '请重新下载安装包。'],
  backup_exists: ['该次安装因备份位置被占用而取消。', '请通过“问题反馈”提供诊断日志，保留原有备份。'],
  replace_failed: ['该次安装未能替换应用。', '如仍需升级，可退出应用后使用完整 DMG 安装。'],
  install_locked: ['该次安装因另一个安装助手正在运行而取消。', '请等待已有安装结束，再检查更新。'],
  readiness_timeout: ['该次安装未收到安装批准，已取消替换。', '如仍需升级，请重新安装更新。'],
};

async function readJson(filename) {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16000) throw Object.assign(new Error('Invalid update history file'), { code: 'INVALID_HISTORY' });
    const buffer = Buffer.alloc(16001);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16000) throw Object.assign(new Error('Update history file too large'), { code: 'INVALID_HISTORY' });
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}

// Notification state is separate from the install journal and shared pointer.
// Reading/dismissing an old result must never delete a newer install's pointer,
// change its progress, acknowledge startup or remove a recovery backup.
export class MacUpdateHistory {
  constructor({ cacheDirectory, currentAppPath, currentVersion, onUpdate = () => {} }, dependencies = {}) {
    Object.assign(this, { cacheDirectory, currentAppPath, currentVersion, onUpdate });
    this.readJson = dependencies.readJson || readJson;
    this.notice = null;
    this.queue = Promise.resolve();
  }

  snapshot() { return this.notice ? { ...this.notice } : null; }
  serial(callback) {
    const pending = this.queue.then(callback);
    this.queue = pending.catch(() => {});
    return pending;
  }
  refresh() { return this.serial(() => this.readCurrent()); }

  async readAcknowledged(directory) {
    try {
      const record = await this.readJson(path.join(directory, 'mac-install-notices.json'));
      return Array.isArray(record?.ids) ? record.ids.filter(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(-100) : [];
    } catch (error) {
      // A damaged preferences file cannot hide a real rollback failure. It is
      // rewritten only after the user explicitly dismisses a valid notice.
      if (error.code === 'ENOENT' || error.code === 'INVALID_HISTORY' || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  async readCurrent() {
    let notice = null;
    try {
      const directory = await realpath(this.cacheDirectory);
      const pointer = path.join(directory, 'mac-last-install.json');
      const first = await this.readJson(pointer);
      if (typeof first.resultPath !== 'string') return this.publish(null);
      const filename = path.resolve(first.resultPath), relative = path.relative(directory, filename);
      if (!/^mac-install-[a-zA-Z0-9]{6}[\\/]install-result\.json$/.test(relative)) return this.publish(null);
      const parent = path.dirname(filename);
      if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) return this.publish(null);
      const record = await this.readJson(filename);
      if (record.appId !== APP_ID || record.currentAppPath !== await realpath(this.currentAppPath)
        || !Object.hasOwn(outcomes, record.status)) return this.publish(null);
      const acknowledged = await this.readAcknowledged(directory);
      // A new install may have replaced the pointer while its predecessor was
      // being read. Ignore that stale result; no write is made to either file.
      if ((await this.readJson(pointer)).resultPath !== first.resultPath) return this.publish(null);
      const id = createHash('sha256').update(`${relative}\n${record.version}\n${record.status}`).digest('hex');
      if (!acknowledged.includes(id)) {
        const timestamp = typeof record.preparedAt === 'string' ? Date.parse(record.preparedAt) : NaN;
        const [outcome, action] = outcomes[record.status];
        notice = { id, status: record.status, targetVersion: version(record.version),
          previousVersion: version(record.backupVersion), currentVersion: this.currentVersion,
          recordedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null, outcome, action };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.publish(null); throw error; }
    }
    return this.publish(notice);
  }

  publish(notice) {
    const changed = JSON.stringify(this.notice) !== JSON.stringify(notice);
    this.notice = notice;
    if (changed) this.onUpdate(this.snapshot());
    return this.snapshot();
  }

  dismiss(id) {
    return this.serial(async () => {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return this.snapshot();
      // Refresh first: a delayed click for an older notice cannot acknowledge
      // the next installation, even if its result arrived before this IPC.
      await this.readCurrent();
      if (this.notice?.id !== id) return this.snapshot();
      const directory = await realpath(this.cacheDirectory);
      const ids = [...(await this.readAcknowledged(directory)).filter(value => value !== id), id].slice(-100);
      const filename = path.join(directory, 'mac-install-notices.json');
      const temporary = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ids }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, filename);
      } finally { await rm(temporary, { force: true }); }
      return this.readCurrent();
    });
  }
}
