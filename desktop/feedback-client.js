import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { splitDiagnosticParts, DIAGNOSTIC_MAX_BYTES } from './diagnostic-log.js';
import { accountError } from './account-storage.js';

const hash = value => createHash('sha256').update(value).digest('hex');
export class FeedbackClient {
  constructor({ accountClient, diagnostics, directory, appInfo, context = () => ({}), onUpdate = () => {}, wait = delay }) {
    this.accountClient = accountClient; this.diagnostics = diagnostics; this.directory = directory;
    this.appInfo = appInfo; this.context = context; this.onUpdate = onUpdate; this.wait = wait;
    this.operation = null; this.stopping = false;
    this.state = { status: 'idle', progress: 0, uploadedBytes: 0, totalBytes: 0 };
  }
  emit(patch) { Object.assign(this.state, patch); try { this.onUpdate(structuredClone(this.state)); } catch {} }
  snapshot() { return structuredClone(this.state); }
  async save(filename, payload) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const tmp = `${filename}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 }); await rename(tmp, filename);
  }
  async request(action, input, userId) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.stopping) throw accountError('FEEDBACK_INTERRUPTED', '反馈上传已暂停，下次提交相同内容可继续。');
      try { return await this.accountClient.feedbackRequest(action, input, userId); }
      catch (error) {
        last = error;
        if (error.status < 500 && error.status !== 429 && error.code !== 'SERVICE_UNAVAILABLE') throw error;
        if (attempt < 2) await this.wait(2000 * (attempt + 1));
      }
    }
    throw last;
  }
  submit(input) {
    if (this.operation) return this.operation;
    this.stopping = false;
    this.operation = this.run(input).finally(() => { this.operation = null; });
    return this.operation;
  }
  async run(input) {
    try {
      if (!input || typeof input !== 'object') throw accountError('INVALID_FEEDBACK', '请填写问题描述。', 400);
      const title = String(input.title || '').trim(), description = String(input.description || '').trim();
      const category = ['download', 'audio', 'update', 'account', 'other'].includes(input.category) ? input.category : 'other';
      if (!title || title.length > 120 || description.length < 5 || description.length > 8000) throw accountError('INVALID_FEEDBACK', '标题最多 120 字，问题描述需为 5–8000 字。', 400);
      await this.accountClient.refresh();
      const account = this.accountClient.snapshot();
      if (!account.authenticated || !account.account?.user?.id) throw accountError('UNAUTHENTICATED', '请先登录软件账号再提交反馈；未登录也可以复制或导出日志。', 401);
      const userId = account.account.user.id;
      const key = hash(JSON.stringify({ userId, title, description, category }));
      const filename = path.join(this.directory, `${key}.json`);
      this.emit({ status: 'collecting', progress: 0, uploadedBytes: 0, totalBytes: 0, error: null, message: '正在准备完整诊断日志…' });
      let pending;
      try {
        const file = await lstat(filename);
        if (!file.isFile() || file.size > DIAGNOSTIC_MAX_BYTES * 2 + 200000) throw new Error('Invalid feedback cache');
        pending = JSON.parse(await readFile(filename, 'utf8'));
        if (pending.userId !== userId || pending.key !== key || hash(pending.text) !== pending.manifest.sha256) throw new Error('Invalid feedback snapshot');
      } catch (error) { if (error.code !== 'ENOENT') throw accountError('FEEDBACK_CACHE_INVALID', '未完成的反馈缓存无法校验，请先导出日志并联系管理员。'); }
      if (!pending) {
        await this.diagnostics.record('feedback.preparing', { category });
        const log = await this.diagnostics.snapshot(this.context());
        const parts = splitDiagnosticParts(log.text);
        pending = { key, userId, requestId: randomUUID(), title, description, category, text: log.text,
          appInfo: { version: this.appInfo.version, platform: this.appInfo.platform, arch: this.appInfo.arch },
          manifest: { partCount: parts.length, totalBytes: log.totalBytes, sha256: hash(log.text),
            parts: parts.map(content => ({ bytes: Buffer.byteLength(content), sha256: hash(content) })),
            firstTimestamp: log.oldestAt, lastTimestamp: log.newestAt, truncated: log.truncated } };
        await this.save(filename, pending);
      }
      const started = await this.request('feedback-begin', { requestId: pending.requestId, title, description, category,
        appVersion: pending.appInfo.version, platform: pending.appInfo.platform, arch: pending.appInfo.arch, log: pending.manifest }, userId);
      const feedbackId = started.feedback.id;
      this.emit({ status: 'uploading', feedbackId, totalBytes: pending.manifest.totalBytes, message: '正在上传诊断日志…' });
      if (started.feedback.status === 'uploading') {
        const chunks = splitDiagnosticParts(pending.text);
        let sent = 0;
        for (let index = 0; index < chunks.length; index++) {
          if (index) await this.wait(Math.max(2000, started.upload?.minPartIntervalMs || 0));
          await this.request('feedback-upload-part', { feedbackId, index, content: chunks[index], sha256: pending.manifest.parts[index].sha256 }, userId);
          sent += Buffer.byteLength(chunks[index]);
          this.emit({ uploadedBytes: sent, progress: Math.min(99, Math.floor(sent / pending.manifest.totalBytes * 100)) });
        }
      }
      const finished = await this.request('feedback-finalize', { feedbackId, requestId: pending.requestId }, userId);
      if (!finished.feedback || finished.feedback.status === 'uploading') throw accountError('FEEDBACK_NOT_COMMITTED', '反馈尚未确认保存，请重试。');
      await rm(filename, { force: true });
      await this.diagnostics.record('feedback.submitted', { feedbackId, bytes: pending.manifest.totalBytes });
      this.emit({ status: 'submitted', progress: 100, uploadedBytes: pending.manifest.totalBytes, feedbackId, message: '反馈与诊断日志已提交，管理员可查看。', error: null });
      return { ok: true, feedbackId };
    } catch (error) {
      const safe = { code: error.code || 'FEEDBACK_FAILED', message: error.message || '反馈提交失败，请重试或导出日志。' };
      await this.diagnostics.record('feedback.failed', { code: safe.code }, 'warn');
      this.emit({ status: 'error', error: safe, message: safe.message });
      return { ok: false, error: safe };
    }
  }
  async shutdown() { this.stopping = true; await this.operation; }
}
