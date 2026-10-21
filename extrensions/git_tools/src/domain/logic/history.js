// @ts-check
'use strict';

/**
 * History tools: Log filters (user, date, content search), reflog subjects
 * and the sides of a commit comparison. Pure functions, no git.
 *
 * @typedef {{kind: 'me'}|{kind: 'text', text: string}} UserFilter
 *   'me' = the configured user.name / user.email; 'text' = substring of the author name or email.
 * @typedef {{preset: DatePreset}|{from?: string, to?: string}} DateFilter
 *   from / to: YYYY-MM-DD (local time, both days included), either optional.
 * @typedef {'24h'|'7d'|'30d'} DatePreset
 * @typedef {{text: string, regex: boolean}} ContentSearch
 *   Commits whose changes contain `text` (git log -S), or match the regex (-G).
 * @typedef {{branch: string|null, path: string|null, user: UserFilter|null, date: DateFilter|null,
 *   search: ContentSearch|null}} LogFilter
 * @typedef {{name: string, emails: string[], count: number}} AuthorEntry
 */

/** @type {{id: DatePreset, label: string, since: string}[]} */
const DATE_PRESETS = [
  { id: '24h', label: 'Last 24 hours', since: '24.hours.ago' },
  { id: '7d', label: 'Last 7 days', since: '7.days.ago' },
  { id: '30d', label: 'Last 30 days', since: '30.days.ago' },
];

/** Shortest content search git is asked for. */
const MIN_SEARCH = 2;

/** @returns {LogFilter} */
const emptyLogFilter = () => ({ branch: null, path: null, user: null, date: null, search: null });

/**
 * Filters git applies to the commits themselves (not the revisions walked):
 * the graph cannot be drawn when they are active.
 * @param {Partial<LogFilter>} f
 */
const hasCommitFilter = (f) => !!(f.user || f.date || (f.search && f.search.text));

/** Escapes a literal for a POSIX basic regular expression (git log --basic-regexp). */
const escapeBasicRegex = (s) => s.replace(/[\\.*[\]^$]/g, '\\$&');
/** YYYY-MM-DD of a real calendar day. */
function isDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/**
 * --since / --until values of a date filter. Custom days cover the whole
 * day in local time.
 * @param {DateFilter|null} date
 * @returns {{since?: string, until?: string}}
 */
function dateBounds(date) {
  if (!date) return {};
  if ('preset' in date) {
    const p = DATE_PRESETS.find((x) => x.id === date.preset);
    return p ? { since: p.since } : {};
  }
  /** @type {{since?: string, until?: string}} */
  const out = {};
  if (date.from && isDay(date.from)) out.since = `${date.from} 00:00:00`;
  if (date.to && isDay(date.to)) out.until = `${date.to} 23:59:59`;
  return out;
}

/**
 * Author substrings of a user filter (git ORs several --author).
 * Null when the filter cannot be applied ("Me" without user.name / user.email).
 * @param {UserFilter|null} user
 * @param {{name: string, email: string}} [me]
 * @returns {string[]|null}
 */
function authorPatterns(user, me) {
  if (!user) return [];
  if (user.kind === 'me') {
    const list = [me && me.name, me && me.email].filter((x) => x && x.trim()).map((x) => /** @type {string} */ (x).trim());
    return list.length ? list : null;
  }
  const t = user.text.trim();
  return t ? [t] : [];
}

/**
 * Options for GitRepository.log() from a Log filter.
 * @param {LogFilter} f
 * @param {{name: string, email: string}} [me]
 */
function logQuery(f, me) {
  const search = f.search && f.search.text.length >= MIN_SEARCH ? f.search : undefined;
  return {
    revisions: f.branch ? [f.branch] : undefined,
    path: f.path || undefined,
    authors: authorPatterns(f.user, me) || [],
    ...dateBounds(f.date),
    search,
  };
}

/**
 * Distinct authors of the loaded commits, most commits first. Authors are
 * grouped by name (case-insensitive); the most used spelling is shown.
 * @param {{author: string, email: string}[]} commits
 * @returns {AuthorEntry[]}
 */
function buildAuthorList(commits) {
  /** @type {Map<string, {spellings: Map<string, number>, emails: Set<string>, count: number}>} */
  const byKey = new Map();
  for (const c of commits) {
    const name = (c.author || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { spellings: new Map(), emails: new Set(), count: 0 }));
    e.count++;
    e.spellings.set(name, (e.spellings.get(name) || 0) + 1);
    if (c.email) e.emails.add(c.email);
  }
  return [...byKey.values()]
    .map((e) => ({
      name: [...e.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      emails: [...e.emails],
      count: e.count,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Splits a reflog subject into its action and message at the first ": ",
 * e.g. "commit (amend): fix: typo" → "commit (amend)" / "fix: typo".
 * Line breaks (never written by git, but tolerated) become spaces.
 * @param {string} subject
 */
function splitReflogSubject(subject) {
  const s = subject.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const i = s.indexOf(': ');
  if (i < 0) return s.endsWith(':') ? { action: s.slice(0, -1), message: '' } : { action: s, message: '' };
  return { action: s.slice(0, i), message: s.slice(i + 2) };
}

/**
 * Orders two commits for a comparison: the one with the earlier committer
 * date first; a tie keeps the given order (the caller puts the ancestor first).
 * @template {{commitTime: number}} T
 * @param {T} a
 * @param {T} b
 * @returns {[T, T]}
 */
const olderFirst = (a, b) => (b.commitTime < a.commitTime ? [b, a] : [a, b]);

module.exports = {
  DATE_PRESETS, MIN_SEARCH, emptyLogFilter, hasCommitFilter, escapeBasicRegex, isDay, dateBounds, authorPatterns,
  logQuery, buildAuthorList, splitReflogSubject, olderFirst,
};
