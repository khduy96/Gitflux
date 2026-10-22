// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { GitError, CommitRejected, ShelfRejected, PatchRejected } = require('../domain/errors');
const { layoutGraph } = require('../domain/logic/graph');
const { emptyLogFilter, hasCommitFilter, logQuery, authorPatterns, buildAuthorList } = require('../domain/logic/history');
const { CommitChanges } = require('../domain/usecases/commitChanges');
const { InteractiveRebase } = require('../domain/usecases/interactiveRebase');
const { selectedLineContents } = require('../domain/usecases/selectedLineContents');
const { ShelveChanges } = require('../domain/usecases/shelveChanges');
const { Patches } = require('../domain/usecases/patches');
const { Changelists, DEFAULT_LIST } = require('../domain/usecases/changelists');
const { isSigningFailure } = require('../domain/logic/signing');
const { isLfsError, lfsErrorLines } = require('../domain/logic/lfs');

/** LFS locks are asked from the remote at most this often (ms), unless forced. */
const LOCKS_INTERVAL = 60000;
/** git subcommands that create commits or tags: their failures can be signing failures. */
const SIGNING_COMMANDS = new Set(['commit', 'commit-tree', 'merge', 'tag', 'rebase', 'cherry-pick', 'revert', 'am']);

/** The git subcommand of failed arguments (`-c key=value` skipped). @param {string[]} args */
function subcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return null;
}

/** @typedef {import('../domain/ports').GitService} GitService */

/** "Delete changelist '<name>'?" after a commit emptied it; off for the session once declined for good. */
let askDeleteEmptyList = true;

/**
 * State of one repository, shared by all views.
 */
class RepoModel {
  /**
   * @param {string} root
   * @param {vscode.OutputChannel} output
   * @param {GitService} git
   */
  constructor(root, output, git) {
    this.output = output;
    this.repo = git.open(root, { log: (line, kind) => this.log(line, kind) });
    this.commitChanges = new CommitChanges(this.repo);
    this.interactiveRebase = new InteractiveRebase(this.repo);
    this.shelfStore = git.shelfStore(this.repo);
    this.shelve = new ShelveChanges(this.repo, this.shelfStore);
    this.patches = new Patches(this.repo);
    /** Changelists of this worktree (changelists.json, shared with the Flutter app). */
    this.changelists = new Changelists(git.changelistStore(this.repo));
    /** Active list the ticks and the message box belong to (null before the first status). @type {string|null} */
    this._activeList = null;
    /** Tracked paths of the last status: a path not in it is seen for the first time. @type {Set<string>|null} */
    this._knownTracked = null;
    /** @type {import('../domain/entities').Status} */
    this.status = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, changes: [], state: 'normal' };
    /** Progress of the rebase in progress (Commit view banner). @type {import('../domain/entities').RebaseProgress|null} */
    this.rebaseProgress = null;
    /** @type {import('../domain/entities').Branch[]} */
    this.branches = [];
    /** @type {{name: string, hash: string}[]} */
    this.tags = [];
    /** @type {{name: string, url: string}[]} */
    this.remotes = [];
    /** @type {any[]} */
    this.stashes = [];
    /** @type {import('../domain/entities').Submodule[]} */
    this.submodules = [];
    /** Newest first. @type {import('../domain/entities').Shelf[]} */
    this.shelves = [];
    /** Main worktree first; `current` marks this one. @type {import('../domain/entities').Worktree[]} */
    this.worktrees = [];
    /** Bisect session in progress (Commit view banner, Log labels). @type {import('../domain/entities').BisectState|null} */
    this.bisect = null;
    /** @type {import('../domain/entities').Commit[]} */
    this.commits = [];
    /** @type {ReturnType<typeof layoutGraph>} */
    this.graph = [];
    /** Kept for the session, per repository. @type {import('../domain/logic/history').LogFilter} */
    this.logFilter = emptyLogFilter();
    /** Authors of the commits loaded without a user filter (Log "User" dropdown). */
    /** @type {import('../domain/logic/history').AuthorEntry[]} */
    this.authors = [];
    this.logLoading = false;

    /** Commit message shown in the Commit view. */
    this.message = '';
    this.amend = false;
    this._prefilled = null;
    /** Commit options: sign (null = follow commit.gpgsign) and Signed-off-by. @type {boolean|null} */
    this.sign = null;
    this.signOff = false;
    /** Signing configuration (commit.gpgsign, gpg.format, user.signingkey…), null until read. @type {any} */
    this.signing = null;

