// "Delete" on the current branch: the branches offered to leave it, and the
// use case that deletes it only once HEAD moved. Run: node --test test/deleteCurrentBranch.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { GitError } = require('../src/domain/errors');
const { checkoutTargets, startPoints, stateOperation } = require('../src/domain/logic/leaveBranch');
const { DeleteCurrentBranch } = require('../src/domain/usecases/deleteCurrentBranch');

/** @param {string} name @param {object} [o] */
const local = (name, o = {}) => ({ name, remote: false, hash: '', current: false, upstream: null, ahead: 0, behind: 0, gone: false, ...o });
/** @param {string} name */
const remote = (name) => ({ ...local(name), remote: true });
const names = (list) => list.map((b) => b.name);

test('checkoutTargets: default main, else master, else none; never the branch being deleted', () => {
  const all = [local('dev'), local('feature', { current: true }), local('main'), local('master')];
  const t = checkoutTargets(all, 'feature');
  assert.equal(t.defaultName, 'main');
  assert.deepEqual(names(t.local), ['main', 'dev', 'master'], 'the default comes first');

  assert.equal(checkoutTargets(all, 'main').defaultName, 'master', 'main is the branch being deleted');
  assert.deepEqual(names(checkoutTargets(all, 'main').local), ['master', 'dev', 'feature']);
  assert.equal(checkoutTargets([local('dev'), local('master')], 'dev').defaultName, 'master');
  assert.equal(checkoutTargets([local('dev'), local('feature')], 'feature').defaultName, null);
  assert.deepEqual(names(checkoutTargets([local('dev'), local('feature')], 'feature').local), ['dev']);
  assert.equal(checkoutTargets([local('main'), local('master')], 'master').defaultName, 'main');
  assert.equal(checkoutTargets([local('dev'), remote('origin/main')], 'dev').defaultName, null, 'only a local main counts');
});

test('checkoutTargets: no remote branch that would check out the branch being deleted again', () => {
  const all = [local('feature/x'), local('main'), remote('origin/feature/x'), remote('origin/main'), remote('upstream/feature/x'),
    remote('origin/other')];
  const t = checkoutTargets(all, 'feature/x');
  assert.deepEqual(names(t.local), ['main']);
  assert.deepEqual(names(t.remote), ['origin/main', 'origin/other']);
});

test('startPoints: every branch, the one being deleted included; default main, else master', () => {
  const all = [local('feature', { current: true }), local('main'), remote('origin/feature'), remote('origin/main')];
  const s = startPoints(all);
  assert.equal(s.defaultName, 'main');
  assert.deepEqual(names(s.local), ['main', 'feature']);
  assert.deepEqual(names(s.remote), ['origin/feature', 'origin/main']);

  const deletingMain = startPoints([local('dev'), local('main', { current: true }), local('master')]);
  assert.equal(deletingMain.defaultName, 'main', 'main even when it is the branch being deleted');
  assert.deepEqual(names(deletingMain.local), ['main', 'dev', 'master']);
  assert.equal(startPoints([local('dev'), local('master')]).defaultName, 'master');
  assert.equal(startPoints([local('dev'), remote('origin/main')]).defaultName, null);
});

test('stateOperation names the operation in progress', () => {
  assert.equal(stateOperation('normal'), '');
  assert.equal(stateOperation('merging'), 'merge');
  assert.equal(stateOperation('rebasing'), 'rebase');
  assert.equal(stateOperation('cherryPicking'), 'cherry-pick');
  assert.equal(stateOperation('reverting'), 'revert');
  assert.equal(stateOperation('applyingMailbox'), 'patch application (git am)');
});

/** Only the members the use case calls; HEAD is `head`, deleteBranch fails with `deleteErrors` in order. */
function fakeRepo({ head = 'feature', refs = [], deleteErrors = [] } = {}) {
  const calls = { deleteBranch: [], refExists: [] };
  const state = { head };
  return {
    calls,
    state,
    status: async () => ({ branch: state.head, head: 'abc', upstream: null, ahead: 0, behind: 0, changes: [], state: 'normal' }),
    refExists: async (ref) => { calls.refExists.push(ref); return refs.includes(ref); },
    deleteBranch: async (name, force = false) => {
      calls.deleteBranch.push({ name, force });
      const e = deleteErrors.shift();
      if (e) throw e;
    },
  };
}

const notMerged = (name) => new GitError(['branch', '-d', name], 1, `error: the branch '${name}' is not fully merged\n`, '');
const never = async () => { throw new Error('confirmForce must not be asked'); };

test('DeleteCurrentBranch: HEAD still on the branch, nothing is deleted', async () => {
  const repo = fakeRepo();
  const r = await new DeleteCurrentBranch(/** @type {any} */ (repo)).run({ branch: 'feature', leave: async () => {}, confirmForce: never });
  assert.deepEqual(r, { outcome: 'stayed', head: 'feature' });
  assert.deepEqual(repo.calls.deleteBranch, []);
  assert.deepEqual(repo.calls.refExists, []);
});

test('DeleteCurrentBranch: a new branch created but not checked out is reported', async () => {
  const repo = fakeRepo({ refs: ['refs/heads/next'] });
  const uc = new DeleteCurrentBranch(/** @type {any} */ (repo));
  const r = await uc.run({ branch: 'feature', leave: async () => {}, created: 'next', confirmForce: never });
  assert.deepEqual(r, { outcome: 'stayed', head: 'feature', createdNotCheckedOut: true });
  assert.deepEqual(repo.calls.refExists, ['refs/heads/next']);
  assert.deepEqual(repo.calls.deleteBranch, []);
  const none = await uc.run({ branch: 'feature', leave: async () => {}, created: 'other', confirmForce: never });
  assert.equal(none.createdNotCheckedOut, false);
});

