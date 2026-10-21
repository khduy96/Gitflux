// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { STATUS_WORD } = require('./shelf');
const { worktreeWhat } = require('./worktrees');
const { worktreeOfBranch } = require('../domain/logic/worktree');

/**
 * Tree of HEAD, local / remote branches, tags, stashes, the shelf,
 * worktrees and the reflog.
 */
class BranchesTreeProvider {
  /** @param {import('./model').RepoManager} manager */
  constructor(manager) {
    this.manager = manager;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    /** Root nodes, kept until the tree changes so that reveal() finds the same objects. */
    this._roots = null;
    /** @type {vscode.TreeView<any>|null} */
    this.view = null;
    manager.onDidChange((what) => {
      if (what === 'refs' || what === 'status') this.changed();
    });
    manager.onDidChangeCurrent(() => this.changed());
  }

  changed() {
    this._roots = null;
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el) {
    return el.item;
  }

  getChildren(el) {
    const m = this.manager.current;
    if (!m) return [];
    if (!el) {
      if (!this._roots) this._roots = this.roots(m);
      return this._roots;
    }
    return el.children || [];
  }

  getParent(el) {
    return el.parent;
  }

  /** Command "Show Shelf": focuses the tree and expands the Shelf node. */
  async revealShelf() {
    await vscode.commands.executeCommand('gitTools.branches.focus');
    const m = this.manager.current;
    if (!m || !this.view) return;
    const node = this.getChildren().find((n) => n.kind === 'shelf');
    if (node) await this.view.reveal(node, { expand: true, select: true, focus: true });
    if (!m.shelves.length) vscode.window.setStatusBarMessage('The shelf is empty: use "Shelve Changes…" in the Commit view', 5000);
  }

  /** @param {import('./model').RepoModel} m */
  roots(m) {
    const s = m.status;
    const head = new vscode.TreeItem(
      s.branch ? `HEAD (${s.branch})` : `HEAD (detached at ${s.head ? s.head.slice(0, 8) : '?'})`,
      vscode.TreeItemCollapsibleState.None);
    head.iconPath = new vscode.ThemeIcon('target', new vscode.ThemeColor('charts.yellow'));
    head.description = [s.ahead ? `↑${s.ahead}` : '', s.behind ? `↓${s.behind}` : '', s.upstream || ''].filter(Boolean).join(' ');
    head.command = { command: 'gitTools.branch.showLog', title: 'Show in Log', arguments: [{ branch: { name: 'HEAD' } }] };

    const local = m.branches.filter((b) => !b.remote);
    const remote = m.branches.filter((b) => b.remote);
    const byRemote = new Map();
    for (const b of remote) {
      const r = b.name.slice(0, b.name.indexOf('/'));
      if (!byRemote.has(r)) byRemote.set(r, []);
      byRemote.get(r).push(b);
    }

    return [
      { item: head },
      this.group('Local', 'folder', this.branchNodes(local), true, local.length),
      this.group('Remote', 'cloud', [...byRemote].map(([r, list]) =>
        this.group(r, 'cloud', this.branchNodes(list, r.length + 1), false, list.length)), true),
      this.group('Tags', 'tag', m.tags.map((t) => this.tagNode(t)), false),
      this.group('Stashes', 'archive', m.stashes.map((st) => this.stashNode(st)), false),
      this.shelfGroup(m),
      this.worktreesGroup(m),
      this.reflogNode(),
      ...(m.repo.hasGitmodules() || m.submodules.length
        ? [{ ...this.group('Submodules', 'repo', m.submodules.map((s) => this.submoduleNode(m, s)), true), kind: 'submodules' }]
        : []),
    ].map((n) => {
      if (n.kind === 'submodules') n.item.contextValue = 'submodules';
      return n;
    });
  }

  /** @param {import('./model').RepoModel} m @param {import('../domain/entities').Submodule} s */
  submoduleNode(m, s) {
    const item = new vscode.TreeItem(s.path, vscode.TreeItemCollapsibleState.None);
    const state = {
      upToDate: ['', 'repo', undefined],
      uninitialized: ['not initialized', 'circle-slash', 'list.warningForeground'],
      outOfDate: ['out of date', 'repo', 'gitDecoration.modifiedResourceForeground'],
      conflict: ['conflict', 'warning', 'gitDecoration.conflictingResourceForeground'],
      notRegistered: ['not registered', 'warning', 'list.warningForeground'],
    }[s.status];
    item.iconPath = new vscode.ThemeIcon(state[1], state[2] ? new vscode.ThemeColor(state[2]) : undefined);
    item.description = state[0] || s.sha.slice(0, 7);
    item.tooltip = s.status === 'notRegistered'
      ? `${s.path}\nDeclared in .gitmodules but not recorded in the parent repository.\nUse "Register as Submodule" to add it.`
      : `${s.path}\n${s.url ? `${s.url}\n` : ''}${s.sha.slice(0, 10)}${s.describe ? ` (${s.describe})` : ''}`;
    item.contextValue = {
      uninitialized: 'submodule-uninitialized',
      notRegistered: s.sha ? 'submodule-unregistered' : 'submodule-missing',
    }[s.status] || 'submodule';
    return { item, submodule: s, parent: m };
  }

