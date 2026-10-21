// Worktrees and Bisect: porcelain / bisect parsing and temporary repositories.
// Run: node --test test/worktreeBisect.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { GitError } = require('../src/domain/errors');
const {
  parseWorktrees, sanitizeForPath, defaultWorktreePath, worktreeOfBranch, checkedOutElsewhere, samePath,
} = require('../src/domain/logic/worktree');
const {
  parseBisectRefs, bisectMarks, parseBisectLog, parseBisectVars, firstBadInOutput, describeBisectProgress,
} = require('../src/domain/logic/bisect');

/** Long, real spelling of a folder (temp folders may come as 8.3 short names on Windows). */
const real = (p) => fs.realpathSync.native(p);

function setup() {
  // A parent folder holds the repository and its worktrees, removed together.
  const parent = real(fs.mkdtempSync(path.join(os.tmpdir(), 'gt_wt_')));
  const dir = path.join(parent, 'repo');
  fs.mkdirSync(dir);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
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
  return {
    parent, dir, git, write, commit, repo: new Repository(dir),
    cleanup: () => fs.rmSync(parent, { recursive: true, force: true }),
  };
}

const sameReal = (a, b) => samePath(real(a), real(b));

// ---------------------------------------------------------------- worktree parsing

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const rec = (...fields) => fields.map((f) => `${f}\0`).join('');

test('parseWorktrees: main, branches, detached, bare, locked, prunable, spaces, null HEAD', () => {
  const out = rec('worktree C:/src/my repo', `HEAD ${H1}`, 'branch refs/heads/main') + '\0'
    + rec('worktree C:/src/my repo-feat', `HEAD ${H2}`, 'branch refs/heads/feature/login', 'locked') + '\0'
    + rec('worktree C:/src/wt2', `HEAD ${H1}`, 'detached', 'locked on a USB\ndrive') + '\0'
    + rec('worktree C:/src/gone', `HEAD ${H1}`, 'branch refs/heads/gone', 'locked reason here', 'prunable gitdir file points to non-existent location') + '\0'
    + rec('worktree C:/src/fresh', `HEAD ${'0'.repeat(40)}`, 'branch refs/heads/unborn', 'prunable') + '\0';
  const list = parseWorktrees(out, 'c:\\src\\my repo-feat\\');
  assert.equal(list.length, 5);
  assert.deepEqual(list[0], {
    path: 'C:/src/my repo', head: H1, branch: 'main', detached: false, bare: false, locked: false, lockReason: '',
    prunable: false, prunableReason: '', main: true, current: false,
  });
  assert.equal(list[1].branch, 'feature/login');
  assert.equal(list[1].locked, true);
  assert.equal(list[1].lockReason, '');
  assert.equal(list[1].main, false);
  assert.equal(list[1].current, process.platform === 'win32'); // case-insensitive only on Windows
  assert.equal(list[2].detached, true);
  assert.equal(list[2].branch, null);
  assert.equal(list[2].lockReason, 'on a USB\ndrive');
  assert.equal(list[3].prunable, true);
  assert.equal(list[3].prunableReason, 'gitdir file points to non-existent location');
  assert.equal(list[3].lockReason, 'reason here');
  assert.equal(list[4].head, null);
  assert.equal(list[4].prunable, true);
  assert.equal(list[4].prunableReason, '');

  const bare = parseWorktrees(rec('worktree /srv/repo.git', 'bare') + '\0' + rec('worktree /home/me/w', `HEAD ${H2}`, 'branch refs/heads/dev') + '\0', '/home/me/w');
  assert.equal(bare[0].bare, true);
  assert.equal(bare[0].main, true);
  assert.equal(bare[0].head, null);
  assert.equal(bare[1].current, true);
  assert.equal(bare[1].branch, 'dev');
  assert.deepEqual(parseWorktrees(''), []);
});

