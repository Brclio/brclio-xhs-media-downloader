import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { sanitizeDiagnostic, containsDiagnosticSecrets } from '../../lib/diagnostic-sanitize.js';

export const FEEDBACK_MAX_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_PART_BYTES = 256 * 1024;
export const FEEDBACK_MAX_PARTS = 64;
export const FEEDBACK_PART_INTERVAL_MS = 2000;
const DAY = 86_400_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = value => new Date(value).toISOString();
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const statuses = ['new', 'in_progress', 'resolved', 'closed'];
const hashPattern = /^[a-f0-9]{64}$/;
function requestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) fail('INVALID_REQUEST_ID', '反馈请求编号无效。');
  return value;
}
function text(value, min, max, label) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail('INVALID_FEEDBACK', `${label}长度不符合要求。`);
  return String(sanitizeDiagnostic(value.trim()));
}
function manifest(input) {
  if (!input || !Number.isInteger(input.partCount) || input.partCount < 1 || input.partCount > FEEDBACK_MAX_PARTS || !Array.isArray(input.parts) || input.parts.length !== input.partCount) fail('INVALID_FEEDBACK_LOG', '日志分块数量无效。');
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > FEEDBACK_MAX_BYTES || !hashPattern.test(input.sha256 || '')) fail('INVALID_FEEDBACK_LOG', '日志总大小或校验值无效。');
  const parts = input.parts.map(part => {
    if (!part || !Number.isInteger(part.bytes) || part.bytes < 1 || part.bytes > FEEDBACK_PART_BYTES || !hashPattern.test(part.sha256 || '')) fail('INVALID_FEEDBACK_LOG', '日志分块大小或校验值无效。');
    return { bytes: part.bytes, sha256: part.sha256 };
  });
  if (parts.reduce((sum, part) => sum + part.bytes, 0) !== input.totalBytes) fail('INVALID_FEEDBACK_LOG', '日志总大小与分块清单不符。');
  const first = Date.parse(input.firstTimestamp), last = Date.parse(input.lastTimestamp);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last || typeof input.truncated !== 'boolean') fail('INVALID_FEEDBACK_LOG', '日志时间范围无效。');
  return { partCount: input.partCount, totalBytes: input.totalBytes, sha256: input.sha256, firstTimestamp: iso(first), lastTimestamp: iso(last), truncated: input.truncated, parts };
}
export function validateFeedbackChunk(content) {
  if (typeof content !== 'string' || !content || Buffer.byteLength(content) > FEEDBACK_PART_BYTES || !content.endsWith('\n')) fail('INVALID_FEEDBACK_LOG', '每个日志分块必须由完整 NDJSON 行组成，并以换行结束。');
  const lines = content.slice(0, -1).split('\n');
  for (const line of lines) {
    if (!line || Buffer.byteLength(line) > 32768) fail('INVALID_FEEDBACK_LOG', '日志记录为空或单行过长。');
    let entry;
    try { entry = JSON.parse(line); } catch { fail('INVALID_FEEDBACK_LOG', '日志不是有效的 NDJSON。'); }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['at', 'level', 'event', 'message', 'details'].includes(key)) || !Number.isFinite(Date.parse(entry.at)) || !['debug', 'info', 'warn', 'error'].includes(entry.level) || typeof entry.event !== 'string' || entry.event.length > 160 || !entry.event || (entry.message !== undefined && typeof entry.message !== 'string')) fail('INVALID_FEEDBACK_LOG', '日志记录结构无效。');
    if (containsDiagnosticSecrets(entry)) fail('FEEDBACK_LOG_SENSITIVE', '日志仍包含敏感信息，未上传。请更新客户端并重新生成脱敏日志。');
  }
  return { bytes: Buffer.byteLength(content), sha256: digest(content), lines: lines.length };
}
function publicFeedback(feedback, user, full = false) {
  const { parts, ...log } = feedback.log;
  return { id: feedback.id, userId: feedback.userId, email: user?.email || '', title: feedback.title, description: full ? feedback.description : feedback.description.slice(0, 200), category: feedback.category || 'other', appVersion: feedback.appVersion, platform: feedback.platform, arch: feedback.arch || '', status: feedback.status, createdAt: feedback.createdAt, updatedAt: feedback.updatedAt, submittedAt: feedback.submittedAt || null, log: full ? { ...log, parts: structuredClone(parts) } : log };
}

