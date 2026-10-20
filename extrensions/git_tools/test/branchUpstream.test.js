// Regression: a branch created from origin/<base> must not track <base>, and the first push
// must publish it under its own name. Run: node --test test/branchUpstream.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_up_'));
  const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a],
    { cwd: dir, stdio: 'pipe' }).toString().trim();
  // Independent repo nested inside another one (not a submodule), cloned from its own remote.
  const remote = path.join(tmp, 'cloud_storage.git');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'v1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'branch', 'feat/cloud_upgrade');
  git(tmp, 'clone', '-q', '--bare', seed, remote);
  const parent = path.join(tmp, 'app');
  fs.mkdirSync(parent);
  git(parent, 'init', '-q', '-b', 'main');
  const child = path.join(parent, 'lib', 'features', 'cloud_storage');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  git(tmp, 'clone', '-q', remote, child);
  return { tmp, git, remote, parent, child, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('new branch from a remote branch is published under its own name', async () => {
  const t = setup();
  try {
    const repo = new Repository(t.child);
    const base = 'origin/feat/cloud_upgrade';
    const branch = 'felix/cloud_upgrade/fixBug';
    const baseBefore = t.git(t.remote, 'rev-parse', 'refs/heads/feat/cloud_upgrade');

    // As newBranch() in src/presentation/commands.js does.
    await repo.createBranch(branch, { startPoint: base, checkout: true, fromRemote: true });
    assert.equal((await repo.status()).upstream, null, 'no upstream right after creation');
    assert.equal(t.git(t.child, 'config', '--get', `branch.${branch}.vscode-merge-base`), base);

    fs.writeFileSync(path.join(t.child, 'a.txt'), 'fix\n');
    t.git(t.child, 'commit', '-qam', 'fix');

    // First push as built by push(): target = local name, --set-upstream since there is none.
    await repo.push({ remote: 'origin', branch, target: branch, setUpstream: true });

    assert.equal(t.git(t.remote, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`), `refs/heads/${branch}`);
    assert.equal(t.git(t.child, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`), `origin/${branch}`);
    assert.equal(t.git(t.remote, 'rev-parse', 'refs/heads/feat/cloud_upgrade'), baseBefore, 'base branch untouched');
    assert.equal(t.git(t.parent, 'for-each-ref', 'refs/heads/felix'), '', 'enclosing repo untouched');
  } finally {
    t.cleanup();
  }
});

test('push repairs an upstream that points at a differently named branch', async () => {
  const t = setup();
  try {
    const repo = new Repository(t.child);
    const branch = 'felix/old';
    const baseBefore = t.git(t.remote, 'rev-parse', 'refs/heads/feat/cloud_upgrade');
    // Branch left behind by the old behaviour: tracks origin/feat/cloud_upgrade.
    t.git(t.child, 'checkout', '-q', '--track', '-b', branch, 'origin/feat/cloud_upgrade');
    assert.equal((await repo.status()).upstream, 'origin/feat/cloud_upgrade');
    fs.writeFileSync(path.join(t.child, 'a.txt'), 'fix\n');
    t.git(t.child, 'commit', '-qam', 'fix');

    await repo.push({ remote: 'origin', branch, target: branch, setUpstream: true });

    assert.equal(t.git(t.child, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`), `origin/${branch}`);
    assert.equal(t.git(t.remote, 'rev-parse', 'refs/heads/feat/cloud_upgrade'), baseBefore);
  } finally {
    t.cleanup();
  }
});
