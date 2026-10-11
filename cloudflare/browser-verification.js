import { MAX_API_BODY_BYTES, readBoundedBody } from './http-adapter.js';

export const BROWSER_VERIFICATION_REGISTRY_KEY = 'browser-verification-registry-v1';
export const MAX_ACTIVE_BROWSER_VERIFICATIONS = 3;
export const BROWSER_VERIFICATION_TTL_MS = 180_000;
export const BROWSER_VERIFICATION_DISPATCH_MS = 25_000;
export const BROWSER_VERIFICATION_RESUME_INTERVAL_MS = 2_000;
const CLOSED_HEADER = 'X-Browser-Closed';
const ELAPSED_HEADER = 'X-Browser-Elapsed-Ms';
// Match browser-parse's reservation contract without a circular module import.
const BUDGET_KEY = 'browser-parse-budget-v1';
const RESERVATION_MS = 180_000;
const DAY_MS = 86_400_000;
const REASONS = new Set(['captcha', 'login', 'access-error']);
const ENGINES = new Set(['node', 'python']);
const tokenPattern = /^[a-f0-9]{64}$/;
const json = (body, status) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
} });
const expired = () => json({ success: false, code: 'VERIFICATION_EXPIRED', message: '验证已结束或过期，请重新解析。' }, 410);
const unavailable = () => json({ success: false, code: 'BROWSER_UNAVAILABLE', message: '验证服务暂时不可用，请稍后重试。' }, 503);

export function publicBrowserResponse(response) {
  const headers = new Headers(response.headers);
  headers.delete(CLOSED_HEADER); headers.delete(ELAPSED_HEADER);
  headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Project only the trusted handoff fields; never relay an internal error or arbitrary URL. */
export function verificationPayload(body, engine, { now = Date.now(), expiresAt } = {}) {
  if (body?.success !== false || body.code !== 'VERIFICATION_REQUIRED' || body.engine !== engine
    || !ENGINES.has(engine) || !Number.isFinite(body.expiresAt) || body.expiresAt <= now
    || body.expiresAt > now + BROWSER_VERIFICATION_TTL_MS
    || (expiresAt !== undefined && body.expiresAt !== expiresAt)
    || typeof body.verificationUrl !== 'string' || body.verificationUrl.length > MAX_API_BODY_BYTES) return null;
  let url, socket;
  try {
    url = new URL(body.verificationUrl);
    const address = url.searchParams.get('wss');
    socket = new URL(address?.startsWith('wss://') ? address : `wss://${address}`);
  } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'live.browser.run' || url.username || url.password || url.port
    || url.hash || url.pathname !== '/ui/view' || url.searchParams.getAll('mode').length !== 1
    || url.searchParams.get('mode') !== 'tab' || url.searchParams.getAll('wss').length !== 1
    || socket.protocol !== 'wss:' || socket.hostname !== 'live.browser.run' || socket.username || socket.password
    || socket.port || socket.hash || !/^\/api\/devtools\/browser\/[A-Za-z0-9_-]{1,128}\/page\/[A-Za-z0-9_-]{1,128}$/.test(socket.pathname)
    || socket.searchParams.getAll('jwt').length !== 1 || !/^[A-Za-z0-9_.-]{1,8192}$/.test(socket.searchParams.get('jwt') || '')) return null;
  return { success: false, engine, code: 'VERIFICATION_REQUIRED',
    message: '小红书需要人工处理，请在验证窗口完成后继续解析。',
    ...(REASONS.has(body.reason) ? { reason: body.reason } : {}),
    verificationUrl: url.href, expiresAt: body.expiresAt };
}

