// Brclio app components: public reviews and private purchase history.
import { getAccountBridge } from './lib/browser-account.js';
import { defaultReviewNickname, randomReviewNickname, normalizeReviewNickname } from './lib/review-nicknames.js';

const money = cents => cents == null ? '待核实' : `¥${(cents / 100).toFixed(2)}`;
const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const statuses = { pending: '付款待核实', confirmed: '已确认收款', legacy_unverified: '历史发码 · 收款待核实' };
const methods = { wechat: '微信支付', alipay: '支付宝', other: '其他方式', unknown: '待核实' };
function node(tag, className, text) {
  const item = document.createElement(tag);
  item.className = className || '';
  if (text != null) item.textContent = text;
  return item;
}

export function initializeCommerceUI({ accountPanel, openAccount }) {
  const bridge = getAccountBridge();
  if (!bridge?.commerceRequest || document.getElementById('software-reviews')) return null;
  const desktop = Boolean(window.xhsDesktop?.getAccountState);
  let userId = '', epoch = 0, reviewRequest = 0, orderRequest = 0;
  let reviewsPage = 1, ordersPage = 1, mineKnown = false, reviewed = false, submitting = false;
  let draft = null, profileDraft = null, profileBusy = false, nickname = '', nicknameDirty = false;

  const reviews = node('section', 'software-reviews');
  reviews.id = 'software-reviews';
  reviews.setAttribute('aria-labelledby', 'software-reviews-title');
  reviews.innerHTML = `<div class="commerce-heading"><div><span class="section-label">FROM OUR USERS</span><h2 id="software-reviews-title">用户评价</h2><p>用过之后，留下你的真实感受。</p></div><div class="review-score"><strong id="review-average">—</strong><span id="review-count">正在读取评价</span></div></div>
    <div id="review-list" class="review-list" aria-live="polite"></div><div id="review-pagination" class="commerce-pagination"></div>
    <p id="review-notice" class="commerce-notice" role="status" aria-live="polite"></p>
    <p id="review-account-notice" class="commerce-notice" role="status" aria-live="polite"></p><div id="review-mine-retry" class="commerce-pagination"></div>
    <div id="review-login-prompt" class="review-login-prompt"><p>所有用户均可评价，无需会员。每个软件账号仅可发布一次。</p><button id="review-login" class="button button-secondary" type="button">登录后评价</button></div>
    <form id="review-profile-form" class="review-profile-form" hidden><label for="review-nickname">公开昵称</label><div class="review-nickname-row"><input id="review-nickname" type="text" autocomplete="nickname" minlength="2" maxlength="48" required aria-describedby="review-nickname-help"><button id="review-nickname-random" class="button button-secondary" type="button">随机换一个</button><button id="review-nickname-save" class="button button-secondary" type="submit">保存昵称</button></div><p id="review-nickname-help" class="commerce-help">可自行填写 2–24 个字，也可从内置 1000 个昵称中随机选择。已发表的评价会显示当前昵称，昵称可随时修改。</p><p id="review-profile-notice" class="commerce-notice" role="status" aria-live="polite"></p></form>
    <form id="review-form" class="review-form" hidden><fieldset><legend>你的评分</legend><div class="review-rating">${[5, 4, 3, 2, 1].map(rating => `<label><input type="radio" name="software-rating" value="${rating}" ${rating === 5 ? 'checked' : ''} required><span>${rating} 星</span></label>`).join('')}</div></fieldset>
    <label for="review-content">使用感受</label><textarea id="review-content" rows="3" minlength="5" maxlength="1000" placeholder="哪些地方帮到了你，还有哪些可以改进？（5–1000 字）" required></textarea>
    <p class="commerce-help">评价按原文公开展示，仅对邮箱脱敏。评分和正文发布后无法修改，每个账号仅限一次。</p>
    <button id="review-submit" class="button button-primary" type="submit">发布评价（仅限一次）</button></form>`;
  const publicMount = desktop ? document.getElementById('desktop-reviews-page') : document.getElementById('public-reviews-mount');
  (publicMount || accountPanel).append(reviews);

  const orders = node('section', 'software-orders');
  orders.id = 'software-orders';
  orders.setAttribute('aria-labelledby', 'software-orders-title');
  orders.innerHTML = `<div class="commerce-heading"><div><span class="account-eyebrow">YOUR PURCHASES</span><h2 id="software-orders-title">我的全部订单</h2></div><button id="orders-refresh" class="button button-secondary" type="button">刷新订单</button></div>
    <p class="commerce-help">仅展示当前软件账号的订单。扫码付款后可在「开通会员」提交付款核实，管理员核实收款后更新；发码与会员兑换分别处理。</p>
    <p id="orders-notice" class="commerce-notice" role="status" aria-live="polite">登录软件账号后查看订单。</p><div id="orders-list" class="orders-list"></div><div id="orders-pagination" class="commerce-pagination"></div>`;
  accountPanel.append(orders);
  const $ = id => document.getElementById(id);
  function notice(id, message, error = false) { $(id).textContent = message; $(id).classList.toggle('is-error', error); }
  async function request(action, input = {}) {
    const reply = await bridge.commerceRequest(action, input);
    if (!reply?.ok) { const error = new Error(reply?.error?.message || '暂时无法读取，请稍后重试。'); error.code = reply?.error?.code; throw error; }
    return reply.result;
  }
  function retry(container, label, callback) {
    const button = node('button', 'button button-secondary', label); button.type = 'button';
    button.addEventListener('click', callback); container.append(button);
  }
  function pagination(id, result, load) {
    const mount = $(id); mount.replaceChildren();
    if (result.totalPages <= 1) return;
    for (const [label, page, disabled] of [['上一页', result.page - 1, result.page <= 1], ['下一页', result.page + 1, result.page >= result.totalPages]]) {
      const button = node('button', 'button button-secondary', label); button.type = 'button'; button.disabled = disabled;
      button.addEventListener('click', () => void load(page)); mount.append(button);
      if (label === '上一页') mount.append(node('span', '', `${result.page} / ${result.totalPages} · 共 ${result.total} 条`));
    }
  }
  async function loadReviews(page = reviewsPage) {
    const serial = ++reviewRequest;
    notice('review-notice', '正在读取评价…');
    try {
      const result = await request('reviews-public', { page, pageSize: 6 });
      if (serial !== reviewRequest) return;
      reviewsPage = result.page;
      $('review-average').textContent = result.summary.count ? `${Number(result.summary.averageRating).toFixed(1)} / 5` : '—';
      $('review-count').textContent = `${result.summary.count} 位用户评价`;
      const list = $('review-list'); list.replaceChildren();
      if (!result.reviews.length) list.append(node('p', 'commerce-empty', '还没有评价，欢迎分享第一条真实体验。'));
      for (const item of result.reviews) {
        const card = node('article', 'review-item'); const heading = node('div', 'review-item-heading');
        heading.append(node('strong', '', item.authorLabel), node('span', 'review-stars', `${'★'.repeat(item.rating)}${'☆'.repeat(5 - item.rating)}`));
        const time = node('time', '', date(item.createdAt)); time.dateTime = item.createdAt;
        card.append(heading, node('p', 'review-content', item.content), time); list.append(card);
      }
      pagination('review-pagination', result, loadReviews); notice('review-notice', '');
    } catch (error) {
      if (serial !== reviewRequest) return;
      notice('review-notice', error.message, true);
      $('review-pagination').replaceChildren(); retry($('review-pagination'), '重新读取评价', () => void loadReviews(page));
    }
  }
  async function loadOrders(page = 1) {
    const current = epoch, serial = ++orderRequest, owner = userId;
    if (!owner) return;
    notice('orders-notice', '正在读取订单…'); $('orders-refresh').disabled = true;
    // Clear the old page while loading so pagination errors cannot mislabel data.
    $('orders-list').replaceChildren(); $('orders-pagination').replaceChildren();
    try {
      const result = await request('orders-mine', { page, pageSize: 10, expectedUserId: owner });
      if (epoch !== current || serial !== orderRequest) return;
      ordersPage = result.page;
      for (const order of result.orders) {
        const row = node('article', 'order-item'); const heading = node('div', 'order-heading');
        heading.append(node('strong', '', order.planName || '会员订单'), node('span', `order-status order-status-${order.status}`, statuses[order.status] || '待核实'));
        const facts = node('dl', 'order-facts');
        for (const [label, value] of [['订单编号', order.id], ['套餐金额', money(order.priceCents)], ['实收金额', money(order.amountCents)], ['付款方式', methods[order.paymentMethod] || '待核实'], ['创建时间', date(order.createdAt)], ['收款时间', date(order.paidAt)]]) {
          const pair = node('div'); pair.append(node('dt', '', label), node('dd', '', value)); facts.append(pair);
        }
        row.append(heading, facts); $('orders-list').append(row);
      }
      pagination('orders-pagination', result, loadOrders);
      notice('orders-notice', result.total ? `共 ${result.total} 条订单，可翻页查看全部记录。` : '暂时没有订单。历史未记录的收款可联系客服核实补录。');
    } catch (error) {
      if (epoch !== current || serial !== orderRequest) return;
      notice('orders-notice', error.message, true); retry($('orders-pagination'), '重新读取订单', () => void loadOrders(page));
    } finally { if (epoch === current && serial === orderRequest) $('orders-refresh').disabled = false; }
  }
  function renderComposer() {
    $('review-login-prompt').hidden = Boolean(userId);
    $('review-profile-form').hidden = !userId;
    $('review-form').hidden = !userId || !mineKnown || reviewed;
    $('review-submit').disabled = submitting || profileBusy || Boolean(profileDraft);
    $('review-nickname').readOnly = submitting || profileBusy || Boolean(profileDraft) || Boolean(draft);
    $('review-nickname-random').disabled = !userId || $('review-nickname').readOnly;
    $('review-nickname-save').disabled = !userId || submitting || profileBusy || Boolean(draft);
  }
  async function loadMine() {
    const current = epoch, owner = userId;
    $('review-mine-retry').replaceChildren();
    try {
      const result = await request('review-mine', { expectedUserId: owner });
      if (epoch !== current) return;
      mineKnown = true; reviewed = Boolean(result.review); renderComposer();
      notice('review-account-notice', reviewed ? '你已发布过评价，感谢分享。每个软件账号仅限一次。' : '每个软件账号仅可发布一次，请确认后提交。');
    } catch (error) {
      if (epoch !== current) return;
      notice('review-account-notice', error.message, true);
      retry($('review-mine-retry'), '重试读取我的评价', () => void loadMine());
    }
  }
  function updateAccount(state) {
    const next = state?.authenticated && state?.verified ? state.account?.user?.id || '' : '';
    const nextNickname = next ? state.account?.user?.nickname || defaultReviewNickname(next) : '';
    if (next === userId) {
      if (nickname !== nextNickname) {
        nickname = nextNickname;
        if (!nicknameDirty && !draft && !profileDraft) $('review-nickname').value = nickname;
        if (userId) void loadReviews(reviewsPage);
      }
      return;
    }
    epoch++; userId = next; ordersPage = 1; mineKnown = false; reviewed = false; submitting = false; draft = null;
    profileDraft = null; profileBusy = false; nicknameDirty = false; nickname = nextNickname;
    $('review-nickname').value = nickname; notice('review-profile-notice', '');
    $('review-content').value = ''; $('orders-list').replaceChildren(); $('orders-pagination').replaceChildren();
    $('review-mine-retry').replaceChildren(); notice('review-account-notice', '');
    $('orders-refresh').disabled = !userId;
    notice('orders-notice', userId ? '正在读取订单…' : '登录软件账号后查看订单。');
    renderComposer();
    if (userId) { void loadMine(); void loadOrders(); }
  }
  $('review-login').addEventListener('click', () => void openAccount());
  $('orders-refresh').addEventListener('click', () => void loadOrders(ordersPage));
  $('review-nickname').addEventListener('input', () => { nicknameDirty = true; $('review-nickname').setCustomValidity(''); });
  $('review-nickname-random').addEventListener('click', () => {
    if (!userId || $('review-nickname').readOnly) return;
    $('review-nickname').value = randomReviewNickname($('review-nickname').value);
    nicknameDirty = true; $('review-nickname').setCustomValidity('');
    notice('review-profile-notice', '已随机选择昵称；保存昵称或发布评价后生效。');
  });
  function readNickname() {
    try { const value = normalizeReviewNickname($('review-nickname').value); $('review-nickname').setCustomValidity(''); return value; }
    catch { $('review-nickname').setCustomValidity('昵称需为 2–24 个字，不能包含换行或不可见字符。'); $('review-nickname').reportValidity(); return null; }
  }
  $('review-profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!userId || submitting || profileBusy || draft) return;
    const value = readNickname(); if (!value) return;
    if (profileDraft && profileDraft.nickname !== value) return;
    profileDraft ||= { nickname: value, expectedUserId: userId, requestId: crypto.randomUUID() };
    const current = epoch; profileBusy = true; renderComposer(); notice('review-profile-notice', '正在保存昵称…');
    try {
      const result = await request('profile-update', profileDraft);
      if (epoch !== current) return;
      nickname = result.profile.nickname; nicknameDirty = false; profileDraft = null;
      $('review-nickname').value = nickname;
      notice('review-profile-notice', '昵称已保存，已发表的评价同步显示当前昵称。');
      await loadReviews(reviewsPage);
    } catch (error) {
      if (epoch !== current) return;
      notice('review-profile-notice', error.message, true);
      if (error.code && !/^(?:STORAGE_|SERVICE_|RATE_LIMIT)/.test(error.code)) profileDraft = null;
    } finally { if (epoch === current) { profileBusy = false; renderComposer(); } }
  });
  $('review-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || profileBusy || profileDraft || !userId || !mineKnown || reviewed || !$('review-form').reportValidity()) return;
    const value = readNickname(); if (!value) return;
    const content = $('review-content').value, rating = Number(reviews.querySelector('input[name="software-rating"]:checked').value);
    if (content.trim().length < 5) { notice('review-account-notice', '请填写 5–1000 字的使用感受。', true); return; }
    // After an uncertain network response retain the exact request and text.
    if (draft && (draft.content !== content || draft.rating !== rating || draft.nickname !== value)) { notice('review-account-notice', '上次提交尚未确认，请保留原内容重试，或刷新核实评价结果。', true); return; }
    draft ||= { content, rating, nickname: value, requestId: crypto.randomUUID(), expectedUserId: userId };
    const current = epoch; submitting = true; renderComposer(); notice('review-account-notice', '正在发布评价…');
    try {
      const result = await request('review-submit', draft);
      if (epoch !== current) return;
      nickname = result.profile?.nickname || result.review?.authorLabel || value; nicknameDirty = false;
      $('review-nickname').value = nickname;
      reviewed = true; mineKnown = true; draft = null; $('review-content').value = '';
      await loadReviews(1);
      if (epoch === current) notice('review-account-notice', '评价已发布，感谢分享你的体验。');
    } catch (error) {
      if (epoch !== current) return;
      notice('review-account-notice', error.message, true);
      if (error.code === 'REVIEW_ALREADY_EXISTS') { reviewed = true; mineKnown = true; draft = null; void loadReviews(1); }
      else if (error.code && !/^(?:STORAGE_|SERVICE_|RATE_LIMIT)/.test(error.code)) draft = null;
    } finally { if (epoch === current) { submitting = false; renderComposer(); } }
  });
  window.addEventListener('brclio-account-update', event => updateAccount(event.detail));
  window.addEventListener('brclio-orders-changed', () => { if (userId) void loadOrders(); });
  void loadReviews(1); renderComposer(); $('orders-refresh').disabled = true;
  return { updateAccount };
}
