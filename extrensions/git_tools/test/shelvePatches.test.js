// Shelve, Shelf and Create / Apply Patch: shelf format, patch parsing and temporary repositories.
// Run: node --test test/shelvePatches.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { ShelfStore } = require('../src/data/shelfStore');
const { ShelveChanges } = require('../src/domain/usecases/shelveChanges');
const { Patches } = require('../src/domain/usecases/patches');
const { ShelfRejected } = require('../src/domain/errors');
const {
  newShelfId, isShelfId, isShelfDir, defaultShelfName, serializeShelf, updateShelfJson, parseShelf, newestFirst, shelfStatus,
} = require('../src/domain/logic/shelf');
const {
  isMailbox, parsePatchStat, appliedWithConflicts, splitRename, unquotePath, patchFileName, normalizeClipboardPatch, oldestFirst,
} = require('../src/domain/logic/patch');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_shelf_'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  };
  const read = (p) => fs.readFileSync(path.join(dir, p));
  const exists = (p) => fs.existsSync(path.join(dir, p));
  const commitAll = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const repo = new Repository(dir);
  const store = new ShelfStore(repo);
  const uc = new ShelveChanges(repo, store);
  const patches = new Patches(repo);
  return {
    dir, git, write, read, exists, commitAll, repo, store, uc, patches,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Every working tree file (bytes, base64) and the index. */
function snapshot(t) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else files[path.relative(t.dir, full).replace(/\\/g, '/')] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(t.dir);
  return { files, index: t.git('ls-files', '-s') };
}

const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join('');

/** Shelves `paths` (paths of the current status) with the use case. */
async function shelve(t, paths, o = {}) {
  const status = await t.repo.status();
  const changes = status.changes.filter((c) => paths.includes(c.path));
  const p = t.uc.prepare({ status, changes, name: o.name || 'My shelf', keep: !!o.keep });
  return t.uc.run(p, o.now);
}

// ---------------------------------------------------------------- shelf format

test('shelf ids: yyyyMMdd-HHmmss-<6 hex> in UTC', () => {
  const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(newShelfId(d, () => 0.5), '20260102-030405-800000');
  assert.equal(newShelfId(d, () => 0), '20260102-030405-000000');
  assert.equal(newShelfId(d, () => 0.99999999), '20260102-030405-ffffff');
  assert.ok(isShelfId(newShelfId(new Date())));
  assert.ok(!isShelfId('20260102-030405-ABCDEF'));
  assert.ok(isShelfDir('20260102-030405-abcdef'));
  for (const bad of ['', '.', '..', '../x', 'a/b', 'x.lock', '-x']) assert.ok(!isShelfDir(bad), bad);
});

test('shelf.json: serialised as specified, read back, unknown fields kept on update', () => {
  const files = [
    { path: 'a.txt', oldPath: null, status: 'M' },
    { path: 'dir/new.txt', oldPath: 'old.txt', status: 'R' },
  ];
  const text = serializeShelf({ name: 'WIP', created: new Date(Date.UTC(2026, 9, 21, 8, 30, 0)), base: 'a'.repeat(40), branch: 'main', files });
  assert.equal(text, `${JSON.stringify({
    version: 1, name: 'WIP', created: '2026-10-21T08:30:00.000Z', base: 'a'.repeat(40), branch: 'main',
    files: [{ path: 'a.txt', oldPath: null, status: 'M' }, { path: 'dir/new.txt', oldPath: 'old.txt', status: 'R' }],
  }, null, 2)}\n`);
  assert.ok(!text.includes('\r'));
  const s = parseShelf(text, 'id1');
  assert.deepEqual(s, { id: 'id1', name: 'WIP', created: Date.UTC(2026, 9, 21, 8, 30, 0), base: 'a'.repeat(40), branch: 'main', files });

  const extended = JSON.stringify({ ...JSON.parse(text), extra: { by: 'flutter' } });
  const renamed = JSON.parse(updateShelfJson(extended, { name: 'Renamed' }));
  assert.equal(renamed.name, 'Renamed');
  assert.deepEqual(renamed.extra, { by: 'flutter' });
  const fewer = JSON.parse(updateShelfJson(text, { files: [files[0]] }));
  assert.deepEqual(fewer.files, [{ path: 'a.txt', oldPath: null, status: 'M' }]);
});

