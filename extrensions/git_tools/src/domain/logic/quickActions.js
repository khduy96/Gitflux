// @ts-check
'use strict';

/**
 * Quick actions: recent branches, WIP commits, undo of the last action,
 * copy formats of commits, branch name prefixes, line history and branch
 * cleanup. Pure functions, no git.
 *
 * @typedef {import('../entities').ReflogEntry} ReflogEntry
 * @typedef {import('../entities').Branch} Branch
 * @typedef {import('../entities').Commit} Commit
 */

/**
 * Branches of a "checkout: moving from <from> to <to>" reflog message
 * (git checkout and git switch), null for any other message.
 * @param {string} message
 * @returns {{from: string, to: string}|null}
 */
function parseCheckoutMove(message) {
  const m = /^moving from (\S+) to (\S+)$/.exec(message.trim());
  return m ? { from: m[1], to: m[2] } : null;
}

/**
 * Local branches checked out most recently first, from the HEAD reflog
 * (newest first): the current branch and names that are not local
 * branches (detached commits, deleted branches) are left out.
 * @param {ReflogEntry[]} entries
 * @param {string[]} localNames
 * @param {string|null} current
 * @param {number} [limit]
 * @returns {string[]}
 */
function recentBranches(entries, localNames, current, limit = 20) {
  const local = new Set(localNames);
  /** @type {string[]} */
  const out = [];
  for (const e of entries) {
    if (e.missing || e.action !== 'checkout') continue;
    const move = parseCheckoutMove(e.message);
    if (!move) continue;
    for (const name of [move.to, move.from]) {
      if (name === current || !local.has(name) || out.includes(name)) continue;
      out.push(name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Subject of a WIP commit made by Git Tools, or by hand ("wip", "WIP: …", oh-my-zsh "--wip--"). */
const isWipSubject = (subject) => /^(wip\b|--wip--)/i.test(subject.trim());

/**
 * Message of a WIP commit.
 * @param {string|null} branch
 * @param {Date} [date]
 */
function wipMessage(branch, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `WIP${branch ? ` on ${branch}` : ''} (${when}) [skip ci]`;
}

/**
 * How "Undo Last Action" undoes the newest HEAD reflog entry.
 *   soft:     the branch moves back, the changes stay in the working tree (commit, amend);
 *   keep:     the branch moves back, the working tree follows, local changes are kept (merge, pull, rebase, reset…);
 *   checkout: the previous branch / commit is checked out again.
 * @typedef {{kind: 'soft'|'keep'|'checkout', action: string, message: string, target: string,
 *   undone: number, checkout?: string}} UndoPlan
 *   target: the commit HEAD goes back to; undone: reflog entries the action spans;
 *   checkout: the branch (or commit) to check out again.
 * @typedef {{unsupported: string}} UndoRefusal
 */

/**
 * Plan of "Undo Last Action" from the HEAD reflog (newest first).
 * @param {ReflogEntry[]} entries
 * @returns {UndoPlan|UndoRefusal}
 */
function undoPlan(entries) {
  const last = entries[0];
  if (!last || last.missing) return { unsupported: 'Nothing to undo: the reflog is empty.' };
  const action = last.action;
  const plan = (kind, from, extra = {}) => {
    const before = entries[from + 1];
    if (!before || !before.hash) return { unsupported: `Cannot undo "${action}": the reflog does not go back further.` };
    return { kind, action, message: last.message, target: before.hash, undone: from + 1, ...extra };
  };
  if (action === 'commit (initial)' || /^clone\b/.test(action) || /^branch\b/.test(action)) {
    return { unsupported: `"${action}" cannot be undone from here.` };
  }
  if (action === 'commit' || action === 'commit (amend)') return plan('soft', 0);
  if (action === 'checkout') {
    const move = parseCheckoutMove(last.message);
    if (!move) return { unsupported: 'Cannot tell which branch was checked out before.' };
    return plan('checkout', 0, { checkout: move.from });
  }
  // A rebase (or pull --rebase) is a run of entries: back to before its start.
  const finish = /^(.*) \(finish\)$/.exec(action);
  if (finish) {
    const start = entries.findIndex((e) => e.action === `${finish[1]} (start)`);
    if (start < 0) return { unsupported: `Cannot find where the ${finish[1]} started in the reflog.` };
    return plan('keep', start);
  }
  if (/\((start|pick|continue|reword|edit|squash|fixup)\)$/.test(action)) {
    return { unsupported: 'A rebase is in progress: abort it instead.' };
  }
  if (/^(commit \(merge\)|commit \(cherry-pick\)|merge\b|pull\b|cherry-pick\b|revert\b|reset\b|am\b|rebase\b)/.test(action)) {
    return plan('keep', 0);
  }
  return { unsupported: `"${action}" cannot be undone from here.` };
}

/** @typedef {'full'|'short'|'subject'|'shortSubject'|'message'} CopyKind */

/**
 * Clipboard text of commits, one per line.
 * @param {CopyKind} kind
 * @param {{hash: string, subject: string}[]} commits
 * @param {Map<string, string>} [bodies] full messages by hash (kind 'message')
 */
function commitCopyText(kind, commits, bodies = new Map()) {
  const line = (c) => {
    switch (kind) {
      case 'short': return c.hash.slice(0, 8);
      case 'subject': return c.subject;
      case 'shortSubject': return `${c.hash.slice(0, 8)} ${c.subject}`;
      case 'message': return bodies.get(c.hash) || c.subject;
      default: return c.hash;
    }
  };
  return commits.map(line).join(kind === 'message' ? '\n\n' : kind === 'full' ? ' ' : '\n');
}

/**
 * Branch names offered while typing a new branch name: the name with each
 * prefix (the last used one first), or as typed when it already has one.
 * @param {string} value
 * @param {string[]} prefixes e.g. ['feature/', 'bugfix/']
 * @param {string|null} [last] last used prefix ('' = none)
 * @returns {{name: string, prefix: string}[]}
 */
function branchNameSuggestions(value, prefixes, last = null) {
  const v = value.trim();
  if (!v) return [];
  const list = [...new Set(prefixes.filter((p) => p && p.trim()).map((p) => (p.endsWith('/') ? p : `${p}/`)))];
  const has = list.find((p) => v.startsWith(p)) || (v.includes('/') ? v.slice(0, v.indexOf('/') + 1) : null);
  if (has !== null) return [{ name: v, prefix: has }];
  const ordered = [...list, ''];
  if (last !== null && ordered.includes(last)) ordered.sort((a, b) => (b === last) - (a === last));
  return ordered.map((p) => ({ name: `${p}${v}`, prefix: p }));
}

/**
 * A commit of `git log -L`: the file path in it and before it (null when the
 * file was created), and the changed lines of the range.
 * @typedef {{hash: string, parents: string[], author: string, time: number, subject: string,
 *   path: string, oldPath: string|null, added: string[], removed: string[]}} LineHistoryEntry
 */

/**
 * Parses `git log -L <range>:<file> --format=<RS>%H<FS>%P<FS>%an<FS>%at<FS>%s`.
 * @param {string} out
 * @param {string} [FS]
 * @param {string} [RS]
 * @returns {LineHistoryEntry[]}
 */
function parseLineLog(out, FS = '\x1f', RS = '\x1e') {
  /** @type {LineHistoryEntry[]} */
  const list = [];
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf('\n');
    const head = (nl < 0 ? rec : rec.slice(0, nl)).split(FS);
    if (head.length < 5 || !/^[0-9a-f]{40,64}$/.test(head[0])) continue;
    const body = nl < 0 ? '' : rec.slice(nl + 1);
    /** @type {LineHistoryEntry} */
    const e = {
      hash: head[0],
      parents: head[1] ? head[1].split(' ') : [],
      author: head[2],
      time: (parseInt(head[3], 10) || 0) * 1000,
      subject: head.slice(4).join(FS),
      path: '',
      oldPath: null,
      added: [],
      removed: [],
    };
    let inHunk = false;
    for (const raw of body.split('\n')) {
      const l = raw.replace(/\r$/, '');
      if (l.startsWith('diff --git ')) inHunk = false;
      else if (!inHunk && l.startsWith('--- ')) e.oldPath = l === '--- /dev/null' ? null : l.slice(4).replace(/^a\//, '');
      else if (!inHunk && l.startsWith('+++ ')) e.path = l.slice(4).replace(/^b\//, '');
      else if (l.startsWith('@@')) inHunk = true;
      else if (inHunk && l.startsWith('+')) e.added.push(l.slice(1));
      else if (inHunk && l.startsWith('-')) e.removed.push(l.slice(1));
    }
    list.push(e);
  }
  return list;
}

/**
 * Local branches "Clean Merged Branches" offers to delete: merged into
 * `base`, or whose upstream is gone (deleted on the remote, e.g. after a
 * squash merge). The current branch, `base` itself and the branches checked
 * out in other worktrees are kept.
 * @param {Branch[]} branches
 * @param {Set<string>} merged local branch names merged into base
 * @param {string} base
 * @param {Set<string>} [checkedOut] branches checked out in other worktrees
 * @returns {{branch: Branch, merged: boolean, gone: boolean}[]}
 */
function cleanupCandidates(branches, merged, base, checkedOut = new Set()) {
  return branches
    .filter((b) => !b.remote && !b.current && b.name !== base && !checkedOut.has(b.name))
    .map((b) => ({ branch: b, merged: merged.has(b.name), gone: !!b.gone }))
    .filter((x) => x.merged || x.gone)
    .sort((a, b) => a.branch.name.localeCompare(b.branch.name));
}

module.exports = {
  parseCheckoutMove, recentBranches, isWipSubject, wipMessage, undoPlan, commitCopyText, branchNameSuggestions,
  parseLineLog, cleanupCandidates,
};
