// @ts-check
'use strict';

/**
 * Git LFS: parsing of the git-lfs command outputs, pointer files, the
 * patterns offered by "Track with LFS…" and a gitattributes pattern matcher
 * (which tracked pattern covers a file). Pure functions, no git.
 *
 * @typedef {import('../entities').LfsPointer} LfsPointer
 * @typedef {import('../entities').LfsLock} LfsLock
 * @typedef {import('../entities').LfsPattern} LfsPattern
 * @typedef {{oid: string, path: string, size: number|null, downloaded: boolean}} LfsFile
 *   One `git lfs ls-files` entry; downloaded: the object is in the local LFS storage.
 * @typedef {{objects: {oid: string, size: string}[], summary: string}} LfsPruneSummary
 */

/** First line of every pointer file (older pointers use hawser / git-media). */
const POINTER_VERSION = /^version https:\/\/(git-lfs\.github\.com\/spec\/v1|hawser\.github\.com\/spec\/v1)\s*$/;

/** Pointer files are small: anything bigger is real content. */
const MAX_POINTER_SIZE = 1024;

/**
 * Reads a pointer file ("version …\noid sha256:<hex>\nsize <n>\n"); null
 * when the text (or buffer) is not one.
 * @param {string|Buffer|null|undefined} data
 * @returns {LfsPointer|null}
 */
function parsePointer(data) {
  if (data === null || data === undefined || data.length > MAX_POINTER_SIZE) return null;
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
  if (!lines.length || !POINTER_VERSION.test(lines[0])) return null;
  let oid = null;
  let size = null;
  for (const l of lines.slice(1)) {
    const m = /^(\S+) (.*)$/.exec(l);
    if (!m) return null;
    if (m[1] === 'oid') {
      const o = /^sha256:([0-9a-f]{64})$/.exec(m[2].trim());
      if (!o) return null;
      oid = o[1];
    } else if (m[1] === 'size') {
      if (!/^\d+$/.test(m[2].trim())) return null;
      size = parseInt(m[2].trim(), 10);
    }
  }
  return oid !== null && size !== null ? { oid, size } : null;
}

/**
 * `git check-attr -z --stdin filter`: path NUL attribute NUL value NUL…
 * Returns the paths whose filter is `lfs`.
 * @param {string} out
 * @returns {Set<string>}
 */
function parseCheckAttrLfs(out) {
  const parts = out.split('\0');
  /** @type {Set<string>} */
  const result = new Set();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 1] === 'filter' && parts[i + 2] === 'lfs') result.add(parts[i]);
  }
  return result;
}

/**
 * `git lfs ls-files --json` ({"files": [{name, oid, size, downloaded…}]}),
 * or the text form "<oid> <*|-> <path>" (with -l: full oid; `*` = the
 * object is downloaded).
 * @param {string} out
 * @returns {LfsFile[]}
 */
function parseLsFiles(out) {
  const text = out.trim();
  if (text.startsWith('{')) {
    try {
      const raw = JSON.parse(text);
      return (Array.isArray(raw.files) ? raw.files : [])
        .filter((f) => f && typeof f.name === 'string' && typeof f.oid === 'string')
        .map((f) => ({ oid: f.oid, path: f.name, size: typeof f.size === 'number' ? f.size : null, downloaded: f.downloaded !== false }));
    } catch {
      return [];
    }
  }
  /** @type {LfsFile[]} */
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{10,64}) ([*-]) (.+)$/.exec(line);
    if (m) files.push({ oid: m[1], path: m[3], size: null, downloaded: m[2] === '*' });
  }
  return files;
}

/**
 * `git lfs locks --json`: [{id, path, owner: {name}, locked_at}].
 * Null when the output is not that list (git-lfs printed an error).
 * @param {string} out
 * @returns {LfsLock[]|null}
 */
function parseLocksJson(out) {
  let raw;
  try {
    raw = JSON.parse(out.trim() || 'null');
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  return raw.filter((l) => l && typeof l.path === 'string').map(lockOf);
}

/**
 * `git lfs locks --verify --json`: {"ours": [...], "theirs": [...]}. Null
 * when the output is not that object.
 * @param {string} out
 * @returns {{ours: LfsLock[], theirs: LfsLock[]}|null}
 */
function parseVerifyLocksJson(out) {
  let raw;
  try {
    raw = JSON.parse(out.trim() || 'null');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ours) || !Array.isArray(raw.theirs)) return null;
  const list = (a) => a.filter((l) => l && typeof l.path === 'string').map(lockOf);
  return { ours: list(raw.ours), theirs: list(raw.theirs) };
}

