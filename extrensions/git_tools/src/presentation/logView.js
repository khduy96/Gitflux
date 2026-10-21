// @ts-check
'use strict';

const vscode = require('vscode');
const { webviewHtml } = require('./webview');
const { openCommitDiff, openCompareWithLocal } = require('./diff');
const cmd = require('./commands');
const { REBASE_ACTIONS, rebaseAction } = require('./rebaseView');
const { createPatchFromCommits } = require('./patches');
const { isDay } = require('../domain/logic/history');

/** Log filter fields the webview may change. */
const FILTER_KEYS = ['branch', 'path', 'user', 'date', 'search'];
/** Authors offered in the "User" dropdown. */
const MAX_AUTHORS = 100;

/**
 * Webview view "Log" in the panel: commit graph, filters and details.
 */
class LogViewProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./model').RepoManager} manager
   */
  constructor(context, manager) {
    this.context = context;
    this.manager = manager;
    /** @type {vscode.WebviewView|null} */
    this.view = null;
    /** Last "history can be rewritten" state sent to the webview. */
    this._canRebase = false;
    /** The webview script is running (it posted 'ready'). */
    this._ready = false;
    /** Commit to show once the log is loaded (Reflog ▸ Show in Log). @type {string|null} */
    this._pending = null;
    /** Commit shown in the details without being in the loaded log. @type {import('../domain/entities').Commit|null} */
    this._extra = null;
    manager.onDidChange((what) => {
      if (what === 'log' || what === 'refs') this.postLog();
      else if (what === 'status') this.postRepoState();
    });
    manager.onDidChangeCurrent(() => this.postLog());
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, {
      title: 'Log',
      styles: ['log.css'],
      scripts: ['common.js', 'log.js'],
    });
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => { if (view.visible) this.postLog(); });
    view.onDidDispose(() => {
      this.view = null;
      this._ready = false;
    });
  }

  postLog() {
    if (!this.view) return;
    const m = this.manager.current;
    this._canRebase = !!m && LogViewProvider.canRebase(m);
    this.view.webview.postMessage({
      type: 'log',
      data: m ? {
        repo: m.name,
        commits: m.commits,
        graph: m.graph,
        head: m.status.head,
        loading: m.logLoading,
        filter: m.logFilter,
        authors: m.authors.slice(0, MAX_AUTHORS).map((a) => ({ name: a.name, count: a.count, emails: a.emails.slice(0, 3) })),
        branches: m.branches.map((b) => ({ name: b.name, remote: b.remote })),
        canRebase: LogViewProvider.canRebase(m),
      } : { repo: null, commits: [], graph: [], head: null, loading: false, filter: {}, authors: [], branches: [], canRebase: false },
    });
    if (this._pending && this._ready && m && !m.logLoading) {
      const hash = this._pending;
      this._pending = null;
      this.showCommit(hash);
    }
  }

  /** History can be rewritten: on a branch, no operation in progress. */
  static canRebase(m) {
    return m.status.state === 'normal' && !!m.status.branch;
  }

  /** Enables / disables the history rewriting menu items without resending the log. */
  postRepoState() {
    const m = this.manager.current;
    const canRebase = !!m && LogViewProvider.canRebase(m);
    if (!this.view || canRebase === this._canRebase) return;
    this._canRebase = canRebase;
    this.view.webview.postMessage({ type: 'repoState', canRebase });
  }

  /** Selects a commit in the log (e.g. from another view). */
  reveal(hash) {
    if (this.view) this.view.webview.postMessage({ type: 'select', hash });
  }

  /**
   * Opens the Log on a commit: selected when loaded, otherwise (e.g. a
   * commit only the reflog still reaches) its details are shown on their own.
   * @param {string} hash
   */
  async showCommit(hash) {
    const m = this.manager.current;
    if (!m) return;
    if (!this.view || !this._ready || m.logLoading) {
      // Applied by postLog() once the webview is ready and the log loaded.
      this._pending = hash;
      await vscode.commands.executeCommand('gitTools.log.focus');
      return;
    }
    await vscode.commands.executeCommand('gitTools.log.focus');
    if (m.commits.some((c) => c.hash === hash)) return this.reveal(hash);
    const c = await m.repo.commitInfo(hash);
    if (!c) return vscode.window.showWarningMessage(`Commit ${hash.slice(0, 8)} no longer exists.`);
    this._extra = c;
    this.view?.webview.postMessage({ type: 'showCommit', commit: c });
  }

  /** "User ▸ Select…": any part of an author name or email. */
  async pickUser(m) {
    const cur = m.logFilter.user && m.logFilter.user.kind === 'text' ? m.logFilter.user.text : '';
    const text = await vscode.window.showInputBox({
      title: 'Filter Log by User',
      prompt: 'Part of the author name or email (case-insensitive)',
      value: cur,
    });
    if (text === undefined) return this.postLog();
    m.setLogFilter({ user: text.trim() ? { kind: 'text', text: text.trim() } : null });
  }

  /** "Date ▸ Select…": from / to days, either optional. */
  async pickDate(m) {
    const cur = m.logFilter.date && !('preset' in m.logFilter.date) ? m.logFilter.date : {};
    const validateInput = (v) => (!v.trim() || isDay(v.trim()) ? null : 'Use YYYY-MM-DD, or leave empty');
    const from = await vscode.window.showInputBox({
      title: 'Filter Log by Date (1/2)', prompt: 'From day, YYYY-MM-DD (empty: no lower bound)', value: cur.from || '', validateInput,
    });
    if (from === undefined) return this.postLog();
    const to = await vscode.window.showInputBox({
      title: 'Filter Log by Date (2/2)', prompt: 'To day, YYYY-MM-DD, included (empty: no upper bound)', value: cur.to || '',
      validateInput: (v) => validateInput(v) || (from.trim() && v.trim() && v.trim() < from.trim() ? 'Must not be before the from day' : null),
    });
    if (to === undefined) return this.postLog();
    const date = { ...(from.trim() ? { from: from.trim() } : {}), ...(to.trim() ? { to: to.trim() } : {}) };
    m.setLogFilter({ date: date.from || date.to ? date : null });
  }

  async onMessage(msg) {
    const m = this.manager.current;
    if (msg.type === 'ready') {
      this._ready = true;
      return this.postLog();
    }
    if (!m) return;
    const find = (h) => m.commits.find((c) => c.hash === h) || (this._extra && this._extra.hash === h ? this._extra : undefined);
    switch (msg.type) {
      case 'filter': {
        /** @type {any} */
        const f = {};
        for (const k of FILTER_KEYS) if (k in msg.filter) f[k] = msg.filter[k];
        m.setLogFilter(f);
        return;
      }
      case 'pickUser':
        return this.pickUser(m);
      case 'pickDate':
        return this.pickDate(m);
      case 'details': {
        const c = find(msg.hash);
        if (!c) return;
        const parent = c.parents[0] || null;
        const [body, files] = await Promise.all([m.repo.commitBody(c.hash), m.repo.changedFiles(parent, c.hash)]);
        const details = { ...c, body, files, containedIn: null };
        this._details = details;
        this.view?.webview.postMessage({ type: 'details', details });
        const containedIn = await m.repo.branchesContaining(c.hash);
        this.view?.webview.postMessage({ type: 'details', details: { ...details, containedIn } });
        return;
      }
      case 'openDiff':
      case 'fileAction': {
        const c = find(msg.hash);
        const d = this._details;
        if (!c || !d || d.hash !== c.hash) return;
        const f = d.files.find((x) => x.path === msg.path);
        if (!f) return;
        const action = msg.type === 'openDiff' ? 'diff' : msg.action;
        switch (action) {
          case 'diff':
            return openCommitDiff(m, f, c.hash, c.parents[0] || null, msg.preview !== false);
          case 'local':
            return openCompareWithLocal(m, f.path, c.hash);
          case 'history':
            return m.setLogFilter({ path: f.path, branch: null });
          case 'get':
            return m.run(`Get ${f.path} from ${c.hash.slice(0, 8)}`,
              () => m.repo.checkoutFile(c.hash, f.path),
              { success: `${f.path} restored` });
          case 'copy':
            await vscode.env.clipboard.writeText(f.path);
            return vscode.window.setStatusBarMessage('Path copied', 3000);
        }
        return;
      }
      case 'commitAction': {
        const commits = msg.hashes.map(find).filter(Boolean);
        if (!commits.length) return;
        if (msg.action === 'createPatch') return createPatchFromCommits(m, commits);
        // Edit Commit Message of HEAD keeps the fast amend path.
        if (REBASE_ACTIONS.has(msg.action) && !(msg.action === 'reword' && commits[0].hash === m.status.head)) {
          return rebaseAction(this.context, m, msg.action, commits);
        }
        await cmd.commitAction(m, msg.action, commits);
        return;
      }
    }
  }
}

module.exports = { LogViewProvider };
