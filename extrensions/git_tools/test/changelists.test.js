// Changelists: changelists.json format (shared with the Flutter app), list rules and temporary repositories.
// Run: node --test test/changelists.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { ChangelistStore } = require('../src/data/changelistStore');
const { Changelists } = require('../src/domain/usecases/changelists');
const { CommitChanges } = require('../src/domain/usecases/commitChanges');
const {
  DEFAULT_LIST, newChangelistId, emptyChangelists, normalizeChangelists, parseChangelists, serializeChangelists, listOf,
  listByName, validateChangelistName, reconcileChangelists, moveToChangelist, createChangelist, editChangelist,
  deleteChangelist, deleteTarget, setActiveChangelist, activeList,
} = require('../src/domain/logic/changelists');

const FIXTURE = path.join(__dirname, 'fixtures', 'changelists_flutter.json');

/** Two lists: default (a, b) and "Feature" (c), Feature active. */
function sample() {
  return normalizeChangelists({
    version: 1,
    active: 'f1',
    lists: [
      { id: 'default', name: 'Changes', comment: '', files: ['a.txt', 'b.txt'] },
      { id: 'f1', name: 'Feature', comment: 'draft', files: ['c.txt'] },
    ],
  });
}

const change = (p, type = 'modified', oldPath) => ({ path: p, type, ...(oldPath ? { oldPath } : {}) });
const filesOf = (data, id) => data.lists.find((l) => l.id === id).files;

// ---------------------------------------------------------------- format

test('empty changelists: only the default list, active', () => {
  const d = emptyChangelists();
  assert.deepEqual(d, { version: 1, active: 'default', lists: [{ id: 'default', name: 'Changes', comment: '', files: [] }] });
});

test('normalize: default list added, unknown active reset, one list per file, paths with forward slashes', () => {
  const d = normalizeChangelists({
    active: 'gone',
    lists: [
      { id: 'x', name: 'X', files: ['dir\\a.txt', 'b.txt', 'b.txt', 3] },
      { id: 'x', name: 'duplicate id' },
      { name: 'no id' },
      { id: 'y', name: '  ', comment: 5, files: ['b.txt', 'c.txt'] },
    ],
  });
  assert.equal(d.version, 1);
  assert.equal(d.active, DEFAULT_LIST);
  assert.deepEqual(d.lists.map((l) => l.id), ['default', 'x', 'y']);
  assert.deepEqual(filesOf(d, 'x'), ['dir/a.txt', 'b.txt']);
  assert.deepEqual(filesOf(d, 'y'), ['c.txt']);
  assert.equal(d.lists[2].name, 'y');
  assert.equal(d.lists[2].comment, '');
  assert.equal(d.lists[0].name, 'Changes');
});

test('parse / serialize: unknown fields kept at the top level and per list, 2-space JSON with a trailing newline', () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const d = parseChangelists(text);
  assert.equal(d.active, '20260301-101500-a1b2c3');
  assert.equal(d.writer, 'git_tools flutter');
  assert.equal(d.lists[1].color, 'blue');
  assert.equal(d.lists[1].comment, 'Add feature X\n\nWith a body line.');
  const out = serializeChangelists(moveToChangelist(d, ['README.md'], '20260302-080000-0f0f0f'));
  assert.ok(out.endsWith('}\n'));
  assert.match(out, /^\{\n {2}"version": 1,\n {2}"active": /);
  const back = JSON.parse(out);
  assert.equal(back.writer, 'git_tools flutter');
  assert.equal(back.lists[1].color, 'blue');
  assert.deepEqual(back.lists[2].files, ['README.md']);
  // A BOM is accepted; anything that is not a JSON object is refused.
  assert.ok(parseChangelists(`﻿${text}`));
  assert.equal(parseChangelists('{ "version": 1, '), null);
  assert.equal(parseChangelists('[]'), null);
  assert.equal(parseChangelists('null'), null);
});

test('changelist ids: yyyyMMdd-HHmmss-<6 hex> in UTC', () => {
  assert.equal(newChangelistId(new Date(Date.UTC(2026, 2, 4, 5, 6, 7)), () => 0.25), '20260304-050607-400000');
  assert.match(newChangelistId(new Date()), /^\d{8}-\d{6}-[0-9a-f]{6}$/);
});