  group(label, icon, children, expanded, count = children.length) {
    const item = new vscode.TreeItem(label,
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon(icon);
    item.description = String(count);
    item.contextValue = 'group';
    return { item, children };
  }

  /**
   * Branches nested into folders by the `/` in their names
   * (feature/a, feature/b → feature ▸ a, b), folders first. A folder holding
   * the current branch starts expanded.
   * @param {import('../domain/entities').Branch[]} list
   * @param {number} skip leading characters of each name already shown by the parents
   */
  branchNodes(list, skip = 0) {
    const folders = new Map();
    const leaves = [];
    for (const b of list) {
      const rest = b.name.slice(skip);
      const i = rest.indexOf('/');
      if (i < 0) {
        leaves.push(this.branchNode(b, rest));
        continue;
      }
      const dir = rest.slice(0, i);
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir).push(b);
    }
    return [
      ...[...folders].map(([dir, sub]) => this.group(dir, 'folder',
        this.branchNodes(sub, skip + dir.length + 1), sub.some((b) => b.current), sub.length)),
      ...leaves,
    ];
  }

  /** @param {import('../domain/entities').Branch} b */
  branchNode(b, label) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const fav = /(^|\/)(main|master|develop)$/.test(b.name);
    item.iconPath = b.current
      ? new vscode.ThemeIcon('tag', new vscode.ThemeColor('charts.yellow'))
      : fav ? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon('git-branch', new vscode.ThemeColor(b.remote ? 'charts.purple' : 'charts.green'));
    // A local branch another worktree has checked out (git refuses to check it out here).
    const m = this.manager.current;
    const elsewhere = !b.remote && !b.current && m ? worktreeOfBranch(m.worktrees || [], b.name) : null;
    item.description = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : '', b.gone ? 'gone' : '',
      elsewhere ? `checked out in ${path.basename(elsewhere.path)}` : ''].filter(Boolean).join(' ');
    item.tooltip = `${b.name}${b.upstream ? `\nTracking ${b.upstream}` : ''}\n${b.hash.slice(0, 10)}` +
      `${elsewhere ? `\nChecked out in worktree ${elsewhere.path}` : ''}`;
    item.contextValue = b.current ? 'branch-current' : b.remote ? 'branch-remote' : 'branch-local';
    item.command = { command: 'gitTools.branch.showLog', title: 'Show in Log', arguments: [{ branch: b }] };
    return { item, branch: b };
  }

  tagNode(t) {
    const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('tag', new vscode.ThemeColor('charts.blue'));
    item.description = t.hash.slice(0, 8);
    item.contextValue = 'tag';
    // Branch-like object so shared commands (new branch, merge) work on tags.
    const asBranch = { name: `refs/tags/${t.name}`, remote: false, current: false, hash: t.hash, upstream: null, ahead: 0, behind: 0, gone: false };
    item.command = { command: 'gitTools.branch.showLog', title: 'Show in Log', arguments: [{ branch: asBranch }] };
    return { item, tag: t, branch: asBranch };
  }

  /** Opens the Reflog panel: where HEAD pointed, to find lost commits. */
  reflogNode() {
    const item = new vscode.TreeItem('Reflog', vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('history');
    item.tooltip = 'Where HEAD pointed (commit, reset, rebase, checkout…): recover commits lost by history rewriting';
    item.contextValue = 'reflog';
    item.command = { command: 'gitTools.showReflog', title: 'Show Reflog' };
    return { item };
  }

  /**
   * Shelf: shelves (newest first) ▸ shelved files.
   * @param {import('./model').RepoModel} m
   */
  shelfGroup(m) {
    const node = { ...this.group('Shelf', 'inbox', [], false, m.shelves.length), kind: 'shelf' };
    node.item.id = 'gitTools.shelf';
    node.item.contextValue = 'shelfGroup';
    node.item.tooltip = 'Changes put aside with "Shelve Changes…" (Commit view), file by file, outside the stash';
    node.children = m.shelves.map((s) => this.shelfNode(s, node));
    return node;
  }

  /**
   * Worktrees: the main one first, the current one marked.
   * @param {import('./model').RepoModel} m
   */
  worktreesGroup(m) {
    const list = m.worktrees || [];
    const node = { ...this.group('Worktrees', 'list-tree', [], false, list.length), kind: 'worktrees', model: m };
    node.item.contextValue = 'worktrees';
    node.item.tooltip = 'Other working folders of this repository (git worktree), each with its own checked-out branch';
    node.children = list.map((w) => this.worktreeNode(m, w, node));
    return node;
  }

  /** @param {import('./model').RepoModel} m @param {import('../domain/entities').Worktree} w */
  worktreeNode(m, w, parent) {
    const item = new vscode.TreeItem(path.basename(w.path) || w.path, vscode.TreeItemCollapsibleState.None);
    item.iconPath = w.prunable ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : w.current ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
        : w.locked ? new vscode.ThemeIcon('lock')
          : new vscode.ThemeIcon(w.main ? 'repo' : 'folder');
    item.description = [worktreeWhat(w), w.current ? 'current' : '', w.main ? 'main worktree' : '', w.locked ? 'locked' : '',
      w.prunable ? 'prunable' : ''].filter(Boolean).join(' · ');
    item.tooltip = [
      w.path,
      w.bare ? 'Bare repository' : w.branch ? `Branch ${w.branch}` : 'Detached HEAD',
      w.head ? `HEAD ${w.head.slice(0, 10)}` : '',
      w.main ? 'Main worktree' : '',
      w.current ? 'Current worktree (this window)' : '',
      w.locked ? `Locked${w.lockReason ? `: ${w.lockReason}` : ''}` : '',
      w.prunable ? `Prunable${w.prunableReason ? `: ${w.prunableReason}` : ''}` : '',
    ].filter(Boolean).join('\n');
    // Order fixed: package.json menus match it with regexes.
    item.contextValue = `worktree${w.main ? '-main' : ''}${w.current ? '-current' : ''}${w.locked ? '-locked' : ''}${w.prunable ? '-prunable' : ''}`;
    return { item, worktree: w, model: m, parent };
  }

  /** @param {import('../domain/entities').Shelf} s */
  shelfNode(s, parent) {
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `gitTools.shelf/${s.id}`;
    item.iconPath = new vscode.ThemeIcon('package');
    const n = s.files.length;
    item.description = [relativeTime(s.created), `${n} file${n === 1 ? '' : 's'}`, s.branch || ''].filter(Boolean).join(' · ');
    item.tooltip = `${s.name}
Created ${s.created ? new Date(s.created).toLocaleString() : '?'}
` +
      `${s.branch ? `Branch ${s.branch}
` : ''}Base ${s.base.slice(0, 10)}
${n} file${n === 1 ? '' : 's'}`;
    item.contextValue = 'shelf';
    const node = { item, shelf: s, parent, children: [] };
    node.children = s.files.map((f) => this.shelfFileNode(s, f, node));
    return node;
  }

  /** @param {import('../domain/entities').Shelf} s @param {import('../domain/entities').ShelfFile} f */
  shelfFileNode(s, f, parent) {
    const item = new vscode.TreeItem(path.posix.basename(f.path), vscode.TreeItemCollapsibleState.None);
    item.id = `gitTools.shelf/${s.id}/${f.path}`;
    // File icon of the theme; the status letter in the description.
    item.resourceUri = vscode.Uri.from({ scheme: 'gittools-shelf-item', path: `/${f.path}` });
    const dir = path.posix.dirname(f.path);
    item.description = `${f.status}${f.oldPath ? ` ← ${f.oldPath}` : dir === '.' ? '' : ` · ${dir}`}`;
    item.tooltip = `${STATUS_WORD[f.status]}: ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''}`;
    item.contextValue = 'shelfFile';
    item.command = { command: 'gitTools.shelf.showDiff', title: 'Show Diff', arguments: [{ shelf: s, file: f }] };
    return { item, shelf: s, file: f, parent };
  }

  stashNode(st) {
    const item = new vscode.TreeItem(st.message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('archive');
    item.description = st.ref;
    item.tooltip = `${st.ref}\n${st.message}\n${new Date(st.time).toLocaleString()}`;
    item.contextValue = 'stash';
    item.command = { command: 'gitTools.stash.showFiles', title: 'Show Changes', arguments: [{ stash: st }] };
    return { item, stash: st };
  }
}

/** "5 minutes ago", "3 days ago"… */
function relativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  let n = Math.max(0, Math.round((now - ms) / 1000));
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  for (const [size, unit] of steps) {
    if (n < size) return unit === 'second' && n < 10 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    n = Math.floor(n / size);
  }
  return '';
}

