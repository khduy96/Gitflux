// @ts-check
'use strict';

/** A git command exited with a non-zero code. */
class GitError extends Error {
  /**
   * @param {string[]} args
   * @param {number} code
   * @param {string} stderr
   * @param {string} stdout
   */
  constructor(args, code, stderr, stdout) {
    super((stderr || stdout).trim() || `git ${args.join(' ')} failed with exit code ${code}`);
    this.args = args;
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/** An AI call failed, was declined or was cancelled. */
class AiError extends Error {
  /** @param {string} message @param {{cancelled?: boolean}} [o] */
  constructor(message, o = {}) {
    super(message);
    this.cancelled = !!o.cancelled;
  }
}

/** The diff of a file changed after its lines were selected. */
class StaleSelectionError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`${path} changed after its lines were selected. Review the selection again.`);
    this.path = path;
  }
}

/** A commit was not started because the input breaks a rule. */
class CommitRejected extends Error {}

/** A history rewrite (interactive rebase) is not possible for the selection or the repository state. */
class RebaseRejected extends Error {}

/** Shelving or unshelving is not possible for the selection or the repository state. */
class ShelfRejected extends Error {}

/** A patch cannot be created or applied (nothing to export, not a patch…). */
class PatchRejected extends Error {}

module.exports = { GitError, AiError, StaleSelectionError, CommitRejected, RebaseRejected, ShelfRejected, PatchRejected };
