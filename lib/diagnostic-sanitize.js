// Shared by the local logger and feedback service. Never log request bodies,
// raw page HTML, cookies, credentials, hardware identifiers or media contents.
export const REDACTED = '[REDACTED]';
const PRIVATE_KEY = /(?:password|passwd|authorization|cookie|secret|token|credential|private.?key|public.?key|stable.?id|machine.?guid|hardware|activation.?code|verification.?code|email.?code|otp|smtp|api.?key|session.?id|device.?proof)/i;
const MAX_STRING = 12000;
export function sanitizeDiagnosticText(input) {
  let value = String(input).slice(0, 64000);
  value = value.replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/g, REDACTED)
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:set-cookie|cookie|authorization)\s*[:=][^\r\n]*/gi, REDACTED)
    .replace(/\b(?:password|passwd|secret|access_token|refresh_token|xsec_token|web_session|a1|token|api_key|activation_code|verification_code)\s*[=:]\s*["']?[^\s,;"']+/gi, REDACTED)
    .replace(/https?:\/\/[^\s<>"')]+/gi, raw => {
      try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`; }
      catch { return '[URL]'; }
    })
    .replace(/\b[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\r\n"'<>]+/gi, '[LOCAL_PATH]')
    .replace(/(?:\/Users\/|\/home\/|\/private\/var\/folders\/|\/var\/folders\/)[^\r\n"'<>]+/g, '[LOCAL_PATH]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID]');
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[TRUNCATED]` : value;
}

export function sanitizeDiagnostic(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeDiagnosticText(value);
  if (depth > 7) return '[DEPTH_LIMIT]';
  if (typeof value !== 'object') return String(value).slice(0, 100);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  let result;
  if (value instanceof Error) {
    result = sanitizeDiagnostic({ name: value.name, code: value.code, message: value.message, stack: value.stack }, depth + 1, seen);
  } else if (Array.isArray(value)) {
    result = value.slice(0, value.length > 250 ? 249 : 250).map(item => sanitizeDiagnostic(item, depth + 1, seen));
    if (value.length > 250) result.push('[TRUNCATED_ITEMS]');
  } else {
    result = {};
    for (const [rawKey, item] of Object.entries(value).slice(0, 100)) {
      const key = sanitizeDiagnosticText(rawKey).slice(0, 100);
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      result[key] = PRIVATE_KEY.test(key) ? REDACTED : sanitizeDiagnostic(item, depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}

/** Reject unsafe upload bytes rather than changing a pre-hashed log snapshot. */
export function containsDiagnosticSecrets(value) {
  return JSON.stringify(value) !== JSON.stringify(sanitizeDiagnostic(value));
}
