(() => {
  'use strict';
  const dialog = document.getElementById('qr-dialog');
  const openButton = document.getElementById('qr-open');
  const closeButton = document.getElementById('qr-close');
  const saveLink = document.getElementById('qr-save');
  const status = document.getElementById('qr-status');
  const androidWithoutSaveBridge = location.origin === 'https://appassets.androidplatform.net'
    && typeof window.BrclioLearning?.postMessage !== 'function';
  if (androidWithoutSaveBridge) {
    saveLink.textContent = '放大二维码并截图';
    document.querySelector('.qr-mobile-note').textContent = '截图后，可从微信「扫一扫」相册中识别。';
  }

  openButton.addEventListener('click', () => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else document.getElementById('contact').scrollIntoView({ block: 'start' });
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => openButton.focus({ preventScroll: true }));

  // Support downloads from both HTTP and the desktop app's local protocol.
  // The regular PNG link remains available when JavaScript is disabled.
  let saving = false;
  window.addEventListener('brclio-qr-save-result', (event) => {
    saving = false;
    status.textContent = typeof event.detail?.message === 'string'
      ? event.detail.message
      : '保存操作已结束。';
  });
  saveLink.addEventListener('click', async (event) => {
    event.preventDefault();
    if (saving) return;
    if (androidWithoutSaveBridge) {
      openButton.click();
      status.textContent = '请截图保存二维码，再从微信「扫一扫」相册中识别。';
      return;
    }
    saving = true;
    status.textContent = '正在准备二维码…';
    if (typeof window.BrclioLearning?.postMessage === 'function') {
      try {
        window.BrclioLearning.postMessage('saveQr');
        status.textContent = '请在系统窗口中选择二维码的保存位置。';
      } catch {
        saving = false;
        status.textContent = '暂时无法打开保存窗口，请点击二维码放大后截图。';
      }
      return;
    }
    try {
      const response = await fetch(saveLink.href);
      if (!response.ok) throw new Error('QR_FETCH_FAILED');
      const url = URL.createObjectURL(await response.blob());
      const download = document.createElement('a');
      download.href = url;
      download.download = saveLink.download;
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status.textContent = '已发起保存；也可以点击二维码放大后截图。';
    } catch {
      status.textContent = '暂时无法保存，请点击二维码放大后截图，或稍后重试。';
    } finally {
      saving = false;
    }
  });
})();
