// Commit view: changes tree with checkboxes, commit message and buttons.
(() => {
  const vscode = acquireVsCodeApi();
  const { h, fill, showMenu, basename, dirname } = gt;

  const saved = vscode.getState() || {};
  let state = null;
  const collapsed = new Set(saved.collapsed || []);
  let selected = new Set();
  let anchor = null;
  let messageFocused = false;

  const app = document.getElementById('app');
  const banner = h('div#banner');
  const tree = h('div#tree', { tabindex: '0' });
  const amend = h('input', { type: 'checkbox', id: 'amend' });
  const signOff = h('input', { type: 'checkbox', id: 'signOff' });
  const sign = h('input', { type: 'checkbox', id: 'sign' });
  const signLabel = h('label.amend', null, sign, ' Sign commit');
  const genBtn = h('button.icon#gen', { title: 'Generate Commit Message' }, '✨');
  const message = h('textarea#message', { rows: '5', placeholder: 'Commit Message' });
  const commitBtn = h('button#commit', { text: 'Commit' });
  const pushBtn = h('button.secondary#commitPush', { text: 'Commit and Push…' });
  const count = h('span.muted#count');
  const bottom = h('div#bottom', null,
    h('div.row.options', null,
      h('label.amend', { title: 'Replace the last commit (git commit --amend)' }, amend, ' Amend'),
      h('label.amend', { title: 'Add a Signed-off-by trailer (git commit --signoff)' }, signOff, ' Sign-off'),
      signLabel,
      h('span.spacer'),
      genBtn),
    message,
    h('div.row', null, commitBtn, pushBtn, h('span.spacer'), count));
  app.append(banner, tree, bottom);

  const post = (type, data = {}) => vscode.postMessage({ type, ...data });
  const persist = () => vscode.setState({ collapsed: [...collapsed] });

  // ------------------------------------------------------------- events

  amend.addEventListener('change', () => post('amend', { value: amend.checked }));
  signOff.addEventListener('change', () => post('option', { name: 'signOff', value: signOff.checked }));
  sign.addEventListener('change', () => post('option', { name: 'sign', value: sign.checked }));
  genBtn.addEventListener('click', () => post(state && state.generating ? 'cancelGenerate' : 'generate'));
  message.addEventListener('input', () => post('message', { text: message.value }));
  message.addEventListener('focus', () => { messageFocused = true; });
  message.addEventListener('blur', () => { messageFocused = false; });
  message.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      post('commit', { push: false });
    }
  });
  commitBtn.addEventListener('click', () => post('commit', { push: false }));
  pushBtn.addEventListener('click', () => post('commit', { push: true }));

  tree.addEventListener('keydown', (e) => {
    if (!state) return;
    const files = visibleFiles();
    const sel = [...selected];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      let i = files.findIndex((f) => f.path === anchor);
      i = Math.max(0, Math.min(files.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      if (files[i]) select(files[i], false, false, true);
    } else if (e.key === ' ' && sel.length) {
      e.preventDefault();
      const changes = state.changes.filter((c) => selected.has(c.path) && c.type !== 'conflicted');
      post('toggle', { paths: changes.map((c) => c.path), value: !changes.every((c) => c.included) });
    } else if (e.key === 'Enter' && sel.length) {
      post('open', { path: sel[0], preview: false });
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      selected = new Set(files.map((f) => f.path));
      render();
    } else if (e.key === 'Delete' && sel.length) {
      post('menu', { action: 'rollback', paths: sel });
    } else if (e.key === 'F6' && sel.length) {
      // F6: Move to Another Changelist (Android Studio shortcut).
      e.preventDefault();
      const tracked = state.changes.filter((c) => selected.has(c.path) && c.type !== 'untracked');
      if (tracked.length) post('menu', { action: 'moveToList', paths: tracked.map((c) => c.path) });
    } else if ((e.key === 'a' || e.key === 'A') && e.ctrlKey && e.altKey) {
      // Ctrl+Alt+A: Add to VCS (Android Studio shortcut).
      e.preventDefault();
      const untracked = state.changes.filter((c) => selected.has(c.path) && c.type === 'untracked');
      if (untracked.length) post('addToVcs', { paths: untracked.map((c) => c.path) });
    }
  });

  // ------------------------------------------------------------- drag & drop
  // Files dropped on another changelist move to it; unversioned files
  // dropped on a changelist are added to git in that list; newly added files
  // dropped on "Unversioned Files" are removed from the index again.

  /** paths: files to move; added: those of them that can be unversioned. @type {{from: string, paths: string[], added: string[]}|null} */
  let dragging = null;

  /** Group key of a changelist: "cl:<id>". */
  const isList = (key) => !!key && key.startsWith('cl:');

  const dropAllowed = (to) => !!dragging && (
    (dragging.from === 'unversioned' && isList(to)) ||
    (isList(dragging.from) && isList(to) && to !== dragging.from && dragging.paths.length > 0) ||
    (isList(dragging.from) && to === 'unversioned' && dragging.added.length > 0));

  function clearDropHighlight() {
    for (const el of tree.querySelectorAll('.drop')) el.classList.remove('drop');
  }

  function highlight(group) {
    clearDropHighlight();
    for (const el of tree.querySelectorAll(`[data-group="${group}"]`)) el.classList.add('drop');
  }

  tree.addEventListener('dragover', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-group]') : null;
    const to = target ? target.getAttribute('data-group') : null;
    if (!to || !dropAllowed(to)) {
      clearDropHighlight();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    highlight(to);
  });

  tree.addEventListener('dragleave', (e) => {
    if (!tree.contains(/** @type {Node} */ (e.relatedTarget))) clearDropHighlight();
  });

  tree.addEventListener('drop', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-group]') : null;
    const to = target ? target.getAttribute('data-group') : null;
    clearDropHighlight();
    if (!to || !dropAllowed(to)) return;
    e.preventDefault();
    if (dragging.from === 'unversioned') post('addToVcs', { paths: dragging.paths, list: to.slice(3) });
    else if (to === 'unversioned') post('unversion', { paths: dragging.added });
    else post('moveToList', { paths: dragging.paths, list: to.slice(3) });
    dragging = null;
  });

  /** Files of group `g` that can be dragged out of it (nested repositories are registered, not added). */
  const movable = (g, c) => !c.nestedRepo && (g.key === 'unversioned' ? c.type === 'untracked' : isList(g.key) && c.type !== 'conflicted');

  function onDragStart(e, g, f) {
    // Drag the selected files of this group when the row is part of the selection.
    const files = (selected.has(f.path) ? g.files.filter((c) => selected.has(c.path)) : [f]).filter((c) => movable(g, c));
    startDrag(e, g, files, files.length === 1 ? basename(files[0].path) : `${files.length} files`);
  }

  /** Dragging a folder moves every file below it. */
  function onDirDragStart(e, g, d, files) {
    startDrag(e, g, files, `${d.name}/ (${files.length} file${files.length === 1 ? '' : 's'})`);
  }

  function startDrag(e, g, files, label) {
    const paths = files.map((c) => c.path);
    dragging = { from: g.key, paths, added: files.filter((c) => c.type === 'added').map((c) => c.path) };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    const ghost = h('div.dragghost', { text: label });
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, -10, -10);
    setTimeout(() => ghost.remove(), 0);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'state') {
      state = msg.state;
      const paths = new Set(state.changes.map((c) => c.path));
      selected = new Set([...selected].filter((p) => paths.has(p)));
      render();
    } else if (msg.type === 'message') {
      if (message.value !== msg.text && (!messageFocused || msg.force)) message.value = msg.text;
    } else if (msg.type === 'focusMessage') {
      message.focus();
    }
  });

  // ------------------------------------------------------------- render

  /**
   * Merge Conflicts, one group per changelist (key "cl:<id>"; empty lists
   * other than the active one only with "Show Empty Changelists"), then
   * Unversioned Files.
   */
  function groups() {
    const c = state.changes;
    const lists = state.changelists || [];
    const ids = new Set(lists.map((l) => l.id));
    const tracked = c.filter((x) => x.type !== 'conflicted' && x.type !== 'untracked');
    const listGroups = lists.map((l) => ({
      key: `cl:${l.id}`,
      list: l,
      label: l.active ? `${l.name} (active)` : l.name,
      // A file of an unknown list shows in the active one (as git-tools assigns it).
      files: tracked.filter((x) => x.list === l.id || (l.active && !ids.has(x.list))),
      checkable: true,
      hideEmpty: !l.active && !state.showEmptyChangelists,
    }));
    if (!listGroups.length) listGroups.push({ key: 'cl:default', list: null, label: 'Changes', files: tracked, checkable: true, hideEmpty: false });
    return [
      { key: 'conflicts', label: 'Merge Conflicts', files: c.filter((x) => x.type === 'conflicted'), checkable: false, hideEmpty: true },
      ...listGroups,
      { key: 'unversioned', label: 'Unversioned Files', files: c.filter((x) => x.type === 'untracked'), checkable: true, hideEmpty: true },
    ].filter((g) => !(g.hideEmpty && !g.files.length));
  }

  /** Files in the order they are rendered (for keyboard navigation). */
  let order = [];
  function visibleFiles() {
    return order;
  }

  /** Builds a directory tree; single-child directory chains are merged ("a/b/c"). */
  function buildTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const f of files) {
      const dir = dirname(f.path);
      let node = root;
      if (dir) {
        for (const part of dir.split('/')) {
          if (!node.dirs.has(part)) {
            node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
          }
          node = node.dirs.get(part);
        }
      }
      node.files.push(f);
    }
    const compress = (node) => {
      for (const [key, child] of [...node.dirs]) {
        let c = child;
        while (!c.files.length && c.dirs.size === 1) {
          const only = c.dirs.values().next().value;
          c = { name: `${c.name}/${only.name}`, path: only.path, dirs: only.dirs, files: only.files };
        }
        node.dirs.set(key, c);
        compress(c);
      }
    };
    compress(root);
    return root;
  }

  function filesUnder(node) {
    return [...node.files, ...[...node.dirs.values()].flatMap(filesUnder)];
  }

  function checkbox(files) {
    const n = files.filter((f) => f.included).length;
    const box = h('input', {
      type: 'checkbox',
      checked: files.length > 0 && n === files.length,
      disabled: !files.length,
      onchange: (e) => post('toggle', { paths: files.map((f) => f.path), value: e.target.checked }),
    });
    if (n > 0 && n < files.length) box.indeterminate = true;
    return box;
  }

  function select(f, ctrl, shift, open) {
    if (ctrl) {
      if (selected.has(f.path)) selected.delete(f.path);
      else selected.add(f.path);
      anchor = f.path;
    } else if (shift && anchor) {
      const files = visibleFiles().map((x) => x.path);
      const a = files.indexOf(anchor);
      const b = files.indexOf(f.path);
      if (a >= 0 && b >= 0) selected = new Set(files.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else {
      selected = new Set([f.path]);
      anchor = f.path;
      if (open && f.type !== 'conflicted') post('open', { path: f.path, preview: true });
    }
    render();
    const row = tree.querySelector(`[data-path="${CSS.escape(f.path)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    if (!state) return;
    renderBanner();
    const scroll = tree.scrollTop;
    tree.replaceChildren();
    order = [];
    if (!state.repo) {
      tree.append(h('div.empty', { text: 'No Git repository found in this workspace.' }));
      return;
    }
    for (const g of groups()) {
      const isCollapsed = collapsed.has(g.key);
      const n = g.files.filter((f) => f.included).length;
      // Dragging the header moves every file of the group that can move.
      const dragFiles = g.files.filter((c) => movable(g, c));
      const dragHint = !dragFiles.length ? ''
        : g.key === 'unversioned' ? 'Drag to a changelist to add all these files to Git.'
          : 'Drag to another changelist to move all its files.';
      const header = h(`div.row.group${g.list ? '.changelist' : ''}${g.list && g.list.active ? '.active' : ''}`, {
        'data-group': g.key,
        title: [g.list ? (g.list.active
          ? `${g.list.name}: the active changelist. New changes go here and its files are ticked.`
          : `${g.list.name}: right-click to make it active, edit or delete it. Drop files here to move them.`) : '', dragHint]
          .filter(Boolean).join('\n') || null,
        draggable: dragFiles.length ? 'true' : null,
        ondragstart: dragFiles.length
          ? (e) => startDrag(e, g, dragFiles, `${g.label} (${dragFiles.length} file${dragFiles.length === 1 ? '' : 's'})`)
          : null,
        ondragend: dragFiles.length ? () => { dragging = null; clearDropHighlight(); } : null,
        onclick: (e) => {
          if (e.target.tagName === 'INPUT' || e.target.classList.contains('link')) return;
          if (isCollapsed) collapsed.delete(g.key);
          else collapsed.add(g.key);
          persist();
          render();
        },
        oncontextmenu: (e) => (g.list ? listMenu(e, g) : nodeMenu(e, g.files, g.key)),
      },
      h('span.chev', { text: isCollapsed ? '▸' : '▾' }),
      g.checkable ? h('input', {
        type: 'checkbox',
        checked: g.files.length > 0 && n === g.files.length,
        disabled: !g.files.length,
        onchange: (e) => post('toggle', { paths: g.files.map((f) => f.path), value: e.target.checked }),
      }) : null,
      h('span.glabel', { text: g.label }),
      h('span.muted', { text: `${g.files.length} file${g.files.length === 1 ? '' : 's'}` }),
      g.key === 'conflicts' ? h('span.link', { text: 'Resolve', onclick: () => post('resolve') }) : null);
      if (g.checkable && n > 0 && n < g.files.length) header.querySelector('input').indeterminate = true;
      tree.append(header);
      if (!g.files.length && isList(g.key) && !isCollapsed) {
        tree.append(h('div.empty', { 'data-group': g.key, text: 'No changes' }));
      }
      if (isCollapsed) continue;
      if (state.groupBy === 'directory') {
        renderDir(g, buildTree(g.files), 0);
      } else {
        for (const f of g.files) renderFile(g, f, 0);
      }
    }
    tree.scrollTop = scroll;
    renderBottom();
  }

  function renderDir(g, node, depth) {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      const key = `${g.key}:${d.path}`;
      const isCollapsed = collapsed.has(key);
      const files = filesUnder(d);
      // A folder can be dragged when every file below it can move groups.
      const draggable = files.length > 0 && files.every((c) => movable(g, c));
      tree.append(h('div.row.dir', {
        'data-group': g.key,
        style: { paddingLeft: `${24 + depth * 14}px` },
        draggable: draggable ? 'true' : null,
        ondragstart: draggable ? (e) => onDirDragStart(e, g, d, files) : null,
        ondragend: draggable ? () => { dragging = null; clearDropHighlight(); } : null,
        title: `${d.path}${draggable ? (g.key === 'unversioned'
          ? '\nDrag to a changelist to add the whole folder to Git'
          : '\nDrag to another changelist to move the whole folder') : ''}`,
        onclick: (e) => {
          if (e.target.tagName === 'INPUT') return;
          if (isCollapsed) collapsed.delete(key);
          else collapsed.add(key);
          persist();
          render();
        },
        oncontextmenu: (e) => nodeMenu(e, files),
      },
      h('span.chev', { text: isCollapsed ? '▸' : '▾' }),
      g.checkable ? checkbox(files) : null,
      h('span.folder'),
      h('span.dname.ellipsis', { text: d.name }),
      h('span.muted', { text: String(files.length) })));
      if (!isCollapsed) renderDir(g, d, depth + 1);
    }
    for (const f of node.files) renderFile(g, f, depth);
  }

  function renderFile(g, f, depth) {
    order.push(f);
    const flat = state.groupBy !== 'directory';
    // In directory mode files line up with the checkbox of sibling folders.
    // Nested repositories are registered as submodules instead of added.
    const draggable = movable(g, f);
    const lock = f.lock ? `\nLocked by ${f.lock.mine ? 'you' : f.lock.owner}` : '';
    const hint = g.key === 'unversioned' ? '\nDrag to a changelist to add to Git'
      : draggable ? `\nDrag to another changelist to move${f.type === 'added' ? ', or to "Unversioned Files" to unversion' : ''}` : '';
    tree.append(h(`div.row.file${selected.has(f.path) ? '.selected' : ''}`, {
      style: { paddingLeft: `${24 + depth * 14 + (flat ? 0 : 16)}px` },
      'data-path': f.path,
      'data-group': g.key,
      draggable: draggable ? 'true' : null,
      ondragstart: draggable ? (e) => onDragStart(e, g, f) : null,
      ondragend: draggable ? () => { dragging = null; clearDropHighlight(); } : null,
      title: `${f.type}: ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''}${f.lfs ? '\nStored with Git LFS' : ''}${lock}${hint}`,
      onclick: (e) => {
        if (e.target.tagName === 'INPUT') return;
        tree.focus();
        select(f, e.ctrlKey || e.metaKey, e.shiftKey, true);
      },
      ondblclick: () => post(f.type === 'conflicted' ? 'resolve' : 'open', { path: f.path, preview: false }),
      oncontextmenu: (e) => {
        e.preventDefault();
        if (!selected.has(f.path)) select(f, false, false, false);
        contextMenu(e.clientX, e.clientY);
      },
    },
    g.checkable && !f.nestedRepo ? fileCheckbox(f) : h('span.nocheck'),
    h(`span.name.t-${f.type}`, { text: basename(f.path) }),
    f.lfs ? h('span.badge.lfs', { text: 'LFS', title: 'Stored with Git LFS' }) : null,
    f.lock ? h(`span.lock${f.lock.mine ? '.mine' : ''}`, { text: '🔒', title: `Locked by ${f.lock.mine ? 'you' : f.lock.owner}` }) : null,
    f.lines ? h('span.partial', {
      text: `${f.lines.selected}/${f.lines.total} lines`,
      title: 'Only some lines are committed. Click to change the selection.',
      onclick: (e) => {
        e.stopPropagation();
        post('menu', { action: 'selectLines', paths: [f.path] });
      },
    }) : null,
    h('span.dir.muted.ellipsis', {
      text: f.nestedRepo
        ? `nested repository${flat && dirname(f.path) ? ` · ${dirname(f.path)}` : ''} (not a registered submodule)`
        : f.submoduleInfo !== null && f.submoduleInfo !== undefined
          ? `submodule${f.submoduleInfo ? ` · ${f.submoduleInfo}` : ''}`
          : f.oldPath ? `← ${f.oldPath}` : flat ? dirname(f.path) : '',
    })));
  }

  /** File checkbox; half-checked when only some lines are committed. */
  function fileCheckbox(f) {
    const box = h('input', {
      type: 'checkbox',
      checked: f.included,
      onchange: (e) => {
        const paths = selected.has(f.path) && selected.size > 1 ? [...selected] : [f.path];
        post('toggle', { paths, value: e.target.checked });
      },
    });
    if (f.lines) box.indeterminate = true;
    return box;
  }

  function renderBottom() {
    amend.checked = !!state.amend;
    amend.disabled = !state.hasCommits;
    signOff.checked = !!state.signOff;
    sign.checked = !!state.sign;
    signLabel.title = state.signTitle || 'Sign the commit (git commit -S)';
    if (!messageFocused || state.generating) {
      if (message.value !== state.message) message.value = state.message;
    }
    message.placeholder = state.repoState !== 'normal' ? 'Merge commit message' : 'Commit Message';
    commitBtn.textContent = state.amend ? 'Amend Commit' : 'Commit';
    commitBtn.disabled = !!state.busy;
    pushBtn.disabled = !!state.busy;
    genBtn.textContent = state.generating ? '■' : '✨';
    genBtn.title = state.generating
      ? 'Stop generating'
      : state.aiReady ? `Generate Commit Message (${state.aiModel})` : 'Generate Commit Message (set up AI first)';
    genBtn.classList.toggle('busy', !!state.generating);
    message.readOnly = !!state.generating;
    const inc = state.changes.filter((c) => c.included).length;
    count.textContent = state.busy ? `${state.busy}…` : inc ? `${inc} selected` : '';
  }

  function renderBanner() {
    banner.replaceChildren();
    if (!state || (state.repoState === 'normal' && !state.bisect)) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    if (state.repoState === 'normal') {
      fill(banner, bisectSection(state.bisect));
      return;
    }
    const label = {
      merging: 'Merging', rebasing: 'Rebasing', cherryPicking: 'Cherry-picking', reverting: 'Reverting', applyingMailbox: 'Applying patches',
    }[state.repoState];
    const conflicts = state.changes.filter((c) => c.type === 'conflicted').length;
    const am = state.repoState === 'applyingMailbox';
    const rb = state.repoState === 'rebasing' || am ? state.rebase : null;
    const title = rb && rb.total ? `${am ? 'Applying patch' : 'Rebasing'} ${rb.current}/${rb.total}` : `${label} in progress`;
    const edit = rb && rb.stoppedForEdit && !conflicts;
    fill(banner,
      h('div', { text: conflicts ? `${title} · ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : edit ? title : `${title} · all conflicts resolved` }),
      edit ? h('div.muted', { text: `Stopped at ${rb.stoppedSha || ''} ${rb.stoppedSubject || ''} for editing — amend, then Continue` }) : null,
      h('div.row', null,
        conflicts ? h('button.secondary', { text: 'Resolve…', onclick: () => post('resolve') })
          : h('button.secondary', { text: 'Continue', onclick: () => post('continue') }),
        state.repoState === 'rebasing' ? h('button.secondary', { text: 'Skip', title: 'Skip this commit (git rebase --skip)', onclick: () => post('skip') }) : null,
        am ? h('button.secondary', { text: 'Skip', title: 'Skip this patch (git am --skip)', onclick: () => post('skip') }) : null,
        h('button.secondary', { text: 'Abort', onclick: () => post('abort') })),
      state.bisect ? bisectSection(state.bisect) : null,
    );
  }

  /** Bisect in progress: where it stands and the Good / Bad / Skip / Reset buttons. */
  function bisectSection(b) {
    const bisect = (action) => () => post('bisect', { action });
    if (b.firstBad) {
      return h('div.bisect', null,
        h('div', { text: 'Bisect finished: first bad commit found' }),
        h('div.muted.ellipsis', { text: b.firstBad, title: b.firstBad }),
        h('div.row', null,
          h('button.secondary', { text: 'Show in Log', onclick: bisect('showFirstBad') }),
          h('button.secondary', { text: 'Reset', title: 'End the bisect and go back to the original branch (git bisect reset)', onclick: bisect('reset') })));
    }
    return h('div.bisect', null,
      h('div', { text: b.title }),
      b.current ? h('div.muted.ellipsis', { text: `Testing ${b.current}`, title: b.current }) : null,
      h('div.row', null,
        h('button.secondary', { text: 'Good', title: 'The checked out commit works (git bisect good)', onclick: bisect('good') }),
        h('button.secondary', { text: 'Bad', title: 'The checked out commit has the problem (git bisect bad)', onclick: bisect('bad') }),
        h('button.secondary', { text: 'Skip', title: 'This commit cannot be tested (git bisect skip)', onclick: bisect('skip') }),
        b.canRun ? h('button.secondary', { text: 'Run…', title: 'Test every commit with a command (git bisect run)', onclick: bisect('run') }) : null,
        h('button.secondary', { text: 'Reset', title: 'End the bisect and go back to the original branch (git bisect reset)', onclick: bisect('reset') })));
  }

  function contextMenu(x, y) {
    const sel = state.changes.filter((c) => selected.has(c.path));
    if (!sel.length) return;
    const single = sel.length === 1 ? sel[0] : null;
    const allUntracked = sel.every((c) => c.type === 'untracked');
    const anyTracked = sel.some((c) => c.type !== 'untracked' && c.type !== 'conflicted');
    const anyConflict = sel.some((c) => c.type === 'conflicted');
    const items = [
      { label: 'Show Diff', id: 'diff', disabled: anyConflict && !!single },
    ];
    // Staged and unstaged changes in one file (MM): each part on its own.
    if (single && single.staged && single.unstaged) {
      items.push(
        { label: 'Show Staged Diff', id: 'stagedDiff' },
        { label: 'Show Unstaged Diff', id: 'unstagedDiff' });
    }
    items.push({ label: 'Open File', id: 'openFile', disabled: !single || single.type === 'deleted' });
    if (anyConflict) items.push({ label: 'Resolve Conflicts…', id: 'resolve' });
    if (single && single.nestedRepo) {
      items.push('-',
        { label: 'Open Repository', id: 'openSubmodule' },
        { label: 'Register as Submodule…', id: 'registerNested' });
    }
    if (sel.some((c) => c.submoduleInfo !== null && c.submoduleInfo !== undefined)) {
      items.push('-',
        { label: 'Open Submodule', id: 'openSubmodule', disabled: !single },
        { label: 'Update Submodule (checkout recorded commit)', id: 'updateSubmodule' });
    }
    items.push('-',
      { label: 'Select Lines to Commit…', id: 'selectLines', disabled: !(single && single.canLines) },
      { label: 'Include in Commit', id: 'include' },
      { label: 'Exclude from Commit', id: 'exclude' },
      { label: 'Move to Another Changelist…    F6', id: 'moveToList', disabled: !anyTracked },
      '-',
      { label: 'Rollback…', id: 'rollback', disabled: !anyTracked });
    if (sel.some((c) => c.type === 'untracked' && !c.nestedRepo)) {
      items.push({ label: 'Add to VCS    Ctrl+Alt+A', id: 'addToVcs' });
    }
    if (allUntracked) {
      items.push({ label: 'Delete…', id: 'delete', danger: true }, { label: 'Add to .gitignore', id: 'ignore' });
    }
    items.push(...lfsItems(sel));
    items.push('-', ...patchItems(sel));
    items.push('-',
      { label: 'Show History', id: 'history', disabled: !single || single.type === 'untracked' },
      { label: 'Annotate with Git Blame', id: 'annotate',
        disabled: !single || ['untracked', 'added', 'deleted', 'conflicted'].includes(single.type) || !!single.nestedRepo ||
          (single.submoduleInfo !== null && single.submoduleInfo !== undefined) },
      { label: 'Copy Path', id: 'copy' },
      { label: 'Reveal in Explorer View', id: 'reveal', disabled: !single || single.type === 'deleted' });
    showMenu(x, y, items, (action) => post('menu', { action, paths: sel.map((c) => c.path) }));
  }

  /** Git LFS items (when git-lfs is installed): track / untrack, and locks when the remote supports them. */
  function lfsItems(sel) {
    if (!state.lfs || !state.lfs.available) return [];
    const items = [];
    if (sel.some((c) => c.type === 'untracked' && !c.nestedRepo)) items.push({ label: 'Track with LFS…', id: 'lfsTrack' });
    if (sel.some((c) => c.lfs)) items.push({ label: 'Untrack from LFS…', id: 'lfsUntrack' });
    if (state.lfs.locks && sel.some((c) => c.lfs && c.type !== 'untracked')) {
      items.push({ label: 'Lock', id: 'lfsLock' }, { label: 'Unlock', id: 'lfsUnlock' });
    }
    return items.length ? ['-', ...items] : [];
  }

  /** Context menu of a changelist group: the list itself, then its files. */
  function listMenu(e, g) {
    e.preventDefault();
    e.stopPropagation();
    const l = g.list;
    const none = !g.files.length;
    showMenu(e.clientX, e.clientY, [
      { label: 'Set Active Changelist', id: 'setActive', disabled: l.active },
      { label: 'New Changelist…', id: 'new' },
      { label: 'Edit Changelist…', id: 'edit' },
      { label: 'Delete Changelist…', id: 'delete', disabled: l.isDefault, danger: true },
      '-',
      { label: 'Include in Commit', id: 'include', disabled: none },
      { label: 'Exclude from Commit', id: 'exclude', disabled: none },
      '-',
      ...patchItems(g.files),
      '-',
      { label: 'Rollback…', id: 'rollback', disabled: none },
    ], (action) => post('listMenu', { action, list: l.id, paths: g.files.map((c) => c.path) }));
  }

  /** Shelve / patch items for a set of changes (files, a folder or a group). */
  function patchItems(changes) {
    // Conflicted files, submodules and nested repositories are never shelved.
    const none = !changes.some((c) => c.type !== 'conflicted' && !c.nestedRepo && (c.submoduleInfo === null || c.submoduleInfo === undefined));
    return [
      { label: 'Shelve Changes…', id: 'shelve', disabled: none || state.repoState !== 'normal' },
      { label: 'Create Patch…', id: 'createPatch', disabled: none },
      { label: 'Copy as Patch to Clipboard', id: 'copyPatch', disabled: none },
    ];
  }

  /** Context menu of a folder or a group: acts on every file below it. */
  function nodeMenu(e, files, groupKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!files.length) return;
    const paths = files.map((c) => c.path);
    const checkable = files.filter((c) => c.type !== 'conflicted');
    showMenu(e.clientX, e.clientY, [
      ...(groupKey === 'unversioned' ? [{ label: 'Clean Unversioned Files…', id: 'clean', danger: true }, '-'] : []),
      { label: 'Include in Commit', id: 'include', disabled: !checkable.length },
      { label: 'Exclude from Commit', id: 'exclude', disabled: !checkable.length },
      ...(files.some((c) => c.type !== 'untracked') ? [{ label: 'Move to Another Changelist…    F6', id: 'moveToList' }] : []),
      '-',
      ...patchItems(files),
      '-',
      { label: 'Rollback…', id: 'rollback', disabled: !files.some((c) => c.type !== 'untracked' && c.type !== 'conflicted') },
    ], (action) => post('menu', { action, paths }));
  }

  post('ready');
})();
