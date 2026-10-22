// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { GitError, CommitRejected } = require('../domain/errors');
const {
  recentBranches, isWipSubject, wipMessage, undoPlan, cleanupCandidates,
} = require('../domain/logic/quickActions');
const { relativeTime } = require('../domain/logic/blame');
const { openCommitDiff, openCompareWithLocal } = require('./diff');
const { modelOf } = require('./blame');
const { signChoice } = require('./signing');
const cmd = require('./commands');

/**
 * Quick actions: switch to a recent / the previous branch, WIP commits,
 * amend without editing, undo of the last action, history of selected lines,
 * compare a file with a branch and clean merged branches.
 *
 * @typedef {import('./model').RepoModel} RepoModel
 * @typedef {import('./model').RepoManager} RepoManager
 * @typedef {import('../domain/entities').Branch} Branch
 */

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
const shortOf = (hash) => hash.slice(0, 8);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Commits listed in a confirmation, at most 8. */
const commitLines = (commits) => commits.slice(0, 8).map((c) => `  ${shortOf(c.hash)} ${c.subject}`).join('\n') +
  (commits.length > 8 ? `\n  … and ${commits.length - 8} more` : '');

/** Refuses actions that move HEAD while a merge, rebase… is in progress. @param {RepoModel} m */
function busyWithOperation(m) {
  if (m.status.state === 'normal') return false;
  vscode.window.showWarningMessage('Finish or abort the merge / rebase in progress first.');
  return true;
}

// ---------------------------------------------------------------- branches

/**
 * After switching branch: offers to undo the WIP commit the branch ends with.
 * @param {RepoModel} m
 */
async function offerUnwip(m) {
  const head = await m.repo.commitInfo('HEAD');
  if (!head || !isWipSubject(head.subject) || !m.status.branch) return;
  const r = await vscode.window.showInformationMessage(`${m.status.branch} ends with a WIP commit: "${head.subject}".`, 'Unwip');
  if (r) await unwip(m);
}

/** @param {RepoModel} m @param {Branch} b */
async function switchTo(m, b) {
  await cmd.checkoutBranch(m, b);
  if (m.status.branch === b.name) await offerUnwip(m);
}

/** Branches checked out recently, most recent first. @param {RepoModel} m */
async function switchRecentBranch(m) {
  const entries = await m.repo.reflog('HEAD', 500);
  const locals = m.branches.filter((b) => !b.remote);
  const names = recentBranches(entries, locals.map((b) => b.name), m.status.branch);
  if (!names.length) return vscode.window.showInformationMessage('No other branch was checked out recently.');
  const pick = /** @type {any} */ (await vscode.window.showQuickPick(names.map((name, i) => {
    const b = /** @type {Branch} */ (locals.find((x) => x.name === name));
    return {
      label: `$(git-branch) ${name}`,
      description: [i === 0 ? 'previous' : '', b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : '', b.upstream || '']
        .filter(Boolean).join(' '),
      branch: b,
    };
  }), { title: `Recent Branches · ${m.name}`, placeHolder: 'Select a branch to check it out', matchOnDescription: true }));
  if (pick) await switchTo(m, pick.branch);
}

/** `git checkout -`: back to the branch (or commit) checked out before. @param {RepoModel} m */
async function checkoutPrevious(m) {
  const prev = await m.repo.previousCheckout();
  if (!prev) return vscode.window.showInformationMessage('No branch was checked out before this one.');
  const b = prev.name ? m.branches.find((x) => !x.remote && x.name === prev.name) : null;
  if (b) return switchTo(m, b);
  if (prev.name) return vscode.window.showInformationMessage(`The previous branch ${prev.name} no longer exists.`);
  await cmd.smartCheckout(m, `Checkout ${shortOf(prev.hash)}`, () => m.repo.checkout(prev.hash));
}

// ---------------------------------------------------------------- commits