test('samePath unifies separators, trailing slashes and (Windows) case', () => {
  assert.ok(samePath('C:\\a\\b\\', 'c:/a/b', true));
  assert.ok(!samePath('C:\\a\\b', 'c:/a/b', false));
  assert.ok(samePath('/a/b/', '/a/b', false));
  assert.ok(!samePath('/a/b', '/a/bc', false));
});

test('sanitizeForPath and defaultWorktreePath (Windows and POSIX roots)', () => {
  assert.equal(sanitizeForPath('feature/login'), 'feature-login');
  assert.equal(sanitizeForPath('refs/heads/fix/a b:c'), 'fix-a-b-c');
  assert.equal(sanitizeForPath('refs/remotes/origin/x'), 'origin-x');
  assert.equal(sanitizeForPath('.hidden.'), 'hidden');
  assert.equal(sanitizeForPath('///'), 'worktree');
  assert.equal(defaultWorktreePath('C:\\src\\app', 'feature/login'), 'C:\\src\\app-feature-login');
  assert.equal(defaultWorktreePath('C:\\src\\app\\', 'dev'), 'C:\\src\\app-dev');
  assert.equal(defaultWorktreePath('C:/src/app', 'dev'), 'C:/src/app-dev');
  assert.equal(defaultWorktreePath('/home/me/app', 'fix/1'), '/home/me/app-fix-1');
  assert.equal(defaultWorktreePath('/home/me/app/', 'fix'), '/home/me/app-fix');
  assert.equal(defaultWorktreePath('app', 'x'), 'app-x');
});

test('checkedOutElsewhere recognizes both git messages', () => {
  assert.equal(checkedOutElsewhere("fatal: 'feat' is already used by worktree at 'C:/src/app-feat'"), 'C:/src/app-feat');
  assert.equal(checkedOutElsewhere("fatal: 'feat' is already checked out at '/home/me/my app'\n"), '/home/me/my app');
  assert.equal(checkedOutElsewhere("fatal: 'feat' is already used by worktree at 'C:/Users/O'Neil/app-feat'\r\nhint: more"), "C:/Users/O'Neil/app-feat");
  assert.equal(checkedOutElsewhere("error: pathspec 'x' did not match any file(s) known to git"), null);
});

test('worktreeOfBranch skips the current worktree', () => {
  const list = parseWorktrees(
    rec('worktree /a', `HEAD ${H1}`, 'branch refs/heads/main') + '\0' + rec('worktree /b', `HEAD ${H2}`, 'branch refs/heads/feat') + '\0',
    '/a',
  );
  assert.equal(worktreeOfBranch(list, 'feat').path, '/b');
  assert.equal(worktreeOfBranch(list, 'main'), null);
  assert.equal(worktreeOfBranch(list, 'nope'), null);
});

// ---------------------------------------------------------------- bisect parsing

test('parseBisectRefs and bisectMarks', () => {
  const out = [
    `refs/bisect/bad ${H1}`,
    `refs/bisect/good-${H2} ${H2}`,
    `refs/bisect/good-${'c'.repeat(40)} ${'c'.repeat(40)}`,
    `refs/bisect/skip-${'d'.repeat(40)} ${'d'.repeat(40)}`,
    'refs/heads/main 1234567',
    '',
  ].join('\r\n');
  const refs = parseBisectRefs(out);
  assert.deepEqual(refs, { bad: H1, good: [H2, 'c'.repeat(40)], skipped: ['d'.repeat(40)] });
  assert.deepEqual(bisectMarks(refs), { [H1]: 'bad', [H2]: 'good', ['c'.repeat(40)]: 'good', ['d'.repeat(40)]: 'skip' });
  assert.deepEqual(bisectMarks({ bad: H1, good: [H1], skipped: [H1] }), { [H1]: 'bad' });
  assert.deepEqual(parseBisectRefs(''), { bad: null, good: [], skipped: [] });
});

