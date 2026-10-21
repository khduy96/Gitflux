// @ts-check
'use strict';

const { allPaths } = require('../entities');
const { PatchRejected } = require('../errors');
const { isMailbox, oldestFirst, patchTargets } = require('../logic/patch');

/** @typedef {import('../ports').GitRepository} GitRepository */
/** @typedef {import('../entities').FileChange} FileChange */
/** @typedef {import('../entities').Commit} Commit */
/** @typedef {import('../entities').PatchFile} PatchFile */

/**
 * A patch read for Apply Patch: its files, whether it is a mailbox (git
 * format-patch, can be applied as commits) and the result of a dry run.
 * @typedef {{mailbox: boolean, files: PatchFile[], check: import('../entities').PatchCheck}} PatchPreview
 */

const firstLine = (s) => String(s).trim().split('\n')[0];

/** Create Patch (working tree changes, commits) and Apply Patch. */
class Patches {
  /** @param {GitRepository} repo */
  constructor(repo) {
    this.repo = repo;
  }

  /**
   * Patch of the working tree content of `changes` against HEAD (new and
   * deleted files included, binary safe), built in a temporary index.
   * Submodules, nested repositories and conflicted files are left out.
   * @param {FileChange[]} changes
   * @param {import('../entities').Status} status
   * @returns {Promise<Buffer>}
   */
  async fromChanges(changes, status) {
    const files = changes.filter((c) => !c.submodule && !c.nestedRepo && c.type !== 'conflicted');
    if (!files.length) throw new PatchRejected('No files selected for the patch (submodules and conflicted files are left out).');
    const { patch, files: inPatch } = await this.repo.buildPatch([...new Set(files.flatMap(allPaths))], status.head);
    if (!inPatch.length) throw new PatchRejected('The selected files have no changes.');
    return patch;
  }

  /**
   * One mailbox (git format-patch --stdout) with the commits, oldest first.
   * Merge commits have no patch and are left out.
   * @param {Commit[]} commits
   * @param {string[]} logOrder hashes as the Log lists them (git log --date-order)
   * @returns {Promise<{patch: Buffer, count: number, skippedMerges: number}>}
   */
  async fromCommits(commits, logOrder) {
    const ordered = oldestFirst(commits, logOrder);
    const plain = ordered.filter((c) => c.parents.length < 2);
    if (!plain.length) throw new PatchRejected('Merge commits cannot be exported as patches.');
    const patch = await this.repo.formatPatch(plain.map((c) => c.hash));
    return { patch, count: plain.length, skippedMerges: ordered.length - plain.length };
  }

  /**
   * Reads a patch for the Apply Patch preview. Throws PatchRejected when it
   * is not a patch.
   * @param {Buffer} patch
   * @returns {Promise<PatchPreview>}
   */
  async inspect(patch) {
    /** @type {PatchFile[]} */
    let files;
    try {
      files = await this.repo.patchFiles(patch);
    } catch (e) {
      throw new PatchRejected(`Not a valid patch: ${firstLine(e.message)}`);
    }
    if (!files.length) throw new PatchRejected('The patch contains no file changes.');
    const check = await this.repo.checkPatch(patch, patchTargets(files));
    return { mailbox: isMailbox(patch.toString('utf8')), files, check };
  }

  /**
   * Applies a patch: as commits (git am --3way, mailbox only) or to the
   * working tree (git apply --3way, the user's staging kept). Conflicts are
   * left for the Merge Conflicts UI; git am then stops (applyingMailbox).
   * @param {Buffer} patch
   * @param {{asCommits: boolean, files: PatchFile[], status: import('../entities').Status}} o
   * @returns {Promise<{conflicted: string[], stopped: boolean, output: string}>}
   */
  async apply(patch, { asCommits, files, status }) {
    if (asCommits) {
      if (status.state !== 'normal') throw new PatchRejected(`Finish the ${status.state} in progress before applying commits.`);
      const r = await this.repo.applyMailbox(patch);
      return { conflicted: r.stopped ? await this.repo.unmergedPaths() : [], stopped: r.stopped, output: r.output };
    }
    const targets = patchTargets(files);
    const unmerged = new Set(await this.repo.unmergedPaths());
    const blocked = targets.filter((p) => unmerged.has(p));
    if (blocked.length) throw new PatchRejected(`Resolve the conflicts in ${blocked.join(', ')} first.`);
    const r = await this.repo.applyPatch(patch, targets);
    return { conflicted: r.conflicted, stopped: false, output: r.output };
  }
}

module.exports = { Patches };
