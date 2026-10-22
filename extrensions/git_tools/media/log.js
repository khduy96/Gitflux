// Log view: commit table with branch graph and commit details.
(() => {
  const vscode = acquireVsCodeApi();
  const { h, fill, showMenu, formatDate, basename, dirname } = gt;

  const ROW = 22;
  const LANE = 12;
  const COLORS = ['#4f9ded', '#73bd79', '#e5a54b', '#c678dd', '#e06c75', '#56b6c2', '#d19a66', '#98c379', '#b57edc', '#61afef'];

  const DATE_PRESETS = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
  /** Shortest text searched in the changes, and the typing pause before it runs. */
  const MIN_SEARCH = 2;
  const SEARCH_DELAY = 450;

  const saved = vscode.getState() || {};
  let detailsWidth = saved.detailsWidth || 380;
  let data = { commits: [], graph: [], head: null, loading: true, filter: {}, authors: [], branches: [], repo: null, canRebase: false, bisect: null };
  let rows = []; // [{c, g}]
  let byHash = new Map();
  /** Loaded commits reachable from HEAD: the ones history rewriting can touch. */
  let ancestors = new Set();
  let text = saved.text || '';
  /** 'text': filters the loaded commits here; 'content': git log -S / -G. */
  let searchMode = saved.searchMode === 'content' ? 'content' : 'text';
  let regex = !!saved.regex;
  let searchTimer = null;
  /** Repository of the last log message (undefined before the first one). */
  let shownRepo;
  let selected = new Set();
  let primary = null;
  let details = null;
  let selectedFile = null;
  /** Commit shown in the details without being in the loaded log (Reflog ▸ Show in Log). */
  let extra = null;
  /** Open folders of the branch picker, by key ("Local/feature", "Remote/origin"). */
  const branchOpen = new Set();
  /** Branch picker while open: {el, input, list, rows, active}. */
  let picker = null;
  /** Signatures by hash ({code, level, text, signer, key}), asked for the visible rows only, per repository. */
  const sigs = new Map();
  const sigPending = new Set();
  let sigRepo = null;
  let sigTimer = null;

  // ------------------------------------------------------------- layout

  const modeSel = h('select#searchMode', { title: 'What the text box searches' },
    h('option', { value: 'text', text: 'Message / hash / author', selected: searchMode === 'text' }),
    h('option', { value: 'content', text: 'Changes containing text', selected: searchMode === 'content' }));
  const search = h('input#search', { type: 'search', value: text });
  const regexBox = h('input#regex', { type: 'checkbox' });
  regexBox.checked = regex;
  const regexLabel = h('label#regexLabel', { title: 'Search lines matching a regular expression (git log -G) instead of a text (-S)' },
    regexBox, ' Regex (-G)');
  const branchLabel = h('span.ellipsis');
  const branchBtn = h('button.dropdown#branch', null, branchLabel, h('span.chev', { text: '▾' }));
  const userSel = h('select#user', { title: 'Author (name or email)' });
  const dateSel = h('select#date', { title: 'Committer date' });
  const pathChip = h('span.chip#pathChip');
  const chips = h('span#chips');
  const status = h('span.muted#status');
  const toolbar = h('div#toolbar', null, modeSel, search, regexLabel,
    h('span.muted', { text: 'Branch:' }), branchBtn, h('span.muted', { text: 'User:' }), userSel,
    h('span.muted', { text: 'Date:' }), dateSel, pathChip, chips, h('span.spacer'), status);
  const spacer = h('div#spacer');
  const rowsEl = h('div#rows');
  const table = h('div#table', { tabindex: '0' }, spacer, rowsEl);
  const splitter = h('div#splitter');
  const detailsEl = h('div#details');
  const main = h('div#main', null, table, splitter, detailsEl);
  document.getElementById('app').append(toolbar, main);
  detailsEl.style.width = `${detailsWidth}px`;

  const post = (type, d = {}) => vscode.postMessage({ type, ...d });
  const persist = () => vscode.setState({ detailsWidth, text, searchMode, regex });
  const setFilter = (filter) => post('filter', { filter });

  // ------------------------------------------------------------- events

  search.addEventListener('input', () => {
    text = search.value;
    persist();
    if (searchMode === 'content') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applySearch, SEARCH_DELAY);
      return;
    }
    computeRows();
    renderRows();
    renderFilterControls();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchMode === 'content') applySearch();
  });
  modeSel.addEventListener('change', () => {
    searchMode = modeSel.value === 'content' ? 'content' : 'text';
    persist();
    renderSearchMode();
    computeRows();
    renderRows();
    applySearch();
  });
  regexBox.addEventListener('change', () => {
    regex = regexBox.checked;
    persist();
    applySearch();
  });
  branchBtn.addEventListener('click', () => (picker ? closePicker() : openPicker()));
  document.addEventListener('mousedown', (e) => {
    if (picker && !picker.el.contains(e.target) && !branchBtn.contains(e.target)) closePicker();
  });
  window.addEventListener('blur', () => closePicker());
  userSel.addEventListener('change', () => {
    const v = userSel.value;
    if (v === 'select') {
      renderFilterControls(); // until the input box answers
      post('pickUser');
    } else {
      setFilter({ user: v === 'me' ? { kind: 'me' } : v.startsWith('a:') ? { kind: 'text', text: v.slice(2) } : null });
    }
  });
  dateSel.addEventListener('change', () => {
    const v = dateSel.value;
    if (v === 'select') {
      renderFilterControls();
      post('pickDate');
    } else if (v !== 'custom') {
      setFilter({ date: v ? { preset: v } : null });
    }
  });
  table.addEventListener('scroll', renderRows);
  window.addEventListener('resize', renderRows);

  let dragging = false;
  splitter.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    detailsWidth = Math.max(220, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX));
    detailsEl.style.width = `${detailsWidth}px`;
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      persist();
      renderRows();
    }
  });

  table.addEventListener('keydown', (e) => {
    if (!rows.length) return;
    const delta = { ArrowDown: 1, ArrowUp: -1, PageDown: 20, PageUp: -20 }[e.key];
    if (delta) {
      e.preventDefault();
      let i = rows.findIndex((r) => r.c.hash === primary);
      i = Math.max(0, Math.min(rows.length - 1, i + delta));
      select(rows[i].c, false, false);
      ensureVisible(i);
    } else if (e.key === 'c' && e.ctrlKey && e.altKey && e.shiftKey && primary) {
      post('commitAction', { action: 'copy', hashes: [primary] });
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'log') {
      data = msg.data;
      if (data.repo !== sigRepo) {
        sigRepo = data.repo;
        sigs.clear();
        sigPending.clear();
      }
      syncSearch();
      computeAncestors();
      const known = new Set(data.commits.map((c) => c.hash));
      if (extra) known.add(extra.hash);
      selected = new Set([...selected].filter((x) => known.has(x)));
      if (primary && !known.has(primary)) {
        primary = null;
        details = null;
      }
      computeRows();
      renderToolbar();
      renderRows();
      renderDetails();
    } else if (msg.type === 'showCommit') {
      extra = msg.commit;
      selected = new Set();
      showDetails(extra.hash);
    } else if (msg.type === 'details') {
      if (msg.details.hash === primary) {
        details = msg.details;
        if (details.signature && !sigs.has(details.hash)) {
          sigs.set(details.hash, details.signature);
          renderRows();
        }
        renderDetails();
      }
    } else if (msg.type === 'signatures') {
      if (msg.repo !== sigRepo) return;
      for (const [hash, s] of Object.entries(msg.signatures)) {
        sigs.set(hash, s);
        sigPending.delete(hash);
      }
      renderRows();
    } else if (msg.type === 'repoState') {
      data.canRebase = msg.canRebase;
      data.bisect = msg.bisect;
      renderRows();
    } else if (msg.type === 'select') {
      const i = rows.findIndex((r) => r.c.hash === msg.hash);
      if (i >= 0) {
        select(rows[i].c, false, false);
        ensureVisible(i);
      } else if (byHash.has(msg.hash)) {
        // Loaded but hidden by the text filter: details only.
        selected = new Set([msg.hash]);
        showDetails(msg.hash);
      }
    }
  });

  // ------------------------------------------------------------- data

  /** Asks git for the commits whose changes contain the text (content mode), or drops that filter. */
  function applySearch() {
    clearTimeout(searchTimer);
    searchTimer = null;
    const want = searchMode === 'content' && text.trim().length >= MIN_SEARCH ? { text, regex } : null;
    const cur = (data.filter && data.filter.search) || null;
    const same = want === cur || (!!want && !!cur && want.text === cur.text && want.regex === cur.regex);
    if (!same && data.repo) setFilter({ search: want });
  }

  /**
   * Keeps the text box in line with the repository's content search: the
   * persisted search runs again on the first log, another repository shows
   * its own (the filters are per repository).
   */
  function syncSearch() {
    if (shownRepo === data.repo) return;
    const first = !shownRepo;
    shownRepo = data.repo;
    const s = data.filter && data.filter.search;
    if (s) {
      searchMode = 'content';
      text = s.text;
      regex = !!s.regex;
    } else if (first) {
      if (searchMode === 'content') applySearch();
    } else if (searchMode === 'content') {
      text = '';
    }
    search.value = text;
    regexBox.checked = regex;
    modeSel.value = searchMode;
    persist();
    renderSearchMode();
  }

  function computeRows() {
    const q = searchMode === 'text' ? text.trim().toLowerCase() : '';
    if (!q) {
      rows = data.commits.map((c, i) => ({ c, g: data.graph[i] }));
      return;
    }
    rows = data.commits
      .filter((c) => c.subject.toLowerCase().includes(q) || c.hash.startsWith(q) ||
        c.author.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) ||
        c.refs.some((r) => r.name.toLowerCase().includes(q)))
      .map((c) => ({ c, g: null }));
  }

  function computeAncestors() {
    byHash = new Map(data.commits.map((c) => [c.hash, c]));
    ancestors = new Set();
    const stack = data.head && byHash.has(data.head) ? [data.head] : [];
    while (stack.length) {
      const hash = stack.pop();
      if (ancestors.has(hash)) continue;
      ancestors.add(hash);
      for (const p of byHash.get(hash).parents) if (byHash.has(p)) stack.push(p);
    }
  }

  function select(c, ctrl, shift) {
    if (ctrl) {
      if (selected.has(c.hash)) selected.delete(c.hash);
      else selected.add(c.hash);
    } else if (shift && primary) {
      const hashes = rows.map((r) => r.c.hash);
      const a = hashes.indexOf(primary);
      const b = hashes.indexOf(c.hash);
      if (a >= 0 && b >= 0) selected = new Set(hashes.slice(Math.min(a, b), Math.max(a, b) + 1));
      renderRows();
      return;
    } else {
      selected = new Set([c.hash]);
    }
    extra = null;
    if (primary !== c.hash) {
      primary = c.hash;
      details = null;
      selectedFile = null;
      post('details', { hash: c.hash });
    }
    renderRows();
    renderDetails();
  }

  /** Shows the details of a commit that has no visible row. */
  function showDetails(hash) {
    primary = hash;
    details = null;
    selectedFile = null;
    post('details', { hash });
    renderRows();
    renderDetails();
  }

  function ensureVisible(i) {
    const top = i * ROW;
    if (top < table.scrollTop) table.scrollTop = top;
    else if (top + ROW > table.scrollTop + table.clientHeight) table.scrollTop = top + ROW - table.clientHeight;
  }

  // ------------------------------------------------------------- render

  function renderToolbar() {
    renderFilterControls();
    const f = data.filter || {};
    const filtered = !!(f.user || f.date || f.search);
    status.replaceChildren(
      data.loading ? h('span.spinner') : '',
      ` ${data.repo ? `${data.commits.length} commit${data.commits.length === 1 ? '' : 's'}${filtered ? ' found' : ''}` : 'No repository'}`,
    );
  }

  function renderSearchMode() {
    regexLabel.hidden = searchMode !== 'content';
    search.placeholder = searchMode === 'content' ? `Text in changes (${MIN_SEARCH}+ characters)` : 'Text or hash';
    search.title = searchMode === 'content'
      ? 'Commits whose changes add or remove this text (git log -S), or a matching line with Regex (-G)'
      : 'Filters the loaded commits by message, hash, author or ref';
  }

  const userLabel = (u) => (u.kind === 'me' ? 'Me' : u.text);
  const dateLabel = (d) => {
    if (d.preset) return (DATE_PRESETS.find((p) => p[0] === d.preset) || [0, d.preset])[1];
    if (d.from && d.to) return `${d.from} – ${d.to}`;
    return d.from ? `Since ${d.from}` : `Until ${d.to}`;
  };

  // ------------------------------------------------------------- branch picker

  /**
   * Branches as a tree of folders split on the `/` of their names
   * (Remote ▸ origin ▸ feature ▸ a), folders before branches.
   */
  function branchFolder(key, label, branches, skip = 0) {
    const folders = new Map();
    const leaves = [];
    for (const b of branches) {
      const rest = b.name.slice(skip);
      const i = rest.indexOf('/');
      if (i < 0) {
        leaves.push({ kind: 'branch', key: b.name, label: rest });
        continue;
      }
      const dir = rest.slice(0, i);
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir).push(b);
    }
    const children = [...folders].map(([dir, list]) => branchFolder(`${key}/${dir}`, dir, list, skip + dir.length + 1));
    return { kind: 'folder', key, label, count: branches.length, children: [...children, ...leaves] };
  }

  /** Visible rows of the picker. While searching: the matching branches, their folders open. */
  function pickerRows(query) {
    const q = query.trim().toLowerCase();
    const out = q ? [] : [{ kind: 'branch', key: '', label: 'All', depth: 0 }, { kind: 'branch', key: 'HEAD', label: 'HEAD', depth: 0 }];
    const walk = (node, depth) => {
      if (node.kind === 'branch') {
        if (!q || node.key.toLowerCase().includes(q)) out.push({ ...node, depth });
        return;
      }
      if (!node.count) return;
      const at = out.length;
      const open = !!q || branchOpen.has(node.key);
      out.push({ kind: 'folder', key: node.key, label: node.label, count: node.count, open, depth });
      if (open) node.children.forEach((c) => walk(c, depth + 1));
      if (q && out.length === at + 1) out.pop(); // nothing matches inside
    };
    walk(branchFolder('Local', 'Local', data.branches.filter((b) => !b.remote)), 0);
    walk(branchFolder('Remote', 'Remote', data.branches.filter((b) => b.remote)), 0);
    return out;
  }

  /**
   * Opens with every folder closed but the ones down to the branch shown in
   * the Log, or the checked out branch when the Log shows them all; that
   * branch is the active line.
   */
  function openPicker() {
    const shown = (data.filter || {}).branch || '';
    const target = shown || (data.branches.find((x) => x.current) || {}).name || '';
    branchOpen.clear();
    const b = data.branches.find((x) => x.name === target);
    if (b) {
      const root = b.remote ? 'Remote' : 'Local';
      branchOpen.add(root);
      for (let i = b.name.indexOf('/'); i >= 0; i = b.name.indexOf('/', i + 1)) branchOpen.add(`${root}/${b.name.slice(0, i)}`);
    }
    const input = h('input', { type: 'search', placeholder: 'Search branches' });
    const list = h('div.list');
    const el = h('div.menu.picker', null, input, list);
    document.body.append(el);
    picker = { el, input, list, rows: pickerRows(''), active: 0 };
    picker.active = Math.max(0, picker.rows.findIndex((r) => r.kind === 'branch' && r.key === target));

    input.addEventListener('input', () => {
      picker.rows = pickerRows(input.value);
      picker.active = Math.max(0, picker.rows.findIndex((r) => r.kind === 'branch'));
      renderPicker();
    });
    input.addEventListener('keydown', (e) => {
      const r = picker.rows[picker.active];
      const toggle = r && r.kind === 'folder' && !input.value && (e.key === 'ArrowRight' ? !r.open : e.key === 'ArrowLeft' && r.open);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        picker.active += e.key === 'ArrowDown' ? 1 : -1;
        renderPicker();
      } else if ((e.key === 'Enter' && r) || toggle) {
        pickRow(r);
      } else if (e.key === 'Escape') {
        closePicker();
        branchBtn.focus();
      } else {
        return;
      }
      e.preventDefault();
    });

    const anchor = branchBtn.getBoundingClientRect();
    el.style.top = `${anchor.bottom + 2}px`;
    el.style.maxHeight = `${Math.max(120, window.innerHeight - anchor.bottom - 8)}px`;
    renderPicker();
    el.style.left = `${Math.max(0, Math.min(anchor.left, window.innerWidth - el.offsetWidth - 4))}px`;
    input.focus();
  }

  function closePicker() {
    if (!picker) return;
    picker.el.remove();
    picker = null;
  }

  /** A folder opens / closes; a branch becomes the filter. */
  function pickRow(r) {
    if (r.kind === 'folder') {
      if (picker.input.value) return; // all open while searching
      if (r.open) branchOpen.delete(r.key);
      else branchOpen.add(r.key);
      picker.rows = pickerRows('');
      renderPicker();
      return;
    }
    closePicker();
    branchBtn.focus();
    if (r.key !== ((data.filter || {}).branch || '')) setFilter({ branch: r.key || null });
  }

  function renderPicker() {
    if (!picker) return;
    const current = (data.filter || {}).branch || '';
    picker.active = Math.max(0, Math.min(picker.active, picker.rows.length - 1));
    fill(picker.list, picker.rows.length ? picker.rows.map((r, i) => h(
      `div.pitem${r.kind === 'folder' ? '.folder' : ''}${i === picker.active ? '.active' : ''}${r.kind === 'branch' && r.key === current ? '.current' : ''}`,
      {
        title: r.kind === 'branch' && r.key ? r.key : null,
        'data-copy': r.kind === 'branch' && r.key && r.key !== 'HEAD' ? r.key : null,
        style: { paddingLeft: `${4 + r.depth * 14}px` },
        onmousedown: (e) => e.preventDefault(), // keeps the focus in the search box
        onclick: () => {
          picker.active = i;
          pickRow(r);
        },
      },
      h('span.chev', { text: r.kind === 'folder' ? (r.open ? '▾' : '▸') : '' }),
      h('span.ellipsis', { text: r.label }),
      r.kind === 'folder' ? h('span.count.muted', { text: String(r.count) }) : null,
    )) : h('div.empty', { text: 'No branches' }));
    const active = picker.list.children[picker.active];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  /** Branch / User / Date dropdowns and the chips of the active filters. */
  function renderFilterControls() {
    const f = data.filter || {};
    branchLabel.textContent = f.branch || 'All';
    branchBtn.title = f.branch ? `Branch: ${f.branch}` : 'All branches';
    if (f.branch && f.branch !== 'HEAD') {
      branchBtn.dataset.copy = f.branch.replace(/^refs\/tags\//, '');
      branchBtn.dataset.copyWhat = f.branch.startsWith('refs/tags/') ? 'tag name' : 'branch name';
    } else {
      delete branchBtn.dataset.copy;
    }
    if (picker) {
      picker.rows = pickerRows(picker.input.value);
      renderPicker();
    }
    const u = f.user || null;
    const authors = data.authors || [];
    const userValue = !u ? '' : u.kind === 'me' ? 'me' : `a:${u.text}`;
    fill(userSel,
      h('option', { value: '', text: 'All' }),
      h('option', { value: 'me', text: 'Me' }),
      authors.length ? h('optgroup', { label: 'Authors' }, authors.map((a) =>
        h('option', { value: `a:${a.name}`, text: `${a.name} (${a.count})`, title: a.emails.join(', ') }))) : null,
      u && u.kind === 'text' && !authors.some((a) => a.name === u.text) ? h('option', { value: userValue, text: u.text }) : null,
      h('option', { value: 'select', text: 'Select…' }),
    );
    userSel.value = userValue;
    const d = f.date || null;
    fill(dateSel,
      h('option', { value: '', text: 'All' }),
      DATE_PRESETS.map(([id, label]) => h('option', { value: id, text: label })),
      d && !d.preset ? h('option', { value: 'custom', text: dateLabel(d) }) : null,
      h('option', { value: 'select', text: 'Select…' }),
    );
    dateSel.value = !d ? '' : d.preset || 'custom';

    pathChip.replaceChildren();
    pathChip.hidden = !f.path;
    if (f.path) {
      pathChip.append(h('span', { text: `Path: ${f.path}` }), h('span.x', { text: ' ×', title: 'Clear', onclick: () => setFilter({ path: null }) }));
    }
    const chip = (label, title, clear) => h('span.chip', { title }, h('span', { text: label }),
      h('span.x', { text: ' ×', title: 'Clear', onclick: clear }));
    fill(chips,
      u ? chip(`User: ${userLabel(u)}`, 'Author name or email contains this (case-insensitive)', () => setFilter({ user: null })) : null,
      d ? chip(`Date: ${dateLabel(d)}`, 'Committer date', () => setFilter({ date: null })) : null,
      f.search ? chip(`${f.search.regex ? 'Changes matching' : 'Changes containing'}: ${f.search.text}`,
        f.search.regex ? 'git log -G' : 'git log -S', () => clearSearch()) : null,
      f.branch || f.path || u || d || f.search || (searchMode === 'text' && text.trim())
        ? h('a.reset', { href: '#', text: 'Reset filters', onclick: (e) => { e.preventDefault(); resetFilters(); } }) : null,
    );
  }

  function clearSearch() {
    text = '';
    search.value = '';
    persist();
    applySearch();
  }

  function resetFilters() {
    clearTimeout(searchTimer);
    text = '';
    search.value = '';
    persist();
    setFilter({ branch: null, path: null, user: null, date: null, search: null });
    computeRows();
    renderRows();
    renderFilterControls();
  }

  function renderRows() {
    spacer.style.height = `${rows.length * ROW}px`;
    const first = Math.max(0, Math.floor(table.scrollTop / ROW) - 5);
    const last = Math.min(rows.length, Math.ceil((table.scrollTop + table.clientHeight) / ROW) + 5);
    rowsEl.replaceChildren();
    if (!rows.length) {
      rowsEl.append(h('div.empty', { text: data.loading ? 'Loading…' : 'No commits' }));
      hideRefsPopup();
      return;
    }
    for (let i = first; i < last; i++) {
      const { c, g } = rows[i];
      const isHead = c.hash === data.head;
      const row = h(`div.crow${selected.has(c.hash) ? '.selected' : ''}${isHead ? '.head' : ''}`, {
        style: { top: `${i * ROW}px` },
        onclick: (e) => {
          table.focus();
          select(c, e.ctrlKey || e.metaKey, e.shiftKey);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          if (!selected.has(c.hash)) select(c, false, false);
          commitMenu(e.clientX, e.clientY, c);
        },
      },
      g ? graphCanvas(g, isHead) : h('span', { style: { width: '8px', flexShrink: '0' } }),
      bisectChip(c.hash),
      commitRefs(c),
      sigMark(sigs.get(c.hash)),
      h('span.subject.ellipsis', { text: c.subject, title: c.subject }),
      h('span.author.ellipsis', { text: c.author }),
      h('span.date', { text: formatDate(c.time) }),
      h('span.hash.mono', { text: c.hash.slice(0, 8) }));
      rowsEl.append(row);
    }
    keepRefsPopup();
    requestSignatures();
  }

  /** Rows on screen (without the rendering margin). */
  function visibleRange() {
    const first = Math.max(0, Math.floor(table.scrollTop / ROW));
    return [first, Math.min(rows.length, Math.ceil((table.scrollTop + table.clientHeight) / ROW))];
  }

  /**
   * Asks for the signatures of the rows on screen not known yet, once the
   * scrolling pauses: verifying runs gpg / ssh-keygen per signed commit.
   */
  function requestSignatures() {
    clearTimeout(sigTimer);
    sigTimer = setTimeout(() => {
      if (!data.repo || data.repo !== sigRepo) return;
      const [first, last] = visibleRange();
      const hashes = [];
      for (let i = first; i < last; i++) {
        const hash = rows[i].c.hash;
        if (!sigs.has(hash) && !sigPending.has(hash)) hashes.push(hash);
      }
      if (!hashes.length) return;
      hashes.forEach((x) => sigPending.add(x));
      post('signatures', { repo: data.repo, hashes });
    }, 150);
  }

  const sigTitle = (s) => [s.text, s.signer && `Signed by ${s.signer}`, s.key && `Key ${s.key}`].filter(Boolean).join('\n');

  /** ✓ green (good), ✓ yellow (untrusted / expired), ✗ red (bad / revoked / cannot check); nothing when unsigned. */
  function sigMark(s) {
    if (!s || !s.level || s.level === 'none') return null;
    return h(`span.sig.${s.level}`, { text: s.level === 'bad' ? '✗' : '✓', title: sigTitle(s) });
  }

  function refChip(r) {
    const icon = r.kind === 'head' ? '◉' : r.kind === 'tag' ? '🏷' : '⑂';
    return h(`span.ref.${r.kind}`, {
      title: r.name,
      'data-copy': r.kind === 'head' ? null : r.name,
      'data-copy-what': r.kind === 'tag' ? 'tag name' : null,
    }, r.kind === 'head' ? icon : `${icon} ${r.name}`);
  }

  /**
   * Refs of a commit grouped by name, most relevant first: a detached HEAD
   * or the current branch, local branches, remote only branches, tags. A
   * local branch and its remote branches (main, origin/main) are one group.
   */
  function groupRefs(refs) {
    const branches = new Map();
    const tags = [];
    let detached = null;
    const branch = (name) => {
      if (!branches.has(name)) branches.set(name, { name, head: false, local: false, tag: false, remotes: [], refs: [] });
      return branches.get(name);
    };
    refs.forEach((r, i) => {
      if (r.kind === 'head') {
        // "HEAD -> main" comes as HEAD then main; HEAD alone is detached.
        const next = refs[i + 1];
        if (next && next.kind === 'local') {
          const b = branch(next.name);
          b.head = true;
          b.refs.push(r);
        } else {
          detached = { name: 'HEAD', head: true, local: false, tag: false, remotes: [], refs: [r] };
        }
      } else if (r.kind === 'local') {
        const b = branch(r.name);
        b.local = true;
        b.refs.push(r);
      } else if (r.kind === 'remote') {
        const slash = r.name.indexOf('/');
        const b = branch(r.name.slice(slash + 1));
        b.remotes.push(slash < 0 ? '' : r.name.slice(0, slash));
        b.refs.push(r);
      } else {
        tags.push({ name: r.name, head: false, local: false, tag: true, remotes: [], refs: [r] });
      }
    });
    const rank = (g) => (g.head ? 0 : g.local ? 1 : 2);
    const list = [...branches.values()];
    return [...(detached ? [detached] : []), ...[0, 1, 2].flatMap((n) => list.filter((g) => rank(g) === n)), ...tags];
  }

  /** Group showing the Log filter `focus` (a branch, "HEAD" or "refs/tags/…"). */
  function focusedGroup(groups, focus) {
    if (focus === 'HEAD') return groups.find((g) => g.head);
    if (focus.startsWith('refs/tags/')) return groups.find((g) => g.tag && g.name === focus.slice(10));
    return groups.find((g) => !g.tag && g.refs.some((r) => r.kind !== 'head' && r.name === focus));
  }

  /**
   * Refs of a commit row, kept short: the most relevant name and "+N", or
   * only the branch the Log shows. Hovering shows every ref.
   */
  function commitRefs(c) {
    if (!c.refs.length) return null;
    const groups = groupRefs(c.refs);
    const focus = (data.filter || {}).branch;
    const shown = focus ? focusedGroup(groups, focus) : groups[0];
    if (!shown) return null;
    const more = focus ? 0 : groups.length - 1;
    return h('span.refs', {
      'data-hash': c.hash,
      onmouseenter: (e) => showRefsPopup(e.currentTarget, c),
    }, groupChip(shown), more ? h('span.ref.more', { text: `+${more}` }) : null);
  }

  /** Name of a group, then a screen for a local branch and a cloud for remote branches of that name. */
  function groupChip(g) {
    const kind = g.head ? 'head' : g.tag ? 'tag' : g.local ? 'local' : 'remote';
    // Copied: the local branch, else the remote one (origin/x), or the tag.
    const remote = g.refs.find((r) => r.kind === 'remote');
    return h(`span.ref.group.${kind}`, {
      'data-copy': g.local || g.tag ? g.name : remote ? remote.name : null,
      'data-copy-what': g.tag ? 'tag name' : null,
    },
      h('span', { text: g.head ? '◉' : g.tag ? '🏷' : '⑂' }),
      h('span.rname.ellipsis', { text: g.name }),
      g.local ? refIcon('local') : null,
      g.remotes.length ? refIcon('remote') : null);
  }

  const REF_ICONS = {
    local: 'M2.5 3.5h11v7h-11z M5.5 13.5h5 M8 10.5v3',
    remote: 'M4.6 12.5h7a2.8 2.8 0 0 0 .4-5.57A4 4 0 0 0 4.3 7.8 2.35 2.35 0 0 0 4.6 12.5z',
  };

  function refIcon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', `ricon ${name}`);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', REF_ICONS[name]);
    svg.append(path);
    return svg;
  }

  /** Every ref of a commit, shown while hovering the refs of its row: {el, hash}. */
  let refsPopup = null;

  function showRefsPopup(anchor, c) {
    hideRefsPopup();
    refsPopup = { el: h('div.refpop', null, c.refs.map(refChip)), hash: c.hash };
    document.body.append(refsPopup.el);
    placeRefsPopup(anchor);
  }

  function placeRefsPopup(anchor) {
    const a = anchor.getBoundingClientRect();
    const r = refsPopup.el.getBoundingClientRect();
    // Touching the refs, so that the mouse can go into it (to copy one of them).
    const below = a.bottom + r.height <= window.innerHeight;
    refsPopup.el.style.left = `${Math.max(4, Math.min(a.left, window.innerWidth - r.width - 4))}px`;
    refsPopup.el.style.top = `${below ? a.bottom - 1 : Math.max(4, a.top - r.height + 1)}px`;
  }

  function hideRefsPopup() {
    if (!refsPopup) return;
    refsPopup.el.remove();
    refsPopup = null;
  }

  /** Rows were rebuilt (signatures, refresh) under the popup: it follows the refs of its commit. */
  function keepRefsPopup() {
    if (!refsPopup) return;
    const anchor = rowsEl.querySelector(`.refs[data-hash="${refsPopup.hash}"]`);
    if (anchor) placeRefsPopup(anchor);
    else hideRefsPopup();
  }

  // Open while the mouse is over the refs of a row or over the popup itself.
  // (A mousemove rather than mouseleave: rebuilt rows get no mouseleave.)
  document.addEventListener('mousemove', (e) => {
    if (refsPopup && !(e.target instanceof Element && e.target.closest('.refs, .refpop'))) hideRefsPopup();
  });
  document.addEventListener('mouseleave', hideRefsPopup);

  /** good / bad / skip label of a commit marked during a bisect session. */
  function bisectChip(hash) {
    const mark = data.bisect && data.bisect.marks ? data.bisect.marks[hash] : null;
    if (!mark) return null;
    const first = data.bisect.firstBad === hash;
    return h(`span.ref.bisect.${mark}`, {
      title: first ? 'First bad commit (bisect)' : `Marked ${mark === 'skip' ? 'skipped' : mark} (bisect)`,
    }, first ? 'first bad' : mark);
  }

  function graphCanvas(g, isHead) {
    const w = g.width * LANE + 6;
    const dpr = window.devicePixelRatio || 1;
    const cv = h('canvas.graph', { width: String(Math.ceil(w * dpr)), height: String(ROW * dpr), style: { width: `${w}px`, height: `${ROW}px` } });
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const x = (lane) => lane * LANE + LANE / 2 + 2;
    const mid = ROW / 2;
    ctx.lineWidth = 1.6;
    for (const [from, to, part, color] of g.segments) {
      ctx.strokeStyle = COLORS[color % COLORS.length];
      ctx.beginPath();
      if (part === 2) {
        ctx.moveTo(x(from), 0);
        ctx.lineTo(x(from), ROW);
      } else {
        const ay = part === 0 ? 0 : mid;
        const by = part === 0 ? mid : ROW;
        ctx.moveTo(x(from), ay);
        if (from === to) ctx.lineTo(x(to), by);
        else ctx.bezierCurveTo(x(from), (ay + by) / 2, x(to), (ay + by) / 2, x(to), by);
      }
      ctx.stroke();
    }
    const color = COLORS[g.color % COLORS.length];
    ctx.beginPath();
    ctx.arc(x(g.lane), mid, isHead ? 4.5 : 3.8, 0, Math.PI * 2);
    if (isHead) {
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-panel-background') || '#1e1e1e';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
    return cv;
  }

  function renderDetails() {
    detailsEl.replaceChildren();
    if (!primary) {
      detailsEl.append(h('div.empty', { text: 'Select a commit to view details' }));
      return;
    }
    if (!details) {
      detailsEl.append(h('div.empty', null, h('span.spinner')));
      return;
    }
    const d = details;
    const files = h('div#files');
    if (extra && extra.hash === d.hash) {
      files.append(h('div.dnote', { text: 'Not in the loaded log (e.g. only the reflog still reaches it).' }));
    }
    files.append(h('div.dhead', null,
      h('span', { text: `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed` }),
      d.parents.length > 1 ? h('span.muted', { text: ' (vs first parent)' }) : null));
    for (const f of d.files) {
      files.append(h(`div.frow${selectedFile === f.path ? '.selected' : ''}`, {
        title: f.path,
        onclick: () => {
          selectedFile = f.path;
          renderDetails();
          post('openDiff', { hash: d.hash, path: f.path, preview: true });
        },
        ondblclick: () => post('openDiff', { hash: d.hash, path: f.path, preview: false }),
        oncontextmenu: (e) => {
          e.preventDefault();
          selectedFile = f.path;
          renderDetails();
          showMenu(e.clientX, e.clientY, [
            { label: 'Show Diff', id: 'diff' },
            { label: 'Compare with Local', id: 'local', disabled: f.type === 'deleted' },
            { label: 'Show History for File', id: 'history' },
            '-',
            { label: 'Get from Revision', id: 'get', disabled: f.type === 'deleted' },
            { label: 'Copy Path', id: 'copy' },
          ], (action) => post('fileAction', { action, hash: d.hash, path: f.path }));
        },
      },
      h(`span.t-${f.type}`, { text: basename(f.path) }),
      h('span.muted.ellipsis', { text: f.oldPath ? `← ${f.oldPath}` : dirname(f.path) })));
    }
    const info = h('div#info', null,
      h('div.body', { text: d.body }),
      h('div.refs', null, (d.refs || []).map(refChip)),
      h('div.meta', null,
        h('a.hash.mono', { text: d.hash.slice(0, 10), title: 'Copy hash', href: '#', onclick: (e) => { e.preventDefault(); post('commitAction', { action: 'copy', hashes: [d.hash] }); } })),
      h('div.meta', null, h('b', { text: d.author }), h('span.muted', { text: ` <${d.email}> on ${new Date(d.time).toLocaleString()}` })),
      signatureInfo(d),
      tagInfo(d),
      d.committer !== d.author ? h('div.meta.muted', { text: `committed by ${d.committer} on ${new Date(d.commitTime).toLocaleString()}` }) : null,
      d.parents.length ? h('div.meta.muted', { text: `${d.parents.length > 1 ? 'Parents' : 'Parent'}: ${d.parents.map((p) => p.slice(0, 8)).join(', ')}` }) : null,
      d.containedIn
        ? h('div.meta.muted', null,
          `In ${d.containedIn.length} branch${d.containedIn.length === 1 ? '' : 'es'}: `,
          d.containedIn.slice(0, 20).map((b, i) => [i ? ', ' : '', h('span', { text: b, 'data-copy': b })]),
          d.containedIn.length > 20 ? ', …' : '')
        : h('div.meta.muted', { text: 'Looking for branches…' }));
    detailsEl.append(files, info);
  }

  /** Signature of the commit in the details: status, signer, key. */
  function signatureInfo(d) {
    const s = d.signature;
    if (s === undefined) return null;
    if (s === null) return h('div.meta.muted', { text: 'Checking signature…' });
    if (!s.level || s.level === 'none') return h('div.meta.muted', { text: 'Not signed' });
    return h('div.meta.signature', { title: s.trust ? `Trust: ${s.trust}` : null },
      sigMark(s), h('span', { text: ` ${s.text}` }),
      s.signer ? h('div.muted', { text: `Signed by ${s.signer}` }) : null,
      s.key ? h('div.muted', { text: `Key ${s.key}${s.trust ? ` · trust ${s.trust}` : ''}` }) : null);
  }

  /** git tag -v of the annotated tags on the commit. */
  function tagInfo(d) {
    if (!d.tags || !d.tags.length) return null;
    return d.tags.map((t) => (t.signed && t.signature
      ? h('div.meta.signature', { title: t.output || null }, h('span.muted', { text: `Tag ${t.name}: ` }), sigMark(t.signature),
        h('span', { text: ` ${t.signature.text}${t.signature.signer ? ` · ${t.signature.signer}` : ''}` }))
      : h('div.meta.muted', { text: `Tag ${t.name}: annotated, not signed` })));
  }

  /**
   * Which history rewriting actions apply to the selection. The extension
   * checks again against git's todo before rewriting anything.
   */
  function rewriteState(sel, c) {
    const single = sel.length === 1;
    const can = !!data.canRebase;
    const inHistory = (x) => !!x && ancestors.has(x.hash);
    // Not a merge and not the root: a commit line of the todo with a parent in range.
    const rewritable = (x) => inHistory(x) && x.parents.length === 1;
    const linear = (x) => inHistory(x) && x.parents.length <= 1;
    const parent = byHash.get(c.parents[0]);
    const child = data.commits.find((x) => rewritable(x) && x.parents[0] === c.hash);
    // Squash: one line of history, each selected commit the parent of the next.
    const hashes = new Set(sel.map((x) => x.hash));
    const tops = sel.filter((x) => !sel.some((y) => y.parents[0] === x.hash));
    let chain = 0;
    for (let x = tops.length === 1 ? tops[0] : null; x && hashes.has(x.hash) && linear(x); x = byHash.get(x.parents[0])) chain++;
    return {
      interactive: can && single && inHistory(c),
      reword: single && (c.hash === data.head || (can && rewritable(c))),
      fixup: can && single && rewritable(c) && linear(parent),
      squash: can && sel.length >= 2 && chain === sel.length,
      drop: can && sel.length > 0 && sel.every(rewritable),
      moveUp: can && single && rewritable(c) && !!child,
      moveDown: can && single && rewritable(c) && linear(parent),
    };
  }

  function commitMenu(x, y, c) {
    const sel = rows.filter((r) => selected.has(r.c.hash)).map((r) => r.c);
    const single = sel.length === 1;
    const isHead = c.hash === data.head;
    const rw = rewriteState(sel, c);
    showMenu(x, y, [
      { label: 'Copy Revision Number', id: 'copy' },
      '-',
      { label: 'Cherry-Pick', id: 'cherryPick' },
      { label: 'Create Patch…', id: 'createPatch' },
      { label: `Checkout Revision '${c.hash.slice(0, 8)}'`, id: 'checkout', disabled: !single },
      { label: 'Compare with Local', id: 'compare', disabled: !single },
      { label: 'Compare Commits', id: 'compareCommits', disabled: sel.length !== 2 },
      '-',
      { label: 'Reset Current Branch to Here…', id: 'reset', disabled: !single },
      { label: 'Revert Commit', id: 'revert' },
      { label: 'Undo Commit…', id: 'undo', disabled: !(single && isHead && c.parents.length) },
      '-',
      { label: 'Edit Commit Message…', id: 'reword', disabled: !rw.reword },
      { label: 'Fixup into Previous', id: 'fixup', disabled: !rw.fixup },
      { label: 'Squash Commits…', id: 'squash', disabled: !rw.squash },
      { label: 'Drop Commits', id: 'drop', disabled: !rw.drop, danger: true },
      '-',
      { label: 'Move Commit Up', id: 'moveUp', disabled: !rw.moveUp },
      { label: 'Move Commit Down', id: 'moveDown', disabled: !rw.moveDown },
      { label: 'Interactively Rebase from Here…', id: 'interactiveRebase', disabled: !rw.interactive },
      '-',
      { label: `Merge into Current…`, id: 'merge', disabled: !single || isHead || ancestors.has(c.hash) },
      '-',
      ...bisectItems(single),
      '-',
      { label: 'New Branch…', id: 'branch', disabled: !single },
      { label: 'New Tag…', id: 'tag', disabled: !single },
    ], (action) => post('commitAction', { action, hashes: sel.map((s) => s.hash) }));
  }

  /** Bisect items: start a session on a commit, or mark it while one is in progress. */
  function bisectItems(single) {
    if (!data.bisect) {
      return [
        { label: 'Bisect ▸ Start: Mark Bad', id: 'bisectBad', disabled: !single },
        { label: 'Bisect ▸ Start: Mark Good', id: 'bisectGood', disabled: !single },
      ];
    }
    const done = !!data.bisect.firstBad;
    return [
      { label: 'Bisect ▸ Mark Bad', id: 'bisectBad', disabled: !single || done },
      { label: 'Bisect ▸ Mark Good', id: 'bisectGood', disabled: !single || done },
      { label: 'Bisect ▸ Skip', id: 'bisectSkip', disabled: !single || done },
      { label: 'Bisect ▸ Run Script…', id: 'bisectRun', disabled: done },
      { label: 'Bisect ▸ Reset Bisect', id: 'bisectReset' },
    ];
  }

  renderSearchMode();
  renderToolbar();
  renderRows();
  renderDetails();
  post('ready');
})();
