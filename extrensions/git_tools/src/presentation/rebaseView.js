// @ts-check
'use strict';

const vscode = require('vscode');
const { webviewHtml } = require('./webview');
const { RebaseRejected } = require('../domain/errors');
const { ACTIONS } = require('../domain/logic/rebaseTodo');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/usecases/interactiveRebase').RebasePlan} RebasePlan */
/** @typedef {import('../domain/logic/rebaseTodo').TodoItem} TodoItem */

/** Log actions that rewrite history through the interactive rebase engine. */
const REBASE_ACTIONS = new Set(['interactiveRebase', 'reword', 'squash', 'fixup', 'moveUp', 'moveDown', 'drop']);

/** @type {Map<string, RebasePanel>} open Interactive Rebase panels by repository root */
const panels = new Map();

const short = (h) => (h ? h.slice(0, 8) : '');

const panelOptions = (context) => ({
  enableScripts: true,
  retainContextWhenHidden: true,
  localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
});

/**
 * Runs the pre-checks and the todo preview with the repository marked busy
 * (git writes in .git meanwhile, which would trigger refreshes). A rejection
 * is shown as a warning; resolves undefined when nothing can be done.
 * @template T
 * @param {RepoModel} m
 * @param {() => Promise<T>} prepare
 * @returns {Promise<T|undefined>}
 */
async function prepareRebase(m, prepare) {
  m.busy = 'Preparing rebase';
  m.fire('busy');
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Preparing rebase' }, prepare);
  } catch (e) {
    if (e instanceof RebaseRejected) {
      vscode.window.showWarningMessage(e.message);
    } else {
      m.log(`Prepare rebase failed: ${e.message}`, 'error');
      vscode.window.showErrorMessage(`Interactive rebase failed: ${String(e.message).split('\n').slice(0, 6).join(' ')}`, 'Show Console')
        .then((r) => { if (r) m.output.show(true); });
    }
    return undefined;
  } finally {
    m.busy = null;
    m.fire('busy');
    await m.refreshStatus();
  }
}

/**
 * Asks to go on when commits to rewrite are already on the upstream branch.
 * @param {RebasePlan} plan
 */
async function confirmPushed(plan) {
  if (!plan.pushed) return true;
  const ok = await vscode.window.showWarningMessage(
    `${plan.pushed} of the commits to rewrite ${plan.pushed === 1 ? 'is' : 'are'} already pushed to ${plan.upstream}.`,
    { modal: true, detail: 'Rewriting them changes their hashes: you will need to force push afterwards (Push… ▸ Force Push).' },
    'Rewrite Anyway');
  return ok === 'Rewrite Anyway';
}

/**
 * Runs the edited todo and explains a stop (conflict, edit, failing hook).
 * @param {RepoModel} m
 * @param {string} label
 * @param {RebasePlan} plan
 * @param {TodoItem[]} items
 * @param {string} success
 */
async function runRebase(m, label, plan, items, success) {
  /** @type {{stopped: boolean, output: string}|undefined} */
  let result;
  const ok = await m.run(label, async () => { result = await m.interactiveRebase.run(plan, items); });
  if (!ok || !result) return;
  if (!result.stopped) {
    vscode.window.setStatusBarMessage(`$(check) ${success}`, 4000);
    return;
  }
  const conflicts = m.status.changes.some((c) => c.type === 'conflicted');
  const p = m.rebaseProgress;
  const lines = result.output.split('\n').map((l) => l.trim()).filter((l) => l && !/^(hint:|Rebasing \(|Executing:)/.test(l));
  const text = conflicts ? 'Rebase stopped on a conflict: resolve it, then Continue (Commit view).'
    : p && p.stoppedForEdit ? `Rebase stopped at ${p.stoppedSha} for editing: amend the commit, then Continue (Commit view).`
      : `Rebase stopped: ${lines.slice(0, 3).join(' ') || 'see the Git console'}. Fix it, then Continue or Abort (Commit view).`;
  const pick = await vscode.window.showWarningMessage(text, ...(conflicts ? ['Resolve…'] : []), 'Show Console');
  if (pick === 'Resolve…') vscode.commands.executeCommand('gitTools.resolveConflicts');
  else if (pick === 'Show Console') m.output.show(true);
}

/**
 * Multi-line commit message editor (Edit Commit Message / Squash Commits).
 * Resolves with the message, or null when cancelled.
 * @param {vscode.ExtensionContext} context
 * @param {{title: string, detail: string, message: string, okLabel: string}} o
 * @returns {Promise<string|null>}
 */
function editMessage(context, o) {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('gitTools.rebaseMessage', o.title, vscode.ViewColumn.Active, panelOptions(context));
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      title: o.title,
      styles: ['rebase.css'],
      scripts: ['common.js', 'rebase.js'],
    });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
      panel.dispose();
    };
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ready') panel.webview.postMessage({ type: 'messageDialog', ...o });
      else if (msg.type === 'ok') finish(String(msg.text));
      else if (msg.type === 'cancel') finish(null);
    });
    panel.onDidDispose(() => finish(null));
  });
}

