import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fail } from './errors.js';
import { subscriptionUrlValue } from './update-proxy.js';

const DEFAULT_CONFIG = { enabled: false, subscriptionUrl: '', revision: 0, updatedAt: null };
const storageFailure = () => fail('STORAGE_INVALID', '网页抓取网络配置异常，请联系管理员。', 503);

/** This setting is for server-side note fetching, never software updates. */
export function webParseSubscriptionUrlValue(value, { enabled = true } = {}) {
  const normalized = subscriptionUrlValue(value, { enabled });
  if (normalized && new URL(normalized).port) fail('INVALID_SUBSCRIPTION_URL', '网页抓取订阅仅支持 HTTPS 默认端口 443。');
  return normalized;
}

function encryptionKey(config) {
  if (typeof config?.pepper !== 'string' || Buffer.byteLength(config.pepper) < 32) fail('SERVICE_NOT_CONFIGURED', '网页抓取配置保护尚未配置。', 503);
  return createHash('sha256').update('brclio-web-parse-subscription-v1\0').update(config.pepper).digest();
}

export function encryptWebParseSubscription(subscriptionUrl, config) {
  if (!subscriptionUrl) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(config), iv);
  cipher.setAAD(Buffer.from('brclio-web-parse-subscription-v1'));
  const content = Buffer.concat([cipher.update(subscriptionUrl, 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), content: content.toString('base64') };
}

function decryptSubscription(value, config) {
  if (!value) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(config), Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from('brclio-web-parse-subscription-v1'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return webParseSubscriptionUrlValue(Buffer.concat([decipher.update(Buffer.from(value.content, 'base64')), decipher.final()]).toString('utf8'));
  } catch { storageFailure(); }
}

export function validateWebParseProxyConfig(value) {
  if (value === null || value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
      Object.hasOwn(value, 'subscriptionUrl')) storageFailure();
  const encrypted = value.subscriptionCiphertext;
  if (encrypted === null && !value.enabled) return;
  if (!encrypted || typeof encrypted !== 'object' || Array.isArray(encrypted) || encrypted.version !== 1 ||
      typeof encrypted.iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(encrypted.iv) ||
      typeof encrypted.tag !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(encrypted.tag) ||
      typeof encrypted.content !== 'string' || encrypted.content.length < 4 || encrypted.content.length > 5500 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encrypted.content)) storageFailure();
}

/** Raw credentials are restricted to the private namespace binding. */
export function webParseProxyPrivateConfig(state, config = {}) {
  const value = state.webParseProxyConfig;
  if (!value) {
    const subscriptionUrl = webParseSubscriptionUrlValue(config.webParseProxySubscriptionUrl || '', { enabled: false });
    return { ...DEFAULT_CONFIG, enabled: Boolean(subscriptionUrl), subscriptionUrl };
  }
  validateWebParseProxyConfig(value);
  return { enabled: value.enabled, subscriptionUrl: decryptSubscription(value.subscriptionCiphertext, config), revision: value.revision, updatedAt: value.updatedAt };
}

/** Administrator reads never return the subscription path or query credentials. */
export function webParseProxyAdminView(value) {
  const configured = Boolean(value.subscriptionUrl);
  const subscriptionHost = configured ? new URL(value.subscriptionUrl).hostname : '';
  return { enabled: value.enabled, configured, subscriptionHost, maskedSubscriptionUrl: configured ? `https://${subscriptionHost}/[REDACTED]` : '', revision: value.revision, updatedAt: value.updatedAt };
}
