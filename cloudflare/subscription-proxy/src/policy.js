import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { parseDocument, visit } from 'yaml';

export const LIMITS = Object.freeze({
  requestBytes: 16_384, subscriptionBytes: 2_097_152, noteBytes: 6_291_456,
  mediaBytes: 33_554_432, rangeBytes: 3_500_000, nodes: 64,
  probeConcurrency: 6, probeMs: 3_000, operationMs: 60_000,
  subscriptionMs: 10_000, requestMs: 15_000, mediaTtlMs: 60_000, queue: 4,
});
export class ProxyError extends Error {
  constructor(code, status = 502) { super(code); this.name = 'ProxyError'; this.code = code; this.status = status; }
}
export const fail = (code, status) => { throw new ProxyError(code, status); };
export const digest = (value) => createHash('sha256').update(value).digest('hex');

export function isPublicAddress(input) {
  const address = String(input).replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 2)
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  // Only global unicast; reject IPv4-mapped, local, multicast and documentation addresses.
  if (version === 6) return /^[23]/.test(address) && !/^2001:0?db8:/i.test(address);
  return false;
}

export function safeHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || /[\s/@?#\\\x00-\x1f]/.test(value)) return false;
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPublicAddress(host);
  if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/.test(host)) return false;
  return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function httpsURL(value, code) {
  if (typeof value !== 'string' || value.length > 8_192 || /[\x00-\x20\\]/.test(value)) fail(code, 400);
  let url;
  try { url = new URL(value); } catch { fail(code, 400); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !safeHostname(url.hostname)) fail(code, 400);
  url.hash = '';
  return url;
}

