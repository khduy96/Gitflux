// @ts-check
'use strict';

const vscode = require('vscode');
const {
  defaultMergeOptions, validateMergeOptions, exclusiveMergeOptions, createsMergeCommit, describeMergePreview, describeMergeOptions,
  squashMessageText,
} = require('../domain/logic/merge');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').MergeOptions} MergeOptions */

/** Options of the last Merge dialog, for the session (the message is not kept). @type {MergeOptions} */
let lastOptions = defaultMergeOptions();

const OPTION_ITEMS = [
  { id: 'ffOnly', label: 'Fast-forward only', description: '--ff-only: fail unless the branch can fast-forward' },
  { id: 'noFf', label: 'No fast-forward', description: '--no-ff: always create a merge commit' },
  { id: 'squash', label: 'Squash', description: '--squash: one set of staged changes, committed by you (implies no commit)' },
  { id: 'noCommit', label: 'No commit', description: '--no-commit: stop before committing (implies --no-ff)' },
  { id: 'message', label: 'Commit message…', description: '-m: edit the merge commit message' },
];

/** Option ids switched on in `o`. @param {MergeOptions} o */
function pickedIds(o) {
  return new Set([
    ...(o.fastForward === 'only' ? ['ffOnly'] : []),
    ...(o.fastForward === 'never' ? ['noFf'] : []),
    ...(o.squash ? ['squash'] : []),
    ...(o.noCommit ? ['noCommit'] : []),
    ...(o.message !== null ? ['message'] : []),
  ]);
}

/** git's default message for merging `ref`. @param {RepoModel} m */
function defaultMessage(m, ref, label) {
  const into = m.status.branch && !/^(main|master)$/.test(m.status.branch) ? ` into ${m.status.branch}` : '';
  if (ref.startsWith('refs/tags/')) return `Merge tag '${ref.slice(10)}'${into}`;
  if (m.branches.some((b) => b.remote && b.name === ref)) return `Merge remote-tracking branch '${ref}'${into}`;
  if (m.branches.some((b) => !b.remote && b.name === ref)) return `Merge branch '${ref}'${into}`;
  return `Merge commit '${label}'${into}`;
}

/**
 * Android Studio style "Merge…" dialog: options (fast-forward only, no
 * fast-forward, squash, no commit, commit message) with their exclusions
 * applied while ticking, and the preview "N commits will be merged ·
 * Fast-forward possible". The last options are remembered for the session.
 * @param {RepoModel} m
 * @param {string} ref branch, tag (refs/tags/…) or commit hash
 * @param {string} [label] name shown for `ref`
 */
async function mergeDialog(m, ref, label = ref) {
  const cur = m.status.branch || 'HEAD';
  const preview = await m.repo.mergePreview(ref).catch(() => ({ commits: 0, fastForward: false }));
  if (!preview.commits) {
    vscode.window.showInformationMessage(`${cur} already contains ${label}: nothing to merge.`);
    return;
  }
  let o = { ...lastOptions, message: null };
  const qp = vscode.window.createQuickPick();
  qp.canSelectMany = true;
  qp.ignoreFocusOut = true;
  qp.title = `Merge ${label} into ${cur}`;
  let syncing = false;
  const render = () => {
    const merging = createsMergeCommit(o, preview.fastForward);
    const items = OPTION_ITEMS.map((it) => ({
      ...it,
      description: it.id === 'message' && !merging ? 'no merge commit will be created with these options' : it.description,
    }));
    syncing = true;
    qp.items = [{ label: describeMergePreview(preview), kind: vscode.QuickPickItemKind.Separator }, ...items];
    const on = pickedIds(o);
    qp.selectedItems = items.filter((it) => on.has(it.id));
    syncing = false;
    qp.placeholder = `git merge ${describeMergeOptions(o) || '(default options)'} ${label} · press Enter to merge`;
  };
  qp.onDidChangeSelection((sel) => {
    if (syncing) return;
    const now = new Set(sel.map((i) => /** @type {any} */ (i).id));
    const before = pickedIds(o);
    const changed = [...now].find((id) => !before.has(id)) || [...before].find((id) => !now.has(id));
    if (!changed) return;
    // Fast-forward only and No fast-forward are one setting: the last ticked wins.
    let fastForward = o.fastForward;
    if (changed === 'ffOnly') fastForward = now.has('ffOnly') ? 'only' : 'default';
    if (changed === 'noFf') fastForward = now.has('noFf') ? 'never' : 'default';
    /** @type {MergeOptions} */
    let next = {
      fastForward,
      squash: now.has('squash'),
      noCommit: now.has('noCommit'),
      message: now.has('message') ? (o.message ?? '') : null,
    };
    if (changed === 'noCommit' && !next.noCommit && next.squash) next.squash = false; // squash implies no commit
    if (changed !== 'message') next = exclusiveMergeOptions(next, /** @type {any} */ (changed));
    // The message applies only when a merge commit will be created.
    if (next.message !== null && !createsMergeCommit(next, preview.fastForward)) next.message = null;
    o = next;
    render();
  });
  render();
  const accepted = await new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(true);
      qp.hide();
    });
    qp.onDidHide(() => resolve(false));
    qp.show();
  });
  qp.dispose();
  if (!accepted) return;
  if (o.message !== null) {
    const msg = await vscode.window.showInputBox({
      title: `Merge ${label} into ${cur}: commit message`,
      value: defaultMessage(m, ref, label),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'The commit message cannot be empty'),
    });
    if (msg === undefined) return;
    o = { ...o, message: msg };
  }
  const error = validateMergeOptions(o);
  if (error) {
    vscode.window.showWarningMessage(error);
    return;
  }
  lastOptions = { ...o, message: null };
  const ok = await m.run(`Merge ${label} into ${cur}`, () => m.repo.merge(ref, o), {
    success: o.squash ? `Changes of ${label} staged (squash)` : o.noCommit ? `Merge of ${label} stopped before committing` : `Merged ${label}`,
  });
  // Conflicts: the Commit view banner and the warning take over.
  require('./commands').warnConflicts(m);
  if (ok && o.squash) await afterSquash(m, label, preview.commits);
}

/**
 * After `merge --squash`: the changes are staged and nothing is committed.
 * The Commit message box gets git's SQUASH_MSG and the user is told to commit.
 * @param {RepoModel} m
 */
async function afterSquash(m, label, commits) {
  const text = await m.repo.squashMessage();
  if (text && !m.message.trim()) {
    m.message = squashMessageText(text);
    m.fire('message');
  }
  const r = await vscode.window.showInformationMessage(
    `Squash merge of ${label}: the changes of ${commits} commit${commits === 1 ? ' are' : 's are'} in the working tree, nothing was committed. ` +
    'Review the message and commit.', 'Commit…');
  if (r) vscode.commands.executeCommand('gitTools.focusCommit');
}

module.exports = { mergeDialog };
