// Standalone Node.js entry points only. Never import this module from a Worker
// or Vercel API: those deployments continue to use the GitHub store.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AccountError, fail } from './errors.js';
import { emptyState, validateState } from './store.js';

const APPLICATION_ID = 0x42524341; // BRCA: Brclio account storage.
const DATABASE_VERSION = 1;
const MAX_PART_BYTES = 262_144;
const defaultDelay = ms => new Promise(resolve => setTimeout(resolve, ms));

function storageError(error) {
  if (error instanceof AccountError) return error;
  // Deliberately discard SQLite/filesystem messages; they can include paths or
  // SQL values. The original error is never returned to an HTTP client.
  const corrupt = [11, 26].includes(error?.errcode);
  return new AccountError(corrupt ? 'STORAGE_INVALID' : 'STORAGE_UNAVAILABLE', corrupt ? 'SQLite 业务数据损坏，请恢复备份后重试。' : 'SQLite 存储暂时不可用，请检查服务器存储配置。', 503);
}

function isBusy(error) {
  return [5, 6].includes(error?.errcode & 0xff);
}

function validatePartKey(feedbackId, index) {
  if (typeof feedbackId !== 'string' || !/^[a-f0-9-]{36}$/.test(feedbackId) || !Number.isInteger(index) || index < 0 || index >= 64) fail('INVALID_FEEDBACK_PART', '反馈日志分块标识无效。');
}

function validatePartContent(content) {
  if (typeof content !== 'string' || !content || Buffer.byteLength(content) > MAX_PART_BYTES) fail('INVALID_FEEDBACK_PART', '反馈日志分块内容无效。');
}

function blobSha(content) {
  // Match Git's blob IDs so the same bytes have the same identity after migration.
  return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
}

