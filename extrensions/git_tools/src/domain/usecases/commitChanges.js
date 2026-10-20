// @ts-check
'use strict';

const { allPaths } = require('../entities');
const { CommitRejected } = require('../errors');
const { selectedLineContents } = require('./selectedLineContents');

/** @typedef {import('../ports').GitRepository} GitRepository */
/** @typedef {import('../entities').FileChange} FileChange */
/** @typedef {import('../entities').LineSelection} LineSelection */

/**
 * A checked commit, ready to run.
 * @typedef {{message: string, paths: string[], partial: {path: string, content: string}[],
 *   amend: boolean, signOff: boolean, inOperation: boolean}} PreparedCommit
 */

/** Commits the checked changes, whole files or selected lines. */
class CommitChanges {
  /** @param {GitRepository} repo */
  constructor(repo) {
    this.repo = repo;
  }

  /**
   * Checks the commit rules and computes the content of partially committed
   * files. Throws CommitRejected, or StaleSelectionError when a line
   * selection is out of date.
   * @param {{status: import('../entities').Status, message: string, changes: FileChange[],
   *   lineSelections: Map<string, LineSelection>, amend?: boolean, signOff?: boolean}} o
   * @returns {Promise<PreparedCommit>}
   */
  async prepare({ status, message, changes, lineSelections, amend = false, signOff = false }) {
    const inOperation = status.state !== 'normal';
    if (!message) throw new CommitRejected('Commit message is empty.');
    if (status.changes.some((c) => c.type === 'conflicted')) {
      throw new CommitRejected('Resolve all conflicts before committing.');
    }
    if (!changes.length && !amend && !inOperation) throw new CommitRejected('No changes selected for commit.');
    const hasLines = changes.some((c) => lineSelections.has(c.path));
    if (hasLines && inOperation) {
      throw new CommitRejected('Selecting individual lines is not possible while a merge or rebase is in progress. Include whole files instead.');
    }
    const partial = hasLines
      ? (await selectedLineContents(this.repo, changes, lineSelections)).map((p) => ({ path: p.path, content: p.content }))
      : [];
    return { message, paths: [...new Set(changes.flatMap(allPaths))], partial, amend, signOff, inOperation };
  }

  /** @param {PreparedCommit} c */
  run(c) {
    if (!c.partial.length) {
      return this.repo.commit({ message: c.message, paths: c.paths, amend: c.amend, signOff: c.signOff, partial: !c.inOperation });
    }
    const partialPaths = new Set(c.partial.map((p) => p.path));
    return this.repo.commitSelected({
      message: c.message,
      fullPaths: c.paths.filter((p) => !partialPaths.has(p)),
      partial: c.partial,
      amend: c.amend,
      signOff: c.signOff,
    });
  }
}

module.exports = { CommitChanges };
