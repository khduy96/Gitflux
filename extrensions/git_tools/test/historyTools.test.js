// Reflog, Log filters (user, date, content search) and Compare Commits: parsing and temporary
// repositories. Run: node --test test/historyTools.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository, parseReflog } = require('../src/data/gitRepository');
const {
  splitReflogSubject, buildAuthorList, dateBounds, escapeBasicRegex, authorPatterns, logQuery, olderFirst,
  hasCommitFilter, emptyLogFilter, isDay,
} = require('../src/domain/logic/history');

const FS = '\x1f';
const RS = '\x1e';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_hist_'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  };
  /**
   * Commits `file` with `content` and returns the hash.
   * @param {{author?: string, email?: string, date?: string}} [o] date: author and committer date
   */
  const commit = (msg, file = `${msg.replace(/\W+/g, '_')}.txt`, content = `${msg}\n`, o = {}) => {
    write(file, content);
    git('add', '-A');
    const env = { ...process.env };
    if (o.author) env.GIT_AUTHOR_NAME = o.author;
    if (o.email) env.GIT_AUTHOR_EMAIL = o.email;
    if (o.date) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = o.date;
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, stdio: 'pipe', env });
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, write, commit, repo: new Repository(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const subjects = (commits) => commits.map((c) => c.subject);

// ---------------------------------------------------------------- parsing

test('splitReflogSubject splits at the first ": " and tolerates line breaks', () => {
  assert.deepEqual(splitReflogSubject('commit (amend): fix: typo'), { action: 'commit (amend)', message: 'fix: typo' });
  assert.deepEqual(splitReflogSubject('checkout: moving from main to feat'), { action: 'checkout', message: 'moving from main to feat' });
  assert.deepEqual(splitReflogSubject('rebase (finish): returning to refs/heads/main'), { action: 'rebase (finish)', message: 'returning to refs/heads/main' });
  assert.deepEqual(splitReflogSubject('initial pull'), { action: 'initial pull', message: '' });
  assert.deepEqual(splitReflogSubject('reset:'), { action: 'reset', message: '' });
  assert.deepEqual(splitReflogSubject('rebase\n(finish): done\nnow'), { action: 'rebase (finish)', message: 'done now' });
});

test('parseReflog keeps separators in messages and fills gaps with missing entries', () => {
  const out = [
    `HEAD@{0}${FS}${'a'.repeat(40)}${FS}commit: one${FS}still the message${RS}\n`,
    `HEAD@{1}${FS}${'b'.repeat(40)}${FS}commit (amend): two\nlines${RS}\n`,
    `HEAD@{4}${FS}${'c'.repeat(40)}${FS}reset: moving to HEAD~1${RS}\n`,
    'garbage without separators\n',
  ].join('');
  const e = parseReflog(out, new Map([[0, 1000], [4, 4000]]));
  assert.deepEqual(e.map((x) => [x.selector, x.index, x.missing]), [
    ['HEAD@{0}', 0, false], ['HEAD@{1}', 1, false], ['HEAD@{2}', 2, true], ['HEAD@{3}', 3, true], ['HEAD@{4}', 4, false],
  ]);
  assert.equal(e[0].message, `one${FS}still the message`);
  assert.equal(e[0].time, 1000);
  assert.equal(e[1].time, null);
  assert.deepEqual([e[1].action, e[1].message], ['commit (amend)', 'two lines']);
  assert.deepEqual([e[4].action, e[4].message, e[4].time], ['reset', 'moving to HEAD~1', 4000]);
  assert.equal(parseReflog(`main@{0}${FS}${'d'.repeat(40)}${FS}branch: Created from HEAD${RS}`)[0].selector, 'main@{0}');
});

test('buildAuthorList groups by name, most commits first', () => {
  const list = buildAuthorList([
    { author: 'Bob', email: 'bob@a' }, { author: 'alice', email: 'al@x' }, { author: 'Alice', email: 'alice@y' },
    { author: 'Alice', email: 'alice@y' }, { author: 'Bob', email: 'bob@b' }, { author: 'Carol', email: 'c@c' }, { author: ' ', email: '' },
  ]);
  assert.deepEqual(list.map((a) => [a.name, a.count]), [['Alice', 3], ['Bob', 2], ['Carol', 1]]);
  assert.deepEqual(list[0].emails.sort(), ['al@x', 'alice@y']);
});

test('date presets and custom days give --since / --until values', () => {
  assert.deepEqual(dateBounds({ preset: '24h' }), { since: '24.hours.ago' });
  assert.deepEqual(dateBounds({ preset: '7d' }), { since: '7.days.ago' });
  assert.deepEqual(dateBounds({ preset: '30d' }), { since: '30.days.ago' });
  assert.deepEqual(dateBounds({ from: '2024-02-01', to: '2024-02-29' }), { since: '2024-02-01 00:00:00', until: '2024-02-29 23:59:59' });
  assert.deepEqual(dateBounds({ to: '2024-03-01' }), { until: '2024-03-01 23:59:59' });
  assert.deepEqual(dateBounds({ from: '2023-02-29' }), {}, 'not a calendar day');
  assert.deepEqual(dateBounds(null), {});
  assert.equal(isDay('2024-1-01'), false);
});

test('author patterns, regex escaping and the log query', () => {
  assert.equal(escapeBasicRegex('a.b*[c]^$\\d+(e)?'), 'a\\.b\\*\\[c\\]\\^\\$\\\\d+(e)?');  assert.deepEqual(authorPatterns({ kind: 'me' }, { name: 'Me', email: 'me@x' }), ['Me', 'me@x']);
  assert.deepEqual(authorPatterns({ kind: 'me' }, { name: '', email: 'me@x' }), ['me@x']);
  assert.equal(authorPatterns({ kind: 'me' }, { name: '', email: '' }), null);
  assert.deepEqual(authorPatterns({ kind: 'text', text: '  bob ' }), ['bob']);
  assert.deepEqual(authorPatterns(null), []);
  const f = { ...emptyLogFilter(), branch: 'main', user: { kind: 'text', text: 'bob' }, date: { preset: '7d' }, search: { text: 'x', regex: false } };
  const q = logQuery(f);
  assert.deepEqual([q.revisions, q.authors, q.since, q.search], [['main'], ['bob'], '7.days.ago', undefined], 'one character is not searched');
  assert.deepEqual(logQuery({ ...f, search: { text: 'xy', regex: true } }).search, { text: 'xy', regex: true });
  assert.equal(hasCommitFilter(emptyLogFilter()), false);
  assert.equal(hasCommitFilter({ ...emptyLogFilter(), branch: 'main', path: 'a' }), false);
  assert.equal(hasCommitFilter({ ...emptyLogFilter(), date: { preset: '24h' } }), true);
});

test('olderFirst orders by committer date', () => {
  const a = { hash: 'a', commitTime: 2000 };
  const b = { hash: 'b', commitTime: 1000 };
  assert.deepEqual(olderFirst(a, b).map((x) => x.hash), ['b', 'a']);
  assert.deepEqual(olderFirst(b, a).map((x) => x.hash), ['b', 'a']);
  assert.deepEqual(olderFirst(a, { hash: 'c', commitTime: 2000 }).map((x) => x.hash), ['a', 'c']);
});

// ---------------------------------------------------------------- reflog

test('reflog shows a commit dropped by reset --hard and New Branch Here recovers it', async () => {
  const t = setup();
  try {
    t.commit('one');
    const two = t.commit('two: with colon');
    const lost = t.commit('three');
    t.git('reset', '-q', '--hard', 'HEAD~1');
    assert.equal(t.git('rev-parse', 'HEAD'), two);

    const entries = await t.repo.reflog();
    assert.deepEqual(entries.slice(0, 2).map((e) => [e.selector, e.action]), [['HEAD@{0}', 'reset'], ['HEAD@{1}', 'commit']]);
    const e = entries.find((x) => x.hash === lost);
    assert.ok(e, 'dropped commit listed');
    assert.deepEqual([e.selector, e.message, e.missing], ['HEAD@{1}', 'three', false]);
    assert.ok(e.time && Math.abs(e.time - Date.now()) < 120000, 'entry time');
    assert.equal(entries.find((x) => x.action === 'commit' && x.hash === two).message, 'two: with colon');
    assert.equal(entries[entries.length - 1].action, 'commit (initial)');

    // Not in the log any more, but its details can still be shown.
    assert.ok(!(await t.repo.log()).some((c) => c.hash === lost));
    assert.equal((await t.repo.commitInfo(lost)).subject, 'three');
    assert.equal(await t.repo.commitInfo('f'.repeat(40)), null);

    // New Branch Here… (commands.newBranch → createBranch with the hash as start point).
    await t.repo.createBranch('recovered', { startPoint: e.hash });
    assert.equal(t.git('rev-parse', 'recovered'), lost);
    assert.ok((await t.repo.log()).some((c) => c.hash === lost));

    // Reflog of the current branch.
    const branch = await t.repo.reflog('refs/heads/main');
    assert.equal(branch[0].selector, 'main@{0}');
    assert.equal(branch[0].action, 'reset');
    assert.deepEqual(await t.repo.reflog('refs/heads/nope'), []);
  } finally {
    t.cleanup();
  }
});

test('reflog marks entries whose commit no longer exists', async () => {
  const t = setup();
  try {
    t.commit('one');
    const gone = t.commit('two');
    t.git('reset', '-q', '--hard', 'HEAD~1');
    fs.rmSync(path.join(t.dir, '.git', 'objects', gone.slice(0, 2), gone.slice(2)));
    let entries = await t.repo.reflog();
    assert.deepEqual(entries.map((e) => [e.selector, e.missing]), [['HEAD@{0}', false], ['HEAD@{1}', true], ['HEAD@{2}', false]]);
    // Recovered from the reflog file.
    assert.deepEqual([entries[1].hash, entries[1].action, entries[1].message], [gone, 'commit', 'two']);
    assert.ok(entries[1].time && Math.abs(entries[1].time - Date.now()) < 120000);

    // The oldest entries leave no gap: they are found in the reflog file too.
    const one = t.git('rev-parse', 'HEAD');
    t.git('checkout', '-q', '--orphan', 'fresh');
    t.commit('fresh');
    fs.rmSync(path.join(t.dir, '.git', 'objects', one.slice(0, 2), one.slice(2)));
    const lines = fs.readFileSync(path.join(t.dir, '.git', 'logs', 'HEAD'), 'utf8').split('\n').filter(Boolean).length;
    entries = await t.repo.reflog();
    assert.equal(entries.length, lines);
    assert.deepEqual([entries[0].message, entries[0].missing], ['fresh', false]);
    assert.ok(entries.slice(1).every((e) => e.missing), 'every older entry points to a deleted commit');
    const last = entries[entries.length - 1];
    assert.deepEqual([last.selector, last.action, last.message, last.hash], [`HEAD@{${lines - 1}}`, 'commit (initial)', 'one', one]);
    // Without a reflog file (other ref backends) only gaps are detected, with their hash.
    t.repo.reflogFile = async () => null;
    assert.deepEqual((await t.repo.reflog()).map((e) => e.missing), [false]);
  } finally {
    t.cleanup();
  }
});

test('reflog of a repository without commits is empty', async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.repo.reflog(), []);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- filters

test('author filter finds a commit beyond the loaded limit, by name or email, case-insensitive', async () => {
  const t = setup();
  try {
    const old = t.commit('old work', 'a.txt', 'a\n', { author: 'Zoë A. (ext)', email: 'zoe@corp.example' });
    for (let i = 0; i < 5; i++) t.commit(`c${i}`);
    assert.equal((await t.repo.log({ limit: 2 })).length, 2);
    assert.ok(!(await t.repo.log({ limit: 2 })).some((c) => c.hash === old));

    assert.deepEqual(subjects(await t.repo.log({ limit: 2, authors: ['zoë a. (ext)'] })), ['old work']);
    assert.deepEqual(subjects(await t.repo.log({ limit: 2, authors: ['CORP.EXAMPLE'] })), ['old work']);
    assert.deepEqual(await t.repo.log({ limit: 2, authors: ['zoe@corp.exampl.'] }), [], '. is literal');
    assert.deepEqual(await t.repo.log({ limit: 2, authors: ['[a-z]'] }), [], 'brackets are literal');
    // Several patterns: any of them ("Me" = user.name or user.email).
    const me = await t.repo.currentUser();
    assert.deepEqual(me, { name: 'Test', email: 't@example.com' });
    const mine = await t.repo.log({ authors: authorPatterns({ kind: 'me' }, me) });
    assert.equal(mine.length, 5);
    assert.equal((await t.repo.log({ authors: ['nobody', 'ZOE@'] })).length, 1);
    // Combined with a branch filter.
    t.git('branch', 'side', old);
    assert.deepEqual(subjects(await t.repo.log({ revisions: ['side'], authors: ['test'] })), []);
  } finally {
    t.cleanup();
  }
});

test('date filter uses --since / --until on the committer date', async () => {
  const t = setup();
  try {
    t.commit('january', 'a.txt', '1\n', { date: '2024-01-15T12:00:00' });
    t.commit('february first', 'a.txt', '2\n', { date: '2024-02-01T00:30:00' });
    t.commit('end of february', 'a.txt', '3\n', { date: '2024-02-29T23:30:00' });
    t.commit('march', 'a.txt', '4\n', { date: '2024-03-01T08:00:00' });
    const range = (date) => t.repo.log({ ...dateBounds(date) }).then(subjects);
    assert.deepEqual(await range({ from: '2024-02-01', to: '2024-02-29' }), ['end of february', 'february first'], 'both days included');
    assert.deepEqual(await range({ from: '2024-02-15' }), ['march', 'end of february']);
    assert.deepEqual(await range({ to: '2024-01-31' }), ['january']);
    assert.deepEqual(await range({ preset: '30d' }), []);
    t.commit('today');
    assert.deepEqual(await range({ preset: '24h' }), ['today']);
    assert.deepEqual(await range({ preset: '7d' }), ['today']);
  } finally {
    t.cleanup();
  }
});

test('content search: pickaxe -S counts changes of the text, -G matches changed lines', async () => {
  const t = setup();
  try {
    t.commit('add helper', 'a.js', 'function helper() {}\n');
    t.commit('call helper', 'b.js', 'helper();\n');
    t.commit('unrelated', 'c.js', 'other\n');
    t.commit('touch line with helper', 'a.js', 'function helper() { return 1; }\n');
    t.commit('remove call', 'b.js', '');
    const search = (text, regex = false, o = {}) => t.repo.log({ ...o, search: { text, regex } }).then(subjects);
    // -S: commits that change the number of occurrences (not the one that only edits the line).
    assert.deepEqual(await search('helper()'), ['remove call', 'call helper', 'add helper']);
    assert.deepEqual(await search('HELPER()'), ['remove call', 'call helper', 'add helper'], 'case is ignored');
    assert.deepEqual(await search('function helper'), ['add helper']);
    // -G: every commit whose diff has a matching added / removed line.
    assert.deepEqual(await search('helper\\(\\) \\{', true), ['touch line with helper', 'add helper']);
    assert.deepEqual(await search('^other$', true), ['unrelated']);
    // Combined with the path filter and the limit.
    assert.deepEqual(await search('helper()', false, { path: 'b.js' }), ['remove call', 'call helper']);
    assert.deepEqual(await search('helper()', false, { limit: 1 }), ['remove call']);
    assert.deepEqual(await search('HELPER\\(\\) \\{', true), ['touch line with helper', 'add helper']);
    // Combined with a user filter: same results, case ignored on both.
    assert.deepEqual(await search('HELPER()', false, { authors: ['TEST'] }), ['remove call', 'call helper', 'add helper']);
    assert.deepEqual(await search('helper()', false, { authors: ['nobody'] }), []);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- compare

test('compare two non-ancestor commits lists the files with rename detection', async () => {
  const t = setup();
  try {
    const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
    t.commit('base', 'old/name.txt', big);
    t.write('keep.txt', 'k\n');
    t.commit('more', 'gone.txt', 'g\n');
    t.git('checkout', '-q', '-b', 'left', 'HEAD~1');
    const left = t.commit('left change', 'left.txt', 'l\n');
    t.git('checkout', '-q', '-b', 'right', 'main');
    fs.mkdirSync(path.join(t.dir, 'new'));
    t.git('mv', 'old/name.txt', 'new/name.txt');
    t.write('new/name.txt', big.replace('line 3\n', 'line three\n'));
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'rename');
    const right = t.git('rev-parse', 'HEAD');
    assert.equal(await t.repo.isAncestor(left, right), false);
    assert.equal(await t.repo.isAncestor(right, left), false);

    const files = await t.repo.changedFiles(left, right);
    assert.deepEqual(files.map((f) => [f.type, f.path, f.oldPath]), [
      ['added', 'gone.txt', undefined],
      ['added', 'keep.txt', undefined],
      ['deleted', 'left.txt', undefined],
      ['renamed', 'new/name.txt', 'old/name.txt'],
    ]);
    // Swap Sides: the same files the other way round.
    const swapped = await t.repo.changedFiles(right, left);
    assert.deepEqual(swapped.map((f) => [f.type, f.path, f.oldPath]), [
      ['deleted', 'gone.txt', undefined],
      ['deleted', 'keep.txt', undefined],
      ['added', 'left.txt', undefined],
      ['renamed', 'old/name.txt', 'new/name.txt'],
    ]);
    assert.equal((await t.repo.contentAt(right, 'new/name.txt')).includes('line three'), true);
  } finally {
    t.cleanup();
  }
});
