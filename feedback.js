// Public feedback board. Session credentials stay in the server's HttpOnly cookie.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 20;
  const categories = { download: '下载与任务', audio: '视频声音', account: '账号与会员', update: '安装与更新', other: '建议 / 其他' };
  const statuses = { new: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' };
  const expiredCodes = new Set(['UNAUTHENTICATED', 'SESSION_REVOKED', 'INVALID_SESSION', 'SESSION_INVALID']);
  const state = { user: null, account: null, sessionEpoch: 0, viewEpoch: 0, listRequest: 0, detailRequest: 0, ownerRequest: 0,
    issue: '', detail: null, owner: null, listBusy: false, detailBusy: false, ownerBusy: false,
    page: 1, totalPages: 1, commentPage: 1, commentPages: 1, status: '', category: '', query: '',
    authBusy: false, codeBusy: false, logoutPending: false, logoutBusy: false, codeUntil: 0, codeEmail: '', everAuthenticated: false };
  const drafts = new Map();
  let codeTimer;
  let loginReturnFocus;
  let sessionSync = null;
  const uid = () => state.user?.id || '';
  const draftKey = (kind, issue = state.issue, user = uid()) => JSON.stringify([user || 'guest', kind, issue]);
  const config = kind => kind === 'public' ? { field: 'feedback-comment-content', button: 'feedback-comment-submit', hint: 'feedback-comment-hint', status: 'feedback-comment-status', max: 2000, action: 'feedback-public-comment' }
    : { field: 'feedback-owner-reply', button: 'feedback-owner-reply-submit', hint: 'feedback-owner-reply-hint', status: 'feedback-owner-reply-status', max: 8000, action: 'feedback-owner-reply' };
  const node = (tag, className, text) => {
    const value = document.createElement(tag); if (className) value.className = className;
    if (text !== undefined && text !== null) value.textContent = String(text); return value;
  };
  const count = value => Math.max(0, Math.trunc(Number(value) || 0));
  const date = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'; };
  function tell(id, message, tone = 'info') { $(id).textContent = message; $(id).dataset.tone = tone; }
  function notice(message, tone = 'info') { tell('feedback-notice', message, tone); $('feedback-notice').hidden = !message; }
  function draft(kind, create = false) {
    const key = draftKey(kind);
    if (!drafts.has(key) && create) drafts.set(key, { content: '', pending: null, sending: false });
    return drafts.get(key);
  }
  function saveDrafts() {
    if (!state.issue) return;
    for (const kind of ['public', 'owner']) {
      if (kind === 'owner' && !state.owner) continue;
      const current = draft(kind, true);
      if (!current.pending && !current.sending) current.content = $(config(kind).field).value;
    }
  }
  function restoreDrafts() {
    for (const kind of ['public', 'owner']) $(config(kind).field).value = draft(kind)?.content || '';
  }
  function clearOwner() {
    state.ownerRequest += 1; state.owner = null; state.ownerBusy = false;
    $('feedback-owner-section').hidden = true; $('feedback-owner-messages').replaceChildren();
    $('feedback-owner-original').open = false; $('feedback-owner-original-title').textContent = ''; $('feedback-owner-original-description').textContent = '';
    $('feedback-owner-reply').value = ''; tell('feedback-owner-status', ''); tell('feedback-owner-reply-status', '');
  }
  function setAccount(account, { expired = false } = {}) {
    saveDrafts();
    const previous = uid(), next = typeof account?.user?.id === 'string' ? account.user.id : '';
    if (next && !state.everAuthenticated && state.issue) {
      const guest = drafts.get(draftKey('public', state.issue, ''));
      if (guest?.content && !guest.pending && !drafts.has(draftKey('public', state.issue, next))) drafts.set(draftKey('public', state.issue, next), { ...guest });
      drafts.delete(draftKey('public', state.issue, ''));
    }
    state.sessionEpoch += 1; state.account = next ? account : null; state.user = next ? account.user : null;
    if (next) state.everAuthenticated = true;
    clearOwner(); restoreDrafts();
    tell('feedback-comment-status', '');
    renderControls();
    if (expired) notice('登录已失效，请重新验证邮箱。未发送的草稿会在同一账号重新登录后恢复。', 'error');
    if (next && state.issue) void loadOwner();
    return previous !== next;
  }
  async function api(action, input = {}, { sensitive = false, epoch = state.sessionEpoch } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch('/api/account', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input }), signal: controller.signal });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) {
        const error = new Error(result?.error?.message || '暂时无法连接，请稍后重试。');
        error.code = result?.error?.code || 'SERVICE_UNAVAILABLE'; error.status = response.status;
        error.uncertain = !result || response.status >= 500 || response.status === 429;
        if (sensitive && epoch === state.sessionEpoch && (response.status === 401 || expiredCodes.has(error.code))) setAccount(null, { expired: true });
        else if (sensitive && epoch === state.sessionEpoch && error.code === 'ACCOUNT_CHANGED') {
          setAccount(null); notice('登录账号已变化，原账号草稿已保留。请确认账号后再发送。', 'error');
          void syncSession();
        }
        throw error;
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        const wrapped = new Error('暂时无法确认操作结果，请保持原文并重试。'); wrapped.uncertain = true; throw wrapped;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  function syncSession({ showFailure = false } = {}) {
    if (state.logoutPending || state.authBusy) return Promise.resolve();
    const epoch = state.sessionEpoch;
    if (sessionSync?.epoch === epoch) return sessionSync.promise;
    const promise = (async () => {
      try {
        const result = await api('me', { client: 'browser' }, { sensitive: Boolean(uid()), epoch });
        if (epoch !== state.sessionEpoch) return;
        if ((result.account?.user?.id || '') !== uid()) {
          const previous = uid(); setAccount(result.account);
          if (previous) notice('登录账号已变化，原账号草稿已保留。请确认账号后再发送。', 'error');
        }
      } catch (error) {
        if (epoch === state.sessionEpoch && showFailure && error.status !== 401 && !expiredCodes.has(error.code)) notice('暂时无法确认登录状态，可继续浏览或重新登录。');
      } finally { if (sessionSync?.epoch === epoch) sessionSync = null; }
    })();
    sessionSync = { epoch, promise }; return promise;
  }
  function renderControls() {
    $('feedback-account-label').textContent = uid() ? state.user.email || '已登录软件账号' : state.logoutPending ? '退出尚未确认' : '无需登录即可浏览';
    $('feedback-login-open').hidden = Boolean(uid()); $('feedback-login-open').disabled = state.logoutPending || state.authBusy;
    $('feedback-logout').hidden = !uid() && !state.logoutPending;
    $('feedback-logout').disabled = state.logoutBusy; $('feedback-logout').textContent = state.logoutBusy ? '正在退出…' : state.logoutPending ? '重试退出' : '退出登录';
    $('feedback-list-retry').disabled = state.listBusy; $('feedback-prev').disabled = state.listBusy || state.page <= 1; $('feedback-next').disabled = state.listBusy || state.page >= state.totalPages;
    $('feedback-detail-refresh').disabled = !state.issue || state.detailBusy || state.ownerBusy;
    $('feedback-comments-prev').disabled = state.detailBusy || state.commentPage <= 1; $('feedback-comments-next').disabled = state.detailBusy || state.commentPage >= state.commentPages;
    for (const kind of ['public', 'owner']) {
      const c = config(kind), current = draft(kind), pending = Boolean(current?.pending);
      const unavailable = !state.detail || state.logoutPending || (kind === 'owner' && (!uid() || !state.owner));
      $(c.field).disabled = unavailable || Boolean(current?.sending); $(c.field).readOnly = pending;
      $(c.button).disabled = unavailable || Boolean(current?.sending);
      $(c.button).textContent = current?.sending ? '正在保存…' : !uid() ? '登录后评论 ↗' : pending ? '重试原文 ↗' : kind === 'public' ? '发表公开评论 ↗' : '发送私密回复 ↗';
      $(c.hint).textContent = pending ? '原文已保留，重试会确认同一条内容。' : kind === 'public' ? '公开可见 · 最多 2000 字' : '仅双方可见 · 最多 8000 字';
    }
    const remaining = Math.max(0, Math.ceil((state.codeUntil - Date.now()) / 1000));
    $('feedback-send-code').disabled = state.codeBusy || state.authBusy || remaining > 0;
    $('feedback-send-code').textContent = state.codeBusy ? '正在发送…' : remaining > 0 ? `${remaining} 秒后重发` : '获取验证码';
    $('feedback-login-submit').disabled = state.authBusy || state.codeBusy; $('feedback-login-submit').textContent = state.authBusy ? '正在验证…' : '验证并登录 ↗';
    $('feedback-login-email').disabled = state.authBusy || state.codeBusy; $('feedback-login-code').disabled = state.authBusy;
  }
  function badge(text, status) { const value = node('span', 'badge', text); if (status) value.dataset.status = status; return value; }
  function issueUrl(id) { const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('issue', id); return url; }
  function renderList(rows) {
    const fragment = document.createDocumentFragment();
    for (const issue of rows) {
      const link = node('a', 'feedback-issue-link'); link.href = issueUrl(issue.id).href; link.dataset.feedbackId = issue.id; link.setAttribute('aria-current', String(issue.id === state.issue));
      const heading = node('div', 'issue-item-top'); heading.append(node('strong', '', issue.title), badge(statuses[issue.status] || '已提交', issue.status));
      link.append(heading, node('p', 'issue-preview', issue.description), node('p', 'issue-item-meta', `${categories[issue.category] || '其他'} · ${count(issue.commentCount)} 条评论 · ${date(issue.updatedAt || issue.createdAt)}`));
      link.addEventListener('click', event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); void selectIssue(issue.id, { focus: true }); });
      fragment.append(link);
    }
    $('feedback-public-list').replaceChildren(fragment);
  }
  async function loadList() {
    const request = ++state.listRequest;
    state.listBusy = true; renderControls(); $('feedback-public-list').setAttribute('aria-busy', 'true');
    tell('feedback-list-status', '正在读取问题…');
    try {
      const result = await api('feedback-public-list', { page: state.page, pageSize: PAGE_SIZE, status: state.status, category: state.category, query: state.query });
      if (request !== state.listRequest) return;
      if (!Array.isArray(result.feedbacks)) throw new Error('问题列表暂时无法读取，请重试。');
      state.page = Math.max(1, count(result.page)); state.totalPages = Math.max(1, count(result.totalPages));
      renderList(result.feedbacks);
      $('feedback-page-label').textContent = `${state.page} / ${state.totalPages}`;
      tell('feedback-list-status', result.feedbacks.length ? `共 ${count(result.total)} 个问题` : '暂时没有符合条件的问题，试试其他筛选条件。');
      for (const element of document.querySelectorAll('[data-status-count]')) {
        const key = element.dataset.statusCount;
        element.textContent = String(count(key === 'unresolved' ? result.counts?.unresolved ?? count(result.counts?.new) + count(result.counts?.in_progress) : result.counts?.[key]));
      }
    } catch (error) { if (request === state.listRequest) tell('feedback-list-status', `${error.message} 可点击「刷新列表」重试。`, 'error'); }
    finally { if (request === state.listRequest) { state.listBusy = false; $('feedback-public-list').setAttribute('aria-busy', 'false'); renderControls(); } }
  }
  function renderMessages(container, messages, privateThread = false) {
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      const article = node('article', 'feedback-comment'); article.dataset.messageId = message.id;
      const meta = node('p', 'comment-meta'); meta.append(node('strong', '', message.authorRole === 'admin' ? '管理员' : privateThread ? '我' : '软件用户'), node('time', '', date(message.createdAt)));
      article.append(meta, node('p', 'feedback-comment-content', message.content)); fragment.append(article);
    }
    container.replaceChildren(fragment);
    if (!messages.length) container.append(node('p', 'small-text', privateThread ? '暂时没有私密回复，你可以在下方继续补充。' : '还没有评论，欢迎分享你的经验。'));
  }
  function renderDetail(result) {
    state.detail = result;
    const issue = result.feedback;
    $('feedback-detail-title').textContent = issue.title;
    $('feedback-detail-description').textContent = issue.description;
    $('feedback-detail-meta').textContent = `提交于 ${date(issue.createdAt)} · 更新于 ${date(issue.updatedAt)} · ${issue.id}`;
    $('feedback-detail-badges').replaceChildren(badge(statuses[issue.status] || '已提交', issue.status), badge(categories[issue.category] || '其他'));
    $('feedback-comment-count').textContent = `${count(result.total ?? issue.commentCount)} 条评论`;
    state.commentPage = Math.max(1, count(result.page || state.commentPage)); state.commentPages = Math.max(1, count(result.totalPages));
    $('feedback-comments-page-label').textContent = `${state.commentPage} / ${state.commentPages}`;
    $('feedback-comments-pagination').hidden = state.commentPages < 2;
    renderMessages($('feedback-public-comments'), result.comments);
  }
  async function loadDetail() {
    if (!state.issue) return false;
    const issue = state.issue, view = state.viewEpoch, request = ++state.detailRequest;
    state.detailBusy = true; renderControls(); tell('feedback-detail-status', '正在读取最新进展…');
    try {
      const result = await api('feedback-public-detail', { feedbackId: issue, page: state.commentPage, pageSize: PAGE_SIZE });
      if (view !== state.viewEpoch || request !== state.detailRequest) return false;
      if (result.feedback?.id !== issue || !Array.isArray(result.comments)) throw new Error('问题内容暂时无法读取，请重试。');
      renderDetail(result); tell('feedback-detail-status', ''); return true;
    } catch (error) {
      if (view === state.viewEpoch && request === state.detailRequest) {
        if (!state.detail) $('feedback-detail-title').textContent = error.status === 404 ? '没有找到这个问题' : '暂时无法读取问题';
        tell('feedback-detail-status', `${error.message} 可点击上方「刷新」重试。`, 'error');
      }
      return false;
    } finally { if (view === state.viewEpoch && request === state.detailRequest) { state.detailBusy = false; renderControls(); } }
  }
  async function loadOwner() {
    if (!uid() || !state.issue || state.logoutPending) return false;
    const issue = state.issue, epoch = state.sessionEpoch, view = state.viewEpoch, request = ++state.ownerRequest;
    state.ownerBusy = true; renderControls();
    try {
      const result = await api('feedback-owner-detail', { feedbackId: issue }, { sensitive: true, epoch });
      if (epoch !== state.sessionEpoch || view !== state.viewEpoch || request !== state.ownerRequest) return false;
      if (result.feedback?.id !== issue || !Array.isArray(result.messages)) throw new Error('私密对话暂时无法读取。');
      state.owner = result; $('feedback-owner-section').hidden = false;
      $('feedback-owner-original-title').textContent = result.feedback.title || ''; $('feedback-owner-original-description').textContent = result.feedback.description || '';
      renderMessages($('feedback-owner-messages'), result.messages, true); restoreDrafts(); tell('feedback-owner-status', ''); return true;
    } catch (error) {
      if (epoch === state.sessionEpoch && view === state.viewEpoch && request === state.ownerRequest) {
        if (error.status === 404 || error.code === 'FEEDBACK_NOT_FOUND') { clearOwner(); renderControls(); }
        else tell('feedback-owner-status', `${error.message} 可刷新问题重试。`, 'error');
      }
      return false;
    } finally { if (epoch === state.sessionEpoch && view === state.viewEpoch && request === state.ownerRequest) { state.ownerBusy = false; renderControls(); } }
  }
  async function selectIssue(issue, { focus = false, historyMode = 'push' } = {}) {
    if (!issue) return;
    saveDrafts(); state.viewEpoch += 1; state.detailRequest += 1; state.detailBusy = false; state.issue = issue; state.detail = null; state.commentPage = 1; state.commentPages = 1;
    clearOwner(); restoreDrafts();
    $('feedback-detail-empty').hidden = true; $('feedback-detail').hidden = false;
    $('feedback-detail-title').textContent = '正在读取问题…'; $('feedback-detail-description').textContent = ''; $('feedback-detail-meta').textContent = '';
    $('feedback-detail-badges').replaceChildren(); $('feedback-public-comments').replaceChildren(); $('feedback-comment-count').textContent = '';
    $('feedback-comments-pagination').hidden = true; $('feedback-share-url').hidden = true;
    tell('feedback-comment-status', ''); tell('feedback-owner-reply-status', '');
    if (historyMode !== 'none') history[historyMode === 'replace' ? 'replaceState' : 'pushState']({}, '', issueUrl(issue));
    for (const link of document.querySelectorAll('.feedback-issue-link')) link.setAttribute('aria-current', String(link.dataset.feedbackId === issue));
    renderControls();
    if (focus) { $('feedback-detail-title').focus({ preventScroll: true }); if (matchMedia('(max-width: 900px)').matches) $('feedback-detail').scrollIntoView({ block: 'start' }); }
    await Promise.all([loadDetail(), loadOwner()]);
  }
  async function send(kind, event) {
    event.preventDefault(); const c = config(kind);
    if (!state.issue || !state.detail || state.logoutPending || (kind === 'owner' && !state.owner)) return;
    saveDrafts();
    if (!uid()) { openLogin(); return; }
    const current = draft(kind, true); if (current.sending) return;
    if (!current.content.trim() || current.content.length > c.max) { tell(c.status, `请填写 1–${c.max} 字的内容。`, 'error'); return; }
    const epoch = state.sessionEpoch, view = state.viewEpoch, user = uid(), issue = state.issue;
    current.pending ||= { feedbackId: issue, content: current.content, requestId: crypto.randomUUID(), ...(kind === 'public' ? { expectedUserId: user } : {}) };
    current.sending = true; renderControls(); tell(c.status, '正在保存…');
    try {
      const account = await api('me', { client: 'browser' }, { sensitive: true, epoch });
      if (epoch !== state.sessionEpoch) return;
      if (account.account?.user?.id !== user) { setAccount(account.account); notice('当前登录账号已变化，请确认账号后再发送。原账号草稿已保留。', 'error'); return; }
      if (view !== state.viewEpoch) return;
      const result = await api(c.action, current.pending, { sensitive: true, epoch });
      if (epoch !== state.sessionEpoch) return;
      const message = kind === 'public' ? result.comment : result.message;
      if (!message?.id) { const error = new Error('尚未确认保存，请重试原文。'); error.uncertain = true; throw error; }
      current.content = ''; current.pending = null;
      if (view !== state.viewEpoch) return;
      $(c.field).value = '';
      if (kind === 'public') {
        const comments = state.detail.comments.filter(item => item.id !== message.id);
        const total = count(result.feedback?.commentCount || state.detail.total + 1);
        renderDetail({ ...state.detail, feedback: result.feedback || state.detail.feedback, comments: [...comments, message], total });
        state.commentPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
      } else if (state.owner) {
        state.owner = { ...state.owner, feedback: result.feedback || state.owner.feedback, messages: [...state.owner.messages.filter(item => item.id !== message.id), message] };
        renderMessages($('feedback-owner-messages'), state.owner.messages, true);
      }
      tell(c.status, kind === 'public' ? '评论已保存。' : '私密回复已保存。');
      const refreshed = await (kind === 'public' ? loadDetail() : loadOwner());
      if (epoch === state.sessionEpoch && view === state.viewEpoch && !refreshed) tell(c.status, `${kind === 'public' ? '评论' : '私密回复'}已保存，最新对话暂未刷新，请稍后点击「刷新」。`, 'error');
      if (kind === 'public') void loadList();
    } catch (error) {
      if (!error.uncertain && !expiredCodes.has(error.code) && error.status !== 401) current.pending = null;
      if (kind === 'owner' && error.status === 404 && epoch === state.sessionEpoch) {
        clearOwner(); renderControls(); notice('这段私密对话暂不可用，原账号草稿已保留，正在确认登录状态。', 'error');
        void syncSession();
      }
      if (epoch === state.sessionEpoch && view === state.viewEpoch) tell(c.status, `${error.message}${current.pending ? ' 原文已保留，请点击「重试原文」。' : ''}`, 'error');
    } finally { current.sending = false; if (epoch === state.sessionEpoch && view === state.viewEpoch) renderControls(); }
  }
  function openLogin() {
    if (state.logoutPending) return;
    loginReturnFocus = document.activeElement;
    if (!$('feedback-login-dialog').open) $('feedback-login-dialog').showModal();
    $('feedback-login-email').focus();
  }
  $('feedback-login-open').addEventListener('click', openLogin);
  $('feedback-login-close').addEventListener('click', () => $('feedback-login-dialog').close());
  $('feedback-login-dialog').addEventListener('close', () => { $('feedback-login-code').value = ''; const target = loginReturnFocus?.isConnected && !loginReturnFocus.hidden ? loginReturnFocus : uid() ? $('feedback-logout') : $('feedback-login-open'); target?.focus(); });
  $('feedback-send-code').addEventListener('click', async () => {
    if (state.codeBusy || state.authBusy || state.codeUntil > Date.now() || !$('feedback-login-email').reportValidity()) return;
    const email = $('feedback-login-email').value.trim(), epoch = state.sessionEpoch;
    state.codeBusy = true; renderControls(); tell('feedback-login-status', '正在发送验证码…');
    try {
      const result = await api('send-code', { client: 'browser', email });
      if (epoch !== state.sessionEpoch) return;
      state.codeEmail = email; state.codeUntil = Date.now() + Math.max(1, count(result.retryAfterSeconds ?? result.retryAfter ?? 60)) * 1000;
      tell('feedback-login-status', '验证码已发送，5 分钟内有效，请检查邮箱。'); $('feedback-login-code').focus();
      clearInterval(codeTimer); codeTimer = setInterval(() => { renderControls(); if (state.codeUntil <= Date.now()) clearInterval(codeTimer); }, 1000);
    } catch (error) { if (epoch === state.sessionEpoch) tell('feedback-login-status', error.message, 'error'); }
    finally { state.codeBusy = false; renderControls(); }
  });
  $('feedback-login-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.authBusy || state.codeBusy || !$('feedback-login-form').reportValidity()) return;
    const email = $('feedback-login-email').value.trim(), code = $('feedback-login-code').value.trim(), epoch = state.sessionEpoch;
    state.authBusy = true; renderControls(); tell('feedback-login-status', '正在验证邮箱…');
    try {
      const result = await api('verify-code', { client: 'browser', email, code });
      if (epoch !== state.sessionEpoch) return;
      if (!result.account?.user?.id) throw new Error('登录结果无法确认，请重试。');
      setAccount(result.account); notice('已登录，可以参与公开评论。'); $('feedback-login-dialog').close();
    } catch (error) { if (epoch === state.sessionEpoch) tell('feedback-login-status', error.message, 'error'); }
    finally { state.authBusy = false; renderControls(); }
  });
  $('feedback-logout').addEventListener('click', async () => {
    if (state.logoutBusy) return;
    state.logoutPending = true; state.logoutBusy = true; setAccount(null); renderControls();
    try { await api('logout', { client: 'browser' }); state.logoutPending = false; notice('已退出登录。'); }
    catch (error) {
      if (error.status === 401 || expiredCodes.has(error.code)) { state.logoutPending = false; notice('原登录已失效，已退出当前页面。'); }
      else notice(`退出尚未确认，已隐藏当前账号内容。${error.message} 请点击「重试退出」。`, 'error');
    }
    finally { state.logoutBusy = false; renderControls(); }
  });
  $('feedback-comment-form').addEventListener('submit', event => void send('public', event));
  $('feedback-owner-reply-form').addEventListener('submit', event => void send('owner', event));
  for (const kind of ['public', 'owner']) $(config(kind).field).addEventListener('input', () => { const current = draft(kind, true); if (!current.pending && !current.sending) current.content = $(config(kind).field).value; });
  $('feedback-search-form').addEventListener('submit', event => { event.preventDefault(); state.query = $('feedback-search').value.trim(); state.category = $('feedback-category').value; state.page = 1; void loadList(); });
  $('feedback-category').addEventListener('change', () => { state.category = $('feedback-category').value; state.query = $('feedback-search').value.trim(); state.page = 1; void loadList(); });
  const filters = [...document.querySelectorAll('[data-status-filter]')];
  for (const [index, filter] of filters.entries()) {
    filter.addEventListener('click', () => { state.status = filter.dataset.statusFilter; state.page = 1; for (const item of filters) item.setAttribute('aria-pressed', String(item === filter)); void loadList(); });
    filter.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? filters.length - 1 : (index + (event.key === 'ArrowLeft' ? filters.length - 1 : 1)) % filters.length; filters[next].focus(); filters[next].click(); });
  }
  $('feedback-prev').addEventListener('click', () => { if (state.page > 1 && !state.listBusy) { state.page -= 1; void loadList(); } });
  $('feedback-next').addEventListener('click', () => { if (state.page < state.totalPages && !state.listBusy) { state.page += 1; void loadList(); } });
  $('feedback-comments-prev').addEventListener('click', () => { if (state.commentPage > 1 && !state.detailBusy) { state.commentPage -= 1; void loadDetail(); } });
  $('feedback-comments-next').addEventListener('click', () => { if (state.commentPage < state.commentPages && !state.detailBusy) { state.commentPage += 1; void loadDetail(); } });
  $('feedback-list-retry').addEventListener('click', () => void loadList());
  $('feedback-detail-refresh').addEventListener('click', () => { void loadDetail(); void loadOwner(); });
  $('feedback-share').addEventListener('click', async () => {
    if (!state.issue) return;
    const url = issueUrl(state.issue).href, view = state.viewEpoch;
    try { await navigator.clipboard.writeText(url); if (view === state.viewEpoch) tell('feedback-detail-status', '问题链接已复制。'); }
    catch { if (view === state.viewEpoch) { $('feedback-share-url').value = url; $('feedback-share-url').hidden = false; $('feedback-share-url').select(); tell('feedback-detail-status', '已选中问题链接，可手动复制。'); } }
  });
  const locationIssue = () => new URL(location.href).searchParams.get('issue') || '';
  window.addEventListener('popstate', () => {
    const issue = locationIssue();
    if (issue) void selectIssue(issue, { historyMode: 'none' });
    else { saveDrafts(); state.viewEpoch += 1; state.issue = ''; state.detail = null; clearOwner(); restoreDrafts(); $('feedback-detail').hidden = true; $('feedback-detail-empty').hidden = false; renderControls(); }
  });
  window.addEventListener('pagehide', () => clearInterval(codeTimer), { once: true });
  window.addEventListener('focus', () => void syncSession());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncSession(); });
  renderControls(); void loadList();
  if (locationIssue()) void selectIssue(locationIssue(), { historyMode: 'none' });
  void syncSession({ showFailure: true });
})();
