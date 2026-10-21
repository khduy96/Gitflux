// @ts-check
'use strict';

/**
 * Shelf format: `<git-common-dir>/git-tools/shelf/<id>/shelf.json` next to
 * `changes.patch`. The format is shared with the Git Tools Flutter app, so a
 * shelf created by one is read by the other. Pure functions, no git.
 *
 * shelf.json:
 *   { "version": 1, "name": string, "created": ISO-8601 UTC, "base": HEAD hash at shelve time,
 *     "branch": string|null, "files": [{ "path": string, "oldPath": string|null, "status": "M"|"A"|"D"|"R" }] }
 *
 * @typedef {import('../entities').Shelf} Shelf
 * @typedef {import('../entities').ShelfFile} ShelfFile
 * @typedef {import('../entities').ShelfFileStatus} ShelfFileStatus
 */

const SHELF_VERSION = 1;

/** yyyyMMdd-HHmmss-<6 hex> */
const SHELF_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

/**
 * Folder names read as shelves: anything usable in a ref name, so a shelf
 * written by another tool with a slightly different id is still listed.
 */
const SHELF_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * New shelf id from the creation time (UTC) and 6 random hex digits.
 * @param {Date} date
 * @param {() => number} [random] 0 ≤ x < 1
 */
function newShelfId(date, random = Math.random) {
  const d = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const t = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  const hex = Math.floor(random() * 0x1000000).toString(16).padStart(6, '0').slice(-6);
  return `${d}-${t}-${hex}`;
}

/** Whether `id` has the format this extension creates. */
const isShelfId = (id) => SHELF_ID.test(id);

/** Whether a folder below the shelf root can hold a shelf. */
const isShelfDir = (name) => SHELF_DIR.test(name) && !name.endsWith('.lock') && !name.includes('..');

/** The ref keeping the base commit of a shelf alive. */
const shelfRef = (id) => `refs/git-tools/shelf/${id}`;

/**
 * Default shelf name: first line of the commit message, or "Changes from
 * <yyyy-MM-dd HH:mm>" (local time).
 * @param {string} message
 * @param {Date} now
 */
function defaultShelfName(message, now) {
  const first = (message || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  if (first) return first;
  return `Changes from ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Shelf status of a `git diff --name-status` change type: type changes are
 * modifications, copies new files.
 * @param {import('../entities').ChangeType} type
 * @returns {ShelfFileStatus}
 */
function shelfStatus(type) {
  if (type === 'added' || type === 'copied' || type === 'untracked') return 'A';
  if (type === 'deleted') return 'D';
  if (type === 'renamed') return 'R';
  return 'M';
}

/**
 * The shelf.json text of a new shelf (2-space indented, LF, trailing newline).
 * @param {{name: string, created: Date, base: string, branch: string|null, files: ShelfFile[]}} o
 */
function serializeShelf(o) {
  return stringify({
    version: SHELF_VERSION,
    name: o.name,
    created: o.created.toISOString(),
    base: o.base,
    branch: o.branch || null,
    files: o.files.map(fileJson),
  });
}

/**
 * shelf.json with some fields replaced, keeping the fields this version does
 * not know (written by a newer app) as they are.
 * @param {string} text current shelf.json
 * @param {{name?: string, files?: ShelfFile[]}} changes
 */
function updateShelfJson(text, changes) {
  const raw = JSON.parse(text);
  if (changes.name !== undefined) raw.name = changes.name;
  if (changes.files) raw.files = changes.files.map(fileJson);
  return stringify(raw);
}

/** @param {ShelfFile} f */
const fileJson = (f) => ({ path: f.path, oldPath: f.oldPath || null, status: f.status });

const stringify = (o) => `${JSON.stringify(o, null, 2)}\n`;

/**
 * Reads shelf.json; null when it is not a shelf this version understands.
 * @param {string} text
 * @param {string} id folder name
 * @returns {Shelf|null}
 */
function parseShelf(text, id) {
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.version !== SHELF_VERSION) return null;
  if (typeof raw.base !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(raw.base)) return null;
  if (!Array.isArray(raw.files)) return null;
  /** @type {ShelfFile[]} */
  const files = [];
  for (const f of raw.files) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    const status = ['M', 'A', 'D', 'R'].includes(f.status) ? f.status : 'M';
    files.push({ path: f.path, oldPath: typeof f.oldPath === 'string' && f.oldPath ? f.oldPath : null, status });
  }
  const created = typeof raw.created === 'string' ? Date.parse(raw.created) : NaN;
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : id,
    created: Number.isNaN(created) ? 0 : created,
    base: raw.base,
    branch: typeof raw.branch === 'string' && raw.branch ? raw.branch : null,
    files,
  };
}

/** Newest first; shelves with the same time by id. @param {Shelf[]} shelves */
const newestFirst = (shelves) => [...shelves].sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));

/** Paths git touches for these files (both sides of a rename). @param {ShelfFile[]} files */
const shelfPaths = (files) => [...new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))];

module.exports = {
  SHELF_VERSION, newShelfId, isShelfId, isShelfDir, shelfRef, defaultShelfName, shelfStatus, serializeShelf,
  updateShelfJson, parseShelf, newestFirst, shelfPaths,
};
