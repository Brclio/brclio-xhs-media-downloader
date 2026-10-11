import { parseNoteHtml } from '../lib/xhs.js';

/** Per-owner Browser Run lifecycle. The caller routes one unguessable token to
 * one DO and authorizes it again after eviction. No HTML, cookies or Live View
 * URLs persist. The private sourceURL may contain a share query and is kept only
 * in temporary lifecycle storage, deleted on close (180s session deadline). */
export const BROWSER_SESSION_KEY = 'browser-session';
export const BROWSER_SESSION_TTL_MS = 180_000;
export const MAX_BROWSER_HTML_BYTES = 6 * 1024 * 1024;
const CLEANUP_GRACE_MS = 60_000;
const CALL_TIMEOUT_MS = 5_000;
const MAX_WIRE_CHARS = 8 * 1024 * 1024;
const GUARDRAILS = Object.freeze(['xiaohongshu.com', '*.xiaohongshu.com',
  'xhslink.com', '*.xhslink.com', 'xhslink.cn', '*.xhslink.cn', 'xhscdn.com', '*.xhscdn.com']);
// This expression is constant, never supplied by a request. Limit before CDP transfer,
// then enforce the actual UTF-8 byte limit again in the Worker.
const SNAPSHOT = `(() => { const html = document.documentElement?.outerHTML || ''; return { finalUrl: location.href, html: html.length > 6291456 ? null : html }; })()`;
const NOTE_HOSTS = new Set(['xiaohongshu.com', 'www.xiaohongshu.com']);
const LINK_HOSTS = new Set(['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);
const CAPTCHA_TITLES = new Set(['小红书安全验证', '小红书 - 安全验证', '安全验证 - 小红书']);
const LOGIN_TITLES = new Set(['小红书登录', '小红书 - 登录', '登录 - 小红书']);
const DIAGNOSTIC_HOSTS = new Set(['apex', 'www', 'shortlink', 'other']);
const DIAGNOSTIC_PATHS = new Set(['note', 'captcha', 'login', 'shortlink', 'root', 'error', 'other', 'blank']);
const brandedTitle = (html, titles) => titles.has(/<title\b[^>]*>([^<]{0,160})<\/title\s*>/i.exec(html)?.[1]?.trim());
function safeDiagnostic(value) {
  if (!value || !DIAGNOSTIC_HOSTS.has(value.finalLocation?.hostname)
    || !DIAGNOSTIC_PATHS.has(value.finalLocation?.pathClass)
    || !Number.isInteger(value.htmlBytes) || value.htmlBytes < 0 || value.htmlBytes > MAX_WIRE_CHARS * 3
    || typeof value.brandedCaptcha !== 'boolean' || typeof value.brandedLogin !== 'boolean') return undefined;
  return { finalLocation: { hostname: value.finalLocation.hostname, pathClass: value.finalLocation.pathClass },
    htmlBytes: value.htmlBytes, brandedCaptcha: value.brandedCaptcha, brandedLogin: value.brandedLogin };
}
function pageDiagnostic(page) {
  let url;
  try { url = new URL(page.finalUrl); } catch { /* Invalid locations retain only the fixed other class. */ }
  const hostname = url?.hostname === 'xiaohongshu.com' ? 'apex' : url?.hostname === 'www.xiaohongshu.com' ? 'www'
    : LINK_HOSTS.has(url?.hostname) ? 'shortlink' : 'other';
  const path = url?.pathname || '';
  const pathClass = page.finalUrl === 'about:blank' ? 'blank'
    : (url && /^(?:chrome-error:|edge-error:)$/.test(url.protocol)) || /^about:(?:neterror|certerror)/.test(page.finalUrl) ? 'error'
      : url && noteFromURL(url) ? 'note'
        : /(?:^|\/)captcha(?:\/|$)/i.test(path) ? 'captcha'
          : /(?:^|\/)(?:login|signin|website-login)(?:\/|$)/i.test(path) ? 'login'
            : hostname === 'shortlink' ? 'shortlink' : path === '/' ? 'root'
              : /(?:^|\/)(?:error|404|403|500)(?:\/|$)/i.test(path) ? 'error' : 'other';
  const html = typeof page.html === 'string' ? page.html : '';
  return safeDiagnostic({ finalLocation: { hostname, pathClass }, htmlBytes: new TextEncoder().encode(html).byteLength,
    brandedCaptcha: brandedTitle(html, CAPTCHA_TITLES), brandedLogin: brandedTitle(html, LOGIN_TITLES) });
}

const SAFE_CODES = new Set(['BROWSER_OWNER_REQUIRED', 'BROWSER_OWNER_REJECTED', 'BROWSER_PAGE_REJECTED',
  'BROWSER_INPUT_REJECTED', 'BROWSER_NOTE_MISMATCH', 'BROWSER_CANCELLED', 'BROWSER_EXPIRED',
  'BROWSER_TIMEOUT', 'BROWSER_STORAGE', 'BROWSER_CLOSE_FAILED', 'BROWSER_CONNECT_FAILED',
  'BROWSER_CDP_PROTOCOL', 'BROWSER_CDP_FAILED', 'BROWSER_HTML_TOO_LARGE', 'BROWSER_PAGE_UNAVAILABLE',
  'BROWSER_LIVE_VIEW_FAILED', 'BROWSER_LIVE_VIEW_INVALID', 'BROWSER_FAILED', 'BROWSER_NOT_READY',
  'BROWSER_ACQUIRE_FAILED', 'BROWSER_TARGET_FAILED', 'BROWSER_NOT_FOUND']);
export class BrowserSessionError extends Error {
  constructor(code, closed = false, diagnostic) {
    code = SAFE_CODES.has(code) ? code : 'BROWSER_FAILED';
    super(code); this.name = 'BrowserSessionError'; this.code = code; this.closed = closed === true;
    const projected = safeDiagnostic(diagnostic);
    if (projected) this.diagnostic = projected;
  }
}
const fail = code => { throw new BrowserSessionError(code); };
const opaqueId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function pageURL(value) {
  if (typeof value !== 'string' || value.length > 8192) fail('BROWSER_PAGE_REJECTED');
  let url;
  try { url = new URL(value); } catch { fail('BROWSER_PAGE_REJECTED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || (!NOTE_HOSTS.has(url.hostname) && !LINK_HOSTS.has(url.hostname))) fail('BROWSER_PAGE_REJECTED');
  url.hash = '';
  return url;
}
const noteFromURL = url => NOTE_HOSTS.has(url.hostname)
  ? /^(?:\/explore\/|\/discovery\/item\/)([a-f\d]{24})\/?$/i.exec(url.pathname)?.[1].toLowerCase() || null : null;
const isCaptcha = (url, html) => NOTE_HOSTS.has(url.hostname) && (
  /(?:^|\/)captcha(?:\/|$)/i.test(url.pathname)
  || brandedTitle(html, CAPTCHA_TITLES));
const isLogin = (url, html) => /(?:^|\/)(?:login|signin|website-login)(?:\/|$)/i.test(url.pathname)
  || brandedTitle(html, LOGIN_TITLES);
function ready(html, noteId) {
  if (new RegExp(`["']${noteId}["']\\s*:|["'](?:noteId|note_id|itemId|item_id)["']\\s*:\\s*["']${noteId}["']`).test(html)) return true;
  // Generic INITIAL_STATE or recommendations are not evidence of hydration for
  // this note. The existing pure parser validates any primary-media fallback.
  if (!/<meta\b[^>]*(?:og:image|og:video)/i.test(html)) return false;
  try {
    const parsed = parseNoteHtml(html, { noteId });
    return Boolean(parsed.images.length || parsed.videos.length || parsed.originalVideos?.length);
  } catch { return false; }
}

/** authorizeToken is mandatory; it must compare this DO's id to idFromName(token).
 * clock/sleep and smaller timeouts support deterministic mock tests only. */
export class BrowserSessionManager {
  constructor(state, browser, { authorizeToken, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    callTimeoutMs = CALL_TIMEOUT_MS, waitMs = 12_000, pollMs = 250 } = {}) {
    if (typeof authorizeToken !== 'function') fail('BROWSER_OWNER_REQUIRED');
    this.state = state; this.browser = browser; this.authorizeToken = authorizeToken;
    this.now = now; this.sleep = sleep;
    this.callTimeoutMs = Math.max(1, Math.min(CALL_TIMEOUT_MS, callTimeoutMs));
    this.waitMs = Math.max(1, Math.min(12_000, waitMs));
    this.pollMs = Math.max(1, Math.min(250, pollMs));
    this.tail = Promise.resolve(); this.cancelEpoch = 0;
  }
  _lock(action) { const result = this.tail.then(action); this.tail = result.catch(() => {}); return result; }
  async _authorize(token) {
    if (typeof token !== 'string' || !/^[a-f\d]{64}$/i.test(token)) fail('BROWSER_OWNER_REJECTED');
    try { if (await this.authorizeToken(token) !== true) fail('BROWSER_OWNER_REJECTED'); }
    catch { fail('BROWSER_OWNER_REJECTED'); }
  }
  _check(record, epoch) {
    if (epoch !== this.cancelEpoch) fail('BROWSER_CANCELLED');
    if (this.now() >= record.deadline) fail('BROWSER_EXPIRED');
  }
  _bounded(promise, milliseconds, code = 'BROWSER_TIMEOUT', onLate) {
    let done = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { done = true; reject(new BrowserSessionError(code)); }, Math.max(1, milliseconds));
      Promise.resolve(promise).then(value => {
        if (done) { if (onLate) Promise.resolve().then(() => onLate(value)).catch(() => {}); return; }
        done = true; clearTimeout(timer); resolve(value);
      }, error => { if (!done) { done = true; clearTimeout(timer); reject(error instanceof BrowserSessionError ? error : new BrowserSessionError(code)); } });
    });
  }
  async _call(action, until, code, onLate) {
    const remaining = Math.min(this.callTimeoutMs, until - this.now());
    if (remaining <= 0) fail('BROWSER_TIMEOUT');
    return this._bounded(Promise.resolve().then(action), remaining, code, onLate);
  }
  async _stored() {
    try { return await this.state.storage.get(BROWSER_SESSION_KEY); } catch { fail('BROWSER_STORAGE'); }
  }
  async _put(record) {
    // Explicit projection keeps all persistent data inside this six-field contract.
    const saved = Object.fromEntries(['sessionId', 'targetId', 'deadline', 'engine', 'noteId', 'sourceURL'].map(key => [key, record[key]]));
    try { await this.state.storage.put(BROWSER_SESSION_KEY, saved); } catch { fail('BROWSER_STORAGE'); }
  }
  async _alarmAt(time) {
    try { await this.state.storage.setAlarm(time); } catch { fail('BROWSER_STORAGE'); }
  }
  async _delete() {
    await this.state.storage.delete(BROWSER_SESSION_KEY);
    await this.state.storage.deleteAlarm();
  }
  async _close(record) {
    // Expire before the close attempt: a failed close can never be resumed.
    record.deadline = Math.min(record.deadline, this.now());
    try { await this._put(record); } catch { /* Still close the remote resource. */ }
    let closed = false;
    const cleanupUntil = record.deadline + CLEANUP_GRACE_MS;
    const closeUntil = Math.min(this.now() + this.callTimeoutMs, cleanupUntil);
    if (record.sessionId && this.now() < cleanupUntil) {
      try {
        const result = await this._call(() => this.browser.closeSession(record.sessionId), closeUntil, 'BROWSER_CLOSE_FAILED');
        closed = result === 'closed' || result?.status === 'closed' || result?.state === 'closed';
        if (!closed && typeof this.browser.getSession === 'function') {
          const current = await this._call(() => this.browser.getSession(record.sessionId), closeUntil, 'BROWSER_CLOSE_FAILED');
          closed = current === null || current?.status === 'closed' || current?.state === 'closed';
        }
      } catch { /* Retain only expired lifecycle metadata for bounded alarm retries. */ }
    }
    if (closed || this.now() >= record.deadline + CLEANUP_GRACE_MS) {
      try { await this._delete(); } catch {
        try { await this._alarmAt(this.now() + 10_000); } catch { /* Provider inactivity is the final fallback. */ }
      }
    } else {
      try { await this._put(record); await this._alarmAt(Math.min(this.now() + 10_000, record.deadline + CLEANUP_GRACE_MS)); }
      catch { /* keepAlive is bounded even if storage is unavailable. */ }
    }
    return closed;
  }
  async _lateAcquire(value, expired) {
    if (!opaqueId(value?.sessionId)) return;
    return this._lock(async () => {
      try {
        const current = await this._stored();
        if (current && !current.sessionId && current.deadline === expired.deadline
          && current.engine === expired.engine && current.sourceURL === expired.sourceURL) {
          current.sessionId = value.sessionId; await this._put(current); await this._close(current); return;
        }
        await this._call(() => this.browser.closeSession(value.sessionId), this.now() + this.callTimeoutMs, 'BROWSER_CLOSE_FAILED');
      } catch { /* An acquisition that outlives local cleanup still has bounded inactivity. */ }
    });
  }
  async _connect(record, until, epoch) {
    this._check(record, epoch);
    const connection = await this._call(() => this.browser.connectSession(record.sessionId, { targetId: record.targetId }), until, 'BROWSER_CONNECT_FAILED');
    this._check(record, epoch);
    const response = await this._call(() => connection.webSocket.fetch('https://browser-binding.invalid', { headers: { Upgrade: 'websocket' } }), until,
      'BROWSER_CONNECT_FAILED', late => { try { late?.webSocket?.close(); } catch { /* Discard a late socket. */ } });
    const socket = response?.webSocket;
    if (!socket || typeof socket.addEventListener !== 'function') fail('BROWSER_CONNECT_FAILED');
    let nextId = 0, disposed = false;
    const pending = new Map();
    const rejectAll = code => { for (const item of pending.values()) item.reject(new BrowserSessionError(code)); pending.clear(); };
    const message = event => {
      if (typeof event.data !== 'string' || event.data.length > MAX_WIRE_CHARS) { rejectAll('BROWSER_CDP_PROTOCOL'); return; }
      let data;
      try { data = JSON.parse(event.data); } catch { rejectAll('BROWSER_CDP_PROTOCOL'); return; }
      const item = pending.get(data?.id);
      if (!item) return;
      pending.delete(data.id);
      if (data.error) item.reject(new BrowserSessionError('BROWSER_CDP_FAILED'));
      else item.resolve(data.result);
    };
    const closed = () => rejectAll('BROWSER_CONNECT_FAILED');
    socket.addEventListener('message', message); socket.addEventListener('close', closed); socket.addEventListener('error', closed);
    try { socket.accept(); } catch { rejectAll('BROWSER_CONNECT_FAILED');
      socket.removeEventListener('message', message); socket.removeEventListener('close', closed); socket.removeEventListener('error', closed);
      try { socket.close(); } catch { /* No active connection. */ }
      fail('BROWSER_CONNECT_FAILED');
    }
    const dispose = () => {
      if (disposed) return;
      disposed = true; rejectAll('BROWSER_CONNECT_FAILED');
      socket.removeEventListener('message', message); socket.removeEventListener('close', closed); socket.removeEventListener('error', closed);
      try { socket.close(); } catch { /* Remote lifecycle is closed separately. */ }
    };
    return { dispose, evaluate: async () => {
      this._check(record, epoch);
      const id = ++nextId;
      const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      // Install rejection handling before send, which can synchronously fail.
      const result = this._call(() => reply, until, 'BROWSER_TIMEOUT');
      try { socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        expression: SNAPSHOT, returnByValue: true, awaitPromise: false,
      } })); } catch { pending.get(id)?.reject(new BrowserSessionError('BROWSER_CONNECT_FAILED')); }
      try { return await result; } finally { pending.delete(id); }
    } };
  }
  async _poll(record, epoch, until) {
    const cdp = await this._connect(record, until, epoch);
    let lastPage, diagnostic;
    try {
      while (this.now() < until) {
        this._check(record, epoch);
        const result = await cdp.evaluate();
        this._check(record, epoch);
        if (result?.exceptionDetails || !result?.result || result.result.type !== 'object') fail('BROWSER_CDP_FAILED');
        const page = result.result.value;
        if (page && typeof page === 'object') diagnostic = pageDiagnostic(page);
        if (!page || page.html === null) fail('BROWSER_HTML_TOO_LARGE');
        if (typeof page.html !== 'string' || new TextEncoder().encode(page.html).byteLength > MAX_BROWSER_HTML_BYTES) fail('BROWSER_HTML_TOO_LARGE');
        // A new target may still be blank while its already validated navigation starts.
        if (page.finalUrl === 'about:blank' && !page.html.replace(/<[^>]*>|\s/g, '')) {
          await this.sleep(Math.min(this.pollMs, until - this.now())); continue;
        }
        const url = pageURL(page.finalUrl);
        const id = noteFromURL(url);
        if (id && record.noteId && id !== record.noteId) fail('BROWSER_NOTE_MISMATCH');
        if (isCaptcha(url, page.html)) return { kind: 'gate' };
        if (isLogin(url, page.html)) fail('BROWSER_PAGE_REJECTED');
        if (id) {
          if (!record.noteId) { record.noteId = id; await this._put(record); }
          lastPage = { kind: 'page', engine: record.engine, noteId: id, finalUrl: url.href, html: page.html };
          if (ready(page.html, id)) return lastPage;
        } else if (!LINK_HOSTS.has(url.hostname) || url.href !== record.sourceURL) fail('BROWSER_PAGE_REJECTED');
        await this.sleep(Math.min(this.pollMs, until - this.now()));
      }
      this._check(record, epoch);
      if (lastPage) return lastPage;
      fail('BROWSER_PAGE_UNAVAILABLE');
    } catch (error) {
      throw new BrowserSessionError(error instanceof BrowserSessionError ? error.code : 'BROWSER_FAILED', false, diagnostic);
    } finally { cdp.dispose(); }
  }
  async _verification(record, epoch, until) {
    this._check(record, epoch);
    const remaining = record.deadline - this.now();
    const view = await this._call(() => this.browser.getLiveView(record.sessionId,
      { targetId: record.targetId, mode: 'tab', expiresInMs: Math.max(60_000, remaining) }), until, 'BROWSER_LIVE_VIEW_FAILED');
    this._check(record, epoch);
    let url, socketURL;
    try {
      if (typeof view?.devtoolsFrontendUrl !== 'string' || view.devtoolsFrontendUrl.length > 16_384) fail('BROWSER_LIVE_VIEW_INVALID');
      url = new URL(view.devtoolsFrontendUrl);
      const socket = url.searchParams.get('wss');
      socketURL = new URL(socket?.startsWith('wss://') ? socket : `wss://${socket}`);
    } catch { fail('BROWSER_LIVE_VIEW_INVALID'); }
    if (url.protocol !== 'https:' || url.hostname !== 'live.browser.run' || url.username || url.password || url.port
      || url.hash || url.pathname !== '/ui/view' || url.searchParams.getAll('mode').length !== 1 || url.searchParams.get('mode') !== 'tab' || url.searchParams.getAll('wss').length !== 1
      || socketURL.protocol !== 'wss:' || socketURL.hostname !== 'live.browser.run' || socketURL.username || socketURL.password || socketURL.port
      || socketURL.hash || socketURL.searchParams.getAll('jwt').length !== 1 || !/^[A-Za-z0-9_.-]{1,8192}$/.test(socketURL.searchParams.get('jwt') || '')
      || socketURL.pathname !== `/api/devtools/browser/${record.sessionId}/page/${record.targetId}`) fail('BROWSER_LIVE_VIEW_INVALID');
    await this._alarmAt(record.deadline);
    return { kind: 'verification', engine: record.engine, verificationUrl: url.href, expiresAt: record.deadline };
  }
  async _run(record, epoch, until) {
    try {
      const outcome = await this._poll(record, epoch, until);
      this._check(record, epoch);
      if (outcome.kind === 'gate') return await this._verification(record, epoch, until);
      return { ...outcome, closed: await this._close(record) };
    } catch (error) {
      const closed = await this._close(record);
      throw new BrowserSessionError(error instanceof BrowserSessionError ? error.code : 'BROWSER_FAILED', closed,
        error instanceof BrowserSessionError ? error.diagnostic : undefined);
    }
  }
  async start({ token, engine, noteId = null, sourceURL } = {}) {
    const epoch = this.cancelEpoch;
    await this._authorize(token);
    const fingerprint = JSON.stringify([engine, noteId, sourceURL]);
    if (this.starting) {
      if (this.starting.fingerprint !== fingerprint) fail('BROWSER_OWNER_REJECTED');
      return this.starting.promise;
    }
    const operation = this._lock(async () => {
      if (engine !== 'node' && engine !== 'python') fail('BROWSER_INPUT_REJECTED');
      if (noteId !== null && noteId !== '' && (typeof noteId !== 'string' || !/^[a-f\d]{24}$/i.test(noteId))) fail('BROWSER_INPUT_REJECTED');
      const source = pageURL(sourceURL);
      const sourceId = noteFromURL(source);
      if (!sourceId && !LINK_HOSTS.has(source.hostname)) fail('BROWSER_INPUT_REJECTED');
      const expectedId = noteId ? noteId.toLowerCase() : sourceId;
      if (expectedId && sourceId && expectedId !== sourceId) fail('BROWSER_NOTE_MISMATCH');
      let record = await this._stored();
      if (record) {
        if (record.engine !== engine || record.sourceURL !== source.href || (expectedId && record.noteId !== expectedId)) fail('BROWSER_OWNER_REJECTED');
        if (this.now() >= record.deadline) { const closed = await this._close(record); throw new BrowserSessionError('BROWSER_EXPIRED', closed); }
        if (!record.sessionId || !record.targetId) fail('BROWSER_NOT_READY');
        return this._run(record, epoch, Math.min(record.deadline, this.now() + this.waitMs));
      }
      record = { sessionId: '', targetId: '', deadline: this.now() + BROWSER_SESSION_TTL_MS,
        engine, noteId: expectedId, sourceURL: source.href };
      this._check(record, epoch);
      const until = Math.min(record.deadline, this.now() + this.waitMs);
      try {
        await this._put(record); await this._alarmAt(record.deadline);
        const session = await this._call(() => this.browser.acquire({ keepAlive: BROWSER_SESSION_TTL_MS, recording: false,
          guardrails: { allowedDomains: [...GUARDRAILS] } }), until, 'BROWSER_ACQUIRE_FAILED', value => this._lateAcquire(value, record));
        if (!opaqueId(session?.sessionId)) fail('BROWSER_ACQUIRE_FAILED');
        record.sessionId = session.sessionId;
        await this._put(record); this._check(record, epoch);
        const target = await this._call(() => this.browser.devtools.newTarget(record.sessionId, record.sourceURL), until, 'BROWSER_TARGET_FAILED');
        if (!opaqueId(target?.id)) fail('BROWSER_TARGET_FAILED');
        record.targetId = target.id;
        await this._put(record); this._check(record, epoch);
      } catch (error) {
        const closed = await this._close(record);
        throw new BrowserSessionError(error instanceof BrowserSessionError ? error.code : 'BROWSER_FAILED', closed);
      }
      return this._run(record, epoch, until);
    });
    const starting = { fingerprint, promise: operation };
    this.starting = starting;
    try { return await operation; } finally { if (this.starting === starting) this.starting = null; }
  }
  async resume({ token } = {}) {
    const epoch = this.cancelEpoch;
    await this._authorize(token);
    return this._lock(async () => {
      const record = await this._stored();
      if (!record || !record.sessionId || !record.targetId) fail('BROWSER_NOT_FOUND');
      if (this.now() >= record.deadline) { const closed = await this._close(record); throw new BrowserSessionError('BROWSER_EXPIRED', closed); }
      return this._run(record, epoch, Math.min(record.deadline, this.now() + this.waitMs));
    });
  }
  async cancel({ token } = {}) {
    await this._authorize(token);
    ++this.cancelEpoch;
    return this._lock(async () => {
      const record = await this._stored();
      return { kind: 'cancelled', closed: record ? await this._close(record) : false };
    });
  }
  alarm() {
    return this._lock(async () => {
      const record = await this._stored();
      if (!record) return;
      if (this.now() < record.deadline) { await this._alarmAt(record.deadline); return; }
      await this._close(record);
    });
  }
}
