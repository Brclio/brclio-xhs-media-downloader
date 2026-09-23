import { AccountError, fail } from './errors.js';

export function emptyState() {
  return { schemaVersion: 1, users: {}, sessions: {}, devices: {}, otps: {}, otpHistory: [], codes: {}, operations: {}, rateLimits: {}, audit: [], mailStatus: null, feedback: {}, feedbackRateLimits: {} };
}
function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.audit)) fail('STORAGE_INVALID', '业务数据格式异常，授权暂不可用。', 503);
  for (const key of ['users', 'sessions', 'devices', 'otps', 'codes', 'operations', 'rateLimits']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) fail('STORAGE_INVALID', '业务数据格式异常，授权暂不可用。', 503);
  }
  // Additive schema migration: deployed schemaVersion 1 accounts remain valid.
  for (const key of ['feedback', 'feedbackRateLimits']) {
    if (state[key] === undefined) state[key] = {};
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) fail('STORAGE_INVALID', '反馈数据格式异常，请联系管理员。', 503);
  }
  return state;
}

/** One authoritative file is the transaction boundary. Conflicts rerun validation on the new SHA. */
export class GithubStateStore {
  constructor({ owner, repo, token, branch = 'main', path = 'state/accounts.json', allowInitialize = false, fetchImpl = (...args) => fetch(...args), maxAttempts = 6, maxBytes = 900_000, timeoutMs = 10_000, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!owner || !repo || !token || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) fail('SERVICE_NOT_CONFIGURED', 'GitHub 数据存储尚未配置。', 503);
    if (!path || path.startsWith('/') || path.split('/').includes('..')) fail('SERVICE_NOT_CONFIGURED', '业务数据路径配置错误。', 503);
    Object.assign(this, { owner, repo, token, branch, path, allowInitialize, fetchImpl, maxAttempts, maxBytes, timeoutMs, delay });
    this.base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    this.contentUrl = `${this.base}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    this.privateCheckedAt = 0;
  }
  async request(url, method = 'GET', body) {
    try {
      return await this.fetchImpl(url, {
        method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Brclio-Account-Service', 'Cache-Control': 'no-cache', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        // Workers supports manual/follow, but not redirect:error. Every caller
        // rejects non-2xx responses, so manual also keeps credentials at GitHub.
        ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual',
      });
    } catch {
      fail(method === 'PUT' ? 'STORAGE_WRITE_UNCERTAIN' : 'STORAGE_UNAVAILABLE', method === 'PUT' ? '存储响应中断，操作结果尚未确认。请保留本次请求并刷新重试。' : 'GitHub 存储暂时不可用，请稍后重试。', 503);
    }
  }
  checkFailure(response) {
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') || response.headers.get('retry-after')) fail('STORAGE_RATE_LIMITED', 'GitHub 存储请求受限，请稍后重试。', 503);
    if (!response.ok) fail('STORAGE_UNAVAILABLE', 'GitHub 存储访问失败，请联系管理员。', 503);
  }
  async assertPrivate() {
    if (Date.now() - this.privateCheckedAt < 60_000) return;
    const response = await this.request(this.base);
    this.checkFailure(response);
    let repo;
    try { repo = await response.json(); } catch { fail('STORAGE_UNAVAILABLE', 'GitHub 仓库状态读取失败。', 503); }
    if (repo.private !== true) fail('STORAGE_NOT_PRIVATE', '业务数据仓库必须为私有仓库。', 503);
    this.privateCheckedAt = Date.now();
  }
  async read() {
    await this.assertPrivate();
    const response = await this.request(`${this.contentUrl}?ref=${encodeURIComponent(this.branch)}`);
    if (response.status === 404 && this.allowInitialize) return { state: emptyState(), sha: null };
    this.checkFailure(response);
    try {
      const file = await response.json();
      if (!file.sha || file.encoding !== 'base64' || typeof file.content !== 'string') fail('STORAGE_INVALID', '业务数据文件不可读取或过大。', 503);
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.length > this.maxBytes) fail('STORAGE_CAPACITY', '业务数据已达到安全容量限制，请联系管理员。', 503);
      return { state: validateState(JSON.parse(bytes.toString('utf8'))), sha: file.sha };
    } catch (error) {
      if (error instanceof AccountError) throw error;
      fail('STORAGE_INVALID', '业务数据读取失败，授权暂不可用。', 503);
    }
  }
  async transaction(mutate) {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const { state, sha } = await this.read();
      const result = await mutate(state);
      if (result?.changed === false) return result.value;
      const content = JSON.stringify(validateState(state));
      if (Buffer.byteLength(content) > this.maxBytes) fail('STORAGE_CAPACITY', '业务数据已达到安全容量限制，本次操作未保存。', 503);
      const response = await this.request(this.contentUrl, 'PUT', { message: 'Update account state [skip ci]', content: Buffer.from(content).toString('base64'), branch: this.branch, ...(sha ? { sha } : {}) });
      if (response.status === 409 || (!sha && response.status === 422)) {
        await this.delay(Math.min(40 * 2 ** attempt, 500) + Math.floor(Math.random() * 25));
        continue;
      }
      this.checkFailure(response);
      if (![200, 201].includes(response.status)) fail('STORAGE_WRITE_UNCERTAIN', 'GitHub 写入尚未确认，请使用相同请求重试。', 503);
      try {
        const confirmation = await response.json();
        if (!confirmation.content?.sha) fail('STORAGE_WRITE_UNCERTAIN', 'GitHub 写入确认不完整，请使用相同请求重试。', 503);
      } catch (error) {
        if (error instanceof AccountError) throw error;
        fail('STORAGE_WRITE_UNCERTAIN', 'GitHub 写入确认中断，请使用相同请求重试。', 503);
      }
      // An uncertain write is an error. The caller retries its durable operation ID to recover safely.
      return result?.value;
    }
    fail('STORAGE_CONFLICT', '同时操作较多，本次操作未确认，请使用相同请求重试。', 503);
  }

  feedbackPartUrl(feedbackId, index) {
    if (!/^[a-f0-9-]{36}$/.test(feedbackId) || !Number.isInteger(index) || index < 0 || index >= 64) fail('INVALID_FEEDBACK_PART', '反馈日志分块标识无效。');
    return `${this.base}/contents/feedback/${feedbackId}/part-${String(index).padStart(3, '0')}.ndjson`;
  }

  async readFeedbackPart(feedbackId, index, { allowMissing = false } = {}) {
    await this.assertPrivate();
    const response = await this.request(`${this.feedbackPartUrl(feedbackId, index)}?ref=${encodeURIComponent(this.branch)}`);
    if (response.status === 404 && allowMissing) return null;
    if (response.status === 404) fail('FEEDBACK_LOG_INCOMPLETE', '日志尚未全部上传，请使用原反馈重试。', 409);
    this.checkFailure(response);
    try {
      const file = await response.json();
      if (!file.sha || file.encoding !== 'base64' || typeof file.content !== 'string') fail('STORAGE_INVALID', '反馈日志文件格式异常。', 503);
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.length > 262_144) fail('STORAGE_INVALID', '反馈日志文件超过分块大小限制。', 503);
      return { content: bytes.toString('utf8'), bytes: bytes.length, blobSha: file.sha };
    } catch (error) {
      if (error instanceof AccountError) throw error;
      fail('STORAGE_INVALID', '反馈日志读取失败。', 503);
    }
  }

  async readFeedbackParts(feedbackId, count) {
    if (!Number.isInteger(count) || count < 1 || count > 64) fail('INVALID_FEEDBACK_PART', '日志分块数量无效。');
    // Validate the identifier before performing any network request.
    this.feedbackPartUrl(feedbackId, count - 1);
    await this.assertPrivate();
    const parts = [];
    // One GraphQL request reads up to 16 immutable files. A supported 64-part
    // finalization stays below Workers Free's 50 external subrequests.
    for (let start = 0; start < count; start += 16) {
      const end = Math.min(count, start + 16);
      const variables = { owner: this.owner, repo: this.repo };
      const declarations = ['$owner: String!', '$repo: String!'];
      const fields = [];
      for (let index = start; index < end; index++) {
        variables[`path${index}`] = `${this.branch}:feedback/${feedbackId}/part-${String(index).padStart(3, '0')}.ndjson`;
        declarations.push(`$path${index}: String!`);
        fields.push(`part${index}: object(expression: $path${index}) { ... on Blob { oid byteSize isBinary isTruncated text } }`);
      }
      const query = `query FeedbackParts(${declarations.join(', ')}) { repository(owner: $owner, name: $repo) { isPrivate ${fields.join(' ')} } }`;
      const response = await this.request('https://api.github.com/graphql', 'POST', { query, variables });
      this.checkFailure(response);
      let result;
      try { result = await response.json(); }
      catch { fail('STORAGE_UNAVAILABLE', '反馈日志读取失败。', 503); }
      if (result?.errors?.length) {
        const limited = result.errors.some(error => error?.type === 'RATE_LIMITED');
        fail(limited ? 'STORAGE_RATE_LIMITED' : 'STORAGE_UNAVAILABLE', limited ? 'GitHub 存储请求受限，请稍后重试。' : '反馈日志读取失败。', 503);
      }
      const repository = result?.data?.repository;
      if (!repository) fail('STORAGE_UNAVAILABLE', '反馈日志读取失败。', 503);
      if (repository.isPrivate !== true) fail('STORAGE_NOT_PRIVATE', '业务数据仓库必须为私有仓库。', 503);
      for (let index = start; index < end; index++) {
        const file = repository[`part${index}`];
        if (file === null) fail('FEEDBACK_LOG_INCOMPLETE', '日志尚未全部上传，请使用原反馈重试。', 409);
        if (!file || typeof file.oid !== 'string' || !file.oid || file.isBinary !== false || file.isTruncated !== false || typeof file.text !== 'string'
            || !Number.isInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > 262_144 || Buffer.byteLength(file.text) !== file.byteSize) {
          fail('STORAGE_INVALID', '反馈日志文件格式异常、内容不完整或超过分块大小限制。', 503);
        }
        parts.push({ content: file.text, bytes: file.byteSize, blobSha: file.oid });
      }
    }
    return parts;
  }

  async writeFeedbackPart(feedbackId, index, content) {
    if (typeof content !== 'string' || !content || Buffer.byteLength(content) > 262_144) fail('INVALID_FEEDBACK_PART', '反馈日志分块内容无效。');
    const url = this.feedbackPartUrl(feedbackId, index);
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const prior = await this.readFeedbackPart(feedbackId, index, { allowMissing: true });
      if (prior) {
        if (prior.content !== content) fail('FEEDBACK_PART_CONFLICT', '日志分块已存在且内容不同，请保留原快照重试。', 409);
        return { received: true, replayed: true };
      }
      const response = await this.request(url, 'PUT', { message: 'Store private feedback log [skip ci]', branch: this.branch, content: Buffer.from(content).toString('base64') });
      if ([409, 422].includes(response.status)) { await this.delay(Math.min(40 * 2 ** attempt, 500)); continue; }
      this.checkFailure(response);
      if (![200, 201].includes(response.status)) fail('STORAGE_WRITE_UNCERTAIN', '日志写入尚未确认，请重试原分块。', 503);
      try {
        const confirmation = await response.json();
        if (!confirmation.content?.sha) fail('STORAGE_WRITE_UNCERTAIN', '日志写入确认不完整，请重试原分块。', 503);
      } catch (error) {
        if (error instanceof AccountError) throw error;
        fail('STORAGE_WRITE_UNCERTAIN', '日志写入确认中断，请重试原分块。', 503);
      }
      return { received: true, replayed: false };
    }
    fail('STORAGE_CONFLICT', '日志写入发生并发冲突，请重试原分块。', 503);
  }
}
export function createGithubStore(env = process.env, options = {}) {
  return new GithubStateStore({ owner: env.AUTH_GITHUB_OWNER, repo: env.AUTH_GITHUB_REPO, token: env.AUTH_GITHUB_TOKEN, branch: env.AUTH_GITHUB_BRANCH || 'main', path: env.AUTH_GITHUB_PATH || 'state/accounts.json', allowInitialize: env.AUTH_ALLOW_INITIALIZE === 'true', ...options });
}