export async function verificationTokenDigest(token) {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validEntry(entry) {
  return entry && typeof entry.digest === 'string' && tokenPattern.test(entry.digest) && ENGINES.has(entry.engine)
    && Number.isFinite(entry.expiresAt) && entry.expiresAt > 0
    && Number.isFinite(entry.nextResumeAt) && entry.nextResumeAt >= 0
    && Number.isFinite(entry.leaseUntil) && entry.leaseUntil >= 0
    && Number.isFinite(entry.cancelLeaseUntil) && entry.cancelLeaseUntil >= 0
    && Number.isSafeInteger(entry.sequence) && entry.sequence >= 0 && typeof entry.terminal === 'boolean'
    && (entry.reservation === undefined || validReservation(entry.reservation));
}
function validReservation(reservation) {
  return reservation && Number.isSafeInteger(reservation.day) && reservation.day >= 0
    && Number.isSafeInteger(reservation.startedAt) && reservation.startedAt >= 0
    && Math.floor(reservation.startedAt / DAY_MS) === reservation.day;
}
function entriesFrom(value, now) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ACTIVE_BROWSER_VERIFICATIONS || !value.every(validEntry)
    || new Set(value.map(entry => entry.digest)).size !== value.length) throw new Error('verification-registry-invalid');
  return value.filter(entry => entry.expiresAt > now).map(({ digest, engine, expiresAt, nextResumeAt, leaseUntil, cancelLeaseUntil, sequence, terminal, reservation }) =>
    ({ digest, engine, expiresAt, nextResumeAt, leaseUntil, cancelLeaseUntil, sequence, terminal,
      ...(reservation ? { reservation: { day: reservation.day, startedAt: reservation.startedAt } } : {}) }));
}

async function settleUsage(transaction, entry, now) {
  const reservation = entry.reservation;
  if (!validReservation(reservation) || !Number.isSafeInteger(now) || now < reservation.startedAt
    || Math.floor(now / DAY_MS) !== reservation.day) return;
  // Charge the whole lifetime, including the manual window; per-operation CDP
  // elapsed headers are intentionally ignored for this accounting.
  const charged = Math.min(RESERVATION_MS, Math.ceil(now - reservation.startedAt) + 5000);
  const refund = RESERVATION_MS - charged;
  if (refund <= 0) return;
  const budget = await transaction.get(BUDGET_KEY);
  if (!budget || budget.day !== reservation.day || !Number.isFinite(budget.usedMs) || budget.usedMs < RESERVATION_MS
    || !Number.isFinite(budget.lastStartMs) || budget.lastStartMs < -30_000) return;
  await transaction.put(BUDGET_KEY, { day: budget.day, usedMs: budget.usedMs - refund, lastStartMs: budget.lastStartMs });
}

