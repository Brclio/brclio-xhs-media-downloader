import { fail } from './errors.js';
import { PROTECTED_FEATURES } from '../../lib/membership-policy.js';

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
  };
  if (Buffer.byteLength(config.pepper) < 32) fail('SERVICE_NOT_CONFIGURED', '授权服务尚未配置。', 503);
  if (!Number.isInteger(config.deviceLimit) || config.deviceLimit < 1 || config.deviceLimit > 20) fail('SERVICE_NOT_CONFIGURED', '设备上限配置错误。', 503);
  for (const value of [config.otpEmailHourlyLimit, config.otpIpHourlyLimit, config.otpGlobalHourlyLimit]) {
    if (!Number.isInteger(value) || value < 1 || value > 10_000) fail('SERVICE_NOT_CONFIGURED', '验证码发送限制配置错误。', 503);
  }
  return config;
}
