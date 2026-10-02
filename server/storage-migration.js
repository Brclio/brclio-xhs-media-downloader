/** Node-only offline migration helpers. Never imported by serverless request handlers. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, lstat, open, realpath } from 'node:fs/promises';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, validateState, GithubStateStore } from './auth/store.js';
import { fail } from './auth/errors.js';

const STATE_MAX_BYTES = 900_000;
const SQLITE_MAX_BYTES = 16 * 1024 * 1024;
const PART_MAX_BYTES = 262_144;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/;
const PART_PATH = /^feedback\/([a-f0-9-]{36})\/part-(\d{3})\.ndjson$/;
const HASH = /^[a-f0-9]{64}$/;
const sha256 = content => createHash('sha256').update(content).digest('hex');
const partPath = ({ feedbackId, index }) => `feedback/${feedbackId}/part-${String(index).padStart(3, '0')}.ndjson`;

/** Preserve unknown state fields and every uploaded part, including unfinished uploads. */
export function validateMigrationSnapshot(snapshot, { maxStateBytes = SQLITE_MAX_BYTES } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.parts)) fail('MIGRATION_INVALID', '迁移快照格式无效。');
  let state;
  try { state = validateState(structuredClone(snapshot.state)); }
  catch { fail('MIGRATION_INVALID', '迁移快照中的账号数据格式无效。'); }
  if (Buffer.byteLength(JSON.stringify(state)) > maxStateBytes) fail('STORAGE_CAPACITY', `账号数据超过目标存储的 ${maxStateBytes} 字节限制，迁移未执行。`);
  const parts = [], byPath = new Map();
  for (const part of snapshot.parts) {
    if (!part || typeof part.feedbackId !== 'string' || !ID.test(part.feedbackId) || !Number.isInteger(part.index) || part.index < 0 || part.index >= 64
        || typeof part.content !== 'string' || !part.content || Buffer.byteLength(part.content) > PART_MAX_BYTES) fail('MIGRATION_INVALID', '迁移快照包含无效的反馈日志分块。');
    const key = partPath(part);
    if (byPath.has(key)) fail('MIGRATION_INVALID', '迁移快照包含重复的反馈日志分块。');
    const copy = { feedbackId: part.feedbackId, index: part.index, content: part.content };
    parts.push(copy); byPath.set(key, copy);
  }
  for (const [id, feedback] of Object.entries(state.feedback)) {
    const log = feedback.log;
    if (!ID.test(id) || feedback.id !== id || !log || !Number.isInteger(log.partCount) || log.partCount < 1 || log.partCount > 64
        || !Array.isArray(log.parts) || log.parts.length !== log.partCount || !HASH.test(log.sha256 || '')
        || !Number.isSafeInteger(log.totalBytes) || log.totalBytes < 1 || log.totalBytes > LOG_MAX_BYTES) fail('MIGRATION_INVALID', '反馈日志清单无效，迁移未执行。');
    let manifestBytes = 0;
    const present = [];
    for (let index = 0; index < log.partCount; index += 1) {
      const expected = log.parts[index];
      if (!expected || !Number.isInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > PART_MAX_BYTES || !HASH.test(expected.sha256 || '')) fail('MIGRATION_INVALID', '反馈日志分块清单无效，迁移未执行。');
      manifestBytes += expected.bytes;
      const part = byPath.get(partPath({ feedbackId: id, index }));
      if (!part) {
        if (feedback.submittedAt || feedback.status !== 'uploading') fail('FEEDBACK_LOG_INCOMPLETE', '已提交反馈缺少日志分块，迁移未执行。');
        continue;
      }
      if (Buffer.byteLength(part.content) !== expected.bytes || sha256(part.content) !== expected.sha256) fail('FEEDBACK_LOG_MISMATCH', '反馈日志分块校验失败，迁移未执行。');
      present.push(part.content);
    }
    if (manifestBytes !== log.totalBytes || (present.length === log.partCount && sha256(present.join('')) !== log.sha256)) fail('FEEDBACK_LOG_MISMATCH', '反馈完整日志校验失败，迁移未执行。');
    // Unexpected uploaded parts would otherwise become inaccessible after migration.
    if (parts.some(part => part.feedbackId === id && part.index >= log.partCount)) fail('MIGRATION_INVALID', '反馈日志分块数量超过清单，迁移未执行。');
  }
  parts.sort((a, b) => a.feedbackId.localeCompare(b.feedbackId) || a.index - b.index);
  return { ...snapshot, state, parts };
}

