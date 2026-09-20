import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { sanitizeDiagnostic } from '../lib/diagnostic-sanitize.js';

export const DIAGNOSTIC_MAX_BYTES = 8 * 1024 * 1024;
export const DIAGNOSTIC_PART_BYTES = 256 * 1024;
const FILE_COUNT = 8;
const ENTRY_BYTES = 24000;
const encode = entry => `${JSON.stringify(sanitizeDiagnostic(entry))}\n`;
function boundedEntry(entry, limit = ENTRY_BYTES) {
  let line = encode(entry);
  if (Buffer.byteLength(line) <= limit) return line;
  const originalBytes = Buffer.byteLength(line);
  let summary = JSON.stringify(sanitizeDiagnostic(entry.details || {}));
  do {
    summary = summary.slice(0, Math.floor(summary.length / 2));
    line = encode({ at: entry.at, level: 'warn', event: entry.event === 'diagnostics.snapshot' ? 'diagnostics.snapshot' : 'diagnostics.entry_reduced',
      details: { sourceEvent: String(entry.event).slice(0, 120), summary, originalBytes } });
  } while (Buffer.byteLength(line) > limit && summary.length);
  if (Buffer.byteLength(line) > limit) throw new Error('Diagnostic record limit too small');
  return line;
}

export function splitDiagnosticParts(text, maximum = DIAGNOSTIC_PART_BYTES) {
  const parts = []; let current = '', bytes = 0;
  for (const line of text.match(/[^\n]*\n/g) || []) {
    const length = Buffer.byteLength(line);
    if (length > maximum) throw new Error('单条诊断记录超过上传限制。');
    if (bytes && bytes + length > maximum) { parts.push(current); current = ''; bytes = 0; }
    current += line; bytes += length;
  }
  if (current) parts.push(current);
  if (parts.join('') !== text) throw new Error('诊断日志必须以完整行保存。');
  return parts;
}

export class DiagnosticLog {
  constructor({ directory, now = Date.now, maxBytes = DIAGNOSTIC_MAX_BYTES }) {
    if (!path.isAbsolute(directory)) throw new Error('Diagnostics directory must be absolute');
    this.directory = directory; this.now = now; this.maxBytes = maxBytes;
    this.segmentBytes = Math.floor((maxBytes - Math.min(32768, maxBytes / 8)) / FILE_COUNT);
    this.runId = randomBytes(8).toString('hex'); this.pending = Promise.resolve();
    this.queued = 0; this.dropped = 0; this.lastError = null; this.currentBytes = 0;
    this.meta = { startedAt: new Date(now()).toISOString(), rotatedBytes: 0 };
  }
  file(index = 0) { return path.join(this.directory, index ? `events.${index}.ndjson` : 'events.ndjson'); }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error('Invalid diagnostics directory');
    try {
      const saved = JSON.parse(await readFile(path.join(this.directory, 'retention.json'), 'utf8'));
      if (typeof saved.startedAt === 'string' && Number.isSafeInteger(saved.rotatedBytes) && saved.rotatedBytes >= 0) this.meta = saved;
    } catch { /* New logger; no previous history is invented. */ }
    try { const info = await lstat(this.file()); if (!info.isFile()) throw new Error('Invalid log file'); this.currentBytes = info.size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.record('diagnostics.started', { runId: this.runId, retainedLimitBytes: this.maxBytes });
    return this;
  }
  record(event, details = {}, level = 'info') {
    if (this.queued >= 500) { this.dropped++; return Promise.resolve(); }
    this.queued++;
    const work = this.pending.then(async () => {
      const line = boundedEntry({ at: new Date(this.now()).toISOString(), level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
        event: String(event).slice(0, 120), details }, Math.min(ENTRY_BYTES, this.segmentBytes));
      const bytes = Buffer.byteLength(line);
      if (this.currentBytes + bytes > this.segmentBytes) await this.rotate();
      try { const info = await lstat(this.file()); if (!info.isFile()) throw new Error('Invalid log file'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await appendFile(this.file(), line, { mode: 0o600 }); this.currentBytes += bytes;
    }).catch(error => { this.lastError = error.code || 'LOG_WRITE_FAILED'; }).finally(() => { this.queued--; });
    this.pending = work;
    return work;
  }
  async rotate() {
    try { this.meta.rotatedBytes += (await lstat(this.file(FILE_COUNT - 1))).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(this.file(FILE_COUNT - 1), { force: true });
    for (let index = FILE_COUNT - 2; index >= 0; index--) {
      try { await rename(this.file(index), this.file(index + 1)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.currentBytes = 0;
    const temp = path.join(this.directory, 'retention.tmp');
    await writeFile(temp, JSON.stringify(this.meta), { mode: 0o600 });
    await rename(temp, path.join(this.directory, 'retention.json'));
  }
  async flush() { await this.pending; }
  async snapshot(context = {}) {
    // Capture a fixed, privacy-filtered snapshot while later log writes queue behind it.
    let result;
    const capture = this.pending.then(async () => {
      const rows = []; let fileCount = 0; let invalidLines = 0;
      for (let index = FILE_COUNT - 1; index >= 0; index--) {
        try {
          const info = await lstat(this.file(index));
          if (!info.isFile() || info.size > this.maxBytes) { invalidLines++; continue; }
          const data = await readFile(this.file(index), 'utf8'); fileCount++;
          for (const line of data.split('\n').filter(Boolean)) {
            try {
              const entry = JSON.parse(line);
              if (!entry || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) || typeof entry.event !== 'string') { invalidLines++; continue; }
              rows.push(boundedEntry(entry));
            } catch { invalidLines++; }
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const capturedAt = new Date(this.now()).toISOString();
      let retainedBytes = rows.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
      let trimmed = 0;
      const header = () => boundedEntry({ at: capturedAt, level: 'info', event: 'diagnostics.snapshot', details: {
        schemaVersion: 1, ...context, retainedLimitBytes: this.maxBytes, rotatedBytes: this.meta.rotatedBytes,
        trimmedEntries: trimmed, invalidLines, droppedEvents: this.dropped, loggingError: this.lastError,
        historyBeganAt: this.meta.startedAt, privacy: 'No cookies, credentials, raw hardware identifiers or downloaded media.' } });
      let meta = header();
      while (rows.length && retainedBytes + Buffer.byteLength(meta) > this.maxBytes) {
        retainedBytes -= Buffer.byteLength(rows.shift()); trimmed++; meta = header();
      }
      const text = meta + rows.join('');
      if (Buffer.byteLength(text) > this.maxBytes) throw new Error('诊断摘要超过上限。');
      const times = rows.map(line => Date.parse(JSON.parse(line).at));
      const oldestAt = times.length ? new Date(times.reduce((a, b) => Math.min(a, b))).toISOString() : capturedAt;
      const newestAt = times.length ? new Date(times.reduce((a, b) => Math.max(a, b))).toISOString() : capturedAt;
      result = { text, fileCount, totalBytes: Buffer.byteLength(text), oldestAt, newestAt, capturedAt,
        maxBytes: this.maxBytes, truncated: Boolean(this.meta.rotatedBytes || trimmed || this.dropped || invalidLines),
        loggingError: this.lastError, summary: `保留 ${rows.length} 条运行记录；最多 ${Math.round(this.maxBytes / 1024 / 1024)} MiB。日志从安装支持日志的版本后开始记录。` };
    });
    this.pending = capture.catch(error => { this.lastError = error.code || 'LOG_READ_FAILED'; });
    await capture; return result;
  }
}
