import { fail } from './errors.js';
import { PROTECTED_FEATURES } from '../../lib/membership-policy.js';
import { createPrivateKey } from 'node:crypto';

export function readConfig(env = process.env) {
  const config = {
    pepper: env.AUTH_SECRET_PEPPER || '',
    adminEmails: (env.AUTH_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    deviceLimit: Number(env.AUTH_DEVICE_LIMIT || 1),
    protectedFeatures: [...PROTECTED_FEATURES],
    otpTtlMs: 300_000, otpIntervalMs: 60_000, otpMaxAttempts: 5,
    otpEmailHourlyLimit: Number(env.AUTH_EMAIL_HOURLY_LIMIT || 6),
    otpIpHourlyLimit: Number(env.AUTH_IP_HOURLY_LIMIT || 20),
    otpGlobalHourlyLimit: Number(env.AUTH_GLOBAL_HOURLY_LIMIT || 200),
    deviceCheckWriteMs: 86_400_000,
    siteOrigin: env.AUTH_SITE_ORIGIN || '',
    avatarOrigin: env.AUTH_AVATAR_ORIGIN || env.AUTH_SITE_ORIGIN || '',
    googleClientId: env.AUTH_GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.AUTH_GOOGLE_CLIENT_SECRET || '',
    googleRedirectUri: env.AUTH_GOOGLE_REDIRECT_URI || '',
    webParseProxySubscriptionUrl: env.WEB_PARSE_PROXY_SUBSCRIPTION_URL || '',
    entitlementPrivateKey: null,
    entitlementKeyId: env.AUTH_ENTITLEMENT_KEY_ID || 'v1',
    // Server-only credentials. Payment validates these lazily so existing login,
    // manual receipts and activation codes still work before rollout.
    brclioPay: {
      baseUrl: env.BRCLIO_PAY_BASE_URL || 'https://pay.bornforthis.cn',
      clientId: env.BRCLIO_PAY_CLIENT_ID || 'xhs-downloader',
      apiSecret: env.BRCLIO_PAY_API_SECRET || '',
      webhookSecret: env.BRCLIO_PAY_WEBHOOK_SECRET || '',
      mode: env.BRCLIO_PAY_MODE || 'live',
      returnOrigin: env.AUTH_SITE_ORIGIN || '',
    },
  };
  if (Buffer.byteLength(config.pepper) < 32) fail('SERVICE_NOT_CONFIGURED', '授权服务尚未配置。', 503);
  if (!Number.isInteger(config.deviceLimit) || config.deviceLimit < 1 || config.deviceLimit > 20) fail('SERVICE_NOT_CONFIGURED', '设备上限配置错误。', 503);
  for (const value of [config.otpEmailHourlyLimit, config.otpIpHourlyLimit, config.otpGlobalHourlyLimit]) {
    if (!Number.isInteger(value) || value < 1 || value > 10_000) fail('SERVICE_NOT_CONFIGURED', '验证码发送限制配置错误。', 503);
  }
  if (typeof config.entitlementKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.entitlementKeyId)) fail('SERVICE_NOT_CONFIGURED', '授权签名标识配置错误。', 503);
  if (env.AUTH_ENTITLEMENT_PRIVATE_KEY) {
    try {
      config.entitlementPrivateKey = createPrivateKey(env.AUTH_ENTITLEMENT_PRIVATE_KEY.replaceAll('\\n', '\n'));
      if (config.entitlementPrivateKey.asymmetricKeyType !== 'ed25519') throw new Error('unsupported key');
    } catch { fail('SERVICE_NOT_CONFIGURED', '授权签名配置错误。', 503); }
  }
  return config;
}