test('DeleteCurrentBranch: an error from leave() propagates and nothing is deleted', async () => {
  const repo = fakeRepo();
  await assert.rejects(new DeleteCurrentBranch(/** @type {any} */ (repo)).run({
    branch: 'feature', leave: async () => { throw new Error('checkout failed'); }, confirmForce: never,
  }), /checkout failed/);
  assert.deepEqual(repo.calls.deleteBranch, []);
});

test('DeleteCurrentBranch: deletes once HEAD moved', async () => {
  const repo = fakeRepo();
  const r = await new DeleteCurrentBranch(/** @type {any} */ (repo)).run({
    branch: 'feature', leave: async () => { repo.state.head = 'main'; }, confirmForce: never,
  });
  assert.deepEqual(r, { outcome: 'deleted', head: 'main' });
  assert.deepEqual(repo.calls.deleteBranch, [{ name: 'feature', force: false }]);
});

test('DeleteCurrentBranch: HEAD moved but leaving reported an error (unstash conflict), nothing is deleted', async () => {
  const repo = fakeRepo();
  const r = await new DeleteCurrentBranch(/** @type {any} */ (repo)).run({
    branch: 'feature', leave: async () => { repo.state.head = 'main'; return false; }, confirmForce: never,
  });
  assert.deepEqual(r, { outcome: 'leaveFailed', head: 'main' });
  assert.deepEqual(repo.calls.deleteBranch, []);

  const ok = await new DeleteCurrentBranch(/** @type {any} */ (fakeRepo())).run({
    branch: 'feature', leave: async () => true, confirmForce: never,
  });
  assert.equal(ok.outcome, 'stayed', 'HEAD still decides first');
});

test('DeleteCurrentBranch: not fully merged and force declined keeps the branch', async () => {
  const repo = fakeRepo({ deleteErrors: [notMerged('feature')] });
  const asked = [];
  const r = await new DeleteCurrentBranch(/** @type {any} */ (repo)).run({
    branch: 'feature', leave: async () => { repo.state.head = 'main'; },
    confirmForce: async (branch, head) => { asked.push([branch, head]); return false; },
  });
  assert.deepEqual(r, { outcome: 'kept', head: 'main' });
  assert.deepEqual(asked, [['feature', 'main']]);
  assert.deepEqual(repo.calls.deleteBranch, [{ name: 'feature', force: false }]);
});

test('DeleteCurrentBranch: not fully merged and force confirmed force deletes', async () => {
  const repo = fakeRepo({ deleteErrors: [notMerged('feature')] });
  const r = await new DeleteCurrentBranch(/** @type {any} */ (repo)).run({
    branch: 'feature', leave: async () => { repo.state.head = 'next'; }, created: 'next', confirmForce: async () => true,
  });
  assert.deepEqual(r, { outcome: 'deleted', head: 'next' });
  assert.deepEqual(repo.calls.deleteBranch, [{ name: 'feature', force: false }, { name: 'feature', force: true }]);
  assert.deepEqual(repo.calls.refExists, []);
});

test('DeleteCurrentBranch: other git errors fail without asking', async () => {
  const repo = fakeRepo({ deleteErrors: [new GitError(['branch', '-d', 'feature'], 1, "error: cannot delete branch 'feature' used by worktree\n", '')] });
  const r = await new DeleteCurrentBranch(/** @type {any} */ (repo)).run({
    branch: 'feature', leave: async () => { repo.state.head = 'main'; }, confirmForce: never,
  });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.head, 'main');
  assert.match(r.error || '', /used by worktree/);
  assert.equal(repo.calls.deleteBranch.length, 1);
});

/** A repository on main with an initial commit; `feature` checked out. */
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_delcur_'));
  const dir = path.join(tmp, 'repo');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  fs.mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  // Repository runs git without -c options.
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@t'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git('config', k, v);
  const commit = (file, text, msg) => {
    fs.writeFileSync(path.join(dir, file), text);
    git('add', '-A');
    git('commit', '-qm', msg);
  };
  commit('a.txt', 'a\n', 'init');
  git('checkout', '-q', '-b', 'feature');
  return { dir, git, commit, repo: new Repository(dir), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('real repository: a merged feature is deleted after checking out main', async () => {
  const t = setup();
  try {
    t.commit('f.txt', 'f\n', 'feature work');
    t.git('checkout', '-q', 'main');
    t.git('merge', '-q', '--no-edit', 'feature');
    t.git('checkout', '-q', 'feature');

    const r = await new DeleteCurrentBranch(t.repo).run({
      branch: 'feature', leave: () => t.repo.checkout('main'), confirmForce: never,
    });
    assert.deepEqual(r, { outcome: 'deleted', head: 'main' });
    assert.equal(t.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(t.git('branch', '--list', 'feature'), '');
  } finally { t.cleanup(); }
});

test('real repository: git\'s "not fully merged" is recognised, declining keeps the branch', async () => {
  const t = setup();
  try {
    t.commit('f.txt', 'f\n', 'unmerged work');
    let asked = 0;
    const r = await new DeleteCurrentBranch(t.repo).run({
      branch: 'feature', leave: async () => { await t.repo.createBranch('next', { startPoint: 'main', checkout: true }); },
      created: 'next', confirmForce: async () => { asked++; return false; },
    });
    assert.deepEqual(r, { outcome: 'kept', head: 'next' });
    assert.equal(asked, 1);
    assert.equal(t.git('rev-parse', '--abbrev-ref', 'HEAD'), 'next');
    assert.notEqual(t.git('branch', '--list', 'feature'), '');
  } finally { t.cleanup(); }
});