export function snapshotHasData(snapshot) {
  return snapshot.parts.length > 0 || !isDeepStrictEqual(snapshot.state, emptyState());
}

export function summarizeSnapshot(snapshot) {
  return {
    users: Object.keys(snapshot.state.users).length,
    sessions: Object.keys(snapshot.state.sessions).length,
    devices: Object.keys(snapshot.state.devices).length,
    codes: Object.keys(snapshot.state.codes).length,
    feedback: Object.keys(snapshot.state.feedback).length,
    uploadingFeedback: Object.values(snapshot.state.feedback).filter(item => item.status === 'uploading').length,
    logParts: snapshot.parts.length,
    logBytes: snapshot.parts.reduce((sum, part) => sum + Buffer.byteLength(part.content), 0),
    stateBytes: Buffer.byteLength(JSON.stringify(snapshot.state)),
  };
}

/** Immutable blob SHAs ensure a snapshot cannot mix different branch revisions. */
export class GithubMigrationStore extends GithubStateStore {
  constructor(options) {
    super(options);
    if (this.path.startsWith('feedback/') || this.path.split('/').some(segment => !segment || segment === '.') || this.path.includes('\\')) fail('SERVICE_NOT_CONFIGURED', '账号数据路径不能与反馈日志目录重叠。');
    this.refUrl = `${this.base}/git/ref/heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`;
    this.updateRefUrl = `${this.base}/git/refs/heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`;
  }

  async json(url, method = 'GET', body) {
    let response;
    try { response = await this.request(url, method, body); }
    catch (error) {
      if (method === 'PATCH') fail('MIGRATION_WRITE_UNCERTAIN', 'GitHub 分支更新结果不确定，请先核对分支提交记录，勿直接重复覆盖。', 503);
      throw error;
    }
    if (response.status === 409 || response.status === 422) fail('STORAGE_CONFLICT', 'GitHub 分支已变更或拒绝更新。请停止服务写入并重新预览；本次未强制覆盖。', 409);
    this.checkFailure(response);
    try { return await response.json(); }
    catch {
      fail(method === 'PATCH' ? 'MIGRATION_WRITE_UNCERTAIN' : 'STORAGE_INVALID', method === 'PATCH' ? 'GitHub 分支更新确认中断，请核对分支提交记录。' : 'GitHub 迁移响应格式无效。', 503);
    }
  }

  async head() {
    const ref = await this.json(this.refUrl);
    if (!ref.object?.sha || ref.object.type !== 'commit') fail('STORAGE_INVALID', 'GitHub 分支不存在或没有初始提交。请先在私有仓库初始化该分支。', 503);
    return ref.object.sha;
  }

  async readBlob(entry, maxBytes, cache) {
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !entry.sha || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > maxBytes) fail('STORAGE_INVALID', 'GitHub 迁移源文件格式或大小无效。', 503);
    if (cache?.has(entry.sha)) {
      const content = cache.get(entry.sha);
      if (Buffer.byteLength(content) !== entry.size) fail('STORAGE_INVALID', 'GitHub 迁移源文件内容不完整。', 503);
      return content;
    }
    const blob = await this.json(`${this.base}/git/blobs/${encodeURIComponent(entry.sha)}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.sha !== entry.sha) fail('STORAGE_INVALID', 'GitHub 迁移源文件不可读取。', 503);
    const bytes = Buffer.from(blob.content, 'base64');
    const content = bytes.toString('utf8');
    if (bytes.length !== entry.size || bytes.length > maxBytes || !Buffer.from(content, 'utf8').equals(bytes)) fail('STORAGE_INVALID', 'GitHub 迁移源文件内容不完整或不是 UTF-8。', 503);
    cache?.set(entry.sha, content);
    return content;
  }

  async currentRevision() {
    await this.assertPrivate();
    return this.head();
  }

  async exportSnapshot() {
    await this.assertPrivate();
    const revision = await this.head();
    const commit = await this.json(`${this.base}/git/commits/${encodeURIComponent(revision)}`);
    if (!commit.tree?.sha) fail('STORAGE_INVALID', 'GitHub 提交缺少文件树。', 503);
    const treeSha = commit.tree.sha;
    const tree = await this.json(`${this.base}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
    if (!Array.isArray(tree.tree) || tree.truncated !== false) fail('STORAGE_INVALID', 'GitHub 文件树不完整，无法安全迁移。', 503);
    let state = emptyState(), stateExists = false;
    const parts = [], managedPaths = [], blobCache = new Map();
    for (const entry of tree.tree) {
      if (entry.path === this.path) {
        const content = await this.readBlob(entry, STATE_MAX_BYTES, blobCache);
        try { state = JSON.parse(content); } catch { fail('STORAGE_INVALID', 'GitHub 账号数据不是有效 JSON。', 503); }
        stateExists = true;
      } else {
        const match = PART_PATH.exec(entry.path);
        if (!match) {
          if (/^feedback\/[^/]+\/part-[^/]+\.ndjson$/.test(entry.path)) fail('MIGRATION_INVALID', 'GitHub 存在无法识别的反馈分块路径，迁移未执行。');
          continue;
        }
        const index = Number(match[2]);
        if (index >= 64) fail('MIGRATION_INVALID', 'GitHub 反馈日志超过 64 个分块限制，迁移未执行。');
        parts.push({ feedbackId: match[1], index, content: await this.readBlob(entry, PART_MAX_BYTES, blobCache) });
        managedPaths.push(entry.path);
      }
    }
    return validateMigrationSnapshot({ state, parts, revision, treeSha, stateExists, managedPaths }, { maxStateBytes: STATE_MAX_BYTES });
  }