/** Every change, untracked files included, in a temporary commit. @param {RepoModel} m */
async function wip(m) {
  if (busyWithOperation(m)) return;
  // Nested repositories stay out: `git add` would record them as gitlinks.
  const nested = m.status.changes.filter((c) => c.nestedRepo).map((c) => c.path);
  const count = m.status.changes.length - nested.length;
  if (!count) return vscode.window.showInformationMessage('There are no local changes to put in a WIP commit.');
  if (m.status.changes.some((c) => c.type === 'conflicted')) return vscode.window.showWarningMessage('Resolve the conflicts first.');
  await m.run('WIP commit', () => m.repo.wipCommit(wipMessage(m.status.branch), nested),
    { success: `${plural(count, 'file')} saved in a WIP commit (Unwip brings them back)` });
}

/** Undoes the WIP commit HEAD is, its changes back in the working tree. @param {RepoModel} m */
async function unwip(m) {
  if (busyWithOperation(m)) return;
  const head = await m.repo.commitInfo('HEAD');
  if (!head || !isWipSubject(head.subject)) {
    return vscode.window.showInformationMessage(`The last commit is not a WIP commit${head ? `: "${head.subject}"` : ''}.`);
  }
  if (head.parents.length !== 1) return vscode.window.showInformationMessage('The WIP commit has no single parent: undo it from the Log.');
  if (await m.repo.headPushed()) {
    const ok = await vscode.window.showWarningMessage('The WIP commit is already pushed.', {
      modal: true, detail: 'Undoing it here leaves it on the remote; the next push of this branch needs a force push.',
    }, 'Unwip Anyway');
    if (!ok) return;
  }
  await m.run('Unwip', () => m.repo.reset('HEAD~1', 'mixed'), { success: 'WIP commit undone: its changes are back' });
}

/** Adds the ticked files to the last commit, keeping its message. @param {RepoModel} m */
async function amendNoEdit(m) {
  if (!m.status.head) return vscode.window.showInformationMessage('There is no commit to amend yet.');
  if (busyWithOperation(m)) return;
  const changes = m.includedChanges();
  if (!changes.length) return vscode.window.showInformationMessage('Tick the files to add to the last commit in the Commit view.');
  if (await m.repo.headPushed()) {
    const ok = await vscode.window.showWarningMessage('The last commit is already pushed.', {
      modal: true, detail: 'Amending rewrites it: the next push of this branch needs a force push.',
    }, 'Amend Anyway');
    if (!ok) return;
  }
  let prepared;
  try {
    prepared = await m.commitChanges.prepare({
      status: m.status,
      message: await m.repo.lastCommitMessage(),
      changes,
      lineSelections: m.lineSelections,
      amend: true,
      signOff: m.signOff,
      sign: signChoice(m),
    });
  } catch (e) {
    if (e instanceof CommitRejected) return vscode.window.showWarningMessage(e.message);
    const r = await vscode.window.showWarningMessage(e.message, 'Select Lines…');
    if (r && e.path) vscode.commands.executeCommand('gitTools.selectLines', { model: m, path: e.path });
    return;
  }
  const ok = await m.run('Amend commit', () => m.commitChanges.run(prepared),
    { success: `${plural(changes.length, 'file')} added to the last commit` });
  if (ok) {
    // The message box keeps its draft: it was not used.
    m.includedUntracked.clear();
    m.lineSelections.clear();
    m.applyActiveTicks();
    m.fire('status');
  }
}

