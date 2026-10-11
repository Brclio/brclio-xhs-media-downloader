import { LIMITS, ProxyError, fail, digest, subscriptionURL, noteURL, noteRedirect,
  mediaURL, mediaRange, mediaAccept, parseSubscription, classifyNote } from './src/policy.js';
import { workerWssEndpoint, workerFetchThroughVless } from './worker-transport.js';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const PROBE_URL = 'https://www.gstatic.com/generate_204';
export const ENDPOINT_PROBE_MS = 6_000;
const NOTE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 '
    + 'Mobile/15E148 Safari/604.1',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,'
    + 'image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
};
const combinedSignal = (signal, ms) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ms)]);
const identity = url => /\/(?:explore|discovery\/item|item)\/([a-f0-9]{12,64})\/?$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? null;

export async function readBounded(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); fail('UPSTREAM_BODY_TOO_LARGE'); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); fail('UPSTREAM_BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export async function fetchFreshSubscription(value, { signal, fetchImpl = fetch } = {}) {
  let url = subscriptionURL(value); const origin = url.origin;
  const deadline = combinedSignal(signal, LIMITS.subscriptionMs);
  for (let count = 0; count <= 3; count++) {
    const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal: deadline,
      headers: { 'User-Agent': 'clash-verge/2.4.2', Accept: 'application/yaml,text/yaml,text/plain,application/json' } });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || count === 3) fail('SUBSCRIPTION_REDIRECT_REJECTED');
      const next = subscriptionURL(new URL(location, url).href);
      if (next.origin !== origin) fail('SUBSCRIPTION_REDIRECT_REJECTED');
      url = next; continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); fail('SUBSCRIPTION_FETCH_FAILED'); }
    return new TextDecoder().decode(await readBounded(response, LIMITS.subscriptionBytes));
  }
  fail('SUBSCRIPTION_REDIRECT_REJECTED');
}

export function compatibleEndpoints(nodes) {
  const endpoints = [], seen = new Set();
  for (const node of nodes) {
    try {
      const endpoint = workerWssEndpoint(node.config);
      // Workers verifies WSS by hostname. Repeated preferred IPs with the same
      // hostname/port/path are one route here, not independently tested entries.
      const key = digest(JSON.stringify([endpoint.url.href, node.config.uuid]));
      if (seen.has(key)) continue;
      seen.add(key); endpoints.push({ ...node, entrySelectionPreserved: endpoint.entrySelectionPreserved });
    } catch { /* Unsupported endpoint forms fail closed. */ }
  }
  if (!endpoints.length) fail('SUBSCRIPTION_NO_COMPATIBLE_ENDPOINTS');
  return endpoints;
}

export async function probeEndpoints(nodes, { transport = workerFetchThroughVless, signal, now = () => performance.now() } = {}) {
  const healthy = []; let cursor = 0;
  // Two connections leave room for TLS certificate validation and subscription I/O.
  await Promise.all(Array.from({ length: Math.min(2, nodes.length) }, async () => {
    while (cursor < nodes.length) {
      signal?.throwIfAborted(); const node = nodes[cursor++]; const started = now();
      try {
        const result = await transport(node, PROBE_URL, { headers: { Accept: '*/*' },
          signal: combinedSignal(signal, ENDPOINT_PROBE_MS), maxBytes: 16_384 });
        if (result.status === 204 && result.body.byteLength === 0) healthy.push({ ...node, latencyMs: Math.max(1, Math.round(now() - started)) });
      } catch { /* No upstream exception or credentials reach logs or responses. */ }
    }
  }));
  signal?.throwIfAborted(); healthy.sort((a, b) => a.latencyMs - b.latencyMs || a.id.localeCompare(b.id));
  if (!healthy.length) fail('PROXY_NO_HEALTHY_NODES');
  return healthy;
}

export async function fetchNote(value, node, { signal, transport = workerFetchThroughVless } = {}) {
  let url = noteURL(value); let expected = identity(url);
  for (let count = 0; count <= 5; count++) {
    const result = await transport(node, url.href, { headers: NOTE_HEADERS, signal, maxBytes: LIMITS.noteBytes });
    if (REDIRECTS.has(result.status)) {
      const location = result.headers.get('location');
      if (!location || count === 5) fail('UPSTREAM_REDIRECT_REJECTED');
      url = noteRedirect(new URL(location, url).href);
      if (expected && identity(url) && expected !== identity(url)) fail('UPSTREAM_NOTE_MISMATCH');
      expected ??= identity(url);
      continue;
    }
    if (result.status === 401) fail('UPSTREAM_LOGIN_REQUIRED', 422);
    if ([403, 429, 461, 471].includes(result.status)) fail('UPSTREAM_VERIFICATION_REQUIRED', 422);
    if (result.status === 404) fail('UPSTREAM_NOTE_NOT_FOUND', 404);
    if (result.status !== 200) fail('UPSTREAM_FETCH_FAILED');
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(result.headers.get('content-type') ?? '')) fail('UPSTREAM_CONTENT_REJECTED');
    const html = new TextDecoder().decode(result.body); classifyNote(html);
    return { html, finalUrl: url.href };
  }
  fail('UPSTREAM_REDIRECT_REJECTED');
}