test('parseShelf: written by another app (microseconds, no branch), and invalid files', () => {
  const other = '{"version":1,"name":"From app","created":"2026-10-21T08:30:00.123456Z","base":"' + 'b'.repeat(40) +
    '","branch":null,"files":[{"path":"x","oldPath":null,"status":"A"},{"path":"y","status":"X"},{"oldPath":"z"}]}';
  const s = parseShelf(other, 'x');
  assert.equal(s.branch, null);
  assert.equal(s.created, Date.UTC(2026, 9, 21, 8, 30, 0, 123));
  assert.deepEqual(s.files, [{ path: 'x', oldPath: null, status: 'A' }, { path: 'y', oldPath: null, status: 'M' }]);
  assert.equal(parseShelf('{', 'x'), null);
  assert.equal(parseShelf('{"version":2,"base":"' + 'b'.repeat(40) + '","files":[]}', 'x'), null);
  assert.equal(parseShelf('{"version":1,"base":"HEAD","files":[]}', 'x'), null);
  assert.equal(parseShelf('{"version":1,"base":"' + 'b'.repeat(40) + '"}', 'x'), null);
  assert.equal(parseShelf('{"version":1,"name":"","base":"' + 'b'.repeat(64) + '","files":[]}', 'id').name, 'id');
  const sorted = newestFirst([{ id: 'a', created: 1 }, { id: 'b', created: 3 }, { id: 'c', created: 2 }].map((x) => /** @type {any} */ (x)));
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'c', 'a']);
});

test('defaultShelfName and shelfStatus', () => {
  const now = new Date(2026, 9, 21, 9, 5);
  assert.equal(defaultShelfName('', now), 'Changes from 2026-10-21 09:05');
  assert.equal(defaultShelfName('  \n\n', now), 'Changes from 2026-10-21 09:05');
  assert.equal(defaultShelfName('Fix login\n\nbody', now), 'Fix login');
  assert.deepEqual(['modified', 'typeChanged', 'added', 'copied', 'untracked', 'deleted', 'renamed'].map(shelfStatus),
    ['M', 'M', 'A', 'A', 'A', 'D', 'R']);
});

// ---------------------------------------------------------------- patch parsing

test('isMailbox: format-patch output, mail headers, plain diffs', () => {
  assert.ok(isMailbox(`From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: T <t@e>\nSubject: [PATCH] x\n\n---\n`));
  assert.ok(isMailbox('From: T <t@e>\nDate: now\nSubject: fix\n\ndiff --git a/x b/x\n'));
  assert.ok(!isMailbox('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n'));
  assert.ok(!isMailbox('diff --git a/x b/x\n+From: someone\n+Subject: text\n'));
  assert.ok(!isMailbox(''));
});

test('parsePatchStat: numstat records and summary lines', () => {
  const out = [
    '1\t1\tf.txt', '-\t-\tbin.png', '0\t0\tdir/new.txt', '0\t5\tgone.txt', '1\t0\tsp ace é.txt', '2\t0\tsrc/b.js',
    '3\t1\t', 'old name.txt', 'new name.txt', '4\t0\tf.txt',
    [' create mode 100644 bin.png', ' rename old.txt => dir/new.txt (100%)', ' mode change 100644 => 100755',
      ' delete mode 100644 gone.txt', ' create mode 100644 sp ace é.txt', ' rename src/{a.js => b.js} (90%)',
      ' rename old name.txt => new name.txt (80%)', ''].join('\n'),
  ].join('\0');
  assert.deepEqual(parsePatchStat(out), [
    { path: 'f.txt', oldPath: null, status: 'M', added: 5, deleted: 1 },
    { path: 'bin.png', oldPath: null, status: 'A', added: null, deleted: null },
    { path: 'dir/new.txt', oldPath: 'old.txt', status: 'R', added: 0, deleted: 0 },
    { path: 'gone.txt', oldPath: null, status: 'D', added: 0, deleted: 5 },
    { path: 'sp ace é.txt', oldPath: null, status: 'A', added: 1, deleted: 0 },
    { path: 'src/b.js', oldPath: 'src/a.js', status: 'R', added: 2, deleted: 0 },
    { path: 'new name.txt', oldPath: 'old name.txt', status: 'R', added: 3, deleted: 1 },
  ]);
  assert.deepEqual(parsePatchStat(''), []);
});