/**
 * Status bar entry with the current branch (opens the branches popup).
 */
class BranchStatusBar {
  /** @param {import('./model').RepoManager} manager */
  constructor(manager) {
    this.manager = manager;
    this.item = vscode.window.createStatusBarItem('gitTools.branch', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'Git Tools Branch';
    this.item.command = 'gitTools.branches';
    manager.onDidChange(() => this.update());
    manager.onDidChangeCurrent(() => this.update());
    this.update();
  }

  update() {
    const m = this.manager.current;
    if (!m) {
      this.item.hide();
      return;
    }
    const s = m.status;
    const name = s.branch || (s.head ? s.head.slice(0, 8) : 'no commits');
    const sync = [s.ahead ? `${s.ahead}↑` : '', s.behind ? `${s.behind}↓` : ''].filter(Boolean).join(' ');
    const multi = this.manager.models.size > 1 ? `${m.name}: ` : '';
    this.item.text = `${m.busy ? '$(sync~spin)' : '$(git-branch)'} ${multi}${name}${sync ? ` ${sync}` : ''}`;
    this.item.tooltip = m.busy ? `${m.busy}…` : `Git Tools · ${m.name}\nBranch: ${name}${s.upstream ? `\nTracking ${s.upstream}` : ''}\nClick for branches and actions`;
    this.item.show();
  }

  dispose() {
    this.item.dispose();
  }
}

module.exports = { BranchesTreeProvider, BranchStatusBar };
