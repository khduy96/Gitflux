// @ts-check
'use strict';

/**
 * Patch files: mailbox detection (git format-patch output), the file list of
 * `git apply --numstat --summary -z`, and the conflicts `git apply --3way`
 * reports. Pure functions, no git.
 *
 * @typedef {import('../entities').PatchFile} PatchFile
 * @typedef {import('../entities').ShelfFileStatus} ShelfFileStatus
 */

/**
 * Whether the patch is a mailbox (git format-patch): starts with
 * "From <hash> ", or has From: / Subject: mail headers before the first diff.
 * @param {string} text
 */
function isMailbox(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const first = lines.find((l) => l.trim()) || '';
  if (/^From [0-9a-f]{7,64} /.test(first)) return true;
  let from = false;
  let subject = false;
  for (const l of lines) {
    if (l.startsWith('diff --git ') || l.startsWith('--- ') || l.startsWith('Index: ')) break;
    if (/^From: \S/.test(l)) from = true;
    else if (/^Subject: /.test(l)) subject = true;
  }
  return from && subject;
}

/**
 * Removes the C-style quoting git puts around unusual paths ("a\tb").
 * Octal escapes are UTF-8 bytes.
 * @param {string} s
 */
function unquotePath(s) {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  /** @type {number[]} */
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next || '')) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Old and new path of a summary rename ("a => b" or "dir/{a => b}/c";
 * an empty side drops its folder level).
 * @param {string} s
 * @returns {{oldPath: string, path: string}|null}
 */
function splitRename(s) {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(s);
  if (brace) {
    const join = (mid) => `${brace[1]}${mid}${brace[4]}`.replace(/\/\//g, '/').replace(/^\//, '');
    return { oldPath: join(brace[2]), path: join(brace[3]) };
  }
  const i = s.indexOf(' => ');
  if (i < 0) return null;
  return { oldPath: unquotePath(s.slice(0, i)), path: unquotePath(s.slice(i + 4)) };
}

/**
 * Parses `git apply --numstat --summary -z`: NUL terminated
 * "added\tdeleted\tpath" records (renames: "added\tdeleted\t" NUL old NUL
 * new), then the summary lines. The same file patched several times (a
 * mailbox with several commits) is listed once with summed counts.
 * @param {string} out
 * @returns {PatchFile[]}
 */
function parsePatchStat(out) {
  const parts = out.split('\0');
  const summary = parts.pop() || '';
  /** @type {Map<string, PatchFile>} */
  const files = new Map();
  /** @type {Map<string, ShelfFileStatus>} */
  const status = new Map();
  /** @type {Map<string, string>} new path → old path */
  const renamed = new Map();

  for (const line of summary.split('\n')) {
    const l = line.trim();
    let m;
    if ((m = /^create mode \d+ (.+)$/.exec(l))) status.set(unquotePath(m[1]), 'A');
    else if ((m = /^delete mode \d+ (.+)$/.exec(l))) status.set(unquotePath(m[1]), 'D');
    else if ((m = /^(?:rename|copy) (.+) \(\d+%\)$/.exec(l))) {
      const r = splitRename(m[1]);
      if (r) {
        status.set(r.path, l.startsWith('copy') ? 'A' : 'R');
        if (l.startsWith('rename')) renamed.set(r.path, r.oldPath);
      }
    }
  }

  const add = (counts, p, oldPath) => {
    const [a, d] = counts;
    const binary = a === '-' || d === '-';
    const prev = files.get(p);
    if (prev) {
      if (binary) prev.added = prev.deleted = null;
      else if (prev.added !== null && prev.deleted !== null) {
        prev.added += Number(a);
        prev.deleted += Number(d);
      }
      return;
    }
    const old = oldPath || renamed.get(p) || null;
    files.set(p, {
      path: p,
      oldPath: old,
      status: status.get(p) || (old ? 'R' : 'M'),
      added: binary ? null : Number(a),
      deleted: binary ? null : Number(d),
    });
  };
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i].replace(/^\n/, ''));
    if (!m) continue;
    if (m[3]) add([m[1], m[2]], m[3], null);
    else {
      add([m[1], m[2]], parts[i + 2], parts[i + 1]);
      i += 2;
    }
  }
  return [...files.values()];
}

/**
 * Files `git apply --3way` (also with --check) merged with conflicts, from
 * its "Applied patch to 'x' with conflicts." lines.
 * @param {string} stderr
 */
function appliedWithConflicts(stderr) {
  const out = [];
  const re = /^Applied patch to '(.*)' with conflicts\.$/gm;
  let m;
  while ((m = re.exec(stderr))) out.push(m[1]);
  return out;
}

/** Paths git reads or writes for these files (both sides of a rename). @param {{path: string, oldPath: string|null}[]} files */
const patchTargets = (files) => [...new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))];

/**
 * Default file name of a patch: `<branch>.patch`, folders of the branch name
 * joined with '-'.
 * @param {string|null} branch
 */
function patchFileName(branch) {
  const base = (branch || 'changes').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'changes';
  return `${base}.patch`;
}

/**
 * Text pasted from the clipboard with every line ending converted to CRLF
 * (some clipboards do that) back to LF. A patch with only some CRLF lines
 * (files with CRLF content) is left alone.
 * @param {string} text
 */
function normalizeClipboardPatch(text) {
  const lf = (text.match(/\n/g) || []).length;
  const crlf = (text.match(/\r\n/g) || []).length;
  return lf && lf === crlf ? text.replace(/\r\n/g, '\n') : text;
}

/**
 * Commits in the order to export them: oldest first. `logOrder` lists hashes
 * as git log --date-order shows them (no parent before its children), so the
 * reverse of that order is a topological order.
 * @template {{hash: string}} T
 * @param {T[]} commits
 * @param {string[]} logOrder
 * @returns {T[]}
 */
function oldestFirst(commits, logOrder) {
  const at = new Map(logOrder.map((h, i) => [h, i]));
  return [...commits].sort((a, b) => (at.get(b.hash) ?? -1) - (at.get(a.hash) ?? -1));
}

module.exports = {
  isMailbox, unquotePath, splitRename, parsePatchStat, appliedWithConflicts, patchTargets, patchFileName,
  normalizeClipboardPatch, oldestFirst,
};
