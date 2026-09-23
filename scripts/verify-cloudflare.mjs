#!/usr/bin/env node
// Anonymous, non-mutating deployment checks. Never print request values or response bodies.
import { pathToFileURL } from 'node:url';
import { isXhsVideoUrl, validateAssetToken } from '../lib/xhs.js';

const DIRECT_TOKEN = 'smoke-fixture/original_image';
const DIRECT_URL = `https://ci.xiaohongshu.com/${DIRECT_TOKEN}?imageView2/format/jpg`;
const FIXTURE_VIDEO = 'https://sns-video-bd.xhscdn.com/smoke-fixture.mp4';
const JSON_HEADERS = { 'content-type': 'application/json' };
const LIMIT = 512 * 1024;
const TIMEOUT = 25_000;

class CheckError extends Error {}
function requireCheck(value, message) { if (!value) throw new CheckError(message); }
const jsonRequest = value => ({ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(value) });

function safeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new CheckError('Base URL must be an HTTP(S) origin.'); }
  requireCheck(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Base URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  return url.origin;
}

export function parseArgs(args) {
  const options = { baseUrl: 'https://xhs.download.brclio.com', json: false };
  let baseSet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (['--note-url', '--image-token', '--video-url'].includes(arg)) {
      requireCheck(Boolean(args[i + 1]) && !args[i + 1].startsWith('--'), 'An optional media argument is missing its value.');
      options[{ '--note-url': 'noteUrl', '--image-token': 'imageToken', '--video-url': 'videoUrl' }[arg]] = args[++i];
    } else {
      requireCheck(!arg.startsWith('-') && !baseSet, 'Unknown or duplicate command argument.');
      options.baseUrl = arg;
      baseSet = true;
    }
  }
  options.baseUrl = safeOrigin(options.baseUrl);
  if (options.noteUrl) {
    let url;
    try { url = new URL(options.noteUrl); } catch { throw new CheckError('Optional note URL is invalid.'); }
    requireCheck(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && /(?:^|\.)(?:xiaohongshu\.com|xhslink\.com|xhslink\.cn)$/i.test(url.hostname), 'Optional note URL must use an allowed Xiaohongshu HTTPS host.');
  }
  if (options.imageToken) requireCheck(validateAssetToken(options.imageToken), 'Optional image token is invalid.');
  if (options.videoUrl) requireCheck(isXhsVideoUrl(options.videoUrl), 'Optional video URL must use an allowed Xiaohongshu CDN host.');
  return options;
}

function apiJson(response, expectedStatus, { errorCode, success = false, noStore = true } = {}) {
  requireCheck(response.status === expectedStatus, `Expected HTTP ${expectedStatus}.`);
  requireCheck(/application\/json/i.test(response.headers.get('content-type') || ''), 'Expected JSON content type.');
  requireCheck(response.headers.get('x-content-type-options')?.toLowerCase() === 'nosniff', 'Missing nosniff header.');
  if (noStore) requireCheck(/(?:^|[,\s])no-store(?:$|[,\s])/i.test(response.headers.get('cache-control') || ''), 'Missing no-store header.');
  let payload;
  try { payload = JSON.parse(response.text); } catch { throw new CheckError('Response was not valid JSON.'); }
  requireCheck(payload && typeof payload === 'object', 'Expected a JSON object.');
  requireCheck(errorCode ? payload.ok === false && payload.error?.code === errorCode : payload.success === success, 'Response contract did not match.');
  requireCheck(!response.headers.has('set-cookie'), 'Anonymous check unexpectedly set a cookie.');
  return payload;
}

function adminHeaders(response) {
  requireCheck(response.headers.get('x-content-type-options')?.toLowerCase() === 'nosniff', 'Missing admin nosniff header.');
  requireCheck(response.headers.get('x-frame-options')?.toUpperCase() === 'DENY', 'Missing admin frame protection.');
  requireCheck(response.headers.get('referrer-policy') === 'no-referrer', 'Missing admin referrer protection.');
  requireCheck(/(?:^|[,\s])no-store(?:$|[,\s])/i.test(response.headers.get('cache-control') || ''), 'Missing admin no-store header.');
  const csp = response.headers.get('content-security-policy') || '';
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    requireCheck(csp.split(';').some(value => value.trim() === directive), 'Missing required admin CSP directive.');
  }
}