export function subscriptionURL(value) { return httpsURL(value, 'INVALID_SUBSCRIPTION_URL'); }
const NOTE_HOSTS = new Set(['xiaohongshu.com', 'www.xiaohongshu.com']);
const SHORT_HOSTS = new Set(['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);
export function noteURL(value) {
  const url = httpsURL(value, 'INVALID_NOTE_URL');
  const path = url.pathname;
  if (NOTE_HOSTS.has(url.hostname) && /^\/(?:explore|discovery\/item|item)\/[a-f0-9]{12,64}\/?$/i.test(path)) return url;
  if (SHORT_HOSTS.has(url.hostname) && /^\/[a-z0-9/_-]{1,160}$/i.test(path) && !path.includes('..')) return url;
  fail('INVALID_NOTE_URL', 400);
}
export function noteRedirect(value) {
  const url = httpsURL(value, 'UPSTREAM_REDIRECT_REJECTED');
  if (NOTE_HOSTS.has(url.hostname) && /(?:^|\/)(?:captcha|login|error|403|404|500)(?:\/|$)/i.test(url.pathname)) fail('UPSTREAM_VERIFICATION_REQUIRED', 422);
  try { return noteURL(url.href); } catch (error) {
    if (error?.code === 'UPSTREAM_VERIFICATION_REQUIRED') throw error;
    fail('UPSTREAM_REDIRECT_REJECTED');
  }
}

// Match the existing image parser's explicit CDN list. Spectrum is also used
// for public cover images; it is never a permitted video path.
const IMAGE_HOSTS = new Set(['sns-webpic-qc.xhscdn.com', 'sns-webpic.xhscdn.com',
  'sns-img-hw.xhscdn.com', 'sns-img-bd.xhscdn.com', 'sns-img-al.xhscdn.com', 'ci.xiaohongshu.com']);
export function mediaURL(value) {
  const url = httpsURL(value, 'INVALID_MEDIA_URL');
  if (!(url.hostname === 'xhscdn.com' || url.hostname.endsWith('.xhscdn.com') || url.hostname === 'ci.xiaohongshu.com')) fail('INVALID_MEDIA_URL', 400);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { fail('INVALID_MEDIA_URL', 400); }
  if (/[\\\x00-\x1f]/.test(path) || path.split('/').includes('..')) fail('MEDIA_PATH_REJECTED', 400);
  if (/(?:^|\/)spectrum(?:\/|$)/i.test(path) && !IMAGE_HOSTS.has(url.hostname)) fail('MEDIA_PATH_REJECTED', 400);
  if (/^sns-video[^.]*\.xhscdn\.com$/i.test(url.hostname) && !path.startsWith('/stream/')) fail('MEDIA_PATH_REJECTED', 400);
  return url;
}

export function mediaRange(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('INVALID_RANGE', 400);
  const match = /^bytes=(\d{1,16})-(\d{1,16})$/.exec(value);
  if (!match) fail('INVALID_RANGE', 400);
  const start = Number(match[1]), end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start + 1 > LIMITS.rangeBytes) fail('INVALID_RANGE', 400);
  return { header: `bytes=${start}-${end}`, start, end, bytes: end - start + 1 };
}

export function mediaAccept(value) {
  if (value == null || value === '') return '*/*';
  if (typeof value !== 'string' || value.length > 160 || !/^[a-zA-Z0-9/*+.,;= -]+$/.test(value)) fail('INVALID_ACCEPT', 400);
  return value;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const FINGERPRINTS = new Set(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized']);
export function parseSubscription(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.subscriptionBytes) fail('SUBSCRIPTION_TOO_LARGE');
  let data;
  try {
    const document = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true });
    if (document.errors.length || document.warnings.length) fail('SUBSCRIPTION_INVALID');
    // Reject syntax before conversion: older YAML versions do not count empty
    // collection aliases toward maxAliasCount, so that limit alone is not a ban.
    visit(document, { Alias() { fail('SUBSCRIPTION_INVALID'); } });
    data = document.toJS({ maxAliasCount: 0 });
  } catch { fail('SUBSCRIPTION_INVALID'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.proxies) || data.proxies.length > 256) fail('SUBSCRIPTION_INVALID');
  const nodes = [], seen = new Set();
  for (const item of data.proxies) {
    if (!item || typeof item !== 'object' || item.type !== 'vless' || item.network !== 'ws' || item.tls !== true
      || item['skip-cert-verify'] === true || !UUID.test(item.uuid ?? '') || !safeHostname(item.server)
      || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535 || item.flow || item['reality-opts']
      || (item.encryption && item.encryption !== 'none') || item['dialer-proxy'] || item['ws-opts']?.['v2ray-http-upgrade']) continue;
    const servername = item.servername ?? item['sni'] ?? item.server;
    const ws = item['ws-opts'];
    if (!safeHostname(servername) || !ws || typeof ws !== 'object' || typeof ws.path !== 'string'
      || !ws.path.startsWith('/') || ws.path.length > 2_048 || /[\x00-\x20]/.test(ws.path)) continue;
    const wsHost = ws.headers?.Host ?? ws.headers?.host ?? servername;
    if (!safeHostname(wsHost)) continue;
    if (ws['max-early-data'] && (!Number.isInteger(ws['max-early-data']) || ws['max-early-data'] < 0 || ws['max-early-data'] > 4096)) continue;
    if (ws['early-data-header-name'] && ws['early-data-header-name'] !== 'Sec-WebSocket-Protocol') continue;
    const config = {
      type: 'vless', server: item.server.toLowerCase(), port: item.port, uuid: item.uuid.toLowerCase(),
      tls: true, servername: servername.toLowerCase(), network: 'ws', 'skip-cert-verify': false,
      'ws-opts': { path: ws.path, headers: { Host: wsHost.toLowerCase() } },
    };
    if (FINGERPRINTS.has(item['client-fingerprint'])) config['client-fingerprint'] = item['client-fingerprint'];
    if (ws['max-early-data']) config['ws-opts']['max-early-data'] = ws['max-early-data'];
    if (ws['early-data-header-name']) config['ws-opts']['early-data-header-name'] = 'Sec-WebSocket-Protocol';
    const id = digest(JSON.stringify(config)).slice(0, 24);
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, config });
    if (nodes.length > LIMITS.nodes) fail('SUBSCRIPTION_NODE_LIMIT');
  }
  if (!nodes.length) fail('SUBSCRIPTION_NO_SUPPORTED_NODES');
  return nodes;
}

export function classifyNote(html) {
  const head = html.slice(0, 120_000);
  if (/<title[^>]*>[^<]*(?:安全验证|验证码|访问验证|Security Verification)/i.test(head)
    || /(?:请完成|请先完成|拖动滑块|验证码验证|captcha-container|id=["']captcha)/i.test(head)) fail('UPSTREAM_VERIFICATION_REQUIRED', 422);
  if (/<title[^>]*>[^<]*(?:登录|Login)/i.test(head)) fail('UPSTREAM_LOGIN_REQUIRED', 422);
}

export function publicError(error) {
  if (error instanceof ProxyError) return { code: error.code, status: error.status };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { code: 'PROXY_TIMEOUT', status: 504 };
  return { code: 'PROXY_UNAVAILABLE', status: 502 };
}