  async importSnapshot(input, { replace = false, expectedRevision } = {}) {
    const snapshot = validateMigrationSnapshot(input, { maxStateBytes: STATE_MAX_BYTES });
    if (expectedRevision === undefined) fail('MIGRATION_REVISION_REQUIRED', '写入 GitHub 前必须提供预览时的目标版本。');
    const target = await this.exportSnapshot();
    if (target.revision !== expectedRevision) fail('STORAGE_CONFLICT', 'GitHub 目标在预览后已更新，迁移未执行。', 409);
    if (snapshotHasData(target) && !replace) fail('MIGRATION_TARGET_NOT_EMPTY', '目标已有数据；请使用 --replace 并备份后再迁移。', 409);
    const files = new Map([[this.path, JSON.stringify(snapshot.state)], ...snapshot.parts.map(part => [partPath(part), part.content])]);
    const entries = [];
    for (const [path, content] of files) {
      const blob = await this.json(`${this.base}/git/blobs`, 'POST', { content: Buffer.from(content).toString('base64'), encoding: 'base64' });
      if (!blob.sha) fail('STORAGE_INVALID', 'GitHub 未确认迁移文件，分支未更新。', 503);
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (const path of target.managedPaths) {
      if (!files.has(path)) entries.push({ path, mode: '100644', type: 'blob', sha: null });
    }
    // A base tree retains README, repository configuration, and every unrelated file.
    const tree = await this.json(`${this.base}/git/trees`, 'POST', { base_tree: target.treeSha, tree: entries });
    if (!tree.sha) fail('STORAGE_INVALID', 'GitHub 未确认迁移文件树，分支未更新。', 503);
    if (await this.head() !== expectedRevision) fail('STORAGE_CONFLICT', 'GitHub 目标在迁移准备期间已更新，迁移未执行。', 409);
    const commit = await this.json(`${this.base}/git/commits`, 'POST', { message: 'Migrate account storage atomically [skip ci]', tree: tree.sha, parents: [target.revision] });
    if (!commit.sha) fail('STORAGE_INVALID', 'GitHub 未确认迁移提交，分支未更新。', 503);
    // Competing writes descend from the old HEAD, so force:false rejects a race.
    const confirmation = await this.json(this.updateRefUrl, 'PATCH', { sha: commit.sha, force: false });
    if (confirmation.object?.sha !== commit.sha) fail('MIGRATION_WRITE_UNCERTAIN', 'GitHub 分支更新尚未确认，请核对分支提交记录。', 503);
    return { revision: commit.sha };
  }
}

export function createGithubMigrationStore(env = process.env, options = {}) {
  return new GithubMigrationStore({ owner: env.AUTH_GITHUB_OWNER, repo: env.AUTH_GITHUB_REPO, token: env.AUTH_GITHUB_TOKEN,
    branch: env.AUTH_GITHUB_BRANCH || 'main', path: env.AUTH_GITHUB_PATH || 'state/accounts.json', ...options });
}

async function canonicalDestination(path) {
  const missing = [];
  let existing = resolve(path);
  while (true) {
    try { return resolve(await realpath(existing), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(existing) === existing) throw error;
      missing.unshift(basename(existing)); existing = dirname(existing);
    }
  }
}

/** Block data paths copied or served publicly, including aliases through symlinks. */
export async function assertPrivateMigrationPath(path) {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const candidate = await canonicalDestination(path);
  for (const name of ['dist-web', 'public', 'assets', 'admin', 'cloudflare/pages/dist']) {
    const publicRoot = await canonicalDestination(join(projectRoot, name));
    if (candidate === publicRoot || candidate.startsWith(publicRoot + sep)) fail('MIGRATION_PUBLIC_PATH', 'SQLite 数据与迁移备份不能放在网站公开目录中。');
  }
}

/** Back up logical contents (including uncheckpointed WAL data), never credentials. */
export async function writeMigrationBackup(snapshot, { directory = 'data/migration-backups', target = 'storage' } = {}) {
  if (!['github', 'sqlite', 'storage'].includes(target)) fail('MIGRATION_BACKUP_FAILED', '备份目标类型无效。');
  const destination = resolve(directory);
  await assertPrivateMigrationPath(destination);
  const firstCreatedDirectory = await mkdir(destination, { recursive: true, mode: 0o700 });
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('MIGRATION_BACKUP_FAILED', '备份目录必须为本地真实目录。');
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) fail('MIGRATION_BACKUP_FAILED', '现有备份目录权限必须为 0700，请先修正目录权限。');
  const name = `${new Date().toISOString().replaceAll(':', '-')}-${target}-${randomUUID()}.json`;
  const path = join(destination, name);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ formatVersion: 1, createdAt: new Date().toISOString(), target, snapshot }), 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  // fsync(file) alone does not persist its directory entry. Flush the backup
  // directory and any newly created ancestors before allowing replacement.
  // Node cannot open directory handles for this operation on Windows.
  if (process.platform !== 'win32') {
    const lastDirectory = firstCreatedDirectory ? dirname(resolve(firstCreatedDirectory)) : destination;
    for (let directory = destination; ; directory = dirname(directory)) {
      const directoryHandle = await open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      if (directory === lastDirectory) break;
    }
  }
  return path;
}