/** Log blobs are immutable; only a verified atomic state transition makes a feedback submitted. */
export function createFeedbackService({ store, now, authenticate, hash, operation, audit }) {
  const ensure = state => { state.feedback ||= {}; state.feedbackRateLimits ||= {}; };
  function get(state, id, user, admin = false) {
    const feedback = own(state.feedback || {}, id);
    if (!feedback || (!admin && feedback.userId !== user.id)) fail('FEEDBACK_NOT_FOUND', '没有找到该反馈。', 404);
    return feedback;
  }
  function checkOwner(state, request, time) {
    const identity = authenticate(state, request, time);
    if (identity.session.client !== 'desktop') fail('DESKTOP_REQUIRED', '请通过桌面客户端提交反馈。', 403);
    return identity;
  }
  async function begin(request) {
    const input = request.input;
    const clean = { title: text(input.title, 1, 120, '问题标题'), description: text(input.description, 5, 8000, '问题说明'), category: input.category || 'other', appVersion: text(input.appVersion, 1, 50, '应用版本'), platform: input.platform, arch: input.arch || '', log: manifest(input.log) };
    if (!['darwin', 'win32'].includes(clean.platform)) fail('INVALID_FEEDBACK', '反馈设备系统无效。');
    if (!['download', 'audio', 'update', 'account', 'other'].includes(clean.category) || !['', 'arm64', 'x64', 'ia32'].includes(clean.arch)) fail('INVALID_FEEDBACK', '反馈分类或设备架构无效。');
    const id = randomUUID(), key = requestId(input.requestId);
    return store.transaction(state => {
      ensure(state);
      const time = now(), { user } = checkOwner(state, request, time);
      const requestKey = hash('feedback-request', `${user.id}:${key}`);
      const inputHash = hash('feedback-input', JSON.stringify(clean));
      const prior = Object.values(state.feedback).find(item => item.requestKey === requestKey);
      if (prior) {
        if (prior.inputHash !== inputHash) fail('REQUEST_ID_REUSED', '该反馈请求编号已对应其他内容，请保留原快照重试。', 409);
        return { changed: false, value: { feedback: publicFeedback(prior, user, true), replayed: true, upload: { partBytes: FEEDBACK_PART_BYTES, maxBytes: FEEDBACK_MAX_BYTES, minPartIntervalMs: FEEDBACK_PART_INTERVAL_MS, partsReceived: [] } } };
      }
      for (const [rateKey, values] of Object.entries(state.feedbackRateLimits)) {
        state.feedbackRateLimits[rateKey] = values.filter(at => at > time - DAY);
        if (!state.feedbackRateLimits[rateKey].length) delete state.feedbackRateLimits[rateKey];
      }
      const userKey = hash('feedback-user-rate', user.id), userTimes = state.feedbackRateLimits[userKey] || [], globalTimes = state.feedbackRateLimits.global || [];
      if (userTimes.length >= 3 || globalTimes.filter(at => at > time - 3_600_000).length >= 20) fail('FEEDBACK_RATE_LIMITED', '反馈提交次数已达上限，请稍后再试；已有反馈可以继续上传。', 429);
      if (globalTimes.some(at => time - at < 60_000)) fail('FEEDBACK_RATE_LIMITED', '反馈服务正在处理其他提交，请 60 秒后重试。', 429);
      (state.feedbackRateLimits[userKey] ||= []).push(time); (state.feedbackRateLimits.global ||= []).push(time);
      const feedback = { id, userId: user.id, ...clean, requestKey, inputHash, status: 'uploading', createdAt: iso(time), updatedAt: iso(time), submittedAt: null };
      state.feedback[id] = feedback;
      return { value: { feedback: publicFeedback(feedback, user, true), replayed: false, upload: { partBytes: FEEDBACK_PART_BYTES, maxBytes: FEEDBACK_MAX_BYTES, minPartIntervalMs: FEEDBACK_PART_INTERVAL_MS, partsReceived: [] } } };
    });
  }
  async function upload(request) {
    const { state } = await store.read(), time = now(), { user } = checkOwner(state, request, time);
    const feedback = get(state, request.input.feedbackId, user), index = request.input.index;
    if (!Number.isInteger(index) || index < 0 || index >= feedback.log.partCount) fail('INVALID_FEEDBACK_PART', '日志分块序号无效。');
    const actual = validateFeedbackChunk(request.input.content), expected = feedback.log.parts[index];
    if (request.input.sha256 !== expected.sha256 || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail('FEEDBACK_LOG_MISMATCH', '日志分块与提交时锁定的清单不一致。');
    if (time < Date.parse(feedback.createdAt) + index * FEEDBACK_PART_INTERVAL_MS) fail('FEEDBACK_UPLOAD_TOO_FAST', '日志上传过快，请按 2 秒间隔串行重试。', 429);
    const result = await store.writeFeedbackPart(feedback.id, index, request.input.content);
    return { feedbackId: feedback.id, index, ...result };
  }
  async function finalize(request) {
    requestId(request.input.requestId);
    const { state } = await store.read(), { user } = checkOwner(state, request, now());
    const feedback = get(state, request.input.feedbackId, user);
    if (feedback.submittedAt) return { feedback: publicFeedback(feedback, user, true), replayed: true };
    const parts = Array(feedback.log.partCount);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, parts.length) }, async () => {
      for (;;) {
        const index = next++; if (index >= parts.length) return;
        const file = await store.readFeedbackPart(feedback.id, index);
        const actual = validateFeedbackChunk(file.content), expected = feedback.log.parts[index];
        if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail('FEEDBACK_LOG_MISMATCH', '已保存日志与分块清单不一致，反馈尚未提交。', 503);
        parts[index] = file.content;
      }
    }));
    const combined = parts.join('');
    if (Buffer.byteLength(combined) !== feedback.log.totalBytes || digest(combined) !== feedback.log.sha256) fail('FEEDBACK_LOG_MISMATCH', '完整日志校验失败，反馈尚未提交。');
    const records = combined.trimEnd().split('\n').map(line => JSON.parse(line));
    const retained = records.filter(record => record.event !== 'diagnostics.snapshot');
    const range = retained.length ? retained : records;
    const bounds = range.reduce((result, record) => {
      const at = Date.parse(record.at);
      return { first: Math.min(result.first, at), last: Math.max(result.last, at) };
    }, { first: Infinity, last: -Infinity });
    if (iso(bounds.first) !== feedback.log.firstTimestamp || iso(bounds.last) !== feedback.log.lastTimestamp) fail('FEEDBACK_LOG_MISMATCH', '完整日志时间范围与清单不一致。');
    return store.transaction(latest => {
      const time = now(), identity = checkOwner(latest, request, time), current = get(latest, feedback.id, identity.user);
      if (current.submittedAt) return { changed: false, value: { feedback: publicFeedback(current, identity.user, true), replayed: true } };
      if (current.inputHash !== feedback.inputHash) fail('FEEDBACK_LOG_MISMATCH', '反馈清单已变更，请联系管理员。', 409);
      current.status = 'new'; current.submittedAt = iso(time); current.updatedAt = iso(time);
      current.finalizeRequestHash = hash('feedback-finalize', request.input.requestId);
      return { value: { feedback: publicFeedback(current, identity.user, true), replayed: false } };
    });
  }
  async function adminStatus(request) {
    return store.transaction(state => {
      const time = now(), { user } = authenticate(state, request, time, true);
      return operation(state, user, request, () => {
        const feedback = get(state, request.input.feedbackId, user, true);
        if (!feedback.submittedAt) fail('FEEDBACK_NOT_SUBMITTED', '该反馈日志尚未上传完成，不能修改处理状态。', 409);
        if (!statuses.includes(request.input.status)) fail('INVALID_FEEDBACK_STATUS', '反馈处理状态无效。');
        const reason = text(request.input.reason, 2, 500, '处理说明'), before = { status: feedback.status };
        feedback.status = request.input.status; feedback.updatedAt = iso(time);
        audit(state, user, request.action, feedback.id, reason, before, { status: feedback.status }, time);
        return { feedback: publicFeedback(feedback, state.users[feedback.userId], true) };
      });
    });
  }
  async function read(request) {
    const { state } = await store.read(), time = now(), admin = request.action.startsWith('admin-');
    const { user } = admin ? authenticate(state, request, time, true) : checkOwner(state, request, time);
    if (request.action === 'feedback-mine' || request.action === 'admin-feedback') {
      const query = String(request.input.query || '').trim().toLowerCase(), status = String(request.input.status || '');
      const feedbacks = Object.values(state.feedback || {}).filter(f => (admin || f.userId === user.id) && (!status || f.status === status) && (!query || [f.id, f.userId, state.users[f.userId]?.email, f.title].some(v => String(v || '').toLowerCase().includes(query)))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { feedbacks: feedbacks.slice(0, 1000).map(f => publicFeedback(f, state.users[f.userId])), total: feedbacks.length };
    }
    const feedback = get(state, request.input.feedbackId, user, admin);
    if (request.action === 'admin-feedback-detail') return { feedback: publicFeedback(feedback, state.users[feedback.userId], true), history: state.audit.filter(a => a.targetId === feedback.id).slice(-200).reverse() };
    if (request.action === 'admin-feedback-part') {
      if (!feedback.submittedAt) fail('FEEDBACK_NOT_SUBMITTED', '该反馈日志尚未完整提交。', 409);
      const index = request.input.index;
      if (!Number.isInteger(index) || index < 0 || index >= feedback.log.partCount) fail('INVALID_FEEDBACK_PART', '日志分块序号无效。');
      const part = await store.readFeedbackPart(feedback.id, index), actual = validateFeedbackChunk(part.content), expected = feedback.log.parts[index];
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail('FEEDBACK_LOG_MISMATCH', '日志校验失败，请联系管理员。', 503);
      return { feedbackId: feedback.id, index, content: part.content, sha256: actual.sha256, bytes: actual.bytes };
    }
    fail('UNKNOWN_ACTION', '未知反馈操作。', 404);
  }
  return { async execute(request) {
    if (request.action === 'feedback-begin') return begin(request);
    if (request.action === 'feedback-upload-part') return upload(request);
    if (request.action === 'feedback-finalize') return finalize(request);
    if (request.action === 'admin-feedback-status') return adminStatus(request);
    return read(request);
  } };
}
