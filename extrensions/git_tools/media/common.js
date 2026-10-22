// Shared helpers for Git Tools webviews.
/* exported gt */
const gt = (() => {
  /**
   * Creates an element: h('div.cls#id', {attr}, ...children)
   * @returns {HTMLElement}
   */
  function h(tag, attrs, ...children) {
    const [name, ...rest] = tag.split(/(?=[.#])/);
    const el = document.createElement(name || 'div');
    for (const r of rest) {
      if (r[0] === '.') el.classList.add(r.slice(1));
      else el.id = r.slice(1);
    }
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** Replaces the children of `el`, skipping null / false and flattening arrays like h(). */
  function fill(el, ...children) {
    el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  let menuEl = null;
  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }
  window.addEventListener('blur', closeMenu);
  document.addEventListener('mousedown', (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  /**
   * Shows a context menu. items: {label, id, disabled?, danger?} | '-'
   */
  function showMenu(x, y, items, onPick) {
    closeMenu();
    menuEl = h('div.menu', null, items.map((it) => (it === '-'
      ? h('div.sep')
      : h(`div.item${it.disabled ? '.disabled' : ''}${it.danger ? '.danger' : ''}`, {
        text: it.label,
        onclick: () => {
          if (it.disabled) return;
          closeMenu();
          onPick(it.id);
        },
      }))));
    document.body.append(menuEl);
    // At most the view high (CSS), scrolling inside: it fits once moved up.
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    menuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  }

  function formatDate(ms) {
    const d = new Date(ms);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = (day(now) - day(d)) / 86400000;
    if (diff === 0) return `Today ${time}`;
    if (diff === 1) return `Yesterday ${time}`;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${time}`;
  }

  /** "5 minutes ago", "3 days ago"… */
  function relativeTime(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
    let n = s;
    for (const [size, unit] of steps) {
      if (n < size) return unit === 'second' && n < 10 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`;
      n = Math.floor(n / size);
    }
    return '';
  }

  function basename(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }

  function dirname(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  // ------------------------------------------------------------- copy on hover
  // Ctrl+C (⌘C on macOS) over an element with data-copy (a branch name…)
  // copies that value; data-copy-what names it in the message. Selected text
  // is copied as usual.

  /** Element with data-copy under the mouse. */
  let hoverCopy = null;
  document.addEventListener('mouseover', (e) => {
    hoverCopy = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
  });
  document.addEventListener('mouseleave', () => { hoverCopy = null; });

  function textSelected() {
    const a = document.activeElement;
    if ((a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && a.selectionStart !== a.selectionEnd) return true;
    return String(window.getSelection() || '') !== '';
  }

  const copyTarget = () => (hoverCopy && hoverCopy.isConnected && hoverCopy.dataset.copy && !textSelected() ? hoverCopy : null);

  document.addEventListener('copy', (e) => {
    const t = copyTarget();
    if (!t || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', t.dataset.copy);
    e.preventDefault();
    toast(`Copied ${t.dataset.copyWhat || 'branch name'}: ${t.dataset.copy}`);
  });

  // With nothing selected the browser may not raise "copy" for the shortcut: raise it.
  document.addEventListener('keydown', (e) => {
    const mac = /Mac/.test(navigator.platform);
    const shortcut = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!shortcut || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c' || !copyTarget()) return;
    e.preventDefault();
    document.execCommand('copy');
  }, true);

  let toastEl = null;
  let toastTimer = null;
  /** Short message at the bottom of the view. */
  function toast(text) {
    if (!toastEl) {
      toastEl = h('div.gt-toast');
      document.body.append(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  return { h, fill, showMenu, closeMenu, formatDate, relativeTime, basename, dirname, toast };
})();
