import { fail } from './errors.js';

const DEFAULT_CONFIG = { enabled: false, subscriptionUrl: '', revision: 0, updatedAt: null };

/** Public clients receive this setting only to start an update operation. */
export function updateProxyConfigView(state) {
  const value = state.updateProxyConfig;
  if (!value) return { ...DEFAULT_CONFIG, subscriptionUrls: [] };
  const subscriptionUrls = subscriptionUrlsValue(Object.hasOwn(value, 'subscriptionUrls') ? value.subscriptionUrls : [value.subscriptionUrl], { enabled: value.enabled });
  return { enabled: value.enabled, subscriptionUrls, subscriptionUrl: subscriptionUrls[0] || '', revision: value.revision, updatedAt: value.updatedAt };
}

export function subscriptionUrlValue(value, { enabled = true } = {}) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value.trim())) fail('INVALID_SUBSCRIPTION_URL', '请输入不超过 4096 字符的公开 HTTPS 订阅地址。');
  const trimmed = value.trim();
  if (!trimmed && !enabled) return '';
  let url;
  try { url = new URL(trimmed); } catch { fail('INVALID_SUBSCRIPTION_URL', '请输入有效的 HTTPS 订阅地址。'); }
  // Accept public DNS names only. This excludes IP literals, alternate integer
  // representations, local machine names and known private network suffixes.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || hostname.length > 253 || !hostname.includes('.') ||
      /^[\d.]+$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[') ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|home\.arpa|invalid)$/.test(hostname) ||
      !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail('INVALID_SUBSCRIPTION_URL', '订阅地址须为公开 HTTPS 域名，不能包含用户名、密码或片段。');
  }
  if (url.href.length > 4096) fail('INVALID_SUBSCRIPTION_URL', '订阅地址规范化后不能超过 4096 字符。');
  return url.href;
}

/** Normalize a bounded pool; legacy callers wrap their single URL field. */
export function subscriptionUrlsValue(value, { enabled = true } = {}) {
  if (!Array.isArray(value)) fail('INVALID_SUBSCRIPTION_URL', '请输入订阅地址列表，每行一个公开 HTTPS 地址。');
  const urls = [];
  for (const entry of value) {
    if (typeof entry !== 'string') fail('INVALID_SUBSCRIPTION_URL', '每个订阅地址都须为公开 HTTPS 地址。');
    const normalized = subscriptionUrlValue(entry, { enabled: false });
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
    if (urls.length > 8) fail('INVALID_SUBSCRIPTION_URL', '最多保存 8 个不同的订阅地址。');
  }
  if (enabled && !urls.length) fail('INVALID_SUBSCRIPTION_URL', '启用更新代理时，请填写至少一个 HTTPS 订阅地址。');
  return urls;
}

export function validateUpdateProxyConfig(value) {
  if (value === null || value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    fail('STORAGE_INVALID', '更新网络配置异常，请联系管理员。', 503);
  }
  try { subscriptionUrlsValue(Object.hasOwn(value, 'subscriptionUrls') ? value.subscriptionUrls : [value.subscriptionUrl], { enabled: value.enabled }); }
  catch { fail('STORAGE_INVALID', '更新网络配置异常，请联系管理员。', 503); }
}

/** Subscription credentials may live in the path as well as the query. */
export function updateProxyAuditView(value) {
  const subscriptionUrls = value.subscriptionUrls.map(url => `${new URL(url).origin}/[REDACTED]`);
  return { ...value, subscriptionUrls, subscriptionUrl: subscriptionUrls[0] || '' };
}

export function updateProxyAuditReason(reason, ...urls) {
  let result = reason;
  for (const url of urls.flat(Infinity).filter(value => typeof value === 'string' && value)) result = result.replaceAll(url, '[REDACTED_SUBSCRIPTION]');
  return result.replace(/https?:\/\/[^\s<>"')]+/gi, '[REDACTED_URL]')
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '[REDACTED]');
}
