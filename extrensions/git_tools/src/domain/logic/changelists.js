// @ts-check
'use strict';

const { newShelfId } = require('./shelf');

/**
 * Changelists (Android Studio): the tracked changes split into named lists,
 * one of them active. Stored in `$(git rev-parse --git-path
 * git-tools/changelists.json)` (per worktree, never tracked); the format is
 * shared with the Git Tools Flutter app, so both work on the same lists.
 * Pure functions, no git.
 *
 * changelists.json:
 *   { "version": 1, "active": id,
 *     "lists": [{ "id": "default" | yyyyMMdd-HHmmss-6hex, "name": string, "comment": string, "files": [path] }] }
 * `files`: repository relative paths with forward slashes. The "default"
 * list always exists (renameable, not deletable). A file is in one list at
 * most; unversioned files are in none. Fields this version does not know
 * (top level and per list) are kept when the file is rewritten.
 *
 * @typedef {import('../entities').Changelist} Changelist
 * @typedef {import('../entities').ChangelistsData} ChangelistsData
 * @typedef {import('../entities').FileChange} FileChange
 */

const CHANGELISTS_VERSION = 1;
const DEFAULT_LIST = 'default';
const DEFAULT_NAME = 'Changes';

/** Repository relative path with forward slashes. @param {string} p */
const normPath = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * New changelist id: same format as shelf ids (creation time in UTC and 6
 * random hex digits).
 * @param {Date} date
 * @param {() => number} [random] 0 ≤ x < 1
 */
const newChangelistId = (date, random) => newShelfId(date, random);

/** Only the default list, active. @returns {ChangelistsData} */
function emptyChangelists() {
  return { version: CHANGELISTS_VERSION, active: DEFAULT_LIST, lists: [{ id: DEFAULT_LIST, name: DEFAULT_NAME, comment: '', files: [] }] };
}

/**
 * Applies the invariants to data read from disk: lists with a string id
 * (duplicates dropped), name and comment strings, each file in one list
 * only (the first one wins), the default list present (first when it had
 * to be added) and `active` naming an existing list (the default one
 * otherwise). Unknown fields are kept.
 * @param {any} raw
 * @returns {ChangelistsData}
 */
function normalizeChangelists(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ids = new Set();
  const seen = new Set();
  /** @type {Changelist[]} */
  const lists = [];
  for (const l of Array.isArray(src.lists) ? src.lists : []) {
    if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !l.id || ids.has(l.id)) continue;
    ids.add(l.id);
    const files = [];
    for (const f of Array.isArray(l.files) ? l.files : []) {
      if (typeof f !== 'string' || !f) continue;
      const p = normPath(f);
      if (seen.has(p)) continue;
      seen.add(p);
      files.push(p);
    }
    const name = typeof l.name === 'string' && l.name.trim() ? l.name : l.id === DEFAULT_LIST ? DEFAULT_NAME : l.id;
    lists.push({ ...l, name, comment: typeof l.comment === 'string' ? l.comment : '', files });
  }
  if (!ids.has(DEFAULT_LIST)) lists.unshift({ id: DEFAULT_LIST, name: DEFAULT_NAME, comment: '', files: [] });
  const active = typeof src.active === 'string' && lists.some((l) => l.id === src.active) ? src.active : DEFAULT_LIST;
  return { ...src, version: typeof src.version === 'number' ? src.version : CHANGELISTS_VERSION, active, lists };
}

/**
 * Reads changelists.json; null when the text is not a JSON object (e.g. a
 * file damaged by hand), so that it is not overwritten with empty lists.
 * @param {string} text
 * @returns {ChangelistsData|null}
 */
function parseChangelists(text) {
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return normalizeChangelists(raw);
}

/** changelists.json text: 2-space indented, LF, trailing newline. @param {ChangelistsData} data */
const serializeChangelists = (data) => `${JSON.stringify(data, null, 2)}\n`;

/** Whether two states would be written the same. @param {ChangelistsData} a @param {ChangelistsData} b */
const sameChangelists = (a, b) => serializeChangelists(a) === serializeChangelists(b);

/** @param {ChangelistsData} data @param {string} id @returns {Changelist|null} */
const findList = (data, id) => data.lists.find((l) => l.id === id) || null;

/** The active list (the default one when `active` is unknown). @param {ChangelistsData} data */
const activeList = (data) => /** @type {Changelist} */ (findList(data, data.active) || findList(data, DEFAULT_LIST) || data.lists[0]);

/** Id of the list holding `path`, or null. @param {ChangelistsData} data @param {string} path */
function listOf(data, path) {
  const l = data.lists.find((x) => x.files.includes(path));
  return l ? l.id : null;
}

/** List with this name (trimmed, case-insensitive), or null. @param {ChangelistsData} data @param {string} name */
function listByName(data, name) {
  const n = name.trim().toLowerCase();
  return data.lists.find((l) => l.name.trim().toLowerCase() === n) || null;
}

/**
 * Why `name` cannot name a list, or null. Names are unique (ignoring case).
 * @param {ChangelistsData} data
 * @param {string} name
 * @param {string|null} [exceptId] the list being renamed
 */
function validateChangelistName(data, name, exceptId = null) {
  if (!name.trim()) return 'Enter a name';
  const other = listByName(data, name);
  return other && other.id !== exceptId ? `A changelist named "${other.name}" already exists` : null;
}

