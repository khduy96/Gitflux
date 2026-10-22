// Interactive Rebase panel (Android Studio "Rebasing Commits" dialog) and the
// commit message dialog of Edit Commit Message / Squash Commits.
//
// `items` stay in todo order (oldest first, as git runs them); the list shows
// them reversed, newest on top like the Log. Up = newer = later in the todo,
// and a squash / fixup row melds into the row below it.
(() => {
  const vscode = acquireVsCodeApi();
  const { h, formatDate } = gt;
  const app = document.getElementById('app');

  const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
  const KEYS = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
  const HINTS = {
    pick: 'use the commit',
    reword: 'use the commit, edit its message',
    edit: 'stop after the commit to amend it',
    squash: 'meld into the older commit below, combine messages',
    fixup: 'meld into the older commit below, keep its message',
    drop: 'remove the commit',
  };

  const post = (type, d = {}) => vscode.postMessage({ type, ...d });

  let plan = null;
  let original = [];
  let items = [];
  let analysis = { errors: [], warnings: [], groups: [] };
  let stale = false;
  let selected = new Set();
  let primary = null;
  let seq = 0;
  let dragFrom = -1;

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'init') {
      plan = msg.plan;
      original = msg.items;
      items = clone(original);
      analysis = msg.analysis;
      stale = false;
      const first = [...items].reverse().find((it) => it.kind === 'commit');
      primary = first ? first.id : null;
      selected = new Set(primary === null ? [] : [primary]);
      renderPanel();
    } else if (msg.type === 'analysis') {
      if (msg.seq !== seq) return; // an older answer
      analysis = msg.analysis;
      renderList();
      renderProblems();
      renderSide(false);
    } else if (msg.type === 'stale') {
      stale = msg.stale;
      renderNotice();
      renderButtons();
    } else if (msg.type === 'messageDialog') {
      renderMessageDialog(msg);
    }
  });

  const clone = (list) => list.map((it) => ({ ...it }));
  const indexOf = (id) => items.findIndex((it) => it.id === id);
  const shortHash = (it) => (it.short && it.short.length <= 12 ? it.short : it.hash.slice(0, 8));

  /** Sends the edit to the extension, which validates it and groups squashes. */
  function changed() {
    seq++;
    post('validate', { seq, items: edited() });
  }

  function edited() {
    return items.map((it) => ({ id: it.id, action: it.action, newMessage: it.newMessage, groupMessage: it.groupMessage }));
  }

  /** Moves item `from` to `to` when only commit lines lie in between (same run). */
  function canMove(from, to) {
    if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return false;
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) if (items[i].kind !== 'commit') return false;
    return true;
  }

  function move(from, to) {
    if (!canMove(from, to)) return false;
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    changed();
    renderList();
    return true;
  }

  function setAction(action) {
    let any = false;
    for (const it of items) {
      if (selected.has(it.id) && it.kind === 'commit' && it.action !== action) {
        it.action = action;
        any = true;
      }
    }
    if (!any) return;
    changed();
    renderList();
    renderSide(true);
  }

  function select(id, ctrl, shift) {
    if (ctrl) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    } else if (shift && primary !== null) {
      const a = indexOf(primary);
      const b = indexOf(id);
      selected = new Set(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((it) => it.id));
    } else {
      selected = new Set([id]);
    }
    if (!shift) primary = id;
    renderList();
    renderSide(true);
  }

  // ------------------------------------------------------------- layout

  let listEl;
  let sideEl;
  let noticeEl;
  let problemsEl;
  let buttonsEl;
  let messageBox = null;

  function renderPanel() {
    document.body.classList.remove('dialog');
    listEl = h('div#list', { tabindex: '0', onkeydown: onListKey });
    sideEl = h('div#side');
    noticeEl = h('div#notice');
    problemsEl = h('div#problems');
    buttonsEl = h('div.buttons');
    const commits = original.filter((it) => it.kind === 'commit').length;
    app.replaceChildren(
      h('div#top', null,
        h('b', null, 'Rebasing ', h('span', { text: plan.branch, 'data-copy': plan.branch })),
        h('span.muted', { text: `onto ${plan.base || 'the root'} · ${commits} commit${commits === 1 ? '' : 's'}${plan.rebaseMerges ? ' · merges are kept (--rebase-merges)' : ''}` })),
      noticeEl,
      h('div#main', null, listEl, sideEl),
      problemsEl,
      h('div#bottom', null,
        h('span.muted.hint', { text: 'Drag or Alt+↑/↓ to reorder · P R E S F D to set the action · newest commit first' }),
        h('span.spacer'),
        buttonsEl));
    renderNotice();
    renderList();
    renderSide(true);
    renderProblems();
    renderButtons();
    listEl.focus();
  }

  function renderNotice() {
    noticeEl.replaceChildren();
    if (plan.pushed) {
      noticeEl.append(h('div.warn', {
        text: `⚠ ${plan.pushed} of these commits ${plan.pushed === 1 ? 'is' : 'are'} already pushed to ${plan.upstream}: you will need to force push after rebasing.`,
      }));
    }
    if (stale) {
      noticeEl.append(h('div.warn', null,
        h('span', { text: `⚠ ${plan.branch} changed since this list was made. ` }),
        h('button.secondary', { text: 'Reload', onclick: () => post('reload') })));
    }
    noticeEl.hidden = !noticeEl.childElementCount;
  }

  function renderButtons() {
    buttonsEl.replaceChildren(
      h('button.secondary', {
        text: 'Reset',
        title: 'Back to the original order and actions',
        onclick: () => {
          items = clone(original);
          changed();
          renderList();
          renderSide(true);
        },
      }),
      h('button.secondary', { text: 'Cancel', onclick: () => post('cancel') }),
      h('button', {
        text: 'Start Rebasing',
        disabled: stale || analysis.errors.length > 0,
        onclick: () => post('start', { seq, items: edited() }),
      }));
  }

  function renderProblems() {
    problemsEl.replaceChildren(
      ...[...analysis.errors].reverse().map((e) => h('div.error', { text: `✖ ${e.message}` })),
      ...analysis.warnings.map((w) => h('div.warning', { text: `⚠ ${w}` })));
    problemsEl.hidden = !problemsEl.childElementCount;
    if (buttonsEl) renderButtons();
  }

  /** Group (head + melded commits) of the item at index i. */
  const groupAt = (i) => analysis.groups.find((g) => g.members.includes(i));

  function renderList() {
    const y = listEl.scrollTop;
    const errorAt = new Set(analysis.errors.map((e) => e.index));
    const rows = items.map((it, i) => {
      const cls = `${selected.has(it.id) ? '.selected' : ''}${errorAt.has(i) ? '.invalid' : ''}`;
      if (it.kind !== 'commit') {
        return h(`div.row.structural${cls}`, {
          title: 'Merge structure line (kept as is)',
          onclick: (e) => select(it.id, e.ctrlKey || e.metaKey, e.shiftKey),
        },
        h('span.action', null, h('span.verb', { text: it.verb })),
        h('span.text.mono.ellipsis', { text: it.text }));
      }
      const g = groupAt(i);
      const melded = g && g.head !== i;
      const box = h('select.action', {
        title: HINTS[it.action],
        onchange: (e) => {
          if (!selected.has(it.id)) select(it.id, false, false);
          setAction(e.target.value);
        },
        onclick: (e) => e.stopPropagation(),
      }, ACTIONS.map((a) => h('option', { value: a, text: a, selected: a === it.action })));
      const reworded = (it.action === 'reword' && it.newMessage !== undefined) || (g && g.head === i && g.squash);
      return h(`div.row.commit.a-${it.action}${cls}`, {
        draggable: 'true',
        onclick: (e) => select(it.id, e.ctrlKey || e.metaKey, e.shiftKey),
        ondragstart: (e) => {
          dragFrom = i;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(it.id));
        },
        ondragend: () => {
          dragFrom = -1;
          clearDrop();
        },
        ondragover: (e) => {
          if (!canMove(dragFrom, i)) return;
          e.preventDefault();
          clearDrop();
          // Shown reversed: a newer position (higher index) is above the dragged row.
          e.currentTarget.classList.add(i > dragFrom ? 'drop-before' : 'drop-after');
        },
        ondrop: (e) => {
          e.preventDefault();
          const from = dragFrom;
          dragFrom = -1;
          clearDrop();
          if (move(from, i)) select(it.id, false, false);
        },
      },
      h('span.action', null, box),
      h('span.hash.mono', { text: shortHash(it) }),
      h('span.subject.ellipsis', { title: it.message || it.subject },
        melded ? h('span.muted', { title: `Melded into ${shortHash(items[g.head])} below`, text: '↓ ' }) : null,
        it.subject,
        reworded ? h('span.badge', { text: ' ✎' }) : null),
      h('span.author.ellipsis', { text: it.author || '' }),
      h('span.date', { text: it.time ? formatDate(it.time) : '' }));
    });
    listEl.replaceChildren(
      h('div.row.header', null,
        h('span.action', { text: 'Action' }), h('span.hash', { text: 'Hash' }), h('span.subject', { text: 'Subject' }),
        h('span.author', { text: 'Author' }), h('span.date', { text: 'Date' })),
      ...rows.reverse());
    listEl.scrollTop = y;
  }

  function clearDrop() {
    for (const el of listEl.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  }

  /**
   * Right side: message editor for a reworded commit or a squash group,
   * otherwise the commit message for reference. `force` rebuilds it even
   * while the user is typing.
   */
  function renderSide(force) {
    if (!force && messageBox && document.activeElement === messageBox) return;
    messageBox = null;
    const i = indexOf(primary);
    const it = items[i];
    if (!it) {
      sideEl.replaceChildren(h('div.empty', { text: 'Select a commit' }));
      return;
    }
    if (it.kind !== 'commit') {
      sideEl.replaceChildren(h('div.title', { text: it.verb }),
        h('div.muted', { text: 'Lines like this one rebuild the merges of the range. They are kept as they are: commits can be reordered only between them.' }));
      return;
    }
    const g = groupAt(i);
    const head = g ? items[g.head] : null;
    if (g && g.squash) {
      editor(`Message of the commit squashed from ${g.members.length} commits`, g.message || '', (v) => { head.groupMessage = v; },
        () => { head.groupMessage = undefined; });
      return;
    }
    if (head && head.action === 'reword') {
      editor(`New message of ${shortHash(head)}`, head.newMessage !== undefined ? head.newMessage : head.message || head.subject,
        (v) => { head.newMessage = v; }, () => { head.newMessage = undefined; });
      return;
    }
    const note = it.action === 'fixup' || it.action === 'squash'
      ? (g ? `Melded into ${shortHash(items[g.head])}.` : 'Nothing to meld into.')
      : `${HINTS[it.action][0].toUpperCase()}${HINTS[it.action].slice(1)}. Choose "reword" to change the message.`;
    sideEl.replaceChildren(
      h('div.title', { text: `${shortHash(it)} · ${it.author || ''}` }),
      h('div.message.mono', { text: it.message || it.subject }),
      h('div.muted.note', { text: note }));
  }

  function editor(title, value, set, reset) {
    messageBox = h('textarea.message.mono', {
      spellcheck: 'false',
      oninput: (e) => {
        set(e.target.value);
        changed();
      },
    });
    messageBox.value = value;
    sideEl.replaceChildren(
      h('div.title', null, h('span', { text: title }), h('span.spacer'),
        h('button.icon', {
          text: '↺',
          title: 'Default message',
          onclick: () => {
            reset();
            changed();
            renderSide(true);
          },
        })),
      messageBox);
  }

  function onListKey(e) {
    if (e.target !== listEl) return;
    const i = indexOf(primary);
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      e.preventDefault();
      if (i >= 0) move(i, i + (e.key === 'ArrowUp' ? 1 : -1));
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const j = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowUp' ? 1 : -1)));
      if (items[j]) {
        select(items[j].id, false, false);
        const row = listEl.children[items.length - j];
        if (row) row.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    const action = KEYS[e.key.toLowerCase()];
    if (action && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setAction(action);
    }
  }

  // ------------------------------------------------------------- message dialog

  function renderMessageDialog(o) {
    document.body.classList.add('dialog');
    const box = h('textarea.message.mono', { spellcheck: 'false' });
    box.value = o.message;
    const error = h('div.error');
    const ok = h('button', { text: o.okLabel });
    const check = () => {
      const empty = !box.value.trim();
      ok.disabled = empty;
      error.textContent = empty ? 'The commit message cannot be empty.' : '';
    };
    const submit = () => {
      if (box.value.trim()) post('ok', { text: box.value });
    };
    box.addEventListener('input', check);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        post('cancel');
      }
    });
    ok.addEventListener('click', submit);
    app.replaceChildren(
      h('div#top', null, h('b', { text: o.title })),
      h('div.muted.hint', { text: o.detail }),
      box,
      error,
      h('div#bottom', null,
        h('span.muted.hint', { text: 'Ctrl+Enter to confirm' }),
        h('span.spacer'),
        h('div.buttons', null, h('button.secondary', { text: 'Cancel', onclick: () => post('cancel') }), ok)));
    check();
    box.focus();
  }

  post('ready');
})();
