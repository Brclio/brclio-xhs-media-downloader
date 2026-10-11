import { extractInputUrl, extractNoteId, isDirectImageUrl } from '../lib/xhs.js';
import { MAX_API_BODY_BYTES, readBoundedBody } from './http-adapter.js';
import { BrowserVerificationRegistry, cancelUnregisteredVerification, publicBrowserResponse, verificationPayload } from './browser-verification.js';

export const BROWSER_BUDGET_STORAGE_KEY = 'browser-parse-budget-v1';
export const BROWSER_ATTEMPT_RESERVATION_MS = 180_000;
export const BROWSER_DAILY_BUDGET_MS = 600_000;
export const BROWSER_START_INTERVAL_MS = 30_000;
const START_TIMEOUT_MS = 20_000;
const PAGE_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com']);
const SHORT_HOSTS = new Set(['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);
const CLOSED_HEADER = 'X-Browser-Closed';
const ELAPSED_HEADER = 'X-Browser-Elapsed-Ms';
const DAY_MS = 86_400_000;
const STATE_RETRY_AFTER_SECONDS = 60;

const json = (body, status, headers = {}) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
} });

async function candidate(request) {
  const endpoint = new URL(request.url);
  if (request.method !== 'POST' || !['/api/parse', '/api/python_parse'].includes(endpoint.pathname)
    || request.signal.aborted
    || request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site'
    || (request.headers.has('Origin') && request.headers.get('Origin') !== endpoint.origin)
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return null;
  const body = JSON.parse(await readBoundedBody(request, MAX_API_BODY_BYTES));
  if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 3000) return null;
  const sourceURL = extractInputUrl(body.text);
  if (sourceURL.length > 10_000 || isDirectImageUrl(sourceURL)) return null;
  const url = new URL(sourceURL);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const noteId = extractNoteId(sourceURL);
  if (!SHORT_HOSTS.has(url.hostname) && !(PAGE_HOSTS.has(url.hostname)
    && /^\/(?:explore|discovery\/item)\/[a-f0-9]{24}\/?$/i.test(url.pathname) && noteId)) return null;
  return { engine: endpoint.pathname === '/api/python_parse' ? 'python' : 'node', sourceURL, noteId };
}

function numericRecord(record) {
  return record && Number.isSafeInteger(record.day) && record.day >= 0
    && Number.isFinite(record.usedMs) && record.usedMs >= 0 && record.usedMs <= BROWSER_DAILY_BUDGET_MS
    && Number.isFinite(record.lastStartMs) && record.lastStartMs >= -BROWSER_START_INTERVAL_MS;
}

async function reserve(storage, now) {
  const day = Math.floor(now / DAY_MS);
  const unavailable = { ok: false, reason: 'state-unavailable', retryAfter: STATE_RETRY_AFTER_SECONDS, usedMs: null };
  try {
    return await storage.transaction(async transaction => {
      const previous = await transaction.get(BROWSER_BUDGET_STORAGE_KEY);
      if (previous !== undefined && (!numericRecord(previous) || previous.day > day || previous.lastStartMs > now)) return unavailable;
      const record = previous?.day === day
        ? { day, usedMs: previous.usedMs, lastStartMs: previous.lastStartMs }
        : { day, usedMs: 0, lastStartMs: previous?.lastStartMs ?? -BROWSER_START_INTERVAL_MS };
      // Exhausted quota takes priority: waiting out the cooldown cannot admit another session.
      if (record.usedMs + BROWSER_ATTEMPT_RESERVATION_MS > BROWSER_DAILY_BUDGET_MS) {
        const resetsAt = (day + 1) * DAY_MS;
        return { ok: false, reason: 'daily-limit', retryAfter: Math.max(1, Math.ceil((resetsAt - now) / 1000)), usedMs: record.usedMs, resetsAt };
      }
      if (now - record.lastStartMs < BROWSER_START_INTERVAL_MS) return { ok: false, reason: 'cooldown',
        retryAfter: Math.max(1, Math.ceil((record.lastStartMs + BROWSER_START_INTERVAL_MS - now) / 1000)), usedMs: record.usedMs };
      record.usedMs += BROWSER_ATTEMPT_RESERVATION_MS;
      record.lastStartMs = now;
      await transaction.put(BROWSER_BUDGET_STORAGE_KEY, record);
      return { ok: true, day, startedAt: now };
    });
  } catch { return unavailable; }
}

