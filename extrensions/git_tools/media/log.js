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
  let data = { commits: [], graph: [], head: null, loading: true, filter: {}, authors: [], branches: [], repo: null, canRebase: false };
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
  const branchOpen = new Set(saved.branchOpen || ['Local', 'Remote']);
  /** Branch picker while open: {el, input, list, rows, active}. */
  let picker = null;

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
  const persist = () => vscode.setState({ detailsWidth, text, searchMode, regex, branchOpen: [...branchOpen] });
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
        renderDetails();
      }
    } else if (msg.type === 'repoState') {
      data.canRebase = msg.canRebase;
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

  function openPicker() {
    const current = (data.filter || {}).branch || '';
    // Opens the folders down to the branch shown.
    const b = data.branches.find((x) => x.name === current);
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
    picker.active = Math.max(0, picker.rows.findIndex((r) => r.kind === 'branch' && r.key === current));

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
      persist();
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
      c.refs.map(refChip),
      h('span.subject.ellipsis', { text: c.subject, title: c.subject }),
      h('span.author.ellipsis', { text: c.author }),
      h('span.date', { text: formatDate(c.time) }),
      h('span.hash.mono', { text: c.hash.slice(0, 8) }));
      rowsEl.append(row);
    }
  }

  function refChip(r) {
    const icon = r.kind === 'head' ? '◉' : r.kind === 'tag' ? '🏷' : '⑂';
    return h(`span.ref.${r.kind}`, { title: r.name }, r.kind === 'head' ? icon : `${icon} ${r.name}`);
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
      d.committer !== d.author ? h('div.meta.muted', { text: `committed by ${d.committer} on ${new Date(d.commitTime).toLocaleString()}` }) : null,
      d.parents.length ? h('div.meta.muted', { text: `${d.parents.length > 1 ? 'Parents' : 'Parent'}: ${d.parents.map((p) => p.slice(0, 8)).join(', ')}` }) : null,
      h('div.meta.muted', { text: d.containedIn ? `In ${d.containedIn.length} branch${d.containedIn.length === 1 ? '' : 'es'}: ${d.containedIn.slice(0, 20).join(', ')}${d.containedIn.length > 20 ? ', …' : ''}` : 'Looking for branches…' }));
    detailsEl.append(files, info);
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
      { label: 'New Branch…', id: 'branch', disabled: !single },
      { label: 'New Tag…', id: 'tag', disabled: !single },
    ], (action) => post('commitAction', { action, hashes: sel.map((s) => s.hash) }));
  }

  renderSearchMode();
  renderToolbar();
  renderRows();
  renderDetails();
  post('ready');
})();
