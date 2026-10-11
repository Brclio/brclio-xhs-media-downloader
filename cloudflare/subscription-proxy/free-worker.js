import { FreeSubscriptionService, readBounded } from './free-service.js';
import { LIMITS, publicError } from './src/policy.js';
const failure = (code, status) => Response.json({ code }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export class SubscriptionTransport {
  constructor(state) { this.state = state; this.service = new FreeSubscriptionService(); }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/fetch-note', '/fetch-media'].includes(path)) return failure('NOT_FOUND', 404);
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return failure('JSON_REQUIRED', 415);
    try {
      let bytes;
      try { bytes = await readBounded(request, LIMITS.requestBytes); }
      catch { return failure('REQUEST_TOO_LARGE', 413); }
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('INVALID_JSON', 400);
      if (path === '/fetch-note') return Response.json(await this.service.note(body, { signal: request.signal }), {
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      const result = await this.service.media(body, { signal: request.signal });
      return new Response(result.body, { status: result.status, headers: result.headers });
    } catch (error) {
      if (error instanceof SyntaxError) return failure('INVALID_JSON', 400);
      const result = publicError(error); return failure(result.code, result.status);
    }
  }
}

export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !['/fetch-note', '/fetch-media'].includes(path)) return failure('NOT_FOUND', 404);
  return env.SUBSCRIPTION_TRANSPORT.get(env.SUBSCRIPTION_TRANSPORT.idFromName('subscription-transport-v1')).fetch(request);
} };
