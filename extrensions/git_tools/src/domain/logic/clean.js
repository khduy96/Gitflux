// @ts-check
'use strict';

const { unquotePath } = require('./patch');

/**
 * Clean Working Tree: the entries `git clean -n` lists and how the chosen
 * ones are handed back to `git clean -f`. Pure functions, no git.
 *
 * @typedef {import('../entities').CleanEntry} CleanEntry
 * @typedef {import('../entities').CleanOptions} CleanOptions
 */

/**
 * Paths of `git clean -n` output ("Would remove <path>", directories end
 * with "/"). Lines of other kinds ("Would skip repository …") are ignored.
 * @param {string} out
 * @returns {{path: string, directory: boolean}[]}
 */
function parseCleanOutput(out) {
  const entries = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^Would remove (.+)$/.exec(raw);
    if (!m) continue;
    const p = unquotePath(m[1]);
    const directory = p.endsWith('/');
    entries.push({ path: directory ? p.slice(0, -1) : p, directory });
  }
  return entries;
}

/**
 * Entries of the Clean dialog: what `git clean -n` removes, plus the nested
 * repositories only the doubled force (`-n -ff`) lists. Sorted by path.
 * @param {string} plain output of `git clean -n [-d] [-x]`
 * @param {string} forced output of the same with `-ff`
 * @returns {CleanEntry[]}
 */
function cleanEntries(plain, forced) {
  const listed = parseCleanOutput(plain);
  const known = new Set(listed.map((e) => e.path));
  /** @type {CleanEntry[]} */
  const entries = listed.map((e) => ({ ...e, nestedRepo: false }));
  for (const e of parseCleanOutput(forced)) {
    if (!known.has(e.path)) entries.push({ ...e, nestedRepo: true });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Arguments of `git clean` for the options (without -n / -f).
 * @param {CleanOptions} o
 */
function cleanFlags(o) {
  return [...(o.directories ? ['-d'] : []), ...(o.ignored ? ['-x'] : [])];
}

/**
 * Splits literal pathspecs into batches that keep each command line short:
 * `git clean` has no --pathspec-from-file, and Windows limits a command line
 * to 32767 characters.
 * @param {string[]} specs
 * @param {number} [maxChars]
 * @returns {string[][]}
 */
function batchPathspecs(specs, maxChars = 24000) {
  /** @type {string[][]} */
  const batches = [];
  let current = [];
  let size = 0;
  for (const s of specs) {
    if (current.length && size + s.length + 3 > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += s.length + 3;
  }
  if (current.length) batches.push(current);
  return batches;
}

module.exports = { parseCleanOutput, cleanEntries, cleanFlags, batchPathspecs };