test('parseBisectLog: marks (old/new terms too) and the first bad commit', () => {
  const log = [
    'git bisect start',
    '# status: waiting for both good and bad commits',
    `# bad: [${H1}] c8`,
    `git bisect bad ${H1}`,
    `# good: [${H2}] c1`,
    `git bisect good ${H2}`,
    `git bisect skip ${'d'.repeat(40)} ${'e'.repeat(40)}`,
    `git bisect old ${'f'.repeat(40)}`,
    `git bisect new ${'9'.repeat(40)}`,
    `# first bad commit: [${'5'.repeat(40)}] Introduce the bug`,
    '',
  ].join('\n');
  assert.deepEqual(parseBisectLog(log), {
    good: [H2, 'f'.repeat(40)],
    bad: [H1, '9'.repeat(40)],
    skipped: ['d'.repeat(40), 'e'.repeat(40)],
    firstBad: '5'.repeat(40),
    firstBadSubject: 'Introduce the bug',
  });
  assert.deepEqual(parseBisectLog(''), { good: [], bad: [], skipped: [], firstBad: null, firstBadSubject: '' });
});

test('parseBisectVars', () => {
  const out = `bisect_rev='${H1}'\nbisect_nr=3\nbisect_good=3\nbisect_bad=2\nbisect_all=7\nbisect_steps=2\n`;
  assert.deepEqual(parseBisectVars(out), { remaining: 3, steps: 2, next: H1 });
  assert.deepEqual(parseBisectVars('bisect_rev=\r\nbisect_nr=0\r\nbisect_steps=0\r\n'), { remaining: 0, steps: 0, next: null });
  assert.equal(parseBisectVars(''), null);
});

test('firstBadInOutput and describeBisectProgress', () => {
  assert.equal(firstBadInOutput(`Bisecting: 0 revisions left\n${H1} is the first bad commit\ncommit ${H1}\n`), H1);
  assert.equal(firstBadInOutput(`${H2} is the first new commit`), H2);
  assert.equal(firstBadInOutput('Bisecting: 3 revisions left to test after this (roughly 2 steps)'), null);
  assert.equal(describeBisectProgress(null), 'Bisecting: mark a good and a bad commit');
  assert.equal(describeBisectProgress({ remaining: 3, steps: 2 }), 'Bisecting: ~3 revisions left (~2 steps)');
  assert.equal(describeBisectProgress({ remaining: 1, steps: 1 }), 'Bisecting: ~1 revision left (~1 step)');
});

// ---------------------------------------------------------------- worktrees on a repository

