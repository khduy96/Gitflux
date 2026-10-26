// @ts-check
'use strict';

/** @typedef {import('../entities').Branch} Branch */
/** @typedef {import('../entities').RepoState} RepoState */

/**
 * Branches offered when leaving the current branch before deleting it, and
 * the one Enter takes right away. `local` starts with that default branch.
 * @typedef {{local: Branch[], remote: Branch[], defaultName: string|null}} LeaveChoices
 */

/**
 * What is in progress, for "Finish or abort the <op> in progress first".
 * @type {Partial<Record<RepoState, string>>}
 */
const OPERATION = {
  merging: 'merge', rebasing: 'rebase', cherryPicking: 'cherry-pick', reverting: 'revert', applyingMailbox: 'patch application (git am)',
};

/**
 * Local and remote branches, the local one named `defaultName` first.
 * @param {Branch[]} branches
 * @param {string|null} defaultName
 * @returns {LeaveChoices}
 */
function grouped(branches, defaultName) {
  const local = branches.filter((b) => !b.remote);
  const first = local.filter((b) => b.name === defaultName);
  return {
    local: [...first, ...local.filter((b) => b.name !== defaultName)],
    remote: branches.filter((b) => b.remote),
    defaultName,
  };
}

/**
 * Local main, else local master, else null; never `exclude`.
 * @param {Branch[]} branches
 * @param {string|null} exclude
 */
function defaultBranch(branches, exclude) {
  for (const name of ['main', 'master']) {
    if (name !== exclude && branches.some((b) => !b.remote && b.name === name)) return name;
  }
  return null;
}

/**
 * "Checkout Another Branch and Delete": every branch but the one being
 * deleted and the remote branches of the same name (checking one out would
 * land on that local branch again). Default: main, else master.
 * @param {Branch[]} branches
 * @param {string} deleting
 * @returns {LeaveChoices}
 */
function checkoutTargets(branches, deleting) {
  const kept = branches.filter((b) => b.remote
    ? b.name.slice(b.name.indexOf('/') + 1) !== deleting
    : b.name !== deleting);
  return grouped(kept, defaultBranch(kept, deleting));
}

/**
 * "Create New Branch and Delete": start points, the branch being deleted
 * included. Default: main, else master.
 * @param {Branch[]} branches
 * @returns {LeaveChoices}
 */
function startPoints(branches) {
  return grouped(branches, defaultBranch(branches, null));
}

/**
 * The operation in progress, '' when the repository is in a normal state.
 * @param {RepoState} state
 */
function stateOperation(state) {
  return OPERATION[state] || '';
}

module.exports = { checkoutTargets, startPoints, stateOperation };
