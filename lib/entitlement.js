import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { PROTECTED_FEATURES } from './membership-policy.js';

export const ENTITLEMENT_MAX_AGE_MS = 86_400_000;
export const ENTITLEMENT_SYNC_INTERVAL_MS = 300_000;
const ISSUER = 'brclio-xhs-account';
const AUDIENCE = 'brclio-xhs-desktop';
const CLAIM_KEYS = ['version', 'issuer', 'audience', 'userId', 'deviceId', 'deviceKeyHash', 'sessionHash', 'requestNonce', 'features', 'issuedAt', 'expiresAt', 'membershipExpiresAt'];
const hash = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const validNonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
const validTime = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code = 'ENTITLEMENT_INVALID') {
  const error = new Error(code === 'ENTITLEMENT_EXPIRED' ? '本地授权已到期，请连接网络刷新账号授权。' : '本地授权校验失败，请连接网络刷新账号授权。');
  error.code = code;
  throw error;
}

function publicKeyValue(value) {
  const key = value?.type === 'public' ? value : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') fail();
  return key;
}

function deviceKeyHash(publicKey) {
  return hash(publicKeyValue(publicKey).export({ format: 'der', type: 'spki' }));
}

function decode(value, maxLength) {
  if (typeof value !== 'string' || !value || value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail();
  return bytes;
}

/** A grant is signed only after the server has read current account state. */
export function issueEntitlement({ privateKey, keyId = 'v1', token, publicKey, userId, deviceId, requestNonce, feature, membershipExpiresAt = null, now = Date.now() }) {
  try {
    const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519' || typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) ||
        !validId(userId) || !validId(deviceId) || !validNonce(requestNonce) || typeof token !== 'string' || token.length < 32 || token.length > 200 ||
        !PROTECTED_FEATURES.includes(feature) || !validTime(now) || !Number.isSafeInteger(now + ENTITLEMENT_MAX_AGE_MS) ||
        (membershipExpiresAt !== null && (!validTime(membershipExpiresAt) || membershipExpiresAt <= now))) fail();
    const claims = { version: 1, issuer: ISSUER, audience: AUDIENCE, userId, deviceId,
      deviceKeyHash: deviceKeyHash(publicKey), sessionHash: hash(token), requestNonce, features: [feature],
      issuedAt: now, expiresAt: Math.min(now + ENTITLEMENT_MAX_AGE_MS, membershipExpiresAt ?? Infinity), membershipExpiresAt };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return { keyId, payload, signature: sign(null, Buffer.from(`${keyId}.${payload}`), key).toString('base64url') };
  } catch { fail(); }
}

/** Verify against packaged public keys; no key from the grant is trusted. */
export function verifyEntitlement(entitlement, { publicKeys, now = Date.now(), token, publicKey, feature, userId, requestNonce } = {}) {
  let claims;
  try {
    if (!record(entitlement) || Object.keys(entitlement).length !== 3 ||
        !Object.hasOwn(entitlement, 'keyId') || !Object.hasOwn(entitlement, 'payload') || !Object.hasOwn(entitlement, 'signature') ||
        typeof entitlement.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entitlement.keyId)) fail();
    const pinned = publicKeys instanceof Map ? publicKeys.get(entitlement.keyId)
      : record(publicKeys) && Object.hasOwn(publicKeys, entitlement.keyId) ? publicKeys[entitlement.keyId] : null;
    if (!pinned) fail();
    const payload = decode(entitlement.payload, 8192), signature = decode(entitlement.signature, 100);
    if (signature.length !== 64 || !verify(null, Buffer.from(`${entitlement.keyId}.${entitlement.payload}`), publicKeyValue(pinned), signature)) fail();
    claims = JSON.parse(payload.toString('utf8'));
    if (!record(claims) || Object.keys(claims).length !== CLAIM_KEYS.length || !CLAIM_KEYS.every(name => Object.hasOwn(claims, name)) ||
        claims.version !== 1 || claims.issuer !== ISSUER || claims.audience !== AUDIENCE ||
        !validId(claims.userId) || !validId(claims.deviceId) || (userId !== undefined && claims.userId !== userId) ||
        !validNonce(claims.requestNonce) || (requestNonce !== undefined && claims.requestNonce !== requestNonce) ||
        !Array.isArray(claims.features) || claims.features.length !== 1 || !PROTECTED_FEATURES.includes(claims.features[0]) || claims.features[0] !== feature ||
        !/^[a-f0-9]{64}$/.test(claims.deviceKeyHash) || !/^[a-f0-9]{64}$/.test(claims.sessionHash) ||
        typeof token !== 'string' || token.length < 32 || token.length > 200 || claims.sessionHash !== hash(token) || claims.deviceKeyHash !== deviceKeyHash(publicKey) ||
        !validTime(now) || !validTime(claims.issuedAt) || !validTime(claims.expiresAt) || claims.issuedAt > now ||
        claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > ENTITLEMENT_MAX_AGE_MS ||
        (claims.membershipExpiresAt !== null && (!validTime(claims.membershipExpiresAt) || claims.expiresAt > claims.membershipExpiresAt))) fail();
  } catch { fail(); }
  if (claims.expiresAt <= now || (claims.membershipExpiresAt !== null && claims.membershipExpiresAt <= now)) fail('ENTITLEMENT_EXPIRED');
  return claims;
}