async function ownerFetch(stub, token, action, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('verification-dispatch-timeout')); }, timeoutMs);
  });
  try {
    return await Promise.race([stub.fetch(new Request(`https://browser.internal/__internal/browser/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: controller.signal,
    })), timedOut]);
  } finally { clearTimeout(timer); }
}

/** Only parsing-v1 owns this bounded directory. Unknown bearer tokens never address a new DO. */
export class BrowserVerificationRegistry {
  constructor(storage, namespace, { now = Date.now } = {}) {
    this.storage = storage; this.namespace = namespace; this.now = now;
  }
  async _change(action) {
    return this.storage.transaction(async transaction => {
      const previous = await transaction.get(BROWSER_VERIFICATION_REGISTRY_KEY);
      const entries = entriesFrom(previous, this.now());
      const before = JSON.stringify(entries);
      const result = await action(entries, transaction);
      if ((previous !== undefined && previous.length !== entries.length) || JSON.stringify(entries) !== before) {
        await transaction.put(BROWSER_VERIFICATION_REGISTRY_KEY, entries);
      }
      return result;
    });
  }
  async register(token, { expiresAt, engine, reservation } = {}) {
    const digest = await verificationTokenDigest(token), now = this.now();
    if (!digest || !ENGINES.has(engine) || !Number.isFinite(expiresAt) || expiresAt <= now
      || expiresAt > now + BROWSER_VERIFICATION_TTL_MS
      || (reservation !== undefined && (!validReservation(reservation) || reservation.startedAt > now
        || now - reservation.startedAt > BROWSER_VERIFICATION_TTL_MS))) return false;
    const recordedReservation = reservation === undefined ? undefined : { day: reservation.day, startedAt: reservation.startedAt };
    return this._change(entries => {
      const existing = entries.find(entry => entry.digest === digest);
      if (existing) return existing.engine === engine && existing.expiresAt === expiresAt && !existing.terminal
        && JSON.stringify(existing.reservation) === JSON.stringify(recordedReservation);
      if (entries.length >= MAX_ACTIVE_BROWSER_VERIFICATIONS) return false;
      entries.push({ digest, engine, expiresAt, nextResumeAt: 0, leaseUntil: 0, cancelLeaseUntil: 0, sequence: 0, terminal: false,
        ...(recordedReservation ? { reservation: recordedReservation } : {}) });
      return true;
    });
  }
  async _claim(digest, action) {
    return this._change(entries => {
      const entry = entries.find(candidate => candidate.digest === digest);
      if (!entry || (entry.terminal && action === 'resume')) return { kind: 'expired' };
      const now = this.now();
      // A cancellation can interrupt an in-flight resume; a duplicate cancel cannot queue more work.
      if ((action === 'cancel' && entry.cancelLeaseUntil > now)
        || (action === 'resume' && (entry.leaseUntil > now || entry.nextResumeAt > now))) return { kind: 'busy' };
      if (entry.sequence === Number.MAX_SAFE_INTEGER) return { kind: 'expired' };
      entry.sequence++;
      entry.leaseUntil = Math.min(entry.expiresAt, now + BROWSER_VERIFICATION_DISPATCH_MS);
      if (action === 'cancel') { entry.terminal = true; entry.cancelLeaseUntil = entry.leaseUntil; }
      else entry.nextResumeAt = now + BROWSER_VERIFICATION_RESUME_INTERVAL_MS;
      return { kind: 'claimed', entry: { ...entry } };
    });
  }
  async _settle(claim, { remove = false, terminal = false, timeout = false, confirmedClosed = false } = {}) {
    return this._change(async (entries, transaction) => {
      const index = entries.findIndex(entry => entry.digest === claim.digest && entry.sequence === claim.sequence);
      if (index === -1) return false;
      if (remove) {
        if (confirmedClosed) await settleUsage(transaction, entries[index], this.now());
        // Removal and the accounting write share one transaction. Replayed or
        // superseded sequences can never refund this reservation a second time.
        entries.splice(index, 1);
      }
      else {
        if (!timeout) { entries[index].leaseUntil = 0; entries[index].cancelLeaseUntil = 0; }
        if (terminal) entries[index].terminal = true;
      }
      return true;
    });
  }
  async dispatch({ token, action } = {}) {
    const digest = await verificationTokenDigest(token);
    if (!digest || !['resume', 'cancel'].includes(action)) return json({ success: false, message: '验证请求无效。' }, 400);
    let claim;
    try {
      const result = await this._claim(digest, action);
      if (result.kind === 'expired') return expired();
      if (result.kind === 'busy') return json({ success: false, code: 'VERIFICATION_BUSY', message: '正在处理验证，请稍后继续。' }, 429);
      claim = result.entry;
      const stub = this.namespace.get(this.namespace.idFromName(`browser:${token}`));
      const response = await ownerFetch(stub, token, action, BROWSER_VERIFICATION_DISPATCH_MS);
      if (!(response instanceof Response)) throw new Error('verification-response-invalid');
      if (action === 'resume' && response.status === 422) {
        const payload = verificationPayload(JSON.parse(await readBoundedBody(response, MAX_API_BODY_BYTES)), claim.engine,
          { now: this.now(), expiresAt: claim.expiresAt });
        if (payload) {
          if (!await this._settle(claim)) return expired();
          return json({ ...payload, verificationToken: token }, 422);
        }
        const remove = response.headers.get(CLOSED_HEADER) === '1';
        if (!await this._settle(claim, { remove, terminal: !remove, confirmedClosed: remove })) return expired();
        return unavailable();
      }
      // Failures without confirmed closure remain cancelled and retain their original deadline/budget.
      const confirmedClosed = response.headers.get(CLOSED_HEADER) === '1';
      const remove = confirmedClosed || response.ok || response.status === 410;
      if (!await this._settle(claim, { remove, terminal: !remove, confirmedClosed })) return expired();
      return publicBrowserResponse(response);
    } catch {
      // A timeout may leave a private request running. Keep its lease; never declare or refund a close.
      if (claim) { try { await this._settle(claim, { terminal: true, timeout: true }); } catch { /* Owner alarm remains responsible for cleanup. */ } }
      return unavailable();
    }
  }
}

/** Registration failures never expose an untracked browser; the full usage reservation is retained. */
export async function cancelUnregisteredVerification(stub, token) {
  try { await ownerFetch(stub, token, 'cancel', 5_000); } catch { /* The owner also has an absolute deadline/alarm. */ }
}
