// @ts-check
'use strict';

const { GitError } = require('../errors');

/** @typedef {import('../ports').GitRepository} GitRepository */

/**
 * How "Delete" on the current branch ended. `head`: the branch checked out
 * afterwards (null when detached).
 * - stayed: HEAD is still on the branch (checkout declined or failed), nothing deleted;
 *   `createdNotCheckedOut` when the new branch exists although it was not checked out.
 * - leaveFailed: HEAD moved but leaving reported an error (e.g. Smart Checkout could not
 *   restore the local changes), nothing deleted.
 * - deleted: the branch was deleted (force deleted when not fully merged and confirmed).
 * - kept: not fully merged and force delete declined.
 * - failed: git refused to delete it, `error` says why.
 * @typedef {{outcome: 'stayed'|'leaveFailed'|'deleted'|'kept'|'failed', head: string|null, createdNotCheckedOut?: boolean, error?: string}} DeleteCurrentBranchResult
 */

/**
 * Deletes the current branch: leaves it first (checkout of another branch,
 * or of a new one), then deletes it locally, only once HEAD has moved without
 * an error.
 */
class DeleteCurrentBranch {
  /** @param {GitRepository} repo */
  constructor(repo) {
    this.repo = repo;
  }

  /**
   * @param {{branch: string, leave: () => Promise<boolean|void>, created?: string,
   *   confirmForce: (branch: string, head: string|null) => Promise<boolean>}} o
   *   leave: checks out another branch, resolves to false when it reported an error
   *   (errors it throws propagate; either way nothing is deleted);
   *   created: name of the branch leave() creates, if any;
   *   confirmForce: asked when the branch is not fully merged.
   * @returns {Promise<DeleteCurrentBranchResult>}
   */
  async run({ branch, leave, created, confirmForce }) {
    const left = await leave();
    // A fresh status, not a cached one: HEAD decides whether leaving worked.
    const head = (await this.repo.status()).branch;
    if (head === branch) {
      /** @type {DeleteCurrentBranchResult} */
      const stayed = { outcome: 'stayed', head };
      if (created) stayed.createdNotCheckedOut = await this.repo.refExists(`refs/heads/${created}`);
      return stayed;
    }
    if (left === false) return { outcome: 'leaveFailed', head };
    try {
      await this.repo.deleteBranch(branch);
      return { outcome: 'deleted', head };
    } catch (e) {
      if (!(e instanceof GitError && e.stderr.includes('not fully merged'))) {
        return { outcome: 'failed', head, error: e.message };
      }
    }
    if (!(await confirmForce(branch, head))) return { outcome: 'kept', head };
    try {
      await this.repo.deleteBranch(branch, true);
      return { outcome: 'deleted', head };
    } catch (e) {
      return { outcome: 'failed', head, error: e.message };
    }
  }
}

module.exports = { DeleteCurrentBranch };
