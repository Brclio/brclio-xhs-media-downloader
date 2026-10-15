// Account extension. Brand components inherit the existing Brclio app template.
import { MEMBERSHIP_PLANS, getMembershipPlan } from './lib/membership-plans.js';
import { getAccountBridge } from './lib/browser-account.js';
import { initializeCommerceUI } from './commerce-ui.js';
import { initializeAvatarUI } from './avatar-ui.js';
import { createPaymentRecovery } from './lib/payment-recovery.js';

const { document, window } = globalThis.brclioPageContext?.() ?? globalThis;

const PAYMENT_METHODS = Object.freeze({
  wechat: { name: '微信支付', image: './assets/membership/wechat-pay.png' },
  alipay: { name: '支付宝', image: './assets/membership/alipay.png' },
});

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' }) : '—';
}
export function consumeGoogleCallback({ href, replace }) {
  const url = new URL(href);
  if (url.searchParams.get('google_callback') !== '1') return null;
  const callback = { code: url.searchParams.get('code') || '', state: url.searchParams.get('state') || '', error: url.searchParams.get('error') || '' };
  for (const key of ['google_callback', 'code', 'state', 'scope', 'authuser', 'prompt', 'error', 'error_description', 'hd']) url.searchParams.delete(key);
  replace(url.href);
  return callback;
}
export function consumePaymentCallback({ href, replace }) {
  const url = new URL(href);
  if (!['/', '/index.html'].includes(url.pathname) || !url.searchParams.has('payment_order')) return null;
  const orderId = url.searchParams.get('payment_order');
  for (const key of ['payment_order', 'payment_order_id', 'product_order_id']) url.searchParams.delete(key);
  replace(url.href);
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(orderId || '') ? orderId : null;
}
export function paymentCheckoutUrl(value) {
  const url = new URL(value);
  const fragment = new URLSearchParams(url.hash.slice(1)), token = fragment.get('token');
  if (url.origin !== 'https://pay.bornforthis.cn' || url.username || url.password || fragment.size !== 1 ||
    !token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error('收银台地址无效，请重新创建订单。');
  return url.href;
}
export function paymentCatalog(value) {
  if (!value || typeof value.enabled !== 'boolean' || (value.acceptingPayments !== undefined && typeof value.acceptingPayments !== 'boolean') || value.mode !== 'live' || value.currency !== 'CNY' || !Array.isArray(value.plans) || !['string', 'number'].includes(typeof value.version)) {
    throw new Error('在线商品目录无效，请稍后刷新。');
  }
  const seen = new Set();
  for (const plan of value.plans) {
    const rule = getMembershipPlan(plan.id);
    if (!rule || seen.has(plan.id) || plan.days !== rule.days || typeof plan.name !== 'string' || !plan.name ||
      !Number.isSafeInteger(plan.priceCents) || plan.priceCents <= 0 || !/^\d+\.\d{2}$/.test(plan.amount) ||
      Number(plan.amount.replace('.', '')) !== plan.priceCents) throw new Error('在线商品与本产品权益规则不一致，请联系客服。');
    seen.add(plan.id);
  }
  return value;
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
  const bridge = getAccountBridge();
  if (!bridge?.getAccountState || document.getElementById('software-account')) return;
  // Discard OAuth query values before the first asynchronous account request.
  // Codes and confirmation credentials live only in this page's memory.
  const googleCallback = !window.xhsDesktop?.getAccountState ? consumeGoogleCallback({ href: window.location.href,
    replace: href => window.history.replaceState(window.history.state, '', href) }) : null;
  const paymentReturn = consumePaymentCallback({ href: window.location.href,
    replace: href => window.history.replaceState(window.history.state, '', href) });
  const panel = document.createElement('section');
  panel.id = 'software-account';
  panel.className = 'software-account';
  panel.setAttribute('aria-labelledby', 'account-title');
  panel.innerHTML = `
    <div class="account-heading">
      <div><span class="account-eyebrow">SOFTWARE ACCOUNT</span><h2 id="account-title">软件账号与会员</h2></div>
      <div class="account-tools"><span id="account-badge" class="account-badge">读取登录状态…</span><button id="account-open-membership" class="button button-primary" type="button" aria-haspopup="dialog">开通会员</button><button id="account-refresh" class="button button-secondary" type="button">刷新权益</button></div>
    </div>
    <p class="account-intro">软件账号用于会员权益；小红书账号用于读取笔记，两者分别登录。可使用 Google 账号或邮箱验证码登录。<a id="account-membership-details" href="./membership.html">查看会员权益 ↗</a></p>
    <p id="account-notice" class="account-notice" role="status" aria-live="polite"></p>
    <section id="account-google-confirmation" class="account-google-confirmation" aria-labelledby="account-google-confirm-title" hidden>
      <h3 id="account-google-confirm-title">确认登录桌面客户端</h3>
      <p>Google 账号 <strong id="account-google-confirm-email"></strong> 将登录设备 <strong id="account-google-confirm-device"></strong>。请确认这是你刚才在客户端发起的登录。</p>
      <div class="account-google-actions"><button id="account-google-confirm" class="button button-primary" type="button">确认登录此设备</button><button id="account-google-decline" class="button button-secondary" type="button">取消</button></div>
    </section>
    <div id="account-google-login-row" class="account-google-login-row" hidden>
      <div class="account-google-actions"><button id="account-google-login" class="button account-google-button" type="button"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.23-2.51c-.89.6-2.03.96-3.39.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.86-2.86A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg><span id="account-google-login-label">使用 Google 账号登录</span></button><button id="account-google-cancel" class="button button-secondary" type="button" hidden>取消 Google 登录</button></div>
      <p id="account-google-note" class="account-form-note"></p>
      <p class="account-login-divider"><span>或使用邮箱验证码</span></p>
    </div>
    <form id="account-login-form" class="account-login-form">
      <label>邮箱地址<input id="account-email" type="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="you@example.com" required></label>
      <label>邮箱验证码<span class="account-code-row"><input id="account-otp" type="text" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6 位验证码" required><button id="account-send-code" class="button button-secondary" type="button">发送验证码</button></span></label>
      <button id="account-login" class="button button-primary" type="submit">验证并登录 / 注册</button>
      <p class="account-form-note">验证码 5 分钟有效且仅可成功使用一次。${window.xhsDesktop?.getAccountState ? '登录状态保存在本机系统安全存储中，退出应用不会退出账号。' : '登录状态通过安全 Cookie 保存；点击退出软件账号可结束当前登录。'}</p>
    </form>
    <div id="account-details" class="account-details" hidden>
      <dl class="account-facts"><div><dt>当前软件账号</dt><dd id="account-identity"></dd></div><div><dt>公开昵称</dt><dd id="account-nickname"></dd><dd class="account-secondary"><a id="account-nickname-settings" href="#software-reviews">设置评论昵称 ↗</a></dd></div><div><dt>会员权益</dt><dd id="account-membership"></dd><dd id="account-expiry" class="account-secondary"></dd></div><div><dt>当前设备</dt><dd id="account-device"></dd></div></dl>
      <form id="account-redeem-form" class="account-redeem-form"><label>会员激活码<input id="account-activation" autocomplete="off" spellcheck="false" maxlength="256" placeholder="输入邮件中收到的激活码" required></label><button id="account-redeem" class="button button-primary" type="submit">兑换会员</button><button id="account-logout" class="button button-secondary" type="button">退出软件账号</button></form>
      <p class="account-form-note">退出账号不会释放设备名额。更换设备请联系管理员；兑换会员不会绕过设备限制。</p>
    </div>
    <p class="account-scope">单篇原图、实况与播放视频免费下载；无水印原视频为会员权益，主页批量下载还需要已授权设备。原视频需由笔记页面提供，作者写入画面的水印可能仍保留。会员状态变化不会删除已有文件或任务记录。</p>
    <dialog id="membership-dialog" class="membership-dialog" aria-labelledby="membership-title" aria-describedby="membership-description">
      <div class="membership-dialog-heading">
        <div><span class="account-eyebrow">BRCLIO MEMBERSHIP</span><h2 id="membership-title">开通会员</h2></div>
        <button id="membership-close" class="membership-close" type="button" aria-label="关闭开通会员窗口" autofocus>×</button>
      </div>
      <p id="membership-description" class="membership-description">解锁无水印原视频下载与主页批量下载。原视频需由笔记页面提供；可在线付款开通，也可使用原有人工扫码与激活码流程。</p>
      <section id="membership-online-payment" class="membership-payment-note" aria-labelledby="membership-online-title" hidden>
        <h3 id="membership-online-title">Brclio Pay 在线开通</h3>
        <p class="membership-small">价格从支付中心实时读取。按次购买，不自动续费；付款经服务端核实后开通，已有未到期时长顺延，设备授权规则保持不变。桌面付款后请主动切回软件核实；收银台返回网页不保证拉起客户端，也不会更新本机旧版本。</p>
        <label>在线套餐 <select id="membership-online-plan" aria-describedby="membership-online-quote"></select></label>
        <p id="membership-online-quote" class="membership-amount">请刷新在线商品目录。</p>
        <div class="account-google-actions"><button id="membership-online-pay" class="button button-primary" type="button" disabled>前往 Brclio Pay 付款</button><button id="membership-online-refresh" class="button button-secondary" type="button">刷新在线报价</button><button id="membership-online-check" class="button button-secondary" type="button" hidden>查询付款与权益状态</button></div>
        <p id="membership-online-status" class="membership-small" role="status" aria-live="polite"></p>
      </section>
      <fieldset class="membership-plans"><legend>人工扫码套餐</legend><div class="membership-plan-options">${MEMBERSHIP_PLANS.map(plan => `
        <label class="membership-plan"><input type="radio" name="membership-plan" value="${plan.id}" ${plan.id === 'monthly' ? 'checked' : ''}><span class="membership-plan-name">${plan.name}</span><span class="membership-plan-price"><span>¥</span>${plan.priceLabel}</span><span class="membership-plan-duration">${plan.days} 天会员</span><span class="membership-plan-selected" aria-hidden="true">已选择</span></label>`).join('')}
      </div><p class="membership-small">按次购买，不自动续费。兑换后生效；已有有效期会员可顺延。</p></fieldset>
      <p class="membership-pricing-note"><span>价格说明</span>随着功能持续完善，会员价格将适时上调，具体以购买时页面展示为准。</p>
      <section class="membership-payment-note" aria-labelledby="membership-note-title">
        <h3 id="membership-note-title">付款务必备注软件账号邮箱</h3>
        <p>请填写用于登录本软件的邮箱，方便核实收款与发送激活码。请勿只填写小红书昵称。</p>
        <div id="membership-email-row" class="membership-email-row" hidden><span id="membership-email" class="membership-email"></span><button id="membership-copy-email" class="button button-secondary" type="button">复制邮箱</button></div>
        <p id="membership-email-status" class="membership-email-status" role="status" aria-live="polite"></p>
        <div class="membership-processing-note">
          <h4>人工处理，请耐心等待</h4>
          <p>付款后由人工核实，我们会在 <strong>24 小时内</strong>尽快处理，并将激活码发送至付款备注的邮箱。收到后兑换即可开通，会员时长从兑换成功起计算。</p>
        </div>
      </section>
      <div id="membership-login-guidance" class="membership-login-guidance"><p id="membership-login-message">请先登录软件账号，确认收件邮箱后再付款。</p><button id="membership-go-login" class="button button-primary" type="button">前往登录 / 注册</button></div>
      <section id="membership-payment" class="membership-payment" aria-label="扫码付款" hidden>
        <div class="membership-payment-instructions">
          <fieldset class="membership-methods"><legend>选择付款方式</legend><div class="membership-method-options"><label><input type="radio" name="membership-method" value="wechat" checked><span>微信支付</span></label><label><input type="radio" name="membership-method" value="alipay"><span>支付宝</span></label></div></fieldset>
          <p class="membership-amount">付款金额 <strong id="membership-amount">¥${MEMBERSHIP_PLANS[1].priceLabel}</strong><span id="membership-purchase-summary">${MEMBERSHIP_PLANS[1].name} · ${MEMBERSHIP_PLANS[1].days} 天</span></p>
          <p id="membership-payment-help" class="membership-small">请用微信扫描右侧二维码，手动输入对应金额，并在付款备注中填写上方邮箱。</p>
          <p class="membership-small">请留意收件箱与垃圾邮件，收到激活码后兑换开通。</p>
        </div>
        <figure class="membership-payment-qr"><img id="membership-payment-image" src="./assets/membership/wechat-pay.png" alt="微信支付收款二维码" width="240" height="240"><figcaption id="membership-payment-caption">微信支付 · 收款码</figcaption></figure>
      </section>
      <details class="membership-contact"><summary>忘记备注邮箱，或需要付款帮助？</summary><div class="membership-contact-content"><p>用微信扫描此码联系客服，提供付款记录和软件账号邮箱，方便核实。<strong>这是客服好友码，不是收款码。</strong></p><img src="./assets/membership/wechat-contact.png" alt="微信客服好友二维码（非收款码）" width="176" height="176"></div></details>
      <div class="membership-order-report"><button id="membership-report-paid" class="button button-secondary" type="button" hidden>我已付款，提交核实</button><p id="membership-order-status" role="status" aria-live="polite">付款后提交所选套餐和付款方式，订单将显示为待核实。此操作不会自动扣款或开通会员。</p></div>
      <div class="membership-dialog-footer"><p>收到邮件后，把激活码粘贴到「账号与会员」中兑换。</p><button id="membership-go-redeem" class="button button-primary" type="button">我已收到激活码，前往兑换</button></div>
    </dialog>`;
  const isDesktop = Boolean(window.xhsDesktop?.getAccountState);
  const mount = document.getElementById(isDesktop ? 'desktop-account-mount' : 'browser-account-mount');
  const navigation = document.getElementById('desktop-navigation');
  if (mount) mount.replaceChildren(panel);
  else if (navigation) navigation.insertAdjacentElement('afterend', panel);
  else (document.querySelector('main') || document.body).prepend(panel);
  const element = id => document.getElementById(id);
  let busy = false, state = null, cooldownUntil = 0, cooldownTimer = null, googleEnabled = false, googleBusy = false, googleConfirmation = null;
  const commerce = initializeCommerceUI({ accountPanel: panel, openAccount: () => openAccountUI() });
  const avatars = initializeAvatarUI({ panel, bridge, onState: value => render(value), isAccountBusy: () => busy, documentImpl: document, windowImpl: window });
  let paymentDraft = null, paymentBusy = false, paymentUserId = null, paymentEpoch = 0;
  let onlineCatalog = null, catalogBusy = false, catalogRevision = 0, onlineDraft = null, onlineBusy = false;
  let onlineOrderId = paymentReturn, onlineStatusBusy = false, returnCheckedUserId = null;
  let recoveryState = null, recoveryOwner = null, onlineQuote = null, wakeBusy = false, pageInactive = false, lastWake = -Infinity;
  const recovery = createPaymentRecovery({ bridge,
    onChange: value => {
      recoveryState = value;
      if (value.phase === 'idle') onlineQuote = null;
      if (value.order?.planId && getMembershipPlan(value.order.planId) && Number.isSafeInteger(value.order.priceCents)) {
        const plan = getMembershipPlan(value.order.planId);
        onlineQuote = { name: value.order.planName || plan.name, amount: (value.order.priceCents / 100).toFixed(2), days: plan.days };
      }
      onlineOrderId = value.orderId || (paymentReturn && !returnCheckedUserId ? paymentReturn : null);
      onlineStatusBusy = value.busy;
      if (value.message) element('membership-online-status').textContent = value.message
        + (value.persistent === false ? ' 此浏览器暂时无法保存恢复记录，请保留付款页面；关闭后可在「我的全部订单」核实。' : '');
      renderPurchase();
    },
    onConfirmed: value => {
      render(value.state);
      window.dispatchEvent(new CustomEvent('brclio-orders-changed'));
    },
  });
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
    element('membership-report-paid').hidden = !ready || !bridge.commerceRequest;
    element('membership-report-paid').disabled = paymentBusy;
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
    const onlinePlan = onlineCatalog?.plans.find(item => item.id === element('membership-online-plan').value);
    const paymentsPaused = onlineCatalog?.acceptingPayments === false;
    const draftPlan = onlineDraft && getMembershipPlan(onlineDraft.planId);
    const draftCatalogPlan = onlineDraft && onlineCatalog?.plans.find(item => item.id === onlineDraft.planId);
    element('membership-online-payment').hidden = !bridge.commerceRequest;
    const waiting = Boolean(recoveryState?.orderId && !['confirmed', 'closed'].includes(recoveryState.phase));
    element('membership-online-plan').disabled = waiting || onlineBusy || catalogBusy || Boolean(onlineDraft);
    element('membership-online-pay').disabled = waiting || !ready || !onlineCatalog?.enabled || paymentsPaused || (!onlinePlan && !onlineDraft) || catalogBusy || onlineBusy;
    element('membership-online-pay').textContent = onlineBusy ? '正在创建付款订单…' : waiting ? '等待付款与权益确认' : paymentsPaused ? '在线付款暂未开放' : onlineDraft ? '重试原付款订单' : '前往 Brclio Pay 付款';
    element('membership-online-refresh').disabled = catalogBusy || onlineBusy || !ready;
    element('membership-online-check').hidden = !onlineOrderId;
    element('membership-online-check').disabled = !state?.authenticated || onlineStatusBusy;
    const quote = waiting ? onlineQuote ? `${onlineQuote.name} · ¥${onlineQuote.amount} · ${onlineQuote.days} 天会员（原订单报价）` : '已恢复待核实订单，正在读取原订单报价。'
      : draftPlan ? `${draftCatalogPlan?.name || draftPlan.name} · ¥${onlineDraft.amount} · ${draftPlan.days} 天会员（原订单报价）`
      : onlinePlan ? `${onlinePlan.name} · ¥${onlinePlan.amount} · ${onlinePlan.days} 天会员` : '';
    element('membership-online-quote').textContent = catalogBusy ? '正在读取最新在线报价…'
      : onlineCatalog && !onlineCatalog.enabled ? '在线购买暂未开放。'
      : paymentsPaused ? `${quote ? `${quote}。` : ''}支付中心尚未启用在线收款，请稍后刷新报价或使用人工扫码。`
      : quote || '暂无可购买的在线套餐，请刷新报价。';
  };
  async function loadOnlineCatalog() {
    if (!bridge.commerceRequest || !paymentUserId || !state?.verified) return;
    const epoch = paymentEpoch, revision = ++catalogRevision;
    const wasPaused = onlineCatalog?.acceptingPayments === false;
    catalogBusy = true; onlineCatalog = null; renderPurchase();
    try {
      const reply = await bridge.commerceRequest('payment-catalog', { expectedUserId: paymentUserId });
      if (epoch !== paymentEpoch || revision !== catalogRevision) return;
      if (!reply.ok) throw new Error(reply.error?.message || '暂时无法读取在线报价，请稍后刷新。');
      const catalog = paymentCatalog(reply.result.catalog), selector = element('membership-online-plan');
      const selected = onlineDraft?.planId || selector.value || 'monthly';
      selector.replaceChildren(...catalog.plans.map(plan => {
        const option = document.createElement('option'); option.value = plan.id;
        option.textContent = `${plan.name} · ¥${plan.amount} · ${plan.days} 天`;
        return option;
      }));
      if (catalog.plans.some(plan => plan.id === selected)) selector.value = selected;
      onlineCatalog = catalog;
      if (wasPaused && catalog.acceptingPayments === true && catalog.enabled) {
        element('membership-online-status').textContent = onlineDraft ? '在线付款已恢复，请重试原付款订单。' : '在线付款已恢复，请确认当前报价后付款。';
      } else if (wasPaused && catalog.acceptingPayments === undefined && catalog.enabled) {
        element('membership-online-status').textContent = onlineDraft ? '已刷新报价，请重试原付款订单核实收款状态。' : '已刷新报价，收款状态仍需在下单时核实。';
      }
    } catch (error) {
      if (epoch === paymentEpoch && revision === catalogRevision) element('membership-online-status').textContent = error.message;
    } finally {
      if (epoch === paymentEpoch && revision === catalogRevision) { catalogBusy = false; renderPurchase(); }
    }
  }
  const checkOnlineOrder = () => recovery.focus();
  const notice = (message, error = false) => {
    element('account-notice').textContent = message || '';
    element('account-notice').classList.toggle('is-error', error);
  };
  const updateButtons = () => {
    const blocked = busy || !state?.configured || ['initializing', 'secure_storage_unavailable'].includes(state?.status);
    panel.querySelectorAll('button').forEach(button => { if (!dialog.contains(button) && !button.closest('[data-avatar-ui]')) button.disabled = blocked; });
    element('account-open-membership').disabled = false;
    element('account-refresh').disabled = busy || !state?.configured || state?.status === 'initializing';
    element('account-refresh').textContent = state?.status === 'secure_storage_unavailable' ? '重试安全存储' : '刷新权益';
    element('account-google-login-row').hidden = !googleEnabled || Boolean(state?.authenticated) || Boolean(googleConfirmation);
    element('account-google-login-label').textContent = googleBusy ? (isDesktop ? '等待浏览器确认…' : '正在打开 Google…') : '使用 Google 账号登录';
    element('account-login-form').hidden = Boolean(state?.authenticated) || Boolean(googleConfirmation);
    element('account-google-cancel').hidden = !isDesktop || !googleBusy;
    element('account-google-cancel').disabled = false;
    element('account-google-confirm').disabled = busy;
    element('account-google-decline').disabled = busy;
    element('account-google-note').textContent = isDesktop ? '将在系统默认浏览器中登录，确认账号与设备后回到客户端。' : '首次登录会自动创建软件账号。已有相同邮箱的软件账号会保留会员权益。';
    const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    element('account-send-code').disabled = blocked || remaining > 0;
    element('account-send-code').textContent = remaining ? `${remaining} 秒后重发` : '发送验证码';
    if (!remaining && cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
    renderPurchase();
    avatars?.renderControls();
  };
  const render = value => {
    if (!value) return;
    const previousStatus = state?.status;
    state = value;
    recovery.setAccount(value);
    if (paymentUserId !== (value.authenticated ? value.account?.user?.id : null)) {
      paymentEpoch++;
      recoveryOwner = null;
      paymentUserId = value.authenticated ? value.account?.user?.id : null;
      paymentDraft = null; paymentBusy = false;
      onlineCatalog = null; onlineDraft = null; onlineBusy = false; catalogBusy = false; onlineStatusBusy = false;
      catalogRevision++;
      element('membership-online-plan').replaceChildren();
      element('membership-online-status').textContent = onlineOrderId ? '登录付款时使用的软件账号后，可查询该订单的付款与权益状态。' : '';
      element('membership-order-status').textContent = '付款后提交所选套餐和付款方式，订单将显示为待核实。此操作不会自动扣款或开通会员。';
    }
    commerce?.updateAccount(value);
    avatars?.updateAccount(value);
    window.dispatchEvent(new CustomEvent('brclio-account-update', { detail: value }));
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
      element('account-nickname').textContent = account.user?.nickname || '前往用户评价设置';
      element('account-membership').textContent = membershipLabel(account);
      element('account-expiry').textContent = account.membership?.type === 'duration'
        ? `生效 ${dateLabel(account.membership.startsAt)} · 到期 ${dateLabel(account.membership.expiresAt)}`
        : account.membership?.type === 'permanent' ? '无会员到期时间' : '点击「开通会员」，或兑换邮件中的激活码';
      const labels = { authorized: '本设备已授权', device_limit: '账号已绑定其他设备，请联系管理员解绑', revoked: '此设备授权已被撤销，请联系管理员', unbound: '本设备尚未获得授权，请联系管理员' };
      element('account-device').textContent = isDesktop
        ? labels[account.device?.status] || '等待服务端确认设备授权'
        : '当前浏览器登录；主页批量下载需桌面端设备授权';
    } else if (value.authenticated) {
      element('account-identity').textContent = '已保存登录，等待服务端确认';
      element('account-nickname').textContent = '昵称待校验';
      element('account-membership').textContent = '会员状态待校验';
      element('account-expiry').textContent = '';
      element('account-device').textContent = isDesktop ? '设备授权待校验' : '浏览器登录状态待校验';
    }
    if (!value.configured) notice('授权服务尚未配置。管理员完成部署并配置服务地址后，才能登录和使用会员功能。单篇下载仍可使用。');
    else if (value.status === 'initializing') notice('正在读取本机加密登录信息。如 macOS 弹出钥匙串授权，请输入 Mac 登录密码；确认是本软件后可选择“始终允许”。');
    else if (value.error) notice(value.error.message, true);
    else if (value.pendingLogout) notice('已退出本机登录，服务器会话撤销等待联网重试。设备名额不会释放。');
    else if (['initializing', 'secure_storage_unavailable'].includes(previousStatus)) notice('');
    updateButtons();
    if (paymentReturn && paymentUserId && value.verified && returnCheckedUserId !== paymentUserId) {
      returnCheckedUserId = paymentUserId;
      recoveryOwner = paymentUserId;
      recovery.track(paymentReturn);
      queueMicrotask(() => void recovery.check());
    } else if (paymentUserId && value.verified && recoveryOwner !== paymentUserId) {
      recoveryOwner = paymentUserId;
      queueMicrotask(() => void recovery.restore());
    }
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
  element('account-google-login').addEventListener('click', async () => {
    if (busy || !googleEnabled) return;
    googleBusy = true;
    await run(async () => {
      notice(isDesktop ? '已打开默认浏览器。请完成 Google 登录并确认此设备，然后回到客户端。' : '正在打开 Google 登录…');
      const reply = await bridge.loginAccountGoogle();
      if (reply.ok && !isDesktop) {
        const url = new URL(reply.result?.authorizationUrl);
        if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.hash) throw new Error('Google 登录地址无效，请重试。');
        window.location.assign(url.href);
      }
      return reply;
    }, isDesktop ? 'Google 账号登录成功。' : '正在跳转至 Google…');
    googleBusy = false; updateButtons();
  });
  element('account-google-cancel').addEventListener('click', async () => {
    try { await bridge.cancelAccountGoogleLogin?.(); }
    catch { notice('取消登录失败，请重试。', true); }
  });
  element('account-google-confirm').addEventListener('click', async () => {
    const confirmation = googleConfirmation;
    if (!confirmation) return;
    const result = await run(() => bridge.confirmAccountGoogleLogin(confirmation), '已确认登录。请返回桌面客户端，稍候即可看到登录状态。');
    if (result) { googleConfirmation = null; element('account-google-confirmation').hidden = true; updateButtons(); }
  });
  element('account-google-decline').addEventListener('click', () => {
    googleConfirmation = null; element('account-google-confirmation').hidden = true;
    notice('未确认设备登录。请返回客户端取消此次 Google 登录。'); updateButtons();
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
  element('account-nickname-settings').addEventListener('click', event => {
    event.preventDefault();
    if (isDesktop) document.getElementById('reviews-tab')?.click();
    else document.getElementById('browser-account-dialog')?.close();
    document.getElementById('review-profile-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('review-nickname')?.focus({ preventScroll: true });
  });
  element('account-membership-details').addEventListener('click', event => {
    const tab = document.getElementById('desktop-membership-link');
    if (isDesktop && tab) { event.preventDefault(); tab.click(); }
  });
  element('account-open-membership').addEventListener('click', () => {
    renderPurchase(); if (!dialog.open) dialog.showModal(); void loadOnlineCatalog();
  });
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
  element('membership-online-refresh').addEventListener('click', () => void loadOnlineCatalog());
  element('membership-online-check').addEventListener('click', () => void checkOnlineOrder());
  element('membership-online-plan').addEventListener('change', renderPurchase);
  element('membership-online-pay').addEventListener('click', async () => {
    if (onlineBusy || !state?.verified || !paymentUserId || state.account?.membership?.type === 'permanent') return;
    const plan = onlineCatalog?.plans.find(item => item.id === element('membership-online-plan').value);
    if (!onlineCatalog?.enabled || onlineCatalog.acceptingPayments === false || (!plan && !onlineDraft)) return;
    onlineDraft ||= { planId: plan.id, amount: plan.amount, catalogVersion: onlineCatalog.version,
      expectedUserId: paymentUserId, requestId: crypto.randomUUID() };
    const epoch = paymentEpoch;
    onlineBusy = true; renderPurchase();
    element('membership-online-status').textContent = '正在创建订单，请稍候…';
    try {
      const reply = await bridge.commerceRequest('payment-create', onlineDraft);
      if (epoch !== paymentEpoch) return;
      if (!reply.ok) throw Object.assign(new Error(reply.error?.message || '创建结果未确认，请重试原订单。'), { code: reply.error?.code });
      const order = reply.result.order;
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(order?.id || '')) throw new Error('付款订单返回异常，请重试原订单。');
      onlineOrderId = order.id;
      const quotedPlan = getMembershipPlan(onlineDraft.planId);
      onlineQuote = { name: order.planName || onlineCatalog?.plans.find(item => item.id === onlineDraft.planId)?.name || quotedPlan.name,
        amount: Number.isSafeInteger(order.priceCents) ? (order.priceCents / 100).toFixed(2) : onlineDraft.amount, days: quotedPlan.days };
      if (order.status === 'confirmed' || ['PAID', 'CLOSED'].includes(reply.result.paymentStatus || order.paymentStatus)) {
        onlineDraft = null; recovery.track(order.id, { persistent: reply.recovery?.persistent !== false }); await recovery.check(); return;
      }
      const checkoutUrl = paymentCheckoutUrl(reply.result.checkoutUrl);
      onlineDraft = null;
      recovery.track(order.id, { persistent: reply.recovery?.persistent !== false });
      window.dispatchEvent(new CustomEvent('brclio-orders-changed'));
      if (isDesktop) window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
      else window.location.assign(checkoutUrl);
    } catch (error) {
      if (epoch !== paymentEpoch) return;
      if (error.code === 'QUOTE_CHANGED') {
        onlineDraft = null; await loadOnlineCatalog();
        if (epoch === paymentEpoch) element('membership-online-status').textContent = '在线报价已变化。请核对新价格，再次点击付款以创建新订单。';
      } else {
        element('membership-online-status').textContent = error.message;
        if (error.code === 'PAYMENT_SERVICE_DISABLED' && onlineCatalog) onlineCatalog = { ...onlineCatalog, acceptingPayments: false };
        if (['ACCOUNT_CHANGED', 'ALREADY_PERMANENT', 'INVALID_ORDER', 'REQUEST_ID_REUSED', 'PAYMENT_PRODUCT_DISABLED'].includes(error.code)) onlineDraft = null;
      }
    } finally { if (epoch === paymentEpoch) { onlineBusy = false; renderPurchase(); } }
  });
  element('membership-report-paid').addEventListener('click', async () => {
    if (paymentBusy || !state?.verified || !state?.authenticated || !paymentUserId) return;
    const planId = selectedPlan().id, paymentMethod = panel.querySelector('input[name="membership-method"]:checked').value;
    if (paymentDraft && (paymentDraft.planId !== planId || paymentDraft.paymentMethod !== paymentMethod)) {
      element('membership-order-status').textContent = '上次提交尚未确认，请恢复原套餐和付款方式重试，或刷新订单核实结果。'; return;
    }
    paymentDraft ||= { planId, paymentMethod, requestId: crypto.randomUUID(), expectedUserId: paymentUserId };
    const current = paymentEpoch; paymentBusy = true; renderPurchase();
    element('membership-order-status').textContent = '正在提交付款核实…';
    try {
      const reply = await bridge.commerceRequest('order-create', paymentDraft);
      if (current !== paymentEpoch) return;
      if (!reply.ok) { const error = new Error(reply.error?.message || '提交失败，请保留原选择重试。'); error.code = reply.error?.code; throw error; }
      paymentDraft = null;
      element('membership-order-status').textContent = `订单 ${reply.result.order.id} 已记录，付款待人工核实。可在「我的全部订单」查看。请保留付款凭证。`;
      window.dispatchEvent(new CustomEvent('brclio-orders-changed'));
    } catch (error) {
      if (current !== paymentEpoch) return;
      element('membership-order-status').textContent = error.message;
      if (error.code && !/^(?:STORAGE_|SERVICE_|RATE_LIMIT)/.test(error.code)) paymentDraft = null;
    } finally { if (current === paymentEpoch) { paymentBusy = false; renderPurchase(); } }
  });
  const unsubscribe = bridge.onAccountUpdate(render);
  const browserDialog = document.getElementById('browser-account-dialog');
  document.getElementById('browser-account-open')?.addEventListener('click', () => void openAccountUI());
  document.getElementById('browser-account-close')?.addEventListener('click', () => browserDialog?.close());
  window.addEventListener('pagehide', event => {
    // BFCache suspends this document rather than destroying it. Keep the
    // pending-order controller and subscriptions for pageshow's immediate check.
    if (event.persisted) return;
    pageInactive = true;
    if (cooldownTimer) clearInterval(cooldownTimer);
    if (typeof unsubscribe === 'function') unsubscribe();
    recovery.dispose();
    if (typeof unsubscribeFocus === 'function') unsubscribeFocus();
    window.removeEventListener('focus', wakePayment);
    window.removeEventListener('online', wakePayment);
    document.removeEventListener('visibilitychange', wakeVisible);
    window.removeEventListener('pageshow', wakeRestored);
  });
  async function wakePayment() {
    if (pageInactive || wakeBusy || Date.now() - lastWake < 250) return;
    lastWake = Date.now(); wakeBusy = true;
    try {
      if (!state?.verified && (state?.authenticated || state?.status === 'service_unavailable')) {
        const refreshed = await bridge.refreshAccount();
        if (refreshed?.state) render(refreshed.state);
      }
      await recovery.focus();
    } catch { /* The persisted order remains available for the next focus or retry. */ }
    finally { wakeBusy = false; }
  }
  const wakeVisible = () => { if (!document.hidden) void wakePayment(); };
  const wakeRestored = event => { if (event.persisted) { lastWake = -Infinity; void wakePayment(); } };
  const unsubscribeFocus = bridge.onAppFocus?.(() => void wakePayment());
  window.addEventListener('focus', wakePayment);
  window.addEventListener('online', wakePayment);
  document.addEventListener('visibilitychange', wakeVisible);
  window.addEventListener('pageshow', wakeRestored);
  try { render(await bridge.getAccountState()); }
  catch { notice('无法读取软件账号，请重新打开应用。', true); }
  if (paymentReturn) {
    const browserDialog = document.getElementById('browser-account-dialog');
    if (isDesktop) document.getElementById('account-tab')?.click();
    else if (browserDialog && !browserDialog.open) browserDialog.showModal();
    if (!dialog.open) dialog.showModal();
    if (paymentUserId && state?.verified) void loadOnlineCatalog();
  }
  try { const reply = await bridge.getAccountGoogleConfig?.(); googleEnabled = reply?.ok === true && reply.result?.enabled === true; updateButtons(); } catch {}
  if (googleCallback) {
    const browserDialog = document.getElementById('browser-account-dialog');
    if (browserDialog && !browserDialog.open) browserDialog.showModal();
    if (googleCallback.error) notice('Google 登录已取消。你可以重新登录或使用邮箱验证码。');
    else if (!googleCallback.code || !googleCallback.state) notice('Google 登录回调不完整，请重新登录。', true);
    else {
      const result = await run(() => bridge.completeAccountGoogleLogin(googleCallback), 'Google 账号登录成功。');
      if (result?.loginClient === 'desktop' && result.status === 'confirmation_required') {
        googleConfirmation = { attemptId: result.attemptId, confirmationToken: result.confirmationToken };
        element('account-google-confirm-email').textContent = result.email || '已验证的 Google 账号';
        element('account-google-confirm-device').textContent = result.deviceName || '桌面客户端';
        element('account-google-confirmation').hidden = false;
        notice('请核对账号与设备，然后确认登录桌面客户端。'); updateButtons();
        element('account-google-confirm').focus();
      }
    }
  }
}

export async function openAccountUI({ purchase = false } = {}) {
  await initializeAccountUI();
  if (document.body.isConnected === false) return;
  const desktopTab = document.getElementById('account-tab');
  if (window.xhsDesktop?.getAccountState && desktopTab) desktopTab.click();
  else {
    const dialog = document.getElementById('browser-account-dialog');
    if (dialog && !dialog.open) dialog.showModal();
  }
  const target = document.getElementById(purchase ? 'account-open-membership' : 'account-email');
  if (purchase) target?.click();
  else if (target && !target.closest('[hidden]')) target.focus();
  else document.getElementById('account-refresh')?.focus();
}

if (typeof window !== 'undefined') {
  let entryRevision = 0;
  async function applyAccountEntry(url = window.location.href) {
    const revision = ++entryRevision;
    await initializeAccountUI();
    if (revision !== entryRevision || document.body.isConnected === false) return;
    const requested = new URL(url);
    const current = new URL(window.location.href);
    // Other homepage entry hooks may already have consumed a signed note URL.
    // Read the live query so consuming account intent never restores old data.
    if (requested.pathname !== current.pathname || requested.searchParams.get('account') !== current.searchParams.get('account')
      || requested.searchParams.get('membership') !== current.searchParams.get('membership')) return;
    if (!['/', '/index.html'].includes(current.pathname)) return;
    const purchase = current.searchParams.get('membership') === 'open';
    const showOrders = current.searchParams.get('account') === 'orders';
    const showAccount = current.searchParams.get('account') === 'open';
    if (!purchase && !showOrders && !showAccount) return;
    current.searchParams.delete(purchase ? 'membership' : 'account');
    history.replaceState(history.state, '', current.href);
    await openAccountUI({ purchase });
    if (showOrders && revision === entryRevision && document.body.isConnected !== false) {
      document.getElementById('software-orders')?.scrollIntoView({ block: 'start' });
    }
  }
  window.addEventListener('brclio-page-leave', () => { entryRevision += 1; });
  void applyAccountEntry();
  window.addEventListener('brclio-page-enter', event => void applyAccountEntry(event.detail.url));
}