// ---------------------------------------------------------------- reconcile

test('reconcile: a file seen for the first time goes to the active list, unversioned files to none', () => {
  const d = reconcileChangelists(sample(), [change('a.txt'), change('c.txt'), change('new.txt', 'added'), change('u.txt', 'untracked')]);
  assert.deepEqual(filesOf(d, 'f1'), ['c.txt', 'new.txt']);
  assert.equal(listOf(d, 'u.txt'), null);
  // Assigned once: making another list active does not move it.
  const later = reconcileChangelists(setActiveChangelist(d, 'default'), [change('a.txt'), change('c.txt'), change('new.txt', 'added')]);
  assert.equal(listOf(later, 'new.txt'), 'f1');
});

test('reconcile: paths no longer changed are pruned, lists are kept', () => {
  const d = reconcileChangelists(sample(), [change('b.txt')]);
  assert.deepEqual(filesOf(d, 'default'), ['b.txt']);
  assert.deepEqual(filesOf(d, 'f1'), []);
  assert.deepEqual(d.lists.map((l) => l.id), ['default', 'f1']);
  assert.equal(d.active, 'f1');
});

test('reconcile: a renamed file takes the place of its old path; a copy does not', () => {
  const d = reconcileChangelists(sample(), [change('a.txt'), change('b.txt'), change('d.txt', 'renamed', 'c.txt')]);
  assert.deepEqual(filesOf(d, 'f1'), ['d.txt']);
  const copied = reconcileChangelists(setActiveChangelist(sample(), 'default'), [change('c.txt'), change('e.txt', 'copied', 'c.txt')]);
  assert.equal(listOf(copied, 'c.txt'), 'f1');
  assert.equal(listOf(copied, 'e.txt'), 'default');
});

test('reconcile: conflicted files keep their list', () => {
  const d = reconcileChangelists(sample(), [change('c.txt', 'conflicted')]);
  assert.equal(listOf(d, 'c.txt'), 'f1');
});

test('reconcile leaves its input untouched', () => {
  const before = sample();
  const copy = JSON.parse(JSON.stringify(before));
  reconcileChangelists(before, [change('x.txt')]);
  moveToChangelist(before, ['a.txt'], 'f1');
  deleteChangelist(before, 'f1');
  assert.deepEqual(before, copy);
});

// ---------------------------------------------------------------- list rules

test('move: files leave every other list; unknown target refused', () => {
  const d = moveToChangelist(sample(), ['a.txt', 'c.txt'], 'f1');
  assert.deepEqual(filesOf(d, 'default'), ['b.txt']);
  assert.deepEqual(filesOf(d, 'f1'), ['c.txt', 'a.txt']);
  assert.throws(() => moveToChangelist(sample(), ['a.txt'], 'nope'));
});

test('create / edit / set active / names', () => {
  let d = createChangelist(sample(), { id: 'n1', name: ' New ', comment: 'msg' });
  assert.deepEqual(d.lists[2], { id: 'n1', name: 'New', comment: 'msg', files: [] });
  assert.throws(() => createChangelist(d, { id: 'n1', name: 'Again' }));
  d = editChangelist(d, 'default', { name: 'Main' });
  assert.equal(d.lists[0].name, 'Main');
  assert.equal(d.lists[0].id, 'default');
  d = setActiveChangelist(d, 'n1');
  assert.equal(activeList(d).id, 'n1');
  assert.equal(validateChangelistName(d, 'feature'), 'A changelist named "Feature" already exists');
  assert.equal(validateChangelistName(d, 'Feature', 'f1'), null);
  assert.equal(validateChangelistName(d, '  '), 'Enter a name');
  assert.equal(listByName(d, ' main ').id, 'default');
});