test('worktree add (new branch, existing branch, detached), list, lock, unlock, remove', async () => {
  const t = setup();
  try {
    const c1 = t.commit('c1');
    const c2 = t.commit('c2');
    t.git('branch', 'existing', c1);
    const wtNew = path.join(t.parent, 'wt new');
    const wtExisting = path.join(t.parent, 'wt-existing');
    const wtDetached = path.join(t.parent, 'wt-detached');
    await t.repo.addWorktree({ path: wtNew, newBranch: 'feature/x', startPoint: c1 });
    await t.repo.addWorktree({ path: wtExisting, branch: 'existing' });
    await t.repo.addWorktree({ path: wtDetached, detach: true, startPoint: c2 });

    let list = await t.repo.worktrees();
    assert.equal(list.length, 4);
    assert.ok(list[0].main);
    assert.ok(list[0].current);
    assert.ok(sameReal(list[0].path, t.dir));
    assert.equal(list[0].branch, 'main');
    assert.equal(list[0].head, c2);
    const at = (p) => list.find((w) => sameReal(w.path, p));
    assert.equal(at(wtNew).branch, 'feature/x');
    assert.equal(at(wtNew).head, c1);
    assert.equal(at(wtExisting).branch, 'existing');
    assert.equal(at(wtDetached).detached, true);
    assert.equal(at(wtDetached).branch, null);
    assert.equal(at(wtDetached).head, c2);
    assert.ok(list.slice(1).every((w) => !w.current && !w.main));

    // The current worktree as seen from a linked one.
    const fromLinked = await new Repository(wtNew).worktrees();
    assert.ok(sameReal(fromLinked.find((w) => w.current).path, wtNew));

    await t.repo.lockWorktree(wtExisting, '  on a stick  ');
    await t.repo.lockWorktree(wtDetached);
    list = await t.repo.worktrees();
    assert.equal(at(wtExisting).locked, true);
    assert.equal(at(wtExisting).lockReason, 'on a stick');
    assert.equal(at(wtDetached).locked, true);
    assert.equal(at(wtDetached).lockReason, '');
    await assert.rejects(() => t.repo.removeWorktree(wtExisting), GitError);
    await t.repo.unlockWorktree(wtExisting);
    list = await t.repo.worktrees();
    assert.equal(at(wtExisting).locked, false);

    // Changes block the removal unless forced.
    assert.equal(await t.repo.worktreeHasChanges(wtExisting), false);
    fs.writeFileSync(path.join(wtExisting, 'c1.txt'), 'changed\n');
    assert.equal(await t.repo.worktreeHasChanges(wtExisting), true);
    await assert.rejects(() => t.repo.removeWorktree(wtExisting), GitError);
    assert.ok(fs.existsSync(wtExisting));
    await t.repo.removeWorktree(wtExisting, true);
    assert.ok(!fs.existsSync(wtExisting));

    fs.writeFileSync(path.join(wtNew, 'untracked.txt'), 'u');
    assert.equal(await t.repo.worktreeHasChanges(wtNew), true);
    fs.rmSync(path.join(wtNew, 'untracked.txt'));
    await t.repo.removeWorktree(wtNew);
    assert.ok(!fs.existsSync(wtNew));
    list = await t.repo.worktrees();
    assert.equal(list.length, 2);
    // The branch of a removed worktree stays.
    assert.equal(t.git('rev-parse', 'feature/x'), c1);
  } finally {
    t.cleanup();
  }
});

test('prune: dry run lists a worktree whose folder is gone, then prunes it', async () => {
  const t = setup();
  try {
    t.commit('c1');
    const wt = path.join(t.parent, 'gone');
    await t.repo.addWorktree({ path: wt, newBranch: 'gone-branch' });
    assert.deepEqual(await t.repo.pruneWorktrees(true), []);
    fs.rmSync(wt, { recursive: true, force: true });
    let list = await t.repo.worktrees();
    assert.equal(list.length, 2);
    assert.equal(list[1].prunable, true);
    const dry = await t.repo.pruneWorktrees(true);
    assert.equal(dry.length, 1);
    assert.match(dry[0], /gone/);
    assert.equal((await t.repo.worktrees()).length, 2);
    await t.repo.pruneWorktrees(false);
    list = await t.repo.worktrees();
    assert.equal(list.length, 1);
    assert.deepEqual(await t.repo.pruneWorktrees(true), []);
  } finally {
    t.cleanup();
  }
});

