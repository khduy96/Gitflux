// Quick actions: recent branches, WIP, undo of the last action, copy formats, branch prefixes, line history,
// merged branches and inline blame. Run: node --test test/quickActions.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const {
  parseCheckoutMove, recentBranches, isWipSubject, wipMessage, undoPlan, commitCopyText, branchNameSuggestions,
  parseLineLog, cleanupCandidates,
} = require('../src/domain/logic/quickActions');
const { inlineBlameText, relativeTime } = require('../src/domain/logic/blame');

const FS = '\x1f';
const RS = '\x1e';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_quick_'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  };
  const commit = (msg, file = `${msg.replace(/\W+/g, '_')}.txt`, content = `${msg}\n`) => {
    write(file, content);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, write, commit, repo: new Repository(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Reflog entry as Repository.reflog returns it. */
const entry = (action, message, hash = 'a'.repeat(40), index = 0) => ({
  selector: `HEAD@{${index}}`, index, hash, action, message, time: null, missing: false,
});
/** Entries newest first, numbered. */
const reflog = (...list) => list.map((e, i) => ({ ...e, index: i, selector: `HEAD@{${i}}` }));

// ---------------------------------------------------------------- pure

test('parseCheckoutMove reads checkout / switch messages only', () => {
  assert.deepEqual(parseCheckoutMove('moving from main to feature/x'), { from: 'main', to: 'feature/x' });
  assert.equal(parseCheckoutMove('Fast-forward'), null);
});

test('recentBranches: most recent first, current and unknown names left out', () => {
  const entries = reflog(
    entry('checkout', 'moving from feat to main'),
    entry('commit', 'work'),
    entry('checkout', 'moving from old to feat'),
    entry('checkout', 'moving from 1234abcd to old'),
    entry('checkout', 'moving from gone to 1234abcd'),
  );
  assert.deepEqual(recentBranches(entries, ['main', 'feat', 'old'], 'main'), ['feat', 'old']);
  assert.deepEqual(recentBranches(entries, ['main', 'feat', 'old'], 'main', 1), ['feat']);
  assert.deepEqual(recentBranches([], ['main'], 'main'), []);
});

test('isWipSubject / wipMessage', () => {
  assert.ok(isWipSubject('WIP on main (2024-01-02 03:04) [skip ci]'));
  assert.ok(isWipSubject('wip: parser'));
  assert.ok(isWipSubject('--wip-- [skip ci]'));
  assert.ok(!isWipSubject('Wipe the cache'));
  assert.ok(!isWipSubject('Fix WIP handling'));
  const msg = wipMessage('feat', new Date(2024, 0, 2, 3, 4));
  assert.equal(msg, 'WIP on feat (2024-01-02 03:04) [skip ci]');
  assert.ok(isWipSubject(msg));
  assert.ok(wipMessage(null).startsWith('WIP ('));
});

test('undoPlan: commit and amend are soft, merge / pull / reset keep, checkout goes back', () => {
  const h = (c) => c.repeat(40);
  assert.deepEqual(undoPlan(reflog(entry('commit', 'two', h('b')), entry('commit', 'one', h('a')))),
    { kind: 'soft', action: 'commit', message: 'two', target: h('a'), undone: 1 });
  assert.equal(undoPlan(reflog(entry('commit (amend)', 'x', h('c')), entry('commit', 'x', h('b')))).kind, 'soft');
  for (const action of ['merge feat', 'commit (merge)', 'pull', 'reset', 'cherry-pick', 'revert', 'pull --rebase']) {
    const p = /** @type {any} */ (undoPlan(reflog(entry(action, 'm', h('c')), entry('commit', 'x', h('b')))));
    assert.equal(p.kind, 'keep', action);
    assert.equal(p.target, h('b'), action);
  }
  assert.deepEqual(undoPlan(reflog(entry('checkout', 'moving from feat to main', h('c')), entry('commit', 'x', h('b')))),
    { kind: 'checkout', action: 'checkout', message: 'moving from feat to main', target: h('b'), undone: 1, checkout: 'feat' });
});

test('undoPlan: a finished rebase goes back to before its start', () => {
  const h = (c) => c.repeat(40);
  const p = /** @type {any} */ (undoPlan(reflog(
    entry('rebase (finish)', 'returning to refs/heads/feat', h('e')),
    entry('rebase (pick)', 'two', h('d')),
    entry('rebase (pick)', 'one', h('c')),
    entry('rebase (start)', 'checkout main', h('b')),
    entry('commit', 'two', h('a')),
    entry('rebase (start)', 'older', h('9')),
  )));
  assert.equal(p.kind, 'keep');
  assert.equal(p.target, h('a'));
  assert.equal(p.undone, 4);
  const pull = /** @type {any} */ (undoPlan(reflog(
    entry('pull --rebase (finish)', 'returning to refs/heads/main', h('e')),
    entry('pull --rebase (start)', 'checkout x', h('d')),
    entry('commit', 'local', h('c')),
  )));
  assert.equal(pull.target, h('c'));
});

test('undoPlan refuses what it cannot undo', () => {
  const h = 'a'.repeat(40);
  assert.ok('unsupported' in undoPlan([]));
  assert.ok('unsupported' in undoPlan(reflog(entry('commit (initial)', 'first', h))));
  assert.ok('unsupported' in undoPlan(reflog(entry('commit', 'only one entry', h))));
  assert.ok('unsupported' in undoPlan(reflog(entry('rebase (pick)', 'x', h), entry('rebase (start)', 'y', h), entry('commit', 'z', h))));
  assert.ok('unsupported' in undoPlan(reflog(entry('rebase (finish)', 'x', h), entry('commit', 'z', h))));
  assert.ok('unsupported' in undoPlan(reflog(entry('something new', 'x', h), entry('commit', 'z', h))));
});

test('commitCopyText formats', () => {
  const cs = [{ hash: '1'.repeat(40), subject: 'First' }, { hash: '2'.repeat(40), subject: 'Second' }];
  assert.equal(commitCopyText('full', cs), `${'1'.repeat(40)} ${'2'.repeat(40)}`);
  assert.equal(commitCopyText('short', cs), '11111111\n22222222');
  assert.equal(commitCopyText('subject', cs), 'First\nSecond');
  assert.equal(commitCopyText('shortSubject', cs.slice(0, 1)), '11111111 First');
  assert.equal(commitCopyText('message', cs, new Map([['1'.repeat(40), 'First\n\nBody']])), 'First\n\nBody\n\nSecond');
});

test('branchNameSuggestions: each prefix, the last used first, as typed when it has one', () => {
  const prefixes = ['feature/', 'bugfix', 'hotfix/'];
  assert.deepEqual(branchNameSuggestions('', prefixes), []);
  assert.deepEqual(branchNameSuggestions(' login ', prefixes).map((s) => s.name),
    ['feature/login', 'bugfix/login', 'hotfix/login', 'login']);
  assert.deepEqual(branchNameSuggestions('login', prefixes, 'hotfix/').map((s) => s.name),
    ['hotfix/login', 'feature/login', 'bugfix/login', 'login']);
  assert.deepEqual(branchNameSuggestions('login', prefixes, '').map((s) => s.name)[0], 'login');
  assert.deepEqual(branchNameSuggestions('bugfix/crash', prefixes), [{ name: 'bugfix/crash', prefix: 'bugfix/' }]);
  assert.deepEqual(branchNameSuggestions('team/x', prefixes), [{ name: 'team/x', prefix: 'team/' }]);
});

test('parseLineLog: commits, paths before / after and changed lines', () => {
  const out = [
    `${RS}${'b'.repeat(40)}${FS}${'a'.repeat(40)}${FS}Jane${FS}1700000000${FS}Change${FS}it\n\n`,
    'diff --git a/old.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -2,1 +2,1 @@\n-before\n+after\n',
    `${RS}${'a'.repeat(40)}${FS}${FS}Joe${FS}1600000000${FS}Create\n\n`,
    'diff --git a/old.txt b/old.txt\n--- /dev/null\n+++ b/old.txt\n@@ -0,0 +2,1 @@\n+before\n',
  ].join('');
  const list = parseLineLog(out);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    hash: 'b'.repeat(40), parents: ['a'.repeat(40)], author: 'Jane', time: 1700000000000, subject: `Change${FS}it`,
    path: 'new.txt', oldPath: 'old.txt', added: ['after'], removed: ['before'],
  });
  assert.deepEqual([list[1].parents, list[1].path, list[1].oldPath, list[1].added], [[], 'old.txt', null, ['before']]);
});

