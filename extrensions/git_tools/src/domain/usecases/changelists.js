// @ts-check
'use strict';

const {
  DEFAULT_LIST, newChangelistId, emptyChangelists, sameChangelists, findList, activeList, listOf, listByName,
  validateChangelistName, reconcileChangelists, moveToChangelist, createChangelist, editChangelist, deleteTarget,
  deleteChangelist, setActiveChangelist,
} = require('../logic/changelists');

/** @typedef {import('../ports').ChangelistStore} ChangelistStore */
/** @typedef {import('../entities').ChangelistsData} ChangelistsData */
/** @typedef {import('../entities').FileChange} FileChange */

/**
 * Changelists of one worktree (Android Studio): every change goes through
 * the store, read again first (the Flutter app may have changed the file)
 * and written only when something changed. Changes run one at a time, so
 * two of them never read the same state.
 */
class Changelists {
  /** @param {ChangelistStore} store */
  constructor(store) {
    this.store = store;
    /** Last state read or written. @type {ChangelistsData} */
    this.data = emptyChangelists();
    /** @type {Promise<any>} */
    this._queue = Promise.resolve();
  }

  /**
   * Reads the file, applies `fn` and writes the result when it differs.
   * @template T
   * @param {(data: ChangelistsData) => {data: ChangelistsData, value?: T}} fn
   * @returns {Promise<T|undefined>}
   */
  update(fn) {
    const next = this._queue.then(async () => {
      const before = await this.store.read();
      const { data, value } = fn(before);
      if (!sameChangelists(before, data)) await this.store.write(data);
      this.data = data;
      return value;
    });
    this._queue = next.catch(() => {});
    return next;
  }

  /** Reads the file again (e.g. changed by the Flutter app). */
  load() {
    return this.update((data) => ({ data }));
  }

  get active() {
    return this.data.active;
  }

  /** Id of the list holding `path`, or null. @param {string} path */
  listOf(path) {
    return listOf(this.data, path);
  }

  /** @param {string} id */
  list(id) {
    return findList(this.data, id);
  }

  /** @param {string} id */
  filesOf(id) {
    const l = findList(this.data, id);
    return l ? [...l.files] : [];
  }

  /** @param {string} name */
  byName(name) {
    return listByName(this.data, name);
  }

  /** @param {string} name @param {string|null} [exceptId] */
  validateName(name, exceptId = null) {
    return validateChangelistName(this.data, name, exceptId);
  }

  /** Where the files of list `id` go when it is deleted. @param {string} id */
  deleteTarget(id) {
    return deleteTarget(this.data, id);
  }

  /**
   * Status refresh: renames followed, unchanged paths pruned, files seen for
   * the first time assigned to the active list (persisted at once, so a
   * later change of the active list does not move them).
   * @param {FileChange[]} changes
   */
  reconcile(changes) {
    return this.update((data) => ({ data: reconcileChangelists(data, changes) }));
  }

  /** @param {string[]} paths @param {string} toId */
  move(paths, toId) {
    return this.update((data) => ({ data: moveToChangelist(data, paths, toId) }));
  }

  /**
   * New list, optionally holding `paths` and made active. Returns its id.
   * @param {{name: string, comment?: string, paths?: string[], now?: Date}} o
   * @returns {Promise<string>}
   */
  async create(o) {
    const id = await this.update((data) => {
      const error = validateChangelistName(data, o.name);
      if (error) throw new Error(error);
      let id = newChangelistId(o.now || new Date());
      while (findList(data, id)) id = newChangelistId(o.now || new Date());
      let next = createChangelist(data, { id, name: o.name, comment: o.comment || '' });
      if (o.paths && o.paths.length) next = moveToChangelist(next, o.paths, id);
      return { data: next, value: id };
    });
    return /** @type {string} */ (id);
  }

  /** @param {string} id @param {{name?: string, comment?: string}} changes */
  edit(id, changes) {
    return this.update((data) => {
      if (changes.name !== undefined) {
        const error = validateChangelistName(data, changes.name, id);
        if (error) throw new Error(error);
      }
      return { data: editChangelist(data, id, changes) };
    });
  }

  /** Saves the commit message draft of a list. @param {string} id @param {string} text */
  saveComment(id, text) {
    return this.update((data) => ({ data: findList(data, id) ? editChangelist(data, id, { comment: text }) : data }));
  }

  /**
   * Deletes a list; its files go to the active list (the default one when
   * the active list is deleted). Returns the id of the list they went to.
   * @param {string} id
   * @returns {Promise<string>}
   */
  async remove(id) {
    const target = await this.update((data) => ({ value: deleteTarget(data, id), data: deleteChangelist(data, id) }));
    return /** @type {string} */ (target);
  }

  /**
   * Makes `id` active. `message` (the commit message box, the draft of the
   * list active until now) is saved as that list's comment; returns the
   * comment of the new active list, to show in the message box.
   * @param {string} id
   * @param {string} message
   * @returns {Promise<string>}
   */
  async setActive(id, message) {
    const comment = await this.update((data) => {
      if (!findList(data, id)) throw new Error('The changelist no longer exists.');
      if (data.active === id) return { data, value: activeList(data).comment };
      const saved = editChangelist(data, activeList(data).id, { comment: message });
      const next = setActiveChangelist(saved, id);
      return { data: next, value: activeList(next).comment };
    });
    return /** @type {string} */ (comment);
  }
}

module.exports = { Changelists, DEFAULT_LIST };