function reservationRejected(engine, reservation) {
  const { reason, retryAfter, usedMs } = reservation;
  // Strict fixed fields only: never log input URLs, note IDs, credentials or storage exceptions.
  try { console.warn('CF_BROWSER_RESERVATION_REJECTED', JSON.stringify({ reason, retryAfter, usedMs })); } catch {}
  let code, message;
  if (reason === 'daily-limit') {
    code = 'BROWSER_DAILY_LIMIT';
    const beijingDate = new Date(reservation.resetsAt + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    message = `今日网页验证剩余额度不足以开启新会话（Node/Python 共用）。将于北京时间 ${beijingDate} 08:00 恢复。请届时重试，或使用桌面客户端。`;
  } else if (reason === 'cooldown') {
    code = 'BROWSER_COOLDOWN';
    message = `网页验证需间隔 30 秒。请在 ${retryAfter} 秒后重试；Node/Python 共用等待时间。`;
  } else {
    code = 'BROWSER_STATE_UNAVAILABLE';
    message = '网页验证服务暂时无法确认额度状态。请稍后重试，或使用桌面客户端。';
  }
  return json({ success: false, engine, code, message, retryAfter,
    ...(reason === 'daily-limit' ? { resetsAt: new Date(reservation.resetsAt).toISOString() } : {}),
  }, reason === 'state-unavailable' ? 503 : 429, { 'Retry-After': String(retryAfter) });
}

async function refundConfirmedClose(storage, reservation, response) {
  if (response.headers.get(CLOSED_HEADER) !== '1') return;
  const rawElapsed = response.headers.get(ELAPSED_HEADER);
  if (rawElapsed === null || !/^\d+(?:\.\d+)?$/.test(rawElapsed)) return;
  const elapsed = Number(rawElapsed);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > BROWSER_ATTEMPT_RESERVATION_MS) return;
  const refund = BROWSER_ATTEMPT_RESERVATION_MS - Math.min(BROWSER_ATTEMPT_RESERVATION_MS, Math.ceil(elapsed) + 5000);
  if (refund <= 0) return;
  try {
    await storage.transaction(async transaction => {
      const record = await transaction.get(BROWSER_BUDGET_STORAGE_KEY);
      if (!numericRecord(record) || record.day !== reservation.day) return;
      await transaction.put(BROWSER_BUDGET_STORAGE_KEY, {
        day: record.day, usedMs: Math.max(0, record.usedMs - refund), lastStartMs: record.lastStartMs,
      });
    });
  } catch { /* A failed refund retains the conservative reservation. */ }
}

async function startSession(stub, payload, signal) {
  const controller = new AbortController();
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(); rejectAbort(new Error('browser-start-cancelled')); };
  const timer = setTimeout(abort, START_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('browser-start-cancelled');
    return await Promise.race([stub.fetch(new Request('https://browser-session.internal/__internal/browser/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
    })), aborted]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

/** Ordinary Browser Run reading is isolated per request; only explicit verification retains a session. */
export async function maybeParseWithBrowser(request, nativeResponse, { env, state } = {}) {
  if (!env?.BROWSER || !env?.PARSE_RUNTIME || !state?.storage?.transaction
    || ![422, 502, 504].includes(nativeResponse.status)) return nativeResponse;
  try {
    const input = await candidate(request);
    if (!input) return nativeResponse;
    const reservation = await reserve(state.storage, Date.now());
    if (!reservation.ok) return reservationRejected(input.engine, reservation);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const stub = env.PARSE_RUNTIME.get(env.PARSE_RUNTIME.idFromName(`browser:${token}`));
    let response;
    try { response = await startSession(stub, { token, ...input }, request.signal); }
    catch {
      // Aborting the transport does not prove the owner stopped its acquisition.
      // Explicitly cancel it; a late start result can never reach registration.
      await cancelUnregisteredVerification(stub, token);
      return nativeResponse;
    }
    if (!(response instanceof Response)) return nativeResponse;
    if (response.status === 422) {
      const body = JSON.parse(await readBoundedBody(response, MAX_API_BODY_BYTES));
      const payload = verificationPayload(body, input.engine);
      if (payload) {
        let registered = false;
        try {
          if (!request.signal.aborted) registered = await new BrowserVerificationRegistry(state.storage, env.PARSE_RUNTIME)
            .register(token, { expiresAt: payload.expiresAt, engine: input.engine,
              reservation: { day: reservation.day, startedAt: reservation.startedAt } });
        } catch { /* A storage failure must not expose an untracked browser. */ }
        if (!registered) { await cancelUnregisteredVerification(stub, token); return nativeResponse; }
        // A live verification keeps its complete reservation, even if a bad close header is present.
        return json({ ...payload, verificationToken: token }, 422);
      }
    }
    await refundConfirmedClose(state.storage, reservation, response);
    return response.ok ? publicBrowserResponse(response) : nativeResponse;
  } catch { return nativeResponse; }
}
