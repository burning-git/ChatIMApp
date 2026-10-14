document.addEventListener('click', async function (event) {
  const button = event.target.closest('[data-copy-text]');
  if (!button || button.disabled) return;
  const text = button.getAttribute('data-copy-text');
  button.disabled = true;
  let copied = false;
  try {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); copied = true; } catch (_) {}
    }
    if (!copied) {
      const focused = document.activeElement;
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.readOnly = true;
      textarea.setAttribute('aria-hidden', 'true');
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;font-size:16px';
      document.body.appendChild(textarea);
      try {
        textarea.focus({ preventScroll: true });
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        copied = document.execCommand('copy');
      } finally {
        textarea.remove();
        if (focused && focused.focus) focused.focus({ preventScroll: true });
      }
    }
  } catch (_) {}
  const status = button.parentElement.querySelector('.copy-status');
  if (copied) {
    button.textContent = '已复制';
    status.textContent = '已复制到剪贴板';
  } else {
    const content = button.closest('article').querySelector('.message-content');
    const selection = window.getSelection();
    if (content && selection) {
      const range = document.createRange();
      range.selectNodeContents(content);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    status.textContent = '自动复制不可用，请复制已选中的文字';
  }
  button.disabled = false;
  window.setTimeout(function () { button.textContent = '复制'; status.textContent = ''; }, 3000);
});
