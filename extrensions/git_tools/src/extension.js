// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { createAi } = require('./data/aiClients');
const { GitCliService } = require('./data/gitService');
const { RepoManager } = require('./presentation/model');
const { RevisionContentProvider, SCHEME } = require('./presentation/diff');
const { CommitViewProvider } = require('./presentation/commitView');
const { LogViewProvider } = require('./presentation/logView');
const { BranchesTreeProvider, BranchStatusBar } = require('./presentation/branchesTree');
const { RepositoriesViewProvider } = require('./presentation/repositoriesView');
const { AiController } = require('./presentation/aiCommands');
const { openMergeTool } = require('./presentation/mergeTool');
const { showSetupGuide } = require('./presentation/guide');
const { openLineSelection } = require('./presentation/selectLines');
const { pickAndRebase } = require('./presentation/rebaseView');
const { ReflogPanel } = require('./presentation/reflogView');
const shelfUi = require('./presentation/shelf');
const patchUi = require('./presentation/patches');
const { registerWorktreeCommands } = require('./presentation/worktrees');
const { registerBlame } = require('./presentation/blame');
const { cleanWorkingTree } = require('./presentation/clean');
const { bisectAction } = require('./presentation/bisect');
const { registerChangelistCommands } = require('./presentation/changelists');
const { registerLfsCommands } = require('./presentation/lfs');
const { registerSigningCommands, signChoice } = require('./presentation/signing');
const { registerInlineBlame } = require('./presentation/inlineBlame');
const { useMemento } = require('./presentation/branchName');
const quick = require('./presentation/quickActions');
const cmd = require('./presentation/commands');

const NO_OPERATION = 'No merge, rebase, cherry-pick, revert or patch application in progress.';
const OPERATION_LABEL = { applyingMailbox: 'patch application (git am)' };