test('splitRename, unquotePath, appliedWithConflicts, patchFileName, clipboard, oldestFirst', () => {
  assert.deepEqual(splitRename('a/{ => b}/c.txt'), { oldPath: 'a/c.txt', path: 'a/b/c.txt' });
  assert.deepEqual(splitRename('{x => y}/c.txt'), { oldPath: 'x/c.txt', path: 'y/c.txt' });
  assert.deepEqual(splitRename('a.txt => b.txt'), { oldPath: 'a.txt', path: 'b.txt' });
  assert.equal(splitRename('nothing'), null);
  assert.equal(unquotePath('"a\\tb\\"c\\\\"'), 'a\tb"c\\');
  assert.equal(unquotePath('"\\303\\251.txt"'), 'é.txt');
  assert.equal(unquotePath('plain'), 'plain');
  assert.deepEqual(appliedWithConflicts("Applied patch to 'a.txt' cleanly.\nApplied patch to 'b c.txt' with conflicts.\nU b c.txt\n"), ['b c.txt']);
  assert.equal(patchFileName('feature/login'), 'feature-login.patch');
  assert.equal(patchFileName(null), 'changes.patch');
  assert.equal(normalizeClipboardPatch('a\r\nb\r\n'), 'a\nb\n');
  assert.equal(normalizeClipboardPatch('a\r\nb\n'), 'a\r\nb\n');
  const c = (hash) => ({ hash });
  assert.deepEqual(oldestFirst([c('b'), c('d'), c('a')], ['a', 'b', 'c', 'd']).map((x) => x.hash), ['d', 'b', 'a']);
});

// ---------------------------------------------------------------- shelve / unshelve

/** a, b, c, gone (committed); then a, b, c modified, gone deleted, new untracked; c partly staged. */
function dirtyRepo(t) {
  t.write('a.txt', lines(5));
  t.write('b.txt', lines(5));
  t.write('c.txt', lines(5));
  t.write('gone.txt', 'bye\n');
  const base = t.commitAll('base');
  t.write('a.txt', lines(5, (i) => (i === 2 ? 'A changed' : `line ${i}`)));
  t.write('b.txt', `${lines(5)}tail\n`);
  t.write('c.txt', lines(6));
  t.git('add', 'c.txt');
  t.write('c.txt', lines(7));
  fs.rmSync(path.join(t.dir, 'gone.txt'));
  t.write('new/deep/n.txt', 'brand new\n');
  return base;
}

test('shelve 2 of 3 modified + untracked + deleted: reverted, 3rd and index untouched; unshelve restores all', async () => {
  const t = setup();
  try {
    const base = dirtyRepo(t);
    const before = snapshot(t);
    const shelf = await shelve(t, ['a.txt', 'b.txt', 'gone.txt', 'new/deep/n.txt'], { now: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) });

    assert.match(shelf.id, /^20260102-030405-[0-9a-f]{6}$/);
    assert.equal(shelf.base, base);
    assert.equal(shelf.branch, 'main');
    assert.deepEqual(shelf.files, [
      { path: 'a.txt', oldPath: null, status: 'M' },
      { path: 'b.txt', oldPath: null, status: 'M' },
      { path: 'gone.txt', oldPath: null, status: 'D' },
      { path: 'new/deep/n.txt', oldPath: null, status: 'A' },
    ]);
    const dir = path.join(t.dir, '.git', 'git-tools', 'shelf', shelf.id);
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'shelf.json'), 'utf8'));
    assert.deepEqual(Object.keys(json), ['version', 'name', 'created', 'base', 'branch', 'files']);
    assert.equal(json.created, '2026-01-02T03:04:05.000Z');
    const patch = fs.readFileSync(path.join(dir, 'changes.patch'), 'utf8');
    assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt\nindex [0-9a-f]{40}\.\.[0-9a-f]{40} 100644\n/);
    assert.ok(!patch.includes('\r'));
    assert.ok(!patch.includes('c.txt'));
    assert.equal(t.git('rev-parse', `refs/git-tools/shelf/${shelf.id}`), base);

    // Shelved files are back at HEAD, the rest as it was.
    assert.equal(t.read('a.txt').toString(), lines(5));
    assert.equal(t.read('b.txt').toString(), lines(5));
    assert.equal(t.read('gone.txt').toString(), 'bye\n');
    assert.ok(!t.exists('new'), 'new file and its empty folders removed');
    assert.equal(t.read('c.txt').toString(), lines(7));
    assert.equal(snapshot(t).index, before.index);
    assert.equal(t.git('status', '--porcelain'), 'MM c.txt');

    const listed = await t.store.list();
    assert.deepEqual(listed.map((s) => s.id), [shelf.id]);
    assert.equal((await t.uc.content(shelf, 'a.txt')).toString(), lines(5, (i) => (i === 2 ? 'A changed' : `line ${i}`)));
    assert.equal((await t.uc.content(shelf, 'new/deep/n.txt')).toString(), 'brand new\n');
    assert.equal(await t.uc.content(shelf, 'gone.txt'), null);

    const r = await t.uc.unshelve({ shelf, remove: true });
    assert.equal(r.applied.length, 4);
    assert.deepEqual(r.conflicted, []);
    assert.ok(r.shelfDeleted);
    assert.deepEqual(snapshot(t), before);
    assert.deepEqual(await t.store.list(), []);
    assert.ok(!fs.existsSync(dir));
    assert.equal(t.git('for-each-ref', 'refs/git-tools/'), '');
  } finally {
    t.cleanup();
  }
});

