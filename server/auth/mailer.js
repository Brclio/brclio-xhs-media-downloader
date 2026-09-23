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
  async function deliver({ email, deliveryId, template, subject, text, fields, label }) {
    if (!configured) fail('MAIL_NOT_CONFIGURED', '邮件服务尚未配置，请联系管理员。', 503);
    if (provider === 'smtp') {
      let transport;
      try {
        transport = await smtpTransport();
        const sent = await transport.sendMail({ from: env.AUTH_MAIL_FROM, to: { address: email }, subject, text, headers: { 'X-Account-Delivery-ID': deliveryId } });
        if (!sent.accepted?.length || sent.rejected?.length) fail('MAIL_SEND_FAILED', `${label}邮件未被邮件服务接受，请稍后重试。`, 503);
      } catch { fail('MAIL_SEND_FAILED', `${label}邮件发送未确认，请稍后重试。`, 503); }
      finally { transport?.close(); }
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
      body = { email, ...fields, deliveryId, template, subject, text };
    }
    let response;
    // Refuse redirects without forwarding the provider credential. Unlike
    // redirect:error, manual is supported by both Node.js and Workers fetch.
    try { response = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { fail('MAIL_SEND_FAILED', `${label}邮件发送未确认，请稍后重试。`, 503); }
    if (!response.ok) fail('MAIL_SEND_FAILED', `${label}邮件发送失败，请稍后重试。`, 503);
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
      const subject = '小红书下载器登录验证码';
      const text = [
        `您的登录验证码为 ${code}，${expiresInMinutes} 分钟内有效，仅能使用一次。首次验证将创建账号。如果不是您本人操作，请忽略此邮件。`,
        '本人长期招收编程私教学员，欢迎零基础入门或希望系统提升编程能力的朋友咨询。微信：Jiabcdefh。',
        '新书推荐：《编程启蒙：思维与代码》。一起从思维训练开始，迈出写代码的第一步。',
        'Tips：如果此邮件出现在垃圾邮件文件夹，请点一下“这不是垃圾邮件”，以免影响下次接收验证码。\nIf this message is in your spam folder, please mark it as “Not spam” to help ensure you receive future verification codes.',
      ].join('\n\n');
      return deliver({ email, deliveryId, template: 'account-login', subject, text, fields: { code, expiresInMinutes }, label: '验证码' });
    },
    async sendActivation({ email, code, plan, redeemBy, deliveryId }) {
      const subject = 'Brclio 小红书下载器会员激活码';
      const deadline = redeemBy ? `请在 ${new Date(redeemBy).toISOString()}（UTC）前兑换。` : '本激活码不设兑换截止时间。';
      const text = [
        '感谢您开通 Brclio 小红书下载器会员。',
        `收件账号：${email}\n套餐：${plan.name} · ${plan.priceCents / 100} 元\n会员时长：${plan.days} 天\n激活码：${code}`,
        `使用方法：打开 Brclio 小红书下载器，登录 ${email}，在“账号与会员”中粘贴激活码并兑换。此激活码仅限该邮箱账号兑换一次。`,
        `会员有效期从成功兑换时开始计算；已有未到期的限时会员会顺延 ${plan.days} 天。${deadline}激活码不增加设备名额。`,
        '付款请务必备注您的账号邮箱，激活码会发送至该邮箱。',
        '如未看到邮件，请检查垃圾邮件文件夹并将此邮件标记为“这不是垃圾邮件”。重复收到同一激活码邮件不会重复扣费或重复增加会员时长。',
      ].join('\n\n');
      return deliver({ email, deliveryId, template: 'membership-activation', subject, text, fields: { code, plan, redeemBy }, label: '激活码' });
    },
  };
}
