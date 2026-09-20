import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { parseNoteHtml, extractNoteId, fetchNotePage } from '../lib/xhs.js';
import { parseProfileUrl, normalizeProfileNote, parsePostedResponse, profileError, readProfileSnapshot } from './profile-source.js';
import { readLoginSnapshot } from './login-state.js';
import { readNoteSnapshot } from './note-state.js';

const ORIGIN = 'https://www.xiaohongshu.com';
const POSTED = /^\/api\/sns\/web\/v\d+\/user_posted\/?$/;
const require = createRequire(import.meta.url);

function allowedNavigation(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'xiaohongshu.com' || url.hostname.endsWith('.xiaohongshu.com'));
  } catch { return false; }
}

export class XhsBrowser {
  constructor({ onStatus = () => {}, onLoginState = () => {}, onDiagnostic = () => {}, BrowserWindow, session, wait = delay, fetchPage = fetchNotePage } = {}) {
    this.onStatus = onStatus;
    this.electron = BrowserWindow ? { BrowserWindow, session } : null;
    this.profileWindow = null;
    this.detailWindow = null;
    this.wait = wait;
    this.onLoginState = onLoginState;
    this.onDiagnostic = onDiagnostic;
    this.fetchPage = fetchPage;
    this.loginState = { status: 'unknown', loggedIn: false, nickname: '', userId: '' };
    this.accountWindow = null;
  }