test('delete: files go to the active list, or to the default list when the active one is deleted', () => {
  let d = createChangelist(sample(), { id: 'n1', name: 'Other' });
  d = moveToChangelist(d, ['a.txt'], 'n1');
  assert.equal(deleteTarget(d, 'n1'), 'f1');
  const a = deleteChangelist(d, 'n1');
  assert.deepEqual(filesOf(a, 'f1'), ['c.txt', 'a.txt']);
  assert.equal(a.active, 'f1');
  assert.equal(deleteTarget(d, 'f1'), 'default');
  const b = deleteChangelist(d, 'f1');
  assert.deepEqual(filesOf(b, 'default'), ['b.txt', 'c.txt']);
  assert.equal(b.active, 'default');
  assert.throws(() => deleteChangelist(d, 'default'), /cannot be deleted/);
});

// ---------------------------------------------------------------- temporary repositories

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_changelists_'));
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
  const repo = new Repository(dir);
  const store = new ChangelistStore(repo);
  const lists = new Changelists(store);
  const file = path.join(dir, '.git', 'git-tools', 'changelists.json');
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) write(f, `${f}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return {
    dir, git, write, repo, store, lists, file,
    /** Status refresh as the model does it. */
    refresh: async () => {
      const status = await repo.status();
      await lists.reconcile(status.changes);
      return status;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('store: no file reads as the default list; writes atomically at git-path git-tools/changelists.json', async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.store.read(), emptyChangelists());
    assert.equal(path.normalize(await t.store.file()), path.normalize(t.file));
    // Nothing changed: no file written.
    await t.refresh();
    assert.equal(fs.existsSync(t.file), false);
    t.write('a.txt', 'changed\n');
    await t.refresh();
    const text = fs.readFileSync(t.file, 'utf8');
    assert.equal(text, serializeChangelists(JSON.parse(text)));
    assert.deepEqual(JSON.parse(text).lists[0].files, ['a.txt']);
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['changelists.json']);
    // A damaged file is reported, not overwritten.
    fs.writeFileSync(t.file, '{ broken');
    await assert.rejects(() => t.refresh(), /not a valid changelists file/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), '{ broken');
  } finally {
    t.cleanup();
  }
});

test('two lists: committing the active one leaves the other list and its files untouched', async () => {
  const t = setup();
  try {
    t.write('a.txt', 'a2\n');
    t.write('b.txt', 'b2\n');
    await t.refresh();
    const feature = await t.lists.create({ name: 'Feature', paths: ['b.txt'] });
    await t.lists.setActive(feature, '');
    t.write('c.txt', 'c2\n'); // first seen while Feature is active
    let status = await t.refresh();
    assert.deepEqual(t.lists.filesOf(feature), ['b.txt', 'c.txt']);
    assert.deepEqual(t.lists.filesOf(DEFAULT_LIST), ['a.txt']);

    // Ticks = the files of the active list.
    const ticked = status.changes.filter((c) => t.lists.listOf(c.path) === t.lists.active);
    const uc = new CommitChanges(t.repo);
    const prepared = await uc.prepare({ status, message: 'Feature', changes: ticked, lineSelections: new Map() });
    await uc.run(prepared);
    assert.deepEqual(t.git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['b.txt', 'c.txt']);

    status = await t.refresh();
    assert.deepEqual(status.changes.map((c) => c.path), ['a.txt']);
    assert.equal(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), 'a2\n');
    assert.deepEqual(t.lists.filesOf(DEFAULT_LIST), ['a.txt']);
    assert.deepEqual(t.lists.filesOf(feature), []);
    assert.ok(t.lists.list(feature), 'an emptied list is kept until the user deletes it');
  } finally {
    t.cleanup();
  }
});

test('move files, rename follow, delete a list (files move to the active list)', async () => {
  const t = setup();
  try {
    t.write('a.txt', 'a2\n');
    t.write('b.txt', 'b2\n');
    await t.refresh();
    const other = await t.lists.create({ name: 'Other' });
    await t.lists.move(['a.txt', 'b.txt'], other);
    assert.deepEqual(t.lists.filesOf(other), ['a.txt', 'b.txt']);
    t.git('mv', 'a.txt', 'renamed.txt');
    await t.refresh();
    assert.deepEqual(t.lists.filesOf(other), ['renamed.txt', 'b.txt']);
    const target = await t.lists.remove(other);
    assert.equal(target, DEFAULT_LIST);
    assert.equal(t.lists.list(other), null);
    assert.deepEqual(t.lists.filesOf(DEFAULT_LIST), ['renamed.txt', 'b.txt']);
    await assert.rejects(() => t.lists.remove(DEFAULT_LIST), /cannot be deleted/);
    await assert.rejects(() => t.lists.create({ name: 'changes' }), /already exists/);
  } finally {
    t.cleanup();
  }
});

test('per-list commit message: saved on switch, restored when switching back', async () => {
  const t = setup();
  try {
    const feature = await t.lists.create({ name: 'Feature', comment: 'Feature draft' });
    assert.equal(await t.lists.setActive(feature, 'Default draft'), 'Feature draft');
    assert.equal(await t.lists.setActive(DEFAULT_LIST, 'Feature draft, edited'), 'Default draft');
    assert.equal(await t.lists.setActive(feature, 'Default draft'), 'Feature draft, edited');
    const saved = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.equal(saved.active, feature);
    assert.equal(saved.lists.find((l) => l.id === DEFAULT_LIST).comment, 'Default draft');
  } finally {
    t.cleanup();
  }
});

test('changes written by the other app are read before every change (nothing lost)', async () => {
  const t = setup();
  try {
    t.write('a.txt', 'a2\n');
    await t.refresh();
    // The Flutter app adds a list and moves a.txt into it.
    const outside = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    outside.lists.push({ id: '20260101-000000-000001', name: 'From app', comment: '', files: ['a.txt'], pinned: true });
    outside.lists[0].files = [];
    fs.writeFileSync(t.file, JSON.stringify(outside));
    t.write('b.txt', 'b2\n');
    await t.refresh();
    const now = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.deepEqual(now.lists.map((l) => [l.name, l.files]), [['Changes', ['b.txt']], ['From app', ['a.txt']]]);
    assert.equal(now.lists[1].pinned, true);
  } finally {
    t.cleanup();
  }
});

test('reads a changelists.json written by the Flutter app (hand-written sample)', async () => {
  const t = setup();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.copyFileSync(FIXTURE, t.file);
    t.write('README.md', 'readme\n');
    t.write('lib/a.dart', 'a\n');
    t.write('lib/b.dart', 'b\n');
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'files');
    t.write('README.md', 'readme 2\n');
    t.write('lib/a.dart', 'a 2\n');
    t.write('lib/c.dart', 'new\n');
    t.git('add', 'lib/c.dart');
    await t.refresh();
    assert.equal(t.lists.active, '20260301-101500-a1b2c3');
    assert.deepEqual(t.lists.filesOf(DEFAULT_LIST), ['README.md']);
    // lib/b.dart is unchanged now (pruned); lib/c.dart is new (active list).
    assert.deepEqual(t.lists.filesOf('20260301-101500-a1b2c3'), ['lib/a.dart', 'lib/c.dart']);
    assert.equal(t.lists.list('20260301-101500-a1b2c3').comment, 'Add feature X\n\nWith a body line.');
    const saved = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.equal(saved.writer, 'git_tools flutter');
    assert.equal(saved.lists[1].color, 'blue');
    assert.deepEqual(saved.lists[2], { id: '20260302-080000-0f0f0f', name: 'Later', comment: '', files: [] });
  } finally {
    t.cleanup();
  }
});

test('changelists are per worktree', async () => {
  const t = setup();
  const wt = path.join(os.tmpdir(), `gt_changelists_wt_${process.pid}_${Date.now()}`);
  try {
    t.git('worktree', 'add', '-q', '-b', 'wt', wt);
    const other = new ChangelistStore(new Repository(wt));
    assert.notEqual(path.normalize(await other.file()), path.normalize(await t.store.file()));
    assert.match((await other.file()).replace(/\\/g, '/'), /\/\.git\/worktrees\/[^/]+\/git-tools\/changelists\.json$/);
  } finally {
    try { t.git('worktree', 'remove', '--force', wt); } catch { /* ignore */ }
    fs.rmSync(wt, { recursive: true, force: true });
    t.cleanup();
  }
});