export function buildChecks(options = {}) {
  const checks = [];
  const add = (name, path, init, verify, extra = {}) => checks.push({ name, path, init, verify, ...extra });
  for (const [name, path, type, marker] of [
    ['home', '/', /text\/html/i, '<title>Brclio'],
    ['changelog', '/changelog', /text\/html/i, '<html'],
    ['main-script', '/app.js', /(?:javascript|ecmascript)/i],
    ['main-style', '/style.css', /text\/css/i],
    ['account-script', '/account-ui.js', /(?:javascript|ecmascript)/i],
    ['archive-module', '/lib/archive.js', /(?:javascript|ecmascript)/i],
    ['favicon', '/favicon.svg', /image\/svg\+xml/i],
    ['admin', '/admin', /text\/html/i, 'id="login-form"'],
    ['admin-trailing-slash', '/admin/', /text\/html/i, 'id="login-form"'],
    ['admin-script', '/admin/admin.js', /(?:javascript|ecmascript)/i],
    ['admin-style', '/admin/admin.css', /text\/css/i],
  ]) {
    add(`static/${name}`, path, {}, response => {
      requireCheck(response.status === 200, 'Expected HTTP 200.');
      requireCheck(type.test(response.headers.get('content-type') || ''), 'Unexpected static content type.');
      requireCheck(response.bytes.length > 0, 'Static asset was empty.');
      if (marker) requireCheck(response.text.includes(marker), 'Static page marker was missing.');
      if (name.startsWith('admin')) adminHeaders(response);
    }, { allowRedirect: true });
  }

  for (const [engine, prefix] of [['node', ''], ['python', 'python_']]) {
    const parsePath = `/api/${prefix}parse`;
    const rejectedParse = (name, init, status = 400) => add(`${engine}/parse/${name}`, parsePath, init, response => apiJson(response, status));
    rejectedParse('method', {}, 405);
    rejectedParse('empty', jsonRequest({ text: '' }));
    rejectedParse('malformed', { method: 'POST', headers: JSON_HEADERS, body: '{' });
    rejectedParse('untrusted-url', jsonRequest({ text: 'https://example.invalid/not-a-note' }));
    rejectedParse('input-size', jsonRequest({ text: 'x'.repeat(3001) }), 413);
    add(`${engine}/parse/direct-image`, parsePath, jsonRequest({ text: DIRECT_URL }), response => {
      const data = apiJson(response, 200, { success: true });
      requireCheck(data.engine === engine && data.count === 1 && data.images?.length === 1 && data.images[0].token === DIRECT_TOKEN && data.images[0].url === DIRECT_URL && data.videoCount === 0, 'Direct image parse contract did not match.');
    });
    for (const kind of ['image', 'video']) {
      add(`${engine}/${kind}/method`, `/api/${prefix}${kind}`, { method: 'POST' }, response => apiJson(response, 405, { noStore: kind !== 'image' }));
      add(`${engine}/${kind}/missing-input`, `/api/${prefix}${kind}`, {}, response => apiJson(response, 400, { noStore: kind !== 'image' }));
    }
    add(`${engine}/image/invalid-token`, `/api/${prefix}image?token=..%2Fnot-a-token`, {}, response => apiJson(response, 400, { noStore: false }));
    add(`${engine}/video/untrusted-url`, `/api/${prefix}video?url=${encodeURIComponent('https://example.invalid/video.mp4')}`, {}, response => apiJson(response, 400));
    add(`${engine}/video/invalid-range`, `/api/${prefix}video?${new URLSearchParams({ url: FIXTURE_VIDEO, action: 'chunk', start: '10', end: '9' })}`, {}, response => apiJson(response, 400));
    add(`${engine}/video/oversize-range`, `/api/${prefix}video?${new URLSearchParams({ url: FIXTURE_VIDEO, action: 'chunk', start: '0', end: '3500000' })}`, {}, response => apiJson(response, 413));

    if (options.noteUrl) add(`${engine}/upstream/note`, parsePath, jsonRequest({ text: options.noteUrl }), response => {
      const data = apiJson(response, 200, { success: true });
      requireCheck(data.engine === engine && Array.isArray(data.images) && Array.isArray(data.videos) && data.images.length + data.videos.length > 0, 'Note did not produce media.');
    });
    if (options.imageToken) add(`${engine}/upstream/image`, `/api/${prefix}image?${new URLSearchParams({ token: options.imageToken, name: 'smoke.jpg' })}`, {}, response => {
      requireCheck(response.status === 200 && /^image\//i.test(response.headers.get('content-type') || '') && response.bytes.length > 16, 'Image download contract did not match.');
      requireCheck(response.headers.get('x-xhs-engine') === engine, 'Image engine header did not match.');
      requireCheck(/^attachment;/i.test(response.headers.get('content-disposition') || ''), 'Image attachment header was missing.');
    }, { maxBytes: 4_200_000 });
    if (options.videoUrl) {
      add(`${engine}/upstream/video-meta`, `/api/${prefix}video?${new URLSearchParams({ url: options.videoUrl, action: 'meta' })}`, {}, response => {
        const data = apiJson(response, 200, { success: true });
        requireCheck(data.engine === engine && Number.isSafeInteger(data.size) && data.size > 0 && data.chunkSize === 3_500_000, 'Video metadata contract did not match.');
      });
      add(`${engine}/upstream/video-chunk`, `/api/${prefix}video?${new URLSearchParams({ url: options.videoUrl, action: 'chunk', start: '0', end: '4095' })}`, {}, response => {
        requireCheck([200, 206].includes(response.status) && response.bytes.length === 4096, 'Video chunk contract did not match.');
        requireCheck(/^(?:video\/|application\/octet-stream)/i.test(response.headers.get('content-type') || ''), 'Video chunk content type did not match.');
        requireCheck(response.headers.get('x-xhs-engine') === engine, 'Video engine header did not match.');
      }, { maxBytes: 4096 });
    }
  }

  // These fail at the HTTP boundary before config, storage, rate limits or mailer access.
  for (const [name, init, status, errorCode] of [
    ['method', {}, 405, 'METHOD_NOT_ALLOWED'],
    ['content-type', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['malformed', { method: 'POST', headers: JSON_HEADERS, body: '{' }, 400, 'INVALID_JSON'],
    ['invalid-shape', jsonRequest([]), 400, 'INVALID_REQUEST'],
    ['body-size', jsonRequest({ padding: 'x'.repeat(16_384) }), 413, 'REQUEST_TOO_LARGE'],
  ]) add(`account/${name}`, '/api/account', init, response => apiJson(response, status, { errorCode }));
  return checks;
}

async function readBounded(response, maxBytes) {
  requireCheck(Number(response.headers.get('content-length') || 0) <= maxBytes, 'Response exceeded byte limit.');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireCheck(total <= maxBytes, 'Response exceeded byte limit.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, total);
}

async function requestCheck(origin, check, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    let url = new URL(check.path, origin);
    for (let redirects = 0; ; redirects++) {
      response = await fetchImpl(url, { ...check.init, redirect: 'manual', credentials: 'omit', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status) || !check.allowRedirect) break;
      await response.body?.cancel();
      requireCheck(redirects < 3 && Boolean(response.headers.get('location')), 'Too many or invalid static redirects.');
      url = new URL(response.headers.get('location'), url);
      requireCheck(url.origin === origin && !url.username && !url.password, 'Static redirect left the requested origin.');
    }
    const bytes = await readBounded(response, check.maxBytes || LIMIT);
    return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') };
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => {});
  }
}

export async function runSmoke(options, { fetchImpl = fetch, checks = buildChecks(options), timeoutMs = TIMEOUT, onResult = () => {} } = {}) {
  const origin = safeOrigin(options.baseUrl);
  const results = [];
  for (const check of checks) {
    const started = Date.now();
    const result = { name: check.name, ok: false };
    try {
      const response = await requestCheck(origin, check, fetchImpl, timeoutMs);
      result.status = response.status;
      check.verify(response);
      result.ok = true;
    } catch (error) {
      // Fetch errors can contain signed URLs, headers and response content. Only our
      // fixed assertion messages cross the reporting boundary.
      result.reason = error instanceof CheckError ? error.message : 'Request failed or timed out.';
    }
    result.durationMs = Date.now() - started;
    results.push(result);
    onResult(result);
  }
  return { origin, checkedAt: new Date().toISOString(), passed: results.filter(result => result.ok).length, total: results.length, ok: results.every(result => result.ok), realMediaChecks: Boolean(options.noteUrl || options.imageToken || options.videoUrl), results };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log('Usage: node scripts/verify-cloudflare.mjs [BASE_ORIGIN] [--json] [--note-url URL] [--image-token TOKEN] [--video-url URL]\nDefault checks are anonymous and do not access account storage or send mail. Optional media checks fetch a supplied public note, image, or the first 4096 video bytes. JSON output contains only check names, statuses and fixed failure reasons.');
      return 0;
    }
    const report = await runSmoke(options, { onResult: result => {
      if (!options.json) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.status ? ` HTTP ${result.status}` : ''}${result.reason ? `: ${result.reason}` : ''}`);
    } });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`${report.passed}/${report.total} passed. ${report.realMediaChecks ? 'Includes optional upstream media checks.' : 'Real upstream media, authenticated accounts and SMTP delivery are not covered.'}`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof CheckError ? error.message : 'Smoke checker failed.');
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
