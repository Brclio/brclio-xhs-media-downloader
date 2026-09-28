import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { sanitizeDiagnostic, containsDiagnosticSecrets } from '../../lib/diagnostic-sanitize.js';

export const FEEDBACK_MAX_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_PART_BYTES = 256 * 1024;
export const FEEDBACK_MAX_PARTS = 64;
export const FEEDBACK_PART_INTERVAL_MS = 2000;
export const FEEDBACK_REPLY_MAX_CHARS = 8000;
export const FEEDBACK_COMMENT_MAX_CHARS = 2000;
export const FEEDBACK_COMMENT_MAX_STATE_BYTES = 700_000;
const DAY = 86_400_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = value => new Date(value).toISOString();
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const statuses = ['new', 'in_progress', 'resolved', 'closed'];
const categories = ['download', 'audio', 'update', 'account', 'other'];
const hashPattern = /^[a-f0-9]{64}$/;
function requestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) fail('INVALID_REQUEST_ID', '反馈请求编号无效。');
  return value;
}
function text(value, min, max, label) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail('INVALID_FEEDBACK', `${label}长度不符合要求。`);
  return String(sanitizeDiagnostic(value.trim()));
}
// Preserve authored source; anonymous views apply separate redaction at read time.
function originalText(value, min, max, label) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail('INVALID_FEEDBACK', `${label}长度不符合要求。`);
  return value;
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
  const messages = feedback.messages || [], last = messages.at(-1);
  return { id: feedback.id, userId: feedback.userId, email: user?.email || '', title: feedback.title, description: full ? feedback.description : feedback.description.slice(0, 200), category: feedback.category || 'other', appVersion: feedback.appVersion, platform: feedback.platform, arch: feedback.arch || '', status: feedback.status, createdAt: feedback.createdAt, updatedAt: feedback.updatedAt, submittedAt: feedback.submittedAt || null, replyCount: messages.length, lastMessageAt: last?.createdAt || feedback.submittedAt || feedback.createdAt, lastMessageRole: last?.authorRole || 'user', log: full ? { ...log, parts: structuredClone(parts) } : log };
}
function publicMessage(message) {
  const { id, authorRole, authorId, content, createdAt } = message;
  return { id, authorRole, authorId, content, createdAt };
}
// Anonymous views use a separate allowlist. Never spread private feedback or messages.
function boardText(value) {
  return String(sanitizeDiagnostic(value))
    .replace(/\b(?:Brclio|XHS)-[a-f0-9]{40}\b/gi, '[REDACTED]')
    .replace(/(?:密码|验证码|激活码|会话令牌|访问令牌)\s*[:：=]\s*[^\s，。；,;]+/g, '[REDACTED]')
    .replace(/(?:手机号|手机号码|电话|联系方式|微信(?:号)?|QQ(?:号)?)\s*[:：=][^\r\n，。；,;]+/gi, '[CONTACT]')
    .replace(/\b(?:phone|telephone|mobile|wechat|contact)\s*[:=][^\r\n，。；,;]+/gi, '[CONTACT]')
    .replace(/(?<!\d)(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?!\d)/g, '[PHONE]');
}
function publicBoardFeedback(feedback, full = false) {
  const description = boardText(feedback.description);
  return { id: feedback.id, title: boardText(feedback.title), description: full ? description : description.slice(0, 200), category: categories.includes(feedback.category) ? feedback.category : 'other', status: feedback.status, createdAt: feedback.createdAt, updatedAt: feedback.updatedAt, submittedAt: feedback.submittedAt, commentCount: (feedback.comments || []).length };
}
function publicBoardComment(comment) {
  return { id: comment.id, authorRole: comment.authorRole === 'admin' ? 'admin' : 'user', content: boardText(comment.content), createdAt: comment.createdAt };
}
function boardPage(input) {
  const page = input.page === undefined ? 1 : input.page, pageSize = input.pageSize === undefined ? 20 : input.pageSize;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) fail('INVALID_FEEDBACK_FILTER', '分页参数无效。');
  return { page, pageSize };
}
function pageResults(items, pagination) {
  const { page, pageSize } = pagination;
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, totalPages: Math.ceil(items.length / pageSize) };
}