test('cleanupCandidates: merged or gone, never current, base or checked out elsewhere', () => {
  const b = (name, o = {}) => ({ name, remote: false, hash: '', current: false, upstream: null, ahead: 0, behind: 0, gone: false, ...o });
  const branches = [
    b('main'), b('cur', { current: true }), b('done'), b('squashed', { gone: true, ahead: 2 }), b('wip'), b('wt'),
    b('origin/done', { remote: true }),
  ];
  const list = cleanupCandidates(branches, new Set(['main', 'cur', 'done', 'wt']), 'main', new Set(['wt']));
  assert.deepEqual(list.map((x) => [x.branch.name, x.merged, x.gone]), [['done', true, false], ['squashed', false, true]]);
});

test('inlineBlameText and relativeTime', () => {
  const now = Date.UTC(2024, 0, 10);
  const c = { hash: 'a'.repeat(40), author: 'Jane', email: '', time: now - 3 * 86400000, summary: 'Fix the parser', previous: null, filename: 'a', uncommitted: false };
  assert.equal(inlineBlameText(c, now), 'Jane, 3 days ago • Fix the parser');
  assert.equal(inlineBlameText({ ...c, summary: 'x'.repeat(80) }, now, 10), `Jane, 3 days ago • ${'x'.repeat(9)}…`);
  assert.equal(inlineBlameText({ ...c, uncommitted: true }, now), 'You • Not Committed Yet');
  assert.equal(relativeTime(now - 5000, now), 'just now');
  assert.equal(relativeTime(now - 3600 * 1000, now), '1 hour ago');
});

