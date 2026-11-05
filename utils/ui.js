/**
 * UI Regression Detector - tiny in-page toast / confirm helpers.
 * Replaces alert()/confirm(), which are unreliable in extension popups.
 */

function ensureStyles() {
  if (document.getElementById('urd-ui-styles')) return;
  const style = document.createElement('style');
  style.id = 'urd-ui-styles';
  style.textContent = `
    .urd-toast-wrap{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:99999;max-width:min(380px,calc(100vw - 32px))}
    .urd-toast{background:#1e293b;color:#f8fafc;border:1px solid rgba(255,255,255,.15);border-left:4px solid #06b6d4;border-radius:8px;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)}
    .urd-toast.error{border-left-color:#f43f5e}.urd-toast.warn{border-left-color:#f59e0b}.urd-toast.success{border-left-color:#10b981}
    .urd-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100000;padding:16px}
    .urd-modal{background:#0f172a;color:#f8fafc;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:18px;max-width:340px;width:100%;font:13px/1.5 system-ui,sans-serif}
    .urd-modal p{margin:0 0 14px}.urd-modal-actions{display:flex;gap:8px;justify-content:flex-end}
    .urd-modal button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:#1e293b;color:inherit;cursor:pointer}
    .urd-modal button.danger{background:#e11d48;border-color:#e11d48}
  `;
  document.head.appendChild(style);
}

export function toast(message, type = 'info', ms = 4000) {
  ensureStyles();
  let wrap = document.querySelector('.urd-toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'urd-toast-wrap';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = `urd-toast ${type}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * Generic modal. build(container, close) fills the dialog; returns { close }.
 */
export function openModal(build, { maxWidth = 560, onClose = null } = {}) {
  ensureStyles();
  const bg = document.createElement('div');
  bg.className = 'urd-modal-bg';
  const modal = document.createElement('div');
  modal.className = 'urd-modal';
  modal.style.maxWidth = `${maxWidth}px`;
  modal.style.maxHeight = '85vh';
  modal.style.overflowY = 'auto';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  bg.appendChild(modal);
  document.body.appendChild(bg);

  const close = () => {
    bg.remove();
    if (onClose) onClose();
  };
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  build(modal, close);
  return { close };
}

export function confirmDialog(message, confirmLabel = 'Delete') {
  ensureStyles();
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'urd-modal-bg';
    const modal = document.createElement('div');
    modal.className = 'urd-modal';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    const p = document.createElement('p');
    p.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'urd-modal-actions';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'danger';
    ok.textContent = confirmLabel;
    actions.append(cancel, ok);
    modal.append(p, actions);
    bg.appendChild(modal);
    document.body.appendChild(bg);

    const done = (val) => { bg.remove(); resolve(val); };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
    bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
    cancel.focus();
  });
}
