const verificationPageContext = globalThis.brclioPageContext?.();

function trustedVerificationURL(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'live.browser.run'
    || url.username || url.password || (url.port && url.port !== '443')
    || url.hash || url.pathname !== '/ui/view' || url.searchParams.getAll('mode').length !== 1
    || url.searchParams.get('mode') !== 'tab' || url.searchParams.getAll('wss').length !== 1) return null;
  let socket;
  const address = url.searchParams.get('wss');
  try { socket = new URL(address.startsWith('wss://') ? address : `wss://${address}`); } catch { return null; }
  if (socket.protocol !== 'wss:' || socket.hostname !== 'live.browser.run' || socket.username || socket.password
    || socket.port || socket.hash || !/^\/api\/devtools\/browser\/[A-Za-z0-9_-]+\/page\/[A-Za-z0-9_-]+$/.test(socket.pathname)
    || socket.searchParams.getAll('jwt').length !== 1 || !socket.searchParams.get('jwt')) return null;
  return { url: url.href, connectionPath: socket.pathname };
}

// A verification session belongs only to the current parse operation.
export function verificationDetails(payload) {
  const token = payload?.verificationToken;
  const expiresAt = typeof payload?.expiresAt === 'number' ? payload.expiresAt : Date.parse(payload?.expiresAt);
  const connection = trustedVerificationURL(payload?.verificationUrl);
  if (!connection || !['node', 'python', 'browser-python'].includes(payload?.engine)
    || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now() || expiresAt > Date.now() + 185000) return null;
  const reason = ['captcha', 'login', 'access-error'].includes(payload.reason) ? payload.reason : 'access-error';
  return { token, expiresAt, ...connection, engine: payload.engine, reason };
}

const REASON_COPY = {
  captcha: {
    title: '完成小红书安全验证',
    description: '小红书要求安全验证。请在弹出的窗口手动完成验证，再回到这里继续解析。',
    open: '打开验证窗口', opened: '验证窗口已打开，完成验证后点击继续解析。',
    blocked: '浏览器阻止了弹出窗口，请点击“打开验证窗口”完成验证。',
    pending: '验证尚未完成，请先在窗口按小红书页面提示完成验证。',
  },
  login: {
    title: '在小红书窗口完成登录',
    description: '小红书要求登录。请在弹出的窗口按页面提示完成登录，再回到这里继续解析。',
    open: '打开登录窗口', opened: '小红书窗口已打开，完成登录后点击继续解析。',
    blocked: '浏览器阻止了弹出窗口，请点击“打开登录窗口”完成登录。',
    pending: '小红书仍要求登录，请在窗口完成登录后继续。',
  },
  'access-error': {
    title: '在窗口打开小红书笔记',
    description: '小红书暂未打开这篇笔记。可在弹出的窗口按页面提示处理，然后回到原网页继续解析。',
    open: '打开小红书窗口', opened: '小红书窗口已打开，按页面提示处理后点击继续解析。',
    blocked: '浏览器阻止了弹出窗口，请点击“打开小红书窗口”按页面提示处理。',
    pending: '小红书仍未打开这篇笔记，请在窗口按页面提示处理后继续。',
  },
};

// May be called from a user gesture when the browser requires one for popups.
// Keep the handle so this parse can close its own verification window later.
export function prepareVerificationPopup() {
  const { window } = verificationPageContext ?? globalThis;
  let handle;
  try {
    handle = window.open('about:blank', '_blank', 'popup,width=1080,height=760');
    if (!handle) return null;
    handle.opener = null;
    const meta = handle.document.createElement('meta');
    meta.name = 'referrer'; meta.content = 'no-referrer';
    handle.document.head.append(meta);
    handle.document.title = '小红书窗口 · Brclio';
    const message = handle.document.createElement('p');
    message.textContent = '正在打开小红书窗口……';
    message.style.cssText = 'margin:32px;font:16px/1.6 system-ui,sans-serif;color:#1a1a2e';
    handle.document.body.style.backgroundColor = '#fefcf6';
    handle.document.body.append(message);
  } catch {
    try { handle?.close(); } catch {}
    return null;
  }
  return {
    isOpen() { try { return !handle.closed; } catch { return false; } },
    navigate(url) {
      try {
        // Only the validated, short-lived official Live View URL may leave the blank page.
        const target = trustedVerificationURL(url);
        if (!target || handle.closed) return false;
        handle.location.replace(target.url); handle.focus(); return true;
      } catch { return false; }
    },
    close() { try { handle.close(); } catch {} },
    focus() { try { handle.focus(); } catch {} },
  };
}

