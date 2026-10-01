// Explicit opt-in live acceptance. Only the supplied XHS page and its CDN are
// contacted. Accounts, memberships and credentials exist in test-only memory.
// node scripts/verify-member-video-live.mjs --input-file=/private/note.txt --output=/private/original.mp4
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { emptyState } from '../server/auth/store.js';
import { digest } from '../server/auth/crypto.js';
import { readConfig } from '../server/auth/config.js';
import { createAccountService } from '../server/auth/service.js';
import { createAccountHandler, BROWSER_COOKIE } from '../api/account.js';
import { createHostedMemberVideoHandler } from '../api/member_video.js';
import { resolveOriginalVideos } from '../lib/member-video-handler.js';
import { extractInputUrl, isXhsVideoUrl } from '../lib/xhs.js';
import { inspectMp4Tracks } from '../lib/media-tracks.js';
import { invokeHandler } from '../cloudflare/http-adapter.js';

const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const SITE_ORIGIN = 'https://member-video-live.invalid';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Opt-in XHS member gateway acceptance: --input-file=/private/note.txt --output=/private/original.mp4');
  process.exit(0);
}
const options = Object.create(null);
for (const arg of args) {
  const match = arg.match(/^--(input-file|output)=(.+)$/);
  if (!match || options[match[1]]) throw new Error('Provide exactly one --input-file and one --output argument.');
  options[match[1]] = match[2];
}
if (!options['input-file'] || !options.output) throw new Error('Explicit --input-file and --output are required.');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function safeMessage(error) {
  return String(error?.message || 'Live acceptance failed.').replace(/https?:\/\/[^\s"'<>]+/gi, '[private URL withheld]')
    .replace(/member-video:[A-Za-z0-9_-]+/g, '[download ticket withheld]');
}
async function requireAbsent(filename) {
  try { await fs.stat(filename); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output or partial file already exists; choose another output path.');
}
async function responseJSON(response, label) {
  const value = await response.json().catch(() => null);
  requireCondition(response.ok && value?.success === true, `${label} failed (HTTP ${response.status}, ${value?.code || 'no-code'}).`);
  return value;
}

async function main() {
  const inputFile = path.resolve(options['input-file']);
  const output = path.resolve(options.output), partial = `${output}.part`, reportFile = `${output}.json`;
  requireCondition((await fs.stat(inputFile)).size <= 12_000, 'Input file is too large for a single share link.');
  const text = (await fs.readFile(inputFile, 'utf8')).trim();
  requireCondition(text.length > 0 && text.length <= 3000, 'Input must contain one valid share link or share text under 3001 characters.');
  extractInputUrl(text); // Validate without logging the signed link.
  await requireAbsent(output); await requireAbsent(partial); await requireAbsent(reportFile);
  await fs.mkdir(path.dirname(output), { recursive: true });

  const pepper = randomBytes(48).toString('base64url');
  const env = { AUTH_SECRET_PEPPER: pepper, AUTH_SITE_ORIGIN: SITE_ORIGIN };
  const config = readConfig(env), state = emptyState();
  const issuedAt = Date.now(), memberId = randomUUID(), ordinaryId = randomUUID();
  const memberToken = randomBytes(32).toString('base64url'), ordinaryToken = randomBytes(32).toString('base64url');
  const seed = (id, token, member) => {
    state.users[id] = { id, email: `${id}@example.test`, role: 'user', createdAt: new Date(issuedAt).toISOString(),
      membership: member ? { type: 'duration', startsAt: new Date(issuedAt - 60_000).toISOString(), expiresAt: new Date(issuedAt + 86_400_000).toISOString() }
        : { type: 'none', startsAt: null, expiresAt: null } };
    state.sessions[digest(pepper, 'session', token)] = { id: randomUUID(), userId: id, client: 'browser', createdAt: new Date(issuedAt).toISOString(), revokedAt: null, deviceId: null, deviceStatus: 'unbound' };
  };
  seed(memberId, memberToken, true); seed(ordinaryId, ordinaryToken, false);
  let accountReads = 0, accountTransactions = 0, authorizationCalls = 0, resolveCalls = 0;
  const store = {
    async read() { accountReads++; return { state: structuredClone(state), sha: 'test-only-memory' }; },
    async transaction() { accountTransactions++; throw new Error('Live acceptance must never mutate its test account store.'); },
  };
  const service = createAccountService({ store, config, mailer: { configured: false, async send() { throw new Error('Mail must never be sent by live acceptance.'); } } });
  const accountHandler = createAccountHandler({ service, config, env });
  let resolved;
  const handler = createHostedMemberVideoHandler({ env,
    accountFetch: async request => {
      const body = await request.clone().json();
      requireCondition(body.action === 'authorize' && body.input?.client === 'browser' && body.input.feature === 'watermark-free-video', 'Unexpected account action.');
      authorizationCalls++;
      return invokeHandler(accountHandler, request);
    },
    resolve: async input => { resolveCalls++; resolved = await resolveOriginalVideos(input); return resolved; },
  });
  const headers = token => ({ 'Content-Type': 'application/json', Origin: SITE_ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...(token ? { Cookie: `${BROWSER_COOKIE}=${token}` } : {}) });
  const post = token => new Request(`${SITE_ORIGIN}/api/member_video`, { method: 'POST', headers: headers(token), body: JSON.stringify({ text }) });
  const get = (action, ticket, token = memberToken, extra = {}) => new Request(`${SITE_ORIGIN}/api/member_video?${new URLSearchParams({ action, ticket, ...extra })}`, { headers: headers(token) });

  const realFetch = globalThis.fetch, realConsoleError = console.error;
  const networkByPhase = Object.create(null);
  let phase = 'guest', networkRequests = 0, file;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const allowed = ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn', 'xhscdn.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
    requireCondition(allowed && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'), 'Live acceptance attempted a request outside the XHS page/CDN allowlist.');
    networkRequests++; networkByPhase[phase] = (networkByPhase[phase] || 0) + 1;
    return realFetch(input, init);
  };
  // Handler error objects can contain request URLs. Keep all diagnostics private.
  console.error = () => process.stderr.write('A gateway request was rejected; private handler details withheld.\n');
  try {
    const guest = await invokeHandler(handler, post(''));
    requireCondition([401, 403].includes(guest.status) && networkRequests === 0 && resolveCalls === 0, 'Guest rejection must occur before any source fetch.');
    phase = 'ordinary';
    const ordinary = await invokeHandler(handler, post(ordinaryToken));
    requireCondition(ordinary.status === 403 && networkRequests === 0 && resolveCalls === 0, 'Ordinary accounts must be rejected before any source fetch.');
    phase = 'resolve';
    const authorized = await responseJSON(await invokeHandler(handler, post(memberToken)), 'Member resolver');
    const candidate = resolved?.originalVideos?.[0], video = authorized.videos?.[0];
    requireCondition(resolveCalls === 1 && isXhsVideoUrl(candidate?.url), 'The real note page did not expose a supported original source.');
    requireCondition(video?.url?.startsWith('member-video:') && !JSON.stringify(authorized).includes(candidate.url), 'The member gateway must return an encrypted ticket rather than the original URL.');
    requireCondition(/^[a-f0-9]{32}$/i.test(candidate.declaredMd5 || '') && candidate.declaredMd5 === video.declaredMd5, 'A page-declared original MD5 is required for this acceptance.');
    const ticket = video.url.slice('member-video:'.length);

    phase = 'guest-ticket';
    let before = networkRequests;
    const guestTicket = await invokeHandler(handler, get('meta', ticket, ''));
    requireCondition([401, 403].includes(guestTicket.status) && networkRequests === before, 'Guest ticket access must be rejected before fetching media.');
    phase = 'revoked-ticket';
    const session = state.sessions[digest(pepper, 'session', memberToken)];
    session.revokedAt = new Date().toISOString();
    const revoked = await invokeHandler(handler, get('meta', ticket));
    requireCondition([401, 403].includes(revoked.status) && networkRequests === before, 'Revocation after ticket issuance must be checked live before fetching media.');
    session.revokedAt = null; // Test-only local fixture restoration.

    phase = 'metadata';
    const metadata = await responseJSON(await invokeHandler(handler, get('meta', ticket)), 'Member metadata');
    const size = Number(metadata.size), chunkSize = Number(metadata.chunkSize);
    requireCondition(Number.isSafeInteger(size) && size > 0 && size <= MAX_VIDEO_BYTES, 'Metadata size is outside the gateway safety limit.');
    requireCondition(Number.isSafeInteger(chunkSize) && chunkSize > 0 && chunkSize <= 3_500_000, 'Gateway chunk size is invalid.');
    const totalChunks = Math.ceil(size / chunkSize), md5 = createHash('md5');
    let received = 0;
    file = await fs.open(partial, 'wx+', 0o600);
    phase = 'chunk';
    for (let index = 0; index < totalChunks; index++) {
      const start = index * chunkSize, end = Math.min(size - 1, start + chunkSize - 1), expected = end - start + 1;
      const response = await invokeHandler(handler, get('chunk', ticket, memberToken, { start: String(start), end: String(end) }));
      requireCondition(response.ok, `Member chunk ${index + 1} failed (HTTP ${response.status}).`);
      requireCondition(Number(response.headers.get('content-length')) === expected, `Member chunk ${index + 1} declared length is incorrect.`);
      requireCondition(response.headers.get('content-range') === `bytes ${start}-${end}/${size}`, `Member chunk ${index + 1} returned an incorrect byte range.`);
      requireCondition(response.body, `Member chunk ${index + 1} has no body.`);
      const reader = response.body.getReader();
      let chunkBytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          chunkBytes += value.byteLength;
          requireCondition(chunkBytes <= expected, `Member chunk ${index + 1} exceeds the requested range.`);
          let written = 0;
          while (written < value.byteLength) {
            const result = await file.write(value, written, value.byteLength - written, received + written);
            requireCondition(result.bytesWritten > 0, 'Partial file write did not advance.'); written += result.bytesWritten;
          }
          md5.update(value); received += value.byteLength;
        }
      } finally { reader.releaseLock(); }
      requireCondition(chunkBytes === expected, `Member chunk ${index + 1} is incomplete.`);
      if ((index + 1) % 10 === 0 || index + 1 === totalChunks) process.stderr.write(JSON.stringify({ phase: 'member-gateway-chunks', completed: index + 1, totalChunks, bytes: received, totalBytes: size }) + '\n');
    }
    requireCondition(received === size && (await file.stat()).size === size, 'Combined gateway file size does not match metadata.');
    const actualMd5 = md5.digest('hex');
    requireCondition(actualMd5 === candidate.declaredMd5.toLowerCase(), 'Combined gateway MP4 does not match the original MD5 declared by the page.');
    const tracks = await inspectMp4Tracks(async (start, length) => {
      const bytes = new Uint8Array(length); let filled = 0;
      while (filled < length) { const result = await file.read(bytes, filled, length - filled, start + filled); if (!result.bytesRead) break; filled += result.bytesRead; }
      return bytes.subarray(0, filled);
    }, size);
    requireCondition(tracks.hasVideo && tracks.hasAudio, 'Verified original must contain both video and audio tracks.');
    requireCondition(authorizationCalls >= totalChunks + 4 && accountReads === authorizationCalls && accountTransactions === 0, 'The gateway did not recheck the test account on every metadata/chunk request.');
    requireCondition(state.audit.length === 0 && Object.keys(state.otps).length === 0, 'Acceptance unexpectedly performed account mutations.');
    await file.sync(); await file.close(); file = null;
    await fs.rename(partial, output);
    const report = {
      ok: true, gateway: 'createHostedMemberVideoHandler', accountStore: 'isolated test-only memory',
      guestStatus: guest.status, ordinaryStatus: ordinary.status, guestTicketStatus: guestTicket.status, revokedTicketStatus: revoked.status,
      bytes: size, md5: actualMd5, declaredMd5: candidate.declaredMd5, declaredMd5Matches: true,
      chunks: totalChunks, chunkSize, authorizationCalls, accountReads, accountTransactions,
      networkRequests, networkByPhase, sourceMetadata: { source: video.source, sourceField: video.sourceField,
        metadataSource: video.metadataSource, sourceWatermark: video.sourceWatermark, width: video.width, height: video.height },
      hasVideo: tracks.hasVideo, hasAudio: tracks.hasAudio, tracks: tracks.tracks,
      productionAccountChanged: false, mailSent: false, output, completedAt: new Date().toISOString(),
    };
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ ...report, reportFile }));
  } finally {
    globalThis.fetch = realFetch; console.error = realConsoleError;
    await file?.close().catch(() => {});
  }
}

main().catch(error => { process.stderr.write(JSON.stringify({ ok: false, error: safeMessage(error), partialMayRemain: true }) + '\n'); process.exitCode = 1; });