/** @returns {LfsLock} */
const lockOf = (l) => ({
  id: String(l.id ?? ''),
  path: l.path,
  owner: l.owner && typeof l.owner.name === 'string' ? l.owner.name : '',
  lockedAt: typeof l.locked_at === 'string' ? l.locked_at : '',
});

/**
 * `git lfs track --json` ({"patterns": [{pattern, source, lockable, tracked}]}),
 * or the text listing ("    *.bin [lockable] (.gitattributes)" below
 * "Listing tracked patterns"). Excluded patterns (`!pattern`) are left out.
 * @param {string} out
 * @returns {LfsPattern[]}
 */
function parseTrackList(out) {
  const text = out.trim();
  const norm = (s) => s.replace(/\\/g, '/');
  if (text.startsWith('{')) {
    try {
      const raw = JSON.parse(text);
      return (Array.isArray(raw.patterns) ? raw.patterns : [])
        .filter((p) => p && typeof p.pattern === 'string' && p.tracked !== false && !p.pattern.startsWith('!'))
        .map((p) => ({ pattern: p.pattern, source: norm(typeof p.source === 'string' ? p.source : '.gitattributes'), lockable: !!p.lockable }));
    } catch {
      return [];
    }
  }
  /** @type {LfsPattern[]} */
  const patterns = [];
  let tracked = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^Listing tracked patterns/.test(line)) tracked = true;
    else if (/^Listing excluded patterns/.test(line)) tracked = false;
    else if (tracked) {
      const m = /^\s+(.+?)( \[lockable\])? \(([^)]*)\)\s*$/.exec(line);
      if (m && !m[1].startsWith('!')) patterns.push({ pattern: m[1], source: norm(m[3]), lockable: !!m[2] });
    }
  }
  return patterns;
}

/**
 * `git lfs prune --dry-run --verbose`: the objects that would be removed
 * (" * <oid> (<size>)") and git-lfs's summary line. git-lfs redraws its
 * progress with carriage returns: those count as line breaks.
 * @param {string} out
 * @returns {LfsPruneSummary}
 */
function parsePruneDryRun(out) {
  /** @type {{oid: string, size: string}[]} */
  const objects = [];
  let summary = '';
  for (const raw of out.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    const o = /^\* ([0-9a-f]{64}) \(([^)]*)\)/.exec(line);
    if (o) {
      if (!objects.some((x) => x.oid === o[1])) objects.push({ oid: o[1], size: o[2] });
    } else if (/^prune: /.test(line) && (/would be pruned/.test(line) || !summary)) {
      summary = line.replace(/^prune: /, '').replace(/, done\.?$/, '');
    }
  }
  return { objects, summary };
}

/**
 * Patterns offered by "Track with LFS…" for files: each exact path, `*.<ext>`
 * of their extensions and `<dir>/**` of their folders, without duplicates.
 * @param {string[]} paths repository relative, forward slashes
 * @returns {{pattern: string, kind: 'path'|'extension'|'directory', description: string}[]}
 */
function trackPatternOptions(paths) {
  /** @type {{pattern: string, kind: 'path'|'extension'|'directory', description: string}[]} */
  const out = [];
  const add = (pattern, kind, description) => {
    if (!out.some((o) => o.pattern === pattern)) out.push({ pattern, kind, description });
  };
  for (const p of paths) add(p, 'path', 'this file only');
  for (const p of paths) {
    const name = p.slice(p.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) add(`*${name.slice(dot)}`, 'extension', `every ${name.slice(dot)} file`);
  }
  for (const p of paths) {
    const i = p.lastIndexOf('/');
    if (i > 0) add(`${p.slice(0, i)}/**`, 'directory', `every file below ${p.slice(0, i)}/`);
  }
  return out;
}

/**
 * Regular expression of a gitattributes pattern relative to its folder:
 * without a slash it matches the file name at any depth, with one it is
 * anchored; `*` and `?` stay in one folder, `**` crosses folders, `[…]`
 * classes (also `[[:space:]]`) are kept.
 * @param {string} pattern
 */
