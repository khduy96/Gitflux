// Annotate (git blame) and staged / unstaged diff contents: porcelain parsing and temporary
// repositories. Run: node --test test/blameDiff.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const {
  parseBlamePorcelain, annotationText, commitAges, ageBucket, shortDate, UNCOMMITTED,
} = require('../src/domain/logic/blame');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_blame_'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  };
  /** Commits `file` with `content` (author / date optional) and returns the hash. */
  const commit = (msg, file, content, o = {}) => {
    write(file, content);
    git('add', '-A');
    const env = { ...process.env };
    if (o.author) env.GIT_AUTHOR_NAME = o.author;
    if (o.date) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = o.date;
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, stdio: 'pipe', env });
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, write, commit, repo: new Repository(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const A = '1a2b3c4d'.repeat(5);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

/** Hand-written `git blame --porcelain` (headers of a commit only the first time). */
const SAMPLE = [
  `${A} 1 1 2`,
  'author Jane Doe',
  'author-mail <jane@example.com>',
  'author-time 1714521600',
  'author-tz +0000',
  'committer Jane Doe',
  'committer-mail <jane@example.com>',
  'committer-time 1714521600',
  'committer-tz +0000',
  'summary First version',
  'boundary',
  'filename old name.txt',
  '\tline one',
  `${A} 2 2`,
  '\tline two',
  `${B} 3 4 1`,
  'author Bob',
  'author-mail <bob@example.com>',
  'author-time 1717200000',
  'summary Second',
  `previous ${A} old name.txt`,
  'filename new name.txt',
  '\tline four',
  `${Z} 3 3 1`,
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1720000000',
  'summary Version of new name.txt from new name.txt',
  `previous ${B} new name.txt`,
  'filename new name.txt',
  '\tline three',
  `${A} 3 5`,
  '\t\tindented with author-time 5',
  '',
].join('\n');

test('parseBlamePorcelain: commits once, lines sorted, uncommitted, previous / filename', () => {
  const blame = parseBlamePorcelain(SAMPLE);
  assert.equal(blame.commits.size, 3);
  assert.deepEqual(blame.commits.get(A), {
    hash: A, author: 'Jane Doe', email: 'jane@example.com', time: 1714521600000, summary: 'First version', previous: null,
    filename: 'old name.txt', uncommitted: false,
  });
  assert.deepEqual(blame.commits.get(B), {
    hash: B, author: 'Bob', email: 'bob@example.com', time: 1717200000000, summary: 'Second', previous: A,
    filename: 'new name.txt', uncommitted: false,
  });
  const z = blame.commits.get(Z);
  assert.equal(z.uncommitted, true);
  assert.equal(z.email, 'not.committed.yet');
  assert.equal(z.previous, B);
  assert.deepEqual(blame.lines, [
    { hash: A, line: 1, origLine: 1 },
    { hash: A, line: 2, origLine: 2 },
    { hash: Z, line: 3, origLine: 3 },
    { hash: B, line: 4, origLine: 3 },
    { hash: A, line: 5, origLine: 3 },
  ]);
  // A content line that looks like a field does not change the commit.
  assert.equal(blame.commits.get(A).time, 1714521600000);
});

test('parseBlamePorcelain tolerates CRLF and empty output', () => {
  const crlf = parseBlamePorcelain(SAMPLE.replace(/\n/g, '\r\n'));
  assert.equal(crlf.commits.get(A).author, 'Jane Doe');
  assert.equal(crlf.commits.get(A).email, 'jane@example.com');
  assert.equal(crlf.commits.get(B).filename, 'new name.txt');
  assert.equal(crlf.commits.get(B).previous, A);
  assert.equal(crlf.lines.length, 5);
  assert.deepEqual(crlf.lines.map((l) => l.line), [1, 2, 3, 4, 5]);
  const empty = parseBlamePorcelain('');
  assert.equal(empty.commits.size, 0);
  assert.deepEqual(empty.lines, []);
});

test('annotationText: fixed width, author cut with an ellipsis, Not Committed Yet', () => {
  const time = new Date(2024, 4, 1, 12).getTime();
  const c = { hash: A, author: 'Jane Doe', email: '', time, summary: '', previous: null, filename: '', uncommitted: false };
  assert.equal(annotationText(c), `1a2b3c4d  Jane Doe      2024-05-01`);
  assert.equal(annotationText({ ...c, author: 'Maximilian Mustermann' }), `1a2b3c4d  Maximilian …  2024-05-01`);
  assert.equal(annotationText({ ...c, author: 'Maximilian Mustermann' }, 5), `1a2b3c4d  Maxi…  2024-05-01`);
  const width = annotationText(c).length;
  assert.equal(annotationText({ ...c, author: 'Maximilian Mustermann' }).length, width);
  const u = annotationText({ ...c, hash: Z, uncommitted: true });
  assert.equal(u, 'Not Committed Yet'.padEnd(width, ' '));
  assert.equal(annotationText({ ...c, uncommitted: true }, 3).length, 8 + 2 + 3 + 2 + 10);
  assert.equal(shortDate(time), '2024-05-01');
  assert.ok(UNCOMMITTED.test(Z));
  assert.ok(!UNCOMMITTED.test(A));
});

test('commitAges and ageBucket', () => {
  const mk = (hash, time, uncommitted = false) => ({ hash, time, uncommitted, author: '', email: '', summary: '', previous: null, filename: '' });
  const ages = commitAges([mk('a', 1000), mk('b', 2000), mk('c', 3000), mk(Z, 0, true)]);
  assert.equal(ages.get('a'), 0);
  assert.equal(ages.get('b'), 0.5);
  assert.equal(ages.get('c'), 1);
  assert.equal(ages.get(Z), 1);
  assert.equal(commitAges([mk('a', 5)]).get('a'), 1);
  assert.equal(commitAges([]).size, 0);
  assert.equal(ageBucket(0, 5), 0);
  assert.equal(ageBucket(1, 5), 4);
  assert.equal(ageBucket(0.5, 5), 2);
  assert.equal(ageBucket(-1, 5), 0);
  assert.equal(ageBucket(2, 5), 4);
  assert.equal(ageBucket(0.3, 1), 0);
});

// ---------------------------------------------------------------- blame on a repository

test('blame of a committed file', async () => {
  const t = setup();
  try {
    const c1 = t.commit('first', 'f.txt', 'one\ntwo\nthree\n', { author: 'Ann', date: '2024-01-01T10:00:00Z' });
    const c2 = t.commit('second', 'f.txt', 'one\nTWO\nthree\nfour\n', { author: 'Ben', date: '2024-06-01T10:00:00Z' });
    const blame = await t.repo.blame('f.txt');
    assert.deepEqual(blame.lines.map((l) => [l.line, l.hash]), [[1, c1], [2, c2], [3, c1], [4, c2]]);
    assert.equal(blame.commits.get(c1).author, 'Ann');
    assert.equal(blame.commits.get(c1).email, 't@example.com');
    assert.equal(blame.commits.get(c1).summary, 'first');
    assert.equal(blame.commits.get(c1).time, Date.parse('2024-01-01T10:00:00Z'));
    assert.equal(blame.commits.get(c2).previous, c1);
    assert.equal(blame.commits.get(c2).filename, 'f.txt');
    const ages = commitAges(blame.commits.values());
    assert.equal(ages.get(c1), 0);
    assert.equal(ages.get(c2), 1);
  } finally {
    t.cleanup();
  }
});

test('blame of a dirty buffer: added lines uncommitted, the others keep their commits', async () => {
  const t = setup();
  try {
    const c1 = t.commit('first', 'dir/f.txt', 'one\ntwo\nthree\n');
    const c2 = t.commit('second', 'dir/f.txt', 'one\ntwo\nthree\nfour\n');
    // The buffer is not saved: the file on disk keeps the committed text.
    const blame = await t.repo.blame('dir/f.txt', 'zero\none\ntwo\nnew\nthree\nfour\n');
    const byLine = blame.lines.map((l) => [l.line, blame.commits.get(l.hash).uncommitted ? 'U' : l.hash]);
    assert.deepEqual(byLine, [[1, 'U'], [2, c1], [3, c1], [4, 'U'], [5, c1], [6, c2]]);
    const u = [...blame.commits.values()].find((c) => c.uncommitted);
    assert.match(annotationText(u), /^Not Committed Yet/);
    // Saved changes are blamed the same way without contents.
    t.write('dir/f.txt', 'one\nchanged\nthree\nfour\n');
    const saved = await t.repo.blame('dir/f.txt');
    assert.equal(saved.commits.get(saved.lines[1].hash).uncommitted, true);
    assert.equal(saved.lines[0].hash, c1);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- staged / unstaged contents

test('staged and unstaged changes: flags and the three versions', async () => {
  const t = setup();
  try {
    t.commit('base', 'mm.txt', 'head\n');
    t.commit('base2', 'staged.txt', 'head s\n');
    t.commit('base3', 'work.txt', 'head w\n');
    t.write('mm.txt', 'index\n');
    t.git('add', 'mm.txt');
    t.write('mm.txt', 'working\n');
    t.write('staged.txt', 'staged s\n');
    t.git('add', 'staged.txt');
    t.write('work.txt', 'working w\n');
    t.write('new.txt', 'new\n');
    t.git('add', 'new.txt');

    const s = await t.repo.status();
    const c = Object.fromEntries(s.changes.map((x) => [x.path, x]));
    assert.equal(c['mm.txt'].type, 'modified');
    assert.equal(c['mm.txt'].staged, true);
    assert.equal(c['mm.txt'].unstaged, true);
    assert.equal(c['staged.txt'].staged, true);
    assert.equal(c['staged.txt'].unstaged, false);
    assert.equal(c['work.txt'].staged, false);
    assert.equal(c['work.txt'].unstaged, true);
    assert.equal(c['new.txt'].type, 'added');
    assert.equal(c['new.txt'].staged, true);
    assert.equal(c['new.txt'].unstaged, false);

    assert.equal(await t.repo.contentAt('HEAD', 'mm.txt'), 'head\n');
    assert.equal(await t.repo.contentAt('', 'mm.txt'), 'index\n');
    assert.equal(t.repo.workingText('mm.txt'), 'working\n');
    assert.equal((await t.repo.show('', 'mm.txt')).toString('utf8'), 'index\n');

    assert.equal(await t.repo.contentAt('HEAD', 'staged.txt'), 'head s\n');
    assert.equal(await t.repo.contentAt('', 'staged.txt'), 'staged s\n');
    assert.equal(t.repo.workingText('staged.txt'), 'staged s\n');

    assert.equal(await t.repo.contentAt('', 'work.txt'), 'head w\n');
    assert.equal(t.repo.workingText('work.txt'), 'working w\n');

    assert.equal(await t.repo.contentAt('HEAD', 'new.txt'), null);
    assert.equal(await t.repo.contentAt('', 'new.txt'), 'new\n');

    // Deleted from the worktree only / staged deletion.
    t.git('rm', '-q', '--cached', 'work.txt');
    const s2 = await t.repo.status();
    const w = s2.changes.find((x) => x.path === 'work.txt' && x.type === 'deleted');
    assert.ok(w);
    assert.equal(w.staged, true);
  } finally {
    t.cleanup();
  }
});