// ---------------------------------------------------------------- git

test('reflog of real operations: undoPlan targets the state before each of them', async (t) => {
  const r = setup();
  t.after(r.cleanup);
  const one = r.commit('one');
  const two = r.commit('two');
  let plan = /** @type {any} */ (undoPlan(await r.repo.reflog()));
  assert.deepEqual([plan.kind, plan.target], ['soft', one]);

  r.write('two.txt', 'amended\n');
  r.git('commit', '-q', '-a', '--amend', '--no-edit');
  plan = undoPlan(await r.repo.reflog());
  assert.deepEqual([plan.kind, plan.target], ['soft', two]);
  const amended = r.git('rev-parse', 'HEAD');

  r.git('checkout', '-q', '-b', 'feat');
  r.commit('feat 1');
  r.commit('feat 2');
  r.git('checkout', '-q', 'main');
  plan = undoPlan(await r.repo.reflog());
  assert.deepEqual([plan.kind, plan.checkout], ['checkout', 'feat']);
  assert.deepEqual(recentBranches(await r.repo.reflog(), ['main', 'feat'], 'main'), ['feat']);
  assert.deepEqual(await r.repo.previousCheckout(), { name: 'feat', hash: r.git('rev-parse', 'feat') });

  r.commit('main 3');
  const beforeMerge = r.git('rev-parse', 'HEAD');
  r.git('merge', '-q', '--no-edit', 'feat');
  plan = undoPlan(await r.repo.reflog());
  assert.deepEqual([plan.kind, plan.target], ['keep', beforeMerge]);
  await r.repo.reset(plan.target, 'keep');
  assert.equal(r.git('rev-parse', 'HEAD'), beforeMerge);

  r.git('checkout', '-q', 'feat');
  const featTip = r.git('rev-parse', 'HEAD');
  r.git('rebase', '-q', 'main');
  plan = undoPlan(await r.repo.reflog());
  assert.deepEqual([plan.kind, plan.target], ['keep', featTip]);

  r.git('reset', '-q', '--hard', amended);
  plan = undoPlan(await r.repo.reflog());
  assert.equal(plan.kind, 'keep');
  assert.notEqual(plan.target, amended);
});