    /** Git LFS of this repository (null when the service has none). */
    this.lfs = /** @type {any} */ (git).lfs ? /** @type {any} */ (git).lfs(this.repo) : null;
    this.lfsAvailable = false;
    /** Changed paths an LFS filter applies to. @type {Set<string>} */
    this.lfsPaths = new Set();
    /** LFS locks by path, null when the remote has no locking. @type {Map<string, {id: string, path: string, owner: string, mine: boolean}>|null} */
    this.lfsLocks = null;
    /** Time of the last locks request (ms). */
    this._locksAt = 0;

    // Checkbox model: tracked files are included unless excluded,
    // unversioned files are excluded unless included. Tracked files of
    // changelists other than the active one start excluded.
    /** @type {Set<string>} */
    this.excludedTracked = new Set();
    /** @type {Set<string>} */
    this.includedUntracked = new Set();
    /**
     * Files committed partially: path → excluded line keys of its diff.
     * @type {Map<string, {signature: string, excluded: Set<string>, total: number}>}
     */
    this.lineSelections = new Map();

    /** @type {string|null} */
    this.busy = null;

    this._onDidChange = new vscode.EventEmitter();
    /** Fires with 'status' | 'refs' | 'log' | 'message' | 'busy'. */
    this.onDidChange = this._onDidChange.event;

