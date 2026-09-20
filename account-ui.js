// Desktop-only account extension. Brand components inherit the existing Brclio app template.
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
      <div class="account-tools"><span id="account-badge" class="account-badge">读取登录状态…</span><button id="account-refresh" class="button button-secondary" type="button">刷新权益</button></div>
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
      <form id="account-redeem-form" class="account-redeem-form"><label>会员激活码<input id="account-activation" autocomplete="off" spellcheck="false" maxlength="256" placeholder="输入管理员发放的激活码" required></label><button id="account-redeem" class="button button-primary" type="submit">兑换会员</button><button id="account-logout" class="button button-secondary" type="button">退出软件账号</button></form>
      <p class="account-form-note">退出账号不会释放设备名额。更换设备请联系管理员；兑换会员不会绕过设备限制。</p>
    </div>
    <p class="account-scope">单篇下载免费；主页批量下载需要有效会员与已授权设备。会员状态变化不会删除已有文件或任务记录。</p>`;
  const navigation = document.getElementById('desktop-navigation');
  if (navigation) navigation.insertAdjacentElement('afterend', panel);
  else (document.querySelector('main') || document.body).prepend(panel);
  const element = id => document.getElementById(id);
  let busy = false, state = null, cooldownUntil = 0, cooldownTimer = null;
  const notice = (message, error = false) => {
    element('account-notice').textContent = message || '';
    element('account-notice').classList.toggle('is-error', error);
  };
  const updateButtons = () => {
    const blocked = busy || !state?.configured || state?.status === 'secure_storage_unavailable';
    panel.querySelectorAll('button').forEach(button => { button.disabled = blocked; });
    const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    element('account-send-code').disabled = blocked || remaining > 0;
    element('account-send-code').textContent = remaining ? `${remaining} 秒后重发` : '发送验证码';
    if (!remaining && cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
  };
  const render = value => {
    if (!value) return;
    state = value;
    const account = value.account;
    element('account-login-form').hidden = Boolean(value.authenticated);
    element('account-details').hidden = !value.authenticated;
    const badge = element('account-badge');
    badge.textContent = !value.configured ? '授权服务尚未配置' : value.status === 'secure_storage_unavailable' ? '安全存储不可用'
      : value.status === 'service_unavailable' ? '服务暂时不可用' : value.status === 'checking' ? '正在验证登录'
        : value.authenticated ? membershipLabel(account) : '未登录软件账号';
    badge.classList.toggle('is-member', value.verified && Boolean(account?.membership?.active));
    if (account) {
      element('account-identity').textContent = account.user?.email || account.user?.id || '读取中';
      element('account-membership').textContent = membershipLabel(account);
      element('account-expiry').textContent = account.membership?.type === 'duration'
        ? `生效 ${dateLabel(account.membership.startsAt)} · 到期 ${dateLabel(account.membership.expiresAt)}`
        : account.membership?.type === 'permanent' ? '无会员到期时间' : '可兑换激活码或联系管理员开通';
      const labels = { authorized: '本设备已授权', device_limit: '账号已绑定其他设备，请联系管理员解绑', revoked: '此设备授权已被撤销，请联系管理员', unbound: '本设备尚未获得授权，请联系管理员' };
      element('account-device').textContent = labels[account.device?.status] || '等待服务端确认设备授权';
    } else if (value.authenticated) {
      element('account-identity').textContent = '已保存登录，等待服务端确认';
      element('account-membership').textContent = '会员状态待校验';
      element('account-expiry').textContent = '';
      element('account-device').textContent = '设备授权待校验';
    }
    if (!value.configured) notice('授权服务尚未配置。管理员完成部署并配置服务地址后，才能登录和使用会员功能。单篇下载仍可使用。');
    else if (value.error) notice(value.error.message, true);
    else if (value.pendingLogout) notice('已退出本机登录，服务器会话撤销等待联网重试。设备名额不会释放。');
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
  bridge.onAccountUpdate(render);
  try { render(await bridge.getAccountState()); }
  catch { notice('无法读取软件账号，请重新打开应用。', true); }
}

if (typeof window !== 'undefined') void initializeAccountUI();