test('shelve with "keep" leaves the working tree and index as they are', async () => {
  const t = setup();
  try {
    dirtyRepo(t);
    const before = snapshot(t);
    const shelf = await shelve(t, ['a.txt', 'new/deep/n.txt'], { keep: true });
    assert.deepEqual(snapshot(t), before);
    assert.deepEqual(shelf.files.map((f) => f.path), ['a.txt', 'new/deep/n.txt']);
  } finally {
    t.cleanup();
  }
});

test('shelve is refused during a merge, without a commit, and skips submodules', async () => {
  const t = setup();
  try {
    const status = { branch: 'main', head: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, changes: [], state: 'merging' };
    const a = { path: 'a.txt', type: 'modified' };
    assert.throws(() => t.uc.prepare({ status, changes: [a], name: 'x' }), (e) => e instanceof ShelfRejected && /merge/.test(e.message));
    assert.throws(() => t.uc.prepare({ status: { ...status, state: 'normal', head: null }, changes: [a], name: 'x' }), ShelfRejected);
    assert.throws(() => t.uc.prepare({ status: { ...status, state: 'normal' }, changes: [a], name: ' ' }), ShelfRejected);
    const sub = { path: 'lib', type: 'modified', submodule: { newCommits: true, modifiedContent: false, untrackedContent: false } };
    assert.throws(() => t.uc.prepare({ status: { ...status, state: 'normal' }, changes: [sub], name: 'x' }), ShelfRejected);
    const p = t.uc.prepare({ status: { ...status, state: 'normal' }, changes: [a, sub], name: ' x ' });
    assert.deepEqual([p.name, p.paths, p.skipped.map((c) => c.path)], ['x', ['a.txt'], ['lib']]);
  } finally {
    t.cleanup();
  }
});

test('partial unshelve of one file: the shelf keeps the rest', async () => {
  const t = setup();
  try {
    dirtyRepo(t);
    const before = snapshot(t);
    const shelf = await shelve(t, ['a.txt', 'b.txt', 'new/deep/n.txt']);
    const r = await t.uc.unshelve({ shelf, paths: ['b.txt'], remove: true });
    assert.deepEqual(r.applied.map((f) => f.path), ['b.txt']);
    assert.ok(!r.shelfDeleted);
    assert.equal(t.read('b.txt').toString(), `${lines(5)}tail\n`);
    assert.equal(t.read('a.txt').toString(), lines(5));
    assert.ok(!t.exists('new/deep/n.txt'));
    const [left] = await t.store.list();
    assert.deepEqual(left.files.map((f) => f.path), ['a.txt', 'new/deep/n.txt']);
    assert.ok(!(await t.store.readPatch(shelf.id)).toString().includes('b.txt'));

    // Apply (keep in shelf), then remove the files by hand.
    const r2 = await t.uc.unshelve({ shelf: left, remove: false });
    assert.equal(r2.applied.length, 2);
    assert.deepEqual(snapshot(t), before);
    assert.equal((await t.store.list()).length, 1);
  } finally {
    t.cleanup();
  }
});