function attrPatternRegex(pattern) {
  const anchored = pattern.includes('/');
  const p = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slashAfter = p[i + 2] === '/';
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && slashAfter) {
          re += '(?:.*/)?';
          i += 2;
        } else if (atStart && i + 2 === p.length) {
          re += '.*';
          i += 1;
        } else {
          re += '[^/]*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      // Closing bracket of the class; [:name:] inside it is one unit.
      let j = i + 1;
      if (p[j] === '!' || p[j] === '^') j++;
      if (p[j] === ']') j++;
      while (j < p.length && p[j] !== ']') {
        const k = p[j] === '[' && p[j + 1] === ':' ? p.indexOf(':]', j + 2) : -1;
        j = k < 0 ? j + 1 : k + 2;
      }
      if (j >= p.length) {
        re += '\\[';
        continue;
      }
      let body = p.slice(i + 1, j);
      const negate = body[0] === '!' || body[0] === '^';
      if (negate) body = body.slice(1);
      body = body.replace(/\\/g, '\\\\').replace(/\[:space:\]/g, '\\s').replace(/\[:alpha:\]/g, 'A-Za-z')
        .replace(/\[:digit:\]/g, '0-9').replace(/\[:alnum:\]/g, 'A-Za-z0-9');
      re += `[${negate ? '^' : ''}${body}]`;
      i = j;
    } else if (c === '\\' && i + 1 < p.length) {
      re += p[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i++;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re}$`);
}

/**
 * Whether a tracked pattern covers `file`. A pattern read from a nested
 * .gitattributes is listed by git-lfs with its folder prepended
 * ("sub/*.dat" for "*.dat" in sub/.gitattributes): it applies below that folder.
 * @param {LfsPattern} p
 * @param {string} file repository relative, forward slashes
 */
function patternMatches(p, file) {
  const source = p.source.replace(/\\/g, '/');
  const dir = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
  let pattern = p.pattern;
  let rel = file;
  if (dir) {
    if (!file.startsWith(`${dir}/`)) return false;
    rel = file.slice(dir.length + 1);
    if (pattern.startsWith(`${dir}/`)) pattern = pattern.slice(dir.length + 1);
  }
  try {
    return attrPatternRegex(pattern).test(rel);
  } catch {
    return false;
  }
}

/**
 * The tracked patterns covering any of `files`.
 * @param {LfsPattern[]} patterns
 * @param {string[]} files
 */
function patternsFor(patterns, files) {
  return patterns.filter((p) => files.some((f) => patternMatches(p, f)));
}

/**
 * .gitattributes text without the LFS line(s) of `pattern` (for patterns of
 * nested .gitattributes files, which `git lfs untrack` does not edit).
 * Other attributes and lines are kept as they are.
 * @param {string} text
 * @param {string} pattern as written in that file
 */
function removeAttrPattern(text, pattern) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((l) => {
    const m = /^\s*(\S+)\s+(.*)$/.exec(l);
    return !(m && m[1] === pattern && /(^|\s)filter=lfs(\s|$)/.test(m[2]));
  });
  return kept.join(eol);
}

/** Lines of git's / git-lfs's output that come from LFS (push hook, batch API, smudge). */
const LFS_LINE = /git-lfs|\bLFS\b|lfs\/|batch response|smudge|locks? (?:verify|owned)|pre-push hook/i;

/** Whether an error text (e.g. the stderr of a failed push) comes from Git LFS. @param {string} text */
const isLfsError = (text) => LFS_LINE.test(text || '');

/** The LFS lines of an error text, for a short message. @param {string} text */
const lfsErrorLines = (text) => (text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && LFS_LINE.test(l));

/** "1.2 MB" for a byte count. @param {number} n */
function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/**
 * Text shown for one side of an LFS diff: the pointer and whether the
 * object is in the local storage.
 * @param {LfsPointer|null} p
 * @param {{label: string, present?: boolean|null, note?: string}} o
 */
function describePointer(p, o) {
  if (!p) return `${o.label}\n\n${o.note || '(no Git LFS pointer)'}\n`;
  const local = o.present === undefined || o.present === null ? '' : o.present ? 'present locally' : 'not downloaded (LFS ▸ Pull)';
  return [
    o.label,
    '',
    `oid sha256:${p.oid}`,
    `size ${p.size} (${formatSize(p.size)})`,
    local ? `object ${local}` : null,
    o.note || null,
    '',
  ].filter((l) => l !== null).join('\n');
}

/**
 * Tooltip line of a locked file: "Locked by Ann (you) since 2026-10-21 14:03".
 * @param {LfsLock} l
 */
function describeLock(l) {
  const when = l.lockedAt && !Number.isNaN(Date.parse(l.lockedAt)) ? ` since ${l.lockedAt.slice(0, 16).replace('T', ' ')}` : '';
  return `Locked by ${l.owner || 'unknown user'}${l.mine ? ' (you)' : ''}${when}`;
}

module.exports = {
  parsePointer, parseCheckAttrLfs, parseLsFiles, parseLocksJson, parseVerifyLocksJson, parseTrackList, parsePruneDryRun,
  trackPatternOptions, attrPatternRegex, patternMatches, patternsFor, removeAttrPattern, isLfsError, lfsErrorLines,
  formatSize, describePointer, describeLock,
};
