// Reflog panel: where HEAD (or the current branch) pointed, newest first.
(() => {
  const vscode = acquireVsCodeApi();
  const { h, fill, showMenu, relativeTime } = gt;

  let data = { repo: null, ref: 'HEAD', branch: null, head: null, entries: [], loading: true, error: null, max: 500 };
  let selected = null; // selector

  const refSel = h('select#ref', { title: 'Whose reflog is shown' });
  const status = h('span.muted#status');
  const refresh = h('button.icon', { title: 'Refresh', text: '⟳', onclick: () => post('refresh') });
  const toolbar = h('div#toolbar', null, h('span.muted', { text: 'Reflog of' }), refSel, h('span.spacer'), status, refresh);
  const list = h('div#list', { tabindex: '0' });
  document.getElementById('app').append(toolbar, list);

  const post = (type, d = {}) => vscode.postMessage({ type, ...d });

  refSel.addEventListener('change', () => post('setRef', { ref: refSel.value }));

  list.addEventListener('keydown', (e) => {
    const entries = data.entries;
    if (!entries.length) return;
    const i = entries.findIndex((x) => x.selector === selected);
    const delta = { ArrowDown: 1, ArrowUp: -1, PageDown: 20, PageUp: -20 }[e.key];
    if (delta) {
      e.preventDefault();
      selected = entries[Math.max(0, Math.min(entries.length - 1, i + delta))].selector;
      render();
      const row = list.querySelector('.rrow.selected');
      if (row) row.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && i >= 0 && !entries[i].missing) {
      post('action', { action: 'log', selector: selected, hash: entries[i].hash });
    }
  });

  window.addEventListener('message', (e) => {
    if (e.data.type !== 'reflog') return;
    data = e.data.data;
    if (selected && !data.entries.some((x) => x.selector === selected)) selected = null;
    renderToolbar();
    render();
  });

  function renderToolbar() {
    fill(refSel,
      h('option', { value: 'HEAD', text: 'HEAD' }),
      data.branch ? h('option', { value: 'branch', text: data.branch }) : null,
    );
    refSel.value = data.ref === 'branch' && data.branch ? 'branch' : 'HEAD';
    refSel.disabled = !data.repo;
    const n = data.entries.length;
    status.replaceChildren(
      data.loading ? h('span.spinner') : '',
      ` ${data.repo ? `${data.repo} · ${n} entr${n === 1 ? 'y' : 'ies'}${n >= data.max ? ' (newest)' : ''}` : 'No repository'}`,
    );
  }

  function render() {
    list.replaceChildren();
    if (data.error) {
      list.append(h('div.empty', { text: data.error }));
      return;
    }
    if (!data.entries.length) {
      list.append(h('div.empty', { text: data.loading ? 'Loading…' : data.repo ? 'The reflog is empty' : 'No repository' }));
      return;
    }
    for (const e of data.entries) {
      const time = e.time ? new Date(e.time) : null;
      list.append(h(`div.rrow${e.missing ? '.missing' : ''}${e.selector === selected ? '.selected' : ''}${e.hash && e.hash === data.head && !e.missing ? '.head' : ''}`, {
        title: `${e.selector}\n${e.hash}${e.missing ? ' (commit no longer exists)' : ''}\n${e.action}${e.message ? `: ${e.message}` : ''}`,
        onclick: () => select(e),
        ondblclick: () => { if (!e.missing) post('action', { action: 'log', selector: e.selector, hash: e.hash }); },
        oncontextmenu: (ev) => {
          ev.preventDefault();
          select(e);
          menu(ev.clientX, ev.clientY, e);
        },
      },
      h('span.sel.mono', { text: e.selector }),
      h('span.hash.mono', { text: e.hash ? e.hash.slice(0, 8) : '' }),
      h('span.action.ellipsis', { text: e.action }),
      h('span.message.ellipsis', { text: e.missing ? `(commit no longer exists)${e.message ? ` ${e.message}` : ''}` : e.message }),
      h('span.time', { text: time ? relativeTime(e.time) : '', title: time ? time.toLocaleString() : '' })));
    }
  }

  function select(e) {
    selected = e.selector;
    list.focus();
    render();
  }

  function menu(x, y, e) {
    const off = e.missing || !e.hash;
    showMenu(x, y, [
      { label: 'Show in Log', id: 'log', disabled: off },
      '-',
      { label: `Checkout Revision '${e.hash.slice(0, 8)}'`, id: 'checkout', disabled: off },
      { label: 'New Branch Here…', id: 'branch', disabled: off },
      { label: 'Reset Current Branch to Here…', id: 'reset', disabled: off },
      '-',
      { label: 'Copy Revision Number', id: 'copy', disabled: off },
    ], (action) => post('action', { action, selector: e.selector, hash: e.hash }));
  }

  renderToolbar();
  render();
  post('ready');
})();