/** Log blobs are immutable; only a verified atomic state transition makes a feedback submitted. */
export function createFeedbackService({ store, now, authenticate, hash, operation, audit, isAdmin }) {
  const ensure = state => { state.feedback ||= {}; state.feedbackRateLimits ||= {}; };
  function get(state, id, user, admin = false) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) fail('FEEDBACK_NOT_FOUND', '没有找到该反馈。', 404);
    const feedback = own(state.feedback || {}, id);
    if (!feedback || (!admin && feedback.userId !== user.id)) fail('FEEDBACK_NOT_FOUND', '没有找到该反馈。', 404);
    return feedback;
  }
  function checkOwner(state, request, time) {
    const identity = authenticate(state, request, time);
    if (identity.session.client !== 'desktop') fail('DESKTOP_REQUIRED', '请通过桌面客户端提交反馈。', 403);
    return identity;
  }
  function checkBrowserOwner(state, request, time) {
    const identity = authenticate(state, request, time);
    if (identity.session.client !== 'browser') fail('BROWSER_REQUIRED', '请通过网页登录查看自己的反馈对话。', 403);
    return identity;
  }
  async function begin(request) {
    const input = request.input;
    const clean = { title: originalText(input.title, 1, 120, '问题标题'), description: originalText(input.description, 5, 8000, '问题说明'), category: input.category || 'other', appVersion: text(input.appVersion, 1, 50, '应用版本'), platform: input.platform, arch: input.arch || '', log: manifest(input.log) };
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
        // Before originalTextVersion 1, begin sanitized authored text before hashing.
        // Keep old pending snapshots resumable, without weakening exact matching for new records.
        const legacyHash = prior.originalTextVersion === undefined ? hash('feedback-input', JSON.stringify({ ...clean, title: text(input.title, 1, 120, '问题标题'), description: text(input.description, 5, 8000, '问题说明') })) : null;
        if (prior.inputHash !== inputHash && prior.inputHash !== legacyHash) fail('REQUEST_ID_REUSED', '该反馈请求编号已对应其他内容，请保留原快照重试。', 409);
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
      const feedback = { id, userId: user.id, ...clean, requestKey, inputHash, originalTextVersion: 1, messages: [], comments: [], status: 'uploading', createdAt: iso(time), updatedAt: iso(time), submittedAt: null };
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
    const validatePart = (file, index) => {
      const actual = validateFeedbackChunk(file.content), expected = feedback.log.parts[index];
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail('FEEDBACK_LOG_MISMATCH', '已保存日志与分块清单不一致，反馈尚未提交。', 503);
      parts[index] = file.content;
    };
    if (typeof store.readFeedbackParts === 'function') {
      const files = await store.readFeedbackParts(feedback.id, parts.length);
      if (!Array.isArray(files) || files.length !== parts.length) fail('FEEDBACK_LOG_INCOMPLETE', '日志尚未全部上传，请使用原反馈重试。', 409);
      files.forEach(validatePart);
    } else {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, parts.length) }, async () => {
        for (;;) {
          const index = next++; if (index >= parts.length) return;
          validatePart(await store.readFeedbackPart(feedback.id, index), index);
        }
      }));
    }
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
  async function reply(request) {
    const admin = request.action === 'admin-feedback-reply';
    const content = originalText(request.input.content, 1, FEEDBACK_REPLY_MAX_CHARS, '回复内容');
    const key = requestId(request.input.requestId), id = randomUUID();
    return store.transaction(state => {
      const time = now(), { user } = admin ? authenticate(state, request, time, true) : request.action === 'feedback-owner-reply' ? checkBrowserOwner(state, request, time) : checkOwner(state, request, time);
      const feedback = get(state, request.input.feedbackId, user, admin);
      if (!feedback.submittedAt) fail('FEEDBACK_NOT_SUBMITTED', '该反馈日志尚未上传完成，不能回复。', 409);
      const authorRole = admin ? 'admin' : 'user';
      const requestKey = hash('feedback-reply-request', `${authorRole}:${user.id}:${key}`);
      const inputHash = hash('feedback-reply-input', JSON.stringify({ feedbackId: feedback.id, content }));
      // The key is scoped to the author across threads, so accidental reuse cannot send a second message.
      for (const item of Object.values(state.feedback || {})) {
        const prior = (item.messages || []).find(message => message.requestKey === requestKey);
        if (!prior) continue;
        if (prior.inputHash !== inputHash) fail('REQUEST_ID_REUSED', '该回复请求编号已对应其他内容，请保留原文重试。', 409);
        return { changed: false, value: { feedback: publicFeedback(feedback, state.users[feedback.userId], true), message: publicMessage(prior), replayed: true } };
      }
      state.feedbackReplyRateLimits ||= {};
      for (const [rateKey, values] of Object.entries(state.feedbackReplyRateLimits)) {
        state.feedbackReplyRateLimits[rateKey] = values.filter(at => at > time - DAY);
        if (!state.feedbackReplyRateLimits[rateKey].length) delete state.feedbackReplyRateLimits[rateKey];
      }
      const userKey = hash('feedback-reply-user-rate', `${authorRole}:${user.id}`);
      const times = own(state.feedbackReplyRateLimits, userKey) || [];
      if (times.length >= (admin ? 500 : 100) || times.filter(at => at > time - 3_600_000).length >= (admin ? 100 : 20)) fail('FEEDBACK_REPLY_RATE_LIMITED', '回复次数已达上限，请稍后再试。已发送的原文可继续重试确认。', 429);
      (state.feedbackReplyRateLimits[userKey] ||= []).push(time);
      const message = { id, authorRole, authorId: user.id, content, createdAt: iso(time), requestKey, inputHash };
      (feedback.messages ||= []).push(message);
      feedback.updatedAt = iso(time);
      return { value: { feedback: publicFeedback(feedback, state.users[feedback.userId], true), message: publicMessage(message), replayed: false } };
    });
  }
  async function read(request) {
    const { state } = await store.read(), time = now(), admin = request.action.startsWith('admin-');
    const { user } = admin ? authenticate(state, request, time, true) : request.action === 'feedback-owner-detail' ? checkBrowserOwner(state, request, time) : checkOwner(state, request, time);
    if (request.action === 'feedback-mine' || request.action === 'admin-feedback') {
      const query = String(request.input.query || '').trim().toLowerCase(), status = String(request.input.status || '');
      const feedbacks = Object.values(state.feedback || {}).filter(f => (admin || f.userId === user.id) && (!status || f.status === status) && (!query || [f.id, f.userId, state.users[f.userId]?.email, f.title].some(v => String(v || '').toLowerCase().includes(query)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
      return { feedbacks: feedbacks.slice(0, 1000).map(f => publicFeedback(f, state.users[f.userId])), total: feedbacks.length };
    }
    const feedback = get(state, request.input.feedbackId, user, admin);
    if (['feedback-detail', 'feedback-owner-detail', 'admin-feedback-detail'].includes(request.action)) return { feedback: publicFeedback(feedback, state.users[feedback.userId], true), messages: (feedback.messages || []).map(publicMessage), ...(admin ? { history: state.audit.filter(a => a.targetId === feedback.id).slice(-200).reverse() } : {}) };
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
  function boardGet(state, id) {
    const feedback = get(state, id, null, true);
    if (!feedback.submittedAt || !statuses.includes(feedback.status)) fail('FEEDBACK_NOT_FOUND', '没有找到该反馈。', 404);
    return feedback;
  }
  async function boardRead(request) {
    const pagination = boardPage(request.input);
    const { state } = await store.read();
    if (request.action === 'feedback-public-list') {
      const { status = '', category = '', query = '' } = request.input;
      if (typeof status !== 'string' || (status && ![...statuses, 'all', 'unresolved'].includes(status)) || typeof category !== 'string' || (category && !categories.includes(category)) || typeof query !== 'string' || query.length > 120) fail('INVALID_FEEDBACK_FILTER', '反馈筛选条件无效。');
      const term = query.trim().toLowerCase();
      const submitted = Object.values(state.feedback || {}).filter(feedback => feedback.submittedAt && statuses.includes(feedback.status));
      const counts = { all: submitted.length, ...Object.fromEntries(statuses.map(status => [status, submitted.filter(feedback => feedback.status === status).length])) };
      counts.unresolved = counts.new + counts.in_progress;
      const rows = submitted
        .map(feedback => publicBoardFeedback(feedback, true))
        .filter(feedback => (!status || status === 'all' || (status === 'unresolved' ? ['new', 'in_progress'].includes(feedback.status) : feedback.status === status)) && (!category || feedback.category === category) && (!term || `${feedback.title}\n${feedback.description}`.toLowerCase().includes(term)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      const { items, ...meta } = pageResults(rows, pagination);
      return { feedbacks: items.map(feedback => ({ ...feedback, description: feedback.description.slice(0, 200) })), ...meta, counts };
    }
    const feedback = boardGet(state, request.input.feedbackId);
    const { items, ...meta } = pageResults(feedback.comments || [], pagination);
    return { feedback: publicBoardFeedback(feedback, true), comments: items.map(publicBoardComment), ...meta };
  }
  async function boardComment(request) {
    if (Object.keys(request.input).some(key => !['feedbackId', 'content', 'requestId', 'expectedUserId'].includes(key))) fail('INVALID_FEEDBACK_COMMENT', '评论仅支持问题编号、正文、请求编号和账号一致性校验，不支持回复评论或自定义身份。');
    const content = originalText(request.input.content, 1, FEEDBACK_COMMENT_MAX_CHARS, '评论内容');
    const key = requestId(request.input.requestId), id = randomUUID();
    return store.transaction(state => {
      const time = now(), { user, session } = authenticate(state, request, time);
      // A cookie can change in another tab after the author's last account check.
      // This is an assertion about the authenticated identity, never an author override.
      if ((session.client === 'browser' || Object.hasOwn(request.input, 'expectedUserId')) && (typeof request.input.expectedUserId !== 'string' || !request.input.expectedUserId.trim() || request.input.expectedUserId !== user.id)) fail('ACCOUNT_CHANGED', '登录账号已变化，请切回撰写评论时的账号后重试。', 409);
      const feedback = boardGet(state, request.input.feedbackId);
      const requestKey = hash('feedback-comment-request', `${user.id}:${key}`);
      const inputHash = hash('feedback-comment-input', JSON.stringify({ feedbackId: feedback.id, content }));
      for (const item of Object.values(state.feedback || {})) {
        const prior = (item.comments || []).find(comment => comment.requestKey === requestKey);
        if (!prior) continue;
        if (prior.inputHash !== inputHash) fail('REQUEST_ID_REUSED', '该评论请求编号已对应其他内容，请保留原文重试。', 409);
        return { changed: false, value: { feedback: publicBoardFeedback(feedback, true), comment: publicBoardComment(prior), replayed: true } };
      }
      state.feedbackCommentRateLimits ||= {};
      for (const [rateKey, values] of Object.entries(state.feedbackCommentRateLimits)) {
        state.feedbackCommentRateLimits[rateKey] = values.filter(at => at > time - DAY);
        if (!state.feedbackCommentRateLimits[rateKey].length) delete state.feedbackCommentRateLimits[rateKey];
      }
      const userKey = hash('feedback-comment-user-rate', user.id), times = own(state.feedbackCommentRateLimits, userKey) || [], globalTimes = state.feedbackCommentRateLimits.global || [];
      if (times.length >= 100 || times.filter(at => at > time - 3_600_000).length >= 20 || globalTimes.length >= 300 || globalTimes.filter(at => at > time - 3_600_000).length >= 100) fail('FEEDBACK_COMMENT_RATE_LIMITED', '评论次数已达上限，请稍后再试。原请求可继续重试确认。', 429);
      (state.feedbackCommentRateLimits[userKey] ||= []).push(time);
      (state.feedbackCommentRateLimits.global ||= []).push(time);
      const comment = { id, authorId: user.id, authorRole: isAdmin(user) ? 'admin' : 'user', content, createdAt: iso(time), requestKey, inputHash };
      (feedback.comments ||= []).push(comment);
      feedback.updatedAt = iso(time);
      // Public participation cannot consume the final 200 KB reserved for account operations.
      if (Buffer.byteLength(JSON.stringify(state)) > FEEDBACK_COMMENT_MAX_STATE_BYTES) fail('FEEDBACK_COMMENT_CAPACITY', '评论存储暂时已满，本次评论未保存，请稍后再试或联系管理员。', 503);
      return { value: { feedback: publicBoardFeedback(feedback, true), comment: publicBoardComment(comment), replayed: false } };
    });
  }
  return { async execute(request) {
    if (request.action === 'feedback-public-list' || request.action === 'feedback-public-detail') return boardRead(request);
    if (request.action === 'feedback-public-comment') return boardComment(request);
    if (request.action === 'feedback-begin') return begin(request);
    if (request.action === 'feedback-upload-part') return upload(request);
    if (request.action === 'feedback-finalize') return finalize(request);
    if (['feedback-reply', 'feedback-owner-reply', 'admin-feedback-reply'].includes(request.action)) return reply(request);
    if (request.action === 'admin-feedback-status') return adminStatus(request);
    return read(request);
  } };
}
