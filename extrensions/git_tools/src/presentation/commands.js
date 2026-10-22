// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { GitError } = require('../domain/errors');
const { openCommitDiff } = require('./diff');
const { olderFirst } = require('../domain/logic/history');
const { checkedOutElsewhere, worktreeOfBranch } = require('../domain/logic/worktree');
const { divergedFromUpstream } = require('../domain/logic/divergence');
const { mergeDialog } = require('./mergeDialog');
const { newWorktree, openWorktree } = require('./worktrees');
const { signChoice, askSignTag } = require('./signing');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').Branch} Branch */

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });

/** Simplified `git check-ref-format`. */
function validateRefName(name, existing = []) {
  const n = name.trim();
  if (!n) return 'Name cannot be empty';
  if (/[\s~^:?*[\\]/.test(n) || n.includes('..') || n.includes('@{') || n.startsWith('-') || n.startsWith('/') ||
      n.endsWith('/') || n.endsWith('.') || n.endsWith('.lock')) {
    return 'Invalid name';
  }
  if (existing.includes(n)) return `"${n}" already exists`;
  return null;
}

const currentLabel = (m) => m.status.branch || 'HEAD';

function warnConflicts(m) {
  const n = m.status.changes.filter((c) => c.type === 'conflicted').length;
  if (!n) return;
  // A pull that conflicts can also be given up for the remote branch as it is.
  m.repo.pullInProgress().catch(() => null).then(async (pull) => {
    const take = pull ? `Drop Local and Take ${pull.upstream}…` : null;
    const r = await vscode.window.showWarningMessage(`${n} file(s) have conflicts.`, 'Resolve…', ...(take ? [take] : []));
    if (r === 'Resolve…') vscode.commands.executeCommand('gitTools.resolveConflicts');
    else if (r && r === take) await takeRemote(m, pull.branch, pull.upstream, m.status.state);
  });
}

// ---------------------------------------------------------------- branches

/**
 * Checkout that offers Smart Checkout (stash, checkout, unstash) when local
 * changes would be overwritten.
 * @param {RepoModel} m
 */
async function smartCheckout(m, label, checkout) {
  m.busy = label;
  m.fire('busy');
  try {
    await checkout();
    vscode.window.setStatusBarMessage(`$(check) ${label}`, 4000);
  } catch (e) {
    m.busy = null;
    // The branch is checked out in another worktree: offer to open that one.
    const elsewhere = e instanceof GitError ? checkedOutElsewhere(e.message) : null;
    if (elsewhere) {
      m.log(`${label} failed: ${e.message}`, 'error');
      const choice = await vscode.window.showWarningMessage(`${label} failed: the branch is already checked out in another worktree.`,
        { modal: true, detail: `${elsewhere}\n\nA branch can be checked out in one worktree at a time. Open that worktree, or create a new branch from it.` },
        'Open that Worktree');
      if (choice) await openWorktree(path.normalize(elsewhere));
      return;
    }
    const overwritten = e instanceof GitError &&
      /would be overwritten|commit your changes or stash them/.test(e.stderr);
    if (!overwritten) {
      m.log(`${label} failed: ${e.message}`, 'error');
      vscode.window.showErrorMessage(`${label} failed: ${e.message}`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'Your local changes would be overwritten by checkout.',
      { modal: true, detail: `${e.message}\n\nSmart Checkout stashes local changes, checks out, then restores them.` },
      'Smart Checkout',
    );
    if (choice === 'Smart Checkout') {
      await m.run(label, async () => {
        await m.repo.stash({ message: 'Uncommitted changes before checkout' });
        try {
          await checkout();
        } finally {
          await m.repo.stashPop();
        }
      }, { success: `${label} (local changes restored)` });
      return;
    }
  } finally {
    m.busy = null;
    m.fire('busy');
    await m.refreshAll();
  }
}

/** @param {RepoModel} m @param {Branch} b */
async function checkoutBranch(m, b) {
  if (b.current) return;
  if (!b.remote) {
    return smartCheckout(m, `Checkout ${b.name}`, () => m.repo.checkout(b.name));
  }
  const short = b.name.slice(b.name.indexOf('/') + 1);
  const local = m.branches.find((x) => !x.remote && x.name === short);
  if (local) {
    return smartCheckout(m, `Checkout ${local.name}`, () => m.repo.checkout(local.name));
  }
  return smartCheckout(m, `Checkout ${b.name}`,
    () => m.repo.checkoutTracking(short, b.name));
}

/** @param {RepoModel} m */
async function newBranch(m, startPoint, startLabel) {
  const existing = m.branches.filter((b) => !b.remote).map((b) => b.name);
  const name = await vscode.window.showInputBox({
    title: startPoint ? `New Branch from ${startLabel || startPoint}` : 'Create New Branch',
    prompt: 'New branch name',
    validateInput: (v) => validateRefName(v, existing),
  });
  if (!name) return;
  const pick = await vscode.window.showQuickPick(
    [{ label: '$(check) Create and checkout', id: true }, { label: 'Create without checkout', id: false }],
    { title: `Create branch ${name.trim()}` },
  );
  if (!pick) return;
  const branch = name.trim();
  const fromRemote = !!startPoint && m.branches.some((b) => b.remote && b.name === startPoint);
  const create = () => m.repo.createBranch(branch, { startPoint, checkout: pick.id, fromRemote });
  if (pick.id) await smartCheckout(m, `Create branch ${branch}`, create);
  else await m.run(`Create branch ${branch}`, create, { success: `Branch ${branch} created` });
}

/** @param {RepoModel} m @param {Branch} b */
async function renameBranch(m, b) {
  const existing = m.branches.filter((x) => !x.remote).map((x) => x.name);
  const name = await vscode.window.showInputBox({
    title: `Rename Branch ${b.name}`,
    value: b.name,
    validateInput: (v) => (v.trim() === b.name ? 'Enter a different name' : validateRefName(v, existing)),
  });
  if (!name) return;
  await m.run('Rename branch', () => m.repo.renameBranch(b.name, name.trim()),
    { success: `Renamed to ${name.trim()}` });
}

/** @param {RepoModel} m @param {Branch} b */
async function deleteBranch(m, b) {
  if (b.remote) {
    const remote = b.name.slice(0, b.name.indexOf('/'));
    const branch = b.name.slice(b.name.indexOf('/') + 1);
    const ok = await vscode.window.showWarningMessage(`Delete remote branch ${b.name}?`,
      { modal: true, detail: `This pushes the deletion to ${remote}.` }, 'Delete');
    if (ok) {
      await m.run(`Delete ${b.name}`, () => m.repo.deleteRemoteBranch(remote, branch),
        { success: `Deleted ${b.name}` });
    }
    return;
  }
  const ok = await vscode.window.showWarningMessage(`Delete branch ${b.name}?`, { modal: true }, 'Delete');
  if (!ok) return;
  try {
    await m.repo.deleteBranch(b.name);
    vscode.window.setStatusBarMessage(`$(check) Deleted branch ${b.name}`, 4000);
  } catch (e) {
    if (e instanceof GitError && e.stderr.includes('not fully merged')) {
      const force = await vscode.window.showWarningMessage(`Branch ${b.name} is not fully merged.`,
        { modal: true, detail: 'Deleting it may lose commits. Delete anyway?' }, 'Force Delete');
      if (force) await m.run(`Delete ${b.name}`, () => m.repo.deleteBranch(b.name, true));
    } else {
      vscode.window.showErrorMessage(`Delete branch failed: ${e.message}`);
    }
  }
  await m.refreshAll();
}

/**
 * Deletes several local branches after one confirmation; the ones not fully
 * merged are force deleted after a second one. The current branch is kept.
 * @param {RepoModel} m @param {Branch[]} branches
 */
async function deleteBranches(m, branches) {
  const kept = branches.filter((b) => b.current);
  const list = branches.filter((b) => !b.current && !b.remote);
  if (!list.length) {
    if (kept.length) vscode.window.showInformationMessage(`${kept[0].name} is the current branch: it cannot be deleted.`);
    return;
  }
  const names = (bs) => bs.slice(0, 15).map((b) => `  ${b.name}`).join('\n') + (bs.length > 15 ? `\n  … and ${bs.length - 15} more` : '');
  const ok = await vscode.window.showWarningMessage(`Delete ${list.length} branch${list.length === 1 ? '' : 'es'}?`, {
    modal: true,
    detail: `${names(list)}${kept.length ? `\n\nNot deleted (current branch): ${kept.map((b) => b.name).join(', ')}` : ''}`,
  }, 'Delete');
  if (!ok) return;
  const deleted = [];
  const unmerged = [];
  const failed = [];
  await m.run(`Delete ${list.length} branches`, async () => {
    for (const b of list) {
      try {
        await m.repo.deleteBranch(b.name);
        deleted.push(b);
      } catch (e) {
        if (e instanceof GitError && e.stderr.includes('not fully merged')) unmerged.push(b);
        else failed.push(`${b.name}: ${(e.stderr || e.message || '').trim().split('\n')[0]}`);
      }
    }
  });
  if (unmerged.length) {
    const force = await vscode.window.showWarningMessage(
      `${unmerged.length} branch${unmerged.length === 1 ? ' is' : 'es are'} not fully merged.`,
      { modal: true, detail: `${names(unmerged)}\n\nDeleting ${unmerged.length === 1 ? 'it' : 'them'} may lose commits. Delete anyway?` },
      'Force Delete');
    if (force) {
      await m.run(`Force delete ${unmerged.length} branches`, async () => {
        for (const b of unmerged) {
          try {
            await m.repo.deleteBranch(b.name, true);
            deleted.push(b);
          } catch (e) {
            failed.push(`${b.name}: ${(e.stderr || e.message || '').trim().split('\n')[0]}`);
          }
        }
      });
    }
  }
  if (failed.length) vscode.window.showErrorMessage(`Could not delete ${failed.length} branch${failed.length === 1 ? '' : 'es'}: ${failed.join('; ')}`);
  if (deleted.length) vscode.window.setStatusBarMessage(`$(check) Deleted ${deleted.length} branch${deleted.length === 1 ? '' : 'es'}`, 4000);
  await m.refreshAll();
}

/** @param {RepoModel} m */
async function mergeIntoCurrent(m, ref) {
  await m.run(`Merge ${ref} into ${currentLabel(m)}`, () => m.repo.merge(ref),
    { success: `Merged ${ref}` });
  warnConflicts(m);
}

/** @param {RepoModel} m */
async function rebaseOnto(m, ref) {
  await m.run(`Rebase ${currentLabel(m)} onto ${ref}`, () => m.repo.rebase(ref),
    { success: `Rebased onto ${ref}` });
  warnConflicts(m);
}

/** @param {RepoModel} m @param {Branch} b */
async function checkoutAndRebase(m, b) {
  const cur = currentLabel(m);
  await m.run(`Checkout ${b.name} and rebase onto ${cur}`,
    () => m.repo.rebase(cur, b.name), { success: `Rebased ${b.name} onto ${cur}` });
  warnConflicts(m);
}

/** Lists commits on each side and lets the user open diffs of changed files. */
async function compareWithCurrent(m, ref) {
  const cur = currentLabel(m);
  const [theirs, ours, files] = await Promise.all([
    m.repo.commitsBetween('HEAD', ref),
    m.repo.commitsBetween(ref, 'HEAD'),
    m.repo.changedFiles('HEAD', ref),
  ]);
  const items = [
    sep(`Commits in ${ref} not in ${cur} (${theirs.length})`),
    ...theirs.map((c) => ({ label: `$(git-commit) ${c.subject}`, description: `${c.hash.slice(0, 8)} · ${c.author}` })),
    sep(`Commits in ${cur} not in ${ref} (${ours.length})`),
    ...ours.map((c) => ({ label: `$(git-commit) ${c.subject}`, description: `${c.hash.slice(0, 8)} · ${c.author}` })),
    sep(`Files that differ (${files.length}) — select to open diff`),
    ...files.map((f) => ({ label: `$(diff) ${path.basename(f.path)}`, description: f.path, file: f })),
  ];
  const qp = vscode.window.createQuickPick();
  qp.title = `Compare ${cur} with ${ref}`;
  qp.items = items;
  qp.matchOnDescription = true;
  qp.onDidAccept(() => {
    const sel = /** @type {any} */ (qp.selectedItems[0]);
    if (sel && sel.file) openCommitDiff(m, sel.file, ref, 'HEAD', false);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

const STATUS_LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typeChanged: 'T', untracked: 'U', conflicted: 'U' };

/**
 * Files that differ between two commits (any two: neither has to contain
 * the other), older on the left. Select a file to open its diff; the title
 * bar button swaps the sides.
 * @param {RepoModel} m
 * @param {import('../domain/entities').Commit[]} commits
 */
async function compareCommits(m, commits) {
  if (commits.length !== 2) return;
  let [left, right] = olderFirst(commits[0], commits[1]);
  // Same committer date (e.g. a rebase or a script): the ancestor goes left.
  if (left.commitTime === right.commitTime && await m.repo.isAncestor(right.hash, left.hash)) [left, right] = [right, left];
  const shortOf = (c) => c.hash.slice(0, 8);
  const qp = vscode.window.createQuickPick();
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true; // stays open while stepping through the diffs
  qp.placeholder = 'Select a file to open its diff';
  qp.buttons = [{ iconPath: new vscode.ThemeIcon('arrow-swap'), tooltip: 'Swap Sides' }];
  let gen = 0;
  const load = async () => {
    const g = ++gen;
    qp.title = `${shortOf(left)} ${left.subject}  ↔  ${shortOf(right)} ${right.subject}`;
    qp.busy = true;
    try {
      const files = await m.repo.changedFiles(left.hash, right.hash);
      if (g !== gen) return;
      qp.items = [
        sep(`${files.length} file${files.length === 1 ? '' : 's'} changed`),
        ...files.map((f) => ({
          label: `${STATUS_LETTER[f.type] || 'M'}  ${path.basename(f.path)}`,
          description: f.oldPath ? `${f.oldPath} → ${f.path}` : path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path),
          file: f,
        })),
      ];
    } catch (e) {
      if (g === gen) qp.items = [{ label: `$(error) ${String(e.message).split('\n')[0]}` }];
    } finally {
      if (g === gen) qp.busy = false;
    }
  };
  qp.onDidTriggerButton(() => {
    [left, right] = [right, left];
    load();
  });
  qp.onDidAccept(() => {
    const sel = /** @type {any} */ (qp.selectedItems[0]);
    if (sel && sel.file) openCommitDiff(m, sel.file, right.hash, left.hash, true);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  await load();
}

/** @param {RepoModel} m @param {Branch} b */
async function updateBranch(m, b) {
  if (!b.upstream) {
    vscode.window.showWarningMessage(`${b.name} has no upstream branch.`);
    return;
  }
  const slash = b.upstream.indexOf('/');
  await m.run(`Update ${b.name}`, () => m.repo.fetchInto(b.upstream.slice(0, slash), b.upstream.slice(slash + 1), b.name),
  { success: `${b.name} updated` });
}

/**
 * "Drop Local and Take origin/x": instead of a pull that conflicts, the local
 * branch is deleted and checked out again from its upstream, fetched first.
 * Its commits not on the upstream are listed and dropped after confirmation.
 * Uncommitted changes go along (stash, checkout, unstash; left in the stash
 * when they do not apply). `abortState`: a pull stopped on conflicts, whose
 * merge / rebase is aborted first.
 * @param {RepoModel} m @param {string} name @param {string} ref
 * @param {string|null} [abortState]
 */
async function takeRemote(m, name, ref, abortState = null) {
  const slash = ref.indexOf('/');
  if (!await m.run(`Fetch ${ref}`, () => m.repo.fetchBranch(ref.slice(0, slash), ref.slice(slash + 1)))) return;
  const lost = await m.repo.commitsBetween(ref, name);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const op = abortState === 'rebasing' ? 'rebase' : 'merge';
  const detail = [
    `${name} is deleted and checked out again from ${ref}.`,
    abortState ? `The ${op} of the pull is aborted first: its conflicts are dropped.` : '',
    lost.length
      ? `${plural(lost.length, 'local commit')} not on ${ref} will be dropped (git's reflog keeps them for a while):\n${
        lost.slice(0, 8).map((c) => `  ${c.hash.slice(0, 8)} ${c.subject}`).join('\n')}${lost.length > 8 ? '\n  …' : ''}`
      : `No commit is lost: ${ref} has all of ${name}.`,
    'Uncommitted changes are kept: stashed, then put back on the new branch (left in the stash if they do not apply).',
  ].filter(Boolean).join('\n\n');
  const button = `Take ${ref}`;
  const ok = await vscode.window.showWarningMessage(
    `${abortState ? `Abort the ${op} and take` : 'Drop local'} ${name}${abortState ? ` from ${ref}` : ` and take ${ref}`}?`,
    { modal: true, detail }, button);
  if (ok !== button) return;
  let stashed = false;
  let restored = true;
  const done = await m.run(`Take ${ref}`, async () => {
    if (abortState) await m.repo.abortOperation(abortState);
    if ((await m.repo.status()).changes.length) {
      await m.repo.stash({ message: `Uncommitted changes before taking ${ref}`, includeUntracked: true });
      stashed = true;
    }
    try {
      await m.repo.checkoutFrom(name, ref);
    } finally {
      if (stashed) {
        try {
          await m.repo.stashPop();
        } catch {
          restored = false;
        }
      }
    }
  });
  await m.refreshAll();
  if (!done) return;
  if (restored) {
    vscode.window.setStatusBarMessage(`$(check) ${name} taken from ${ref}${stashed ? ' (local changes restored)' : ''}`, 4000);
  } else {
    vscode.window.showWarningMessage(`${name} was taken from ${ref}, but your uncommitted changes did not apply cleanly on it: they are kept in the stash (stash@{0}), maybe partly applied. Resolve the conflicts, then drop that stash.`);
  }
}

/** "Drop Local and Take <upstream>" of a local branch diverged from its upstream. @param {RepoModel} m @param {Branch} b */
async function takeUpstream(m, b) {
  if (!divergedFromUpstream(b)) return;
  if (m.status.state !== 'normal') {
    vscode.window.showWarningMessage('Finish or abort the merge / rebase in progress first.');
    return;
  }
  return takeRemote(m, b.name, b.upstream);
}

/** @param {RepoModel} m @param {Branch} b */
async function branchActions(m, b) {
  const cur = currentLabel(m);
  const q = (s) => `'${s.length > 32 ? `${s.slice(0, 30)}…` : s}'`;
  /** @type {{label: string, id: string}[]} */
  const items = [];
  if (!b.current) items.push({ label: '$(log-in) Checkout', id: 'checkout' });
  items.push({ label: `$(add) New Branch from ${q(b.name)}…`, id: 'new' });
  if (!b.current && !b.remote) items.push({ label: `$(git-pull-request) Checkout and Rebase onto ${q(cur)}`, id: 'checkoutRebase' });
  if (!b.current) items.push({ label: `$(compare-changes) Compare with ${q(cur)}`, id: 'compare' });
  items.push({ label: '$(history) Show in Log', id: 'log' });
  if (!b.current) {
    items.push({ label: `$(git-pull-request) Rebase ${q(cur)} onto ${q(b.name)}`, id: 'rebase' });
    items.push({ label: `$(git-merge) Merge ${q(b.name)} into ${q(cur)}…`, id: 'mergeDialog' });
    items.push({ label: `$(git-merge) Quick Merge ${q(b.name)} into ${q(cur)}`, description: 'default options', id: 'merge' });
  }
  if (!b.current) items.push({ label: '$(folder-library) Checkout in New Worktree…', id: 'worktree' });
  if (b.current) items.push({ label: '$(arrow-up) Push…', id: 'push' });
  if (!b.current && !b.remote && b.upstream) items.push({ label: `$(arrow-down) Update from ${b.upstream}`, id: 'update' });
  if (divergedFromUpstream(b)) {
    items.push({ label: `$(cloud-download) Drop Local and Take ${q(b.upstream)}…`, description: `↑${b.ahead} ↓${b.behind}: instead of a pull that may conflict`, id: 'takeUpstream' });
  }
  if (!b.remote) items.push({ label: '$(edit) Rename…', id: 'rename' });
  items.push({ label: '$(copy) Copy Branch Name', id: 'copy' });
  if (!b.current) items.push({ label: '$(trash) Delete', id: 'delete' });
  const pick = await vscode.window.showQuickPick(items, { title: b.name });
  if (!pick) return;
  return runBranchAction(m, b, pick.id);
}

/** @param {RepoModel} m @param {Branch} b */
async function runBranchAction(m, b, id) {
  switch (id) {
    case 'checkout': return checkoutBranch(m, b);
    case 'new': return newBranch(m, b.name);
    case 'checkoutRebase': return checkoutAndRebase(m, b);
    case 'compare': return compareWithCurrent(m, b.name);
    case 'log':
      m.setLogFilter({ branch: b.name, path: null });
      return vscode.commands.executeCommand('gitTools.log.focus');
    case 'rebase': return rebaseOnto(m, b.name);
    case 'merge': return mergeIntoCurrent(m, b.name);
    case 'mergeDialog': return mergeDialog(m, b.name, b.name.replace(/^refs\/tags\//, ''));
    case 'worktree': return newWorktree(m, b);
    case 'push': return push(m);
    case 'update': return updateBranch(m, b);
    case 'takeUpstream': return takeUpstream(m, b);
    case 'rename': return renameBranch(m, b);
    case 'copy':
      await vscode.env.clipboard.writeText(b.name);
      return vscode.window.setStatusBarMessage(`Copied ${b.name}`, 3000);
    case 'delete': return deleteBranch(m, b);
  }
}

/** Android Studio style branches popup. @param {RepoModel} m */
async function branchesPopup(m) {
  const qp = vscode.window.createQuickPick();
  qp.title = `Git Branches · ${m.name}`;
  qp.placeholder = 'Search for branches and actions';
  qp.matchOnDescription = true;
  const sorted = (list) => [...list].sort((a, b) =>
    (b.current - a.current) || (fav(b) - fav(a)) || a.name.localeCompare(b.name));
  const fav = (b) => (/(^|\/)(main|master|develop)$/.test(b.name) ? 1 : 0);
  const branchItem = (b) => {
    const elsewhere = !b.remote && !b.current ? worktreeOfBranch(m.worktrees, b.name) : null;
    return {
      label: `${b.current ? '$(tag)' : fav(b) ? '$(star-full)' : '$(git-branch)'} ${b.name}`,
      description: [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : '', b.upstream && !b.remote ? b.upstream : '',
        elsewhere ? `checked out in ${path.basename(elsewhere.path)}` : '']
        .filter(Boolean).join(' '),
      branch: b,
    };
  };
  qp.items = [
    { label: '$(arrow-down) Update Project…', id: 'update' },
    { label: '$(check) Commit…', id: 'commit' },
    { label: '$(arrow-up) Push…', id: 'push' },
    sep(''),
    { label: '$(add) New Branch…', id: 'new' },
    { label: '$(tag) Checkout Tag or Revision…', id: 'revision' },
    sep('Local'),
    ...sorted(m.branches.filter((b) => !b.remote)).map(branchItem),
    sep('Remote'),
    ...sorted(m.branches.filter((b) => b.remote)).map(branchItem),
  ];
  qp.onDidAccept(async () => {
    const sel = /** @type {any} */ (qp.selectedItems[0]);
    qp.hide();
    if (!sel) return;
    if (sel.branch) return branchActions(m, sel.branch);
    switch (sel.id) {
      case 'update': return update(m);
      case 'commit': return vscode.commands.executeCommand('gitTools.focusCommit');
      case 'push': return push(m);
      case 'new': return newBranch(m);
      case 'revision': return checkoutRevision(m);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/** @param {RepoModel} m */
async function checkoutRevision(m) {
  const items = [
    ...m.tags.map((t) => ({ label: `$(tag) ${t.name}`, ref: `refs/tags/${t.name}` })),
  ];
  const qp = vscode.window.createQuickPick();
  qp.title = 'Checkout Tag or Revision';
  qp.placeholder = 'Type a tag, branch or commit hash';
  qp.items = items;
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
  if (!(await m.repo.refExists(`${ref}^{commit}`))) {
    vscode.window.showErrorMessage(`Unknown revision: ${ref}`);
    return;
  }
  await smartCheckout(m, `Checkout ${ref}`, () => m.repo.checkout(ref));
}

// ---------------------------------------------------------------- remote

/** Push dialog: shows outgoing commits, target branch, force option. @param {RepoModel} m */
async function push(m) {
  const branch = m.status.branch;
  if (!branch) {
    vscode.window.showWarningMessage('Cannot push from a detached HEAD. Checkout a branch first.');
    return;
  }
  if (!m.remotes.length) {
    vscode.window.showWarningMessage('No remotes configured.', 'Manage Remotes…')
      .then((r) => { if (r) manageRemotes(m); });
    return;
  }
  let remote = m.defaultRemote();
  const up = m.status.upstream;
  // An upstream with another name (e.g. a branch created from origin/develop that still
  // tracks it) would push straight into that branch, so always target the local name.
  const upName = up && (up.startsWith(`${remote}/`) ? up.slice(remote.length + 1) : up.slice(up.indexOf('/') + 1));
  const mismatchedUp = up && upName !== branch ? up : null;
  let target = branch;

  for (;;) {
    const remoteRef = `refs/remotes/${remote}/${target}`;
    const exists = await m.repo.refExists(remoteRef);
    const commits = await m.repo.outgoing('HEAD', remote, exists ? remoteRef : null);
    const dest = `${remote}/${target}${exists ? '' : ' (new)'}`;
    const items = [
      ...(mismatchedUp ? [sep(`⚠ ${branch} tracks ${mismatchedUp}; pushing to ${remote}/${branch} fixes the upstream`)] : []),
      { label: `$(arrow-up) Push ${commits.length} commit(s) to ${dest}`, id: 'push' },
      { label: '$(warning) Force Push (--force-with-lease)', id: 'force', description: 'overwrites remote history if unchanged since last fetch' },
      { label: '$(tag) Push with tags', id: 'tags' },
      { label: '$(edit) Change remote or target branch…', id: 'target' },
      sep(commits.length ? 'Commits to push' : 'Nothing to push'),
      ...commits.map((c) => ({ label: `$(git-commit) ${c.subject}`, description: `${c.hash.slice(0, 8)} · ${c.author}`, commit: c })),
    ];
    const pick = /** @type {any} */ (await vscode.window.showQuickPick(items, { title: `Push ${branch} → ${dest}` }));
    if (!pick) return;
    if (pick.commit) continue;
    if (pick.id === 'target') {
      const r = m.remotes.length > 1
        ? await vscode.window.showQuickPick(m.remotes.map((x) => ({ label: x.name, description: x.url })), { title: 'Remote' })
        : { label: remote };
      if (!r) continue;
      const t = await vscode.window.showInputBox({ title: 'Target branch on remote', value: target, validateInput: (v) => validateRefName(v) });
      if (!t) continue;
      remote = r.label;
      target = t.trim();
      continue;
    }
    if (target !== branch) {
      const ok = await vscode.window.showWarningMessage(`Push ${branch} into ${remote}/${target}?`,
        { modal: true, detail: `The remote branch has a different name: this updates ${target} directly instead of publishing ${remote}/${branch}.` },
        `Push to ${target}`);
      if (!ok) continue;
    }
    if (pick.id === 'force') {
      const ok = await vscode.window.showWarningMessage(`Force push ${branch} to ${remote}/${target}?`, { modal: true }, 'Force Push');
      if (!ok) continue;
    }
    const o = {
      remote, branch, target,
      force: pick.id === 'force',
      tags: pick.id === 'tags',
      setUpstream: !up || (!!mismatchedUp && target === branch),
    };
    await m.run(pick.id === 'force' ? 'Force push' : 'Push', () => m.repo.push(o),
      { success: `Pushed to ${remote}/${target}` });
    return;
  }
}

/** Update Project / Pull. @param {RepoModel} m */
async function update(m, context) {
  if (!m.status.branch) {
    vscode.window.showWarningMessage('Cannot update a detached HEAD. Checkout a branch first.');
    return;
  }
  if (!m.remotes.length) {
    vscode.window.showWarningMessage('No remotes configured.');
    return;
  }
  let remote = m.defaultRemote();
  const up = m.status.upstream;
  let branch = up && up.startsWith(`${remote}/`) ? up.slice(remote.length + 1) : null;
  if (!branch) {
    const candidates = m.branches.filter((b) => b.remote);
    const pick = await vscode.window.showQuickPick(
      candidates.map((b) => ({ label: b.name })), { title: 'No upstream branch: choose the remote branch to pull' });
    if (!pick) return;
    remote = pick.label.slice(0, pick.label.indexOf('/'));
    branch = pick.label.slice(pick.label.indexOf('/') + 1);
  }
  const last = context ? context.globalState.get('gitTools.pullMode', 'merge') : 'merge';
  const modes = [
    { label: '$(git-merge) Merge', description: 'Merge incoming changes into the current branch', id: 'merge' },
    { label: '$(git-pull-request) Rebase', description: 'Rebase the current branch on top of incoming changes', id: 'rebase' },
    { label: '$(arrow-right) Fast-forward only', description: 'Fail if the update cannot be fast-forwarded', id: 'ff' },
  ].sort((a, b) => (b.id === last) - (a.id === last));
  const mode = /** @type {any} */ (await vscode.window.showQuickPick(modes, { title: `Update ${m.status.branch} from ${remote}/${branch}` }));
  if (!mode) return;
  if (context) context.globalState.update('gitTools.pullMode', mode.id);
  const withSubmodules = m.submodules.length > 0 &&
    vscode.workspace.getConfiguration('gitTools').get('submodules.updateOnPull', true);
  await m.run(`Update ${m.status.branch}`, async () => {
    await m.repo.pull(remote, branch, mode.id);
    if (withSubmodules) await m.repo.updateSubmodules();
  }, { success: `Updated from ${remote}/${branch}${withSubmodules ? ' (submodules updated)' : ''}` });
  warnConflicts(m);
}

/** @param {RepoModel} m */
async function fetch(m) {
  await m.run('Fetch', () => m.repo.fetchAll(), { success: 'Fetched all remotes' });
}

/** @param {RepoModel} m */
async function manageRemotes(m) {
  const pick = /** @type {any} */ (await vscode.window.showQuickPick([
    { label: '$(add) Add Remote…', id: 'add' },
    sep('Remotes'),
    ...m.remotes.map((r) => ({ label: `$(cloud) ${r.name}`, description: r.url, remote: r })),
  ], { title: 'Git Remotes' }));
  if (!pick) return;
  if (pick.id === 'add') {
    const name = await vscode.window.showInputBox({ title: 'Remote name', value: m.remotes.length ? '' : 'origin', validateInput: (v) => validateRefName(v, m.remotes.map((r) => r.name)) });
    if (!name) return;
    const url = await vscode.window.showInputBox({ title: `URL of ${name}`, placeHolder: 'https://github.com/user/repo.git' });
    if (!url) return;
    await m.run('Add remote', () => m.repo.addRemote(name.trim(), url.trim()));
    return;
  }
  const action = await vscode.window.showQuickPick(['Edit URL…', 'Remove'], { title: pick.remote.name });
  if (action === 'Edit URL…') {
    const url = await vscode.window.showInputBox({ title: `URL of ${pick.remote.name}`, value: pick.remote.url });
    if (url) await m.run('Edit remote', () => m.repo.setRemoteUrl(pick.remote.name, url.trim()));
  } else if (action === 'Remove') {
    const ok = await vscode.window.showWarningMessage(`Remove remote ${pick.remote.name}?`, { modal: true }, 'Remove');
    if (ok) await m.run('Remove remote', () => m.repo.removeRemote(pick.remote.name));
  }
}

// ---------------------------------------------------------------- stash

/** @param {RepoModel} m */
async function stash(m) {
  if (!m.status.changes.length) {
    vscode.window.showInformationMessage('There are no local changes to stash.');
    return;
  }
  const message = await vscode.window.showInputBox({ title: 'Stash Changes', prompt: 'Message (optional)' });
  if (message === undefined) return;
  const opts = await vscode.window.showQuickPick([
    { label: 'Include unversioned files', picked: false, id: 'u' },
    { label: 'Keep index', picked: false, id: 'k' },
  ], { title: 'Stash options', canPickMany: true });
  if (!opts) return;
  const o = {
    message: message.trim(),
    includeUntracked: opts.some((x) => x.id === 'u'),
    keepIndex: opts.some((x) => x.id === 'k'),
  };
  await m.run('Stash changes', () => m.repo.stash(o), { success: 'Local changes stashed' });
}

async function stashApply(m, s, pop) {
  await m.run(`${pop ? 'Pop' : 'Apply'} ${s.ref}`, () => m.repo.stashApply(s.ref, pop),
    { success: pop ? 'Stash popped' : 'Stash applied' });
  warnConflicts(m);
}

async function stashDrop(m, s) {
  const ok = await vscode.window.showWarningMessage(`Drop ${s.ref} "${s.message}"?`, { modal: true }, 'Drop');
  if (ok) await m.run(`Drop ${s.ref}`, () => m.repo.stashDrop(s.ref));
}

async function stashBranch(m, s) {
  const name = await vscode.window.showInputBox({
    title: 'Unstash as Branch', prompt: 'New branch name',
    validateInput: (v) => validateRefName(v, m.branches.filter((b) => !b.remote).map((b) => b.name)),
  });
  if (name) await m.run('Unstash as branch', () => m.repo.stashBranch(s.ref, name.trim()));
}

async function stashShowFiles(m, s) {
  const files = await m.repo.stashFiles(s);
  const pick = /** @type {any} */ (await vscode.window.showQuickPick(
    files.map((f) => ({ label: `$(diff) ${path.basename(f.path)}`, description: `${f.type} · ${f.path}`, file: f })),
    { title: `${s.ref}: ${s.message}`, matchOnDescription: true }));
  if (!pick) return;
  const f = pick.file;
  if (f.type === 'untracked') await openCommitDiff(m, { ...f, type: 'added' }, `${s.hash}^3`, null, false);
  else await openCommitDiff(m, f, s.hash, `${s.hash}^1`, false);
}

// ---------------------------------------------------------------- conflicts

/** @param {RepoModel} m */
async function resolveConflicts(m, openMergeTool) {
  const conflicts = m.status.changes.filter((c) => c.type === 'conflicted');
  if (!conflicts.length) {
    vscode.window.showInformationMessage('No conflicts.');
    return;
  }
  const side = (ch) => ({ D: 'deleted', A: 'added' }[ch] || 'modified');
  const yours = m.status.state === 'rebasing' ? 'upstream' : 'yours';
  const theirs = m.status.state === 'rebasing' ? 'your commit' : 'theirs';
  // Conflicts of a pull: one more way out, the remote branch as it is.
  const pull = await m.repo.pullInProgress().catch(() => null);
  const pick = /** @type {any} */ (await vscode.window.showQuickPick([
    ...conflicts.map((c) => {
      const code = c.conflictCode || 'UU';
      return { label: `$(warning) ${c.path}`, description: `${yours}: ${side(code[0])} · ${theirs}: ${side(code[1])}`, change: c };
    }),
    ...(pull ? [
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(cloud-download) Abort and Take ${pull.upstream}…`, description: `drop the local commits of ${pull.branch}, keep uncommitted changes`, take: pull },
    ] : []),
  ], { title: `Conflicts (${conflicts.length})` }));
  if (!pick) return;
  if (pick.take) return takeRemote(m, pick.take.branch, pick.take.upstream, m.status.state);
  const c = pick.change;
  const canMerge = !(c.conflictCode || '').includes('D');
  const action = /** @type {any} */ (await vscode.window.showQuickPick([
    ...(canMerge ? [{ label: '$(git-merge) Merge…', description: '3-way merge tool', id: 'merge' }] : []),
    { label: `$(arrow-left) Accept ${yours[0].toUpperCase()}${yours.slice(1)}`, id: 'ours' },
    { label: `$(arrow-right) Accept ${theirs[0].toUpperCase()}${theirs.slice(1)}`, id: 'theirs' },
    ...(canMerge ? [{ label: '$(go-to-file) Open in Editor', description: 'resolve markers manually, then Mark as Resolved', id: 'open' }] : []),
    { label: '$(check) Mark as Resolved', id: 'resolved' },
  ], { title: c.path }));
  if (!action) return;
  switch (action.id) {
    case 'merge': return openMergeTool(m, c);
    case 'ours':
    case 'theirs':
      return m.run(`Accept ${action.id}`, () => m.repo.acceptSide(c, action.id === 'ours'), { success: `${c.path} resolved` });
    case 'open':
      return vscode.window.showTextDocument(vscode.Uri.file(path.join(m.root, c.path)));
    case 'resolved': {
      if (/^<{7}( |$)/m.test(m.repo.workingText(c.path))) {
        const ok = await vscode.window.showWarningMessage('The file still contains conflict markers. Mark as resolved anyway?', { modal: true }, 'Mark Resolved');
        if (!ok) return;
      }
      return m.run('Mark resolved', () => m.repo.markResolved(c.path), { success: `${c.path} resolved` });
    }
  }
}

// ---------------------------------------------------------------- commits

const RESET_MODES = [
  { label: 'Soft', id: 'soft', detail: 'Files won\'t change, differences will be staged for commit.' },
  { label: 'Mixed', id: 'mixed', detail: 'Files won\'t change, differences won\'t be staged.' },
  { label: 'Hard', id: 'hard', detail: 'Files will be reverted to the selected commit. Local changes will be lost!' },
  { label: 'Keep', id: 'keep', detail: 'Files will be reverted to the selected commit, local changes are kept.' },
];

/** Handles an action chosen in the Log context menu. @param {RepoModel} m */
async function commitAction(m, action, commits) {
  const c = commits[0];
  const short = c.hash.slice(0, 8);
  switch (action) {
    case 'copy':
      await vscode.env.clipboard.writeText(commits.map((x) => x.hash).join(' '));
      return vscode.window.setStatusBarMessage('Revision number copied', 3000);
    case 'cherryPick':
      await m.run(commits.length > 1 ? `Cherry-pick ${commits.length} commits` : `Cherry-pick ${short}`, async () => {
        for (const x of [...commits].reverse()) {
          await m.repo.cherryPick(x);
        }
      }, { success: 'Cherry-picked' });
      return warnConflicts(m);
    case 'checkout':
      return smartCheckout(m, `Checkout ${short}`, () => m.repo.checkout(c.hash));
    case 'compare':
      return compareWithCurrent(m, c.hash);
    case 'compareCommits':
      return compareCommits(m, commits);
    case 'merge':
      return mergeDialog(m, c.hash, short);
    case 'reset': {
      const mode = /** @type {any} */ (await vscode.window.showQuickPick(RESET_MODES, {
        title: `Reset ${currentLabel(m)} to ${short}`, placeHolder: 'Choose how the working tree and index are changed',
      }));
      if (!mode) return;
      if (mode.id === 'hard') {
        const ok = await vscode.window.showWarningMessage(`Hard reset ${currentLabel(m)} to ${short}?`, { modal: true, detail: 'All local changes will be lost.' }, 'Reset');
        if (!ok) return;
      }
      return m.run(`Reset to ${short}`, () => m.repo.reset(c.hash, mode.id), { success: `Reset to ${short} (${mode.id})` });
    }
    case 'revert':
      await m.run(commits.length > 1 ? `Revert ${commits.length} commits` : `Revert ${short}`, async () => {
        for (const x of commits) {
          await m.repo.revert(x);
        }
      }, { success: 'Reverted' });
      return warnConflicts(m);
    case 'undo': {
      const ok = await vscode.window.showWarningMessage('Undo the last commit?', { modal: true, detail: 'Its changes are kept in the working tree.' }, 'Undo Commit');
      if (ok) await m.run('Undo commit', () => m.repo.undoLastCommit(), { success: 'Commit undone' });
      return;
    }
    case 'reword': { // HEAD; older commits go through the interactive rebase (rebaseView.js)
      const current = await m.repo.lastCommitMessage();
      const msg = await vscode.window.showInputBox({ title: 'Edit Commit Message', value: current, validateInput: (v) => (v.trim() ? null : 'Message cannot be empty') });
      if (!msg || msg.trim() === current) return;
      return m.run('Edit commit message', () => m.repo.commit({ message: msg.trim(), paths: [], amend: true, sign: signChoice(m) }),
        { success: 'Commit message updated' });
    }
    case 'branch':
      return newBranch(m, c.hash, short);
    case 'tag': {
      const name = await vscode.window.showInputBox({ title: `Tag commit ${short}`, prompt: 'Tag name', validateInput: (v) => validateRefName(v, m.tags.map((t) => t.name)) });
      if (!name) return;
      const message = await vscode.window.showInputBox({ title: `Tag ${name}`, prompt: 'Message (optional, creates an annotated tag)' });
      if (message === undefined) return;
      const sign = await askSignTag(m, name.trim(), !!message.trim());
      if (sign === undefined) return;
      return m.run(`Create tag ${name}`, () => m.repo.createTag(name.trim(), c.hash, message.trim(), sign),
        { success: `${sign ? 'Signed tag' : 'Tag'} ${name} created` });
    }
  }
}

/** Rollback dialog for working tree changes. @param {RepoModel} m */
async function rollback(m, changes) {
  const tracked = changes.filter((c) => c.type !== 'untracked' && c.type !== 'conflicted');
  if (!tracked.length) return;
  const picks = await vscode.window.showQuickPick(
    tracked.map((c) => ({ label: path.basename(c.path), description: `${c.type} · ${c.path}`, picked: true, change: c })),
    { title: 'Rollback Changes', canPickMany: true, placeHolder: 'Selected files are reverted to HEAD' });
  if (!picks || !picks.length) return;
  const sel = picks.map((p) => p.change);
  let deleteAdded = false;
  if (sel.some((c) => c.type === 'added')) {
    const r = await vscode.window.showQuickPick(['Keep local copies of added files', 'Delete local copies of added files'], { title: 'Added files' });
    if (!r) return;
    deleteAdded = r.startsWith('Delete');
  }
  await m.run('Rollback', () => m.repo.rollback(sel, !!m.status.head, deleteAdded), { success: `${sel.length} file(s) rolled back` });
}

/** @param {RepoModel} m */
async function deleteUntracked(m, changes) {
  const ok = await vscode.window.showWarningMessage(
    changes.length === 1 ? `Delete ${changes[0].path}?` : `Delete ${changes.length} unversioned files?`, { modal: true }, 'Delete');
  if (!ok) return;
  m.repo.deleteFiles(changes.map((c) => c.path));
  await m.refreshStatus();
}

/**
 * Starts tracking unversioned files (Android Studio "Add to VCS"): they move
 * from "Unversioned Files" to "Changes" and are included in the next commit.
 * @param {RepoModel} m
 */
async function addToVcs(m, changes) {
  const nested = changes.filter((c) => c.nestedRepo);
  if (nested.length) {
    vscode.window.showInformationMessage(
      `${nested.map((c) => c.path).join(', ')} ${nested.length === 1 ? 'is a repository' : 'are repositories'} of ${nested.length === 1 ? 'its' : 'their'} own. Use "Register as Submodule…" instead of adding ${nested.length === 1 ? 'it' : 'them'}.`);
  }
  const files = changes.filter((c) => c.type === 'untracked' && !c.nestedRepo);
  if (!files.length) return;
  for (const c of files) m.excludedTracked.delete(c.path);
  await m.run(files.length === 1 ? `Add ${path.basename(files[0].path)} to Git` : `Add ${files.length} files to Git`,
    () => m.repo.add(files.map((c) => c.path)),
    { success: `${files.length} file(s) added to Git`, refresh: false });
  await m.refreshStatus();
}

/**
 * Stops tracking newly added files without deleting them: they move back to
 * "Unversioned Files".
 * @param {RepoModel} m
 */
async function unversion(m, changes) {
  const files = changes.filter((c) => c.type === 'added');
  if (!files.length) return;
  await m.run(files.length === 1 ? `Unversion ${path.basename(files[0].path)}` : `Unversion ${files.length} files`,
    () => m.repo.untrack(files.map((c) => c.path)),
    { success: `${files.length} file(s) moved to Unversioned Files`, refresh: false });
  await m.refreshStatus();
}

/** @param {RepoModel} m */
async function addToGitignore(m, changes) {
  m.repo.addToGitignore(changes.map((c) => `/${c.path}`));
  await m.refreshStatus();
}

module.exports = {
  validateRefName, warnConflicts, smartCheckout, checkoutBranch, newBranch, renameBranch, deleteBranch, deleteBranches, takeRemote, takeUpstream, mergeIntoCurrent, rebaseOnto,
  checkoutAndRebase, compareWithCurrent, compareCommits, updateBranch, branchActions, runBranchAction, branchesPopup, checkoutRevision,
  push, update, fetch, manageRemotes, stash, stashApply, stashDrop, stashBranch, stashShowFiles, resolveConflicts,
  commitAction, rollback, deleteUntracked, addToGitignore, addToVcs, unversion,
};