function rejectSymlink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) fail('SERVICE_NOT_CONFIGURED', 'SQLite 数据文件不能使用符号链接。', 503);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export class SqliteStateStore {
  #db;
  #closed = false;

  constructor({ path, readOnly = false, openExisting = false, maxAttempts = 8, maxBytes = 16 * 1024 * 1024, delay = defaultDelay } = {}) {
    if (typeof path !== 'string' || !path.trim() || path === ':memory:' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || typeof delay !== 'function') fail('SERVICE_NOT_CONFIGURED', 'SQLite 存储配置无效。', 503);
    Object.assign(this, { kind: 'sqlite', path: resolve(path), readOnly, maxAttempts, maxBytes, delay });
    let created = false;
    try {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rejectSymlink(`${this.path}${suffix}`);
      if (!existsSync(this.path)) {
        if (readOnly || openExisting) fail('STORAGE_NOT_FOUND', 'SQLite 数据库尚未创建。', 503);
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        try {
          const descriptor = openSync(this.path, 'wx', 0o600);
          closeSync(descriptor);
          created = true;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          rejectSymlink(this.path);
        }
      }
      if (!lstatSync(this.path).isFile()) fail('SERVICE_NOT_CONFIGURED', 'SQLite 数据文件配置无效。', 503);
      if (!readOnly) chmodSync(this.path, 0o600);
      this.#db = new DatabaseSync(this.path, { readOnly });
      this.#db.exec('PRAGMA busy_timeout = 250; PRAGMA trusted_schema = OFF;');
      if (created) {
        this.#atomic('IMMEDIATE', () => {
          this.#db.exec(`
            CREATE TABLE account_state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision >= 0),
              content TEXT NOT NULL
            ) STRICT;
            CREATE TABLE feedback_parts (
              feedback_id TEXT NOT NULL,
              part_index INTEGER NOT NULL CHECK (part_index >= 0 AND part_index < 64),
              content TEXT NOT NULL,
              blob_sha TEXT NOT NULL,
              PRIMARY KEY (feedback_id, part_index)
            ) STRICT;
            PRAGMA application_id = ${APPLICATION_ID};
            PRAGMA user_version = ${DATABASE_VERSION};
          `);
          this.#db.prepare('INSERT INTO account_state (id, revision, content) VALUES (1, 0, ?)').run(JSON.stringify(emptyState()));
        });
      }
      // Existing empty, foreign, newer or damaged databases are never initialized
      // again. Startup must stop, leaving recovery to an explicit restore.
      const applicationId = this.#db.prepare('PRAGMA application_id').get().application_id;
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (applicationId !== APPLICATION_ID || version !== DATABASE_VERSION || this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('STORAGE_INVALID', 'SQLite 数据库格式异常，请检查数据库版本或恢复备份。', 503);
      this.#readState();
      this.#db.prepare('SELECT feedback_id, part_index, content, blob_sha FROM feedback_parts LIMIT 0').all();
      if (!readOnly) {
        this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.#secureSidecars();
      }
    } catch (error) {
      try { this.#db?.close(); } catch { /* Preserve the original error. */ }
      this.#closed = true;
      throw storageError(error);
    }
  }

  #secureSidecars() {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const path = `${this.path}${suffix}`;
      rejectSymlink(path);
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  #assertOpen(write = false) {
    if (this.#closed) fail('STORAGE_UNAVAILABLE', 'SQLite 数据库连接已关闭。', 503);
    if (write && this.readOnly) fail('STORAGE_READ_ONLY', 'SQLite 数据库当前以只读方式打开。', 503);
  }

  #atomic(mode, operation) {
    this.#db.exec(`BEGIN ${mode}`);
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  #serializeState(state) {
    let content;
    try { content = JSON.stringify(validateState(state)); }
    catch (error) {
      if (error instanceof AccountError) throw error;
      fail('STORAGE_INVALID', '业务数据格式异常，本次操作未保存。', 503);
    }
    if (Buffer.byteLength(content) > this.maxBytes) fail('STORAGE_CAPACITY', '业务数据已达到安全容量限制，本次操作未保存。', 503);
    return content;
  }

  #readState() {
    const rows = this.#db.prepare('SELECT id, revision, content FROM account_state').all();
    if (rows.length !== 1 || rows[0].id !== 1 || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 0) fail('STORAGE_INVALID', 'SQLite 业务数据记录异常，请恢复备份。', 503);
    const { content, revision } = rows[0];
    if (typeof content !== 'string') fail('STORAGE_INVALID', 'SQLite 业务数据格式异常。', 503);
    if (Buffer.byteLength(content) > this.maxBytes) fail('STORAGE_CAPACITY', '业务数据已达到安全容量限制，请联系管理员。', 503);
    try { return { state: validateState(JSON.parse(content)), sha: String(revision), revision }; }
    catch (error) {
      if (error instanceof AccountError) throw error;
      fail('STORAGE_INVALID', 'SQLite 业务数据读取失败，请恢复备份。', 503);
    }
  }

  #bumpRevision(revision) {
    if (revision >= Number.MAX_SAFE_INTEGER) fail('STORAGE_CAPACITY', 'SQLite 数据版本已达到安全容量限制。', 503);
    this.#db.prepare('UPDATE account_state SET revision = ? WHERE id = 1').run(revision + 1);
    return revision + 1;
  }

  #partResult(row) {
    if (!row) return null;
    if (typeof row.content !== 'string' || !row.content || Buffer.byteLength(row.content) > MAX_PART_BYTES || row.blob_sha !== blobSha(row.content)) fail('STORAGE_INVALID', '反馈日志文件格式异常或内容损坏。', 503);
    return { content: row.content, bytes: Buffer.byteLength(row.content), blobSha: row.blob_sha };
  }

  async read() {
    this.#assertOpen();
    try { return this.#readState(); } catch (error) { throw storageError(error); }
  }

  async currentRevision() {
    return (await this.read()).revision;
  }

  async health() {
    await this.read();
    return { provider: this.kind, ok: true };
  }

  async transaction(mutate) {
    this.#assertOpen(true);
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const { state, revision } = await this.read();
      // Mutators may await hashing, mail or network work. Holding a synchronous
      // SQLite lock across this await would block other connections/event loops.
      const result = await mutate(state);
      if (result?.changed === false) return result.value;
      const content = this.#serializeState(state);
      try {
        const committed = this.#atomic('IMMEDIATE', () => {
          const current = this.#readState();
          if (current.revision !== revision) return false;
          this.#bumpRevision(revision);
          this.#db.prepare('UPDATE account_state SET content = ? WHERE id = 1').run(content);
          return true;
        });
        if (committed) return result?.value;
      } catch (error) {
        if (!isBusy(error)) throw storageError(error);
      }
      await this.delay(Math.min(10 * 2 ** attempt, 200));
    }
    fail('STORAGE_CONFLICT', '同时操作较多，本次操作未确认，请使用相同请求重试。', 503);
  }

  async readFeedbackPart(feedbackId, index, { allowMissing = false } = {}) {
    this.#assertOpen();
    validatePartKey(feedbackId, index);
    try {
      const part = this.#partResult(this.#db.prepare('SELECT content, blob_sha FROM feedback_parts WHERE feedback_id = ? AND part_index = ?').get(feedbackId, index));
      if (!part && !allowMissing) fail('FEEDBACK_LOG_INCOMPLETE', '日志尚未全部上传，请使用原反馈重试。', 409);
      return part;
    } catch (error) { throw storageError(error); }
  }

  async readFeedbackParts(feedbackId, count) {
    this.#assertOpen();
    if (!Number.isInteger(count) || count < 1 || count > 64) fail('INVALID_FEEDBACK_PART', '日志分块数量无效。');
    validatePartKey(feedbackId, count - 1);
    try {
      // One query gives a consistent set even during a full snapshot replacement.
      const rows = this.#db.prepare('SELECT part_index, content, blob_sha FROM feedback_parts WHERE feedback_id = ? AND part_index < ? ORDER BY part_index').all(feedbackId, count);
      if (rows.length !== count || rows.some((row, index) => row.part_index !== index)) fail('FEEDBACK_LOG_INCOMPLETE', '日志尚未全部上传，请使用原反馈重试。', 409);
      return rows.map(row => this.#partResult(row));
    } catch (error) { throw storageError(error); }
  }

  async writeFeedbackPart(feedbackId, index, content) {
    this.#assertOpen(true);
    validatePartKey(feedbackId, index);
    validatePartContent(content);
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return this.#atomic('IMMEDIATE', () => {
          const prior = this.#partResult(this.#db.prepare('SELECT content, blob_sha FROM feedback_parts WHERE feedback_id = ? AND part_index = ?').get(feedbackId, index));
          if (prior) {
            if (prior.content !== content) fail('FEEDBACK_PART_CONFLICT', '日志分块已存在且内容不同，请保留原快照重试。', 409);
            return { received: true, replayed: true };
          }
          const { revision } = this.#readState();
          this.#db.prepare('INSERT INTO feedback_parts (feedback_id, part_index, content, blob_sha) VALUES (?, ?, ?, ?)').run(feedbackId, index, content, blobSha(content));
          this.#bumpRevision(revision);
          return { received: true, replayed: false };
        });
      } catch (error) {
        if (!isBusy(error)) throw storageError(error);
      }
      await this.delay(Math.min(10 * 2 ** attempt, 200));
    }
    fail('STORAGE_CONFLICT', '日志写入发生并发冲突，请重试原分块。', 503);
  }

  async exportSnapshot() {
    this.#assertOpen();
    try {
      return this.#atomic('DEFERRED', () => {
        const { state, revision } = this.#readState();
        const parts = this.#db.prepare('SELECT feedback_id, part_index, content, blob_sha FROM feedback_parts ORDER BY feedback_id, part_index').all().map(row => {
          validatePartKey(row.feedback_id, row.part_index);
          const { content } = this.#partResult(row);
          return { feedbackId: row.feedback_id, index: row.part_index, content };
        });
        return { state, parts, revision };
      });
    } catch (error) { throw storageError(error); }
  }

  async importSnapshot(snapshot, { replace = false, expectedRevision } = {}) {
    this.#assertOpen(true);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) fail('STORAGE_CONFLICT', '迁移目标版本无效，请重新读取目标数据。', 409);
    if (replace && expectedRevision === undefined) fail('STORAGE_CONFLICT', '覆盖迁移需要目标版本，请重新读取目标数据。', 409);
    if (!snapshot || !Array.isArray(snapshot.parts)) fail('STORAGE_INVALID', '迁移快照格式无效。', 400);
    let state;
    try { state = JSON.parse(JSON.stringify(snapshot.state)); }
    catch { fail('STORAGE_INVALID', '迁移快照业务数据无效。', 400); }
    const content = this.#serializeState(state);
    const keys = new Set();
    const parts = snapshot.parts.map(part => {
      if (!part || typeof part !== 'object') fail('STORAGE_INVALID', '迁移快照日志分块无效。', 400);
      const { feedbackId, index, content } = part;
      validatePartKey(feedbackId, index);
      validatePartContent(content);
      const key = `${feedbackId}:${index}`;
      if (keys.has(key)) fail('STORAGE_INVALID', '迁移快照包含重复日志分块。', 400);
      keys.add(key);
      return { feedbackId, index, content };
    });
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return this.#atomic('IMMEDIATE', () => {
          const current = this.#readState();
          if (expectedRevision !== undefined && current.revision !== expectedRevision) fail('STORAGE_CONFLICT', '迁移目标数据已更新，请重新检查后重试。', 409);
          const partCount = this.#db.prepare('SELECT COUNT(*) AS count FROM feedback_parts').get().count;
          if (!replace && (partCount > 0 || !isDeepStrictEqual(current.state, emptyState()))) fail('STORAGE_NOT_EMPTY', '迁移目标已有数据；覆盖必须显式指定并保留备份。', 409);
          this.#db.exec('DELETE FROM feedback_parts');
          const insert = this.#db.prepare('INSERT INTO feedback_parts (feedback_id, part_index, content, blob_sha) VALUES (?, ?, ?, ?)');
          for (const part of parts) insert.run(part.feedbackId, part.index, part.content, blobSha(part.content));
          this.#db.prepare('UPDATE account_state SET content = ? WHERE id = 1').run(content);
          return { revision: this.#bumpRevision(current.revision) };
        });
      } catch (error) {
        if (!isBusy(error)) throw storageError(error);
      }
      await this.delay(Math.min(10 * 2 ** attempt, 200));
    }
    fail('STORAGE_CONFLICT', '迁移目标繁忙，请稍后重试。', 409);
  }

  close() {
    if (this.#closed) return;
    try { this.#db.close(); this.#closed = true; }
    catch (error) { throw storageError(error); }
  }
}

export function createSqliteStore(env = process.env, options = {}) {
  return new SqliteStateStore({ path: env.AUTH_SQLITE_PATH || './data/accounts.sqlite', ...options });
}
