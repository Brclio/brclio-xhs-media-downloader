// Shared iPhone benefit actions for the website and packaged desktop pages.
(() => {
  for (const card of document.querySelectorAll('[data-ios-shortcut]')) {
    const link = card.querySelector('[data-shortcut-link]');
    const button = card.querySelector('[data-shortcut-copy]');
    const status = card.querySelector('[data-shortcut-status]');
    if (!link || !button || !status) continue;

    function fallbackCopy(text) {
      const input = document.createElement('textarea');
      input.value = text;
      input.readOnly = true;
      input.style.cssText = 'position:fixed;left:-9999px;top:0';
      try {
        document.body.append(input);
        input.select();
        input.setSelectionRange(0, text.length);
        return document.execCommand('copy');
      } finally {
        input.remove();
      }
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = '';
      try {
        const text = link.href;
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(text);
        } catch {
          if (!fallbackCopy(text)) throw new Error('Copy denied');
        }
        status.textContent = '链接已复制，可发送到 iPhone 打开。';
      } catch {
        status.textContent = '未能自动复制，请长按或选中上方完整链接复制。';
      } finally {
        button.disabled = false;
        button.focus({ preventScroll: true });
      }
    });
  }
})();
