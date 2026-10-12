import { createHash, createPublicKey, verify } from 'node:crypto';
import { fail } from './errors.js';
import { equalDigest } from './crypto.js';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const defaultFetch = (...args) => fetch(...args);
const keyCaches = new WeakMap();
const unavailable = () => fail('GOOGLE_UNAVAILABLE', 'Google 登录暂时不可用，请稍后重试。', 503);
const invalidToken = () => fail('GOOGLE_IDENTITY_INVALID', 'Google 身份校验失败，请重新登录。', 401);

async function readJson(response, maximum) {
  if (!response.ok) unavailable();
  const text = await response.text();
  if (Buffer.byteLength(text) > maximum) unavailable();
  try { return JSON.parse(text); } catch { unavailable(); }
}

export function createGoogleOAuth({ config, fetchImpl = defaultFetch, now = Date.now }) {
  const clientId = config.googleClientId || '', clientSecret = config.googleClientSecret || '';
  let redirectUri = '';
  if (clientId && clientSecret) {
    try {
      const origin = new URL(config.siteOrigin);
      if (origin.protocol !== 'https:' || origin.origin !== config.siteOrigin) throw Error();
      redirectUri = `${origin.origin}/?google_callback=1`;
      if (config.googleRedirectUri && config.googleRedirectUri !== redirectUri) throw Error();
      if (!/^[A-Za-z0-9._-]{10,250}\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret.length < 10 || clientSecret.length > 512) throw Error();
    } catch { redirectUri = ''; }
  }
  const enabled = Boolean(redirectUri);
  const requireEnabled = () => { if (!enabled) fail('GOOGLE_NOT_CONFIGURED', 'Google 登录尚未启用，请使用邮箱验证码登录。', 503); };

  async function request(url, options) {
    try { return await fetchImpl(url, { ...options, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15_000) }); }
    catch { unavailable(); }
  }
  async function signingKey(kid) {
    let cache = keyCaches.get(fetchImpl);
    if (!cache || cache.expiresAt <= now() || !cache.keys.some(key => key.kid === kid)) {
      const response = await request(JWKS_ENDPOINT, { headers: { Accept: 'application/json' } });
      const body = await readJson(response, 65_536);
      if (!Array.isArray(body.keys) || body.keys.length > 20) unavailable();
      const maxAge = Math.min(Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 300), 86_400);
      cache = { keys: body.keys, expiresAt: now() + maxAge * 1000 };
      keyCaches.set(fetchImpl, cache);
    }
    const jwk = cache.keys.find(key => key.kid === kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (!jwk) invalidToken();
    try { return createPublicKey({ key: jwk, format: 'jwk' }); } catch { invalidToken(); }
  }
  async function verifyIdToken(token, nonce) {
    if (typeof token !== 'string' || token.length > 16_384) invalidToken();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) invalidToken();
    let header, payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { invalidToken(); }
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(header.kid) || header.crit !== undefined) invalidToken();
    const key = await signingKey(header.kid);
    let verified = false;
    try { verified = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')); } catch { /* reject invalid signatures */ }
    if (!verified || !payload || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) invalidToken();
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audience.includes(clientId) || (audience.length > 1 && payload.azp !== clientId) || (payload.azp !== undefined && payload.azp !== clientId)) invalidToken();
    const seconds = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= seconds || !Number.isSafeInteger(payload.iat) || payload.iat > seconds + 60 || payload.iat < seconds - 7200) invalidToken();
    if (typeof payload.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(payload.nonce) || !equalDigest(payload.nonce, nonce) || typeof payload.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(payload.sub) || payload.email_verified !== true || typeof payload.email !== 'string') invalidToken();
    const email = payload.email.trim().toLowerCase();
    const domain = email.split('@')[1];
    // Google explicitly warns that email_verified alone cannot establish current
    // ownership of a third-party mailbox. Only Gmail or a verified Workspace hd
    // claim can link an existing mailbox account or create an email-login account.
    const authoritativeEmail = ['gmail.com', 'googlemail.com'].includes(domain) || (typeof payload.hd === 'string' && Boolean(payload.hd.trim()));
    return { subject: payload.sub, email, authoritativeEmail };
  }
  return {
    enabled, redirectUri,
    authorizationUrl({ state, nonce, codeVerifier }) {
      requireEnabled();
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce,
        code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account', access_type: 'online' });
      return url.href;
    },
    async exchange({ code, codeVerifier, nonce }) {
      requireEnabled();
      const response = await request(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code, code_verifier: codeVerifier }).toString() });
      if (response.status === 400 || response.status === 401) fail('GOOGLE_CODE_INVALID', 'Google 登录已失效，请重新发起登录。', 401);
      const result = await readJson(response, 32_768);
      return verifyIdToken(result.id_token, nonce);
    },
  };
}
