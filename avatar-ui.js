// Brclio Design System app components · © 2026 Brclio · CC BY-NC-SA 4.0
import { accountAvatarImage, prepareAvatarFile, resetAvatarImages, validateAvatarCatalog } from './lib/avatar-client.js';

export function initializeAvatarUI({ panel, bridge, onState = () => {}, isAccountBusy = () => false,
  documentImpl = globalThis.document, windowImpl = globalThis.window } = {}) {
  const document = documentImpl, window = windowImpl;
  const details = panel.querySelector('#account-details');
  if (!details) return null;
  const row = document.createElement('section');
  row.className = 'account-avatar-profile'; row.dataset.avatarUi = '';
  row.setAttribute('aria-labelledby', 'account-avatar-heading');
  row.innerHTML = `<span class="account-avatar-preview" aria-hidden="true"><span id="account-avatar-fallback">B</span><img id="account-avatar-image" alt="" width="68" height="68" hidden></span>
    <div class="account-avatar-copy"><h3 id="account-avatar-heading">我的头像</h3><p id="account-avatar-summary">用一张喜欢的图片，代表自己。</p></div>
    <button id="account-avatar-open" class="button button-secondary" type="button" aria-haspopup="dialog">更换头像</button>`;
  details.prepend(row);
  const dialog = document.createElement('dialog');
  dialog.id = 'account-avatar-dialog'; dialog.className = 'account-avatar-dialog'; dialog.dataset.avatarUi = '';
  dialog.setAttribute('aria-labelledby', 'account-avatar-title'); dialog.setAttribute('aria-describedby', 'account-avatar-description');
  dialog.innerHTML = `<div class="account-avatar-dialog-heading"><div><span class="account-eyebrow">A LITTLE MORE YOU</span><h2 id="account-avatar-title">选一张喜欢的头像</h2></div><button id="account-avatar-close" class="membership-close" type="button" aria-label="关闭头像选择" autofocus>×</button></div>
    <p id="account-avatar-description" class="account-avatar-description">100 张内置头像，也可以上传自己的图片。选择后会同步到软件账号。</p>
    <div class="account-avatar-upload"><div><strong>上传自己的头像</strong><p>支持 JPG、PNG、WebP、GIF，原图不超过 100 MB。头像会居中裁为正方形，动图使用静态画面。</p></div><button id="account-avatar-upload" class="button button-primary" type="button">选择图片</button><input id="account-avatar-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif" hidden></div>
    <p class="account-avatar-privacy">原图会私密保留用于收藏，管理员可下载收藏原图；界面仅使用压缩头像。</p>
    <div class="account-avatar-status-row"><p id="account-avatar-status" class="account-avatar-status" role="status" aria-live="polite"></p><progress id="account-avatar-progress" aria-label="正在保存头像" hidden></progress></div>
    <div class="account-avatar-catalog-heading"><h3>内置头像 <span id="account-avatar-count">100</span></h3><button id="account-avatar-retry" class="button button-secondary" type="button" hidden>重新加载</button></div>
    <div id="account-avatar-grid" class="account-avatar-grid" role="radiogroup" aria-label="选择内置头像" aria-busy="false"></div>
    <p class="account-avatar-keyboard-note">点击即可使用；键盘方向键浏览，空格或回车选择。</p>`;
  panel.append(dialog);
  const element = id => panel.querySelector(`#${id}`);
  const supported = typeof bridge.selectAccountAvatar === 'function' && typeof bridge.uploadAccountAvatar === 'function';
  let state = null, userId = '', epoch = 0, busy = false, imageRevision = 0, catalog = null, loadingCatalog = null;
  let previousFocus = null;
  const status = (message, error = false) => { element('account-avatar-status').textContent = message; element('account-avatar-status').classList.toggle('is-error', error); };
  const renderControls = () => {
    const blocked = busy || isAccountBusy() || !state?.authenticated || !state?.verified || !supported;
    element('account-avatar-open').disabled = blocked;
    element('account-avatar-upload').disabled = blocked;
    element('account-avatar-file').disabled = blocked;
    element('account-avatar-progress').hidden = !busy;
    element('account-avatar-grid').setAttribute('aria-busy', String(busy));
    for (const button of element('account-avatar-grid').querySelectorAll('button')) button.disabled = blocked;
    const selectedId = state?.account?.user?.avatar?.kind === 'builtin' ? state.account.user.avatar.id : '';
    const options = [...element('account-avatar-grid').querySelectorAll('button')];
    for (const button of options) { button.setAttribute('aria-checked', String(button.dataset.avatarId === selectedId)); button.tabIndex = -1; }
    const selected = options.find(button => button.dataset.avatarId === selectedId) || options[0];
    if (selected) selected.tabIndex = 0;
  };
  const applyReply = (reply, expectedUser) => {
    if (userId !== expectedUser) throw new Error('账号已切换，请重新选择头像。');
    if (reply?.state) onState(reply.state);
    if (!reply?.ok) throw new Error(reply?.error?.message || '头像保存失败，请重试。');
  };
  async function chooseBuiltin(id) {
    if (busy || isAccountBusy() || !userId || !state?.verified || !supported) return;
    const expectedUser = userId, current = epoch;
    busy = true; status('正在保存头像…'); renderControls();
    try {
      const reply = await bridge.selectAccountAvatar({ builtinId: id, expectedUserId: expectedUser });
      if (current !== epoch) return;
      applyReply(reply, expectedUser); status('头像已更新。');
    } catch (error) { if (current === epoch) status(error.message || '头像保存失败，请重试。', true); }
    finally { if (current === epoch) { busy = false; renderControls(); } }
  }
  async function loadCatalog() {
    if (catalog || loadingCatalog) return loadingCatalog;
    element('account-avatar-retry').hidden = true;
    loadingCatalog = (async () => {
      try {
        const response = await window.fetch(new URL('./assets/avatars/manifest.json', import.meta.url));
        if (!response.ok) throw new Error('内置头像暂时无法读取，请重试。');
        catalog = validateAvatarCatalog(await response.json());
        const fragment = document.createDocumentFragment();
        for (const item of catalog) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'account-avatar-option';
          button.dataset.avatarId = item.id; button.setAttribute('role', 'radio'); button.setAttribute('aria-label', item.name); button.title = item.name;
          const image = document.createElement('img'); image.src = item.url; image.alt = ''; image.width = image.height = 64; image.loading = 'lazy'; image.decoding = 'async';
          button.append(image); button.addEventListener('click', () => void chooseBuiltin(item.id)); fragment.append(button);
        }
        element('account-avatar-grid').replaceChildren(fragment); renderControls();
      } catch (error) { status(error.message || '内置头像暂时无法读取，请重试。', true); element('account-avatar-retry').hidden = false; }
      finally { loadingCatalog = null; }
    })();
    return loadingCatalog;
  }
  function closeDialog() { dialog.close(); }
  element('account-avatar-open').addEventListener('click', () => {
    if (element('account-avatar-open').disabled) return;
    previousFocus = element('account-avatar-open'); status(''); if (!dialog.open) dialog.showModal(); void loadCatalog();
  });
  element('account-avatar-close').addEventListener('click', closeDialog);
  dialog.addEventListener('close', () => { if (previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus({ preventScroll: true }); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });
  element('account-avatar-retry').addEventListener('click', () => { status(''); void loadCatalog(); });
  element('account-avatar-upload').addEventListener('click', () => element('account-avatar-file').click());
  element('account-avatar-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || busy || isAccountBusy() || !userId || !state?.verified || !supported) return;
    const expectedUser = userId, current = epoch;
    busy = true; renderControls();
    try {
      const input = await prepareAvatarFile(file, { documentImpl: document, onStage: message => { if (current === epoch) status(message); } });
      if (current !== epoch) return;
      status('正在上传原图并保存压缩头像，请稍候…');
      const reply = await bridge.uploadAccountAvatar({ ...input, expectedUserId: expectedUser });
      if (current !== epoch) return;
      applyReply(reply, expectedUser); status('头像已更新，原图已私密保存。');
    } catch (error) { if (current === epoch) status(error.message || '头像上传失败，请重新选择图片重试。', true); }
    finally { if (current === epoch) { busy = false; renderControls(); } }
  });
  element('account-avatar-grid').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const options = [...element('account-avatar-grid').querySelectorAll('button')];
    if (!options.length || busy) return;
    const index = options.indexOf(document.activeElement); if (index < 0) return;
    event.preventDefault();
    const columns = Math.max(1, options.filter(button => button.offsetTop === options[0].offsetTop).length);
    const shift = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + shift + options.length) % options.length;
    options.forEach((button, index) => { button.tabIndex = index === next ? 0 : -1; }); options[next].focus({ preventScroll: true }); options[next].scrollIntoView({ block: 'nearest' });
  });
  function updateAccount(value) {
    const nextUser = value?.authenticated ? value.account?.user?.id || '' : '';
    if (nextUser !== userId) { epoch++; busy = false; if (!nextUser) resetAvatarImages(bridge); if (dialog.open) dialog.close(); status(''); }
    userId = nextUser; state = value;
    const user = value?.authenticated ? value.account?.user : null;
    element('account-avatar-fallback').textContent = Array.from(user?.nickname || user?.email || 'B')[0]?.toLocaleUpperCase() || 'B';
    const revision = ++imageRevision, image = element('account-avatar-image');
    image.hidden = true; image.removeAttribute('src'); element('account-avatar-fallback').hidden = false;
    image.onerror = () => { if (revision === imageRevision) { image.hidden = true; element('account-avatar-fallback').hidden = false; } };
    void accountAvatarImage(user, bridge).then(url => { if (revision !== imageRevision || !url) return; image.src = url; image.hidden = false; element('account-avatar-fallback').hidden = true; });
    element('account-avatar-summary').textContent = !supported ? '更新客户端后即可选择头像。' : !value?.verified ? '联网刷新账号后即可更换头像。'
      : user?.avatar?.kind === 'upload' ? '自定义头像 · 原图已私密收藏' : user?.avatar?.kind === 'builtin' ? '内置头像 · 随时换个心情' : '用一张喜欢的图片，代表自己。';
    renderControls();
  }
  window.addEventListener('pagehide', () => { imageRevision++; resetAvatarImages(bridge); }, { once: true });
  return { updateAccount, renderControls };
}