test('unshelve after HEAD moved: conflicting file keeps markers and stays shelved, clean files leave the shelf', async () => {
  const t = setup();
  try {
    t.write('a.txt', lines(5));
    t.write('b.txt', lines(5));
    t.commitAll('base');
    t.write('a.txt', lines(5, (i) => (i === 3 ? 'shelved' : `line ${i}`)));
    t.write('b.txt', `${lines(5)}more\n`);
    const shelf = await shelve(t, ['a.txt', 'b.txt']);
    t.write('a.txt', lines(5, (i) => (i === 3 ? 'committed' : `line ${i}`)));
    t.commitAll('conflicting');
    const r = await t.uc.unshelve({ shelf, remove: true });
    assert.deepEqual(r.applied.map((f) => f.path), ['b.txt']);
    assert.deepEqual(r.conflicted.map((f) => f.path), ['a.txt']);
    assert.ok(!r.shelfDeleted);
    const a = t.read('a.txt').toString();
    assert.match(a, /^<{7} /m);
    assert.match(a, /^committed$/m);
    assert.match(a, /^shelved$/m);
    assert.equal(t.read('b.txt').toString(), `${lines(5)}more\n`);
    assert.deepEqual(await t.repo.unmergedPaths(), ['a.txt']);
    // b.txt is not staged: only the conflict is in the index.
    assert.equal(t.git('diff', '--cached', '--name-only'), 'a.txt');
    const [left] = await t.store.list();
    assert.deepEqual(left.files.map((f) => f.path), ['a.txt']);
    await assert.rejects(t.uc.unshelve({ shelf: left, remove: true }), ShelfRejected);
  } finally {
    t.cleanup();
  }
});

test('unshelve onto a file with uncommitted changes merges them (3-way)', async () => {
  const t = setup();
  try {
    t.write('a.txt', lines(9));
    t.commitAll('base');
    t.write('a.txt', lines(9, (i) => (i === 2 ? 'shelved' : `line ${i}`)));
    const shelf = await shelve(t, ['a.txt']);
    t.write('a.txt', lines(9, (i) => (i === 8 ? 'local' : `line ${i}`)));
    const r = await t.uc.unshelve({ shelf, remove: true });
    assert.deepEqual(r.conflicted, []);
    assert.equal(t.read('a.txt').toString(), lines(9, (i) => (i === 2 ? 'shelved' : i === 8 ? 'local' : `line ${i}`)));
    assert.equal(t.git('diff', '--cached', '--name-only'), '');
  } finally {
    t.cleanup();
  }
});

test('unshelve refused by git changes nothing', async () => {
  const t = setup();
  try {
    t.write('a.txt', 'a\n');
    t.write('b.txt', 'b\n');
    t.commitAll('base');
    t.write('a.txt', 'shelved a\n');
    t.write('b.txt', 'shelved b\n');
    const shelf = await shelve(t, ['a.txt', 'b.txt']);
    t.git('rm', '-q', 'a.txt');
    t.commitAll('a removed');
    t.write('b.txt', 'local b\n');
    const before = snapshot(t);
    await assert.rejects(t.uc.unshelve({ shelf, remove: true }), /a\.txt/);
    assert.deepEqual(snapshot(t), before);
    assert.equal((await t.store.list())[0].files.length, 2);
  } finally {
    t.cleanup();
  }
});

test('unshelve a new file over an untracked one: add/add conflict, nothing lost', async () => {
  const t = setup();
  try {
    t.write('a.txt', 'a\n');
    t.commitAll('base');
    t.write('n.txt', 'shelved\n');
    const shelf = await shelve(t, ['n.txt']);
    t.write('n.txt', 'someone else\n');
    const r = await t.uc.unshelve({ shelf, remove: true });
    assert.deepEqual(r.conflicted.map((f) => f.path), ['n.txt']);
    const n = t.read('n.txt').toString();
    assert.match(n, /someone else/);
    assert.match(n, /shelved/);
    assert.equal((await t.store.list()).length, 1);
  } finally {
    t.cleanup();
  }
});

