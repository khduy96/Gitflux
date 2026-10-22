// "Drop Local and Take <upstream>": a branch diverged from its upstream, and a
// pull stopped on conflicts. Run: node --test test/takeRemote.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { divergedFromUpstream } = require('../src/domain/logic/divergence');

/** A bare origin, a clone where feature has a local commit, and origin's feature moved on (same file: a pull conflicts). */
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_take_'));
  const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe' }).toString().trim();
  const commit = (dir, file, text, msg) => {
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', msg);
  };
  const origin = path.join(tmp, 'origin.git');
  const other = path.join(tmp, 'other');
  const dir = path.join(tmp, 'clone');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', '-c', 'core.autocrlf=false', origin, other);
  commit(other, 'a.txt', 'a\n', 'init');
  git(other, 'checkout', '-q', '-b', 'feature');
  commit(other, 'f.txt', 'base\n', 'feature base');
  git(other, 'push', '-q', 'origin', 'main', 'feature');
  git(tmp, 'clone', '-q', '-c', 'core.autocrlf=false', origin, dir);
  // Repository runs git without the -c above.
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@t'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  git(dir, 'checkout', '-q', 'feature');
  commit(dir, 'f.txt', 'mine\n', 'local work');
  commit(other, 'f.txt', 'theirs\n', 'origin work');
  git(other, 'push', '-q', 'origin', 'feature');
  git(dir, 'fetch', '-q');
  return { dir, git: (...a) => git(dir, ...a), repo: new Repository(dir), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('divergedFromUpstream: only a local branch both ahead and behind its upstream', () => {
  const b = (o) => ({ name: 'x', remote: false, current: false, hash: '', upstream: 'origin/x', ahead: 1, behind: 1, gone: false, ...o });
  assert.equal(divergedFromUpstream(b({})), true);
  assert.equal(divergedFromUpstream(b({ ahead: 0 })), false, 'only behind: a pull fast-forwards');
  assert.equal(divergedFromUpstream(b({ behind: 0 })), false, 'only ahead: a push is enough');
  assert.equal(divergedFromUpstream(b({ upstream: null })), false);
  assert.equal(divergedFromUpstream(b({ gone: true })), false);
  assert.equal(divergedFromUpstream(b({ remote: true })), false);
});

test('the clone sees feature diverged; checkoutFrom takes origin and keeps tracking it', async () => {
  const t = setup();
  try {
    const feature = (await t.repo.branches()).find((x) => x.name === 'feature');
    assert.equal(divergedFromUpstream(feature), true);
    assert.equal((await t.repo.commitsBetween('origin/feature', 'feature')).map((c) => c.subject).join(), 'local work');

    t.git('checkout', '-q', 'main');
    await t.repo.checkoutFrom('feature', 'origin/feature');
    assert.equal(t.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
    assert.equal(t.git('rev-parse', 'feature'), t.git('rev-parse', 'origin/feature'));
    assert.equal(t.git('rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature');
    assert.equal(fs.readFileSync(path.join(t.dir, 'f.txt'), 'utf8'), 'theirs\n');
  } finally { t.cleanup(); }
});

test('pullInProgress: a merge pull and a rebase pull that conflict, not other merges', async () => {
  const t = setup();
  try {
    assert.equal(await t.repo.pullInProgress(), null);
    assert.throws(() => t.git('pull', '--no-rebase', '--no-edit', 'origin', 'feature'));
    assert.deepEqual(await t.repo.pullInProgress(), { branch: 'feature', upstream: 'origin/feature' });
    t.git('merge', '--abort');

    assert.throws(() => t.git('pull', '--rebase', 'origin', 'feature'));
    assert.deepEqual(await t.repo.pullInProgress(), { branch: 'feature', upstream: 'origin/feature' });
    t.git('rebase', '--abort');

    // A conflicting merge of another branch is not a pull.
    t.git('checkout', '-q', '-b', 'other', 'origin/feature');
    t.git('checkout', '-q', 'feature');
    t.git('branch', '--unset-upstream');
    assert.throws(() => t.git('merge', '--no-edit', 'other'));
    assert.equal(await t.repo.pullInProgress(), null);
  } finally { t.cleanup(); }
});
