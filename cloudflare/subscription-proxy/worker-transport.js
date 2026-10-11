import { makeTLSClient, setCryptoImplementation } from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';
import { HTTPResponseDecoder } from './src/worker-http.js';
import { verifyStrictCertificateChain } from './src/worker-certificates.js';
import { noteURL, mediaURL } from './src/policy.js';

setCryptoImplementation(webcryptoCrypto);
const encoder = new TextEncoder();
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export class WorkerTransportError extends Error {
  constructor(code) { super(code); this.name = 'WorkerTransportError'; this.code = code; }
}
const reject = (code) => { throw new WorkerTransportError(code); };

export function buildVlessRequest(uuid, hostname, port = 443) {
  if (!UUID.test(uuid ?? '') || !DOMAIN.test(hostname ?? '') || !Number.isInteger(port) || port < 1 || port > 65535) reject('VLESS_INPUT_REJECTED');
  const host = encoder.encode(hostname.toLowerCase());
  const identity = Uint8Array.from(uuid.replaceAll('-', '').match(/../g).map((byte) => Number.parseInt(byte, 16)));
  const result = new Uint8Array(23 + host.length);
  // version(0), UUID(16), addons-length(0), TCP command(1), port(2), domain(2), length(1)
  result[0] = 0; result.set(identity, 1); result[17] = 0; result[18] = 1;
  result[19] = port >>> 8; result[20] = port & 255; result[21] = 2; result[22] = host.length;
  result.set(host, 23);
  return result;
}

export function createVlessResponseDecoder() {
  let prefix = new Uint8Array(0), remaining = null, complete = false;
  return {
    push(input) {
      if (!(input instanceof Uint8Array)) reject('VLESS_RESPONSE_REJECTED');
      if (complete) return input;
      if (remaining == null) {
        const bytes = new Uint8Array(prefix.length + input.length);
        bytes.set(prefix); bytes.set(input, prefix.length);
        if (bytes.length && bytes[0] !== 0) reject('VLESS_VERSION_REJECTED');
        if (bytes.length < 2) { prefix = bytes; return new Uint8Array(0); }
        remaining = bytes[1]; prefix = new Uint8Array(0); input = bytes.subarray(2);
      }
      const consumed = Math.min(remaining, input.length);
      remaining -= consumed;
      if (remaining) return new Uint8Array(0);
      complete = true;
      return input.subarray(consumed);
    },
    finish() { if (!complete) reject('VLESS_TRUNCATED_RESPONSE'); },
  };
}

// Workers cannot independently set destination IP and verified WSS SNI.
// This returns the TLS hostname route, with an explicit fact about entry selection.
export function workerWssEndpoint(node) {
  if (!node || node.type !== 'vless' || node.network !== 'ws' || node.tls !== true || node['skip-cert-verify'] === true || !UUID.test(node.uuid ?? '')) reject('VLESS_NODE_REJECTED');
  const sni = node.servername ?? node.sni ?? node.server;
  const host = node['ws-opts']?.headers?.Host ?? node['ws-opts']?.headers?.host ?? sni;
  const path = node['ws-opts']?.path;
  if (!DOMAIN.test(sni ?? '') || !DOMAIN.test(host ?? '') || sni.toLowerCase() !== host.toLowerCase()
    || typeof path !== 'string' || !path.startsWith('/') || path.length > 2048 || /[\x00-\x20\\#]/.test(path)
    || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) reject('VLESS_WSS_ENDPOINT_REJECTED');
  const url = new URL(`https://${host}:${node.port}${path}`);
  if (url.hostname !== host.toLowerCase()) reject('VLESS_WSS_ENDPOINT_REJECTED');
  return { url, entrySelectionPreserved: String(node.server).toLowerCase() === host.toLowerCase() };
}

const quietLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {}, trace() {} });
const joinBytes = (first, second) => { const output = new Uint8Array(first.length + second.length); output.set(first); output.set(second, first.length); return output; };
const PROBE = 'https://www.gstatic.com/generate_204';

