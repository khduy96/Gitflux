// @ts-check
'use strict';

const vscode = require('vscode');
const { webviewHtml } = require('./webview');
const cmd = require('./commands');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').ReflogEntry} ReflogEntry */

/** Entries loaded ("load more" is not offered). */
const MAX_ENTRIES = 500;

/** Entry actions run by the Log commit actions (commands.commitAction). */
const COMMIT_ACTIONS = new Set(['checkout', 'branch', 'reset', 'copy']);

/** The open panel. @type {ReflogPanel|null} */
let current = null;

/**
 * Reflog panel: where HEAD (or the current branch) pointed, newest first.
 * The safety net after reset, rebase, drop or amend: a lost commit is
 * found here and recovered with New Branch Here. One panel, following the
 * current repository.
 */
class ReflogPanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./model').RepoManager} manager
   * @param {import('./logView').LogViewProvider} logView
   */
  static show(context, manager, logView) {
    if (current) {
      current.panel.reveal();
      current.load();
      return current;
    }
    current = new ReflogPanel(context, manager, logView);
    return current;
  }

  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./model').RepoManager} manager
   * @param {import('./logView').LogViewProvider} logView
   */
  constructor(context, manager, logView) {
    this.manager = manager;
    this.logView = logView;
    /** 'HEAD', or 'branch' for the reflog of the current branch. */
    this.ref = 'HEAD';
    /** @type {ReflogEntry[]} */
    this.entries = [];
    this._gen = 0;
    this.panel = vscode.window.createWebviewPanel('gitTools.reflog', 'Reflog', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = new vscode.ThemeIcon('history');
    this.panel.webview.html = webviewHtml(this.panel.webview, context.extensionUri, {
      title: 'Reflog',
      styles: ['reflog.css'],
      scripts: ['common.js', 'reflog.js'],
    });
    this.disposables = [
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      // Follows the repository's auto-refresh: every operation that writes
      // the reflog moves HEAD or a branch, which refreshes the refs.
      manager.onDidChange((what) => { if (what === 'refs') this.load(); }),
      manager.onDidChangeCurrent(() => this.load()),
    ];
    this.panel.onDidDispose(() => {
      for (const d of this.disposables) d.dispose();
      current = null;
    });
  }

  /** Ref whose reflog is shown. @param {RepoModel} m */
  refName(m) {
    return this.ref === 'branch' && m.status.branch ? `refs/heads/${m.status.branch}` : 'HEAD';
  }

  async load() {
    const m = this.manager.current;
    const gen = ++this._gen;
    if (!m) {
      this.entries = [];
      this.post({ repo: null, ref: 'HEAD', branch: null, entries: [], loading: false, error: null });
      return;
    }
    this.panel.title = `Reflog · ${m.name}`;
    this.post({ repo: m.name, ref: this.ref, branch: m.status.branch, entries: this.entries, loading: true, error: null });
    /** @type {ReflogEntry[]} */
    let entries = [];
    let error = null;
    try {
      entries = await m.repo.reflog(this.refName(m), MAX_ENTRIES);
    } catch (e) {
      error = String(e && e.message ? e.message : e).split('\n')[0];
      m.log(`reflog failed: ${error}`, 'error');
    }
    if (gen !== this._gen) return;
    this.entries = entries;
    this.post({ repo: m.name, ref: this.ref, branch: m.status.branch, head: m.status.head, entries, loading: false, error, max: MAX_ENTRIES });
  }

  post(data) {
    this.panel.webview.postMessage({ type: 'reflog', data });
  }

  async onMessage(msg) {
    if (msg.type === 'ready') return this.load();
    const m = this.manager.current;
    if (!m) return;
    switch (msg.type) {
      case 'setRef':
        this.ref = msg.ref === 'branch' ? 'branch' : 'HEAD';
        return this.load();
      case 'refresh':
        return this.load();
      case 'action': {
        // Selectors shift when HEAD moves: the hash identifies the entry clicked.
        const e = this.entries.find((x) => x.selector === msg.selector && x.hash === msg.hash)
          || this.entries.find((x) => x.hash === msg.hash && !x.missing);
        // A commit that no longer exists has nothing to check out or recover.
        if (!e || e.missing || !e.hash) return;
        if (msg.action === 'log') return this.logView.showCommit(e.hash);
        if (COMMIT_ACTIONS.has(msg.action)) return cmd.commitAction(m, msg.action, [/** @type {any} */ ({ hash: e.hash, parents: [] })]);
      }
    }
  }
}

module.exports = { ReflogPanel, MAX_ENTRIES };
