// @ts-check
'use strict';

/**
 * A local branch and its upstream both moved on (↑ and ↓): pulling would
 * merge or rebase, and may conflict. Such a branch offers "Drop Local and
 * Take <upstream>".
 * @param {import('../entities').Branch} b
 */
function divergedFromUpstream(b) {
  return !b.remote && !!b.upstream && !b.gone && b.ahead > 0 && b.behind > 0;
}

/**
 * Remote branch of a local branch, for "Rebase / Merge from origin": its
 * upstream, else a remote branch of the same name (origin first); null
 * when there is none.
 * @param {import('../entities').Branch} b
 * @param {import('../entities').Branch[]} branches
 */
function remoteBranchOf(b, branches) {
  if (b.remote) return null;
  if (b.upstream && !b.gone) return b.upstream;
  const same = branches.filter((x) => x.remote && x.name.slice(x.name.indexOf('/') + 1) === b.name);
  const pick = same.find((x) => x.name.startsWith('origin/')) || same[0];
  return pick ? pick.name : null;
}

module.exports = { divergedFromUpstream, remoteBranchOf };
