import { createHmac, createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { fail } from './errors.js';

export const digest = (pepper, purpose, value) => createHmac('sha256', pepper).update(`${purpose}\0${value}`).digest('hex');
export const fingerprint = value => createHash('sha256').update(value).digest('hex');
export function equalDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function normalizeDevice(device) {
  if (!device || typeof device.publicKey !== 'string' || device.publicKey.length > 2048 || !/^[a-f0-9]{64}$/i.test(device.stableIdHash || '')) fail('INVALID_DEVICE', '设备标识无效。');
  let key;
  try { key = createPublicKey(device.publicKey); } catch { fail('INVALID_DEVICE', '设备公钥无效。'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('INVALID_DEVICE', '设备密钥必须使用 Ed25519。');
  const publicKey = key.export({ format: 'pem', type: 'spki' }).toString();
  const platform = String(device.platform || '');
  if (!['darwin', 'win32', 'mac', 'windows'].includes(platform)) fail('INVALID_DEVICE', '仅支持 Mac 和 Windows 设备。');
  return { publicKey, keyFingerprint: fingerprint(publicKey), stableIdHash: device.stableIdHash.toLowerCase(), name: String(device.name || '未命名设备').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100), platform };
}
export function verifyProof({ action, input, token = '', proof, publicKey, now }) {
  const timestamp = Number(proof?.timestamp);
  if (!Number.isSafeInteger(timestamp) || !/^[a-zA-Z0-9_-]{16,100}$/.test(proof?.nonce || '')) fail('INVALID_DEVICE_PROOF', '设备校验失败，请刷新后重试。', 401);
  if (Math.abs(now - timestamp) > 120_000) fail('PROOF_EXPIRED', '设备校验时间已过期，请同步服务器时间后重试。', 401);
  if (typeof proof.signature !== 'string' || proof.signature.length > 200) fail('INVALID_DEVICE_PROOF', '设备签名无效。', 401);
  const message = `${action}\n${proof.timestamp}\n${proof.nonce}\n${JSON.stringify(input)}\n${token}`;
  let valid = false;
  try { valid = verify(null, Buffer.from(message), publicKey, Buffer.from(proof.signature, 'base64')); } catch { /* invalid key or signature */ }
  if (!valid) fail('INVALID_DEVICE_PROOF', '设备签名无效。', 401);
}
