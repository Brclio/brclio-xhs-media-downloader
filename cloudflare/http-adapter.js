// Small Fetch-to-handler boundary shared with the existing Vercel API handlers.
// Keep raw JSON bodies intact so each handler retains its original validation.
export const MAX_API_BODY_BYTES = 16_384;
export const MAX_ACCOUNT_BODY_BYTES = 1_600_000;

export class RequestTooLargeError extends Error {
  constructor() {
    super('请求内容过大。');
    this.name = 'RequestTooLargeError';
  }
}

export async function readBoundedBody(request, maxBytes = MAX_API_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await request.body?.cancel().catch(() => {});
    throw new RequestTooLargeError();
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function queryValues(url) {
  const values = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (values[key] === undefined) values[key] = value;
    else if (Array.isArray(values[key])) values[key].push(value);
    else values[key] = [values[key], value];
  }
  return values;
}

export async function invokeHandler(handler, request, { maxBodyBytes = MAX_API_BODY_BYTES } = {}) {
  const url = new URL(request.url);
  const req = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    query: queryValues(url),
    body: await readBoundedBody(request, maxBodyBytes),
  };
  const headers = new Headers();
  let status = 200;
  let body = null;
  const res = {
    setHeader(name, value) {
      headers.delete(name);
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
      return this;
    },
    getHeader(name) { return headers.get(name); },
    status(value) { status = value; return this; },
    json(value) {
      headers.set('Content-Type', 'application/json; charset=utf-8');
      body = JSON.stringify(value);
      return this;
    },
    send(value) { body = value; return this; },
    end(value) { body = value ?? null; return this; },
  };
  await handler(req, res);
  return new Response(request.method === 'HEAD' || [204, 205, 304].includes(status) ? null : body, { status, headers });
}
