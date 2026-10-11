// A verification session belongs only to the current parse operation.
export function verificationDetails(payload) {
  const token = payload?.verificationToken;
  const expiresAt = typeof payload?.expiresAt === 'number' ? payload.expiresAt : Date.parse(payload?.expiresAt);
  let url;
  try { url = new URL(payload?.verificationUrl); } catch { return null; }
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now() || expiresAt > Date.now() + 185000
    || url.protocol !== 'https:' || url.hostname !== 'live.browser.run'
    || url.username || url.password || (url.port && url.port !== '443')
    || url.hash || url.pathname !== '/ui/view' || url.searchParams.getAll('mode').length !== 1
    || url.searchParams.get('mode') !== 'tab' || url.searchParams.getAll('wss').length !== 1) return null;
  let socket;
  const address = url.searchParams.get('wss');
  try { socket = new URL(address.startsWith('wss://') ? address : `wss://${address}`); } catch { return null; }
  if (socket.protocol !== 'wss:' || socket.hostname !== 'live.browser.run' || socket.username || socket.password
    || socket.port || socket.hash || !/^\/api\/devtools\/browser\/[A-Za-z0-9_-]+\/page\/[A-Za-z0-9_-]+$/.test(socket.pathname)
    || socket.searchParams.getAll('jwt').length !== 1 || !socket.searchParams.get('jwt')) return null;
  return { token, expiresAt, url: url.href };
}

export async function waitForNoteVerification(payload) {
  const details = verificationDetails(payload);
  if (!details) throw new Error('验证窗口不可用或已过期，请重新解析。');
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'note-verification-dialog';
  dialog.setAttribute('aria-labelledby', 'note-verification-title');
  const title = document.createElement('h2');
  title.id = 'note-verification-title'; title.textContent = '完成小红书安全验证';
  const description = document.createElement('p');
  description.textContent = '这篇笔记需要安全验证。在验证窗口完成后，回到这里继续解析。';
  const status = document.createElement('p');
  status.className = 'note-verification-status'; status.setAttribute('role', 'status');
  const countdown = document.createElement('p');
  countdown.className = 'note-verification-status';
  const actions = document.createElement('div'); actions.className = 'note-verification-actions';
  const open = document.createElement('a');
  open.className = 'button button-primary'; open.href = details.url;
  open.target = '_blank'; open.rel = 'noopener noreferrer'; open.referrerPolicy = 'no-referrer';
  open.textContent = '打开验证窗口';
  const resume = document.createElement('button');
  resume.type = 'button'; resume.className = 'button button-secondary'; resume.textContent = '已完成，继续解析';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'note-verification-cancel'; cancel.textContent = '取消';
  actions.append(open, resume); dialog.append(title, description, status, countdown, actions, cancel);
  document.body.append(dialog);
  let finished = false;
  const request = action => fetch('/api/parse_verification', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: details.token, action }),
    signal: AbortSignal.timeout(20000), keepalive: action === 'cancel',
  });
  const cancelRemote = () => { request('cancel').catch(() => {}); };
  window.addEventListener('pagehide', cancelRemote, { once: true });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const end = error => {
        if (finished) return;
        finished = true; cancelRemote(); reject(error);
      };
      const updateTime = () => {
        const seconds = Math.ceil((details.expiresAt - Date.now()) / 1000);
        if (seconds <= 0) return end(new Error('验证已过期，请重新解析。'));
        countdown.textContent = `验证窗口剩余 ${seconds} 秒。`;
      };
      cancel.addEventListener('click', () => end(new Error('已取消验证。')));
      dialog.addEventListener('cancel', event => { event.preventDefault(); end(new Error('已取消验证。')); });
      resume.addEventListener('click', async () => {
        if (finished || resume.disabled) return;
        resume.disabled = true; status.textContent = '正在继续解析……';
        try {
          const response = await request('resume');
          const result = await response.json().catch(() => ({}));
          if (finished) return;
          if (response.ok && result.success) { finished = true; resolve(result); }
          else if (result.code === 'VERIFICATION_REQUIRED') {
            status.textContent = '验证尚未完成，请先在验证窗口完成验证。';
          } else end(new Error(result.message || '继续解析失败，请重新解析。'));
        } catch {
          if (!finished) status.textContent = '连接暂时中断，可在窗口有效期内再次继续。';
        } finally { resume.disabled = false; }
      });
      updateTime(); timer = setInterval(updateTime, 1000); dialog.showModal();
    });
  } finally {
    if (!finished) cancelRemote();
    clearInterval(timer); window.removeEventListener('pagehide', cancelRemote);
    dialog.close(); dialog.remove(); previousFocus?.focus?.();
  }
}
