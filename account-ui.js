// Desktop-only account extension. Brand components inherit the existing Brclio app template.
import { MEMBERSHIP_PLANS, getMembershipPlan } from './lib/membership-plans.js';

const PAYMENT_METHODS = Object.freeze({
  wechat: { name: '微信支付', image: './assets/membership/wechat-pay.png' },
  alipay: { name: '支付宝', image: './assets/membership/alipay.png' },
});

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' }) : '—';
}
export function membershipLabel(account) {
  const membership = account?.membership;
  if (!membership || membership.type === 'none') return '普通用户 · 未开通会员';
  if (membership.type === 'permanent') return '永久会员';
  if (membership.active) return '有效期会员';
  const serverNow = Date.parse(account.serverTime);
  if (Number.isFinite(serverNow) && Date.parse(membership.startsAt) > serverNow) return '会员尚未生效';
  return '会员已到期';
}

export async function initializeAccountUI() {
  const bridge = window.xhsDesktop;
  if (!bridge?.getAccountState || document.getElementById('software-account')) return;
  const panel = document.createElement('section');
  panel.id = 'software-account';
  panel.className = 'software-account';
  panel.setAttribute('aria-labelledby', 'account-title');
  panel.innerHTML = `
    <div class="account-heading">
      <div><span class="account-eyebrow">SOFTWARE ACCOUNT</span><h2 id="account-title">软件账号与会员</h2></div>
      <div class="account-tools"><span id="account-badge" class="account-badge">读取登录状态…</span><button id="account-open-membership" class="button button-primary" type="button" aria-haspopup="dialog">开通会员</button><button id="account-refresh" class="button button-secondary" type="button">刷新权益</button></div>
    </div>
    <p class="account-intro">软件账号用于会员与设备授权；小红书账号用于读取笔记，两者分别登录。首次验证邮箱会自动创建软件账号。</p>
    <p id="account-notice" class="account-notice" role="status" aria-live="polite"></p>
    <form id="account-login-form" class="account-login-form">
      <label>邮箱地址<input id="account-email" type="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="you@example.com" required></label>
      <label>邮箱验证码<span class="account-code-row"><input id="account-otp" type="text" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6 位验证码" required><button id="account-send-code" class="button button-secondary" type="button">发送验证码</button></span></label>
      <button id="account-login" class="button button-primary" type="submit">验证并登录 / 注册</button>
      <p class="account-form-note">验证码 5 分钟有效且仅可成功使用一次。登录状态保存在本机系统安全存储中，退出应用不会退出账号。</p>
    </form>
    <div id="account-details" class="account-details" hidden>
      <dl class="account-facts"><div><dt>当前软件账号</dt><dd id="account-identity"></dd></div><div><dt>会员权益</dt><dd id="account-membership"></dd><dd id="account-expiry" class="account-secondary"></dd></div><div><dt>当前设备</dt><dd id="account-device"></dd></div></dl>
      <form id="account-redeem-form" class="account-redeem-form"><label>会员激活码<input id="account-activation" autocomplete="off" spellcheck="false" maxlength="256" placeholder="输入邮件中收到的激活码" required></label><button id="account-redeem" class="button button-primary" type="submit">兑换会员</button><button id="account-logout" class="button button-secondary" type="button">退出软件账号</button></form>
      <p class="account-form-note">退出账号不会释放设备名额。更换设备请联系管理员；兑换会员不会绕过设备限制。</p>
    </div>
    <p class="account-scope">单篇下载免费；主页批量下载需要有效会员与已授权设备。会员状态变化不会删除已有文件或任务记录。</p>
    <dialog id="membership-dialog" class="membership-dialog" aria-labelledby="membership-title" aria-describedby="membership-description">
      <div class="membership-dialog-heading">
        <div><span class="account-eyebrow">BRCLIO MEMBERSHIP</span><h2 id="membership-title">开通会员</h2></div>
        <button id="membership-close" class="membership-close" type="button" aria-label="关闭开通会员窗口" autofocus>×</button>
      </div>
      <p id="membership-description" class="membership-description">解锁主页批量下载。选择套餐、扫码付款，收到邮件后兑换激活码。</p>
      <fieldset class="membership-plans"><legend>选择会员套餐</legend><div class="membership-plan-options">${MEMBERSHIP_PLANS.map(plan => `
        <label class="membership-plan"><input type="radio" name="membership-plan" value="${plan.id}" ${plan.id === 'monthly' ? 'checked' : ''}><span class="membership-plan-name">${plan.name}</span><span class="membership-plan-price"><span>¥</span>${plan.priceLabel}</span><span class="membership-plan-duration">${plan.days} 天会员</span><span class="membership-plan-selected" aria-hidden="true">已选择</span></label>`).join('')}
      </div><p class="membership-small">按次购买，不自动续费。兑换后生效；已有有效期会员可顺延。</p></fieldset>
      <section class="membership-payment-note" aria-labelledby="membership-note-title">
        <h3 id="membership-note-title">付款务必备注软件账号邮箱</h3>
        <p>核实收款后，激活码会发送至该邮箱。请勿只填写小红书昵称。</p>
        <div id="membership-email-row" class="membership-email-row" hidden><span id="membership-email" class="membership-email"></span><button id="membership-copy-email" class="button button-secondary" type="button">复制邮箱</button></div>
        <p id="membership-email-status" class="membership-email-status" role="status" aria-live="polite"></p>
      </section>
      <div id="membership-login-guidance" class="membership-login-guidance"><p id="membership-login-message">请先登录软件账号，确认收件邮箱后再付款。</p><button id="membership-go-login" class="button button-primary" type="button">前往登录 / 注册</button></div>
      <section id="membership-payment" class="membership-payment" aria-label="扫码付款" hidden>
        <div class="membership-payment-instructions">
          <fieldset class="membership-methods"><legend>选择付款方式</legend><div class="membership-method-options"><label><input type="radio" name="membership-method" value="wechat" checked><span>微信支付</span></label><label><input type="radio" name="membership-method" value="alipay"><span>支付宝</span></label></div></fieldset>
          <p class="membership-amount">付款金额 <strong id="membership-amount">¥9.9</strong><span id="membership-purchase-summary">月付 · 30 天</span></p>
          <p id="membership-payment-help" class="membership-small">请用微信扫描右侧二维码，手动输入对应金额，并在付款备注中填写上方邮箱。</p>
          <p class="membership-small">付款后等待人工核实，再查看收件箱与垃圾邮件。付款本身不会直接激活会员。</p>
        </div>
        <figure class="membership-payment-qr"><img id="membership-payment-image" src="./assets/membership/wechat-pay.png" alt="微信支付收款二维码" width="240" height="240"><figcaption id="membership-payment-caption">微信支付 · 收款码</figcaption></figure>
      </section>
      <details class="membership-contact"><summary>忘记备注邮箱，或需要付款帮助？</summary><div class="membership-contact-content"><p>用微信扫描此码联系客服，提供付款记录和软件账号邮箱，方便核实。<strong>这是客服好友码，不是收款码。</strong></p><img src="./assets/membership/wechat-contact.png" alt="微信客服好友二维码（非收款码）" width="176" height="176"></div></details>
      <div class="membership-dialog-footer"><p>收到邮件后，把激活码粘贴到「账号与会员」中兑换。</p><button id="membership-go-redeem" class="button button-primary" type="button">我已收到激活码，前往兑换</button></div>
    </dialog>`;
  const mount = document.getElementById('desktop-account-mount');
  const navigation = document.getElementById('desktop-navigation');
  if (mount) mount.replaceChildren(panel);
  else if (navigation) navigation.insertAdjacentElement('afterend', panel);
  else (document.querySelector('main') || document.body).prepend(panel);
  const element = id => document.getElementById(id);
  let busy = false, state = null, cooldownUntil = 0, cooldownTimer = null;
  const dialog = element('membership-dialog');
  let copiedEmail = '';
  const selectedPlan = () => getMembershipPlan(panel.querySelector('input[name="membership-plan"]:checked')?.value) || MEMBERSHIP_PLANS[1];
  const renderPurchase = () => {
    const email = state?.authenticated ? state.account?.user?.email || '' : '';
    const permanent = Boolean(state?.authenticated && state?.verified && state.account?.membership?.type === 'permanent');
    const ready = Boolean(email && state?.verified && state?.configured && !permanent);
    const plan = selectedPlan();
    const method = PAYMENT_METHODS[panel.querySelector('input[name="membership-method"]:checked')?.value] || PAYMENT_METHODS.wechat;
    element('membership-email-row').hidden = !email;
    element('membership-email').textContent = email;
    if (copiedEmail !== email) { copiedEmail = ''; element('membership-email-status').textContent = ''; }
    element('membership-copy-email').disabled = !email;
    element('membership-payment').hidden = !ready;
    element('membership-login-guidance').hidden = ready;
    element('membership-login-message').textContent = permanent ? '当前账号已拥有永久会员，无需购买这些套餐。'
      : state?.authenticated
      ? '暂时无法核实当前软件账号，请返回账号页刷新权益，确认邮箱后再付款。'
      : '请先登录软件账号，确认收件邮箱后再付款。首次验证邮箱会自动注册。';
    element('membership-go-login').textContent = permanent ? '返回账号与会员' : state?.authenticated ? '返回账号页刷新权益' : '前往登录 / 注册';
    element('membership-amount').textContent = `¥${plan.priceLabel}`;
    element('membership-purchase-summary').textContent = `${plan.name} · ${plan.days} 天`;
    const image = element('membership-payment-image');
    if (image.getAttribute('src') !== method.image) image.setAttribute('src', method.image);
    image.alt = `${method.name}收款二维码`;
    element('membership-payment-caption').textContent = `${method.name} · 收款码`;
    element('membership-payment-help').textContent = `请用${method.name === '微信支付' ? '微信' : '支付宝'}扫描二维码，手动输入 ${plan.priceLabel} 元，并在付款备注中填写上方邮箱。`;
    element('membership-go-redeem').hidden = permanent;
    element('membership-go-redeem').textContent = state?.authenticated ? '我已收到激活码，前往兑换' : '登录后兑换激活码';
  };
  const notice = (message, error = false) => {
    element('account-notice').textContent = message || '';
    element('account-notice').classList.toggle('is-error', error);
  };
  const updateButtons = () => {
    const blocked = busy || !state?.configured || ['initializing', 'secure_storage_unavailable'].includes(state?.status);
    panel.querySelectorAll('button').forEach(button => { if (!dialog.contains(button)) button.disabled = blocked; });
    element('account-open-membership').disabled = false;
    element('account-refresh').disabled = busy || !state?.configured || state?.status === 'initializing';
    element('account-refresh').textContent = state?.status === 'secure_storage_unavailable' ? '重试安全存储' : '刷新权益';
    const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    element('account-send-code').disabled = blocked || remaining > 0;
    element('account-send-code').textContent = remaining ? `${remaining} 秒后重发` : '发送验证码';
    if (!remaining && cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
    renderPurchase();
  };
  const render = value => {
    if (!value) return;
    const previousStatus = state?.status;
    state = value;
    const account = value.account;
    element('account-login-form').hidden = Boolean(value.authenticated);
    element('account-details').hidden = !value.authenticated;
    const badge = element('account-badge');
    badge.textContent = !value.configured ? '授权服务尚未配置' : value.status === 'initializing' ? '正在读取安全存储' : value.status === 'secure_storage_unavailable' ? '安全存储不可用'
      : value.status === 'service_unavailable' ? '服务暂时不可用' : value.status === 'checking' ? '正在验证登录'
        : value.authenticated ? membershipLabel(account) : '未登录软件账号';
    badge.classList.toggle('is-member', value.verified && Boolean(account?.membership?.active));
    if (account) {
      element('account-identity').textContent = account.user?.email || account.user?.id || '读取中';
      element('account-membership').textContent = membershipLabel(account);
      element('account-expiry').textContent = account.membership?.type === 'duration'
        ? `生效 ${dateLabel(account.membership.startsAt)} · 到期 ${dateLabel(account.membership.expiresAt)}`
        : account.membership?.type === 'permanent' ? '无会员到期时间' : '点击「开通会员」，或兑换邮件中的激活码';
      const labels = { authorized: '本设备已授权', device_limit: '账号已绑定其他设备，请联系管理员解绑', revoked: '此设备授权已被撤销，请联系管理员', unbound: '本设备尚未获得授权，请联系管理员' };
      element('account-device').textContent = labels[account.device?.status] || '等待服务端确认设备授权';
    } else if (value.authenticated) {
      element('account-identity').textContent = '已保存登录，等待服务端确认';
      element('account-membership').textContent = '会员状态待校验';
      element('account-expiry').textContent = '';
      element('account-device').textContent = '设备授权待校验';
    }
    if (!value.configured) notice('授权服务尚未配置。管理员完成部署并配置服务地址后，才能登录和使用会员功能。单篇下载仍可使用。');
    else if (value.status === 'initializing') notice('正在读取本机加密登录信息。如 macOS 弹出钥匙串授权，请输入 Mac 登录密码；确认是本软件后可选择“始终允许”。');
    else if (value.error) notice(value.error.message, true);
    else if (value.pendingLogout) notice('已退出本机登录，服务器会话撤销等待联网重试。设备名额不会释放。');
    else if (['initializing', 'secure_storage_unavailable'].includes(previousStatus)) notice('');
    updateButtons();
  };
  async function run(operation, successMessage) {
    if (busy) return;
    busy = true; updateButtons(); notice('正在处理…');
    try {
      const reply = await operation(); render(reply.state);
      if (!reply.ok) throw new Error(reply.error?.message || '操作失败，请稍后重试。');
      notice(reply.result?.message || successMessage || '操作完成。');
      return reply.result;
    } catch (error) { notice(error.message || '操作失败，请稍后重试。', true); }
    finally { busy = false; updateButtons(); }
  }
  element('account-send-code').addEventListener('click', async () => {
    const email = element('account-email'); if (!email.reportValidity()) return;
    const result = await run(() => bridge.sendAccountCode(email.value), '验证码已发送，5 分钟内有效。');
    if (result) {
      cooldownUntil = Date.now() + Math.max(60, Number(result.retryAfter) || 0) * 1000;
      cooldownTimer = setInterval(updateButtons, 1000); updateButtons(); element('account-otp').focus();
    }
  });
  element('account-login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await run(() => bridge.verifyAccountCode(element('account-email').value, element('account-otp').value), '软件账号登录成功。');
    if (result) element('account-otp').value = '';
  });
  element('account-refresh').addEventListener('click', () => run(() => bridge.refreshAccount(), '已从服务端刷新账号、会员和设备状态。'));
  element('account-redeem-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await run(() => bridge.redeemAccountCode(element('account-activation').value));
    if (result) element('account-activation').value = '';
  });
  element('account-logout').addEventListener('click', () => run(() => bridge.logoutAccount()));
  element('account-open-membership').addEventListener('click', () => { renderPurchase(); if (!dialog.open) dialog.showModal(); });
  element('membership-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('change', renderPurchase);
  element('membership-go-login').addEventListener('click', () => {
    dialog.close();
    (state?.authenticated ? element('account-refresh') : element('account-email')).focus();
  });
  element('membership-go-redeem').addEventListener('click', () => {
    dialog.close();
    (state?.authenticated ? element('account-activation') : element('account-email')).focus();
  });
  element('membership-copy-email').addEventListener('click', async () => {
    const email = state?.authenticated ? state.account?.user?.email : '';
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      if (state?.account?.user?.email !== email || !state?.authenticated) return;
      copiedEmail = email;
      element('membership-email-status').textContent = '邮箱已复制，请粘贴到付款备注中。';
    } catch {
      if (state?.account?.user?.email === email && state?.authenticated) element('membership-email-status').textContent = '暂时无法复制，请选中上方邮箱手动复制，并填写在付款备注中。';
    }
  });
  const unsubscribe = bridge.onAccountUpdate(render);
  window.addEventListener('pagehide', () => {
    if (cooldownTimer) clearInterval(cooldownTimer);
    if (typeof unsubscribe === 'function') unsubscribe();
  }, { once: true });
  try { render(await bridge.getAccountState()); }
  catch { notice('无法读取软件账号，请重新打开应用。', true); }
}

if (typeof window !== 'undefined') void initializeAccountUI();