/** Copy of the lists, files arrays included, so a change never touches `data`. @param {ChangelistsData} data */
const copyLists = (data) => data.lists.map((l) => ({ ...l, files: [...l.files] }));

/**
 * Brings the lists in line with the working tree status:
 *   rename: the new path takes the place of its old path in the old path's list;
 *   prune: paths that are no longer changed leave their list;
 *   first seen: a changed file in no list goes to the active list.
 * Only tracked changes are in lists (unversioned files never are).
 * @param {ChangelistsData} data
 * @param {FileChange[]} changes
 * @returns {ChangelistsData}
 */
function reconcileChangelists(data, changes) {
  const tracked = changes.filter((c) => c.type !== 'untracked');
  const current = new Set(tracked.map((c) => c.path));
  const lists = copyLists(data);
  /** @type {Map<string, Changelist>} */
  const owner = new Map();
  for (const l of lists) for (const f of l.files) owner.set(f, l);
  for (const c of tracked) {
    if (c.type !== 'renamed' || !c.oldPath || owner.has(c.path)) continue;
    const l = owner.get(c.oldPath);
    if (!l) continue;
    l.files[l.files.indexOf(c.oldPath)] = c.path;
    owner.delete(c.oldPath);
    owner.set(c.path, l);
  }
  for (const l of lists) l.files = l.files.filter((f) => current.has(f));
  const active = lists.find((l) => l.id === data.active) || lists.find((l) => l.id === DEFAULT_LIST) || lists[0];
  const assigned = new Set(lists.flatMap((l) => l.files));
  for (const c of tracked) {
    if (assigned.has(c.path)) continue;
    active.files.push(c.path);
    assigned.add(c.path);
  }
  return { ...data, lists };
}

/**
 * Moves files to list `toId` (out of any other list). Throws when the list
 * does not exist.
 * @param {ChangelistsData} data
 * @param {string[]} paths
 * @param {string} toId
 * @returns {ChangelistsData}
 */
function moveToChangelist(data, paths, toId) {
  if (!findList(data, toId)) throw new Error(`Unknown changelist: ${toId}`);
  const moved = [...new Set(paths.map(normPath))];
  const set = new Set(moved);
  // Files already in the target keep their place, the others are appended.
  const lists = copyLists(data).map((l) => (l.id === toId ? l : { ...l, files: l.files.filter((f) => !set.has(f)) }));
  const to = /** @type {Changelist} */ (lists.find((l) => l.id === toId));
  to.files.push(...moved.filter((f) => !to.files.includes(f)));
  return { ...data, lists };
}

/**
 * Adds an empty list (after the others).
 * @param {ChangelistsData} data
 * @param {{id: string, name: string, comment?: string}} o
 * @returns {ChangelistsData}
 */
function createChangelist(data, o) {
  if (findList(data, o.id)) throw new Error(`Changelist ${o.id} already exists`);
  return { ...data, lists: [...copyLists(data), { id: o.id, name: o.name.trim(), comment: o.comment || '', files: [] }] };
}

/**
 * Renames a list and / or replaces its comment.
 * @param {ChangelistsData} data
 * @param {string} id
 * @param {{name?: string, comment?: string}} changes
 * @returns {ChangelistsData}
 */
function editChangelist(data, id, changes) {
  if (!findList(data, id)) throw new Error(`Unknown changelist: ${id}`);
  return {
    ...data,
    lists: copyLists(data).map((l) => (l.id !== id ? l : {
      ...l,
      ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
      ...(changes.comment !== undefined ? { comment: changes.comment } : {}),
    })),
  };
}

/**
 * Where the files of list `id` go when it is deleted: the active list, or
 * the default list when the active one is deleted.
 * @param {ChangelistsData} data
 * @param {string} id
 */
const deleteTarget = (data, id) => (id === data.active || !findList(data, data.active) ? DEFAULT_LIST : data.active);

/**
 * Deletes a list; its files move to deleteTarget(). Deleting the active
 * list makes the default list active. The default list cannot be deleted.
 * @param {ChangelistsData} data
 * @param {string} id
 * @returns {ChangelistsData}
 */
function deleteChangelist(data, id) {
  if (id === DEFAULT_LIST) throw new Error('The default changelist cannot be deleted.');
  const gone = findList(data, id);
  if (!gone) throw new Error(`Unknown changelist: ${id}`);
  const target = deleteTarget(data, id);
  const lists = copyLists(data).filter((l) => l.id !== id);
  const to = /** @type {Changelist} */ (lists.find((l) => l.id === target));
  to.files.push(...gone.files.filter((f) => !to.files.includes(f)));
  return { ...data, active: data.active === id ? DEFAULT_LIST : data.active, lists };
}

/** @param {ChangelistsData} data @param {string} id @returns {ChangelistsData} */
function setActiveChangelist(data, id) {
  if (!findList(data, id)) throw new Error(`Unknown changelist: ${id}`);
  return { ...data, lists: copyLists(data), active: id };
}

module.exports = {
  CHANGELISTS_VERSION, DEFAULT_LIST, DEFAULT_NAME, newChangelistId, emptyChangelists, normalizeChangelists, parseChangelists,
  serializeChangelists, sameChangelists, findList, activeList, listOf, listByName, validateChangelistName, reconcileChangelists,
  moveToChangelist, createChangelist, editChangelist, deleteTarget, deleteChangelist, setActiveChangelist,
};