export async function fetchMedia(value, node, { signal, range, accept, transport = workerFetchThroughVless } = {}) {
  let url = mediaURL(value); const parsedRange = mediaRange(range); const accepted = mediaAccept(accept);
  const maximum = parsedRange?.bytes ?? LIMITS.mediaBytes;
  for (let count = 0; count <= 5; count++) {
    const result = await transport(node, url.href, { signal, maxBytes: maximum, timeoutMs: 30_000,
      headers: { Accept: accepted, Referer: 'https://www.xiaohongshu.com/', ...(parsedRange ? { Range: parsedRange.header } : {}) } });
    if (REDIRECTS.has(result.status)) {
      const location = result.headers.get('location');
      if (!location || count === 5) fail('UPSTREAM_REDIRECT_REJECTED');
      url = mediaURL(new URL(location, url).href); continue;
    }
    if (result.status === 416) fail('UPSTREAM_RANGE_UNAVAILABLE', 416);
    if (parsedRange && result.status !== 206) fail('UPSTREAM_RANGE_REQUIRED', 409);
    if (!parsedRange && result.status !== 200) fail('UPSTREAM_MEDIA_FAILED');
    const type = result.headers.get('content-type') ?? '';
    if (!/^(?:image\/|video\/|audio\/|application\/octet-stream(?:;|$))/i.test(type)) fail('UPSTREAM_MEDIA_CONTENT_REJECTED');
    const path = decodeURIComponent(url.pathname), spectrum = /(?:^|\/)spectrum(?:\/|$)/i.test(path);
    if (/^(?:video\/|audio\/)/i.test(type) && (!path.startsWith('/stream/') || spectrum)) fail('MEDIA_PATH_REJECTED', 400);
    if (spectrum && !/^image\//i.test(type)) fail('UPSTREAM_MEDIA_CONTENT_REJECTED');
    if (result.body.byteLength > maximum) fail('UPSTREAM_BODY_TOO_LARGE');
    const headers = new Headers({ 'Content-Type': type, 'Content-Length': String(result.body.byteLength),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (parsedRange) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers.get('content-range') ?? '');
      const [start, end, total] = match ? match.slice(1).map(Number) : [];
      if (!match || ![start, end, total].every(Number.isSafeInteger) || start !== parsedRange.start
        || end < start || end > parsedRange.end || total <= end || result.body.byteLength !== end - start + 1) fail('UPSTREAM_RANGE_REJECTED');
      headers.set('Content-Range', `bytes ${start}-${end}/${total}`); headers.set('Accept-Ranges', 'bytes');
    }
    return { status: result.status, headers, body: result.body };
  }
  fail('UPSTREAM_REDIRECT_REJECTED');
}

export class FreeSubscriptionService {
  constructor({ subscription = fetchFreshSubscription, transport = workerFetchThroughVless, now = Date.now } = {}) {
    Object.assign(this, { subscription, transport, now }); this.active = false; this.queue = []; this.cache = null;
  }
  enqueue(run, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active && this.queue.length >= LIMITS.queue) return Promise.reject(new ProxyError('PROXY_BUSY', 503));
    return new Promise((resolve, reject) => {
      const entry = { run, signal, resolve, reject };
      entry.abort = () => { const index = this.queue.indexOf(entry); if (index >= 0) { this.queue.splice(index, 1); reject(signal.reason); } };
      signal?.addEventListener('abort', entry.abort, { once: true }); this.queue.push(entry); void this.drain();
    });
  }
  async drain() {
    if (this.active || !this.queue.length) return;
    this.active = true; const entry = this.queue.shift(); entry.signal?.removeEventListener('abort', entry.abort);
    try { const signal = combinedSignal(entry.signal, LIMITS.operationMs); signal.throwIfAborted(); entry.resolve(await entry.run(signal)); }
    catch (error) { entry.reject(error); }
    finally { this.active = false; void this.drain(); }
  }
  async fresh(value, signal) {
    this.cache = null; const url = subscriptionURL(value).href;
    const nodes = parseSubscription(await this.subscription(url, { signal }));
    const endpoints = compatibleEndpoints(nodes);
    const healthy = await probeEndpoints(endpoints, { signal, transport: this.transport });
    signal.throwIfAborted();
    this.cache = { key: digest(url), healthy, nodeCount: nodes.length, endpointCount: endpoints.length,
      checkedAt: new Date(this.now()).toISOString(), expiresAt: this.now() + LIMITS.mediaTtlMs };
    return this.cache;
  }
  note(input, { signal } = {}) {
    noteURL(input?.url); subscriptionURL(input?.subscriptionUrl);
    return this.enqueue(async deadline => {
      const batch = await this.fresh(input.subscriptionUrl, deadline);
      const node = batch.healthy[0];
      const page = await fetchNote(input.url, node, { signal: deadline, transport: this.transport });
      return { ...page, nodeId: node.id, latencyMs: node.latencyMs, nodeCount: batch.nodeCount,
        endpointCount: batch.endpointCount, entrySelectionPreserved: node.entrySelectionPreserved, checkedAt: batch.checkedAt };
    }, signal);
  }
  media(input, { signal } = {}) {
    mediaURL(input?.url); subscriptionURL(input?.subscriptionUrl); mediaRange(input?.range); mediaAccept(input?.accept);
    return this.enqueue(async deadline => {
      const key = digest(subscriptionURL(input.subscriptionUrl).href);
      const batch = this.cache?.key === key && this.cache.expiresAt > this.now() ? this.cache : await this.fresh(input.subscriptionUrl, deadline);
      return fetchMedia(input.url, batch.healthy[0], { ...input, signal: deadline, transport: this.transport });
    }, signal);
  }
}
