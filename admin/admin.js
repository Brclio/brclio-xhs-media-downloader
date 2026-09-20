/* Brclio membership administration. Authentication is an HttpOnly server cookie. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { admin: null, users: [], codes: [], audit: [], selectedId: null, user: null, history: [], pendingDevices: [], generated: [], generatedSaved: false, tab: 'users', serverTime: null, loaded: new Set(), requestIds: new Map(), pendingMutation: null, mutating: false, pages: { users: 0, codes: 0, audit: 0 }, total: {} };
  const PAGE_SIZE = 20;
  let dialogResolve = null;
  let sendTimer = null;
  let userRequest = 0;

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetch('/api/account', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input }), signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        const error = new Error(body?.error?.message || `服务暂时不可用（HTTP ${response.status}），请稍后重试。`);
        error.code = body?.error?.code || 'SERVICE_UNAVAILABLE';
        error.uncertain = !body || response.status >= 500 || response.status === 429;
        if (response.status === 401 && state.admin) { resetSession(); tell('登录已失效，请重新验证邮箱。', 'error'); }
        throw error;
      }
      if (body.serverTime) state.serverTime = body.serverTime;
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
    const key = JSON.stringify([action, input]);
    if (state.mutating) throw new Error('已有管理操作正在提交，请等待结果。');
    if (state.pendingMutation && state.pendingMutation.key !== key) throw new Error('上次操作的结果仍未确认。请先点击“重试原操作”核对结果，再发起其他修改。');
    const requestId = state.requestIds.get(key) || crypto.randomUUID();
    state.requestIds.set(key, requestId);
    state.mutating = true;
    try {
      const result = await api(action, { ...input, requestId });
      state.requestIds.delete(key);
      state.pendingMutation = null;
      return result;
    } catch (error) {
      if (!error.uncertain) { state.requestIds.delete(key); state.pendingMutation = null; }
      else state.pendingMutation = { action, input: { ...input }, key };
      throw error;
    } finally { state.mutating = false; }
  }
  async function run(target, action) {
    if (target?.dataset.busy === 'true') return;
    const wasDisabled = target?.disabled;
    if (target) { target.disabled = true; target.dataset.busy = 'true'; }
    try { return await action(); }
    catch (error) {
      tell(error.message || '操作失败，请重试。', 'error');
      if (state.pendingMutation) {
        const retry = button('重试原操作', 'button-secondary button-small', async () => {
          const pending = state.pendingMutation;
          if (!pending) return;
          const result = await mutate(pending.action, pending.input);
          state.loaded.delete('audit');
          if (pending.action === 'admin-generate-codes') displayGenerated(result);
          else tell('原操作已确认完成，未重复增加权益或重复生成记录。', 'success');
          if (pending.input.userId) await refreshUserAfterChange(pending.input.userId);
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
    $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true; $('admin-email').textContent = '';
    ['users-list', 'user-detail', 'codes-list', 'audit-list', 'status-content'].forEach((id) => $(id).replaceChildren());
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
    if (!state.loaded.has(name)) await ({ users: loadUsers, codes: loadCodes, audit: loadAudit, status: loadStatus })[name]();
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
  async function loadCodes() {
    const data = await api('admin-codes', { query: $('code-query').value.trim(), status: $('code-status').value }); state.codes = data.codes || []; state.total.codes = data.total || state.codes.length; state.pages.codes = 0; state.loaded.add('codes'); renderCodes();
  }
  function codeState(code) {
    if (code.status === 'unused' && code.redeemBy && state.serverTime && Date.parse(code.redeemBy) <= Date.parse(state.serverTime)) return 'expired';
    return code.status;
  }
  function renderCodes() {
    const query = $('code-query').value.trim().toLowerCase(); const filter = $('code-status').value;
    const matching = state.codes.filter((code) => (!filter || codeState(code) === filter) && (!query || [code.id, code.redeemedBy, code.redeemedEmail].some((value) => String(value || '').toLowerCase().includes(query))));
    const visible = pageItems('codes', matching, renderCodes);
    if (!visible.length) { empty($('codes-list'), '没有符合条件的激活码。'); return; }
    const labels = { unused: '待兑换', used: '已兑换', void: '已作废', expired: '已过兑换期限' };
    const rows = visible.map((code) => {
      const status = codeState(code);
      const control = code.status === 'unused' ? button('作废', 'button-danger button-small', async () => {
        const reason = await confirmAction('作废激活码', `记录：${code.id}\n权益：${code.type === 'permanent' ? '永久会员' : `${code.days} 天会员`}\n\n作废后无法兑换，已使用的激活码不能恢复为未使用。`, { danger: true, confirm: '确认作废' });
        if (!reason) return;
        await mutate('admin-void-code', { codeId: code.id, reason }); tell('激活码已作废。', 'success'); state.loaded.delete('audit'); await loadCodes();
      }) : el('span', 'small-text', '—');
      return [record(code.id, `创建于 ${fmt(code.createdAt)}`), record(code.type === 'permanent' ? '永久会员' : `${code.days} 天会员`, `兑换截止：${code.redeemBy ? fmt(code.redeemBy) : '不限制'}`), badge(labels[status] || status, status === 'used' ? '' : status === 'unused' ? 'badge-gold' : 'badge-muted'), record(code.redeemedEmail || code.redeemedBy || '—', code.redeemedAt ? fmt(code.redeemedAt) : ''), control];
    });
    $('codes-list').replaceChildren(table(['记录 / 创建时间', '权益 / 兑换截止', '状态', '兑换账号 / 时间', '管理'], rows, 'codes-table'));
    if (state.total.codes > state.codes.length) $('codes-list').append(el('p', 'field-help', `共 ${state.total.codes} 条记录，本页筛选范围为最近 ${state.codes.length} 条。`));
  }
  $('refresh-codes').addEventListener('click', () => run($('refresh-codes'), loadCodes));
  $('codes-filter-form').addEventListener('submit', (event) => { event.preventDefault(); run(event.submitter, loadCodes); });
  $('code-type').addEventListener('change', () => {
    const duration = $('code-type').value === 'duration'; $('code-days-field').hidden = !duration; $('code-days').disabled = !duration; $('code-days').required = duration;
  });
  function clearGenerated() { state.generated = []; state.generatedSaved = false; $('generated-panel').hidden = true; $('generated-raw').value = ''; $('generated-summary').textContent = ''; }
  function displayGenerated(result) {
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
  function actionLabel(action) { return ({ 'membership': '修改会员权益', 'membership-change': '修改会员权益', 'admin-membership': '修改会员权益', 'device-unbind': '解绑设备', 'admin-unbind': '解绑设备', 'admin-restore-device': '授权新密钥设备', 'codes-generate': '生成激活码', 'admin-generate-codes': '生成激活码', 'code-void': '作废激活码', 'admin-void-code': '作废激活码', 'code-redeem': '兑换激活码', redeem: '兑换激活码' })[action] || action || '操作记录'; }
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
    const github = el('section', 'status-card'); const ghHeading = el('div', 'panel-heading');
    ghHeading.append(el('h3', '', 'GitHub 私有数据仓库'), badge(data.github?.status === 'ok' ? '读取正常' : '暂不可用', data.github?.status === 'ok' ? '' : 'badge-danger'));
    github.append(ghHeading, facts([['检查时间', fmt(data.github?.checkedAt || data.serverTime)], ['服务反馈', data.github?.message || (data.github?.status === 'ok' ? '已成功读取权威业务状态' : '请检查服务端配置与 GitHub 服务')]], 'status-facts'));
    const mail = el('section', 'status-card'); const mailHeading = el('div', 'panel-heading');
    const mailStatus = data.mail?.status || (data.mail?.configured ? 'configured' : 'not_configured');
    mailHeading.append(el('h3', '', '邮箱验证码服务'), badge(({ ok: '连接与认证正常', unavailable: '连接或认证失败', configured: '已配置', not_configured: '未配置' })[mailStatus] || '状态未知', ['unavailable', 'not_configured'].includes(mailStatus) ? 'badge-danger' : ''));
    const delivery = data.mail?.lastDelivery;
    mail.append(mailHeading, facts([['邮件服务', data.mail?.provider || '—'], ['检查时间', fmt(data.mail?.checkedAt || data.serverTime)], ['最近发送状态', delivery ? ({ sent: '已提交发送', delivered: '已投递', success: '发送成功', failed: '发送失败', error: '发送失败', pending: '发送中' })[delivery.status] || delivery.status : '暂无发送记录'], ['最近发送时间', fmt(delivery?.at)], ['服务反馈', data.mail?.message || '邮件配置不代表收件邮箱已成功收到邮件']], 'status-facts'));
    grid.append(github, mail);
    $('status-content').replaceChildren(grid, el('p', 'status-caption', `服务器时间：${fmt(data.serverTime)}。页面所有时间按当前浏览器时区显示；会员权限以服务器时间为准。`));
  }
  $('refresh-status').addEventListener('click', () => run($('refresh-status'), loadStatus));
  window.addEventListener('beforeunload', (event) => {
    if ((state.generated.length && !state.generatedSaved) || state.requestIds.size) { event.preventDefault(); event.returnValue = ''; }
  });
  run(null, async () => { try { await loadSession(); } catch (error) { if (!['ACCOUNT_REQUIRED', 'SESSION_REVOKED', 'UNAUTHENTICATED', 'SESSION_INVALID', 'LOGIN_REQUIRED', 'UNAUTHORIZED'].includes(error.code)) throw error; } });
})();