export async function waitForNoteVerification(payload, { popup = null } = {}) {
  const { document, window } = verificationPageContext ?? globalThis;
  let details = verificationDetails(payload);
  if (!details) { popup?.close(); throw new Error('验证窗口不可用或已过期，请重新解析。'); }
  const originalDeadline = details.expiresAt;
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'note-verification-dialog';
  dialog.setAttribute('aria-labelledby', 'note-verification-title');
  const title = document.createElement('h2');
  title.id = 'note-verification-title';
  const description = document.createElement('p');
  const status = document.createElement('p');
  status.className = 'note-verification-status'; status.setAttribute('role', 'status');
  const countdown = document.createElement('p');
  countdown.className = 'note-verification-status';
  const actions = document.createElement('div'); actions.className = 'note-verification-actions';
  const open = document.createElement('a');
  open.className = 'button button-primary'; open.href = details.url;
  open.target = '_blank'; open.rel = 'noopener noreferrer'; open.referrerPolicy = 'no-referrer';
  const updateCopy = () => {
    const copy = REASON_COPY[details.reason];
    title.textContent = copy.title; description.textContent = copy.description; open.textContent = copy.open;
    return copy;
  };
  updateCopy();
  const resume = document.createElement('button');
  resume.type = 'button'; resume.className = 'button button-secondary'; resume.textContent = '已完成，继续解析';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'note-verification-cancel'; cancel.textContent = '取消';
  actions.append(open, resume); dialog.append(title, description, status, countdown, actions, cancel);
  document.body.append(dialog);
  const openPopup = () => {
    // A manual opening must use the latest validated URL, including a refreshed JWT.
    if (popup?.isOpen() && popup.navigate(details.url)) return true;
    popup?.close(); popup = prepareVerificationPopup();
    if (popup?.navigate(details.url)) return true;
    popup?.close(); popup = null; return false;
  };
  if (popup?.isOpen()) {
    if (!popup.navigate(details.url)) { popup.close(); popup = null; }
  } else openPopup();
  status.textContent = popup ? REASON_COPY[details.reason].opened : REASON_COPY[details.reason].blocked;
  open.addEventListener('click', event => {
    if (details.expiresAt <= Date.now()) {
      event.preventDefault(); endVerification?.(new Error('验证已过期，请重新解析。')); return;
    }
    if (openPopup()) {
      event.preventDefault(); status.textContent = REASON_COPY[details.reason].opened;
    }
    // A normal trusted link remains available when window.open is blocked.
  });
  let finished = false;
  const request = action => {
    const timeout = action === 'cancel' ? 5000
      : Math.max(1, Math.min(30000, Math.floor(details.expiresAt - Date.now())));
    return fetch('/api/parse_verification', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: details.token, action }),
      signal: AbortSignal.timeout(timeout), keepalive: action === 'cancel',
    });
  };
  const cancelRemote = () => { request('cancel').catch(() => {}); };
  let endVerification;
  const leavePage = () => endVerification?.(new Error('已离开页面，解析已取消。'));
  window.addEventListener('pagehide', leavePage, { once: true });
  // A parse can finish while its cached page is away. Keep the verification
  // attached to that page and open it when the user returns.
  const showDialog = () => {
    if (!finished && document.body.isConnected !== false && !dialog.open) dialog.showModal();
  };
  window.addEventListener('brclio-page-enter', showDialog);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const end = error => {
        if (finished) return;
        finished = true; cancelRemote(); reject(error);
      };
      endVerification = end;
      const updateTime = () => {
        const seconds = Math.ceil((details.expiresAt - Date.now()) / 1000);
        if (seconds <= 0) return end(new Error('验证已过期，请重新解析。'));
        countdown.textContent = `验证窗口剩余 ${seconds} 秒。`;
      };
      cancel.addEventListener('click', () => end(new Error('已取消验证。')));
      dialog.addEventListener('cancel', event => { event.preventDefault(); end(new Error('已取消验证。')); });
      resume.addEventListener('click', async () => {
        if (finished || resume.disabled) return;
        if (details.expiresAt <= Date.now()) return end(new Error('验证已过期，请重新解析。'));
        resume.disabled = true; status.textContent = '正在继续解析……';
        try {
          const response = await request('resume');
          const result = await response.json().catch(() => ({}));
          if (finished) return;
          if (details.expiresAt <= Date.now()) return end(new Error('验证已过期，请重新解析。'));
          if (response.ok && result.success) { finished = true; resolve(result); }
          else if (response.status === 429 || result.code === 'VERIFICATION_BUSY') {
            status.textContent = '正在处理验证，请稍后再点击继续解析。';
          }
          else if (result.code === 'VERIFICATION_REQUIRED') {
            const next = verificationDetails({ ...result,
              verificationToken: result.verificationToken === undefined ? details.token : result.verificationToken,
              reason: result.reason === undefined ? details.reason : result.reason });
            if (!next || next.token !== details.token || next.engine !== details.engine
              || next.connectionPath !== details.connectionPath || next.expiresAt > originalDeadline
              || next.expiresAt > details.expiresAt) {
              return end(new Error('小红书窗口信息已失效，请重新解析。'));
            }
            details = next; open.href = next.url;
            status.textContent = updateCopy().pending;
          } else end(new Error(result.message || '继续解析失败，请重新解析。'));
        } catch {
          if (!finished) status.textContent = '连接暂时中断，可在窗口有效期内再次继续。';
        } finally { resume.disabled = false; }
      });
      updateTime(); timer = setInterval(updateTime, 1000); showDialog();
    });
  } finally {
    if (!finished) cancelRemote();
    clearInterval(timer); window.removeEventListener('pagehide', leavePage);
    window.removeEventListener('brclio-page-enter', showDialog);
    popup?.close();
    dialog.close(); dialog.remove();
    if (document.body.isConnected !== false) previousFocus?.focus?.();
  }
}
