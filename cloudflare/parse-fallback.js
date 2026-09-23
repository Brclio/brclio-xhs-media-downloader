// Keep high-bandwidth downloads on Cloudflare. Only an unsuccessful, validated
// note parse may use the existing same-engine Vercel JSON endpoint.
import { extractInputUrl, isDirectImageUrl } from '../lib/xhs.js';
import { readBoundedBody, MAX_API_BODY_BYTES } from './http-adapter.js';

export const PARSE_FALLBACK_ORIGIN = 'https://xhs-images-video-vercel-downloader.vercel.app';
export const MAX_FALLBACK_RESPONSE_BYTES = 512 * 1024;
export const FALLBACK_TIMEOUT_MS = 18_000;
const ROUTES = new Map([['/api/parse', 'node'], ['/api/python_parse', 'python']]);
const RETRYABLE_STATUSES = new Set([400, 403, 408, 422, 429, 500, 502, 503, 504]);

function configuredOrigin(env) {
  if (typeof env?.XHS_PARSE_FALLBACK_ORIGIN !== 'string') return null;
  try {
    const url = new URL(env.XHS_PARSE_FALLBACK_ORIGIN.trim());
    if (url.origin !== PARSE_FALLBACK_ORIGIN || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function validatedNoteText(rawBody, contentType, engine) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType || '')) return null;
  try {
    const body = JSON.parse(rawBody);
    if (!body || typeof body.text !== 'string') return null;
    const text = body.text.trim();
    if (!text || (engine === 'python' ? Array.from(text).length : text.length) > 3000) return null;
    const url = new URL(extractInputUrl(text));
    if (isDirectImageUrl(url.href) || url.protocol !== 'https:' || url.username || url.password
        || (url.port && url.port !== '443')
        || !/(^|\.)(?:xiaohongshu\.com|xhslink\.com|xhslink\.cn)$/i.test(url.hostname)) return null;
    // Forward only the extracted share URL. Other JSON fields, surrounding
    // clipboard text, cookies and account credentials never leave this Worker.
    return url.href;
  } catch { return null; }
}

async function readFallbackBody(response) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    return null;
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_FALLBACK_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FALLBACK_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function validParsePayload(bytes, engine) {
  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return data?.success === true && data.engine === engine
      && Array.isArray(data.images) && Array.isArray(data.videos)
      && data.count === data.images.length && data.videoCount === data.videos.length
      && data.images.length + data.videos.length > 0;
  } catch { return false; }
}

export function createParseFallback({ fetchImpl = globalThis.fetch, timeoutMs = FALLBACK_TIMEOUT_MS } = {}) {
  return async function parseWithFallback(request, env, nativeHandler) {
    const url = new URL(request.url);
    const engine = ROUTES.get(url.pathname);
    const origin = configuredOrigin(env);
    if (!engine || request.method !== 'POST' || !origin || url.origin === origin) return nativeHandler(request);

    // Read once before running the native handler. Cloning an unread upload can
    // leave an unbounded tee queue or deadlock cancellation on oversized input.
    const rawBody = await readBoundedBody(request, MAX_API_BODY_BYTES);
    const noteUrl = validatedNoteText(rawBody, request.headers.get('content-type'), engine);
    const nativeRequest = new Request(request, { body: rawBody });
    let primary;
    let primaryError;
    try { primary = await nativeHandler(nativeRequest); } catch (error) { primaryError = error; }
    if (!noteUrl || (primary && !RETRYABLE_STATUSES.has(primary.status))) {
      if (primaryError) throw primaryError;
      return primary;
    }

    try {
      const response = await fetchImpl(origin + url.pathname, {
        // Workers implements only "follow" and "manual". A non-200 response
        // below is discarded, so redirects are rejected without following them.
        method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ text: noteUrl }),
      });
      if (response.status === 200) {
        const bytes = await readFallbackBody(response);
        if (bytes && validParsePayload(bytes, engine)) {
          // Rebuild an allowlisted response; fallback Set-Cookie, CORS and
          // infrastructure headers must not cross the account origin boundary.
          if (primary?.body) await primary.body.cancel().catch(() => {});
          return new Response(bytes, { status: 200, headers: {
            'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'X-XHS-Engine': engine,
            'X-XHS-Parse-Backend': 'vercel-fallback',
          } });
        }
      } else { await response.body?.cancel(); }
    } catch {
      // Preserve the original native error if the optional fallback is down,
      // times out, redirects or returns a malformed/oversized payload.
    }
    if (primaryError) throw primaryError;
    return primary;
  };
}

export const parseWithFallback = createParseFallback();