/** Undoes the newest action of the HEAD reflog (commit, amend, merge, pull, rebase, reset, checkout…). @param {RepoModel} m */
async function undoLastAction(m) {
  if (m.status.state !== 'normal') {
    const r = await vscode.window.showWarningMessage('A merge, rebase or cherry-pick is in progress: abort it to undo it.', 'Abort…');
    if (r) vscode.commands.executeCommand('gitTools.abortOperation');
    return;
  }
  const plan = undoPlan(await m.repo.reflog('HEAD', 500));
  if ('unsupported' in plan) return vscode.window.showInformationMessage(plan.unsupported);
  const what = `${plan.action}${plan.message ? `: ${plan.message}` : ''}`;

  if (plan.kind === 'checkout') {
    const b = m.branches.find((x) => !x.remote && x.name === plan.checkout);
    const label = b ? b.name : shortOf(plan.target);
    const ok = await vscode.window.showInformationMessage(`Undo the checkout: go back to ${label}?`,
      { modal: true, detail: what }, 'Undo');
    if (!ok) return;
    if (b) return switchTo(m, b);
    return cmd.smartCheckout(m, `Checkout ${label}`, () => m.repo.checkout(plan.target));
  }

  const [target, leaving, pushed] = await Promise.all([
    m.repo.commitInfo(plan.target),
    m.repo.commitsBetween(plan.target, 'HEAD'),
    m.repo.headPushed(),
  ]);
  if (!target) return vscode.window.showWarningMessage(`Commit ${shortOf(plan.target)} no longer exists: cannot undo.`);
  const detail = [
    what,
    `${m.status.branch || 'HEAD'} goes back to ${shortOf(target.hash)} ${target.subject}.`,
    plan.kind === 'soft'
      ? 'The changes of the undone commit stay in the working tree.'
      : 'Uncommitted changes are kept.',
    leaving.length ? `${plural(leaving.length, 'commit')} leave the branch (git's reflog keeps them for a while):\n${commitLines(leaving)}` : '',
    pushed && leaving.length ? '⚠ They are already pushed: the next push needs a force push.' : '',
  ].filter(Boolean).join('\n\n');
  const ok = await vscode.window.showWarningMessage(`Undo ${plan.action}?`, { modal: true, detail }, 'Undo');
  if (!ok) return;

  if (plan.kind === 'soft') {
    await m.run(`Undo ${plan.action}`, () => m.repo.reset(plan.target, 'soft'), { success: `Undone: ${plan.action}` });
    return;
  }
  /** @type {GitError|null} */
  let refused = null;
  const done = await m.run(`Undo ${plan.action}`, async () => {
    try {
      await m.repo.reset(plan.target, 'keep');
    } catch (e) {
      // Local changes in files the undo would change: git refuses --keep.
      if (e instanceof GitError && /not uptodate|local changes|would be overwritten/i.test(e.stderr)) refused = e;
      else throw e;
    }
  });
  if (!done) return;
  if (!refused) {
    vscode.window.setStatusBarMessage(`$(check) Undone: ${plan.action}`, 4000);
    return;
  }
  const mixed = await vscode.window.showWarningMessage('Your uncommitted changes touch files the undo would change.', {
    modal: true,
    detail: `${refused.stderr.trim().split('\n').slice(0, 4).join('\n')}\n\n"Move Branch Only" moves the branch back and leaves every file as it is now (mixed reset): the differences show as local changes.`,
  }, 'Move Branch Only');
  if (mixed) await m.run(`Undo ${plan.action}`, () => m.repo.reset(plan.target, 'mixed'), { success: `Undone: ${plan.action} (files left as they were)` });
}

// ---------------------------------------------------------------- files

/**
 * The repository and relative path of a file command's target (argument
 * or active editor), or null after telling why.
 * @param {RepoManager} manager
 * @param {any} arg
 * @param {string} what
 */
