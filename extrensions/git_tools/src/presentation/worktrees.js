// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { defaultWorktreePath, worktreeOfBranch } = require('../domain/logic/worktree');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('./model').RepoManager} RepoManager */
/** @typedef {import('../domain/entities').Branch} Branch */
/** @typedef {import('../domain/entities').Worktree} Worktree */

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });

/** commands.js may import this module: resolved when called, not at load time. */
const validateRefName = (name, existing) => require('./commands').validateRefName(name, existing);

/** Folder name of a worktree. @param {Worktree} w */
const folderName = (w) => path.basename(w.path) || w.path;

/** "feature/x" or "detached at 1234abcd". @param {Worktree} w */
const worktreeWhat = (w) => (w.bare ? 'bare' : w.branch || `detached at ${w.head ? w.head.slice(0, 8) : '?'}`);

/** Opens a worktree folder in a new VS Code window. @param {string} p */
async function openWorktree(p) {
  if (!fs.existsSync(p)) {
    vscode.window.showWarningMessage(`The worktree folder no longer exists: ${p}. Use "Prune Worktrees…" to forget it.`);
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true });
}

/** Why `p` cannot hold a new worktree, or null. @param {string} root @param {string} v */
function validateWorktreeFolder(root, v) {
  if (!v.trim()) return 'Enter a folder';
  const p = path.resolve(root, v.trim());
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return 'A file with this name already exists';
    if (fs.readdirSync(p).length) return 'The folder already exists and is not empty';
  } catch {
    // Does not exist: git creates it.
  }
  return null;
}

/**
 * Start point picker: HEAD, branches and tags, or a revision typed by the
 * user. Resolves to {ref, hash} (hash of the commit), or null.
 * @param {RepoModel} m @param {string} title
 * @returns {Promise<{ref: string, hash: string}|null>}
 */
async function pickRevision(m, title) {
  const cur = m.status.branch;
  const items = [
    { label: `$(target) ${cur || 'HEAD'}`, description: cur ? 'current branch' : `HEAD${m.status.head ? ` · ${m.status.head.slice(0, 8)}` : ''}`, ref: cur || 'HEAD' },
    sep('Local Branches'),
    ...m.branches.filter((b) => !b.remote && !b.current).map((b) => ({ label: `$(git-branch) ${b.name}`, description: b.hash.slice(0, 8), ref: b.name })),
    sep('Remote Branches'),
    ...m.branches.filter((b) => b.remote).map((b) => ({ label: `$(cloud) ${b.name}`, description: b.hash.slice(0, 8), ref: b.name })),
    sep('Tags'),
    ...m.tags.map((t) => ({ label: `$(tag) ${t.name}`, description: t.hash.slice(0, 8), ref: `refs/tags/${t.name}` })),
  ];
  const qp = vscode.window.createQuickPick();
  qp.title = title;
  qp.placeholder = 'Pick a branch or tag, or type a revision (hash, HEAD~2…)';
  qp.items = /** @type {any[]} */ (items);
  qp.ignoreFocusOut = true;
  const ref = await new Promise((resolve) => {
    qp.onDidAccept(() => {
      const sel = /** @type {any} */ (qp.selectedItems[0]);
      resolve(sel && sel.ref ? sel.ref : qp.value.trim());
      qp.hide();
    });
    qp.onDidHide(() => resolve(null));
    qp.show();
  });
  qp.dispose();
  if (!ref) return null;
  const c = await m.repo.commitInfo(ref);
  if (!c) {
    vscode.window.showErrorMessage(`Unknown revision: ${ref}`);
    return null;
  }
  return { ref, hash: c.hash };
}

/** Name of a new local branch. @param {RepoModel} m @param {string} title @param {string} [value] */
async function askBranchName(m, title, value = '') {
  const existing = m.branches.filter((b) => !b.remote).map((b) => b.name);
  const name = await vscode.window.showInputBox({
    title,
    prompt: 'New branch name',
    value,
    ignoreFocusOut: true,
    validateInput: (v) => validateRefName(v, existing),
  });
  return name ? name.trim() : null;
}