/**
 * Interactive Rebase panel: rows of git's todo, actions, order and messages.
 */
class RebasePanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {RepoModel} m
   * @param {RebasePlan} plan
   */
  constructor(context, m, plan) {
    this.context = context;
    this.m = m;
    this.plan = plan;
    this.stale = false;
    this.panel = vscode.window.createWebviewPanel('gitTools.rebase', `Interactive Rebase: ${plan.branch}`, vscode.ViewColumn.Active, panelOptions(context));
    this.panel.webview.html = webviewHtml(this.panel.webview, context.extensionUri, {
      title: 'Interactive Rebase',
      styles: ['rebase.css'],
      scripts: ['common.js', 'rebase.js'],
    });
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    const sub = m.onDidChange((what) => {
      if (what === 'status' || what === 'refs') this.checkStale();
    });
    this.panel.onDidDispose(() => {
      sub.dispose();
      if (panels.get(m.root) === this) panels.delete(m.root);
    });
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  /** The branch moved or an operation started since the todo was made. */
  checkStale() {
    const s = this.m.status;
    const stale = s.head !== this.plan.head || s.branch !== this.plan.branch || s.state !== 'normal';
    if (stale !== this.stale) {
      this.stale = stale;
      this.post({ type: 'stale', stale });
    }
  }

  init() {
    const p = this.plan;
    this.stale = false;
    this.post({
      type: 'init',
      plan: {
        branch: p.branch, base: p.base ? short(p.base) : null, rebaseMerges: p.rebaseMerges, pushed: p.pushed, upstream: p.upstream,
      },
      items: p.items,
      analysis: this.m.interactiveRebase.analyze(p.items),
    });
  }

  /**
   * Plan items in the order and with the actions / messages of the webview.
   * @param {{id: number, action?: string, newMessage?: string, groupMessage?: string}[]} edited
   * @returns {TodoItem[]}
   */
  itemsFrom(edited) {
    const byId = new Map(this.plan.items.map((it) => [it.id, it]));
    return edited.filter((e) => byId.has(e.id)).map((e) => {
      const it = /** @type {TodoItem} */ (byId.get(e.id));
      if (it.kind !== 'commit') return it;
      return {
        ...it,
        action: ACTIONS.includes(/** @type {any} */ (e.action)) ? /** @type {any} */ (e.action) : it.action,
        newMessage: typeof e.newMessage === 'string' ? e.newMessage : undefined,
        groupMessage: typeof e.groupMessage === 'string' ? e.groupMessage : undefined,
      };
    });
  }

  async onMessage(msg) {
    const uc = this.m.interactiveRebase;
    switch (msg.type) {
      case 'ready':
        return this.init();
      case 'validate':
        return this.post({ type: 'analysis', seq: msg.seq, analysis: uc.analyze(this.itemsFrom(msg.items)) });
      case 'reload': {
        const plan = await prepareRebase(this.m, () => uc.prepare(this.plan.target));
        if (!plan) return;
        this.plan = plan;
        return this.init();
      }
      case 'cancel':
        return this.panel.dispose();
      case 'start': {
        const items = this.itemsFrom(msg.items);
        const analysis = uc.analyze(items);
        if (analysis.errors.length) return this.post({ type: 'analysis', seq: msg.seq, analysis });
        if (analysis.warnings.length) {
          const ok = await vscode.window.showWarningMessage(analysis.warnings.join(' '), { modal: true }, 'Start Rebasing');
          if (!ok) return;
        }
        if (!(await confirmPushed(this.plan))) return;
        this.panel.dispose();
        const n = items.filter((it) => it.kind === 'commit').length;
        return runRebase(this.m, `Interactive rebase of ${this.plan.branch}`, this.plan, items, `Rebased ${n} commit${n === 1 ? '' : 's'}`);
      }
    }
  }
}

/**
 * Opens the Interactive Rebase panel (one per repository).
 * @param {vscode.ExtensionContext} context
 * @param {RepoModel} m
 * @param {RebasePlan} plan
 */
function openRebasePanel(context, m, plan) {
  const existing = panels.get(m.root);
  if (existing) existing.panel.dispose();
  panels.set(m.root, new RebasePanel(context, m, plan));
}

/**
 * Interactively Rebase from Here… for `hash`.
 * @param {vscode.ExtensionContext} context
 * @param {RepoModel} m
 * @param {string} hash
 */
async function interactiveRebase(context, m, hash) {
  const plan = await prepareRebase(m, () => m.interactiveRebase.prepare(hash));
  if (plan) openRebasePanel(context, m, plan);
}

