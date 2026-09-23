import { fail } from './errors.js';

export function createMailer(env = process.env, fetchImpl = fetch, { createSmtpTransport } = {}) {
  const provider = env.AUTH_MAIL_PROVIDER || 'resend';
  const configured = provider === 'resend' ? Boolean(env.AUTH_MAIL_API_KEY && env.AUTH_MAIL_FROM) : provider === 'webhook' ? Boolean(env.AUTH_MAIL_WEBHOOK_URL && env.AUTH_MAIL_WEBHOOK_SECRET) : provider === 'smtp' ? Boolean(env.AUTH_SMTP_HOST && env.AUTH_SMTP_USER && env.AUTH_SMTP_PASS && env.AUTH_MAIL_FROM) : false;
  async function smtpTransport() {
    const port = Number(env.AUTH_SMTP_PORT || 465);
    if (![465, 587].includes(port)) fail('MAIL_NOT_CONFIGURED', 'SMTP 仅支持安全端口 465 或 587。', 503);
    const createTransport = createSmtpTransport || (await import('nodemailer')).default.createTransport;
    return createTransport({
      host: env.AUTH_SMTP_HOST, port, secure: port === 465, requireTLS: true,
      auth: { user: env.AUTH_SMTP_USER, pass: env.AUTH_SMTP_PASS },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
      logger: false, debug: false,
    });
  }
  return {
    provider, configured,
    async check() {
      if (!configured) return { status: 'not_configured', message: '邮件服务尚未配置。' };
      if (provider !== 'smtp') return { status: 'configured', message: '请参考最近发送状态；已配置不代表邮件已投递。' };
      let transport;
      try {
        transport = await smtpTransport();
        await transport.verify();
        return { status: 'ok', checkedAt: new Date().toISOString(), message: 'SMTP 连接和身份验证成功；实际收件请参考验证码邮件。' };
      } catch { return { status: 'unavailable', checkedAt: new Date().toISOString(), message: 'SMTP 连接或身份验证失败，请检查邮件服务配置。' }; }
      finally { transport?.close(); }
    },
    async send({ email, code, expiresInMinutes, deliveryId }) {
      if (!configured) fail('MAIL_NOT_CONFIGURED', '邮件服务尚未配置，请联系管理员。', 503);
      const subject = '小红书下载器登录验证码';
      const text = [
        `您的登录验证码为 ${code}，${expiresInMinutes} 分钟内有效，仅能使用一次。首次验证将创建账号。如果不是您本人操作，请忽略此邮件。`,
        '本人长期招收编程私教学员，欢迎零基础入门或希望系统提升编程能力的朋友咨询。微信：Jiabcdefh。',
        '新书推荐：《编程启蒙：思维与代码》。一起从思维训练开始，迈出写代码的第一步。',
        'Tips：如果此邮件出现在垃圾邮件文件夹，请点一下“这不是垃圾邮件”，以免影响下次接收验证码。\nIf this message is in your spam folder, please mark it as “Not spam” to help ensure you receive future verification codes.',
      ].join('\n\n');
      if (provider === 'smtp') {
        const transport = await smtpTransport();
        try {
          const sent = await transport.sendMail({ from: env.AUTH_MAIL_FROM, to: { address: email }, subject, text, headers: { 'X-Account-Delivery-ID': deliveryId } });
          if (!sent.accepted?.length || sent.rejected?.length) fail('MAIL_SEND_FAILED', '验证码邮件未被邮件服务接受，请稍后重试。', 503);
        } catch { fail('MAIL_SEND_FAILED', '验证码邮件发送未确认，请稍后重新获取。', 503); }
        finally { transport.close(); }
        return;
      }
      let url, headers, body;
      if (provider === 'resend') {
        url = 'https://api.resend.com/emails';
        headers = { Authorization: `Bearer ${env.AUTH_MAIL_API_KEY}`, 'Idempotency-Key': deliveryId };
        body = { from: env.AUTH_MAIL_FROM, to: [email], subject, text };
      } else {
        url = env.AUTH_MAIL_WEBHOOK_URL;
        if (!url.startsWith('https://')) fail('MAIL_NOT_CONFIGURED', '邮件服务地址必须使用 HTTPS。', 503);
        headers = { Authorization: `Bearer ${env.AUTH_MAIL_WEBHOOK_SECRET}`, 'Idempotency-Key': deliveryId };
        body = { email, code, expiresInMinutes, deliveryId, template: 'account-login', subject, text };
      }
      let response;
      // Refuse redirects without forwarding the provider credential. Unlike
      // redirect:error, manual is supported by both Node.js and Workers fetch.
      try { response = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
      catch { fail('MAIL_SEND_FAILED', '验证码邮件发送未确认，请稍后重新获取。', 503); }
      if (!response.ok) fail('MAIL_SEND_FAILED', '验证码邮件发送失败，请稍后重新获取。', 503);
    },
  };
}