test('wipCommit takes untracked files, a mixed reset brings them back', async (t) => {
  const r = setup();
  t.after(r.cleanup);
  r.commit('base', 'a.txt', 'a\n');
  r.git('config', 'core.hooksPath', path.join(r.dir, 'hooks'));
  r.write('hooks/pre-commit', '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(r.dir, 'hooks/pre-commit'), 0o755);
  r.write('a.txt', 'changed\n');
  r.write('new.txt', 'new\n');
  await r.repo.wipCommit(wipMessage('main'));
  assert.ok(isWipSubject(r.git('log', '-1', '--format=%s')));
  assert.equal(r.git('status', '--porcelain', '--', 'a.txt', 'new.txt'), '');
  await r.repo.reset('HEAD~1', 'mixed');
  assert.equal(r.git('log', '-1', '--format=%s'), 'base');
  // Unstaged again (" M", the helper trims the leading space of the output).
  assert.deepEqual(r.git('status', '--porcelain', '--', 'a.txt', 'new.txt').split('\n').sort(), ['?? new.txt', 'M a.txt']);
  assert.equal(r.git('diff', '--cached', '--name-only'), '');
});

test('wipCommit leaves excluded nested repositories out', async (t) => {
  const r = setup();
  t.after(r.cleanup);
  r.commit('base', 'a.txt', 'a\n');
  fs.mkdirSync(path.join(r.dir, 'nested'));
  execFileSync('git', ['init', '-q'], { cwd: path.join(r.dir, 'nested') });
  r.write('nested/x.txt', 'x\n');
  r.write('b.txt', 'b\n');
  await r.repo.wipCommit('WIP', ['nested']);
  assert.equal(r.git('show', '--name-only', '--format=', 'HEAD'), 'b.txt');
  assert.equal(r.git('status', '--porcelain'), '?? nested/');
});

test('headPushed follows the upstream', async (t) => {
  const r = setup();
  t.after(r.cleanup);
  r.commit('one');
  assert.equal(await r.repo.headPushed(), false);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_quick_remote_'));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--bare', remote]);
  r.git('remote', 'add', 'origin', remote);
  r.git('push', '-q', '-u', 'origin', 'main');
  assert.equal(await r.repo.headPushed(), true);
  r.commit('two');
  assert.equal(await r.repo.headPushed(), false);
});

test('lineHistory follows the lines through a rename', async (t) => {
  const r = setup();
  t.after(r.cleanup);
  r.commit('one', 'f.txt', 'a\nb\nc\n');
  r.commit('two', 'f.txt', 'a\nB\nc\n');
  r.git('mv', 'f.txt', 'g.txt');
  r.git('commit', '-q', '-m', 'rename');
  r.commit('four', 'g.txt', 'a\nBB\nc\n');
  r.commit('other line', 'g.txt', 'A\nBB\nc\n');
  const list = await r.repo.lineHistory('g.txt', 2, 2);
  assert.deepEqual(list.map((e) => e.subject), ['four', 'two', 'one']);
  assert.deepEqual([list[0].path, list[0].added, list[0].removed], ['g.txt', ['BB'], ['B']]);
  assert.deepEqual([list[1].path, list[1].oldPath], ['f.txt', 'f.txt']);
  assert.equal(list[2].oldPath, null);
});

test('mergedBranches and blame of one line', async (t) => {
  const r = setup();
  t.after(r.cleanup);
  r.commit('one', 'f.txt', 'a\nb\n');
  r.git('branch', 'done');
  r.git('checkout', '-q', '-b', 'open');
  r.commit('open work');
  r.git('checkout', '-q', 'main');
  r.commit('two', 'f.txt', 'a\nB\n');
  assert.deepEqual((await r.repo.mergedBranches('main')).sort(), ['done', 'main']);
  const blame = await r.repo.blame('f.txt', undefined, { start: 2, end: 2 });
  assert.equal(blame.lines.length, 1);
  assert.equal(blame.commits.get(blame.lines[0].hash)?.summary, 'two');
  const dirty = await r.repo.blame('f.txt', 'a\nB\nnew\n', { start: 3, end: 3 });
  assert.equal(dirty.commits.get(dirty.lines[0].hash)?.uncommitted, true);
});

test('lastHeadAction / lastCommitMessage: a commit made in a terminal is told from a checkout', async () => {
  const r = setup();
  try {
    assert.equal(await r.repo.lastHeadAction(), null);
    r.commit('Nội dung đầu tiên');
    assert.equal(await r.repo.lastHeadAction(), 'commit (initial)');
    r.commit('Nội dung thứ hai');
    assert.equal(await r.repo.lastHeadAction(), 'commit');
    assert.equal(await r.repo.lastCommitMessage(), 'Nội dung thứ hai');
    r.git('commit', '-q', '--amend', '-m', 'Sửa lại');
    assert.equal(await r.repo.lastHeadAction(), 'commit (amend)');
    r.git('checkout', '-q', '-b', 'other');
    r.git('checkout', '-q', 'HEAD~1');
    assert.equal(await r.repo.lastHeadAction(), 'checkout');
  } finally {
    r.cleanup();
  }
});