function targetURL(value) {
  let url;
  try { url = new URL(value); } catch { reject('PROXY_TARGET_REJECTED'); }
  if (url.href === PROBE) return url;
  try { return noteURL(url.href); } catch { /* Try the media allowlist. */ }
  try { return mediaURL(url.href); } catch { reject('PROXY_TARGET_REJECTED'); }
}

function httpRequest(url, supplied = {}) {
  const headers = new Headers(supplied);
  const allowed = new Set(['accept', 'accept-language', 'range', 'referer', 'user-agent']);
  for (const [name, value] of headers) {
    if (!allowed.has(name) || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) reject('PROXY_HEADER_REJECTED');
  }
  const range = headers.get('range');
  if (range) {
    const match = /^bytes=(\d{1,16})-(\d{1,16})$/.exec(range);
    const start = Number(match?.[1]), end = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start + 1 > 3_500_000) reject('PROXY_HEADER_REJECTED');
  }
  const referer = headers.get('referer');
  if (referer && referer !== 'https://www.xiaohongshu.com/') reject('PROXY_HEADER_REJECTED');
  if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
  if (!headers.has('accept')) headers.set('accept', '*/*');
  const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.hostname}`, 'Connection: close', 'Accept-Encoding: identity'];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  return encoder.encode(`${lines.join('\r\n')}\r\n\r\n`);
}

async function openWorkerWebSocket(url, signal) {
  const response = await fetch(url, { headers: { Upgrade: 'websocket' }, redirect: 'manual', signal });
  if (response.status !== 101 || !response.webSocket) { await response.body?.cancel(); reject('PROXY_WSS_REJECTED'); }
  response.webSocket.binaryType = 'arraybuffer';
  response.webSocket.accept();
  return response.webSocket;
}

async function decodeContent(result, maxBytes) {
  const encoding = result.headers.get('content-encoding')?.toLowerCase() ?? 'identity';
  if (encoding === 'identity') return result;
  if (!['gzip', 'deflate'].includes(encoding)) reject('PROXY_HTTP_ENCODING_REJECTED');
  const stream = new Blob([result.body]).stream().pipeThrough(new DecompressionStream(encoding));
  const reader = stream.getReader(), parts = [];
  let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > maxBytes) { await reader.cancel(); reject('PROXY_HTTP_BODY_TOO_LARGE'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(count); let at = 0;
  for (const part of parts) { body.set(part, at); at += part.length; }
  result.headers.delete('content-encoding'); result.headers.delete('content-length');
  return { ...result, body };
}

export async function workerFetchThroughVless(node, value, {
  headers = {}, signal, maxBytes = 6_291_456, timeoutMs = 15_000,
  // Dependency injection supports local native-Node probes and deterministic lifecycle tests.
  openWebSocket = openWorkerWebSocket, makeClient = makeTLSClient, verifyChain = verifyStrictCertificateChain,
} = {}) {
  const config = node?.config ?? node;
  const endpoint = workerWssEndpoint(config), url = targetURL(value);
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 33_554_432 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) reject('PROXY_LIMIT_REJECTED');
  const http = httpRequest(url, headers), vless = buildVlessRequest(config.uuid, url.hostname);
  const activeSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  activeSignal.throwIfAborted();
  const websocket = await openWebSocket(endpoint.url, activeSignal);
  if (activeSignal.aborted) { try { websocket.close(); } catch { /* Already closed. */ } activeSignal.throwIfAborted(); }
  const decoder = new HTTPResponseDecoder(maxBytes), vlessDecoder = createVlessResponseDecoder();
  let tls, sentHeader = false, chainCheck, identityVerified = false, finished = false, receive = Promise.resolve(), queuedBytes = 0, wireBytes = 0;
  const result = await new Promise((resolve, rejectResult) => {
    const end = (error, response) => {
      if (finished) return;
      finished = true;
      activeSignal.removeEventListener('abort', onAbort);
      websocket.removeEventListener('message', onMessage);
      websocket.removeEventListener('close', onClose);
      websocket.removeEventListener('error', onError);
      try { websocket.close(); } catch { /* Close errors never expose the endpoint. */ }
      if (error) rejectResult(new WorkerTransportError(error)); else resolve(response);
    };
    const onAbort = () => end('PROXY_TIMEOUT');
    const onError = () => end('PROXY_WSS_FAILED');
    const complete = () => {
      if (!identityVerified) { end('PROXY_TLS_CERTIFICATE_REJECTED'); return; }
      try { vlessDecoder.finish(); end(null, decoder.finish()); } catch { end('PROXY_HTTP_REJECTED'); }
    };
    const onClose = () => { void receive.then(complete, () => end('PROXY_TLS_FAILED')); };
    const onMessage = (event) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data instanceof Uint8Array ? event.data : null;
      if (!data) { end('PROXY_WSS_BINARY_REQUIRED'); return; }
      wireBytes += data.length; queuedBytes += data.length;
      if (data.length > 2_097_152 || queuedBytes > maxBytes + 524_288 || wireBytes > maxBytes + 1_048_576 || (!identityVerified && wireBytes > 524_288)) { end('PROXY_WSS_BODY_TOO_LARGE'); return; }
      receive = receive.then(async () => {
        try {
          if (finished) return;
          const bytes = vlessDecoder.push(data);
          if (bytes.length) await tls.handleReceivedBytes(bytes);
        } finally { queuedBytes -= data.length; }
      });
      void receive.catch(() => end('PROXY_TLS_FAILED'));
    };
    activeSignal.addEventListener('abort', onAbort, { once: true });
    websocket.addEventListener('message', onMessage);
    websocket.addEventListener('close', onClose);
    websocket.addEventListener('error', onError);
    try { tls = makeClient({
      host: url.hostname, verifyServerCertificate: true, logger: quietLogger,
      namedCurves: ['SECP256R1', 'SECP384R1'], applicationLayerProtocols: ['http/1.1'],
      cipherSuites: ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256'],
      // Never fetch an untrusted certificate's AIA URL. Full chain must arrive in TLS.
      fetchCertificateBytes: async () => { throw new Error('PROXY_TLS_INCOMPLETE_CHAIN'); },
      write({ header, content }) {
        if (finished) throw new WorkerTransportError('PROXY_CLOSED');
        let bytes = joinBytes(header, content);
        if (!sentHeader) { bytes = joinBytes(vless, bytes); sentHeader = true; }
        websocket.send(bytes);
      },
      onRecvCertificates({ certificates }) {
        chainCheck = verifyChain(certificates, url.hostname);
        void chainCheck.catch(() => end('PROXY_TLS_CERTIFICATE_REJECTED'));
      },
      onHandshake() {
        void (async () => {
          if (!chainCheck) { end('PROXY_TLS_CERTIFICATE_REJECTED'); return; }
          await chainCheck;
          if (finished || activeSignal.aborted) return;
          identityVerified = true;
          await tls.write(http);
        })().catch(() => end('PROXY_TLS_CERTIFICATE_REJECTED'));
      },
      onApplicationData(bytes) {
        if (finished) return;
        if (!identityVerified) { end('PROXY_TLS_CERTIFICATE_REJECTED'); return; }
        try { if (decoder.push(bytes)) complete(); } catch { end('PROXY_HTTP_REJECTED'); }
      },
      onTlsEnd(error) { if (!finished) { if (error) end('PROXY_TLS_FAILED'); else complete(); } },
    }); } catch { end('PROXY_TLS_FAILED'); return; }
    if (activeSignal.aborted) onAbort();
    else void tls.startHandshake().catch(() => end('PROXY_TLS_FAILED'));
  });
  return decodeContent(result, maxBytes);
}