function fileTarget(manager, arg, what) {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') {
    vscode.window.showInformationMessage(`Open a file to ${what}.`);
    return null;
  }
  const m = modelOf(manager, uri.fsPath);
  if (!m) {
    vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} is not in a Git repository.`);
    return null;
  }
  return { m, rel: path.relative(m.root, uri.fsPath).replace(/\\/g, '/'), uri };
}

/**
 * Commits that changed the selected lines (git log -L): select one to open
 * the file's diff in it; buttons: Show in Log, Copy Hash.
 * @param {RepoManager} manager
 * @param {import('./logView').LogViewProvider} logView
 */
async function lineHistory(manager, logView) {
  const editor = vscode.window.activeTextEditor;
  const t = fileTarget(manager, undefined, 'show the history of its lines');
  if (!t || !editor) return;
  const { m, rel } = t;
  const sel = editor.selection;
  const start = sel.start.line + 1;
  // A selection ending at the start of a line does not include that line.
  const end = Math.max(start, sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1));
  const changed = editor.document.isDirty || m.status.changes.some((c) => c.path === rel);
  let entries;
  try {
    entries = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `History of ${path.basename(rel)}:${start}` },
      () => m.repo.lineHistory(rel, start, end));
  } catch (e) {
    const msg = String(e.message || e);
    if (/no path|has only \d+ line|bad revision|does not have any commits|unknown revision/i.test(msg)) {
      return vscode.window.showInformationMessage(`No committed history for these lines of ${path.basename(rel)}.`);
    }
    return vscode.window.showWarningMessage(`Line history failed: ${msg.split('\n').find((l) => /fatal|error/.test(l)) || msg.split('\n')[0]}`);
  }
  if (!entries.length) return vscode.window.showInformationMessage(`No committed history for these lines of ${path.basename(rel)}.`);
  const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
  const qp = vscode.window.createQuickPick();
  qp.title = `${path.basename(rel)}, ${range}: ${plural(entries.length, 'commit')}${changed ? ' (line numbers of the committed file)' : ''}`;
  qp.placeholder = 'Select a commit to open its diff';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true; // stays open while stepping through the diffs
  const buttons = [
    { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Show in Log' },
    { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy Hash' },
  ];
  qp.items = entries.map((e) => {
    const lines = e.added.length ? e.added.map((l) => `+ ${l.trim()}`) : e.removed.map((l) => `- ${l.trim()}`);
    return {
      label: `$(git-commit) ${e.subject}`,
      description: `${shortOf(e.hash)} · ${e.author} · ${relativeTime(e.time)}${e.oldPath && e.oldPath !== e.path ? ` · renamed from ${e.oldPath}` : ''}`,
      detail: lines.filter((l) => l.length > 2).slice(0, 2).join('   ') || (e.oldPath ? '' : 'file created'),
      buttons,
      entry: e,
    };
  });
  qp.onDidTriggerItemButton(async (ev) => {
    const e = /** @type {any} */ (ev.item).entry;
    if (ev.button === buttons[0]) {
      qp.hide();
      if (m !== manager.current) await manager.setCurrent(m);
      await logView.showCommit(e.hash);
    } else {
      await vscode.env.clipboard.writeText(e.hash);
      vscode.window.setStatusBarMessage(`$(check) Copied ${shortOf(e.hash)}`, 3000);
    }
  });
  qp.onDidAccept(() => {
    const e = /** @type {any} */ (qp.selectedItems[0])?.entry;
    if (!e) return;
    /** @type {import('../domain/entities').FileChange} */
    const f = e.oldPath === null ? { path: e.path, type: 'added' }
      : e.oldPath !== e.path ? { path: e.path, oldPath: e.oldPath, type: 'renamed' } : { path: e.path, type: 'modified' };
    openCommitDiff(m, f, e.hash, e.parents[0] || null, true);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/**
 * Compares a file with its version on a branch, a tag or any revision.
 * @param {RepoManager} manager
 * @param {any} arg Uri (explorer / editor title) or nothing (active editor)
 */
async function compareFileWithRef(manager, arg) {
  const t = fileTarget(manager, arg, 'compare it with a branch');
  if (!t) return;
  const { m, rel } = t;
  if (!m._full) await manager.setCurrent(m);
  const item = (b) => ({ label: `$(git-branch) ${b.name}`, description: b.current ? 'current' : '', ref: b.name });
  const qp = vscode.window.createQuickPick();
  qp.title = `Compare ${path.basename(rel)} with…`;
  qp.placeholder = 'Select a branch or tag, or type a revision';
  qp.matchOnDescription = true;
  qp.items = [
    sep('Local'),
    ...m.branches.filter((b) => !b.remote).sort((a, b) => (b.current - a.current) || a.name.localeCompare(b.name)).map(item),
    sep('Remote'),
    ...m.branches.filter((b) => b.remote).map(item),
    sep('Tags'),
    ...m.tags.map((x) => ({ label: `$(tag) ${x.name}`, ref: `refs/tags/${x.name}` })),
  ];
  const ref = await new Promise((resolve) => {
    qp.onDidAccept(() => {
      const sel = /** @type {any} */ (qp.selectedItems[0]);
      resolve(sel ? sel.ref : qp.value.trim());
      qp.hide();
    });
    qp.onDidHide(() => resolve(null));
    qp.show();
  });
  qp.dispose();
  if (!ref) return;
  if (!(await m.repo.refExists(`${ref}^{commit}`))) return vscode.window.showErrorMessage(`Unknown revision: ${ref}`);
  if (!(await m.repo.show(ref, rel))) {
    return vscode.window.showInformationMessage(`${rel} does not exist in ${ref.replace(/^refs\/tags\//, '')}.`);
  }
  await openCompareWithLocal(m, rel, ref);
}

