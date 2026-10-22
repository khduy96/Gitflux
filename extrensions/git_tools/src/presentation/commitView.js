// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { webviewHtml } = require('./webview');
const { openLocalDiff, openStagedDiff, openUnstagedDiff } = require('./diff');
const cmd = require('./commands');
const { shelveChanges } = require('./shelf');
const { createPatch } = require('./patches');
const { cleanWorkingTree } = require('./clean');
const { bisectBanner } = require('./bisect');
const { describeSubmodule } = require('../domain/entities');
const changelistUi = require('./changelists');
const { FORMAT_LABEL } = require('./signing');

/**
 * Tooltip of the "Sign commit" option.
 * @param {import('../domain/entities').SigningConfig|null} signing null until read
 */
function signTitle(signing) {
  if (!signing) return 'Sign the commit (git commit -S)';
  const format = FORMAT_LABEL[signing.format] || 'OpenPGP';
  if (signing.signingKey) return `Sign with the ${format} key ${signing.signingKey.startsWith('key::') ? `${signing.signingKey.slice(5, 40)}…` : signing.signingKey}`;
  if (signing.format === 'openpgp') return 'Sign with the OpenPGP key of the committer email';
  return 'No signing key configured: see Signing Settings…';
}

/** Whether the file is opened with the LFS diff (pointer and content). @param {import('./model').RepoModel} m */
const lfsFile = (m, c) => m.lfsAvailable && m.lfsPaths.has(c.path);

/** Lazily loaded: the LFS views. */
const lfsUi = () => require('./lfs');

/**
 * Webview view "Commit": changes with checkboxes and the commit message.
 */
class CommitViewProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./model').RepoManager} manager
   * @param {import('./aiCommands').AiController} ai
   */
  constructor(context, manager, ai) {
    this.context = context;
    this.manager = manager;
    this.ai = ai;
    /** @type {vscode.WebviewView|null} */
    this.view = null;
    manager.onDidChange((what) => {
      if (what === 'message') this.postMessageText(true);
      else if (what !== 'log') this.postState();
    });
    manager.onDidChangeCurrent(() => this.postState());
    ai.onDidChange(() => this.postState());
    /** @type {'none'|'directory'} */
    this.groupBy = context.globalState.get('gitTools.commit.groupBy', 'none');
    vscode.commands.executeCommand('setContext', 'gitTools.commitGroupBy', this.groupBy);
    /** Non-active changelists without files are listed too. */
    this.showEmptyChangelists = !!context.globalState.get('gitTools.commit.showEmptyChangelists', false);
    vscode.commands.executeCommand('setContext', 'gitTools.showEmptyChangelists', this.showEmptyChangelists);
    // Groups start open: the Expand / Collapse All button first collapses.
    vscode.commands.executeCommand('setContext', 'gitTools.commitExpanded', true);
  }

  /** @param {boolean} value */
  setShowEmptyChangelists(value) {
    this.showEmptyChangelists = value;
    this.context.globalState.update('gitTools.commit.showEmptyChangelists', value);
    vscode.commands.executeCommand('setContext', 'gitTools.showEmptyChangelists', value);
    this.postState();
  }

  /** Expand All / Collapse All: one view-title button, its icon from the context key. */
  setAllExpanded(expanded) {
    vscode.commands.executeCommand('setContext', 'gitTools.commitExpanded', expanded);
    if (this.view) this.view.webview.postMessage({ type: 'expandAll', expanded });
  }

  /** @param {'none'|'directory'} value */
  setGroupBy(value) {
    this.groupBy = value;
    this.context.globalState.update('gitTools.commit.groupBy', value);
    vscode.commands.executeCommand('setContext', 'gitTools.commitGroupBy', value);
    this.postState();
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, {
      title: 'Commit',
      styles: ['commit.css'],
      scripts: ['common.js', 'commit.js'],
    });
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => { if (view.visible) this.postState(); });
    view.onDidDispose(() => { this.view = null; });
  }

  focusMessage() {
    if (this.view) {
      this.view.show(false);
      this.view.webview.postMessage({ type: 'focusMessage' });
    }
  }

  postState() {
    if (!this.view) return;
    const m = this.manager.current;
    this.view.description = m && this.manager.models.size > 1 ? m.name : undefined;
    const cl = m ? m.changelists.data : null;
    this.view.webview.postMessage({
      type: 'state',
      state: m && cl ? {
        repo: m.name,
        multiRepo: this.manager.models.size > 1,
        groupBy: this.groupBy,
        showEmptyChangelists: this.showEmptyChangelists,
        changelists: cl.lists.map((l) => ({ id: l.id, name: l.name, active: l.id === cl.active, isDefault: l.id === 'default' })),
        repoState: m.status.state,
        rebase: m.rebaseProgress,
        bisect: bisectBanner(m),
        hasCommits: !!m.status.head,
        changes: m.status.changes.map((c) => {
          const sel = m.lineSelections.get(c.path);
          const lock = m.lfsLocks ? m.lfsLocks.get(c.path) : null;
          return {
            ...c,
            included: c.type !== 'conflicted' && m.isIncluded(c),
            canLines: m.canSelectLines(c) && m.status.state === 'normal',
            submoduleInfo: c.submodule ? describeSubmodule(c.submodule) : null,
            lines: sel ? { selected: sel.total - sel.excluded.size, total: sel.total } : null,
            // Changelist of a tracked change (the active one until the lists are read).
            list: c.type === 'untracked' ? null : m.changelists.listOf(c.path) || cl.active,
            lfs: m.lfsPaths.has(c.path),
            lock: lock ? { owner: lock.owner, mine: lock.mine } : null,
          };
        }),
        message: m.message,
        amend: m.amend,
        signOff: m.signOff,
        sign: m.sign ?? (m.signing ? !!m.signing.commitSign : false),
        signTitle: signTitle(m.signing),
        lfs: { available: m.lfsAvailable, locks: !!m.lfsLocks },
        busy: m.busy,
        generating: this.ai.generating,
        aiReady: this.ai.isConfigured(),
        aiModel: this.ai.model(),
      } : { repo: null, groupBy: this.groupBy, repoState: 'normal', changes: [], changelists: [], message: '' },
    });
  }

  postMessageText(force) {
    const m = this.manager.current;
    if (this.view && m) this.view.webview.postMessage({ type: 'message', text: m.message, force });
  }

  async onMessage(msg) {
    const m = this.manager.current;
    if (msg.type === 'ready') return this.postState();
    if (!m) return;
    const byPath = new Map(m.status.changes.map((c) => [c.path, c]));
    const changes = (msg.paths || []).map((p) => byPath.get(p)).filter(Boolean);
    switch (msg.type) {
      case 'toggle':
        return m.setIncluded(msg.paths, msg.value);
      case 'open': {
        const c = byPath.get(msg.path);
        if (c) await this.openDiff(m, c, msg.preview);
        return;
      }
      case 'message':
        return m.setMessage(msg.text);
      case 'option':
        // Commit options: Sign-off and Sign commit.
        if (msg.name === 'signOff') m.signOff = !!msg.value;
        else if (msg.name === 'sign') m.sign = !!msg.value;
        return this.postState();
      case 'moveToList':
        // Files dragged from one changelist to another.
        return m.moveToChangelist(changes.map((c) => c.path), msg.list);
      case 'listMenu':
        return this.listAction(m, msg.action, msg.list, changes);
      case 'amend':
        m.amend = msg.value;
        if (m.amend && !m.message.trim() && m.status.head) {
          m.message = await m.repo.lastCommitMessage();
          this.postMessageText(true);
        }
        return this.postState();
      case 'commit':
        return m.commit({ push: msg.push });
      case 'generate':
        return this.ai.generate();
      case 'cancelGenerate':
        return this.ai.cancel();
      case 'resolve':
        return vscode.commands.executeCommand('gitTools.resolveConflicts');
      case 'continue':
        return vscode.commands.executeCommand('gitTools.continueOperation');
      case 'abort':
        return vscode.commands.executeCommand('gitTools.abortOperation');
      case 'skip':
        return vscode.commands.executeCommand('gitTools.skipRebaseCommit');
      case 'bisect':
        // Banner buttons: good / bad / skip / reset / run / showFirstBad.
        return vscode.commands.executeCommand(`gitTools.bisect.${msg.action}`);
      case 'menu':
        return this.menuAction(m, msg.action, changes);
      case 'addToVcs':
        // Dropped on a changelist group: added to Git in that list.
        if (msg.list && m.changelists.list(msg.list)) return m.addToChangelist(changes, msg.list);
        return cmd.addToVcs(m, changes);
      case 'unversion':
        return cmd.unversion(m, changes);
    }
  }

  /** Diff of a working tree change; LFS files show their pointers too. @param {import('./model').RepoModel} m */
  openDiff(m, c, preview) {
    return lfsFile(m, c) ? lfsUi().openLfsDiff(m, c, preview) : openLocalDiff(m, c, preview);
  }

  /**
   * Context menu of a changelist group.
   * @param {import('./model').RepoModel} m
   * @param {string} action
   * @param {string} id the changelist
   * @param {import('../domain/entities').FileChange[]} changes its files
   */
  async listAction(m, action, id, changes) {
    const list = m.changelists.list(id);
    if (!list) return;
    switch (action) {
      case 'setActive':
        return m.setActiveChangelist(id);
      case 'new':
        return changelistUi.newChangelist(m);
      case 'edit':
        return changelistUi.editChangelist(m, id);
      case 'delete':
        return changelistUi.deleteChangelist(m, id);
      case 'shelve':
        return shelveChanges(m, changes, { name: list.name });
      default:
        return this.menuAction(m, action, changes);
    }
  }

  /** @param {import('./model').RepoModel} m */
  async menuAction(m, action, changes) {
    const first = changes[0];
    switch (action) {
      case 'diff':
        for (const c of changes.slice(0, 10)) if (c.type !== 'conflicted') await this.openDiff(m, c, false);
        return;
      case 'moveToList':
        return changelistUi.moveToChangelist(m, changes);
      case 'lfsTrack':
        return lfsUi().trackWithLfs(m, changes);
      case 'lfsUntrack':
        return lfsUi().untrackFromLfs(m, changes);
      case 'lfsLock':
        return lfsUi().lockFiles(m, changes);
      case 'lfsUnlock':
        return lfsUi().unlockFiles(m, changes);
      case 'stagedDiff':
        return openStagedDiff(m, first);
      case 'unstagedDiff':
        return openUnstagedDiff(m, first);
      case 'annotate':
        return vscode.commands.executeCommand('gitTools.annotate', { model: m, path: first.path });
      case 'clean':
        return cleanWorkingTree(m);
      case 'openFile':
        return vscode.window.showTextDocument(vscode.Uri.file(path.join(m.root, first.path)));
      case 'resolve':
        return vscode.commands.executeCommand('gitTools.resolveConflicts');
      case 'include':
      case 'exclude':
        return m.setIncluded(changes.map((c) => c.path), action === 'include');
      case 'rollback':
        return cmd.rollback(m, changes);
      case 'shelve':
        return shelveChanges(m, changes);
      case 'createPatch':
      case 'copyPatch':
        return createPatch(m, changes, action === 'copyPatch');
      case 'delete':
        return cmd.deleteUntracked(m, changes);
      case 'ignore':
        return cmd.addToGitignore(m, changes);
      case 'addToVcs':
        return cmd.addToVcs(m, changes);
      case 'selectLines':
        return vscode.commands.executeCommand('gitTools.selectLines', { model: m, path: first.path });
      case 'openSubmodule': {
        const opened = await this.manager.open(path.join(m.root, first.path));
        if (!opened) vscode.window.showWarningMessage(`${first.path} is not initialized.`);
        return;
      }
      case 'registerNested':
        return vscode.commands.executeCommand('gitTools.nestedRepo.register', { model: m }, first.path);
      case 'updateSubmodule':
        return m.updateSubmodules(changes.filter((c) => c.submodule).map((c) => c.path));
      case 'history':
        m.setLogFilter({ path: first.path, branch: null });
        return vscode.commands.executeCommand('gitTools.log.focus');
      case 'copy':
        await vscode.env.clipboard.writeText(changes.map((c) => c.path).join('\n'));
        return vscode.window.setStatusBarMessage('Path copied', 3000);
      case 'reveal':
        return vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(m.root, first.path)));
    }
  }
}

module.exports = { CommitViewProvider };