  async window(kind = 'profile') {
    this.electron ||= require('electron');
    const key = kind === 'profile' ? 'profileWindow' : kind === 'account' ? 'accountWindow' : 'detailWindow';
    if (this[key] && !this[key].isDestroyed()) {
      await this[`${key}Ready`];
      return this[key];
    }
    const browserSession = this.electron.session.fromPartition('persist:xhs-account');
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    const win = new this.electron.BrowserWindow({
      width: 1180, height: 820, show: false, title: 'Brclio 小红书下载器 · 登录与验证',
      webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-navigate', 'will-redirect']) {
      win.webContents.on(event, (e, url) => { if (!allowedNavigation(url)) e.preventDefault(); });
    }
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    for (const event of ['did-finish-load', 'did-navigate-in-page']) {
      win.webContents.on(event, () => { void this.refreshLogin(win); });
    }
    // Closing the login window hides it so a queued task keeps its page/session.
    win.on('close', event => { if (!this.closing) { event.preventDefault(); win.hide(); } });
    this[key] = win;
    // A fresh hidden window has no renderer target. Network.enable can otherwise
    // wait indefinitely before first navigation, so create a blank target first.
    this[`${key}Ready`] = win.loadURL('about:blank');
    await this[`${key}Ready`];
    if (!this.loginTimer) {
      this.loginTimer = setInterval(() => {
        const target = this.accountWindow || this.profileWindow || this.detailWindow;
        if (target) void this.refreshLogin(target);
      }, 2500);
      this.loginTimer.unref?.();
    }
    return win;
  }

  async refreshLogin(win) {
    if (this.loginBusy || this.closing || win.isDestroyed() || !allowedNavigation(win.webContents.getURL())) return this.loginState;
    this.loginBusy = true;
    try {
      const current = await this.execute(win, `(${readLoginSnapshot.toString()})()`);
      if (current?.status === 'unknown' || !current?.status) return this.loginState;
      if (current.loggedIn && !current.nickname && current.userId === this.loginState.userId) current.nickname = this.loginState.nickname;
      if (JSON.stringify(current) !== JSON.stringify(this.loginState)) {
        this.loginState = current;
        this.onLoginState({ ...current });
      }
    } catch { /* A page in navigation is not evidence of logout. */ }
    finally { this.loginBusy = false; }
    return { ...this.loginState };
  }

  async getLoginState() {
    const win = await this.window('account');
    if (!allowedNavigation(win.webContents.getURL())) await this.navigate(win, `${ORIGIN}/explore`);
    return this.refreshLogin(win);
  }

  async openLogin(value) {
    const win = this.blockedWindow && !this.blockedWindow.isDestroyed()
      ? this.blockedWindow : await this.window('account');
    win.show();
    win.focus();
    if (!allowedNavigation(win.webContents.getURL())) await this.navigate(win, value ? parseProfileUrl(value).url : `${ORIGIN}/explore`);
    return true;
  }

  async execute(win, script, signal) {
    signal?.throwIfAborted();
    let timer;
    let abort;
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(script),
        new Promise((_, reject) => {
          abort = () => { win.webContents.stop(); reject(signal.reason || Object.assign(new Error('任务已暂停。'), { name: 'AbortError' })); };
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(profileError('DISCOVERY_INCOMPLETE', '页面读取超时，任务已暂停，请稍后继续。')), 15000);
        })
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async navigate(win, url, signal) {
    signal?.throwIfAborted();
    if (!allowedNavigation(url)) throw profileError('INVALID_URL', '不支持的页面地址。');
    const started = Date.now();
    this.diagnostic('navigation.start', { noteId: extractNoteId(url) || undefined });
    let timer;
    let domReady;
    const abort = () => win.webContents.stop();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise(resolve => {
          domReady = () => { if (allowedNavigation(win.webContents.getURL())) resolve(); };
          win.webContents.on('dom-ready', domReady);
        }),
        new Promise((_, reject) => { timer = setTimeout(() => { win.webContents.stop(); reject(new Error('小红书页面加载超时，请稍后继续。')); }, 45000); })
      ]);
      signal?.throwIfAborted();
      this.diagnostic('navigation.ready', { noteId: extractNoteId(url) || undefined, durationMs: Date.now() - started });
    } catch (error) {
      this.diagnostic('navigation.error', { noteId: extractNoteId(url) || undefined, code: error.code || error.name, durationMs: Date.now() - started });
      throw error;
    } finally {
      clearTimeout(timer);
      win.webContents.removeListener('dom-ready', domReady);
      signal?.removeEventListener('abort', abort);
    }
  }

  block(win, code, message) {
    this.diagnostic('access.blocked', { code });
    this.blockedWindow = win;
    win.show();
    this.onStatus(message);
    throw profileError(code, message);
  }

  async *discover(value, { signal, intervalSeconds = 10, jitterSeconds = 3 } = {}) {
    const profile = parseProfileUrl(value);
    const win = await this.window();
    const debuggerApi = win.webContents.debugger;
    const pending = new Map();
    let readingResponses = 0;
    const batches = [];
    let networkError;
    let active = true;
    const seen = new Map();
    let stale = 0;
    let endReported = false;
    const listener = async (_event, method, params) => {
      try {
        if (method === 'Network.responseReceived') {
          // CORS preflights share the API URL but have no JSON body. Their CDP
          // response cannot be read as the actual authored-note response.
          if (params.type === 'Preflight' || params.response.status === 204) return;
          const url = new URL(params.response.url);
          if (!allowedNavigation(url.href) || !POSTED.test(url.pathname) || url.searchParams.get('user_id') !== profile.id) return;
          if ([401, 403, 429, 461, 471].includes(params.response.status)) {
            networkError = profileError(params.response.status === 429 ? 'RATE_LIMITED' : 'AUTH_REQUIRED', '小红书限制了当前访问，请在内置浏览器完成登录或验证，稍后继续。');
          } else if (params.response.status >= 400) {
            networkError = profileError('DISCOVERY_INCOMPLETE', `主页列表请求失败（HTTP ${params.response.status}），尚未抓取完毕。`);
          } else pending.set(params.requestId, true);
        } else if (method === 'Network.loadingFinished' && pending.delete(params.requestId)) {
          if (params.encodedDataLength > 16 * 1024 * 1024) throw profileError('DISCOVERY_INCOMPLETE', '主页列表响应过大，已暂停。');
          readingResponses++;
          try {
            const body = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
            if (!active) return;
            const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
            const batch = parsePostedResponse(JSON.parse(text), profile.id);
            if (batch) batches.push(batch);
          } finally { readingResponses--; }
        } else if (method === 'Network.loadingFailed' && pending.delete(params.requestId)) {
          networkError = profileError('DISCOVERY_INCOMPLETE', '主页列表请求中断，请稍后继续。');
        }
      } catch (error) {
        // Keep the protocol error (not request URLs/bodies/cookies) available for
        // diagnosing platform changes without falsely completing a partial list.
        if (process.env.XHS_PROFILE_DIAGNOSTICS === '1') console.warn('profile-list-capture', error.name, String(error.message).slice(0, 160));
        if (active) networkError = error.code ? error : profileError('DISCOVERY_INCOMPLETE', '无法读取完整主页列表，请重新继续任务。');
      }
    };
    try {
      if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
      debuggerApi.on('message', listener);
      await debuggerApi.sendCommand('Network.enable', { maxResourceBufferSize: 16 * 1024 * 1024, maxTotalBufferSize: 32 * 1024 * 1024 });
      await this.navigate(win, profile.url, signal);
      // This initial wait only observes rendering; it does not issue new requests.
      await this.wait(1200, undefined, { signal });
      while (true) {
        signal?.throwIfAborted();
        if (networkError) this.block(win, networkError.code, networkError.message);
        if (win.isDestroyed()) throw profileError('DISCOVERY_INCOMPLETE', '内置浏览器已关闭，请继续任务。');
        const snap = await this.execute(win, `(${readProfileSnapshot.toString()})(${JSON.stringify(profile.id)})`, signal);
        if (snap.challenge) this.block(win, 'RATE_LIMITED', '需要安全验证，任务已暂停。请在内置浏览器完成验证后继续。');
        if (snap.login) this.block(win, 'AUTH_REQUIRED', '需要登录小红书，任务已暂停。登录后点击“继续任务”。');
        if (snap.wrongTab || new URL(win.webContents.getURL()).pathname.replace(/\/$/, '') !== `/user/profile/${profile.id}`) {
          throw profileError('DISCOVERY_INCOMPLETE', '浏览器已离开该主页的笔记列表，请继续任务重新加载。');
        }
        const incoming = batches.splice(0);
        if (snap.list.some(raw => !normalizeProfileNote(raw, profile.id))) {
          throw profileError('DISCOVERY_INCOMPLETE', '主页列表中有无法完整识别的帖子，任务已暂停，尚未确认全部抓取。');
        }
        endReported ||= snap.done || incoming.some(batch => batch.done);
        const done = endReported && pending.size === 0 && readingResponses === 0;
        const authoredNotes = [...snap.list, ...incoming.flatMap(batch => batch.notes)];
        const authoredIds = new Set([...seen.keys(), ...authoredNotes.map(raw => normalizeProfileNote(raw, profile.id)?.id)]);
        // DOM cards may include hidden tabs or recommendations. They can enrich an
        // already-confirmed author's note with a token, but cannot introduce IDs.
        const matchingCards = snap.cards.filter(raw => authoredIds.has(normalizeProfileNote(raw, profile.id)?.id));
        const rawNotes = [...authoredNotes, ...matchingCards];
        const candidates = new Map();
        for (const raw of rawNotes) {
          const note = normalizeProfileNote(raw, profile.id);
          if (!note) continue;
          if (!candidates.has(note.id) || new URL(note.url).searchParams.has('xsec_token')) candidates.set(note.id, note);
        }
        let newCount = 0;
        const notes = [];
        for (const note of candidates.values()) {
          const prior = seen.get(note.id);
          if (!prior) newCount++;
          if (!prior || (note.url !== prior && new URL(note.url).searchParams.has('xsec_token'))) {
            notes.push(note);
            seen.set(note.id, note.url);
          }
        }
        yield { notes, done, profileName: snap.profileName };
        if (done) return;
        stale = newCount ? 0 : stale + 1;
        if (stale >= 5) {
          if (!seen.size && /登录|扫码/.test(snap.pageText)) this.block(win, 'AUTH_REQUIRED', '主页需要登录才能加载帖子，请登录后继续。');
          throw profileError('DISCOVERY_INCOMPLETE', '列表连续多次没有加载新帖子，且未收到结束标记。任务已暂停，可稍后继续。');
        }
        const wait = Math.max(3, Number(intervalSeconds) || 10) + Math.random() * Math.max(0, Number(jitterSeconds) || 0);
        this.onStatus(`已发现 ${seen.size} 篇，${Math.ceil(wait)} 秒后加载下一页。`);
        await this.wait(wait * 1000, undefined, { signal });
        await this.execute(win, `(() => {
          const nodes = [document.scrollingElement, ...document.querySelectorAll('.main-container, .user-page, .feeds-tab-container, .scroll-container')];
          for (const node of nodes) if (node && node.scrollHeight > node.clientHeight) node.scrollTop = node.scrollHeight;
          window.scrollTo(0, document.documentElement.scrollHeight);
        })()`, signal);
        await this.wait(1000, undefined, { signal });
      }
    } finally {
      active = false;
      debuggerApi.removeListener('message', listener);
      if (debuggerApi.isAttached()) debuggerApi.detach();
      if (!win.isDestroyed()) win.webContents.stop();
    }
  }

  async resolveNote(note, { signal, beforeRequest = async () => {} } = {}) {
    if (!note?.id || extractNoteId(note.url) !== note.id || !allowedNavigation(note.url)) throw profileError('INVALID_NOTE', '笔记地址无效。');
    const win = await this.window('detail');
    await this.navigate(win, note.url, signal);
    let noteType;
    const complete = parsed => parsed.strategy === 'exact-initial-state' && (parsed.images.length || parsed.videos.length)
      && !parsed.images.some(image => image.livePhoto && !image.liveVideo?.url)
      && ((parsed.noteType || noteType) !== 'video' || parsed.videos.length);
    for (let attempt = 0; attempt < 20; attempt++) {
      signal?.throwIfAborted();
      const result = await this.execute(win, `(${readNoteSnapshot.toString()})(${JSON.stringify(note.id)})`, signal);
      if (result.challenge) this.block(win, 'RATE_LIMITED', '笔记需要安全验证，完成验证后可继续。');
      if (result.login) this.block(win, 'AUTH_REQUIRED', '笔记需要登录，登录后可继续任务。');
      if (result.error) throw profileError(result.error.code, result.error.message);
      const html = `<script>window.__INITIAL_STATE__=${result.serialized.replace(/</g, '\\u003c')}</script>`;
      const parsed = parseNoteHtml(html, { noteId: note.id });
      noteType = JSON.parse(result.serialized || '{}').note?.noteDetailMap?.[note.id]?.note?.type;
      // Images can hydrate before their live-photo streams, and video covers can
      // precede the video payload. Wait for complete media instead of saving early.
      const pendingLiveVideo = parsed.images.some(image => image.livePhoto && !image.liveVideo?.url);
      this.diagnostic('note.extraction', { noteId: note.id, attempt: attempt + 1, source: 'browser',
        images: parsed.images.length, videos: parsed.videos.length, pendingLiveVideo });
      if (complete(parsed)) return parsed;
      await this.wait(500, undefined, { signal });
    }
    // Reactive desktop stores sometimes omit streams until player hydration.
    // Reuse the exact-note mobile-page parser as a bounded, paced alternative.
    // Login/challenge gates above are never bypassed by this fallback.
    if (this.fetchPage) {
      await beforeRequest(signal);
      signal?.throwIfAborted();
      // Pacing may take several seconds. Recheck gates after that wait so a
      // newly presented verification or login page cannot trigger another route.
      const latest = await this.execute(win, `(${readNoteSnapshot.toString()})(${JSON.stringify(note.id)})`, signal);
      if (latest.challenge) this.block(win, 'RATE_LIMITED', '笔记需要安全验证，完成验证后可继续。');
      if (latest.login) this.block(win, 'AUTH_REQUIRED', '笔记需要登录，登录后可继续任务。');
      if (latest.error) throw profileError(latest.error.code, latest.error.message);
      this.diagnostic('note.fallback', { noteId: note.id, source: 'mobile-page' });
      try {
        const page = await this.fetchPage(note.url, { signal });
        signal?.throwIfAborted();
        if (page && extractNoteId(page.finalUrl) === note.id) {
          const parsed = parseNoteHtml(page.html, { noteId: note.id });
          this.diagnostic('note.extraction', { noteId: note.id, source: 'mobile-page', images: parsed.images.length, videos: parsed.videos.length });
          if (complete(parsed)) return parsed;
        }
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        this.diagnostic('note.fallback-error', { noteId: note.id, code: error.code || error.name });
        if (['AUTH_REQUIRED', 'RATE_LIMITED'].includes(error.code)) this.block(win, error.code, '小红书限制了详情访问，请完成登录或验证后继续。');
      }
    }
    throw profileError('NOTE_INCOMPLETE', '详情媒体尚未完整加载，已保留任务和文件。请稍后重试，或打开小红书登录与验证页面检查。');
  }

  diagnostic(event, fields) {
    try { this.onDiagnostic(event, fields); } catch { /* Logging must never affect the browser. */ }
  }

  close() {
    this.closing = true;
    clearInterval(this.loginTimer);
    for (const win of [this.profileWindow, this.detailWindow, this.accountWindow]) if (win && !win.isDestroyed()) win.destroy();
  }
}
