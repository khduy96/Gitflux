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

module.exports = { divergedFromUpstream };