test('binary files round-trip through a shelf', async () => {
  const t = setup();
  try {
    const bin = (n) => Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * n) % 256));
    t.write('img.bin', bin(7));
    t.commitAll('base');
    t.write('img.bin', bin(13));
    t.write('new.bin', bin(3));
    const before = snapshot(t);
    const shelf = await shelve(t, ['img.bin', 'new.bin']);
    assert.match((await t.store.readPatch(shelf.id)).toString(), /GIT binary patch/);
    assert.deepEqual(t.read('img.bin'), bin(7));
    assert.ok(!t.exists('new.bin'));
    assert.deepEqual(await t.uc.content(shelf, 'img.bin'), bin(13));
    await t.uc.unshelve({ shelf, remove: true });
    assert.deepEqual(snapshot(t), before);
  } finally {
    t.cleanup();
  }
});

test('shelf stays usable after its base commit is rewritten and pruned (ref keeps it)', async () => {
  const t = setup();
  try {
    t.write('a.txt', lines(9));
    t.commitAll('one');
    t.write('a.txt', lines(9, (i) => (i === 8 ? 'only in two' : `line ${i}`)));
    const two = t.commitAll('two');
    t.write('a.txt', lines(9, (i) => (i === 2 ? 'shelved' : i === 8 ? 'only in two' : `line ${i}`)));
    const shelf = await shelve(t, ['a.txt']);
    assert.equal(shelf.base, two);
    t.git('reset', '-q', '--hard', 'HEAD~1');
    t.git('reflog', 'expire', '--expire=now', '--all');
    t.git('gc', '-q', '--prune=now');
    assert.equal(t.git('cat-file', '-t', two), 'commit');
    assert.equal((await t.uc.content(shelf, 'a.txt')).toString(), lines(9, (i) => (i === 2 ? 'shelved' : i === 8 ? 'only in two' : `line ${i}`)));
    const r = await t.uc.unshelve({ shelf, remove: true });
    assert.deepEqual(r.conflicted, []);
    // 3-way merge against the base: the shelved line comes back, "two" stays undone.
    assert.equal(t.read('a.txt').toString(), lines(9, (i) => (i === 2 ? 'shelved' : `line ${i}`)));
  } finally {
    t.cleanup();
  }
});

test('ShelfStore lists a shelf written by another app, renames and deletes it', async () => {
  const t = setup();
  try {
    t.write('a.txt', 'a\n');
    const base = t.commitAll('base');
    t.write('a.txt', 'b\n');
    const patch = t.git('diff', '--binary', '--full-index');
    const id = '20260101-000000-abcdef';
    const dir = path.join(t.dir, '.git', 'git-tools', 'shelf', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'changes.patch'), `${patch}\n`);
    fs.writeFileSync(path.join(dir, 'shelf.json'), JSON.stringify({
      version: 1, name: 'From Flutter', created: '2026-01-01T00:00:00.000Z', base, branch: 'main',
      files: [{ path: 'a.txt', oldPath: null, status: 'M' }], app: 'flutter',
    }));
    t.git('update-ref', `refs/git-tools/shelf/${id}`, base);
    fs.mkdirSync(path.join(t.dir, '.git', 'git-tools', 'shelf', 'half-written'));
    t.git('checkout', '--', 'a.txt');
    const [s] = await t.store.list();
    assert.equal(s.name, 'From Flutter');
    await t.store.rename(id, 'Renamed');
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'shelf.json'), 'utf8'));
    assert.equal(json.name, 'Renamed');
    assert.equal(json.app, 'flutter');
    const r = await t.uc.unshelve({ shelf: (await t.store.list())[0], remove: false });
    assert.equal(r.applied.length, 1);
    assert.equal(t.read('a.txt').toString(), 'b\n');
    await t.store.remove(id);
    assert.ok(!fs.existsSync(dir));
    assert.equal(t.git('for-each-ref', 'refs/git-tools/'), '');
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- patches

