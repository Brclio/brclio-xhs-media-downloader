/* Brclio membership administration. Authentication is an HttpOnly server cookie. */
import { MEMBERSHIP_PLANS } from '../lib/membership-plans.js';
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { admin: null, users: [], codes: [], audit: [], feedback: [], selectedFeedback: null, feedbackDetail: null, feedbackHistory: [], feedbackMessages: [], feedbackDrafts: new Map(), feedbackLog: null, selectedId: null, user: null, history: [], pendingDevices: [], generated: [], generatedSaved: false, tab: 'users', serverTime: null, loaded: new Set(), requestIds: new Map(), pendingMutation: null, mutating: false, pages: { users: 0, codes: 0, audit: 0, feedback: 0 }, total: {} };
  const PAGE_SIZE = 20;
  const issue = { recipients: [], code: null, reason: '', searchRequest: 0 };
  const commerce = { orders: [], page: 1, pageSize: 20, total: 0, totalPages: 0, revenue: null, recipients: [], target: null, listRequest: 0, revenueRequest: 0, searchRequest: 0 };
  let orderLinkTarget = null;
  let dialogResolve = null;
  let sendTimer = null;
  let userRequest = 0;
  let feedbackRequest = 0;
  let feedbackSessionEpoch = 0;
  let updateProxyConfig = null;
  let updateProxyRequest = 0;
  let updateProxyDraft = '';
  let updateProxyVisible = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function button(text, className, action) {
    const node = el('button', `button ${className || ''}`, text);
    node.type = 'button';
    if (action) node.addEventListener('click', () => run(node, action));
    return node;
  }
  function tell(message, tone = 'info') {
    $('notice').textContent = message;
    $('notice').dataset.tone = tone;
    $('notice').hidden = false;
  }
  function clearNotice() { $('notice').hidden = true; }
  function fmt(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  function badge(text, variant = '') { return el('span', `badge ${variant}`, text); }
  function platformName(value) { return ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[value] || value || '未知系统'; }
  function membershipBadge(membership = {}) {
    if (membership.type === 'permanent') return badge('永久会员', 'badge-gold');
    if (['duration', 'timed'].includes(membership.type)) return badge(membership.active ? '有效期会员' : '会员未生效 / 已到期', membership.active ? '' : 'badge-danger');
    return badge('普通用户', 'badge-muted');
  }
  function summaryText(value) { return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2); }
  function changeDetails(before, after) {
    const details = el('details');
    details.append(el('summary', '', '查看变更前后'), el('pre', '', `变更前\n${summaryText(before)}\n\n变更后\n${summaryText(after)}`));
    return details;
  }
  function facts(items, className = 'facts') {
    const list = el('dl', className);
    for (const [label, value] of items) {
      const pair = el('div');
      pair.append(el('dt', '', label), value instanceof Node ? el('dd') : el('dd', '', value ?? '—'));
      if (value instanceof Node) pair.lastChild.append(value);
      list.append(pair);
    }
    return list;
  }
  function table(headers, rows, className = '') {
    const wrapper = el('div', 'table-wrap');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('aria-label', '可横向滚动的数据表格');
    const element = el('table', `data-table ${className}`);
    const head = el('thead'); const line = el('tr');
    headers.forEach((name) => { const th = el('th', '', name); th.scope = 'col'; line.append(th); });
    head.append(line); element.append(head);
    const body = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      row.forEach((value) => { const td = el('td'); if (value instanceof Node) td.append(value); else td.textContent = String(value ?? '—'); tr.append(td); });
      body.append(tr);
    }
    element.append(body); wrapper.append(element); return wrapper;
  }
  function record(primary, secondary) {
    const item = el('div', 'record-id', primary || '—');
    if (secondary) item.append(el('span', 'small-text', secondary));
    return item;
  }
  function empty(container, message) { container.replaceChildren(el('p', 'empty-inline', message)); }
  function pageItems(kind, items, render) {
    const last = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
    state.pages[kind] = Math.min(state.pages[kind], last);
    const page = state.pages[kind]; const navigation = $(`${kind}-pagination`);
    navigation.replaceChildren();
    if (items.length > PAGE_SIZE) {
      const previous = button('上一页', 'button-secondary button-small', () => { state.pages[kind] -= 1; render(); });
      previous.disabled = page === 0;
      const next = button('下一页', 'button-secondary button-small', () => { state.pages[kind] += 1; render(); });
      next.disabled = page === last;
      navigation.append(previous, el('span', '', `${page + 1} / ${last + 1} · ${items.length} 条`), next);
    }
    if ((state.total[kind] || 0) > items.length && kind !== 'codes') navigation.append(el('span', '', `共 ${state.total[kind]} 条，本次最多显示 1,000 条`));
    return items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }
  async function api(action, input = {}) {
    const epoch = feedbackSessionEpoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetch('/api/account', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input }), signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        const error = new Error(body?.error?.message || `服务暂时不可用（HTTP ${response.status}），请稍后重试。`);
        error.code = body?.error?.code || 'SERVICE_UNAVAILABLE';
        error.uncertain = !body || response.status >= 500 || response.status === 429;
        if (response.status === 401 && state.admin && epoch === feedbackSessionEpoch) { resetSession(); tell('登录已失效，请重新验证邮箱。', 'error'); }
        throw error;
      }
      if (body.serverTime && epoch === feedbackSessionEpoch) state.serverTime = body.serverTime;
      return body;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        const wrapped = new Error('请求未能确认完成。请保持页面打开并重试相同操作；系统会复用请求编号，避免重复修改。');
        wrapped.uncertain = true;
        throw wrapped;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  // Keep uncertain operations in memory with the same requestId; do not retry under a fresh ID.
  async function mutate(action, input) {
    const epoch = feedbackSessionEpoch;
    const key = JSON.stringify([action, input]);
    if (state.mutating) throw new Error('已有管理操作正在提交，请等待结果。');
    if (state.pendingMutation && state.pendingMutation.key !== key) throw new Error('上次操作的结果仍未确认。请先点击“重试原操作”核对结果，再发起其他修改。');
    const requestId = state.requestIds.get(key) || crypto.randomUUID();
    state.requestIds.set(key, requestId);
    state.mutating = true;
    try {
      const result = await api(action, { ...input, requestId });
      if (epoch !== feedbackSessionEpoch || !state.admin) throw new Error('管理会话已结束。');
      state.requestIds.delete(key);
      state.pendingMutation = null;
      return result;
    } catch (error) {
      if (epoch !== feedbackSessionEpoch || !state.admin) throw error;
      if (!error.uncertain) { if (action !== 'admin-feedback-reply') state.requestIds.delete(key); state.pendingMutation = null; }
      else state.pendingMutation = { action, input: { ...input }, key };
      throw error;
    } finally { if (epoch === feedbackSessionEpoch) state.mutating = false; }
  }
  async function run(target, action) {
    const epoch = feedbackSessionEpoch;
    if (target?.dataset.busy === 'true') return;
    const wasDisabled = target?.disabled;
    if (target) { target.disabled = true; target.dataset.busy = 'true'; }
    try { return await action(); }
    catch (error) {
      if (epoch !== feedbackSessionEpoch) return;
      tell(error.message || '操作失败，请重试。', 'error');
      if (state.pendingMutation) {
        const retry = button('重试原操作', 'button-secondary button-small', async () => {
          const pending = state.pendingMutation;
          if (!pending) return;
          const result = await mutate(pending.action, pending.input);
          state.loaded.delete('audit');
          if (pending.action === 'admin-save-update-proxy-config') return finishUpdateProxySave(result);
          if (pending.action === 'admin-feedback-reply') return finishFeedbackReply(pending.input, result);
          if (pending.action === 'admin-record-order') return finishOrderRecord(result);
          if (pending.action === 'admin-link-order-code') return finishOrderLink(result);
          if (pending.action === 'admin-generate-codes') displayGenerated(result, pending.input);
          else if (pending.action === 'admin-send-activation') displaySent(result);
          else tell('原操作已确认完成，未重复增加权益或重复生成记录。', 'success');
          if (['admin-generate-codes', 'admin-send-activation'].includes(pending.action)) await loadCodes();
          else if (pending.input.userId) await refreshUserAfterChange(pending.input.userId);
          else if (pending.action === 'admin-feedback-status') { await loadFeedback(); await selectFeedback(pending.input.feedbackId); }
          else await loadCodes();
        });
        const actions = el('div', 'button-row notice-actions'); actions.append(retry); $('notice').append(actions);
      }
    }
    finally { if (target) { target.disabled = wasDisabled || target.dataset.cooling === 'true'; delete target.dataset.busy; } }
  }
  function confirmAction(title, message, options = {}) {
    if (dialogResolve) return Promise.resolve(null);
    $('dialog-title').textContent = title; $('dialog-message').textContent = message;
    $('dialog-reason').value = options.reason || '';
    $('dialog-reason').required = options.reasonRequired !== false;
    $('dialog-reason-label').hidden = options.reasonRequired === false;
    $('dialog-confirm').textContent = options.confirm || '确认操作';
    $('dialog-confirm').className = `button ${options.danger ? 'button-danger' : ''}`;
    $('action-dialog').showModal();
    return new Promise((resolve) => { dialogResolve = resolve; });
  }
  function closeDialog(value) {
    const resolve = dialogResolve; dialogResolve = null;
    $('action-dialog').close();
    if (resolve) resolve(value);
  }
  $('dialog-cancel').addEventListener('click', () => closeDialog(null));
  $('action-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(null); });
  $('dialog-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!$('dialog-form').reportValidity()) return;
    const reason = $('dialog-reason').value.trim();
    if ($('dialog-reason').required && reason.length < 3) return $('dialog-reason').focus();
    closeDialog(reason || true);
  });
  function resetSession() {
    state.admin = null; state.users = []; state.codes = []; state.audit = []; state.user = null; state.history = []; state.pendingDevices = []; state.selectedId = null; state.loaded.clear(); state.requestIds.clear(); state.pendingMutation = null;
    clearGenerated();
    issue.recipients = []; issue.code = null; issue.reason = ''; issue.searchRequest += 1;
    $('issue-query').value = ''; $('issue-reason').value = ''; $('issue-deadline').value = '';
    renderRecipients(); renderIssuePreview();
    commerce.orders = []; commerce.page = 1; commerce.total = 0; commerce.totalPages = 0; commerce.revenue = null; commerce.listRequest += 1; commerce.revenueRequest += 1; commerce.searchRequest += 1;
    resetOrderRecord();
    closeOrderLink();
    ['orders-list', 'orders-pagination', 'revenue-summary', 'revenue-breakdown'].forEach(id => $(id).replaceChildren());
    $('orders-count').textContent = '';
    $('orders-filter-form').reset(); $('revenue-filter-form').reset();
    feedbackSessionEpoch += 1; feedbackRequest += 1;
    state.feedback = []; state.selectedFeedback = null; state.feedbackDetail = null; state.feedbackHistory = []; state.feedbackMessages = []; state.feedbackDrafts.clear(); state.feedbackLog = null; state.mutating = false;
    updateProxyConfig = null; updateProxyRequest += 1; updateProxyDraft = '';
    $('update-proxy-form').reset(); setUpdateProxyVisibility(false, false); $('save-update-proxy').disabled = true;
    $('update-proxy-meta').replaceChildren(); $('update-proxy-state').textContent = '正在加载'; $('update-proxy-save-note').textContent = '请先加载配置。';
    $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true; $('admin-email').textContent = '';
    ['users-list', 'user-detail', 'codes-list', 'audit-list', 'status-content', 'feedback-list', 'feedback-detail'].forEach((id) => $(id).replaceChildren());
  }
  async function loadSession() {
    const result = await api('me');
    const account = result.account;
    const user = account?.user || account;
    if (!user || user.role !== 'admin') {
      resetSession();
      if (user) { $('logout').hidden = false; throw new Error('此账号没有管理员权限，请使用已配置的管理员邮箱登录。'); }
      return;
    }
    state.admin = user;
    $('admin-email').textContent = user.email;
    $('logout').hidden = false; $('login-panel').hidden = true; $('workspace').hidden = false;
    $('login-code').value = '';
    await switchTab(state.tab);
  }
  $('send-code').addEventListener('click', () => run($('send-code'), async () => {
    if (!$('login-email').reportValidity()) return;
    const result = await api('send-code', { email: $('login-email').value.trim(), client: 'admin' });
    tell('验证码已发送，请检查邮箱和垃圾邮件。', 'success');
    let remaining = Math.max(1, Number(result.retryAfterSeconds || result.cooldownSeconds || 60));
    clearInterval(sendTimer);
    const tick = () => { const waiting = remaining > 0; $('send-code').textContent = waiting ? `${remaining} 秒后重发` : '发送验证码'; $('send-code').disabled = waiting; $('send-code').dataset.cooling = String(waiting); remaining -= 1; if (!waiting) clearInterval(sendTimer); };
    tick(); sendTimer = setInterval(tick, 1000);
    $('login-code').focus();
  }));
  $('login-form').addEventListener('submit', (event) => { event.preventDefault(); run($('login-submit'), async () => {
    if (!$('login-form').reportValidity()) return;
    clearNotice();
    await api('verify-code', { email: $('login-email').value.trim(), code: $('login-code').value.trim(), client: 'admin' });
    await loadSession();
  }); });
  $('logout').addEventListener('click', () => run($('logout'), async () => {
    if (state.mutating || state.pendingMutation) throw new Error('请先等待或重试尚未确认的管理操作，再退出登录。');
    if (state.generated.length && !state.generatedSaved && !await confirmAction('退出前保存激活码', '退出后将清除本次激活码原文。请确认已经复制或导出。', { reasonRequired: false, confirm: '已保存，退出' })) return;
    await api('logout'); resetSession(); tell('已退出，并撤销当前管理会话。', 'success');
  }));
  const tabs = Array.from(document.querySelectorAll('[data-tab]'));
  async function switchTab(name) {
    state.tab = name;
    tabs.forEach((tab) => { const active = tab.dataset.tab === name; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; $(`panel-${tab.dataset.tab}`).hidden = !active; });
    if (!state.loaded.has(name)) await ({ users: loadUsers, orders: loadCommerce, codes: loadCodes, audit: loadAudit, status: loadStatus, feedback: loadFeedback, 'update-proxy': loadUpdateProxyConfig })[name]();
    if (name === 'codes' && !issue.recipients.length) await findRecipients();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => run(tab, () => switchTab(tab.dataset.tab)));
    tab.addEventListener('keydown', (event) => {
      const position = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (position === null) return;
      event.preventDefault(); tabs[position].focus(); run(null, () => switchTab(tabs[position].dataset.tab));
    });
  });
  async function loadUsers() {
    const data = await api('admin-users', { query: $('user-query').value.trim() });
    state.users = data.users || []; state.total.users = data.total || state.users.length; state.pages.users = 0; state.loaded.add('users');
    renderUsers();
  }
  function renderUsers() {
    $('users-count').textContent = `${state.total.users} 位`;
    const visible = pageItems('users', state.users, renderUsers);
    $('users-list').replaceChildren();
    if (!visible.length) return empty($('users-list'), '没有找到匹配用户。');
    visible.forEach((user) => {
      const item = el('button', 'user-item'); item.type = 'button';
      item.setAttribute('aria-current', String(state.selectedId === user.id));
      item.append(el('strong', '', user.email), membershipBadge(user.membership), el('span', 'small-text', user.id));
      item.addEventListener('click', () => run(item, () => loadUser(user.id)));
      $('users-list').append(item);
    });
  }
  async function loadUser(id) {
    const request = ++userRequest;
    const result = await api('admin-user', { userId: id });
    if (request !== userRequest || !state.admin) return;
    state.selectedId = id; state.user = result.user; state.history = result.history || []; state.pendingDevices = result.pendingDevices || [];
    renderUsers(); renderUser();
  }
  function renderUser() {
    const user = state.user; const membership = user.membership || {};
    const content = $('user-detail'); content.replaceChildren();
    const identity = el('div', 'detail-identity');
    const text = el('div'); text.append(el('h2', '', user.email), el('span', 'small-text', `用户 ID：${user.id}`));
    identity.append(text, membershipBadge(membership)); content.append(identity);
    content.append(facts([['注册时间', fmt(user.createdAt)], ['账号角色', user.role === 'admin' ? '管理员' : '普通用户'], ['会员生效时间', fmt(membership.startsAt)], ['会员到期时间', membership.type === 'permanent' ? '永久有效' : fmt(membership.expiresAt)], ['已绑定设备', `${(user.devices || []).filter((d) => d.status === 'active').length} 台`], ['状态校验时间', fmt(state.serverTime)]]));
    const issueShortcut = el('div', 'issue-shortcut');
    const issueDescription = el('div'); issueDescription.append(el('h3', '', '付款后发放激活码'), el('p', 'field-help', '选择套餐，生成后直接发送至此账号邮箱，由客户自行兑换。'));
    issueShortcut.append(issueDescription, button('为此邮箱发码', 'button-secondary', async () => {
      issue.searchRequest += 1;
      if (!issue.recipients.some((item) => item.id === user.id)) issue.recipients.unshift(user);
      renderRecipients(user.id); $('issue-query').value = user.email;
      await switchTab('codes'); $('email-issue-panel').scrollIntoView({ block: 'start' }); $('issue-plan').focus();
    }));
    content.append(issueShortcut);
    content.append(membershipForm(user));
    const devices = el('section', 'detail-section'); devices.append(el('h3', '', '绑定设备'));
    devices.append(el('p', 'field-help', '解绑后，旧设备授权立即撤销，持续登录或刷新不会自动占回名额。换机后请重新验证邮箱；同一台电脑重装或丢失凭据时，可在下方单独授权新的设备密钥。'));
    if (!(user.devices || []).length) devices.append(el('p', 'empty-inline', '尚无绑定设备。'));
    else devices.append(table(['设备', '状态', '首次绑定', '最近校验', '管理'], user.devices.map((device) => {
      const control = device.status === 'active' ? button('解绑', 'button-danger button-small', async () => {
        const reason = await confirmAction('解绑设备', `账号：${user.email}\n设备：${device.name || device.id}\n\n解绑将撤销此设备的授权，不会退出账号或删除下载文件。`, { danger: true, confirm: '确认解绑' });
        if (!reason) return;
        await mutate('admin-unbind', { userId: user.id, deviceId: device.id, reason });
        tell('设备已解绑，旧授权已撤销。', 'success'); await refreshUserAfterChange(user.id);
      }) : el('span', 'small-text', `解绑于 ${fmt(device.revokedAt)}`);
      return [record(device.name || '未命名设备', `${platformName(device.platform)} · ${device.id}`), badge(device.status === 'active' ? '已绑定' : '已撤销', device.status === 'active' ? '' : 'badge-muted'), fmt(device.boundAt), fmt(device.lastCheckedAt), control];
    }), 'device-table'));
    content.append(devices);
    content.append(pendingDeviceSection(user));
    const history = el('section', 'detail-section'); history.append(el('h3', '', '会员与设备变更历史'));
    if (!state.history.length) history.append(el('p', 'empty-inline', '暂无变更记录。'));
    else {
      const list = el('ol', 'history-list');
      state.history.slice(0, 100).forEach((entry) => { const item = el('li', 'history-item'); item.append(el('strong', '', actionLabel(entry.action)), el('span', 'small-text', `${fmt(entry.at)} · ${entry.actorEmail || entry.actorId || '系统'} · ${entry.reason || '—'}`), changeDetails(entry.before, entry.after)); list.append(item); });
      history.append(list);
      if (state.history.length > 100) history.append(el('p', 'field-help', '这里显示最近 100 条，完整记录请查看操作日志。'));
    }
    content.append(history);
  }
  function pendingDeviceSection(user) {
    const section = el('section', 'detail-section pending-device-section');
    section.append(el('h3', '', '重装 / 凭据丢失后的设备授权'));
    section.append(el('p', 'field-help', '用户需先在待授权的客户端重新验证邮箱，并保持该客户端登录。核对下方设备与登录时间；名额已满时，先解绑旧设备。每次仅授权选中的新密钥，已撤销的旧设备及旧密钥保持失效。'));
    const items = state.pendingDevices;
    if (!items.length) { section.append(el('p', 'empty-inline', '暂无可恢复的新密钥设备。用户重新验证邮箱后，点击“刷新”检查。')); return section; }
    const result = el('div', 'pending-device-results'); const navigation = el('div', 'pagination');
    let page = 0;
    function render() {
      const selected = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      result.replaceChildren(table(['待授权设备', '验证邮箱时间 / 请求编号', '状态', '管理'], selected.map((device) => {
        const authorize = button('授权此新密钥设备', 'button-secondary button-small', async () => {
          const reason = await confirmAction('授权此新密钥设备', `账号：${user.email}\n设备：${device.name || '未命名设备'}（${platformName(device.platform)}）\n验证邮箱时间：${fmt(device.createdAt)}\n请求编号：${device.sessionId}\n\n请确认这就是用户要求恢复的客户端。此操作仅授权所选的新密钥；已撤销的旧设备及旧密钥保持失效。名额已满时须先解绑旧设备。`, { confirm: '确认授权新密钥' });
          if (!reason) return;
          await mutate('admin-restore-device', { userId: user.id, sessionId: device.sessionId, reason });
          tell('已授权所选新密钥设备。用户可在对应客户端刷新授权；已撤销的旧设备与旧密钥未恢复。', 'success');
          await refreshUserAfterChange(user.id);
        });
        return [record(device.name || '未命名设备', platformName(device.platform)), record(fmt(device.createdAt), device.sessionId), badge(device.status === 'device_limit' ? '等待设备名额' : '新密钥待确认', 'badge-gold'), authorize];
      }), 'pending-device-table'));
      navigation.replaceChildren();
      if (items.length > PAGE_SIZE) {
        const previous = button('上一页', 'button-secondary button-small', () => { page -= 1; render(); }); previous.disabled = page === 0;
        const next = button('下一页', 'button-secondary button-small', () => { page += 1; render(); }); next.disabled = (page + 1) * PAGE_SIZE >= items.length;
        navigation.append(previous, el('span', '', `${page + 1} / ${Math.ceil(items.length / PAGE_SIZE)} · ${items.length} 条`), next);
      }
    }
    render(); section.append(result, navigation); return section;
  }
  function inputLabel(title, input, className) { const label = el('label', className, title); label.append(input); return label; }
  function membershipForm(user) {
    const section = el('section'); section.append(el('h3', '', '调整会员权益'));
    const form = el('form', 'membership-form');
    const operation = el('select'); operation.id = 'membership-operation';
    [['days', '开通 / 续期指定天数'], ['permanent', '开通永久会员'], ['until', '设置准确到期时间'], ['adjust', '延长 / 缩短现有会员'], ['cancel', '取消会员权益']].forEach(([value, text]) => { const option = el('option', '', text); option.value = value; operation.append(option); });
    const days = el('input'); days.id = 'membership-days'; days.type = 'number'; days.step = '1'; days.min = '1'; days.max = '36500'; days.value = '30'; days.required = true;
    const dayField = inputLabel('会员天数', days);
    const until = el('input'); until.id = 'membership-until'; until.type = 'datetime-local'; until.step = '60';
    const untilField = inputLabel('到期时间（本机时区）', until); untilField.hidden = true;
    const reason = el('textarea'); reason.id = 'membership-reason'; reason.rows = 2; reason.required = true; reason.minLength = 3; reason.maxLength = 500; reason.placeholder = '记录本次操作原因';
    const help = el('p', 'field-help wide-field', '续期从服务器当前时间与已有到期时间的较晚者计算。所有权益以服务器校验结果为准。');
    const submit = el('button', 'button', '预览并确认变更'); submit.type = 'submit';
    form.append(inputLabel('操作类型', operation), dayField, untilField, help, inputLabel('操作原因', reason, 'wide-field'), submit);
    operation.addEventListener('change', () => {
      const needsDays = ['days', 'adjust'].includes(operation.value);
      dayField.hidden = !needsDays; days.required = needsDays; days.disabled = !needsDays; days.min = operation.value === 'adjust' ? '-36500' : '1';
      dayField.firstChild.textContent = operation.value === 'adjust' ? '调整天数（负数为缩短）' : '会员天数';
      untilField.hidden = operation.value !== 'until'; until.required = !untilField.hidden; until.disabled = untilField.hidden;
      if (operation.value === 'days' && Number(days.value) < 1) days.value = '30';
      help.textContent = operation.value === 'adjust' ? '基于当前会员到期时间调整：正数延长，负数缩短；永久会员请使用设置到期时间或取消。' : operation.value === 'until' ? '输入本机时区的准确到期时间。设置更早的时间会缩短权益；可将永久会员改为有效期会员。' : operation.value === 'cancel' ? '将取消所有会员权益，账号登录、已有任务记录和下载文件保持不变。' : '续期从服务器当前时间与已有到期时间的较晚者计算。所有权益以服务器校验结果为准。';
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); run(submit, async () => {
      if (!form.reportValidity()) return;
      const input = { userId: user.id, operation: operation.value, reason: reason.value.trim() };
      if (input.reason.length < 3) throw new Error('请填写至少 3 个字符的操作原因。');
      if (['days', 'adjust'].includes(input.operation)) { input.days = Number(days.value); if (!input.days) throw new Error('调整天数不能为 0。'); }
      if (input.operation === 'until') input.expiresAt = new Date(until.value).toISOString();
      const detail = input.days ? `${input.days > 0 ? '+' : ''}${input.days} 天` : input.expiresAt ? fmt(input.expiresAt) : '';
      const approved = await confirmAction('确认会员变更', `账号：${user.email}\n操作：${operation.selectedOptions[0].textContent} ${detail}\n原因：${input.reason}`, { reasonRequired: false, danger: input.operation === 'cancel' || input.operation === 'until' || input.days < 0, confirm: '确认修改权益' });
      if (!approved) return;
      await mutate('admin-membership', input); tell('会员权益已更新，用户刷新授权后即可生效。', 'success'); await refreshUserAfterChange(user.id);
    }); });
    section.append(form); return section;
  }
  async function refreshUserAfterChange(id) { state.loaded.delete('audit'); await loadUser(id); await loadUsers(); }
  $('search-form').addEventListener('submit', (event) => { event.preventDefault(); run(event.submitter, loadUsers); });
  $('refresh-users').addEventListener('click', () => run($('refresh-users'), async () => { await loadUsers(); if (state.selectedId) await loadUser(state.selectedId); }));
  function renderRecipients(selected = $('issue-recipient').value) {
    const placeholder = el('option', '', issue.recipients.length ? '请选择已注册的客户邮箱' : '未找到用户，请查找邮箱'); placeholder.value = '';
    $('issue-recipient').replaceChildren(placeholder);
    issue.recipients.forEach((user) => { const option = el('option', '', user.email); option.value = user.id; $('issue-recipient').append(option); });
    $('issue-recipient').value = issue.recipients.some((user) => user.id === selected) ? selected : '';
  }
  async function findRecipients() {
    const request = ++issue.searchRequest;
    const result = await api('admin-users', { query: $('issue-query').value.trim() });
    if (request !== issue.searchRequest || !state.admin) return;
    const selected = $('issue-recipient').value;
    issue.recipients = result.users || [];
    renderRecipients(issue.recipients.length === 1 ? issue.recipients[0].id : selected);
    if (!issue.recipients.length) tell('未找到此邮箱，请让客户先在客户端完成邮箱登录，再查找发码。', 'info');
  }
  MEMBERSHIP_PLANS.forEach((plan) => { const option = el('option', '', `${plan.name} · ¥${plan.priceLabel} · ${plan.days} 天`); option.value = plan.id; $('issue-plan').append(option); });
  $('issue-plan').value = 'monthly';
  function updateIssuePlan() {
    const plan = MEMBERSHIP_PLANS.find((item) => item.id === $('issue-plan').value);
    $('issue-plan-help').textContent = `${plan.name}会员有效期 ${plan.days} 天，从兑换时开始计算；已有有效期会员会顺延。兑换截止时间仅限制可兑换的最后时间，留空表示不限制。`;
  }
  updateIssuePlan();
  $('issue-plan').addEventListener('change', updateIssuePlan);
  $('issue-search-form').addEventListener('submit', (event) => { event.preventDefault(); run(event.submitter, findRecipients); });
  function deliveryStatus(code) {
    return ({ sending: '发送结果待确认', sent: '已提交邮件服务', failed: '发送失败，可重试' })[code.delivery?.status] || '尚未发送';
  }
  function issuePlanText(code) {
    const plan = MEMBERSHIP_PLANS.find((item) => item.id === code.planId);
    return plan ? `${plan.name} · ¥${plan.priceLabel}` : code.planName || '指定时长会员';
  }
  function showIssueCode(code, reason = '') {
    issue.code = code; issue.reason = reason || '会员开通，发送激活码至所选客户邮箱';
    renderIssuePreview();
  }
  function renderIssuePreview() {
    const panel = $('issue-preview'); panel.replaceChildren();
    const code = issue.code;
    if (!code) {
      const emptyPreview = el('div', 'issue-empty'); emptyPreview.append(el('span', 'eyebrow', 'NEXT · SEND'), el('h3', '', '生成后，在这里确认并发送'), el('p', 'muted', '收件邮箱、套餐、有效期与激活码会一起显示。邮件发送结果也会保留在下方记录中。'));
      panel.append(emptyPreview); return;
    }
    const heading = el('div', 'panel-heading'); heading.append(el('h3', '', '发放详情'), badge(deliveryStatus(code), code.delivery?.status === 'failed' ? 'badge-danger' : 'badge-gold'));
    panel.append(heading, facts([['收件邮箱', code.recipientEmail], ['套餐 / 价格', issuePlanText(code)], ['会员有效期', `${code.days} 天 · 兑换后开始`], ['兑换截止', code.redeemBy ? fmt(code.redeemBy) : '不限制'], ['创建时间', fmt(code.createdAt)], ['邮件提交时间', fmt(code.delivery?.sentAt)]], 'issue-facts'));
    if (code.code) { const raw = el('textarea'); raw.id = 'issue-code'; raw.readOnly = true; raw.rows = 2; raw.spellcheck = false; raw.value = code.code; panel.append(inputLabel('本次生成的激活码', raw)); }
    else panel.append(el('p', 'field-help', '原码已从页面清除，仍可发送此记录对应的激活码，不会重复生成。'));
    panel.append(el('p', 'small-text issue-record', `记录 ID：${code.id}`));
    const sent = code.delivery?.status === 'sent';
    const active = codeState(code) === 'unused';
    const submit = button(sent ? '已发送至客户邮箱' : code.delivery ? '重试发送同一激活码' : '发送激活码至客户邮箱', '', async () => {
      if (issue.code?.id !== code.id) return;
      let result;
      try { result = await mutate('admin-send-activation', { codeId: code.id, reason: issue.reason }); }
      catch (error) { if (state.admin) await loadCodes().catch(() => {}); throw error; }
      displaySent(result); state.loaded.delete('audit'); await loadCodes();
    });
    submit.id = 'issue-send'; submit.disabled = sent || !active;
    const actions = el('div', 'button-row'); actions.append(submit); panel.append(actions);
    const help = el('p', 'field-help'); help.textContent = sent ? '邮件已提交给邮件服务，请客户检查收件箱与垃圾邮件；实际到达以客户邮箱为准。' : active ? '邮件包含激活码、套餐、会员有效期和兑换说明。点击发送即发往上方邮箱。' : '此激活码已兑换、作废或超过兑换期限，无法继续发送。'; panel.append(help);
  }
  function displayIssued(result, input) {
    const code = result.codes?.[0];
    if (!code) throw new Error('未返回激活码记录，请刷新记录核对后再继续。');
    showIssueCode(code, input.reason);
    tell(result.replayed ? '已找回本次生成的记录，未重复生成。可直接将同一激活码发送至客户邮箱。' : '激活码已生成。请核对右侧收件邮箱、套餐和有效期，然后点击发送。', 'success');
  }
  function displaySent(result) {
    const code = result.code;
    if (code) {
      const raw = issue.code?.id === code.id ? issue.code.code : null;
      showIssueCode({ ...code, ...(raw ? { code: raw } : {}) }, issue.reason);
    }
    tell(result.message || '激活码邮件已提交发送，请客户检查收件箱和垃圾邮件。', 'success');
  }
  $('issue-form').addEventListener('submit', (event) => { event.preventDefault(); run(event.submitter, async () => {
    if (!$('issue-form').reportValidity()) return;
    const input = { userId: $('issue-recipient').value, planId: $('issue-plan').value, count: 1, reason: $('issue-reason').value.trim() };
    if (input.reason.length < 3) throw new Error('请填写至少 3 个字符的操作原因。');
    if ($('issue-deadline').value) input.redeemBy = new Date($('issue-deadline').value).toISOString();
    const result = await mutate('admin-generate-codes', input);
    displayIssued(result, input); state.loaded.delete('audit'); await loadCodes();
  }); });
  async function loadCodes() {
    const data = await api('admin-codes', { query: $('code-query').value.trim(), status: $('code-status').value }); state.codes = data.codes || []; state.total.codes = data.total || state.codes.length; state.pages.codes = 0; state.loaded.add('codes'); renderCodes();
    const updated = state.codes.find((code) => code.id === issue.code?.id);
    if (updated) { issue.code = { ...issue.code, ...updated }; renderIssuePreview(); }
  }
  function codeState(code) {
    if (code.status === 'unused' && code.redeemBy && state.serverTime && Date.parse(code.redeemBy) <= Date.parse(state.serverTime)) return 'expired';
    return code.status;
  }
  function renderCodes() {
    const query = $('code-query').value.trim().toLowerCase(); const filter = $('code-status').value;
    const matching = state.codes.filter((code) => (!filter || codeState(code) === filter) && (!query || [code.id, code.recipientEmail, code.redeemedBy, code.redeemedEmail].some((value) => String(value || '').toLowerCase().includes(query))));
    const visible = pageItems('codes', matching, renderCodes);
    if (!visible.length) { empty($('codes-list'), '没有符合条件的激活码。'); return; }
    const labels = { unused: '待兑换', used: '已兑换', void: '已作废', expired: '已过兑换期限' };
    const rows = visible.map((code) => {
      const status = codeState(code);
      const control = el('div', 'button-row code-actions');
      if (code.recipientEmail) control.append(button(code.delivery?.status === 'sent' ? '查看发放详情' : code.delivery ? '查看 / 重试发送' : '查看 / 发送', 'button-secondary button-small', () => {
        showIssueCode({ ...code, ...(issue.code?.id === code.id && issue.code.code ? { code: issue.code.code } : {}) });
        $('email-issue-panel').scrollIntoView({ block: 'start' }); $('issue-send').focus();
      }));
      if (code.status === 'unused') control.append(button('作废', 'button-danger button-small', async () => {
        const reason = await confirmAction('作废激活码', `记录：${code.id}\n权益：${code.type === 'permanent' ? '永久会员' : `${code.days} 天会员`}\n\n作废后无法兑换，已使用的激活码不能恢复为未使用。`, { danger: true, confirm: '确认作废' });
        if (!reason) return;
        await mutate('admin-void-code', { codeId: code.id, reason }); tell('激活码已作废。', 'success'); state.loaded.delete('audit'); await loadCodes();
      }));
      if (!control.childElementCount) control.append(el('span', 'small-text', '—'));
      return [record(code.id, `创建于 ${fmt(code.createdAt)}`), record(code.planId ? `${issuePlanText(code)} · ${code.days} 天` : code.type === 'permanent' ? '永久会员' : `${code.days} 天会员`, `兑换截止：${code.redeemBy ? fmt(code.redeemBy) : '不限制'}`), record(code.recipientEmail || '未指定邮箱', code.recipientEmail ? deliveryStatus(code) : '手动发放'), badge(labels[status] || status, status === 'used' ? '' : status === 'unused' ? 'badge-gold' : 'badge-muted'), record(code.redeemedEmail || code.redeemedBy || '—', code.redeemedAt ? fmt(code.redeemedAt) : ''), control];
    });
    $('codes-list').replaceChildren(table(['记录 / 创建时间', '套餐 / 有效期', '收件邮箱 / 发送状态', '兑换状态', '兑换账号 / 时间', '管理'], rows, 'codes-table'));
    if (state.total.codes > state.codes.length) $('codes-list').append(el('p', 'field-help', `共 ${state.total.codes} 条记录，本页筛选范围为最近 ${state.codes.length} 条。`));
  }
  $('refresh-codes').addEventListener('click', () => run($('refresh-codes'), loadCodes));
  $('codes-filter-form').addEventListener('submit', (event) => { event.preventDefault(); run(event.submitter, loadCodes); });
  $('code-type').addEventListener('change', () => {
    const duration = $('code-type').value === 'duration'; $('code-days-field').hidden = !duration; $('code-days').disabled = !duration; $('code-days').required = duration;
  });
  function clearGenerated() { state.generated = []; state.generatedSaved = false; $('generated-panel').hidden = true; $('generated-raw').value = ''; $('generated-summary').textContent = ''; }
  function displayGenerated(result, input = {}) {
    if (input.userId) return displayIssued(result, input);
    const codes = result.codes || [];
    state.generated = codes.filter((code) => typeof code.code === 'string' && code.code); state.generatedSaved = false;
    $('generated-panel').hidden = !state.generated.length;
    $('generated-raw').value = state.generated.map((code) => code.code).join('\n');
    $('generated-summary').textContent = `成功生成 ${state.generated.length} 个。原码只保留在当前页面内存中，离开或刷新页面后无法再次获取。`;
    if (result.replayed || !state.generated.length) {
      tell('这批激活码已在之前的请求中生成，本次没有重复生成。原码无法重复查看；如首次响应丢失，请核对并作废该批未使用记录后再生成。', 'info');
      const details = el('details'); details.append(el('summary', '', `查看本批 ${codes.length} 个记录 ID`), el('pre', '', codes.map((code) => code.id).join('\n'))); $('notice').append(details);
    }
    else tell(`已生成 ${state.generated.length} 个激活码，请立即复制或导出保存。`, 'success');
  }
  $('generate-form').addEventListener('submit', (event) => { event.preventDefault(); run(event.submitter, async () => {
    if (!$('generate-form').reportValidity()) return;
    if (state.generated.length && !state.generatedSaved && !await confirmAction('保存上一批激活码', '继续生成会替换页面上的原码，请先确认上一批已经复制或导出。', { reasonRequired: false, confirm: '已保存，继续生成' })) return;
    const input = { type: $('code-type').value, count: Number($('code-count').value), reason: $('code-reason').value.trim() };
    if (input.reason.length < 3) throw new Error('请填写至少 3 个字符的操作原因。');
    if (input.type === 'duration') input.days = Number($('code-days').value);
    if ($('code-deadline').value) input.redeemBy = new Date($('code-deadline').value).toISOString();
    const result = await mutate('admin-generate-codes', input); displayGenerated(result); state.loaded.delete('audit'); await loadCodes();
  }); });
  $('copy-codes').addEventListener('click', () => run($('copy-codes'), async () => {
    if (!state.generated.length) return;
    try { await navigator.clipboard.writeText(state.generated.map((code) => code.code).join('\n')); state.generatedSaved = true; tell('已复制，请保存到安全的位置。', 'success'); }
    catch { $('generated-raw').focus(); $('generated-raw').select(); throw new Error('浏览器未允许写入剪贴板，已选中激活码，请手动复制。'); }
  }));
  const csv = (value) => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  $('export-codes').addEventListener('click', () => run($('export-codes'), async () => {
    if (!state.generated.length) return;
    const rows = [['激活码', '记录 ID', '会员类型', '天数', '兑换截止时间', '创建时间'], ...state.generated.map((code) => [code.code, code.id, code.type === 'permanent' ? '永久会员' : '有效期会员', code.days || '', code.redeemBy || '', code.createdAt || ''])];
    const blob = new Blob(['\uFEFF', rows.map((row) => row.map(csv).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = el('a'); link.href = url; link.download = `brclio-activation-codes-${new Date().toISOString().slice(0, 10)}.csv`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    state.generatedSaved = true; tell('已发起 CSV 下载，请确认文件已保存；其中包含可用的原始激活码。', 'success');
  }));
  $('dismiss-codes').addEventListener('click', () => run($('dismiss-codes'), async () => {
    if (!await confirmAction('清除激活码原文', '清除后无法再次查看原码。请确认本次生成结果已经安全保存。', { reasonRequired: false, confirm: '已保存，清除' })) return;
    clearGenerated(); tell('已清除页面中的原码，激活码记录仍可查询。', 'success');
  }));
  const feedbackStatus = (value) => ({ uploading: '日志未上传完成', new: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' })[value] || value;
  const feedbackCategory = value => ({ download: '下载问题', audio: '视频声音', update: '安装更新', account: '账号会员', other: '其他问题' })[value] || '其他问题';
  const bytesLabel = (value) => Number(value || 0) >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(2)} MiB` : `${Math.ceil(Number(value || 0) / 1024)} KiB`;
  async function loadFeedback() {
    const epoch = feedbackSessionEpoch;
    const result = await api('admin-feedback', { query: $('feedback-query').value.trim(), status: $('feedback-status-filter').value });
    if (epoch !== feedbackSessionEpoch || !state.admin) return;
    state.feedback = result.feedbacks || []; state.total.feedback = result.total || state.feedback.length;
    state.pages.feedback = 0; state.loaded.add('feedback'); renderFeedbackList();
  }
  function renderFeedbackList() {
    $('feedback-count').textContent = `${state.total.feedback || 0} 条`;
    const visible = pageItems('feedback', state.feedback, renderFeedbackList), list = $('feedback-list');
    list.replaceChildren();
    if (!visible.length) return empty(list, '没有符合条件的反馈。');
    for (const feedback of visible) {
      const item = button('', 'feedback-list-item', () => selectFeedback(feedback.id));
      item.className = 'user-item feedback-list-item';
      item.setAttribute('aria-current', String(state.selectedFeedback === feedback.id));
      item.append(el('strong', '', feedback.title), badge(feedbackStatus(feedback.status), feedback.status === 'uploading' ? 'badge-danger' : feedback.status === 'resolved' ? 'badge-gold' : ''), el('span', 'small-text', `${feedback.email} · ${fmt(feedback.createdAt)}`));
      if (feedback.replyCount) item.append(el('span', 'small-text feedback-reply-summary', `${feedback.replyCount} 条回复 · ${feedback.lastMessageRole === 'admin' ? '管理员' : '用户'} ${fmt(feedback.lastMessageAt)}`));
      list.append(item);
    }
  }
  async function selectFeedback(id) {
    const request = ++feedbackRequest, epoch = feedbackSessionEpoch;
    if (state.selectedFeedback !== id) {
      state.feedbackLog = null; state.feedbackDetail = null; state.feedbackHistory = []; state.feedbackMessages = [];
      state.selectedFeedback = id; renderFeedbackList(); empty($('feedback-detail'), '正在读取反馈与对话…');
    }
    let result;
    try { result = await api('admin-feedback-detail', { feedbackId: id }); }
    catch (error) { if (request !== feedbackRequest || epoch !== feedbackSessionEpoch || !state.admin) return; throw error; }
    if (request !== feedbackRequest || epoch !== feedbackSessionEpoch || !state.admin) return;
    state.selectedFeedback = id; state.feedbackDetail = result.feedback; state.feedbackHistory = result.history || []; state.feedbackMessages = result.messages || [];
    renderFeedbackList(); renderFeedbackDetail();
  }
  function feedbackDraft(id) {
    if (!state.feedbackDrafts.has(id)) state.feedbackDrafts.set(id, { content: '', sending: false });
    return state.feedbackDrafts.get(id);
  }
  async function finishFeedbackReply(input, result) {
    const epoch = feedbackSessionEpoch, draft = feedbackDraft(input.feedbackId);
    if (draft.content === input.content) draft.content = '';
    draft.sending = false;
    state.loaded.delete('audit');
    if (state.selectedFeedback === input.feedbackId && state.feedbackDetail?.id === input.feedbackId) {
      // Show the confirmed message immediately, even if a subsequent refresh fails.
      state.feedbackDetail = result.feedback;
      if (result.message && !state.feedbackMessages.some(message => message.id === result.message.id)) state.feedbackMessages.push(result.message);
      renderFeedbackDetail();
    }
    tell('回复已发送，用户可以在自己的反馈中查看并继续回复。', 'success');
    try {
      await loadFeedback();
      if (epoch === feedbackSessionEpoch && state.admin && state.selectedFeedback === input.feedbackId) await selectFeedback(input.feedbackId);
    } catch {
      if (epoch === feedbackSessionEpoch && state.admin) tell('回复已发送；最新对话暂未刷新，请点击“刷新反馈”查看。', 'success');
    }
  }
  function renderFeedbackConversation(feedback, messages) {
    const section = el('section', 'detail-section feedback-conversation');
    section.append(el('h3', '', '对话记录'), el('p', 'field-help', '回复会显示在提交用户的反馈中，双方可以继续补充。'));
    const list = el('ol', 'feedback-messages'); list.setAttribute('aria-label', '反馈对话记录'); list.setAttribute('aria-live', 'polite');
    for (const message of messages) {
      const item = el('li', `feedback-message feedback-message-${message.authorRole === 'admin' ? 'admin' : 'user'}`);
      const meta = el('div', 'feedback-message-meta'), time = el('time', '', fmt(message.createdAt)); time.dateTime = message.createdAt;
      meta.append(el('strong', '', message.authorRole === 'admin' ? '管理员回复' : '用户回复'), time);
      item.append(meta, el('p', 'feedback-message-content', message.content)); list.append(item);
    }
    section.append(messages.length ? list : el('p', 'empty-inline', '暂无回复。可以在下方直接回复用户。'));
    const draft = feedbackDraft(feedback.id), form = el('form', 'feedback-reply-form'), label = el('label', '', '回复用户'), input = el('textarea');
    input.id = 'feedback-reply-content'; input.name = 'content'; input.rows = 5; input.maxLength = 8000; input.required = true;
    input.placeholder = '填写处理建议，或请用户补充问题细节'; input.value = draft.content; input.disabled = !feedback.submittedAt || draft.sending;
    input.addEventListener('input', () => { draft.content = input.value; }); label.append(input);
    const send = el('button', 'button', draft.sending ? '正在发送…' : '发送回复'); send.type = 'submit'; send.disabled = !feedback.submittedAt || draft.sending;
    const help = el('p', 'field-help', feedback.submittedAt ? '最多 8,000 字。发送失败会保留草稿；重试相同内容不会重复发送。' : '请等待用户完成反馈提交后再回复。');
    form.append(label, help, send);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity() || draft.sending) return;
      draft.content = input.value;
      if (!draft.content.trim()) { input.setCustomValidity('请填写回复内容。'); input.reportValidity(); input.setCustomValidity(''); return; }
      const payload = { feedbackId: feedback.id, content: draft.content }, epoch = feedbackSessionEpoch;
      run(send, async () => {
        draft.sending = true; input.disabled = true;
        try { const result = await mutate('admin-feedback-reply', payload); await finishFeedbackReply(payload, result); }
        finally {
          if (epoch === feedbackSessionEpoch && state.admin) {
            draft.sending = false; input.disabled = false;
            if (state.selectedFeedback === feedback.id && state.feedbackDetail?.id === feedback.id && $('feedback-reply-content') !== input) renderFeedbackDetail();
          }
        }
      });
    });
    section.append(form); return section;
  }
  async function sha256(content) {
    const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function readFeedbackLogs(feedback, progress) {
    if (!feedback.submittedAt || feedback.status === 'uploading') throw new Error('日志尚未完整提交，请等待客户端完成上传。');
    if (state.feedbackLog?.id === feedback.id) return state.feedbackLog.content;
    const epoch = feedbackSessionEpoch, parts = [];
    for (let index = 0; index < feedback.log.partCount; index += 1) {
      if (!state.admin || epoch !== feedbackSessionEpoch) throw new Error('管理会话已结束。');
      if (progress) progress.textContent = `正在读取完整日志 ${index + 1} / ${feedback.log.partCount}…`;
      const result = await api('admin-feedback-part', { feedbackId: feedback.id, index });
      if (!state.admin || epoch !== feedbackSessionEpoch) throw new Error('管理会话已结束。');
      const expected = feedback.log.parts[index], content = result.content;
      if (typeof content !== 'string' || new TextEncoder().encode(content).byteLength !== expected.bytes || await sha256(content) !== expected.sha256) throw new Error('日志分块完整性校验失败，未复制或下载。');
      parts.push(content);
    }
    const content = parts.join('');
    if (new TextEncoder().encode(content).byteLength !== feedback.log.totalBytes || await sha256(content) !== feedback.log.sha256) throw new Error('完整日志校验失败，未复制或下载。');
    if (!state.admin || epoch !== feedbackSessionEpoch) throw new Error('管理会话已结束。');
    if (state.selectedFeedback === feedback.id && epoch === feedbackSessionEpoch) state.feedbackLog = { id: feedback.id, content };
    if (progress) progress.textContent = `完整日志已校验 · ${bytesLabel(feedback.log.totalBytes)} · ${feedback.log.partCount} 个分块`;
    return content;
  }
  function feedbackReport(feedback, content, messages) {
    const conversation = messages.flatMap(message => ['', `${message.authorRole === 'admin' ? '管理员回复' : '用户回复'} · ${message.createdAt} · ${message.id}`, message.content]);
    return [`Brclio 小红书下载器 · 问题反馈`, `反馈编号：${feedback.id}`, `用户：${feedback.email} / ${feedback.userId}`, `标题：${feedback.title}`, `状态：${feedbackStatus(feedback.status)}`, `分类：${feedbackCategory(feedback.category)}`, `版本与系统：${feedback.appVersion} / ${platformName(feedback.platform)} ${feedback.arch || ''}`, `提交时间：${fmt(feedback.submittedAt)}`, `日志范围：${fmt(feedback.log.firstTimestamp)} 至 ${fmt(feedback.log.lastTimestamp)}`, `日志大小：${feedback.log.totalBytes} 字节`, `日志 SHA-256：${feedback.log.sha256}`, `较早日志已轮换：${feedback.log.truncated ? '是' : '否'}`, '', '问题说明', feedback.description, '', '对话记录', ...conversation, '', '完整脱敏日志（NDJSON）', content].join('\n');
  }
  function downloadFeedbackLog(feedback, content, extension) {
    const text = extension === 'txt' ? content.trimEnd().split('\n').map(line => { const item = JSON.parse(line); return `${item.at} [${item.level}] ${item.event}${item.message ? ` — ${item.message}` : ''}${item.details === undefined ? '' : `\n${JSON.stringify(item.details)}`}`; }).join('\n') + '\n' : content;
    const url = URL.createObjectURL(new Blob([text], { type: extension === 'txt' ? 'text/plain;charset=utf-8' : 'application/x-ndjson;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = `brclio-feedback-${feedback.id}.${extension}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderFeedbackDetail() {
    const feedback = state.feedbackDetail, messages = [...state.feedbackMessages], container = $('feedback-detail');
    container.replaceChildren(); if (!feedback) return;
    const heading = el('div', 'panel-heading'); heading.append(el('h2', '', feedback.title), badge(feedbackStatus(feedback.status), feedback.status === 'uploading' ? 'badge-danger' : ''));
    container.append(heading, facts([['提交账号', feedback.email], ['用户 ID', feedback.userId], ['反馈编号', feedback.id], ['问题分类', feedbackCategory(feedback.category)], ['版本 / 系统', `${feedback.appVersion} / ${platformName(feedback.platform)} ${feedback.arch || ''}`], ['创建时间', fmt(feedback.createdAt)], ['提交时间', fmt(feedback.submittedAt)]]));
    const description = el('section', 'detail-section'); description.append(el('h3', '', '问题说明'), el('p', 'feedback-description', feedback.description)); container.append(description);
    container.append(renderFeedbackConversation(feedback, messages));
    const logs = el('section', 'detail-section feedback-log-section'), progress = el('p', 'field-help');
    logs.append(el('h3', '', '完整使用日志'), facts([['保留范围', `${fmt(feedback.log.firstTimestamp)} 至 ${fmt(feedback.log.lastTimestamp)}`], ['日志大小', `${bytesLabel(feedback.log.totalBytes)} / ${feedback.log.partCount} 个分块`], ['较早日志', feedback.log.truncated ? '已按客户端保留上限轮换' : '本次保留范围未截断']]));
    const actions = el('div', 'button-row'), preview = el('pre', 'feedback-log-preview'); preview.hidden = true; preview.tabIndex = 0; preview.setAttribute('aria-label', '完整脱敏使用日志');
    const show = button('查看完整日志', 'button-secondary', async () => { const content = await readFeedbackLogs(feedback, progress); preview.textContent = content; preview.hidden = false; });
    const copy = button('复制反馈与完整日志', '', async () => {
      const content = await readFeedbackLogs(feedback, progress), report = feedbackReport(feedback, content, messages);
      try { await navigator.clipboard.writeText(report); tell('已复制问题说明、完整对话、账号、处理状态与完整脱敏日志。', 'success'); }
      catch { const fallback = el('textarea', 'feedback-copy-fallback'); fallback.readOnly = true; fallback.value = report; fallback.setAttribute('aria-label', '完整反馈报告，请手动复制'); logs.append(fallback); fallback.focus(); fallback.select(); throw new Error('浏览器未允许自动复制，已选中完整报告，请手动复制。'); }
    });
    const ndjson = button('下载日志 NDJSON', 'button-secondary', async () => downloadFeedbackLog(feedback, await readFeedbackLogs(feedback, progress), 'ndjson'));
    const txt = button('下载日志 TXT', 'button-quiet', async () => downloadFeedbackLog(feedback, await readFeedbackLogs(feedback, progress), 'txt'));
    for (const control of [show, copy, ndjson, txt]) { control.disabled = !feedback.submittedAt; actions.append(control); }
    progress.textContent = feedback.submittedAt ? '日志只通过管理员授权接口读取，读取后验证完整校验值。' : '客户端还没有上传完全部日志。这条反馈尚未提交成功。';
    logs.append(actions, progress, preview); container.append(logs);
    const management = el('section', 'detail-section'), form = el('form', 'feedback-status-form'), select = el('select'), label = el('label', '', '处理状态');
    for (const status of ['new', 'in_progress', 'resolved', 'closed']) { const option = el('option', '', feedbackStatus(status)); option.value = status; select.append(option); }
    select.value = feedback.status === 'uploading' ? 'new' : feedback.status; label.append(select);
    const save = el('button', 'button button-secondary', '更新处理状态'); save.type = 'submit'; save.disabled = !feedback.submittedAt; select.disabled = !feedback.submittedAt;
    form.append(label, save); form.addEventListener('submit', event => { event.preventDefault(); run(save, async () => {
      const reason = await confirmAction('更新反馈处理状态', `将“${feedback.title}”标记为“${feedbackStatus(select.value)}”，请输入处理说明。`);
      if (!reason) return;
      await mutate('admin-feedback-status', { feedbackId: feedback.id, status: select.value, reason });
      state.loaded.delete('audit'); await loadFeedback(); await selectFeedback(feedback.id); tell('反馈处理状态已保存，并记录操作说明。', 'success');
    }); });
    management.append(el('h3', '', '处理进度'), form);
    const statusHistory = state.feedbackHistory.filter(entry => entry.action === 'admin-feedback-status');
    if (statusHistory.length) management.append(table(['时间', '管理员', '处理说明'], statusHistory.map(entry => [fmt(entry.at), entry.actorEmail, `${feedbackStatus(entry.before?.status)} → ${feedbackStatus(entry.after?.status)}\n${entry.reason}`])));
    container.append(management);
  }
  $('feedback-filter-form').addEventListener('submit', event => { event.preventDefault(); run(event.submitter, loadFeedback); });
  $('refresh-feedback').addEventListener('click', () => run($('refresh-feedback'), async () => { await loadFeedback(); if (state.selectedFeedback) await selectFeedback(state.selectedFeedback); }));
  function actionLabel(action) { return ({ 'membership': '修改会员权益', 'membership-change': '修改会员权益', 'admin-membership': '修改会员权益', 'device-unbind': '解绑设备', 'admin-unbind': '解绑设备', 'admin-restore-device': '授权新密钥设备', 'codes-generate': '生成激活码', 'admin-generate-codes': '生成激活码', 'admin-send-activation': '邮件发放激活码', 'admin-send-activation-result': '激活码邮件发送结果', 'code-void': '作废激活码', 'admin-void-code': '作废激活码', 'code-redeem': '兑换激活码', redeem: '兑换激活码', 'admin-feedback-status': '更新反馈处理状态', 'admin-feedback-reply': '回复问题反馈', 'feedback-reply': '用户回复反馈', 'admin-save-update-proxy-config': '更新软件订阅配置', 'admin-record-order': '确认订单实际收款', 'admin-link-order-code': '关联订单激活码' })[action] || action || '操作记录'; }
  function renderUpdateProxyConfig(config) {
    updateProxyConfig = config;
    const unconfigured = config.revision === 0;
    $('update-proxy-enabled').checked = config.enabled;
    const urls = Array.isArray(config.subscriptionUrls) ? config.subscriptionUrls : config.subscriptionUrl ? [config.subscriptionUrl] : [];
    updateProxyDraft = urls.join('\n'); setUpdateProxyVisibility(false, false);
    $('update-proxy-state').textContent = unconfigured ? '尚未设置 · 直接连接' : config.enabled ? '已启用更新代理' : '已停用更新代理';
    $('update-proxy-state').className = `badge ${unconfigured || !config.enabled ? 'badge-muted' : ''}`;
    $('update-proxy-save-note').textContent = unconfigured ? '未配置时直接连接。保存并启用后生效。' : '下一次检查更新时生效。';
    $('update-proxy-meta').replaceChildren(facts([['配置版本', unconfigured ? '尚未保存' : `第 ${config.revision} 版`], ['订阅来源', `${urls.length} 个`], ['更新时间', fmt(config.updatedAt)]]));
    $('save-update-proxy').disabled = false;
  }
  async function loadUpdateProxyConfig() {
    const request = ++updateProxyRequest, epoch = feedbackSessionEpoch;
    const data = await api('admin-update-proxy-config');
    if (request !== updateProxyRequest || epoch !== feedbackSessionEpoch || !state.admin) return;
    renderUpdateProxyConfig(data.proxyConfig); state.loaded.add('update-proxy');
  }
  function finishUpdateProxySave(result) {
    renderUpdateProxyConfig(result.proxyConfig); $('update-proxy-reason').value = ''; state.loaded.delete('audit');
    tell(`更新网络配置已保存（第 ${result.proxyConfig.revision} 版）。客户端下一次检查更新时获取。`, 'success');
  }
  function setUpdateProxyVisibility(show, capture = true) {
    if (capture && updateProxyVisible) updateProxyDraft = $('update-proxy-url').value;
    updateProxyVisible = show; $('update-proxy-url').readOnly = !show;
    $('update-proxy-url').value = show ? updateProxyDraft : updateProxyDraft.split(/\r?\n/).filter(line => line.trim()).map(() => '••••••••••••••••••••••••').join('\n');
    $('show-update-proxy-url').textContent = show ? '隐藏' : '显示 / 编辑'; $('show-update-proxy-url').setAttribute('aria-pressed', String(show));
  }
  $('show-update-proxy-url').addEventListener('click', () => setUpdateProxyVisibility(!updateProxyVisible));
  $('refresh-update-proxy').addEventListener('click', () => run($('refresh-update-proxy'), loadUpdateProxyConfig));
  $('update-proxy-form').addEventListener('submit', event => {
    event.preventDefault(); run($('save-update-proxy'), async () => {
      if (!updateProxyConfig || !$('update-proxy-form').reportValidity()) return;
      const enabled = $('update-proxy-enabled').checked;
      if (updateProxyVisible) updateProxyDraft = $('update-proxy-url').value;
      const subscriptionUrls = [...new Set(updateProxyDraft.split(/\r?\n/).map(url => url.trim()).filter(Boolean))];
      if (enabled && !subscriptionUrls.length) { setUpdateProxyVisibility(true); $('update-proxy-url').focus(); throw new Error('启用更新代理时，请填写至少一个 HTTPS 订阅地址。'); }
      if (subscriptionUrls.length > 8) { setUpdateProxyVisibility(true); $('update-proxy-url').focus(); throw new Error('最多保存 8 个不同的订阅地址，每行一个。'); }
      const result = await mutate('admin-save-update-proxy-config', { enabled, subscriptionUrls, expectedRevision: updateProxyConfig.revision, reason: $('update-proxy-reason').value.trim() });
      finishUpdateProxySave(result);
    });
  });
  const paymentMethodLabels = { alipay: '支付宝', wechat: '微信支付', other: '其他' };
  function money(cents) { return Number.isSafeInteger(cents) ? `¥${(cents / 100).toFixed(2)}` : '未确认'; }
  function beijingTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  }
  function commerceDates(prefix) {
    const startDate = $(`${prefix}-start-date`).value;
    const endDate = $(`${prefix}-end-date`).value;
    if (startDate && endDate && startDate > endDate) throw new Error('开始日期不能晚于结束日期。');
    return { ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) };
  }
  async function loadCommerce() {
    const epoch = feedbackSessionEpoch;
    await Promise.all([loadOrders(1), loadRevenue()]);
    if (epoch === feedbackSessionEpoch && state.admin) state.loaded.add('orders');
  }
  async function loadOrders(page = commerce.page) {
    const input = { query: $('order-query').value.trim(), status: $('order-status').value, ...commerceDates('order'), page, pageSize: commerce.pageSize };
    const request = ++commerce.listRequest; const epoch = feedbackSessionEpoch;
    $('orders-list').setAttribute('aria-busy', 'true');
    try {
      const data = await api('admin-orders', input);
      if (request !== commerce.listRequest || epoch !== feedbackSessionEpoch || !state.admin) return;
      commerce.orders = data.orders || []; commerce.page = data.page || page; commerce.total = data.total || 0; commerce.totalPages = data.totalPages || 0;
      renderOrders();
    } finally { if (request === commerce.listRequest) $('orders-list').removeAttribute('aria-busy'); }
  }
  function renderOrders() {
    $('orders-count').textContent = `共 ${commerce.total} 笔`;
    $('orders-pagination').replaceChildren();
    const last = Math.max(1, commerce.totalPages);
    const previous = button('上一页', 'button-secondary button-small', () => loadOrders(commerce.page - 1)); previous.disabled = commerce.page <= 1;
    const next = button('下一页', 'button-secondary button-small', () => loadOrders(commerce.page + 1)); next.disabled = commerce.page >= last;
    const pageStatus = el('span', '', `第 ${commerce.page} / ${last} 页 · 每页 ${commerce.pageSize} 笔`);
    $('orders-pagination').append(previous, pageStatus, next);
    if (last > 1) {
      const jump = el('form', 'page-jump'); const label = el('label', '', '跳至'); const input = el('input');
      input.type = 'number'; input.min = '1'; input.max = String(last); input.step = '1'; input.value = String(commerce.page); input.required = true; input.setAttribute('aria-label', '跳转到订单页码'); label.append(input);
      const submit = button('前往', 'button-secondary button-small'); submit.type = 'submit';
      jump.append(label, submit); jump.addEventListener('submit', event => { event.preventDefault(); run(submit, () => { if (jump.reportValidity()) return loadOrders(Number(input.value)); }); });
      $('orders-pagination').append(jump);
    }
    if (!commerce.orders.length) return empty($('orders-list'), '没有匹配的订单。可调整筛选条件或录入已核实的收款。');
    const statusLabels = { confirmed: '已确认收款', pending: '待确认收款', legacy_unverified: '历史发码 · 未确认收款' };
    $('orders-list').replaceChildren(table(['订单 / 账号', '套餐 / 金额', '状态 / 日期（北京）', '收款凭证 / 激活码', '操作'], commerce.orders.map(order => {
      const identity = record(order.id, order.email || order.userId);
      identity.append(el('span', 'small-text', `创建：${beijingTime(order.createdAt)}`));
      const amount = record(order.planName || order.planId, `套餐标价 ${money(order.priceCents)}`);
      amount.append(el('strong', 'order-received', order.status === 'confirmed' ? `实收 ${money(order.amountCents)}` : '实收尚未确认'));
      const status = el('div'); status.append(badge(statusLabels[order.status] || order.status, order.status === 'confirmed' ? '' : 'badge-muted'), el('span', 'small-text', order.status === 'confirmed' ? `收款：${beijingTime(order.paidAt)}` : '未计入营业额'));
      if (order.confirmedAt) status.append(el('span', 'small-text', `确认：${beijingTime(order.confirmedAt)}`));
      const reference = record(order.paymentMethod ? paymentMethodLabels[order.paymentMethod] || order.paymentMethod : '待核对收款渠道', order.transactionReference ? `流水：${order.transactionReference}` : '未录入收款流水');
      if (order.codeId) reference.append(el('span', 'small-text', `激活码记录：${order.codeId}`));
      if (order.reason) { const details = el('details'); details.append(el('summary', '', '核对说明'), el('p', 'order-reason', order.reason)); reference.append(details); }
      const control = el('div', 'order-actions');
      if (order.status === 'confirmed') {
        control.append(el('span', 'small-text', '已确认，收款只读'));
        if (!order.codeId) control.append(button('关联激活码', 'button-secondary button-small', () => openOrderLink(order)));
        else control.append(el('span', 'small-text', '已关联激活码'));
      } else control.append(button('确认收款', 'button-secondary button-small', () => selectOrderRecord(order)));
      return [identity, amount, status, reference, control];
    }), 'orders-table'));
  }
  async function loadRevenue() {
    const dates = commerceDates('revenue'); const request = ++commerce.revenueRequest; const epoch = feedbackSessionEpoch;
    $('revenue-summary').setAttribute('aria-busy', 'true');
    try {
      const data = await api('admin-revenue', dates);
      if (request !== commerce.revenueRequest || epoch !== feedbackSessionEpoch || !state.admin) return;
      commerce.revenue = data.revenue || {};
      renderRevenue();
    } finally { if (request === commerce.revenueRequest) $('revenue-summary').removeAttribute('aria-busy'); }
  }
  function renderRevenue() {
    const revenue = commerce.revenue;
    const total = el('div', 'revenue-total'); total.append(el('span', 'small-text', '已确认实际收款 · 人民币'), el('strong', '', money(revenue.totalCents || 0)));
    const range = revenue.startDate || revenue.endDate ? `${revenue.startDate || '最早'} 至 ${revenue.endDate || '至今'}` : '全部时间';
    total.append(el('span', 'small-text', `${range} · 北京时间`));
    $('revenue-summary').replaceChildren(total, facts([['已确认收款', `${revenue.confirmedCount || 0} 笔`], ['待确认订单', `${revenue.pendingCount || 0} 笔 · 不计收入`], ['历史发码待核实', `${revenue.legacyUnverifiedCount || 0} 笔 · 不计收入`]], 'revenue-facts'));
    const breakdown = $('revenue-breakdown'); breakdown.replaceChildren();
    const groups = [ ['按会员套餐', revenue.byPlan || [], entry => entry.planName || entry.planId], ['按收款渠道', revenue.byPaymentMethod || [], entry => paymentMethodLabels[entry.paymentMethod] || entry.paymentMethod] ];
    for (const [heading, entries, label] of groups) {
      const section = el('div', 'revenue-group'); section.append(el('h4', '', heading));
      if (!entries.length) section.append(el('p', 'empty-inline', '此区间暂无已确认收款。'));
      else section.append(table(['类别', '收款笔数', '实际收款'], entries.map(entry => [label(entry), `${entry.count} 笔`, money(entry.totalCents)])));
      breakdown.append(section);
    }
    if (revenue.byDay?.length) {
      const days = el('details', 'revenue-days'); days.append(el('summary', '', `查看每日实收（${revenue.byDay.length} 天，北京时间）`), table(['收款日期', '收款笔数', '实际收款'], revenue.byDay.map(entry => [entry.date, `${entry.count} 笔`, money(entry.totalCents)])));
      breakdown.append(days);
    }
  }
  function resetOrderRecord() {
    commerce.target = null; commerce.recipients = []; commerce.searchRequest += 1;
    $('order-record-form').reset(); $('order-user-search-form').reset(); $('order-user-search-form').hidden = false;
    $('order-user').disabled = false; $('order-plan').disabled = false; $('order-code-id').readOnly = false;
    $('order-user').replaceChildren(el('option', '', '请先查找并选择客户账号')); $('order-user').firstChild.value = '';
    $('order-plan').value = 'monthly';
    const plan = MEMBERSHIP_PLANS.find(item => item.id === 'monthly'); $('order-amount').value = (plan.priceCents / 100).toFixed(2);
    $('order-record-target').hidden = true; $('order-record-result').textContent = '';
  }
  function selectOrderRecord(order) {
    if (state.pendingMutation || state.mutating) throw new Error('请先等待或重试尚未确认的管理操作，再切换收款记录。');
    resetOrderRecord(); commerce.target = order;
    const option = el('option', '', order.email || order.userId); option.value = order.userId; $('order-user').replaceChildren(option); $('order-user').disabled = true;
    $('order-plan').value = order.planId; $('order-plan').disabled = true;
    $('order-amount').value = Number.isSafeInteger(order.priceCents) ? (order.priceCents / 100).toFixed(2) : '';
    if (Object.hasOwn(paymentMethodLabels, order.paymentMethod)) $('order-payment-method').value = order.paymentMethod;
    $('order-code-id').value = order.codeId || ''; $('order-code-id').readOnly = Boolean(order.codeId);
    $('order-user-search-form').hidden = true;
    $('order-record-target').textContent = `正在核对订单 ${order.id}。账号与套餐已锁定；请核对并填写实际收款凭证。`; $('order-record-target').hidden = false;
    $('order-record-panel').scrollIntoView({ block: 'start' }); $('order-amount').focus();
  }
  async function findOrderUsers() {
    const query = $('order-user-query').value.trim();
    if (!query) throw new Error('请输入客户邮箱或用户 ID，再查找账号。');
    const request = ++commerce.searchRequest; const epoch = feedbackSessionEpoch;
    const data = await api('admin-users', { query });
    if (request !== commerce.searchRequest || epoch !== feedbackSessionEpoch || !state.admin || commerce.target) return;
    commerce.recipients = data.users || [];
    const placeholder = el('option', '', commerce.recipients.length ? '请选择已核对的客户账号' : '没有找到匹配账号'); placeholder.value = '';
    $('order-user').replaceChildren(placeholder);
    for (const user of commerce.recipients) { const option = el('option', '', `${user.email} · ${user.id}`); option.value = user.id; $('order-user').append(option); }
    if (commerce.recipients.length === 1) $('order-user').value = commerce.recipients[0].id;
  }
  MEMBERSHIP_PLANS.forEach(plan => { const option = el('option', '', `${plan.name} · 标价 ¥${plan.priceLabel}`); option.value = plan.id; $('order-plan').append(option); });
  resetOrderRecord();
  $('order-plan').addEventListener('change', () => { const plan = MEMBERSHIP_PLANS.find(item => item.id === $('order-plan').value); if (plan) $('order-amount').value = (plan.priceCents / 100).toFixed(2); });
  async function finishOrderRecord(result) {
    const order = result.order;
    resetOrderRecord();
    const message = `收款已确认：${order.id} · 实收 ${money(order.amountCents)}。已计入营业额；会员开通请继续使用激活码功能。`;
    $('order-record-result').textContent = message; tell(message, 'success'); state.loaded.delete('audit');
    await Promise.all([loadOrders(commerce.page), loadRevenue()]);
  }
  function closeOrderLink() {
    orderLinkTarget = null;
    if ($('order-link-dialog').open) $('order-link-dialog').close();
    $('order-link-form').reset(); $('order-link-summary').textContent = '';
    $('order-link-code-id').setCustomValidity(''); $('order-link-reason').setCustomValidity('');
  }
  function openOrderLink(order) {
    if (state.pendingMutation || state.mutating) throw new Error('请先等待或重试尚未确认的管理操作，再关联激活码。');
    closeOrderLink(); orderLinkTarget = order;
    $('order-link-summary').textContent = `订单：${order.id}\n账号：${order.email || order.userId}\n套餐：${order.planName || order.planId} · 实收 ${money(order.amountCents)}`;
    $('order-link-dialog').showModal(); $('order-link-code-id').focus();
  }
  async function finishOrderLink(result) {
    state.loaded.delete('audit'); closeOrderLink();
    tell(`订单 ${result.order.id} 已关联激活码记录 ${result.order.codeId}。已合并对应发码记录，营业额未重复增加。`, 'success');
    await Promise.all([loadOrders(commerce.page), loadRevenue()]);
  }
  $('order-link-cancel').addEventListener('click', closeOrderLink);
  $('order-link-dialog').addEventListener('cancel', event => { event.preventDefault(); closeOrderLink(); });
  $('order-link-code-id').addEventListener('input', () => $('order-link-code-id').setCustomValidity(''));
  $('order-link-reason').addEventListener('input', () => $('order-link-reason').setCustomValidity(''));
  $('order-link-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('order-link-form').reportValidity() || !orderLinkTarget) return;
    const input = { orderId: orderLinkTarget.id, codeId: $('order-link-code-id').value.trim().toLowerCase(), reason: $('order-link-reason').value.trim() };
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.codeId)) { $('order-link-code-id').setCustomValidity('请填写有效的激活码记录 ID，勿填写激活码原文。'); $('order-link-code-id').reportValidity(); return; }
    if (input.reason.length < 2) { $('order-link-reason').setCustomValidity('请填写至少 2 个字的关联原因。'); $('order-link-reason').reportValidity(); return; }
    run($('order-link-submit'), async () => {
      closeOrderLink();
      await finishOrderLink(await mutate('admin-link-order-code', input));
    });
  });
  $('order-record-reset').addEventListener('click', () => run($('order-record-reset'), () => { if (state.pendingMutation || state.mutating) throw new Error('请先等待或重试尚未确认的管理操作，再清空表单。'); resetOrderRecord(); }));
  $('order-user-search-form').addEventListener('submit', event => { event.preventDefault(); run(event.submitter || $('order-user-query'), findOrderUsers); });
  $('orders-filter-form').addEventListener('submit', event => { event.preventDefault(); run(event.submitter, () => loadOrders(1)); });
  $('revenue-filter-form').addEventListener('submit', event => { event.preventDefault(); run(event.submitter, loadRevenue); });
  $('refresh-commerce').addEventListener('click', () => run($('refresh-commerce'), () => Promise.all([loadOrders(commerce.page), loadRevenue()])));
  $('order-record-form').addEventListener('submit', event => {
    event.preventDefault(); run($('order-record-submit'), async () => {
      if (!$('order-record-form').reportValidity()) return;
      const amount = $('order-amount').value.trim();
      if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error('请填写有效的实际收款金额，最多两位小数。');
      const [yuan, fraction = ''] = amount.split('.'); const amountCents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('实际收款金额必须大于 0，并在有效范围内。');
      const paidAt = new Date(`${$('order-paid-at').value}+08:00`);
      if (!Number.isFinite(paidAt.getTime())) throw new Error('请填写有效的北京时间收款时间。');
      const input = { userId: $('order-user').value, planId: $('order-plan').value, amountCents, paymentMethod: $('order-payment-method').value, paidAt: paidAt.toISOString(), transactionReference: $('order-transaction-reference').value.trim(), reason: $('order-record-reason').value.trim() };
      if (!input.userId || !input.planId) throw new Error('请查找并选择有效的客户账号和套餐。');
      if (input.transactionReference.length < 3 || input.reason.length < 2) throw new Error('请填写真实收款流水和至少 2 个字的核对说明。');
      if (commerce.target) input.orderId = commerce.target.id;
      if ($('order-code-id').value.trim()) input.codeId = $('order-code-id').value.trim();
      const plan = MEMBERSHIP_PLANS.find(item => item.id === input.planId); const email = $('order-user').selectedOptions[0]?.textContent || input.userId;
      if (!await confirmAction('确认实际收款并入账', `账号：${email}\n套餐：${plan?.name || input.planId}\n实际收款：${money(amountCents)}\n渠道：${paymentMethodLabels[input.paymentMethod]}\n收款时间：${beijingTime(input.paidAt)}（北京时间）\n流水：${input.transactionReference}\n核对说明：${input.reason}\n\n确认后保存只读收款记录并计入营业额。会员权益仍需通过激活码开通。`, { reasonRequired: false, confirm: '确认收款并入账' })) return;
      await finishOrderRecord(await mutate('admin-record-order', input));
    });
  });
  async function loadAudit() { const data = await api('admin-audit'); state.audit = data.audit || []; state.total.audit = data.total || state.audit.length; state.pages.audit = 0; state.loaded.add('audit'); renderAudit(); }
  function renderAudit() {
    const visible = pageItems('audit', state.audit, renderAudit);
    if (!visible.length) return empty($('audit-list'), '暂无管理员操作日志。');
    $('audit-list').replaceChildren(table(['时间 / 操作', '操作管理员', '对象', '原因 / 变更内容'], visible.map((entry) => {
      const detail = el('div'); detail.append(el('p', '', entry.reason || '—'), changeDetails(entry.before, entry.after));
      return [record(fmt(entry.at), actionLabel(entry.action)), record(entry.actorEmail || entry.actorId || '系统'), record(entry.targetId), detail];
    }), 'audit-table'));
  }
  $('refresh-audit').addEventListener('click', () => run($('refresh-audit'), loadAudit));
  async function loadStatus() {
    const data = await api('admin-status'); state.loaded.add('status');
    const grid = el('div', 'status-grid');
    const storage = data.storage || { provider: 'github', ...data.github };
    const storageCard = el('section', 'status-card'); const storageHeading = el('div', 'panel-heading');
    storageHeading.append(el('h3', '', storage.provider === 'sqlite' ? 'SQLite 数据库' : 'GitHub 私有数据仓库'), badge(storage.status === 'ok' ? '读取正常' : '暂不可用', storage.status === 'ok' ? '' : 'badge-danger'));
    storageCard.append(storageHeading, facts([['检查时间', fmt(storage.checkedAt || data.serverTime)], ['服务反馈', storage.message || (storage.status === 'ok' ? '已成功读取权威业务状态' : '请检查服务端存储配置')]], 'status-facts'));
    const mail = el('section', 'status-card'); const mailHeading = el('div', 'panel-heading');
    const mailStatus = data.mail?.status || (data.mail?.configured ? 'configured' : 'not_configured');
    mailHeading.append(el('h3', '', '邮箱验证码服务'), badge(({ ok: '连接与认证正常', unavailable: '连接或认证失败', configured: '已配置', not_configured: '未配置' })[mailStatus] || '状态未知', ['unavailable', 'not_configured'].includes(mailStatus) ? 'badge-danger' : ''));
    const delivery = data.mail?.lastDelivery;
    mail.append(mailHeading, facts([['邮件服务', data.mail?.provider || '—'], ['检查时间', fmt(data.mail?.checkedAt || data.serverTime)], ['最近发送状态', delivery ? ({ sent: '已提交发送', delivered: '已投递', success: '发送成功', failed: '发送失败', error: '发送失败', pending: '发送中' })[delivery.status] || delivery.status : '暂无发送记录'], ['最近发送时间', fmt(delivery?.at)], ['服务反馈', data.mail?.message || '邮件配置不代表收件邮箱已成功收到邮件']], 'status-facts'));
    grid.append(storageCard, mail);
    $('status-content').replaceChildren(grid, el('p', 'status-caption', `服务器时间：${fmt(data.serverTime)}。页面所有时间按当前浏览器时区显示；会员权限以服务器时间为准。`));
  }
  $('refresh-status').addEventListener('click', () => run($('refresh-status'), loadStatus));
  window.addEventListener('beforeunload', (event) => {
    if ((state.generated.length && !state.generatedSaved) || state.requestIds.size) { event.preventDefault(); event.returnValue = ''; }
  });
  run(null, async () => { try { await loadSession(); } catch (error) { if (!['ACCOUNT_REQUIRED', 'SESSION_REVOKED', 'UNAUTHENTICATED', 'SESSION_INVALID', 'LOGIN_REQUIRED', 'UNAUTHORIZED'].includes(error.code)) throw error; } });
})();