/**
 * Handles a history rewriting action of the Log context menu.
 * @param {vscode.ExtensionContext} context
 * @param {RepoModel} m
 * @param {string} action one of REBASE_ACTIONS
 * @param {import('../domain/entities').Commit[]} commits selected commits, newest first
 */
async function rebaseAction(context, m, action, commits) {
  const uc = m.interactiveRebase;
  const c = commits[0];
  const hashes = commits.map((x) => x.hash);
  switch (action) {
    case 'interactiveRebase':
      return interactiveRebase(context, m, c.hash);
    case 'reword': {
      const p = await prepareRebase(m, () => uc.prepareReword(c.hash));
      if (!p || !(await confirmPushed(p.plan))) return;
      const item = /** @type {import('../domain/logic/rebaseTodo').CommitItem} */ (p.items[p.index]);
      const message = await editMessage(context, {
        title: `Edit Commit Message · ${short(c.hash)}`,
        detail: `Rewrites ${short(c.hash)} and the commits after it on ${p.plan.branch}. Commit hooks run.`,
        message: item.message || item.subject,
        okLabel: 'Reword',
      });
      if (message === null || message.trim() === (item.message || '').trim()) return;
      p.items[p.index] = { ...item, newMessage: message };
      return runRebase(m, 'Edit commit message', p.plan, p.items, 'Commit message updated');
    }
    case 'squash': {
      const p = await prepareRebase(m, () => uc.prepareSquash(hashes));
      if (!p || !(await confirmPushed(p.plan))) return;
      const group = uc.analyze(p.items).groups.find((g) => g.head === p.index);
      const message = await editMessage(context, {
        title: `Squash ${hashes.length} Commits`,
        detail: `${hashes.length} commits become one. Edit the message of the resulting commit.`,
        message: (group && group.message) || '',
        okLabel: 'Squash',
      });
      if (message === null) return;
      p.items[p.index] = { ...p.items[p.index], groupMessage: message };
      return runRebase(m, `Squash ${hashes.length} commits`, p.plan, p.items, `Squashed ${hashes.length} commits`);
    }
    case 'fixup': {
      const p = await prepareRebase(m, () => uc.prepareFixup(c.hash));
      if (!p || !(await confirmPushed(p.plan))) return;
      const into = /** @type {import('../domain/logic/rebaseTodo').CommitItem} */ (p.items[p.index]);
      return runRebase(m, `Fixup ${short(c.hash)}`, p.plan, p.items, `${short(c.hash)} melded into ${short(into.hash)}`);
    }
    case 'moveUp':
    case 'moveDown': {
      const dir = action === 'moveUp' ? 'up' : 'down';
      const p = await prepareRebase(m, () => uc.prepareMove(c.hash, dir));
      if (!p || !(await confirmPushed(p.plan))) return;
      return runRebase(m, `Move ${short(c.hash)} ${dir}`, p.plan, p.items, `Moved ${short(c.hash)} ${dir}`);
    }
    case 'drop': {
      const list = commits.slice(0, 10).map((x) => `${short(x.hash)} ${x.subject}`).join('\n');
      const ok = await vscode.window.showWarningMessage(
        commits.length === 1 ? `Drop commit ${short(c.hash)} "${c.subject}"?` : `Drop ${commits.length} commits?`,
        { modal: true, detail: `${commits.length > 1 ? `${list}${commits.length > 10 ? '\n…' : ''}\n\n` : ''}This rewrites the history of the current branch.` },
        'Drop');
      if (!ok) return;
      const p = await prepareRebase(m, () => uc.prepareDrop(hashes));
      if (!p || !(await confirmPushed(p.plan))) return;
      return runRebase(m, commits.length === 1 ? 'Drop commit' : `Drop ${commits.length} commits`, p.plan, p.items,
        commits.length === 1 ? `Dropped ${short(c.hash)}` : `Dropped ${commits.length} commits`);
    }
  }
}

/**
 * Command palette: pick the oldest commit to rewrite, then open the panel.
 * @param {vscode.ExtensionContext} context
 * @param {RepoModel} m
 */
async function pickAndRebase(context, m) {
  if (!m.status.branch) {
    vscode.window.showWarningMessage('HEAD is detached. Checkout a branch to rewrite its history.');
    return;
  }
  const commits = await m.repo.log({ revisions: ['HEAD'], limit: 300 });
  const pick = /** @type {any} */ (await vscode.window.showQuickPick(
    commits.map((x) => ({ label: `$(git-commit) ${x.subject}`, description: `${short(x.hash)} · ${x.author}`, hash: x.hash })),
    { title: `Interactive Rebase of ${m.status.branch}`, placeHolder: 'Oldest commit to rewrite', matchOnDescription: true }));
  if (pick) await interactiveRebase(context, m, pick.hash);
}

module.exports = { REBASE_ACTIONS, rebaseAction, interactiveRebase, pickAndRebase, editMessage };