/**
 * Entry point and composition root: the only module that knows the data
 * layer implementations and hands them to the presentation layer.
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  const output = vscode.window.createOutputChannel('Git Tools');
  const git = new GitCliService(() => vscode.workspace.getConfiguration('gitTools').get('gitPath') || 'git');
  const manager = new RepoManager(output, git, context.workspaceState);
  const ai = new AiController(context, manager, createAi);
  const commitView = new CommitViewProvider(context, manager, ai);
  const logView = new LogViewProvider(context, manager);
  const branches = new BranchesTreeProvider(manager);
  branches.view = vscode.window.createTreeView('gitTools.branches', { treeDataProvider: branches, canSelectMany: true });
  const statusBar = new BranchStatusBar(manager);
  registerWorktreeCommands(context, manager);
  const annotate = registerBlame(context, manager, logView);
  registerInlineBlame(context, manager, annotate);
  useMemento(context.globalState);
  registerChangelistCommands(context, manager, commitView);
  registerLfsCommands(context, manager);
  registerSigningCommands(context, manager);

  context.subscriptions.push(
    output,
    statusBar,
    { dispose: () => manager.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(manager)),
    vscode.workspace.registerTextDocumentContentProvider(shelfUi.SHELF_SCHEME, new shelfUi.ShelfContentProvider(manager)),
    vscode.window.registerWebviewViewProvider('gitTools.commit', commitView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('gitTools.log', logView, { webviewOptions: { retainContextWhenHidden: true } }),
    branches.view,
    vscode.window.registerWebviewViewProvider('gitTools.repositories', new RepositoriesViewProvider(context, manager)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => manager.discover()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitTools.repositoryScanMaxDepth')) manager.discover();
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      // Follow the repository of the active file when several are open.
      if (!e || e.document.uri.scheme !== 'file' || manager.models.size < 2) return;
      const file = e.document.uri.fsPath.toLowerCase();
      const best = manager.list()
        .filter((m) => file.startsWith(m.root.toLowerCase() + path.sep))
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (best && best !== manager.current) manager.setCurrent(best);
    }),
  );

  /** Returns the current repository or explains why there is none. */
  const need = () => {
    const m = manager.current;
    if (!m) vscode.window.showWarningMessage('No Git repository found in this workspace.', 'Select Repository…')
      .then((r) => { if (r) vscode.commands.executeCommand('gitTools.selectRepository'); });
    return m;
  };
  /**
   * Registers a command that needs a repository: the one of a Source Control
   * Repositories item when invoked from there, otherwise the current one.
   */
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    const fromItem = args[0] && args[0].model;
    const m = fromItem || need();
    if (m) return fn(m, ...(fromItem ? args.slice(1) : args));
  }));
  const regFree = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  regFree('gitTools.refresh', async (node) => {
    if (node && node.model) return node.model._full ? node.model.refreshAll() : node.model.refreshStatus();
    await manager.discover();
    if (manager.current) await manager.current.refreshAll();
  });

  // Source Control Repositories.
  regFree('gitTools.repo.select', (node) => node && node.model && manager.setCurrent(node.model));
  regFree('gitTools.repo.open', async () => {
    const dir = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open Repository' });
    if (!dir) return;
    if (!(await manager.open(dir[0].fsPath))) vscode.window.showErrorMessage(`${dir[0].fsPath} is not inside a Git repository.`);
  });
  regFree('gitTools.repo.close', async (node) => {
    const m = (node && node.model) || manager.current;
    if (m) await manager.close(m);
  });
  regFree('gitTools.repo.reopenClosed', () => manager.reopenClosed());
  regFree('gitTools.repo.openTerminal', (node) => {
    const m = (node && node.model) || manager.current;
    if (m) vscode.window.createTerminal({ name: m.name, cwd: m.root }).show();
  });
  regFree('gitTools.repo.revealInOS', (node) => {
    const m = (node && node.model) || manager.current;
    if (m) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.root));
  });

  // Submodules (items of the Branches tree: {submodule, parent}).
  const subOf = (node) => (node && node.submodule ? node : null);
  regFree('gitTools.submodule.open', async (node) => {
    const n = subOf(node);
    if (!n) return;
    const m = await manager.open(path.join(n.parent.root, n.submodule.path));
    if (!m) vscode.window.showWarningMessage(`${n.submodule.path} is not initialized. Use "Update Submodule" first.`);
  });
  regFree('gitTools.submodule.update', (node) => {
    const n = subOf(node);
    if (n) return n.parent.updateSubmodules([n.submodule.path]);
  });
  regFree('gitTools.submodule.sync', (node) => {
    const n = subOf(node);
    if (n) return n.parent.run('Sync submodule URL', () => n.parent.repo.syncSubmodules([n.submodule.path]), { success: 'Submodule URL synced' });
  });
  regFree('gitTools.submodule.copyPath', async (node) => {
    const n = subOf(node);
    if (n) {
      await vscode.env.clipboard.writeText(n.submodule.path);
      vscode.window.setStatusBarMessage(`Copied ${n.submodule.path}`, 3000);
    }
  });
  /**
   * Registers a repository nested in `m` as a submodule (git submodule add
   * with the URL from .gitmodules or the nested repository's origin).
   */
  const registerSubmodule = async (m, rel, declaredUrl) => {
    let url = declaredUrl;
    if (!url) url = await m.repo.nestedOriginUrl(rel);
    url = await vscode.window.showInputBox({
      title: `Register ${rel} as a submodule of ${m.name}`,
      prompt: 'Repository URL recorded in .gitmodules',
      value: url,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'Enter the repository URL'),
    });
    if (!url) return;
    await m.run(`Register submodule ${rel}`, () => m.repo.registerSubmodule(rel, url.trim()),
      { success: `${rel} registered: commit .gitmodules and ${rel} to record it` });
    await manager.discover();
  };
  regFree('gitTools.submodule.register', (node) => {
    const n = subOf(node);
    if (n) return registerSubmodule(n.parent, n.submodule.path, n.submodule.url);
  });
  reg('gitTools.nestedRepo.register', (m, rel) => registerSubmodule(m, rel,
    (m.submodules.find((s) => s.path === rel) || {}).url));
  reg('gitTools.submodules.updateAll', (m) => m.updateSubmodules());
  reg('gitTools.submodules.syncAll', (m) => m.run('Sync submodule URLs', () => m.repo.syncSubmodules(), { success: 'Submodule URLs synced' }));
  reg('gitTools.submodules.add', async (m) => {
    const url = await vscode.window.showInputBox({ title: 'Add Submodule', prompt: 'Repository URL', ignoreFocusOut: true });
    if (!url) return;
    let name = url.trim().split(/[/\\:]/).filter(Boolean).pop() || 'submodule';
    if (name.endsWith('.git')) name = name.slice(0, -4);
    const rel = await vscode.window.showInputBox({ title: 'Add Submodule', prompt: 'Path inside this repository', value: name, ignoreFocusOut: true });
    if (!rel) return;
    await m.run('Add submodule', () => m.repo.addSubmodule(url.trim(), rel.trim().replace(/\\/g, '/')),
      { success: `Submodule added: commit .gitmodules and ${rel.trim()} to record it` });
    await manager.discover();
  });

  // Line level selection (partial commit).
  regFree('gitTools.selectLines', async (arg) => {
    let m = arg && arg.model;
    let rel = arg && arg.path;
    if (!m || !rel) {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') return vscode.window.showInformationMessage('Open a modified file to select lines to commit.');
      const file = uri.fsPath.toLowerCase();
      m = manager.list().filter((x) => file.startsWith(x.root.toLowerCase() + path.sep))
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (!m) return vscode.window.showInformationMessage('The file is not in a Git repository.');
      rel = path.relative(m.root, uri.fsPath).replace(/\\/g, '/');
      if (!m._full) await manager.setCurrent(m);
    }
    await openLineSelection(context, m, rel);
  });

  // Commit view grouping.
  regFree('gitTools.commit.groupByDirectory', () => commitView.setGroupBy('directory'));
  regFree('gitTools.commit.groupByNone', () => commitView.setGroupBy('none'));
  regFree('gitTools.commit.expandAll', () => commitView.setAllExpanded(true));
  regFree('gitTools.commit.collapseAll', () => commitView.setAllExpanded(false));
  regFree('gitTools.branches.expandAll', () => branches.setAllExpanded(true));
  regFree('gitTools.branches.collapseAll', () => branches.setAllExpanded(false));
  regFree('gitTools.selectRepository', async () => {
    const items = [...manager.models.values()].map((m) => ({ label: `$(repo) ${m.name}`, description: m.root, model: m }));
    const pick = /** @type {any} */ (await vscode.window.showQuickPick(
      [...items, { label: '$(folder-opened) Open Repository Folder…', id: 'open' }], { title: 'Select Repository' }));
    if (!pick) return;
    if (pick.model) return manager.setCurrent(pick.model);
    const dir = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open Repository' });
    if (!dir) return;
    if (!(await manager.open(dir[0].fsPath))) vscode.window.showErrorMessage(`${dir[0].fsPath} is not inside a Git repository.`);
  });
  regFree('gitTools.focusCommit', async () => {
    await vscode.commands.executeCommand('gitTools.commit.focus');
    commitView.focusMessage();
  });
  regFree('gitTools.showLog', () => vscode.commands.executeCommand('gitTools.log.focus'));
  reg('gitTools.showReflog', async (m) => {
    if (m !== manager.current) await manager.setCurrent(m);
    ReflogPanel.show(context, manager, logView);
  });
  regFree('gitTools.showOutput', () => output.show(true));

  reg('gitTools.push', (m) => cmd.push(m));
  reg('gitTools.update', (m) => cmd.update(m, context));
  reg('gitTools.fetch', (m) => cmd.fetch(m));
  reg('gitTools.branches', (m) => cmd.branchesPopup(m));
  reg('gitTools.newBranch', (m) => cmd.newBranch(m));
  reg('gitTools.checkoutRevision', (m) => cmd.checkoutRevision(m));
  reg('gitTools.stash', (m) => cmd.stash(m));
  reg('gitTools.manageRemotes', (m) => cmd.manageRemotes(m));
  reg('gitTools.resolveConflicts', (m) => cmd.resolveConflicts(m, (model, change) => openMergeTool(context, model, change)));
  reg('gitTools.continueOperation', (m) => {
    if (m.status.state === 'normal') return vscode.window.showInformationMessage(NO_OPERATION);
    // Concluding a merge creates the merge commit: signed as the Commit view's "Sign commit" says.
    return m.run(`Continue ${OPERATION_LABEL[m.status.state] || m.status.state}`, () => m.repo.continueOperation(m.status.state, signChoice(m)));
  });
  reg('gitTools.skipRebaseCommit', async (m) => {
    if (m.status.state === 'applyingMailbox') {
      const ok = await vscode.window.showWarningMessage('Skip the patch git am stopped at?', { modal: true, detail: 'Its changes are not applied.' }, 'Skip Patch');
      if (ok) await m.run('Skip patch', () => m.repo.skipMailboxPatch());
      return;
    }
    if (m.status.state !== 'rebasing') return vscode.window.showInformationMessage('No rebase in progress.');
    const ok = await vscode.window.showWarningMessage('Skip the commit the rebase stopped at?', { modal: true, detail: 'Its changes are left out of the rewritten history.' }, 'Skip Commit');
    if (ok) await m.run('Skip commit', () => m.repo.skipRebaseCommit());
  });
  reg('gitTools.interactiveRebase', (m) => pickAndRebase(context, m));
  reg('gitTools.abortOperation', async (m) => {
    if (m.status.state === 'normal') return vscode.window.showInformationMessage(NO_OPERATION);
    const label = OPERATION_LABEL[m.status.state] || m.status.state;
    const ok = await vscode.window.showWarningMessage(`Abort ${label}?`, { modal: true }, 'Abort');
    if (ok) await m.run(`Abort ${label}`, () => m.repo.abortOperation(m.status.state));
  });
  reg('gitTools.fileHistory', async (m, uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') return vscode.window.showInformationMessage('Open a file to show its history.');
    const rel = path.relative(m.root, target.fsPath).replace(/\\/g, '/');
    if (rel.startsWith('..')) return vscode.window.showInformationMessage('The file is not in the current repository.');
    m.setLogFilter({ path: rel, branch: null });
    await vscode.commands.executeCommand('gitTools.log.focus');
  });

  // Branch / tag / stash items of the Branches tree (argument: tree node).
  const branchOf = (node) => (node && node.branch) || null;
  const branchCmd = (id, action) => reg(id, (m, node) => {
    const b = branchOf(node);
    if (b) return cmd.runBranchAction(m, b, action);
  });
  branchCmd('gitTools.branch.checkout', 'checkout');
  branchCmd('gitTools.branch.newFrom', 'new');
  branchCmd('gitTools.branch.checkoutRebase', 'checkoutRebase');
  branchCmd('gitTools.branch.compare', 'compare');
  branchCmd('gitTools.branch.rebaseOnto', 'rebase');
  branchCmd('gitTools.branch.merge', 'merge');
  branchCmd('gitTools.branch.mergeDialog', 'mergeDialog');
  branchCmd('gitTools.branch.update', 'update');
  branchCmd('gitTools.branch.takeUpstream', 'takeUpstream');
  branchCmd('gitTools.branch.push', 'push');
  branchCmd('gitTools.branch.rename', 'rename');
  // Context menu: (clicked node, selected nodes); Delete key: nothing, the selection of the tree.
  reg('gitTools.branch.delete', (m, node, nodes) => {
    // Tags carry a branch-like object too: not branches to delete.
    const selected = (nodes && nodes.length ? nodes : node ? [node] : branches.view.selection)
      .filter((n) => n && !n.tag).map(branchOf).filter(Boolean);
    if (selected.length === 1 && !selected[0].current) return cmd.runBranchAction(m, selected[0], 'delete');
    if (selected.length) return cmd.deleteBranches(m, selected);
  });
  branchCmd('gitTools.branch.copyName', 'copy');
  // Ctrl+C / ⌘C in the Branches tree: the selected branches or tags, one per line (a tree view does not tell the hovered row).
  regFree('gitTools.branches.copySelected', async () => {
    const names = branches.view.selection
      .map((n) => (n.tag ? n.tag.name : n.branch ? n.branch.name : null))
      .filter(Boolean);
    if (!names.length) return;
    await vscode.env.clipboard.writeText(names.join('\n'));
    vscode.window.setStatusBarMessage(`$(check) Copied ${names.length === 1 ? names[0] : `${names.length} names`}`, 3000);
  });
  reg('gitTools.branch.showLog', (m, node) => {
    const b = branchOf(node);
    m.setLogFilter({ branch: b ? b.name : null, path: null });
    return vscode.commands.executeCommand('gitTools.log.focus');
  });
  reg('gitTools.tag.checkout', (m, node) => node && node.tag &&
    cmd.smartCheckout(m, `Checkout ${node.tag.name}`, () => m.repo.checkout(`refs/tags/${node.tag.name}`)));
  reg('gitTools.tag.push', async (m, node) => {
    if (!node || !node.tag) return;
    const remote = m.defaultRemote();
    if (!remote) return vscode.window.showWarningMessage('No remotes configured.');
    await m.run(`Push tag ${node.tag.name}`, () => m.repo.pushTag(remote, node.tag.name),
      { success: `Pushed tag ${node.tag.name}` });
  });
  reg('gitTools.tag.delete', async (m, node) => {
    if (!node || !node.tag) return;
    const ok = await vscode.window.showWarningMessage(`Delete tag ${node.tag.name} locally?`, { modal: true }, 'Delete');
    if (ok) await m.run('Delete tag', () => m.repo.deleteTag(node.tag.name));
  });
  reg('gitTools.stash.apply', (m, node) => node && node.stash && cmd.stashApply(m, node.stash, false));
  reg('gitTools.stash.pop', (m, node) => node && node.stash && cmd.stashApply(m, node.stash, true));
  reg('gitTools.stash.drop', (m, node) => node && node.stash && cmd.stashDrop(m, node.stash));
  reg('gitTools.stash.branch', (m, node) => node && node.stash && cmd.stashBranch(m, node.stash));
  reg('gitTools.stash.showFiles', (m, node) => node && node.stash && cmd.stashShowFiles(m, node.stash));

  // Clean: untracked files, with a preview.
  reg('gitTools.cleanWorkingTree', (m) => cleanWorkingTree(m));

  // Quick actions.
  reg('gitTools.switchRecentBranch', (m) => quick.switchRecentBranch(m));
  reg('gitTools.checkoutPreviousBranch', (m) => quick.checkoutPrevious(m));
  reg('gitTools.wip', (m) => quick.wip(m));
  reg('gitTools.unwip', (m) => quick.unwip(m));
  reg('gitTools.amendNoEdit', (m) => quick.amendNoEdit(m));
  reg('gitTools.undoLastAction', (m) => quick.undoLastAction(m));
  reg('gitTools.cleanMergedBranches', (m) => quick.cleanMergedBranches(m));
  regFree('gitTools.lineHistory', () => quick.lineHistory(manager, logView));
  regFree('gitTools.compareFileWithBranch', (uri) => quick.compareFileWithRef(manager, uri));

  // Bisect on the checked out commit (Commit view banner, command palette).
  for (const action of ['good', 'bad', 'skip', 'reset', 'run']) {
    reg(`gitTools.bisect.${action}`, (m) => bisectAction(m, logView, /** @type {any} */ (action)));
  }
  reg('gitTools.bisect.showFirstBad', (m) => m.bisect && m.bisect.firstBad && logView.showCommit(m.bisect.firstBad));

  // Shelve and patches. From the Commit view title: the ticked files.
  reg('gitTools.shelveChanges', (m) => shelfUi.shelveChanges(m, m.includedChanges()));
  reg('gitTools.showShelf', async (m) => {
    if (m !== manager.current) await manager.setCurrent(m);
    await branches.revealShelf();
  });
  reg('gitTools.createPatch', (m) => patchUi.createPatch(m, m.includedChanges(), false));
  reg('gitTools.copyPatch', (m) => patchUi.createPatch(m, m.includedChanges(), true));
  reg('gitTools.applyPatch', (m) => patchUi.applyPatch(m, false));
  reg('gitTools.applyPatchFromClipboard', (m) => patchUi.applyPatch(m, true));
  // Items of the Branches tree ▸ Shelf: {shelf} and {shelf, file}, read again (the tree may be behind).
  const shelfCmd = (id, fn) => reg(id, async (m, node) => {
    if (!node || !node.shelf) return;
    const shelf = await m.shelfStore.get(node.shelf.id);
    if (!shelf) {
      await m.refreshRefs();
      return vscode.window.showWarningMessage(`The shelf "${node.shelf.name}" no longer exists.`);
    }
    const file = node.file && shelf.files.find((f) => f.path === node.file.path);
    if (node.file && !file) return vscode.window.showWarningMessage(`${node.file.path} is no longer in the shelf.`);
    return fn(m, shelf, file);
  });
  shelfCmd('gitTools.shelf.unshelve', (m, s) => shelfUi.unshelveDialog(m, s));
  shelfCmd('gitTools.shelf.apply', (m, s) => shelfUi.unshelve(m, s, null, false));
  shelfCmd('gitTools.shelf.rename', (m, s) => shelfUi.renameShelf(m, s));
  shelfCmd('gitTools.shelf.delete', (m, s) => shelfUi.deleteShelf(m, s));
  shelfCmd('gitTools.shelf.createPatch', (m, s) => shelfUi.shelfPatch(m, s, false));
  shelfCmd('gitTools.shelf.copyPatch', (m, s) => shelfUi.shelfPatch(m, s, true));
  shelfCmd('gitTools.shelf.unshelveFile', (m, s, f) => f && shelfUi.unshelve(m, s, [f.path], true));
  shelfCmd('gitTools.shelf.showDiff', (m, s, f) => f && shelfUi.openShelfDiff(m, s, f));

  // AI commit messages.
  regFree('gitTools.ai.generate', (arg) => {
    // From the built-in Source Control title bar the argument is a SourceControl.
    const fromScm = arg && arg.rootUri instanceof vscode.Uri;
    if (fromScm) manager.open(arg.rootUri.fsPath).then(() => ai.generate({ toScm: true }));
    else ai.generate();
  });
  regFree('gitTools.ai.configure', () => ai.configure());
  regFree('gitTools.ai.setApiKey', () => ai.setApiKey());
  regFree('gitTools.ai.clearApiKey', () => ai.clearApiKey());
  regFree('gitTools.ai.testConnection', () => ai.testConnection());
  regFree('gitTools.ai.setupGuide', () => {
    const p = ai.provider();
    showSetupGuide(context, p === 'none' ? undefined : p);
  });

  await manager.discover();
}

function deactivate() {}

module.exports = { activate, deactivate };