    /** @type {vscode.Disposable[]} */
    this.disposables = [this._onDidChange];
    this._timer = null;
    this._refsDirty = false;
    this._logGen = 0;
    this._started = false;
    /** True once refs and log are loaded (repository was selected). */
    this._full = false;
    this._watching = false;
  }

  get root() {
    return this.repo.root;
  }

  get name() {
    return this.repo.name;
  }

  log(line, kind = 'info') {
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const prefix = kind === 'command' ? `${stamp} > ` : kind === 'output' ? '    ' : kind === 'error' ? `${stamp} ! ` : `${stamp}   `;
    this.output.appendLine(prefix + line);
  }

  fire(what) {
    this._onDidChange.fire(what);
  }

  async start() {
    this._full = true;
    await this.refreshAll();
    this.refreshLfsLocks(true);
    const msg = await this.repo.pendingMergeMessage().catch(() => null);
    if (msg && !this.message) {
      this.message = msg;
      this._prefilled = msg;
      this.fire('message');
    } else if (!this.message) {
      // The message box is the draft of the active changelist.
      const list = this.changelists.list(this.changelists.active);
      if (list && list.comment) {
        this.message = list.comment;
        this.fire('message');
      }
    }
    this.watch();
  }

  /** Status only, for repositories that are listed but not selected. */
  async startLight() {
    await this.refreshStatus();
    this.watch();
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    if (this._timer) clearTimeout(this._timer);
  }

  // ------------------------------------------------------------- watching

  watch() {
    if (this._watching || !vscode.workspace.getConfiguration('gitTools').get('autoRefresh')) return;
    this._watching = true;
    const onFile = (uri) => {
      const rel = path.relative(this.root, uri.fsPath).replace(/\\/g, '/');
      if (rel.startsWith('..')) return;
      if (rel === '.git' || rel.startsWith('.git/')) {
        if (rel.endsWith('.lock') || rel.startsWith('.git/objects') || rel.startsWith('.git/logs')) return;
        // .git/git-tools/shelf: shelves changed here or by the Flutter app.
        // .git/worktrees: worktrees added, removed, locked; BISECT_*: a bisect session.
        if (rel.startsWith('.git/refs') || /^\.git\/(HEAD|packed-refs|FETCH_HEAD|MERGE_HEAD|ORIG_HEAD|BISECT_\w+)$/.test(rel) ||
            rel.startsWith('.git/rebase-') || rel.startsWith('.git/git-tools/shelf/') || /^\.git\/worktrees\/[^/]+(\/(locked|gitdir))?$/.test(rel)) {
          this._refsDirty = true;
        } else if (rel !== '.git/index' && rel !== '.git/git-tools/changelists.json') {
          // changelists.json: lists changed by the Flutter app (or another window).
          return;
        }
      }
      this.scheduleRefresh();
    };
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**'));
    w.onDidChange(onFile);
    w.onDidCreate(onFile);
    w.onDidDelete(onFile);
    this.disposables.push(w);
    this.disposables.push(vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        this._refsDirty = true;
        this.scheduleRefresh();
      }
    }));
  }

  scheduleRefresh() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this.busy) return; // refreshed when the operation ends
      if (this._refsDirty && this._full) {
        this._refsDirty = false;
        this.refreshAll();
      } else {
        this.refreshStatus();
      }
    }, 600);
  }

  // ------------------------------------------------------------- refresh

  async refreshAll() {
    const headBefore = this.status.head;
    await Promise.all([this.refreshStatus(), this.refreshRefs()]);
    this.checkSubmodulesAfterHeadChange(headBefore);
    this.refreshLfsLocks();
    await this.refreshLog();
  }

  /**
   * LFS locks of the remote (`git lfs locks`, a network call): asked only
   * when the repository tracks LFS patterns, at most once a minute unless
   * forced (after Lock / Unlock). Null when the remote has no locking.
   */
  async refreshLfsLocks(force = false) {
    if (!this.lfs || !this.lfsAvailable || !this._full) return;
    if (!force && Date.now() - this._locksAt < LOCKS_INTERVAL) return;
    this._locksAt = Date.now();
    try {
      const usesLfs = (await this.lfs.trackedPatterns()).length > 0;
      const locks = usesLfs ? await this.lfs.locks() : null;
      this.lfsLocks = locks ? new Map(locks.map((l) => [l.path, l])) : null;
    } catch (e) {
      this.lfsLocks = null;
      this.log(`LFS locks: ${e.message}`, 'info');
    }
    this.fire('status');
  }

  /**
   * After checkout / pull / merge / reset of this repository, offers to bring
   * submodules to the recorded commits.
   */
  checkSubmodulesAfterHeadChange(headBefore) {
    if (!headBefore || headBefore === this.status.head) return;
    const stale = this.submodules.filter((s) => s.status === 'outOfDate' || s.status === 'uninitialized');
    if (!stale.length) return;
    vscode.window.showInformationMessage(
      `${stale.length} submodule${stale.length === 1 ? ' is' : 's are'} not at the commit recorded by ${this.name}: ${stale.slice(0, 5).map((s) => s.path).join(', ')}`,
      'Update Submodules',
    ).then((r) => { if (r) this.updateSubmodules(); });
  }

  /** git submodule update --init --recursive (all when `paths` is empty). */
  updateSubmodules(paths = []) {
    return this.run(paths.length === 1 ? `Update submodule ${paths[0]}` : 'Update submodules',
      () => this.repo.updateSubmodules(paths), { success: 'Submodules updated' });
  }

  async refreshStatus() {
    try {
      const previous = this.status.state;
      this.status = await this.repo.status();
      if (this.status.state === 'rebasing' || this.status.state === 'applyingMailbox') {
        this.rebaseProgress = await this.repo.rebaseProgress().catch(() => null);
      } else {
        this.rebaseProgress = null;
        // Todo and message files of an interactive rebase that has ended.
        if (!this.busy) await this.repo.cleanupRebaseState().catch(() => {});
      }
      this.bisect = await this.repo.bisectState().catch(() => null);
      const paths = new Set(this.status.changes.map((c) => c.path));
      for (const p of [...this.excludedTracked]) if (!paths.has(p)) this.excludedTracked.delete(p);
      for (const p of [...this.includedUntracked]) if (!paths.has(p)) this.includedUntracked.delete(p);
      for (const p of [...this.lineSelections.keys()]) {
        const c = this.status.changes.find((x) => x.path === p);
        if (!this.canSelectLines(c)) this.lineSelections.delete(p);
      }
      await this.syncChangelists();
      await this.refreshLfsPaths();
      // Prefill the prepared message when a merge / cherry-pick starts and
      // clear it again when the operation ends elsewhere.
      if (previous === 'normal' && this.status.state !== 'normal' && !this.message.trim()) {
        const msg = await this.repo.pendingMergeMessage();
        if (msg) {
          this.message = msg;
          this._prefilled = msg;
          this.fire('message');
        }
      } else if (this.status.state === 'normal' && this._prefilled && this.message.trim() === this._prefilled.trim()) {
        this.message = '';
        this._prefilled = null;
        this.fire('message');
      }
      this.fire('status');
    } catch (e) {
      this.log(`status failed: ${e.message}`, 'error');
    }
  }

  /** Changed files stored with Git LFS (`git check-attr`), for the selected repository only. */
  async refreshLfsPaths() {
    if (!this.lfs || !this._full) return;
    this.lfsAvailable = await this.lfs.available().catch(() => false);
    this.lfsPaths = this.lfsAvailable
      ? await this.lfs.lfsPaths(this.status.changes.filter((c) => !c.nestedRepo).map((c) => c.path)).catch(() => new Set())
      : new Set();
  }

  // ------------------------------------------------------------- changelists

  /**
   * After a status refresh: the lists follow the changes (first seen files
   * go to the active list, unchanged ones leave). A file seen for the first
   * time is ticked when it is in the active list; when another app made a
   * different list active, the ticks follow it.
   */
  async syncChangelists() {
    const before = this._activeList;
    try {
      await this.changelists.reconcile(this.status.changes);
    } catch (e) {
      this.log(`changelists: ${e.message}`, 'error');
    }
    const active = this.changelists.active;
    const tracked = this.status.changes.filter((c) => c.type !== 'untracked' && c.type !== 'conflicted').map((c) => c.path);
    if (before !== null && before !== active) {
      this.applyActiveTicks();
      const list = this.changelists.list(active);
      if (!this.message.trim() && list && list.comment) {
        this.message = list.comment;
        this.fire('message');
      }
    } else {
      const known = this._knownTracked;
      for (const p of tracked) {
        if (known && known.has(p)) continue;
        const list = this.changelists.listOf(p);
        if (!list || list === active) this.excludedTracked.delete(p);
        else this.excludedTracked.add(p);
      }
    }
    this._knownTracked = new Set(tracked);
    this._activeList = active;
  }

  /** Ticks exactly the tracked files of the active list. */
  applyActiveTicks() {
    const active = this.changelists.active;
    for (const c of this.status.changes) {
      if (c.type === 'untracked' || c.type === 'conflicted') continue;
      const list = this.changelists.listOf(c.path);
      if (!list || list === active) {
        this.excludedTracked.delete(c.path);
      } else {
        this.excludedTracked.add(c.path);
        this.lineSelections.delete(c.path);
      }
    }
  }

  /**
   * Runs a changelist change; a failure (file not readable, name taken…) is
   * shown and logged. Returns the result, undefined on failure.
   * @template T
   * @param {() => Promise<T>} fn
   */
  async changelistOp(fn) {
    try {
      return await fn();
    } catch (e) {
      const text = String(e && e.message ? e.message : e);
      this.log(`changelists: ${text}`, 'error');
      vscode.window.showErrorMessage(text);
      return undefined;
    } finally {
      this.fire('status');
    }
  }

  /**
   * Makes `id` the active changelist: the message box text is saved as the
   * draft of the list active until now and the new list's draft is loaded;
   * the ticks become exactly the files of the new list.
   * @param {string} id
   */
  setActiveChangelist(id) {
    return this.changelistOp(async () => {
      if (id === this.changelists.active) return;
      const comment = await this.changelists.setActive(id, this.message);
      this._activeList = this.changelists.active;
      this.includedUntracked.clear();
      this.applyActiveTicks();
      this.message = comment;
      this._prefilled = null;
      this.fire('message');
    });
  }

  /**
   * Moves tracked files to list `id` (unversioned files are never in a list).
   * Moved into the active list they are ticked, out of it unticked.
   * @param {string[]} paths
   * @param {string} id
   */
  moveToChangelist(paths, id) {
    return this.changelistOp(async () => {
      const tracked = new Set(this.status.changes.filter((c) => c.type !== 'untracked').map((c) => c.path));
      const files = paths.filter((p) => tracked.has(p));
      if (!files.length) return;
      await this.changelists.move(files, id);
      this.tickForList(files, id);
    });
  }

  /** @param {string[]} paths @param {string} id list they are now in */
  tickForList(paths, id) {
    for (const p of paths) {
      if (id === this.changelists.active) {
        this.excludedTracked.delete(p);
      } else {
        this.excludedTracked.add(p);
        this.lineSelections.delete(p);
      }
    }
  }

  /**
   * New changelist, optionally holding tracked `paths` and made active.
   * @param {{name: string, comment?: string, active?: boolean, paths?: string[]}} o
   * @returns {Promise<string|undefined>} its id
   */
  async createChangelist(o) {
    const id = await this.changelistOp(async () => {
      const tracked = new Set(this.status.changes.filter((c) => c.type !== 'untracked').map((c) => c.path));
      const paths = (o.paths || []).filter((p) => tracked.has(p));
      const created = await this.changelists.create({ name: o.name, comment: o.comment, paths });
      this.tickForList(paths, created);
      return created;
    });
    if (id && o.active) await this.setActiveChangelist(id);
    return id;
  }

  /**
   * Renames a list and / or changes its draft; the draft of the active list
   * is the message box.
   * @param {string} id
   * @param {{name?: string, comment?: string, active?: boolean}} o
   */
  async editChangelist(id, o) {
    const ok = await this.changelistOp(async () => {
      await this.changelists.edit(id, { name: o.name, comment: o.comment });
      if (id === this.changelists.active && o.comment !== undefined) {
        this.message = o.comment;
        this.fire('message');
      }
      return true;
    });
    if (ok && o.active) await this.setActiveChangelist(id);
  }

  /**
   * Deletes a list: its files go to the active list (the default one when
   * the active list is deleted, which then becomes active).
   * @param {string} id
   */
  deleteChangelist(id) {
    return this.changelistOp(async () => {
      const wasActive = id === this.changelists.active;
      const files = this.changelists.filesOf(id);
      const target = await this.changelists.remove(id);
      this._activeList = this.changelists.active;
      if (wasActive) this.applyActiveTicks();
      else this.tickForList(files, target);
    });
  }

  /**
   * Adds unversioned files to Git and puts them in list `id` (drop on a
   * changelist group).
   * @param {import('../domain/entities').FileChange[]} changes
   * @param {string} id
   */
  async addToChangelist(changes, id) {
    const files = changes.filter((c) => c.type === 'untracked' && !c.nestedRepo);
    if (!files.length) return;
    const paths = files.map((c) => c.path);
    const list = this.changelists.list(id);
    await this.run(files.length === 1 ? `Add ${path.basename(paths[0])} to Git` : `Add ${files.length} files to Git`, async () => {
      await this.repo.add(paths);
      await this.changelists.move(paths, id);
    }, { success: `${files.length} file(s) added to ${list ? `"${list.name}"` : 'Git'}`, refresh: false });
    await this.refreshStatus();
  }

  /**
   * Puts tracked `paths` in the list named `name` when there is one, else
   * leaves them where the status refresh put them (the active list).
   * Unshelved files go back to the changelist named like the shelf.
   * @param {string} name
   * @param {string[]} paths
   */
  async assignToChangelistNamed(name, paths) {
    const list = this.changelists.byName(name);
    if (list) await this.moveToChangelist(paths, list.id);
  }

  /**
   * After a commit: offers to delete the non-default lists it left empty.
   * @param {Set<string>} ids lists the committed files were in
   */
  async offerDeleteEmptyLists(ids) {
    for (const id of ids) {
      const list = this.changelists.list(id);
      if (!askDeleteEmptyList || !list || id === DEFAULT_LIST || list.files.length) continue;
      const r = await vscode.window.showInformationMessage(`Delete changelist '${list.name}'?`,
        'Delete', 'Keep', 'Keep, Don\'t Ask Again This Session');
      if (r === 'Delete') await this.deleteChangelist(id);
      else if (r && r !== 'Keep') askDeleteEmptyList = false;
    }
  }

  async refreshRefs() {
    try {
      const [branches, tags, remotes, stashes, submodules, shelves, worktrees, signing] = await Promise.all([
        this.repo.branches(), this.repo.tags(), this.repo.remotes(), this.repo.stashes(), this.repo.submodules(),
        this.shelfStore.list().catch(() => []), this.repo.worktrees().catch(() => []), this.repo.signingConfig().catch(() => null),
      ]);
      Object.assign(this, { branches, tags, remotes, stashes, submodules, shelves, worktrees, signing });
      this.fire('refs');
    } catch (e) {
      this.log(`refs failed: ${e.message}`, 'error');
    }
  }

  async refreshLog() {
    const gen = ++this._logGen;
    this.logLoading = true;
    this.fire('log');
    try {
      const limit = vscode.workspace.getConfiguration('gitTools').get('log.maxCommits') || 2000;
      const f = this.logFilter;
      const me = f.user && f.user.kind === 'me' ? await this.repo.currentUser() : undefined;
      if (f.user && authorPatterns(f.user, me) === null) {
        vscode.window.showWarningMessage('Set user.name or user.email in the Git config to filter by "Me".');
        this.logFilter = { ...f, user: null };
      }
      const commits = await this.repo.log({ ...logQuery(this.logFilter, me), limit: Number(limit) });
      if (gen !== this._logGen) return;
      this.commits = commits;
      // Filtered commits are not a connected history: no graph.
      this.graph = hasCommitFilter(this.logFilter) ? [] : layoutGraph(commits);
      if (!this.logFilter.user) this.authors = buildAuthorList(commits);
    } catch (e) {
      this.log(`log failed: ${e.message}`, 'error');
    } finally {
      if (gen === this._logGen) {
        this.logLoading = false;
        this.fire('log');
      }
    }
  }

  /** @param {Partial<import('../domain/logic/history').LogFilter>} filter */
  setLogFilter(filter) {
    this.logFilter = { ...this.logFilter, ...filter };
    this.refreshLog();
  }

  // ------------------------------------------------------------- inclusion

  isIncluded(c) {
    // A nested repository is never committed as files (register it instead).
    if (c.nestedRepo) return false;
    return c.type === 'untracked' ? this.includedUntracked.has(c.path) : !this.excludedTracked.has(c.path);
  }

  /** @param {string[]} paths @param {boolean} value */
  setIncluded(paths, value) {
    const byPath = new Map(this.status.changes.map((c) => [c.path, c]));
    for (const p of paths) {
      const c = byPath.get(p);
      if (!c || c.type === 'conflicted') continue;
      // Ticking / unticking the whole file drops a line selection.
      this.lineSelections.delete(p);
      if (c.type === 'untracked') {
        if (value) this.includedUntracked.add(p);
        else this.includedUntracked.delete(p);
      } else if (value) this.excludedTracked.delete(p);
      else this.excludedTracked.add(p);
    }
    this.fire('status');
  }

  includedChanges() {
    return this.status.changes.filter((c) => c.type !== 'conflicted' && this.isIncluded(c));
  }

  setMessage(text) {
    this.message = text;
  }

  // ------------------------------------------------------------- line selection

  /** Whether lines of this change can be selected individually. */
  canSelectLines(c) {
    return !!c && c.type === 'modified' && !c.submodule && !!this.status.head;
  }

  /**
   * Stores which changed lines of `filePath` are left out of the commit.
   * An empty set means the whole file; all keys excluded means nothing.
   * @param {string} filePath
   * @param {string} signature diff signature the keys belong to
   * @param {string[]} excluded
   * @param {number} total number of changed lines
   */
  setLineSelection(filePath, signature, excluded, total) {
    if (!excluded.length) {
      this.lineSelections.delete(filePath);
      this.excludedTracked.delete(filePath);
    } else if (excluded.length >= total) {
      this.lineSelections.delete(filePath);
      this.excludedTracked.add(filePath);
    } else {
      this.lineSelections.set(filePath, { signature, excluded: new Set(excluded), total });
      this.excludedTracked.delete(filePath);
    }
    this.fire('status');
  }

  /**
   * Content to commit for every included file with a line selection.
   * Throws when a file changed since its lines were selected.
   */
  selectedContents() {
    return selectedLineContents(this.repo, this.includedChanges(), this.lineSelections);
  }

  // ------------------------------------------------------------- operations

  /**
   * Runs a git operation with progress and error reporting.
   * @param {string} label
   * @param {() => Promise<any>} action
   * @param {{success?: string, refresh?: boolean}} [o]
   * @returns {Promise<boolean>}
   */
  async run(label, action, o = {}) {
    this.busy = label;
    this.fire('busy');
    this.log(`${label}…`);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: label },
        () => action(),
      );
      if (o.success) vscode.window.setStatusBarMessage(`$(check) ${o.success}`, 4000);
      return true;
    } catch (e) {
      // A rule the action broke, found once it ran (not a failure of git).
      if (e instanceof ShelfRejected || e instanceof PatchRejected) {
        this.log(`${label}: ${e.message}`, 'info');
        vscode.window.showWarningMessage(e.message);
        return false;
      }
      const details = e instanceof GitError ? e.message : String(e && e.message ? e.message : e);
      this.log(`${label} failed: ${details}`, 'error');
      // Signing failed (no agent, wrong key, pinentry cancelled): git's error and the settings, never unsigned.
      if (e instanceof GitError && SIGNING_COMMANDS.has(subcommand(e.args) || '') && isSigningFailure(details)) {
        require('./signing').showSigningFailure(this, label, details);
        return false;
      }
      // Git LFS (pre-push hook, smudge…): its lines first, the whole stderr on demand.
      if (this.lfsAvailable && isLfsError(details)) {
        const lines = lfsErrorLines(details);
        vscode.window.showErrorMessage(`${label} failed (Git LFS): ${lines.slice(0, 3).join(' ')}`, 'Show Details', 'Show Console')
          .then((r) => {
            if (r === 'Show Details') vscode.window.showErrorMessage(`${label} failed`, { modal: true, detail: details.slice(0, 6000) });
            else if (r) this.output.show(true);
          });
        return false;
      }
      vscode.window.showErrorMessage(`${label} failed: ${details.split('\n').slice(0, 6).join(' ')}`, 'Show Console')
        .then((r) => { if (r) this.output.show(true); });
      return false;
    } finally {
      this.busy = null;
      this.fire('busy');
      if (o.refresh !== false) await this.refreshAll();
    }
  }

  async commit({ push = false } = {}) {
    const changes = this.includedChanges();
    let prepared;
    try {
      prepared = await this.commitChanges.prepare(/** @type {any} */ ({
        status: this.status,
        message: this.message.trim(),
        changes,
        lineSelections: this.lineSelections,
        amend: this.amend,
        signOff: this.signOff,
        sign: this.sign,
      }));
    } catch (e) {
      if (e instanceof CommitRejected) {
        vscode.window.showWarningMessage(e.message);
        return false;
      }
      const r = await vscode.window.showWarningMessage(e.message, 'Select Lines…');
      if (r && e.path) vscode.commands.executeCommand('gitTools.selectLines', { model: this, path: e.path });
      return false;
    }
    const partial = prepared.partial;
    const active = this.changelists.active;
    /** Lists the committed files were in (one may be left empty). */
    const lists = new Set(changes.map((c) => this.changelists.listOf(c.path)).filter((id) => id !== null));
    const ok = await this.run(this.amend ? 'Amend commit' : 'Commit', () => this.commitChanges.run(prepared), {
      success: this.amend ? 'Commit amended'
        : `${changes.length} file(s) committed${partial.length ? ` (${partial.length} partially)` : ''}`,
    });
    if (ok) {
      this.message = '';
      this._prefilled = null;
      this.amend = false;
      this.includedUntracked.clear();
      this.lineSelections.clear();
      this.applyActiveTicks();
      this.fire('message');
      this.fire('status');
      // The message was the draft of the active list: used now.
      await this.changelists.saveComment(active, '').catch((e) => this.log(`changelists: ${e.message}`, 'error'));
      this.offerDeleteEmptyLists(/** @type {Set<string>} */ (lists));
      if (push) await vscode.commands.executeCommand('gitTools.push');
    }
    return ok;
  }

  defaultRemote() {
    const up = this.status.upstream;
    if (up && up.includes('/')) return up.slice(0, up.indexOf('/'));
    if (!this.remotes.length) return null;
    return this.remotes.some((r) => r.name === 'origin') ? 'origin' : this.remotes[0].name;
  }
}