test('create patch from commits, apply with git am on another branch: same commits', async () => {
  const t = setup();
  try {
    t.write('a.txt', lines(5));
    t.commitAll('base');
    t.git('checkout', '-q', '-b', 'feature');
    t.write('a.txt', lines(6));
    t.write('img.bin', Buffer.from([0, 1, 2, 3, 255]));
    const c1 = t.commitAll('first change');
    t.write('b.txt', 'b\n');
    const c2 = t.commitAll('second change\n\nwith a body');
    const commits = [await t.repo.commitInfo(c2), await t.repo.commitInfo(c1)];
    const { patch, count } = await t.patches.fromCommits([commits[1], commits[0]], [c2, c1]);
    assert.equal(count, 2);
    assert.ok(isMailbox(patch.toString()));
    assert.ok(patch.toString().indexOf('first change') < patch.toString().indexOf('second change'));

    t.git('checkout', '-q', 'main');
    const preview = await t.patches.inspect(patch);
    assert.ok(preview.mailbox);
    assert.deepEqual(preview.files.map((f) => [f.path, f.status]), [['a.txt', 'M'], ['img.bin', 'A'], ['b.txt', 'A']]);
    assert.deepEqual(preview.check, { conflicts: [], error: null });
    const r = await t.patches.apply(patch, { asCommits: true, files: preview.files, status: await t.repo.status() });
    assert.ok(!r.stopped);
    assert.equal(t.git('log', '--format=%B', '-2'), 'second change\n\nwith a body\n\nfirst change');
    assert.equal(t.git('rev-parse', 'HEAD^{tree}'), t.git('rev-parse', 'feature^{tree}'));
  } finally {
    t.cleanup();
  }
});

test('create patch from working tree files, apply it as changes only', async () => {
  const t = setup();
  try {
    t.write('a.txt', lines(5));
    t.write('b.txt', 'b\n');
    t.commitAll('base');
    t.write('a.txt', lines(6));
    t.write('n.txt', 'new\n');
    t.write('b.txt', 'not exported\n');
    const status = await t.repo.status();
    const patch = await t.patches.fromChanges(status.changes.filter((c) => c.path !== 'b.txt'), status);
    assert.ok(!isMailbox(patch.toString()));
    assert.ok(!patch.toString().includes('b.txt'));
    const index = t.git('ls-files', '-s');
    t.git('checkout', '--', 'a.txt');
    fs.rmSync(path.join(t.dir, 'n.txt'));

    const preview = await t.patches.inspect(patch);
    assert.ok(!preview.mailbox);
    assert.deepEqual(preview.files.map((f) => [f.path, f.status, f.added, f.deleted]), [['a.txt', 'M', 1, 0], ['n.txt', 'A', 1, 0]]);
    const r = await t.patches.apply(patch, { asCommits: false, files: preview.files, status: await t.repo.status() });
    assert.deepEqual(r.conflicted, []);
    assert.equal(t.read('a.txt').toString(), lines(6));
    assert.equal(t.read('n.txt').toString(), 'new\n');
    assert.equal(t.read('b.txt').toString(), 'not exported\n');
    assert.equal(t.git('ls-files', '-s'), index, 'staging unchanged');

    await assert.rejects(t.patches.inspect(Buffer.from('hello\n')), /Not a valid patch|no file changes/);
  } finally {
    t.cleanup();
  }
});

test('git am conflict: state detected, abort restores', async () => {
  const t = setup();
  try {
    t.write('a.txt', lines(3));
    t.commitAll('base');
    t.git('checkout', '-q', '-b', 'feature');
    t.write('a.txt', lines(3, (i) => (i === 2 ? 'feature' : `line ${i}`)));
    const c = t.commitAll('feature change');
    const { patch } = await t.patches.fromCommits([await t.repo.commitInfo(c)], [c]);
    t.git('checkout', '-q', 'main');
    t.write('a.txt', lines(3, (i) => (i === 2 ? 'main' : `line ${i}`)));
    const head = t.commitAll('main change');

    const preview = await t.patches.inspect(patch);
    assert.deepEqual(preview.check.conflicts, ['a.txt']);
    const r = await t.patches.apply(patch, { asCommits: true, files: preview.files, status: await t.repo.status() });
    assert.ok(r.stopped);
    assert.deepEqual(r.conflicted, ['a.txt']);
    assert.equal(await t.repo.repoState(), 'applyingMailbox');
    assert.equal((await t.repo.status()).state, 'applyingMailbox');
    assert.ok(await t.repo.rebaseProgress());
    await t.repo.abortOperation('applyingMailbox');
    assert.equal(await t.repo.repoState(), 'normal');
    assert.equal(t.git('rev-parse', 'HEAD'), head);
    assert.equal(t.git('status', '--porcelain'), '');
  } finally {
    t.cleanup();
  }
});
