// @ts-check
'use strict';

/**
 * Worktrees: `git worktree list --porcelain -z`, the default folder of a new
 * worktree and the "branch is checked out elsewhere" error. Pure functions,
 * no git.
 *
 * @typedef {import('../entities').Worktree} Worktree
 */

/** Path comparison key: separators unified, case-insensitive on Windows. */
function samePath(a, b, win = process.platform === 'win32') {
  const norm = (p) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return win ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/**
 * Parses `git worktree list --porcelain -z`: records of NUL terminated
 * attribute lines, separated by an empty one. The first record is the main
 * worktree.
 * @param {string} out
 * @param {string} [currentRoot] marks the worktree at this folder as current
 * @returns {Worktree[]}
 */
function parseWorktrees(out, currentRoot) {
  /** @type {Worktree[]} */
  const list = [];
  /** @type {Worktree|null} */
  let w = null;
  for (const field of out.split('\0')) {
    if (!field) {
      w = null;
      continue;
    }
    const sp = field.indexOf(' ');
    const key = sp < 0 ? field : field.slice(0, sp);
    const value = sp < 0 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      w = {
        path: value, head: null, branch: null, detached: false, bare: false, locked: false, lockReason: '',
        prunable: false, prunableReason: '', main: list.length === 0, current: false,
      };
      list.push(w);
      continue;
    }
    if (!w) continue;
    if (key === 'HEAD') w.head = /^0+$/.test(value) ? null : value;
    else if (key === 'branch') w.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') w.detached = true;
    else if (key === 'bare') w.bare = true;
    else if (key === 'locked') {
      w.locked = true;
      w.lockReason = value;
    } else if (key === 'prunable') {
      w.prunable = true;
      w.prunableReason = value;
    }
  }
  if (currentRoot) for (const x of list) x.current = samePath(x.path, currentRoot);
  return list;
}

/** A branch name as a folder name part: "feature/login" → "feature-login". */
function sanitizeForPath(name) {
  return name.replace(/^refs\/(heads|remotes|tags)\//, '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'worktree';
}

/**
 * Default folder of a new worktree: next to the repository,
 * "../<repo-name>-<branch>".
 * @param {string} root repository folder (forward or back slashes)
 * @param {string} branch
 */
function defaultWorktreePath(root, branch) {
  const r = root.replace(/[\\/]+$/, '');
  const i = Math.max(r.lastIndexOf('/'), r.lastIndexOf('\\'));
  const parent = i < 0 ? '' : r.slice(0, i + 1);
  const name = i < 0 ? r : r.slice(i + 1);
  return `${parent}${name}-${sanitizeForPath(branch)}`;
}

/**
 * The worktree (other than the current one) that has `branch` checked out.
 * @param {Worktree[]} worktrees
 * @param {string} branch local branch name
 */
function worktreeOfBranch(worktrees, branch) {
  return worktrees.find((w) => !w.current && w.branch === branch) || null;
}

/**
 * Folder named by git's refusal to check out a branch that another worktree
 * uses ("'x' is already used by worktree at '<path>'", older versions:
 * "'x' is already checked out at '<path>'"), or null.
 * @param {string} message
 */
function checkedOutElsewhere(message) {
  // Up to the last quote of the line: the path itself may contain quotes ("O'Neil").
  const m = /is already (?:used by worktree|checked out) at '(.+)'\r?$/m.exec(message);
  return m ? m[1] : null;
}

module.exports = { parseWorktrees, sanitizeForPath, defaultWorktreePath, worktreeOfBranch, checkedOutElsewhere, samePath };