/** Map key for a repository root (case-insensitive on Windows). */
const keyOf = (root) => (process.platform === 'win32' ? root.toLowerCase() : root);

/**
 * Tracks the repositories of the workspace and which one is active.
 */
class RepoManager {
  /**
   * @param {vscode.OutputChannel} output
   * @param {GitService} git
   * @param {vscode.Memento} [state] workspace state for opened / closed repositories
   */
  constructor(output, git, state) {
    this.output = output;
    this.git = git;
    this.state = state;
    /** @type {Map<string, RepoModel>} keyed by keyOf(root) */
    this.models = new Map();
    /** @type {RepoModel|null} */
    this.current = null;
    this._onDidChangeCurrent = new vscode.EventEmitter();
    this.onDidChangeCurrent = this._onDidChangeCurrent.event;
    /** Forwards change events of the current model. */
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    /** Fires when any repository changes or the list changes. */
    this._onDidChangeRepositories = new vscode.EventEmitter();
    this.onDidChangeRepositories = this._onDidChangeRepositories.event;
    this._sub = null;
    this._discovering = null;
  }

  /** Repositories sorted by name. */
  list() {
    return [...this.models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  }

  get(root) {
    return this.models.get(keyOf(root)) || null;
  }

  _stored(name) {
    return this.state ? this.state.get(name, []) : [];
  }

  async _store(name, list) {
    if (this.state) await this.state.update(name, [...new Set(list)]);
  }

  /** Finds repositories in the workspace folders and their sub folders. */
  async discover() {
    if (this._discovering) return this._discovering;
    this._discovering = this._discover().finally(() => { this._discovering = null; });
    return this._discovering;
  }

  async _discover() {
    const cfg = vscode.workspace.getConfiguration('gitTools');
    const depth = Math.max(0, Number(cfg.get('repositoryScanMaxDepth', 1)));
    const candidates = [];
    for (const f of vscode.workspace.workspaceFolders || []) {
      candidates.push(f.uri.fsPath, ...this.git.scan(f.uri.fsPath, depth));
    }
    candidates.push(...this._stored('gitTools.openedRepos'));

    const closed = new Set(this._stored('gitTools.closedRepos').map(keyOf));
    const roots = new Map();
    for (const dir of candidates) {
      const root = await this.git.findRoot(dir);
      if (root && !closed.has(keyOf(root))) roots.set(keyOf(root), root);
    }
    // Submodules (also those declared in .gitmodules but not registered in
    // the parent) and nested repositories that the parent does not track
    // are listed as repositories of their own, at any depth.
    if (cfg.get('detectSubmodules', true)) {
      const queue = [...roots.values()];
      const seen = new Set(queue.map(keyOf));
      while (queue.length) {
        const root = queue.shift();
        const parent = this.git.open(root);
        const subs = (await parent.submodules().catch(() => []))
          .filter((sm) => sm.status !== 'uninitialized').map((sm) => sm.path);
        const nested = await parent.nestedRepositories().catch(() => []);
        for (const rel of [...subs, ...nested]) {
          const dir = path.normalize(path.join(root, rel));
          if (seen.has(keyOf(dir)) || closed.has(keyOf(dir)) || !this.git.isRepository(dir)) continue;
          seen.add(keyOf(dir));
          roots.set(keyOf(dir), dir);
          queue.push(dir); // submodules of submodules
        }
      }
    }

    for (const [key, root] of roots) {
      if (!this.models.has(key)) this._add(root);
    }
    for (const [key, m] of this.models) {
      if (!roots.has(key)) this._remove(m);
    }
    if (!this.current || !this.models.has(keyOf(this.current.root))) {
      await this.setCurrent(this.list()[0] || null);
    }
    this._onDidChangeRepositories.fire(undefined);
  }

  _add(root) {
    const m = new RepoModel(root, this.output, this.git);
    this.models.set(keyOf(root), m);
    m.disposables.push(m.onDidChange((w) => {
      if (w === 'status' || w === 'busy' || w === 'refs') this._onDidChangeRepositories.fire(undefined);
    }));
    m.startLight();
    return m;
  }

  _remove(m) {
    this.models.delete(keyOf(m.root));
    m.dispose();
  }

  /** @param {RepoModel|null} m */
  async setCurrent(m) {
    if (this.current === m) return;
    if (this._sub) this._sub.dispose();
    this.current = m;
    this._sub = m ? m.onDidChange((w) => this._onDidChange.fire(w)) : null;
    this._onDidChangeRepositories.fire(undefined);
    if (m && !m._started) {
      m._started = true;
      await m.start();
    }
    this._onDidChangeCurrent.fire(m);
  }

  /** Adds a repository by folder path (e.g. opened through the picker). */
  async open(dir, select = true) {
    const root = await this.git.findRoot(dir);
    if (!root) return null;
    await this._store('gitTools.closedRepos', this._stored('gitTools.closedRepos').filter((r) => keyOf(r) !== keyOf(root)));
    const inWorkspace = (vscode.workspace.workspaceFolders || []).some((f) => keyOf(f.uri.fsPath) === keyOf(root));
    if (!inWorkspace) await this._store('gitTools.openedRepos', [...this._stored('gitTools.openedRepos'), root]);
    const m = this.get(root) || this._add(root);
    if (select) await this.setCurrent(m);
    this._onDidChangeRepositories.fire(undefined);
    return m;
  }

  /** Hides a repository from the list (remembered for this workspace). */
  async close(m) {
    await this._store('gitTools.openedRepos', this._stored('gitTools.openedRepos').filter((r) => keyOf(r) !== keyOf(m.root)));
    await this._store('gitTools.closedRepos', [...this._stored('gitTools.closedRepos'), m.root]);
    const wasCurrent = this.current === m;
    this._remove(m);
    if (wasCurrent) {
      this.current = null;
      await this.setCurrent(this.list()[0] || null);
    }
    this._onDidChangeRepositories.fire(undefined);
  }

  /** Re-shows repositories closed earlier. */
  async reopenClosed() {
    await this._store('gitTools.closedRepos', []);
    await this.discover();
  }

  dispose() {
    for (const m of this.models.values()) m.dispose();
    if (this._sub) this._sub.dispose();
    this._onDidChange.dispose();
    this._onDidChangeCurrent.dispose();
    this._onDidChangeRepositories.dispose();
  }
}

module.exports = { RepoModel, RepoManager };
