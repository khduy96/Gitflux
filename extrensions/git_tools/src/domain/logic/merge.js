// @ts-check
'use strict';

/**
 * Merge dialog options (Android Studio "Merge…"): which combinations git
 * accepts, the git arguments and what the merge will produce. Pure
 * functions, no git.
 *
 * @typedef {import('../entities').MergeOptions} MergeOptions
 * @typedef {import('../entities').MergePreview} MergePreview
 */

/** @returns {MergeOptions} */
const defaultMergeOptions = () => ({ fastForward: 'default', squash: false, noCommit: false, message: null });

/**
 * Why git would refuse the combination, or null. Squash, --no-ff and
 * --ff-only exclude each other.
 * @param {MergeOptions} o
 */
function validateMergeOptions(o) {
  if (o.squash && o.fastForward === 'never') return 'Squash cannot be combined with No fast-forward.';
  if (o.squash && o.fastForward === 'only') return 'Squash cannot be combined with Fast-forward only.';
  if (o.message !== null && o.message !== undefined && !o.message.trim()) return 'The commit message cannot be empty.';
  return null;
}

/**
 * Applies the dialog rules after `changed` was switched on: the options it
 * excludes are switched off, and squash implies no commit (git behavior).
 * @param {MergeOptions} o
 * @param {'ffOnly'|'noFf'|'squash'|'noCommit'} changed
 * @returns {MergeOptions}
 */
function exclusiveMergeOptions(o, changed) {
  const r = { ...o };
  if (changed === 'squash' && r.squash) r.fastForward = 'default';
  if ((changed === 'ffOnly' || changed === 'noFf') && r.fastForward !== 'default') r.squash = false;
  if (r.squash) r.noCommit = true;
  else if (changed === 'squash') r.noCommit = false; // implied only while squashing
  if (!createsMergeCommit(r, false)) r.message = null;
  return r;
}

/**
 * Whether the merge can end with a merge commit (the commit message option
 * applies): not squash, not --no-commit, not --ff-only, and either --no-ff
 * or a fast-forward is not possible.
 * @param {MergeOptions} o
 * @param {boolean} fastForwardPossible HEAD is an ancestor of the merged revision
 */
function createsMergeCommit(o, fastForwardPossible) {
  if (o.squash || o.noCommit || o.fastForward === 'only') return false;
  return o.fastForward === 'never' || !fastForwardPossible;
}

/**
 * `git merge` arguments for the options (the revision last).
 * @param {string} ref
 * @param {MergeOptions} o
 */
function mergeArgs(ref, o) {
  const args = ['merge'];
  if (o.fastForward === 'only') args.push('--ff-only');
  // A fast-forward cannot stop before committing: "No commit" alone implies --no-ff.
  else if (o.fastForward === 'never' || (o.noCommit && !o.squash)) args.push('--no-ff');
  if (o.squash) args.push('--squash');
  if (o.noCommit && !o.squash) args.push('--no-commit');
  if (o.message && o.message.trim()) args.push('-m', o.message.trim());
  else args.push('--no-edit');
  args.push(ref);
  return args;
}

/**
 * The dialog preview line: "3 commits will be merged · Fast-forward possible".
 * @param {MergePreview} p
 */
function describeMergePreview(p) {
  if (!p.commits) return 'Already up to date: nothing to merge';
  const n = `${p.commits} commit${p.commits === 1 ? '' : 's'} will be merged`;
  return p.fastForward ? `${n} · Fast-forward possible` : n;
}

/**
 * Short summary of the options for a label ("--no-ff, -m").
 * @param {MergeOptions} o
 */
function describeMergeOptions(o) {
  return mergeArgs('', o).slice(1, -1).filter((a, i, all) => a !== '--no-edit' && all[i - 1] !== '-m').join(' ');
}

/**
 * Message git prepared in SQUASH_MSG, for the Commit message box: comment
 * lines dropped, at most `maxLines` lines (the subjects of the squashed
 * commits come first).
 * @param {string} text
 * @param {number} [maxLines]
 */
function squashMessageText(text, maxLines = 30) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('#'));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const kept = lines.slice(0, maxLines);
  if (lines.length > maxLines) kept.push('…');
  return kept.join('\n').trim();
}

module.exports = {
  defaultMergeOptions, validateMergeOptions, exclusiveMergeOptions, createsMergeCommit, mergeArgs, describeMergePreview,
  describeMergeOptions, squashMessageText,
};