/** Remote branch name without its remote: "origin/feature/x" → "feature/x". @param {RepoModel} m @param {string} name */
function withoutRemote(m, name) {
  const remote = (m.remotes || []).map((r) => r.name).filter((r) => name.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  return remote ? name.slice(remote.length + 1) : name.slice(name.indexOf('/') + 1);
}

/**
 * What to check out for `b` in the new worktree: the branch itself when no
 * worktree uses it, a new branch from it or a detached HEAD otherwise.
 * @param {RepoModel} m @param {Branch} b
 * @returns {Promise<{branch?: string, newBranch?: string, startPoint?: string, detach?: boolean, name: string}|null>}
 */
async function targetForBranch(m, b) {
  if (b.remote) {
    const name = await askBranchName(m, `New Worktree from ${b.name}`, withoutRemote(m, b.name));
    return name ? { newBranch: name, startPoint: b.name, name } : null;
  }
  const local = m.branches.find((x) => !x.remote && x.name === b.name);
  if (local && !local.current && !worktreeOfBranch(m.worktrees, local.name)) return { branch: local.name, name: local.name };
  // Checked out here or in another worktree (or a tag / revision): git refuses a second checkout.
  const other = local && worktreeOfBranch(m.worktrees, local.name);
  const label = b.name.replace(/^refs\/tags\//, '');
  const why = !local ? '' : local.current ? `${label} is the current branch. ` : `${label} is checked out in ${other ? other.path : 'another worktree'}. `;
  const picks = [
    { label: `$(add) New branch from ${label}…`, id: 'new' },
    { label: `$(git-commit) Detached at ${label}`, id: 'detach' },
    ...(other ? [{ label: `$(empty-window) Open the worktree of ${label}`, description: other.path, id: 'open' }] : []),
  ];
  const pick = await vscode.window.showQuickPick(picks, {
    title: `New Worktree from ${label}`,
    placeHolder: `${why}A branch can be checked out in one worktree only`,
    ignoreFocusOut: true,
  });
  if (!pick) return null;
  if (pick.id === 'open') {
    if (other) await openWorktree(other.path);
    return null;
  }
  if (pick.id === 'new') {
    const name = await askBranchName(m, `New Worktree: new branch from ${label}`);
    return name ? { newBranch: name, startPoint: b.name, name } : null;
  }
  const c = await m.repo.commitInfo(b.name);
  if (!c) {
    vscode.window.showErrorMessage(`Unknown revision: ${b.name}`);
    return null;
  }
  return { detach: true, startPoint: c.hash, name: c.hash.slice(0, 8) };
}

/**
 * Asks what the new worktree checks out: an existing branch, a new branch
 * or a detached revision.
 * @param {RepoModel} m
 */
async function targetFromScratch(m) {
  const mode = await vscode.window.showQuickPick([
    { label: '$(git-branch) Existing branch…', description: 'a local branch no worktree uses', id: 'existing' },
    { label: '$(add) New branch…', description: 'git worktree add -b <name> from a start point', id: 'new' },
    { label: '$(git-commit) Detached at revision…', description: 'no branch', id: 'detach' },
  ], { title: 'New Worktree', placeHolder: 'What to check out in the new worktree', ignoreFocusOut: true });
  if (!mode) return null;
  if (mode.id === 'existing') {
    const free = m.branches.filter((b) => !b.remote && !b.current && !worktreeOfBranch(m.worktrees, b.name));
    if (!free.length) {
      vscode.window.showInformationMessage('Every local branch is already checked out in a worktree: create a new branch instead.');
      return null;
    }
    const pick = await vscode.window.showQuickPick(free.map((b) => ({ label: `$(git-branch) ${b.name}`, description: b.hash.slice(0, 8), branch: b })),
      { title: 'New Worktree: Existing Branch', placeHolder: 'Branches checked out in another worktree are not listed', ignoreFocusOut: true });
    return pick ? { branch: pick.branch.name, name: pick.branch.name } : null;
  }
  if (mode.id === 'new') {
    const name = await askBranchName(m, 'New Worktree: New Branch');
    if (!name) return null;
    const from = await pickRevision(m, `New Worktree: start point of ${name}`);
    return from ? { newBranch: name, startPoint: from.ref, name } : null;
  }
  const from = await pickRevision(m, 'New Worktree: Detached at Revision');
  return from ? { detach: true, startPoint: from.hash, name: from.hash.slice(0, 8) } : null;
}

/**
 * New Worktree…: from a branch (local or remote, as from the branch popup
 * or "Checkout in New Worktree…") or from scratch; then the folder.
 * @param {RepoModel} m @param {Branch} [branch]
 */
async function newWorktree(m, branch) {
  const t = branch ? await targetForBranch(m, branch) : await targetFromScratch(m);
  if (!t) return;
  const value = await vscode.window.showInputBox({
    title: `New Worktree: ${t.newBranch ? `new branch ${t.newBranch}` : t.detach ? `detached at ${t.name}` : t.name}`,
    prompt: 'Folder of the new worktree (created by git)',
    value: defaultWorktreePath(m.root, t.name),
    ignoreFocusOut: true,
    validateInput: (v) => validateWorktreeFolder(m.root, v),
  });
  if (!value) return;
  const p = path.resolve(m.root, value.trim());
  const o = { path: p, branch: t.branch, newBranch: t.newBranch, startPoint: t.startPoint, detach: t.detach };
  const ok = await m.run(`Add worktree ${path.basename(p)}`, () => m.repo.addWorktree(o), { success: `Worktree created at ${p}` });
  if (!ok) return;
  const r = await vscode.window.showInformationMessage(`Worktree "${path.basename(p)}" created (${t.detach ? `detached at ${t.name}` : t.name}).`, 'Open in New Window');
  if (r) await openWorktree(p);
}

/** Copies the folder of a worktree. @param {Worktree} w */
async function copyWorktreePath(w) {
  await vscode.env.clipboard.writeText(w.path);
  vscode.window.setStatusBarMessage(`$(check) Copied ${w.path}`, 4000);
}

/** @param {RepoModel} m @param {Worktree} w */
async function lockWorktree(m, w) {
  const reason = await vscode.window.showInputBox({
    title: `Lock Worktree ${folderName(w)}`,
    prompt: 'Reason (optional): a locked worktree is not pruned, moved or removed',
    placeHolder: 'e.g. on a removable drive',
    ignoreFocusOut: true,
  });
  if (reason === undefined) return;
  await m.run(`Lock worktree ${folderName(w)}`, () => m.repo.lockWorktree(w.path, reason), { success: `Worktree ${folderName(w)} locked` });
}

/** @param {RepoModel} m @param {Worktree} w */
async function unlockWorktree(m, w) {
  await m.run(`Unlock worktree ${folderName(w)}`, () => m.repo.unlockWorktree(w.path), { success: `Worktree ${folderName(w)} unlocked` });
}

/**
 * Remove…: confirm; a second confirm before discarding local changes
 * (--force); a locked worktree is unlocked first when the user agrees.
 * @param {RepoModel} m @param {Worktree} w
 */
async function removeWorktree(m, w) {
  const name = folderName(w);
  if (w.main || w.current) {
    vscode.window.showInformationMessage(`The ${w.main ? 'main' : 'current'} worktree cannot be removed.`);
    return;
  }
  const keeps = w.branch ? `The branch ${w.branch} is kept.` : 'Commits only its detached HEAD reaches are no longer listed anywhere.';
  const ok = await vscode.window.showWarningMessage(
    w.locked ? `Worktree "${name}" is locked. Unlock and remove it?` : `Remove worktree "${name}"?`,
    {
      modal: true,
      detail: `${w.path}\n${w.locked ? `Lock reason: ${w.lockReason || '(none given)'}\n` : ''}The folder is deleted. ${keeps}`,
    },
    w.locked ? 'Unlock and Remove' : 'Remove');
  if (!ok) return;
  let force = false;
  // A folder already gone has no changes to lose (git only forgets it).
  if (fs.existsSync(w.path) && await m.repo.worktreeHasChanges(w.path)) {
    const sure = await vscode.window.showWarningMessage(`Worktree "${name}" has local changes.`, {
      modal: true,
      detail: `Modified and untracked files in ${w.path} will be lost. This cannot be undone.`,
    }, 'Remove Anyway');
    if (!sure) return;
    force = true;
  }
  await m.run(`Remove worktree ${name}`, async () => {
    if (w.locked) await m.repo.unlockWorktree(w.path);
    try {
      await m.repo.removeWorktree(w.path, force);
    } catch (e) {
      if (w.locked) await m.repo.lockWorktree(w.path, w.lockReason).catch(() => undefined);
      throw e;
    }
  }, { success: `Worktree ${name} removed` });
}

/**
 * Prune Worktrees…: lists what `git worktree prune -n -v` would forget,
 * then prunes after confirmation.
 * @param {RepoModel} m
 */
async function pruneWorktrees(m) {
  let lines;
  try {
    lines = await m.repo.pruneWorktrees(true);
  } catch (e) {
    vscode.window.showErrorMessage(`Prune worktrees failed: ${String(e && e.message ? e.message : e).split('\n')[0]}`);
    return;
  }
  if (!lines.length) {
    vscode.window.showInformationMessage('Nothing to prune: every worktree folder still exists (or is locked).');
    return;
  }
  const shown = lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n…and ${lines.length - 10} more` : '');
  const ok = await vscode.window.showWarningMessage(`Prune ${lines.length} worktree record(s)?`, {
    modal: true,
    detail: `Git forgets worktrees whose folder is gone:\n\n${shown}`,
  }, 'Prune');
  if (!ok) return;
  await m.run('Prune worktrees', () => m.repo.pruneWorktrees(false), { success: 'Worktrees pruned' });
}

/**
 * The worktree of a tree node, or one picked from a list (command palette).
 * @param {RepoModel} m @param {any} node @param {(w: Worktree) => boolean} filter @param {string} title
 * @returns {Promise<Worktree|null>}
 */
async function worktreeOf(m, node, filter, title) {
  if (node && node.worktree) return node.worktree;
  const list = m.worktrees.filter(filter);
  if (!list.length) {
    vscode.window.showInformationMessage('No worktree for this action.');
    return null;
  }
  const pick = await vscode.window.showQuickPick(list.map((w) => ({
    label: `$(${w.locked ? 'lock' : 'folder'}) ${folderName(w)}`,
    description: [worktreeWhat(w), w.current ? 'current' : '', w.main ? 'main' : '', w.locked ? 'locked' : '', w.prunable ? 'prunable' : '']
      .filter(Boolean).join(' · '),
    detail: w.path,
    worktree: w,
  })), { title, matchOnDescription: true, matchOnDetail: true });
  return pick ? pick.worktree : null;
}

/**
 * Worktree commands (argument: a Branches tree node, or nothing from the
 * command palette → the current repository).
 * @param {vscode.ExtensionContext} context @param {RepoManager} manager
 */
function registerWorktreeCommands(context, manager) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (node) => {
    const m = (node && node.model) || manager.current;
    if (!m) {
      vscode.window.showWarningMessage('No Git repository found in this workspace.');
      return;
    }
    return fn(m, node);
  }));
  const withWorktree = (id, filter, title, fn) => reg(id, async (m, node) => {
    const w = await worktreeOf(m, node, filter, title);
    if (w) return fn(m, w);
  });

  reg('gitTools.worktree.new', (m) => newWorktree(m));
  reg('gitTools.worktree.prune', (m) => pruneWorktrees(m));
  reg('gitTools.branch.checkoutInWorktree', (m, node) => newWorktree(m, node && node.branch ? node.branch : undefined));
  withWorktree('gitTools.worktree.open', (w) => !w.current, 'Open Worktree in New Window', (m, w) => openWorktree(w.path));
  withWorktree('gitTools.worktree.copyPath', () => true, 'Copy Worktree Path', (m, w) => copyWorktreePath(w));
  withWorktree('gitTools.worktree.lock', (w) => !w.main && !w.locked, 'Lock Worktree', lockWorktree);
  withWorktree('gitTools.worktree.unlock', (w) => w.locked, 'Unlock Worktree', unlockWorktree);
  withWorktree('gitTools.worktree.remove', (w) => !w.main && !w.current, 'Remove Worktree', removeWorktree);
}

module.exports = {
  registerWorktreeCommands, newWorktree, openWorktree, copyWorktreePath, lockWorktree, unlockWorktree, removeWorktree,
  pruneWorktrees, worktreeWhat,
};