// ---------------------------------------------------------------- cleanup

/** Default base of "Clean Merged Branches": main, master or develop, else the current branch. @param {RepoModel} m */
function defaultBase(m) {
  const locals = m.branches.filter((b) => !b.remote).map((b) => b.name);
  return ['main', 'master', 'develop'].find((n) => locals.includes(n)) || m.status.branch || 'HEAD';
}

/**
 * Local branches merged into a base branch or whose upstream is gone,
 * ticked for deletion. Buttons: change the base, fetch --prune.
 * @param {RepoModel} m
 */
async function cleanMergedBranches(m) {
  let base = defaultBase(m);
  const qp = vscode.window.createQuickPick();
  qp.canSelectMany = true;
  qp.matchOnDescription = true;
  qp.placeholder = 'Ticked branches are deleted (unmerged ones only after a second confirmation)';
  const changeBase = { iconPath: new vscode.ThemeIcon('git-merge'), tooltip: 'Change Base Branch…' };
  const fetch = { iconPath: new vscode.ThemeIcon('cloud-download'), tooltip: 'Fetch All (prune deleted remote branches)' };
  qp.buttons = [changeBase, fetch];
  let gen = 0;
  /** Hidden only while the base branch is chosen: not disposed. */
  let choosingBase = false;
  const load = async () => {
    const g = ++gen;
    qp.title = `Clean Branches Merged into ${base}`;
    qp.busy = true;
    try {
      const merged = new Set(await m.repo.mergedBranches(base));
      const checkedOut = new Set(m.worktrees.filter((w) => !w.current && w.branch).map((w) => /** @type {string} */ (w.branch)));
      const list = cleanupCandidates(m.branches, merged, base, checkedOut);
      if (g !== gen) return;
      const items = list.map((x) => ({
        label: `$(git-branch) ${x.branch.name}`,
        description: [x.merged ? `merged into ${base}` : '', x.gone ? 'upstream gone' : '', !x.merged && x.branch.ahead ? `↑${x.branch.ahead} not merged` : '']
          .filter(Boolean).join(' · '),
        branch: x.branch,
      }));
      qp.items = items.length ? items : [{ label: `$(check) No branch merged into ${base} and no branch with a deleted upstream.`, branch: null }];
      qp.selectedItems = items;
    } catch (e) {
      if (g === gen) qp.items = [{ label: `$(error) ${String(e.message).split('\n')[0]}`, branch: null }];
    } finally {
      if (g === gen) qp.busy = false;
    }
  };
  qp.onDidTriggerButton(async (b) => {
    if (b === fetch) {
      qp.busy = true;
      await m.run('Fetch', () => m.repo.fetchAll());
      return load();
    }
    choosingBase = true;
    const pick = await vscode.window.showQuickPick(
      m.branches.map((x) => ({ label: x.name, description: x.remote ? 'remote' : '' })),
      { title: 'Base branch: branches merged into it are offered for deletion' });
    choosingBase = false;
    // This quick pick hid when the other one opened.
    if (pick) base = pick.label;
    qp.show();
    await load();
  });
  qp.onDidAccept(async () => {
    const branches = qp.selectedItems.map((i) => /** @type {any} */ (i).branch).filter(Boolean);
    if (!branches.length) return;
    qp.hide();
    await cmd.deleteBranches(m, branches);
  });
  qp.onDidHide(() => { if (!choosingBase) qp.dispose(); });
  qp.show();
  await load();
}

module.exports = {
  switchRecentBranch, checkoutPrevious, offerUnwip, wip, unwip, amendNoEdit, undoLastAction, lineHistory, compareFileWithRef,
  cleanMergedBranches,
};
