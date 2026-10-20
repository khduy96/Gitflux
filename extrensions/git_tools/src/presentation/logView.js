// @ts-check
'use strict';

const vscode = require('vscode');
const { webviewHtml } = require('./webview');
const { openCommitDiff, openCompareWithLocal } = require('./diff');
const cmd = require('./commands');
const { REBASE_ACTIONS, rebaseAction } = require('./rebaseView');

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
    view.onDidDispose(() => { this.view = null; });
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
        branches: m.branches.map((b) => ({ name: b.name, remote: b.remote })),
        canRebase: LogViewProvider.canRebase(m),
      } : { repo: null, commits: [], graph: [], head: null, loading: false, filter: {}, branches: [], canRebase: false },
    });
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

  async onMessage(msg) {
    const m = this.manager.current;
    if (msg.type === 'ready') return this.postLog();
    if (!m) return;
    const find = (h) => m.commits.find((c) => c.hash === h);
    switch (msg.type) {
      case 'filter':
        m.setLogFilter('path' in msg ? { path: msg.path } : { branch: msg.branch });
        return;
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
