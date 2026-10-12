import { createHash } from 'node:crypto';
import { AccountError, fail } from './errors.js';
import { GithubStateStore } from './store.js';

const UUID = '[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}';
const MAX_PART_BYTES = 3 * 1024 * 1024;
const MAX_DIRECTORY_READS = 8;
const CONTENT_ACCEPT = 'application/vnd.github.object+json';
const RAW_ACCEPT = 'application/vnd.github.raw+json';
const sha1 = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const shard = id => `${id.slice(0, 2)}/${id.slice(2, 4)}`;
const pathUrl = path => path.split('/').map(encodeURIComponent).join('/');
const conflict = response => [409, 422].includes(response.status);
const EMPTY_BLOB_SHA = sha1(Buffer.alloc(0));

/** Share this budget with account-state reads/writes on the same HTTP request. */
export function avatarRequestFetch(fetchImpl = (...args) => fetch(...args), maxRequests = 48) {
  let requests = 0;
  return (...args) => {
    if (++requests > maxRequests) fail('AVATAR_STORAGE_BUSY', '头像存储较繁忙，请稍后重试；已上传分块会保留。', 503);
    return fetchImpl(...args);
  };
}

function keyPath(key) {
  let match;
  if (typeof key !== 'string' || key.length > 200) fail('AVATAR_STORAGE_KEY', '头像存储编号无效。');
  if ((match = key.match(new RegExp(`^originals/(${UUID})/part-\\d{3}$`)))) return `avatars/${key}`;
  if ((match = key.match(new RegExp(`^thumbnails/(${UUID})$`)))) return `avatars/thumbnails/${shard(match[1])}/${match[1]}`;
  if ((match = key.match(new RegExp(`^collection/(${UUID})\\.json$`)))) return `avatars/collection/${shard(match[1])}/${match[1]}.json`;
  if ((match = key.match(new RegExp(`^uploads/(${UUID})/(${UUID})\\.json$`)))) return `avatars/uploads/${shard(match[2])}/${match[1]}_${match[2]}.json`;
  fail('AVATAR_STORAGE_KEY', '头像存储编号无效。');
}
function listSpec(prefix) {
  if (prefix === 'collection/') return { folder: 'avatars/collection', kind: 'collection' };
  if (prefix === 'uploads/') return { folder: 'avatars/uploads', kind: 'uploads' };
  const match = prefix?.match(new RegExp(`^uploads/(${UUID})/$`));
  if (match) return { folder: 'avatars/uploads', kind: 'uploads', userId: match[1] };
  fail('AVATAR_STORAGE_PREFIX', '头像收藏分页参数无效。');
}
function fileKey(name, kind) {
  if (kind === 'collection' && new RegExp(`^${UUID}\\.json$`).test(name)) return `collection/${name}`;
  const match = name.match(new RegExp(`^(${UUID})_(${UUID})\\.json$`));
  if (kind === 'uploads' && match) return `uploads/${match[1]}/${match[2]}.json`;
  fail('AVATAR_STORAGE_INVALID', '头像收藏目录格式异常，请联系管理员。', 503);
}
function contentType(key, bytes) {
  if (key.startsWith('collection/') || key.startsWith('uploads/')) return 'application/json';
  if (key.startsWith('thumbnails/')) return bytes.subarray(0, 4).equals(Buffer.from('RIFF')) ? 'image/webp' : 'image/png';
  return 'application/octet-stream';
}
async function bytesFrom(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel().catch(() => {}); fail('AVATAR_STORAGE_INVALID', '头像存储分块大小异常。', 503); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

/** All persisted bytes live beneath avatars/ in the existing private data repo. */
export class GithubAvatarStorage extends GithubStateStore {
  constructor(options) { super(options); this.provider = 'github'; this.cleanupPageLimit = 2; }
  async assertPrivate() {
    // Instances are request-scoped. One private-repository check also keeps
    // slow 100 MiB transfers within the same bounded external-call budget.
    this.requestPrivateCheck ||= super.assertPrivate();
    return this.requestPrivateCheck;
  }

  async api(path, method = 'GET', body, accept = CONTENT_ACCEPT) {
    const url = `${this.base}/${path}`;
    try {
      return await this.fetchImpl(url, { method, headers: { Accept: accept, Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Brclio-Avatar-Service', 'Cache-Control': 'no-cache', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      if (error instanceof AccountError) throw error;
      fail(method === 'GET' ? 'AVATAR_STORAGE_UNAVAILABLE' : 'AVATAR_WRITE_UNCERTAIN', '头像存储响应中断，请保留原图并重试。', 503);
    }
  }
  async checked(response) {
    try { await this.checkFailure(response); }
    catch (error) {
      if (error.code === 'STORAGE_RATE_LIMITED') fail('AVATAR_STORAGE_RATE_LIMITED', '头像存储请求较多，请稍后重试；已上传内容会保留。', 503);
      throw error;
    }
    return response;
  }
  async readFile(path, { ref = this.branch, raw = true } = {}) {
    await this.assertPrivate();
    const response = await this.api(`contents/${pathUrl(path)}?ref=${encodeURIComponent(ref)}`, 'GET', undefined, raw ? RAW_ACCEPT : CONTENT_ACCEPT);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    await this.checked(response);
    if (!raw) {
      const value = await response.json();
      if (value.type !== 'file' || !/^[a-f\d]{40}$/.test(value.sha || '') || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_PART_BYTES) fail('AVATAR_STORAGE_INVALID', '头像存储文件格式异常。', 503);
      return value;
    }
    // raw on the authenticated API endpoint supports files over 1 MiB. Never
    // follow a download_url or forward the repository token to another host.
    return bytesFrom(response, MAX_PART_BYTES);
  }
  async get(key) {
    const bytes = await this.readFile(keyPath(key)); if (bytes === null) return null;
    const type = contentType(key, bytes), value = { key, size: bytes.length, httpMetadata: { contentType: type }, customMetadata: {} };
    return { ...value, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => bytes.toString('utf8') };
  }
  async head(key) {
    const object = await this.get(key); if (!object) return null;
    const bytes = Buffer.from(await object.arrayBuffer()); await object.body.cancel();
    return { ...object, etag: sha1(bytes), customMetadata: { sha256: sha256(bytes) } };
  }
  async put(key, value, options = {}) {
    const path = keyPath(key), bytes = Buffer.from(value);
    if (bytes.length > MAX_PART_BYTES) fail('AVATAR_STORAGE_INVALID', '头像存储分块过大。', 413);
    const blobSha = sha1(bytes);
    if (options.onlyIf && options.onlyIf.etagDoesNotMatch !== '*') fail('AVATAR_STORAGE_KEY', '头像条件写入参数无效。');
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const prior = await this.readFile(path, { raw: false });
      const reservedPart = options.onlyIf && (key.startsWith('originals/') || key.startsWith('thumbnails/'));
      if (reservedPart && !prior) fail('AVATAR_UPLOAD_EXPIRED', '头像上传已取消或过期，请重新上传。', 409);
      if (prior && options.onlyIf && !(reservedPart && prior.size === 0 && prior.sha === EMPTY_BLOB_SHA)) return null;
      if (prior?.sha === blobSha) return { key, size: bytes.length, etag: blobSha, ...options };
      const response = await this.api(`contents/${pathUrl(path)}`, 'PUT', { message: 'Store private avatar [skip ci]', branch: this.branch, content: bytes.toString('base64'), ...(prior ? { sha: prior.sha } : {}) });
      if (conflict(response)) { await response.body?.cancel(); await this.delay(Math.min(40 * 2 ** attempt, 500)); continue; }
      await this.checked(response);
      let result; try { result = await response.json(); } catch { fail('AVATAR_WRITE_UNCERTAIN', '头像写入结果尚未确认，请重试原分块。', 503); }
      if (![200, 201].includes(response.status) || result.content?.sha !== blobSha) fail('AVATAR_WRITE_UNCERTAIN', '头像写入结果尚未确认，请重试原分块。', 503);
      return { key, size: bytes.length, etag: blobSha, httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {} };
    }
    fail('AVATAR_STORAGE_CONFLICT', '头像存储发生并发冲突，请重试原分块。', 503);
  }
  async directory(path, ref = this.branch) {
    await this.assertPrivate();
    const response = await this.api(`contents/${pathUrl(path)}?ref=${encodeURIComponent(ref)}`);
    if (response.status === 404) { await response.body?.cancel(); return []; }
    await this.checked(response);
    const body = await response.json(), entries = Array.isArray(body) ? body : body.entries;
    // At GitHub's ceiling completeness is uncertain, so never claim this is a
    // complete collection. Two UUID hash levels spread files over 65,536 dirs.
    if (!Array.isArray(entries) || entries.length >= 1000) fail('AVATAR_STORAGE_DIRECTORY_LIMIT', '头像收藏分片达到安全容量，请联系管理员整理存储。', 503);
    return entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }
  async list({ prefix, limit = 100, cursor } = {}) {
    const spec = listSpec(prefix);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('AVATAR_STORAGE_PREFIX', '头像收藏分页参数无效。');
    let position = { first: '', second: '', after: '' };
    if (cursor) {
      try { const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (decoded.v !== 1 || decoded.prefix !== prefix) throw new Error(); position = decoded; }
      catch { fail('AVATAR_STORAGE_PREFIX', '头像收藏分页参数无效。'); }
      const filename = new RegExp(spec.kind === 'collection' ? `^${UUID}\\.json$` : `^${UUID}_${UUID}\\.json$`);
      if (!/^(?:[a-f\d]{2})?$/.test(position.first) || !/^(?:[a-f\d]{2})?$/.test(position.second) || typeof position.after !== 'string' || (position.after !== '' && !filename.test(position.after))) fail('AVATAR_STORAGE_PREFIX', '头像收藏分页参数无效。');
    }
    const objects = [], roots = await this.directory(spec.folder); let reads = 1;
    const page = (first, second, after = '') => ({ objects, truncated: true, cursor: Buffer.from(JSON.stringify({ v: 1, prefix, first, second, after })).toString('base64url') });
    for (const first of roots) {
      if (first.type !== 'dir' || !/^[a-f\d]{2}$/.test(first.name) || first.name < position.first) continue;
      if (reads >= MAX_DIRECTORY_READS) return page(first.name, '');
      const children = await this.directory(`${spec.folder}/${first.name}`); reads++;
      for (const second of children) {
        if (second.type !== 'dir' || !/^[a-f\d]{2}$/.test(second.name) || (first.name === position.first && second.name < position.second)) continue;
        if (reads >= MAX_DIRECTORY_READS) return page(first.name, second.name);
        const files = await this.directory(`${spec.folder}/${first.name}/${second.name}`); reads++;
        for (const file of files) {
          if (file.type !== 'file' || (first.name === position.first && second.name === position.second && file.name <= position.after)) continue;
          const key = fileKey(file.name, spec.kind);
          if (!key.startsWith(prefix)) continue;
          if (keyPath(key) !== `${spec.folder}/${first.name}/${second.name}/${file.name}`) fail('AVATAR_STORAGE_INVALID', '头像收藏分片位置异常。', 503);
          objects.push({ key, size: file.size, etag: file.sha });
          if (objects.length >= limit) return page(first.name, second.name, file.name);
        }
      }
    }
    return { objects, truncated: false };
  }
  async delete(value) {
    const keys = Array.isArray(value) ? value : [value];
    // Success only removes one small pending manifest. Keep ordinary deletion
    // serial, as required by the Contents API's branch concurrency semantics.
    for (const key of keys) {
      const path = keyPath(key);
      let deleted = false;
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        const prior = await this.readFile(path, { raw: false }); if (!prior) { deleted = true; break; }
        const response = await this.api(`contents/${pathUrl(path)}`, 'DELETE', { message: 'Remove completed avatar upload marker [skip ci]', branch: this.branch, sha: prior.sha });
        if (conflict(response)) { await response.body?.cancel(); await this.delay(Math.min(40 * 2 ** attempt, 500)); continue; }
        await this.checked(response); await response.body?.cancel(); deleted = true; break;
      }
      if (!deleted) fail('AVATAR_STORAGE_CONFLICT', '头像上传标记删除尚未确认，请稍后重试。', 503);
    }
  }
  async treeCommit(snapshot) {
    await this.assertPrivate();
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const ref = await (await this.checked(await this.api(`git/ref/heads/${pathUrl(this.branch)}`))).json();
      const commitSha = ref.object?.sha;
      if (!/^[a-f\d]{40}$/.test(commitSha || '')) fail('AVATAR_STORAGE_INVALID', '头像存储分支异常。', 503);
      const change = await snapshot(commitSha);
      if (!change.tree?.length) return change.result;
      const commit = await (await this.checked(await this.api(`git/commits/${commitSha}`))).json();
      if (!/^[a-f\d]{40}$/.test(commit.tree?.sha || '')) fail('AVATAR_STORAGE_INVALID', '头像存储目录异常。', 503);
      const tree = await (await this.checked(await this.api('git/trees', 'POST', { base_tree: commit.tree.sha, tree: change.tree }))).json();
      if (!/^[a-f\d]{40}$/.test(tree.sha || '')) fail('AVATAR_WRITE_UNCERTAIN', '头像目录写入尚未确认，请稍后重试。', 503);
      const next = await (await this.checked(await this.api('git/commits', 'POST', { message: change.message, tree: tree.sha, parents: [commitSha] }))).json();
      if (!/^[a-f\d]{40}$/.test(next.sha || '')) fail('AVATAR_WRITE_UNCERTAIN', '头像提交尚未确认，请稍后重试。', 503);
      const updated = await this.api(`git/refs/heads/${pathUrl(this.branch)}`, 'PATCH', { sha: next.sha, force: false });
      if (conflict(updated)) { await updated.body?.cancel(); await this.delay(Math.min(40 * 2 ** attempt, 500)); continue; }
      await this.checked(updated); await updated.body?.cancel(); return change.result;
    }
    fail('AVATAR_STORAGE_CONFLICT', '头像存储发生并发冲突，将保留原记录稍后重试。', 503);
  }
  async beginUpload(manifest) {
    const pending = keyPath(`uploads/${manifest.userId}/${manifest.id}.json`);
    const originals = Array.from({ length: manifest.partCount }, (_, index) => keyPath(`originals/${manifest.id}/part-${String(index).padStart(3, '0')}`));
    return this.treeCommit(async () => ({ message: 'Reserve private avatar upload [skip ci]', result: { reserved: true }, tree: [
      { path: pending, mode: '100644', type: 'blob', content: JSON.stringify(manifest) },
      ...[...originals, keyPath(`thumbnails/${manifest.id}`)].map(path => ({ path, mode: '100644', type: 'blob', content: '' })),
    ] }));
  }
  async completeUpload(manifest) {
    const pending = keyPath(`uploads/${manifest.userId}/${manifest.id}.json`), collection = keyPath(`collection/${manifest.id}.json`);
    return this.treeCommit(async commitSha => {
      const marker = await this.readFile(pending, { ref: commitSha });
      if (!marker) {
        const prior = await this.readFile(collection, { ref: commitSha });
        if (prior && JSON.parse(prior.toString('utf8')).sha256 === manifest.sha256) return { result: { collected: true, replayed: true } };
        fail('AVATAR_UPLOAD_EXPIRED', '头像上传已取消或过期，请重新上传。', 409);
      }
      const current = JSON.parse(marker.toString('utf8'));
      if (current.expiresAt < Date.now() || current.userId !== manifest.userId || current.sessionHash !== manifest.sessionHash) fail('AVATAR_UPLOAD_EXPIRED', '头像上传已取消或过期，请重新上传。', 409);
      return { message: 'Collect private avatar original [skip ci]', result: { collected: true }, tree: [
        { path: collection, mode: '100644', type: 'blob', content: JSON.stringify(manifest) },
        { path: pending, mode: '100644', type: 'blob', sha: null },
      ] };
    });
  }
  async deleteIncomplete(manifest) {
    // A single Git commit removes every unfinished binary. The collection
    // guard is read at that same commit; a concurrent completion changes the
    // branch and forces revalidation before a ref CAS can succeed.
    return this.treeCommit(async commitSha => {
      if (await this.readFile(keyPath(`collection/${manifest.id}.json`), { ref: commitSha, raw: false })) return { result: { retained: true } };
      const originalPath = `avatars/originals/${manifest.id}`;
      const files = await this.directory(originalPath, commitSha);
      const paths = files.filter(file => file.type === 'file' && /^part-\d{3}$/.test(file.name)).map(file => `${originalPath}/${file.name}`);
      for (const key of [`thumbnails/${manifest.id}`, `uploads/${manifest.userId}/${manifest.id}.json`]) {
        const path = keyPath(key); if (await this.readFile(path, { ref: commitSha, raw: false })) paths.push(path);
      }
      return { message: 'Remove expired unfinished avatar upload [skip ci]', result: { deleted: true }, tree: paths.map(path => ({ path, mode: '100644', type: 'blob', sha: null })) };
    });
  }
  async getCleanupCursor() {
    const bytes = await this.readFile('avatars/system/cleanup.json');
    if (!bytes) return null;
    try { const value = JSON.parse(bytes.toString('utf8')); return typeof value.cursor === 'string' ? value.cursor : null; }
    catch { fail('AVATAR_STORAGE_INVALID', '头像清理进度格式异常。', 503); }
  }
  async setCleanupCursor(cursor) {
    const path = 'avatars/system/cleanup.json', bytes = Buffer.from(JSON.stringify({ cursor: cursor || null })), content = bytes.toString('base64');
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const prior = await this.readFile(path, { raw: false });
      if ((!prior && !cursor) || prior?.sha === sha1(bytes)) return;
      const response = await this.api(`contents/${pathUrl(path)}`, 'PUT', { message: 'Advance private avatar cleanup cursor [skip ci]', branch: this.branch, content, ...(prior ? { sha: prior.sha } : {}) });
      if (conflict(response)) { await response.body?.cancel(); continue; }
      await this.checked(response); await response.body?.cancel(); return;
    }
    fail('AVATAR_STORAGE_CONFLICT', '头像清理进度尚未确认，将稍后重试。', 503);
  }
}

export function getAvatarStorage(env = process.env, options = {}) {
  if (!env?.AUTH_GITHUB_OWNER || !env.AUTH_GITHUB_REPO || !env.AUTH_GITHUB_TOKEN) return null;
  return new GithubAvatarStorage({ owner: env.AUTH_GITHUB_OWNER, repo: env.AUTH_GITHUB_REPO, token: env.AUTH_GITHUB_TOKEN, branch: env.AUTH_GITHUB_BRANCH || 'main',
    timeoutMs: 20_000, fetchImpl: avatarRequestFetch(), ...options });
}
