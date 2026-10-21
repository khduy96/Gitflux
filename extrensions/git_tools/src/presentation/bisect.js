// @ts-check
'use strict';

const vscode = require('vscode');
const { GitError } = require('../domain/errors');
const { firstBadInOutput, describeBisectProgress } = require('../domain/logic/bisect');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('./logView').LogViewProvider} LogViewProvider */

const MARK_WORD = { good: 'good', bad: 'bad', skip: 'skipped' };

/**
 * Turns git's refusal to check out the next commit into a clear message.
 * @param {any} e
 */
function explain(e) {
  if (e instanceof GitError && /would be overwritten|commit your changes or stash them|local changes/i.test(e.message)) {
    return new Error('Bisect cannot check out the next commit to test: your local changes would be overwritten. ' +
      'Commit, stash or shelve them, then mark the commit again.');
  }
  return e;
}

/**
 * Shows where the session stands after a mark: the first bad commit once
 * git found it (the session stays until Reset), otherwise git's
 * "Bisecting: N revisions left" line.
 * @param {RepoModel} m
 * @param {LogViewProvider} logView
 * @param {string} output
 */
async function report(m, logView, output) {
  const found = firstBadInOutput(output) || (m.bisect && m.bisect.firstBad);
  if (found) {
    const c = await m.repo.commitInfo(found);
    const r = await vscode.window.showInformationMessage(
      `${found.slice(0, 8)} is the first bad commit${c ? `: ${c.subject}` : ''}`, 'Show in Log', 'Reset Bisect');
    if (r === 'Show in Log') await logView.showCommit(found);
    else if (r === 'Reset Bisect') await bisectReset(m);
    return;
  }
  const line = output.split(/\r?\n/).find((l) => /^Bisecting: /.test(l)) || (m.bisect ? describeBisectProgress(
    m.bisect.remaining === null ? null : { remaining: m.bisect.remaining, steps: m.bisect.steps || 0 }) : '');
  if (line) vscode.window.setStatusBarMessage(`$(debug-alt) ${line}`, 6000);
}

/**
 * Marks `hash` (the commit checked out when omitted) good, bad or skipped,
 * starting a bisect session first when none is in progress.
 * @param {RepoModel} m
 * @param {LogViewProvider} logView
 * @param {'good'|'bad'|'skip'} mark
 * @param {string} [hash]
 */
async function bisectMark(m, logView, mark, hash) {
  const starting = !m.bisect;
  const what = hash ? hash.slice(0, 8) : 'current commit';
  let output = '';
  const ok = await m.run(`${starting ? 'Start bisect: ' : 'Bisect: '}mark ${what} ${MARK_WORD[mark]}`, async () => {
    try {
      output = await m.repo.bisectMark(mark, hash);
    } catch (e) {
      throw explain(e);
    }
  });
  if (!ok) return;
  if (starting && !(m.bisect && m.bisect.bad && m.bisect.good.length)) {
    vscode.window.showInformationMessage(
      `Bisect started: ${what} is ${MARK_WORD[mark]}. Now mark a ${mark === 'good' ? 'bad' : 'good'} commit in the Log (Bisect ▸ Mark ${mark === 'good' ? 'Bad' : 'Good'}).`);
    return;
  }
  await report(m, logView, output);
}

/** Ends the session and checks out the branch it started from. @param {RepoModel} m */
async function bisectReset(m) {
  if (!m.bisect) return vscode.window.showInformationMessage('No bisect in progress.');
  const start = m.bisect.start;
  return m.run('Reset bisect', () => m.repo.bisectReset(), { success: `Bisect ended${start ? `, back on ${start.length === 40 ? start.slice(0, 8) : start}` : ''}` });
}

/**
 * `git bisect run`: git tests every commit with a command (exit 0 good,
 * 125 skip, other bad); the output goes to the Git console.
 * @param {RepoModel} m
 * @param {LogViewProvider} logView
 */
async function bisectRun(m, logView) {
  if (!m.bisect || !m.bisect.bad || !m.bisect.good.length) {
    vscode.window.showInformationMessage('Mark a good and a bad commit first: git bisect run needs both.');
    return;
  }
  const command = await vscode.window.showInputBox({
    title: 'Bisect: Run Script',
    prompt: 'Shell command run on each commit: exit code 0 = good, 125 = skip, anything else = bad',
    placeHolder: 'e.g. npm test   or   ./check.sh',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : 'Enter a command'),
  });
  if (!command) return;
  m.output.show(true);
  let result = { code: 0, output: '' };
  await m.run('Bisect run', async () => {
    result = await m.repo.bisectRun(command.trim());
  });
  if (firstBadInOutput(result.output)) return report(m, logView, result.output);
  vscode.window.showWarningMessage(`git bisect run stopped without a result (exit code ${result.code}).`, 'Show Console')
    .then((r) => { if (r) m.output.show(true); });
}

/**
 * Handles a Bisect action from the Log menu, the Commit view banner or the
 * command palette.
 * @param {RepoModel} m
 * @param {LogViewProvider} logView
 * @param {'good'|'bad'|'skip'|'reset'|'run'} action
 * @param {string} [hash] commit of the Log row (the checked out one when omitted)
 */
function bisectAction(m, logView, action, hash) {
  switch (action) {
    case 'good':
    case 'bad':
    case 'skip':
      return bisectMark(m, logView, action, hash);
    case 'reset':
      return bisectReset(m);
    case 'run':
      return bisectRun(m, logView);
  }
}

/**
 * Banner data for the Commit view, or null when no bisect is in progress.
 * @param {RepoModel} m
 */
function bisectBanner(m) {
  const b = m.bisect;
  if (!b) return null;
  return {
    title: b.firstBad ? 'Bisect finished' : describeBisectProgress(b.remaining === null ? null : { remaining: b.remaining, steps: b.steps || 0 }),
    current: b.head ? `${b.head.slice(0, 8)} ${b.headSubject}` : '',
    firstBad: b.firstBad ? `${b.firstBad.slice(0, 8)} ${b.firstBadSubject}` : null,
    firstBadHash: b.firstBad,
    canRun: !!(b.bad && b.good.length && !b.firstBad),
  };
}

module.exports = { bisectAction, bisectMark, bisectReset, bisectRun, bisectBanner };
