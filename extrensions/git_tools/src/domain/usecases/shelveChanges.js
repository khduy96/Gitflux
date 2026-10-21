// @ts-check
'use strict';

const { allPaths } = require('../entities');
const { ShelfRejected } = require('../errors');
const { shelfPaths } = require('../logic/shelf');

/** @typedef {import('../ports').GitRepository} GitRepository */
/** @typedef {import('../ports').ShelfStore} ShelfStore */
/** @typedef {import('../entities').FileChange} FileChange */
/** @typedef {import('../entities').Shelf} Shelf */
/** @typedef {import('../entities').ShelfFile} ShelfFile */

/** Operations during which nothing is shelved. */
const OPERATION = {
  merging: 'merge', rebasing: 'rebase', cherryPicking: 'cherry-pick', reverting: 'revert', applyingMailbox: 'patch application (git am)',
};

/**
 * A checked shelve, ready to run. `skipped`: submodules, nested
 * repositories and conflicted files, which are never shelved.
 * @typedef {{name: string, base: string, branch: string|null, paths: string[], keep: boolean, skipped: FileChange[]}} PreparedShelve
 */

/**
 * Shelve (Android Studio "Shelve Changes"): puts the changes of chosen files
 * aside as a named patch, independent of git's stash, and brings them back
 * file by file.
 */
class ShelveChanges {
  /** @param {GitRepository} repo @param {ShelfStore} store */
  constructor(repo, store) {
    this.repo = repo;
    this.store = store;
    /** Shelved blobs of the last shelf shown in a diff. @type {{id: string, patch: Buffer, entries: Map<string, {mode: string, sha: string}>}|null} */
    this._entries = null;
  }

  /**
   * Checks the shelve rules. Throws ShelfRejected.
   * @param {{status: import('../entities').Status, changes: FileChange[], name: string, keep?: boolean}} o
   * @returns {PreparedShelve}
   */
  prepare({ status, changes, name, keep = false }) {
    if (status.state !== 'normal') {
      throw new ShelfRejected(`Shelving is not possible while a ${OPERATION[status.state] || status.state} is in progress.`);
    }
    if (!status.head) throw new ShelfRejected('Shelving needs a commit to shelve against: make the first commit.');
    if (!name.trim()) throw new ShelfRejected('Shelf name is empty.');
    const skipped = changes.filter((c) => c.submodule || c.nestedRepo || c.type === 'conflicted');
    const files = changes.filter((c) => !skipped.includes(c));
    if (!files.length) {
      throw new ShelfRejected(skipped.length ? 'Submodules and conflicted files cannot be shelved.' : 'No files selected to shelve.');
    }
    return { name: name.trim(), base: status.head, branch: status.branch, paths: [...new Set(files.flatMap(allPaths))], keep, skipped };
  }

  /**
   * Writes the shelf (patch of the working tree content against HEAD), then
   * reverts the shelved files to HEAD unless they are kept. Other files and
   * their index entries are not touched.
   * @param {PreparedShelve} p
   * @param {Date} [now]
   * @returns {Promise<Shelf>}
   */
  async run(p, now = new Date()) {
    const current = await this.repo.status();
    if (current.head !== p.base || current.state !== 'normal') {
      throw new ShelfRejected('The repository changed (HEAD moved or an operation started). Try again.');
    }
    const { patch, files } = await this.repo.buildPatch(p.paths, p.base);
    if (!files.length) throw new ShelfRejected('The selected files have no changes to shelve.');
    const shelf = await this.store.create({ name: p.name, created: now, base: p.base, branch: p.branch, files, patch });
    if (!p.keep) await this.repo.discardChanges(files, p.base);
    return shelf;
  }

  /**
   * Applies files of a shelf to the working tree with a 3-way merge against
   * the shelf's base. Files that merge with conflicts get conflict markers
   * (the Merge Conflicts UI takes over) and stay in the shelf; the others
   * are dropped from the shelf when `remove` is set. Throws ShelfRejected,
   * or GitError (nothing changed) when git refuses the patch.
   * @param {{shelf: Shelf, paths?: string[]|null, remove: boolean}} o paths: shelf file paths, all when omitted
   * @returns {Promise<{applied: ShelfFile[], conflicted: ShelfFile[], shelfDeleted: boolean}>}
   */
  async unshelve({ shelf, paths = null, remove }) {
    const chosen = paths ? shelf.files.filter((f) => paths.includes(f.path)) : shelf.files;
    if (!chosen.length) throw new ShelfRejected('No files selected to unshelve.');
    const targets = shelfPaths(chosen);
    const unmerged = new Set(await this.repo.unmergedPaths());
    const blocked = targets.filter((p) => unmerged.has(p));
    if (blocked.length) throw new ShelfRejected(`Resolve the conflicts in ${blocked.join(', ')} first.`);
    let patch = await this.store.readPatch(shelf.id);
    const others = shelf.files.filter((f) => !chosen.includes(f));
    if (others.length) patch = (await this.repo.removeFromPatch(shelf.base, patch, shelfPaths(others))).patch;
    const { conflicted } = await this.repo.applyPatch(patch, targets);
    const failed = new Set(conflicted);
    const applied = chosen.filter((f) => !failed.has(f.path) && !(f.oldPath && failed.has(f.oldPath)));
    const kept = chosen.filter((f) => !applied.includes(f));
    const shelfDeleted = remove && applied.length ? await this.removeFiles(shelf, applied) : false;
    return { applied, conflicted: kept, shelfDeleted };
  }

  /**
   * Drops files from a shelf (patch rebuilt without them); the shelf is
   * deleted, with its ref, when no file is left. Returns whether it was.
   * @param {Shelf} shelf
   * @param {ShelfFile[]} files
   */
  async removeFiles(shelf, files) {
    const drop = new Set(files.map((f) => f.path));
    if (shelf.files.every((f) => drop.has(f.path))) {
      await this.store.remove(shelf.id);
      return true;
    }
    const next = await this.repo.removeFromPatch(shelf.base, await this.store.readPatch(shelf.id), shelfPaths(files));
    if (!next.files.length) {
      await this.store.remove(shelf.id);
      return true;
    }
    await this.store.update(shelf.id, { files: next.files, patch: next.patch });
    return false;
  }

  /**
   * Shelved content of a file (the patch applied to the base in a temporary
   * index); null when the shelf deletes it.
   * @param {Shelf} shelf
   * @param {string} filePath
   * @returns {Promise<Buffer|null>}
   */
  async content(shelf, filePath) {
    const patch = await this.store.readPatch(shelf.id);
    let cached = this._entries;
    if (!cached || cached.id !== shelf.id || !cached.patch.equals(patch)) {
      cached = { id: shelf.id, patch, entries: await this.repo.patchedEntries(shelf.base, patch, shelfPaths(shelf.files)) };
      this._entries = cached;
    }
    const e = cached.entries.get(filePath);
    return e ? this.repo.blob(e.sha) : null;
  }
}

module.exports = { ShelveChanges };
