// Tests for submodule support. Run: node --test test/submodule.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { describeSubmodule } = require('../src/domain/entities');

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_sub_'));
  const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a],
    { cwd: dir, stdio: 'pipe' }).toString();
  const lib = path.join(tmp, 'lib');
  const app = path.join(tmp, 'app');
  fs.mkdirSync(lib);
  git(lib, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(lib, 'a.txt'), 'v1\n');
  git(lib, 'add', '-A');
  git(lib, 'commit', '-qm', 'lib v1');
  fs.mkdirSync(app);
  git(app, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, 'main.txt'), 'app\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'app init');
  git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'libs/core');
  git(app, 'commit', '-qm', 'add submodule');
  return { tmp, app, sub: path.join(app, 'libs', 'core'), git, repo: new Repository(app), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('status, list, readable content and rollback of a submodule', async () => {
  const t = setup();
  try {
    const recorded = t.git(t.app, 'ls-tree', 'HEAD', 'libs/core').split(/\s+/)[2];
    fs.writeFileSync(path.join(t.sub, 'a.txt'), 'v2\n');
    t.git(t.sub, 'commit', '-qam', 'lib v2');
    fs.writeFileSync(path.join(t.sub, 'untracked.txt'), 'u\n');

    let s = await t.repo.status();
    const c = s.changes.find((x) => x.path === 'libs/core');
    assert.equal(c.type, 'modified');
    assert.deepEqual(c.submodule, { newCommits: true, modifiedContent: false, untrackedContent: true });
    assert.equal(describeSubmodule(c.submodule), 'new commits, untracked content');

    let subs = await t.repo.submodules();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].path, 'libs/core');
    assert.equal(subs[0].url, '../lib');
    assert.equal(subs[0].status, 'outOfDate');

    const head = await t.repo.contentAt('HEAD', 'libs/core');
    assert.match(head, /Submodule libs\/core/);
    assert.match(head, new RegExp(`Commit ${recorded}`));
    assert.match(head, /lib v1/);
    const work = await t.repo.contentAt('WORKTREE', 'libs/core');
    assert.match(work, /lib v2/);
    assert.match(work, /Local changes inside the submodule/);
    assert.equal(await t.repo.contentAt('HEAD', 'main.txt'), 'app\n');

    await t.repo.rollback([c], true, false);
    assert.equal(t.git(t.sub, 'rev-parse', 'HEAD').trim(), recorded);
    subs = await t.repo.submodules();
    assert.equal(subs[0].status, 'upToDate');
    s = await t.repo.status();
    assert.deepEqual(s.changes.find((x) => x.path === 'libs/core').submodule,
      { newCommits: false, modifiedContent: false, untrackedContent: true });
  } finally {
    t.cleanup();
  }
});

test('uninitialized submodule', async () => {
  const t = setup();
  try {
    t.git(t.app, 'submodule', 'deinit', '-q', '-f', 'libs/core');
    const subs = await t.repo.submodules();
    assert.equal(subs[0].status, 'uninitialized');
    assert.match(await t.repo.contentAt('HEAD', 'libs/core'), /not available locally/);
    assert.equal(await t.repo.contentAt('WORKTREE', 'libs/core'), null);
  } finally {
    t.cleanup();
  }
});

test('submodule declared in .gitmodules but not registered, and nested repositories', async () => {
  const t = setup();
  try {
    // A clone inside the parent that .gitmodules declares but the index does
    // not record (the situation of lib/features/wallet in a real project).
    const wallet = path.join(t.app, 'lib', 'features', 'wallet');
    fs.mkdirSync(path.dirname(wallet), { recursive: true });
    t.git(path.dirname(wallet), '-c', 'protocol.file.allow=always', 'clone', '-q', path.join(t.tmp, 'lib'), 'wallet');
    t.git(t.app, 'config', '-f', '.gitmodules', 'submodule.lib/features/wallet.path', 'lib/features/wallet');
    t.git(t.app, 'config', '-f', '.gitmodules', 'submodule.lib/features/wallet.url', '../lib');
    // A nested repository that is not declared anywhere.
    const other = path.join(t.app, 'tools', 'other');
    fs.mkdirSync(other, { recursive: true });
    t.git(other, 'init', '-q', '-b', 'main');

    const subs = await t.repo.submodules();
    assert.deepEqual(subs.map((s) => [s.path, s.status]), [['lib/features/wallet', 'notRegistered'], ['libs/core', 'upToDate']]);
    assert.equal(subs[0].url, '../lib');
    assert.match(subs[0].sha, /^[0-9a-f]{40}$/);

    assert.deepEqual((await t.repo.nestedRepositories()).sort(), ['lib/features/wallet', 'tools/other']);

    const s = await t.repo.status();
    const nested = s.changes.filter((c) => c.nestedRepo).map((c) => c.path).sort();
    assert.deepEqual(nested, ['lib/features/wallet', 'tools/other']);
    assert.ok(s.changes.every((c) => !c.path.endsWith('/')));

    // Registering adds a gitlink for the existing repository.
    await t.repo.registerSubmodule('lib/features/wallet', '../lib');
    assert.match(t.git(t.app, 'ls-files', '-s', 'lib/features/wallet'), /^160000 /);
    const after = await t.repo.submodules();
    assert.equal(after.find((x) => x.path === 'lib/features/wallet').status, 'upToDate');
  } finally {
    t.cleanup();
  }
});

test('repository without .gitmodules', async () => {
  const t = setup();
  try {
    assert.deepEqual(await new Repository(path.join(t.tmp, 'lib')).submodules(), []);
  } finally {
    t.cleanup();
  }
});