/** Preview is read-only. Replacement is guarded by a durable backup and revision. */
export async function migrateStorage({ source, target, from, to, apply = false, replace = false, backupDirectory, onPreview = () => {}, onBackup = () => {} }) {
  const sourceSnapshot = validateMigrationSnapshot(await source.exportSnapshot());
  if (sourceSnapshot.stateExists === false) fail('MIGRATION_SOURCE_MISSING', 'GitHub 源仓库没有账号数据文件，迁移未执行。');
  const targetSnapshot = validateMigrationSnapshot(await target.exportSnapshot());
  const nonempty = snapshotHasData(targetSnapshot);
  const preview = { direction: `${from} -> ${to}`, mode: apply ? 'apply' : 'dry-run', source: summarizeSnapshot(sourceSnapshot),
    target: summarizeSnapshot(targetSnapshot), targetHasData: nonempty, replace, requiresReplace: nonempty && !replace };
  onPreview(preview);
  if (to === 'github' && preview.source.stateBytes > STATE_MAX_BYTES) fail('STORAGE_CAPACITY', '账号数据超过 GitHub 兼容的 900000 字节限制，迁移未执行。');
  if (!apply) return { ...preview, applied: false };
  if (sourceSnapshot.revision === undefined) fail('MIGRATION_REVISION_REQUIRED', '迁移源快照缺少版本，迁移未执行。');
  if (nonempty && !replace) fail('MIGRATION_TARGET_NOT_EMPTY', '目标已有数据。请确认预览后增加 --replace；覆盖前会自动创建备份。', 409);
  const backup = replace ? await writeMigrationBackup(targetSnapshot, { directory: backupDirectory, target: to }) : null;
  if (backup) onBackup(backup);
  const sourceRevision = typeof source.currentRevision === 'function'
    ? await source.currentRevision() : (await source.exportSnapshot()).revision;
  if (sourceRevision !== sourceSnapshot.revision) fail('STORAGE_CONFLICT', '迁移源在预览或备份期间已更新，迁移未执行。请停止源端写入并重新预览。', 409);
  const result = await target.importSnapshot(sourceSnapshot, { replace, expectedRevision: targetSnapshot.revision });
  return { ...preview, applied: true, revision: result.revision, backup };
}