test('checking out a branch used by another worktree: the error names that worktree', async () => {
  const t = setup();
  try {
    t.commit('c1');
    const wt = path.join(t.parent, 'other wt');
    await t.repo.addWorktree({ path: wt, newBranch: 'feat' });
    const err = await t.repo.checkout('feat').then(() => null, (e) => e);
    assert.ok(err instanceof GitError);
    const where = checkedOutElsewhere(err.message);
    assert.ok(where, err.message);
    assert.ok(sameReal(where, wt));
    assert.equal((await t.repo.status()).branch, 'main');
    const list = await t.repo.worktrees();
    assert.ok(sameReal(worktreeOfBranch(list, 'feat').path, wt));
    assert.equal(worktreeOfBranch(list, 'main'), null);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- bisect on a repository

/** 8 commits on main; the 5th one writes BUG into f.txt. */
function buggyHistory(t) {
  const hashes = [];
  for (let i = 1; i <= 8; i++) hashes.push(t.commit(`c${i}`, 'f.txt', i >= 5 ? `v${i} BUG\n` : `v${i}\n`));
  return { hashes, first: hashes[0], bug: hashes[4], last: hashes[7] };
}

test('bisect: mark good / bad until the first bad commit, then reset', async () => {
  const t = setup();
  try {
    const { first, bug, last } = buggyHistory(t);
    assert.equal(await t.repo.bisectState(), null);
    await t.repo.bisectMark('bad');
    let state = await t.repo.bisectState();
    assert.ok(state);
    assert.equal(state.start, 'main');
    assert.equal(state.bad, last);
    assert.equal(state.remaining, null);
    await t.repo.bisectMark('good', first);

    let progressSeen = false;
    for (let i = 0; i < 10; i++) {
      state = await t.repo.bisectState();
      if (state.firstBad) break;
      assert.equal(typeof state.remaining, 'number');
      assert.equal(typeof state.steps, 'number');
      progressSeen = true;
      assert.equal(state.head, t.git('rev-parse', 'HEAD'));
      assert.equal(state.headSubject, t.git('log', '-1', '--format=%s'));
      assert.equal(state.marks[state.bad], 'bad');
      assert.equal(state.marks[first], 'good');
      const content = fs.readFileSync(path.join(t.dir, 'f.txt'), 'utf8');
      const out = await t.repo.bisectMark(content.includes('BUG') ? 'bad' : 'good');
      assert.ok(out);
    }
    assert.ok(progressSeen);
    assert.equal(state.firstBad, bug);
    assert.equal(state.firstBadSubject, 'c5');
    assert.equal(state.bad, bug);
    assert.ok(state.good.length >= 1);
    assert.equal(state.remaining, null);
    assert.ok(Object.values(state.marks).includes('good'));
    assert.ok(Object.values(state.marks).includes('bad'));

    // Bisect refs are not ref chips in the log.
    const commits = await t.repo.log();
    for (const c of commits) assert.ok(c.refs.every((r) => !r.name.includes('bisect')), JSON.stringify(c.refs));
    assert.ok(commits.find((c) => c.hash === last).refs.some((r) => r.name === 'main'));

    await t.repo.bisectReset();
    assert.equal((await t.repo.status()).branch, 'main');
    assert.equal(t.git('rev-parse', 'HEAD'), last);
    assert.equal(await t.repo.bisectState(), null);
  } finally {
    t.cleanup();
  }
});

test('bisect run finds the first bad commit with a shell command', async () => {
  const t = setup();
  try {
    const { first, bug, last } = buggyHistory(t);
    /** @type {[string, string][]} */
    const logged = [];
    const repo = new Repository(t.dir, { log: (line, kind) => logged.push([line, kind]) });
    await repo.bisectMark('bad');
    await repo.bisectMark('good', first);
    const r = await repo.bisectRun("! grep -q 'BUG' f.txt");
    assert.equal(r.code, 0, r.output);
    assert.equal(firstBadInOutput(r.output), bug);
    // Streamed to the log line by line, the command line first.
    assert.equal(logged.filter(([, k]) => k === 'command').pop()[0].startsWith('git bisect run sh -c'), true);
    assert.ok(logged.some(([l, k]) => k === 'output' && l === `${bug} is the first bad commit`));
    const state = await t.repo.bisectState();
    assert.equal(state.firstBad, bug);
    await t.repo.bisectReset();
    assert.equal(t.git('rev-parse', 'HEAD'), last);
    assert.equal((await t.repo.status()).branch, 'main');
  } finally {
    t.cleanup();
  }
});

test('bisect refuses to check out over local changes', async () => {
  const t = setup();
  try {
    const { first } = buggyHistory(t);
    fs.writeFileSync(path.join(t.dir, 'f.txt'), 'local edit\n');
    await t.repo.bisectMark('bad');
    await assert.rejects(() => t.repo.bisectMark('good', first), (e) => e instanceof GitError && /overwritten|local changes/i.test(e.message));
    assert.equal(fs.readFileSync(path.join(t.dir, 'f.txt'), 'utf8'), 'local edit\n');
    await t.repo.bisectReset();
    assert.equal(await t.repo.bisectState(), null);
  } finally {
    t.cleanup();
  }
});
