// Clean Working Tree and Merge options: clean -n parsing, merge option rules and temporary
// repositories. Run: node --test test/cleanMerge.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { GitError } = require('../src/domain/errors');
const { parseCleanOutput, cleanEntries, cleanFlags, batchPathspecs } = require('../src/domain/logic/clean');
const {
  defaultMergeOptions, validateMergeOptions, exclusiveMergeOptions, createsMergeCommit, mergeArgs, describeMergePreview,
  describeMergeOptions, squashMessageText,
} = require('../src/domain/logic/merge');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_clean_'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  const init = (cwd) => {
    const g = (...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'Test');
    g('config', 'user.email', 't@example.com');
    g('config', 'core.autocrlf', 'false');
    return g;
  };
  init(dir);
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  };
  const exists = (p) => fs.existsSync(path.join(dir, p));
  const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
  const commit = (msg, file = `${msg.replace(/\W+/g, '_')}.txt`, content = `${msg}\n`) => {
    write(file, content);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  return {
    dir, git, init, write, exists, read, commit, repo: new Repository(dir),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const opts = (o = {}) => ({ ...defaultMergeOptions(), ...o });

// ---------------------------------------------------------------- clean parsing

test('parseCleanOutput: files, directories, C-quoted paths; other lines ignored', () => {
  const out = [
    'Would remove a.txt',
    'Would remove build/',
    'Would skip repository nested/',
    'Would remove "we\\"ird \\303\\251.txt"',
    'Would remove "tab\\there/"',
    'Would remove with space.txt\r',
    '',
  ].join('\n');
  assert.deepEqual(parseCleanOutput(out), [
    { path: 'a.txt', directory: false },
    { path: 'build', directory: true },
    { path: 'we"ird é.txt', directory: false },
    { path: 'tab\there', directory: true },
    { path: 'with space.txt', directory: false },
  ]);
  assert.deepEqual(parseCleanOutput(''), []);
});

test('cleanEntries: nested repositories only listed by -ff, flagged and sorted', () => {
  const plain = 'Would remove d/\nWould skip repository nested/\nWould remove z.txt\n';
  const forced = 'Would remove d/\nWould remove nested/\nWould remove z.txt\n';
  assert.deepEqual(cleanEntries(plain, forced), [
    { path: 'd', directory: true, nestedRepo: false },
    { path: 'nested', directory: true, nestedRepo: true },
    { path: 'z.txt', directory: false, nestedRepo: false },
  ]);
  assert.deepEqual(cleanEntries('Would remove a\n', ''), [{ path: 'a', directory: false, nestedRepo: false }]);
});

test('cleanFlags maps the options', () => {
  assert.deepEqual(cleanFlags({ directories: false, ignored: false }), []);
  assert.deepEqual(cleanFlags({ directories: true, ignored: false }), ['-d']);
  assert.deepEqual(cleanFlags({ directories: true, ignored: true }), ['-d', '-x']);
  assert.deepEqual(cleanFlags({ directories: false, ignored: true }), ['-x']);
});

test('batchPathspecs keeps every batch under the limit and the order', () => {
  assert.deepEqual(batchPathspecs([]), []);
  assert.deepEqual(batchPathspecs(['a', 'b']), [['a', 'b']]);
  const specs = Array.from({ length: 50 }, (_, i) => `file-${String(i).padStart(3, '0')}.txt`); // 12 chars + 3
  const batches = batchPathspecs(specs, 100);
  assert.deepEqual(batches.flat(), specs);
  for (const b of batches) assert.ok(b.reduce((n, s) => n + s.length + 3, 0) <= 100);
  assert.equal(batches[0].length, 6);
  // A single spec longer than the limit still gets its own batch.
  assert.deepEqual(batchPathspecs(['x'.repeat(200), 'y'], 100), [['x'.repeat(200)], ['y']]);
});

// ---------------------------------------------------------------- merge options

test('validateMergeOptions: squash excludes --no-ff / --ff-only, message not blank', () => {
  assert.equal(validateMergeOptions(opts()), null);
  assert.equal(validateMergeOptions(opts({ squash: true })), null);
  assert.match(validateMergeOptions(opts({ squash: true, fastForward: 'never' })), /Squash/);
  assert.match(validateMergeOptions(opts({ squash: true, fastForward: 'only' })), /Squash/);
  assert.match(validateMergeOptions(opts({ message: '  \n' })), /empty/);
  assert.equal(validateMergeOptions(opts({ fastForward: 'never', message: 'Merge it' })), null);
});

test('exclusiveMergeOptions switches off what the changed option excludes', () => {
  let o = exclusiveMergeOptions(opts({ fastForward: 'never', squash: true, message: 'm' }), 'squash');
  assert.equal(o.fastForward, 'default');
  assert.equal(o.squash, true);
  assert.equal(o.noCommit, true);
  assert.equal(o.message, null);
  o = exclusiveMergeOptions({ ...o, fastForward: 'only' }, 'ffOnly');
  assert.equal(o.squash, false);
  assert.equal(o.fastForward, 'only');
  o = exclusiveMergeOptions(opts({ squash: true, noCommit: true }), 'squash');
  assert.equal(o.noCommit, true);
  o = exclusiveMergeOptions({ ...o, squash: false }, 'squash');
  assert.equal(o.noCommit, false);
  o = exclusiveMergeOptions(opts({ fastForward: 'never', message: 'msg' }), 'noFf');
  assert.equal(o.message, 'msg');
  o = exclusiveMergeOptions({ ...o, noCommit: true }, 'noCommit');
  assert.equal(o.message, null);
});

test('createsMergeCommit', () => {
  assert.equal(createsMergeCommit(opts(), true), false);
  assert.equal(createsMergeCommit(opts(), false), true);
  assert.equal(createsMergeCommit(opts({ fastForward: 'never' }), true), true);
  assert.equal(createsMergeCommit(opts({ fastForward: 'only' }), false), false);
  assert.equal(createsMergeCommit(opts({ squash: true }), false), false);
  assert.equal(createsMergeCommit(opts({ noCommit: true, fastForward: 'never' }), true), false);
});

test('mergeArgs and describeMergeOptions', () => {
  assert.deepEqual(mergeArgs('feat', opts()), ['merge', '--no-edit', 'feat']);
  assert.deepEqual(mergeArgs('feat', opts({ fastForward: 'only' })), ['merge', '--ff-only', '--no-edit', 'feat']);
  assert.deepEqual(mergeArgs('feat', opts({ fastForward: 'never', message: '  Hi  ' })), ['merge', '--no-ff', '-m', 'Hi', 'feat']);
  assert.deepEqual(mergeArgs('feat', opts({ squash: true, noCommit: true })), ['merge', '--squash', '--no-edit', 'feat']);
  assert.deepEqual(mergeArgs('feat', opts({ noCommit: true })), ['merge', '--no-ff', '--no-commit', '--no-edit', 'feat']);
  assert.deepEqual(mergeArgs('feat', opts({ message: '   ' })), ['merge', '--no-edit', 'feat']);
  assert.equal(describeMergeOptions(opts({ fastForward: 'never', message: 'Hello there' })), '--no-ff -m');
  assert.equal(describeMergeOptions(opts()), '');
  assert.equal(describeMergeOptions(opts({ squash: true })), '--squash');
});

test('describeMergePreview', () => {
  assert.equal(describeMergePreview({ commits: 0, fastForward: false }), 'Already up to date: nothing to merge');
  assert.equal(describeMergePreview({ commits: 1, fastForward: false }), '1 commit will be merged');
  assert.equal(describeMergePreview({ commits: 3, fastForward: true }), '3 commits will be merged · Fast-forward possible');
});

test('squashMessageText drops comments and trailing blanks, caps the lines', () => {
  const text = 'Squashed commit of the following:\r\n\r\ncommit abc\r\n# comment\r\n    one\r\n\r\n\r\n';
  assert.equal(squashMessageText(text), 'Squashed commit of the following:\n\ncommit abc\n    one');
  const many = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
  const r = squashMessageText(many, 5).split('\n');
  assert.deepEqual(r, ['l0', 'l1', 'l2', 'l3', 'l4', '…']);
  assert.equal(squashMessageText('# only comments\n'), '');
});

// ---------------------------------------------------------------- clean on a repository

test('cleanPreview lists files, directories (-d), ignored (-x) and nested repositories', async () => {
  const t = setup();
  try {
    t.write('.gitignore', '*.log\n');
    t.commit('base', 'tracked.txt', 'tracked\n');
    t.write('tracked.txt', 'modified\n');
    t.write('a.txt', 'a');
    t.write('dir/sub/b.txt', 'b');
    t.write('x.log', 'log');
    t.write('dir with space/c.txt', 'c');
    t.write('nested/n.txt', 'n');
    const g = t.init(path.join(t.dir, 'nested'));
    g('add', '-A');
    g('commit', '-q', '-m', 'n');

    assert.deepEqual(await t.repo.cleanPreview({ directories: false, ignored: false }), [
      { path: 'a.txt', directory: false, nestedRepo: false },
    ]);
    assert.deepEqual(await t.repo.cleanPreview({ directories: true, ignored: false }), [
      { path: 'a.txt', directory: false, nestedRepo: false },
      { path: 'dir', directory: true, nestedRepo: false },
      { path: 'dir with space', directory: true, nestedRepo: false },
      { path: 'nested', directory: true, nestedRepo: true },
    ]);
    const withIgnored = await t.repo.cleanPreview({ directories: true, ignored: true });
    assert.deepEqual(withIgnored.map((e) => e.path), ['a.txt', 'dir', 'dir with space', 'nested', 'x.log']);
    assert.deepEqual(await t.repo.cleanPreview({ directories: false, ignored: true }), [
      { path: 'a.txt', directory: false, nestedRepo: false },
      { path: 'x.log', directory: false, nestedRepo: false },
    ]);
  } finally {
    t.cleanup();
  }
});

test('clean removes exactly the given entries; tracked files and unchecked entries survive', async () => {
  const t = setup();
  try {
    t.write('.gitignore', '*.log\n');
    t.commit('base', 'tracked.txt', 'tracked\n');
    t.write('tracked.txt', 'modified\n');
    t.write('a.txt', 'a');
    t.write('keep.txt', 'k');
    t.write('[g]lob.txt', 'g');
    t.write('dir/sub/b.txt', 'b');
    t.write('keepdir/c.txt', 'c');
    t.write('x.log', 'log');
    t.write('y.log', 'log');

    // Without -d / -x: only top level untracked files are offered.
    let o = { directories: false, ignored: false };
    let entries = await t.repo.cleanPreview(o);
    assert.deepEqual(entries.map((e) => e.path).sort(), ['[g]lob.txt', 'a.txt', 'keep.txt']);
    await t.repo.clean(o, entries.filter((e) => e.path !== 'keep.txt'));
    assert.ok(!t.exists('a.txt'));
    assert.ok(!t.exists('[g]lob.txt'));
    assert.ok(t.exists('keep.txt'));
    assert.ok(t.exists('dir/sub/b.txt'));
    assert.ok(t.exists('x.log'));
    assert.equal(t.read('tracked.txt'), 'modified\n');

    // -d -x: directories and ignored files; leave keepdir, y.log and keep.txt.
    o = { directories: true, ignored: true };
    entries = await t.repo.cleanPreview(o);
    assert.deepEqual(entries.map((e) => e.path), ['dir', 'keep.txt', 'keepdir', 'x.log', 'y.log']);
    await t.repo.clean(o, entries.filter((e) => ['dir', 'x.log'].includes(e.path)));
    assert.ok(!t.exists('dir'));
    assert.ok(!t.exists('x.log'));
    assert.ok(t.exists('y.log'));
    assert.ok(t.exists('keepdir/c.txt'));
    assert.ok(t.exists('keep.txt'));
    assert.ok(t.exists('.gitignore'));
    assert.equal(t.read('tracked.txt'), 'modified\n');

    // Nothing selected: nothing happens.
    await t.repo.clean(o, []);
    assert.ok(t.exists('keep.txt'));
  } finally {
    t.cleanup();
  }
});

test('clean removes a nested repository only when it is included', async () => {
  const t = setup();
  try {
    t.commit('base', 'tracked.txt', 'tracked\n');
    t.write('junk/j.txt', 'j');
    t.write('nested/n.txt', 'n');
    const g = t.init(path.join(t.dir, 'nested'));
    g('add', '-A');
    g('commit', '-q', '-m', 'n');
    const o = { directories: true, ignored: false };
    let entries = await t.repo.cleanPreview(o);
    assert.deepEqual(entries, [
      { path: 'junk', directory: true, nestedRepo: false },
      { path: 'nested', directory: true, nestedRepo: true },
    ]);
    await t.repo.clean(o, entries.filter((e) => !e.nestedRepo));
    assert.ok(!t.exists('junk'));
    assert.ok(t.exists('nested/.git'));
    assert.ok(t.exists('nested/n.txt'));

    entries = await t.repo.cleanPreview(o);
    assert.deepEqual(entries, [{ path: 'nested', directory: true, nestedRepo: true }]);
    await t.repo.clean(o, entries);
    assert.ok(!t.exists('nested'));
    assert.ok(t.exists('tracked.txt'));
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- merge on a repository

/** main: base, m1; feat: base, f1, f2 (diverged). */
function diverged(t) {
  const base = t.commit('base', 'base.txt');
  t.git('checkout', '-q', '-b', 'feat');
  t.commit('f1', 'f1.txt');
  t.commit('f2', 'f2.txt');
  t.git('checkout', '-q', 'main');
  const m1 = t.commit('m1', 'm1.txt');
  return { base, m1 };
}

test('mergePreview counts the commits and tells whether fast-forward is possible', async () => {
  const t = setup();
  try {
    t.commit('base', 'base.txt');
    t.git('checkout', '-q', '-b', 'feat');
    t.commit('f1', 'f1.txt');
    t.commit('f2', 'f2.txt');
    t.git('checkout', '-q', 'main');
    assert.deepEqual(await t.repo.mergePreview('feat'), { commits: 2, fastForward: true });
    t.commit('m1', 'm1.txt');
    assert.deepEqual(await t.repo.mergePreview('feat'), { commits: 2, fastForward: false });
    t.git('merge', '-q', '--no-edit', 'feat');
    assert.deepEqual(await t.repo.mergePreview('feat'), { commits: 0, fastForward: false });
  } finally {
    t.cleanup();
  }
});

test('merge --ff-only is refused when not fast-forwardable; the repository is unchanged', async () => {
  const t = setup();
  try {
    const { m1 } = diverged(t);
    await assert.rejects(() => t.repo.merge('feat', opts({ fastForward: 'only' })), GitError);
    assert.equal(t.git('rev-parse', 'HEAD'), m1);
    assert.equal(t.git('status', '--porcelain'), '');
    assert.equal(await t.repo.repoState(), 'normal');
  } finally {
    t.cleanup();
  }
});

test('merge --ff-only fast-forwards when possible', async () => {
  const t = setup();
  try {
    t.commit('base', 'base.txt');
    t.git('checkout', '-q', '-b', 'feat');
    const f1 = t.commit('f1', 'f1.txt');
    t.git('checkout', '-q', 'main');
    await t.repo.merge('feat', opts({ fastForward: 'only' }));
    assert.equal(t.git('rev-parse', 'HEAD'), f1);
  } finally {
    t.cleanup();
  }
});

test('merge --no-ff creates a merge commit with the given message', async () => {
  const t = setup();
  try {
    const base = t.commit('base', 'base.txt');
    t.git('checkout', '-q', '-b', 'feat');
    const f1 = t.commit('f1', 'f1.txt');
    t.git('checkout', '-q', 'main');
    await t.repo.merge('feat', opts({ fastForward: 'never', message: 'Merge feature work' }));
    const parents = t.git('log', '-1', '--format=%P').split(' ');
    assert.deepEqual(parents, [base, f1]);
    assert.equal(t.git('log', '-1', '--format=%s'), 'Merge feature work');
    assert.equal(await t.repo.repoState(), 'normal');
  } finally {
    t.cleanup();
  }
});

test('merge --squash leaves staged changes and SQUASH_MSG, no MERGE_HEAD', async () => {
  const t = setup();
  try {
    const { m1 } = diverged(t);
    await t.repo.merge('feat', exclusiveMergeOptions(opts({ squash: true }), 'squash'));
    assert.equal(t.git('rev-parse', 'HEAD'), m1);
    assert.equal(await t.repo.repoState(), 'normal');
    const s = await t.repo.status();
    const byPath = Object.fromEntries(s.changes.map((c) => [c.path, c]));
    assert.deepEqual(Object.keys(byPath).sort(), ['f1.txt', 'f2.txt']);
    for (const c of s.changes) {
      assert.equal(c.type, 'added');
      assert.equal(c.staged, true);
      assert.equal(c.unstaged, false);
    }
    const msg = await t.repo.squashMessage();
    assert.ok(msg);
    const text = squashMessageText(msg);
    assert.match(text, /^Squashed commit of the following:/);
    assert.match(text, /f1/);
    assert.match(text, /f2/);
  } finally {
    t.cleanup();
  }
});

test('squashMessage is null without a squash', async () => {
  const t = setup();
  try {
    t.commit('base', 'base.txt');
    assert.equal(await t.repo.squashMessage(), null);
  } finally {
    t.cleanup();
  }
});

test('merge --no-commit leaves the repository merging', async () => {
  const t = setup();
  try {
    const { m1 } = diverged(t);
    await t.repo.merge('feat', opts({ noCommit: true }));
    assert.equal(t.git('rev-parse', 'HEAD'), m1);
    assert.equal(await t.repo.repoState(), 'merging');
    const s = await t.repo.status();
    assert.equal(s.state, 'merging');
    assert.deepEqual(s.changes.filter((c) => c.staged).map((c) => c.path).sort(), ['f1.txt', 'f2.txt']);
  } finally {
    t.cleanup();
  }
});

test('merge --no-commit stops before committing even when a fast-forward is possible', async () => {
  const t = setup();
  try {
    const base = t.commit('base', 'base.txt');
    t.git('checkout', '-q', '-b', 'feat');
    t.commit('f1', 'f1.txt');
    t.git('checkout', '-q', 'main');
    await t.repo.merge('feat', opts({ noCommit: true }));
    assert.equal(t.git('rev-parse', 'HEAD'), base);
    assert.equal(await t.repo.repoState(), 'merging');
  } finally {
    t.cleanup();
  }
});

test('merge without options: default fast-forward', async () => {
  const t = setup();
  try {
    t.commit('base', 'base.txt');
    t.git('checkout', '-q', '-b', 'feat');
    const f1 = t.commit('f1', 'f1.txt');
    t.git('checkout', '-q', 'main');
    await t.repo.merge('feat');
    assert.equal(t.git('rev-parse', 'HEAD'), f1);
  } finally {
    t.cleanup();
  }
});
