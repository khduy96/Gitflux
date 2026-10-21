// @ts-check
'use strict';

/**
 * Bisect: the marks of a session (refs/bisect/*, BISECT_LOG), the progress
 * `git rev-list --bisect-vars` computes and the result git prints. Pure
 * functions, no git.
 *
 * @typedef {import('../entities').BisectMark} BisectMark
 */

/**
 * Marks of the refs under refs/bisect/ (`for-each-ref
 * --format=%(refname) %(objectname)`): bad, good-<hash>, skip-<hash>.
 * @param {string} out
 * @returns {{bad: string|null, good: string[], skipped: string[]}}
 */
function parseBisectRefs(out) {
  const r = { bad: /** @type {string|null} */ (null), good: /** @type {string[]} */ ([]), skipped: /** @type {string[]} */ ([]) };
  for (const line of out.split(/\r?\n/)) {
    const m = /^refs\/bisect\/(\S+) ([0-9a-f]{7,64})$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'bad') r.bad = m[2];
    else if (m[1].startsWith('good-')) r.good.push(m[2]);
    else if (m[1].startsWith('skip-')) r.skipped.push(m[2]);
  }
  return r;
}

/**
 * Commit → mark, for the Log labels. A commit marked twice keeps the last
 * kind given (bad wins over good: git keeps one bad ref).
 * @param {{bad: string|null, good: string[], skipped: string[]}} refs
 * @returns {Record<string, BisectMark>}
 */
function bisectMarks(refs) {
  /** @type {Record<string, BisectMark>} */
  const marks = {};
  for (const h of refs.skipped) marks[h] = 'skip';
  for (const h of refs.good) marks[h] = 'good';
  if (refs.bad) marks[refs.bad] = 'bad';
  return marks;
}

/**
 * Parses BISECT_LOG: the marks given (`git bisect good|bad|skip <hash>…`)
 * and the result git records ("# first bad commit: [<hash>] <subject>").
 * @param {string} text
 * @returns {{good: string[], bad: string[], skipped: string[], firstBad: string|null, firstBadSubject: string}}
 */
function parseBisectLog(text) {
  const r = { good: [], bad: [], skipped: [], firstBad: null, firstBadSubject: '' };
  for (const line of text.split(/\r?\n/)) {
    const first = /^# first bad commit: \[([0-9a-f]{7,64})\] ?(.*)$/.exec(line);
    if (first) {
      r.firstBad = first[1];
      r.firstBadSubject = first[2];
      continue;
    }
    const mark = /^git bisect (good|bad|skip|old|new) (.+)$/.exec(line.trim());
    if (!mark) continue;
    const list = { good: r.good, old: r.good, bad: r.bad, new: r.bad, skip: r.skipped }[mark[1]];
    list.push(...mark[2].split(/\s+/).filter(Boolean));
  }
  return r;
}

/**
 * `git rev-list --bisect-vars` output: the commits left to test after the
 * current one and the steps.
 * @param {string} out
 * @returns {{remaining: number, steps: number, next: string|null}|null}
 */
function parseBisectVars(out) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^bisect_(\w+)='?([^']*)'?$/.exec(line.trim());
    if (m) vars[m[1]] = m[2];
  }
  if (!('nr' in vars)) return null;
  return {
    remaining: parseInt(vars.nr, 10) || 0,
    steps: parseInt(vars.steps, 10) || 0,
    next: vars.rev && /^[0-9a-f]{7,64}$/.test(vars.rev) ? vars.rev : null,
  };
}

/** "<hash> is the first bad commit" in git bisect output, or null. @param {string} out */
function firstBadInOutput(out) {
  const m = /^([0-9a-f]{7,64}) is the first (?:bad|new) commit$/m.exec(out);
  return m ? m[1] : null;
}

/**
 * Banner title: "Bisecting: ~3 revisions left (~2 steps)".
 * @param {{remaining: number, steps: number}|null} progress
 */
function describeBisectProgress(progress) {
  if (!progress) return 'Bisecting: mark a good and a bad commit';
  const n = progress.remaining;
  const s = progress.steps;
  return `Bisecting: ~${n} revision${n === 1 ? '' : 's'} left (~${s} step${s === 1 ? '' : 's'})`;
}

module.exports = { parseBisectRefs, bisectMarks, parseBisectLog, parseBisectVars, firstBadInOutput, describeBisectProgress };
