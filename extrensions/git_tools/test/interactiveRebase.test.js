// Interactive rebase engine on temporary repositories. Run: node --test test/interactiveRebase.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { InteractiveRebase } = require('../src/domain/usecases/interactiveRebase');
const { RebaseRejected } = require('../src/domain/errors');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_irb_'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  const write = (p, c) => fs.writeFileSync(path.join(dir, p), c);
  /** Commits `file` with `content` (defaults: one file per commit) and returns the hash. */
  const commit = (msg, file = `${msg.split('\n')[0].replace(/\W+/g, '_')}.txt`, content = `${msg}\n`) => {
    write(file, content);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const repo = new Repository(dir);
  const uc = new InteractiveRebase(repo);
  const subjects = (rev = 'HEAD') => git('log', '--format=%s', rev).split('\n');
  return { dir, git, write, commit, repo, uc, subjects, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Everything the preview must leave alone. */
function snapshot(t) {
  return {
    head: t.git('rev-parse', 'HEAD'),
    branch: t.git('symbolic-ref', '--short', 'HEAD'),
    index: t.git('ls-files', '-s'),
    staged: t.git('diff', '--cached'),
    unstaged: t.git('diff'),
    status: t.git('status', '--porcelain=v1', '-uall'),
    stash: t.git('stash', 'list'),
    files: fs.readdirSync(t.dir).filter((f) => f !== '.git').sort().map((f) => [f, fs.readFileSync(path.join(t.dir, f), 'utf8')]),
  };
}

const stateDir = (t) => path.join(t.dir, '.git', 'git-tools-rebase');

test('preview returns git\'s todo and leaves a clean repository untouched', async () => {
  const t = setup();
  try {
    t.commit('one');
    const two = t.commit('two');
    t.commit('three');
    const before = snapshot(t);
    const plan = await t.uc.prepare(two);
    assert.deepEqual(snapshot(t), before);
    assert.equal(plan.base, t.git('rev-parse', `${two}^`));
    assert.equal(plan.rebaseMerges, false);
    assert.equal(plan.pushed, 0);
    assert.deepEqual(plan.items.map((it) => [it.kind, it.action, it.subject]), [['commit', 'pick', 'two'], ['commit', 'pick', 'three']]);
    assert.equal(plan.items[0].hash, two, 'abbreviated todo hashes are resolved');
    assert.equal(plan.items[0].message, 'two');
    assert.equal(fs.existsSync(stateDir(t)), false, 'state folder removed');
    assert.equal(await t.repo.repoState(), 'normal');
  } finally {
    t.cleanup();
  }
});

test('preview leaves a dirty worktree, the index and the stash list untouched', async () => {
  const t = setup();
  try {
    const one = t.commit('one', 'a.txt', 'a1\n');
    t.commit('two', 'b.txt', 'b1\n');
    t.git('stash', 'list');
    t.write('a.txt', 'a-staged\n');
    t.git('add', 'a.txt');
    t.write('a.txt', 'a-staged-and-unstaged\n');
    t.write('b.txt', 'b-unstaged\n');
    t.write('new.txt', 'untracked\n');
    t.write('added.txt', 'added\n');
    t.git('add', 'added.txt');
    // An older stash must stay where it is.
    // Byte-level state the status snapshot does not show.
    const raw = () => ({
      index: fs.readFileSync(path.join(t.dir, '.git', 'index')).toString('base64'),
      mtimes: ['a.txt', 'b.txt', 'new.txt', 'added.txt'].map((f) => fs.statSync(path.join(t.dir, f)).mtimeMs),
      reflog: t.git('reflog', '--format=%H %gs'),
      origHead: fs.existsSync(path.join(t.dir, '.git', 'ORIG_HEAD')) ? fs.readFileSync(path.join(t.dir, '.git', 'ORIG_HEAD'), 'utf8') : null,
    });
    const before = snapshot(t);
    const rawBefore = raw();
    assert.match(before.status, /MM a\.txt/);
    const plan = await t.uc.prepare(one);
    assert.deepEqual(snapshot(t), before);
    assert.deepEqual(raw(), rawBefore, 'real index bytes, file mtimes, reflog and ORIG_HEAD unchanged');
    assert.equal(fs.existsSync(stateDir(t)), false, 'temporary index removed');
    assert.equal(plan.items.length, 2);
  } finally {
    t.cleanup();
  }
});

test('pre-checks: detached HEAD, commit not in history', async () => {
  const t = setup();
  try {
    const one = t.commit('one');
    t.git('checkout', '-q', '-b', 'side');
    const side = t.commit('side');
    t.git('checkout', '-q', 'main');
    t.commit('two');
    await assert.rejects(t.uc.prepare(side), (e) => e instanceof RebaseRejected && /not in the history/.test(e.message));
    t.git('checkout', '-q', '--detach');
    await assert.rejects(t.uc.prepare(one), (e) => e instanceof RebaseRejected && /detached/.test(e.message));
  } finally {
    t.cleanup();
  }
});

test('reorder commits (Move Commit Down / Up)', async () => {
  const t = setup();
  try {
    t.commit('one');
    t.commit('two');
    const three = t.commit('three');
    const p = await t.uc.prepareMove(three, 'down');
    assert.equal(p.plan.base, t.git('rev-parse', 'HEAD~2'));
    const r = await t.uc.run(p.plan, p.items);
    assert.equal(r.stopped, false);
    assert.deepEqual(t.subjects(), ['two', 'three', 'one']);
    const two = t.git('rev-parse', 'HEAD');
    const q = await t.uc.prepareMove(t.git('rev-parse', 'HEAD~1'), 'up');
    await t.uc.run(q.plan, q.items);
    assert.deepEqual(t.subjects(), ['three', 'two', 'one']);
    await assert.rejects(t.uc.prepareMove(t.git('rev-parse', 'HEAD'), 'up'), /newest/);
    assert.notEqual(two, t.git('rev-parse', 'HEAD'));
    assert.equal(fs.existsSync(stateDir(t)), false, 'state folder removed after success');
  } finally {
    t.cleanup();
  }
});

test('squash with a new message', async () => {
  const t = setup();
  try {
    t.commit('base');
    const a = t.commit('A');
    const b = t.commit('B');
    const c = t.commit('C');
    t.commit('D');
    const p = await t.uc.prepareSquash([c, a, b]);
    assert.equal(p.index, 0);
    const group = t.uc.analyze(p.items).groups[0];
    assert.equal(group.message, 'A\n\nB\n\nC', 'prefilled with the joined messages');
    p.items[p.index] = { ...p.items[p.index], groupMessage: 'ABC squashed\n\nbody' };
    await t.uc.run(p.plan, p.items);
    assert.deepEqual(t.subjects(), ['D', 'ABC squashed', 'base']);
    assert.equal(t.git('log', '-1', '--format=%B', 'HEAD~1'), 'ABC squashed\n\nbody');
    assert.deepEqual(t.git('show', '--name-only', '--format=', 'HEAD~1').split('\n').sort(), ['A.txt', 'B.txt', 'C.txt']);
    await assert.rejects(t.uc.prepareSquash([t.git('rev-parse', 'HEAD'), t.git('rev-parse', 'HEAD~2')]), /consecutive/);
  } finally {
    t.cleanup();
  }
});

test('fixup into previous keeps the previous message', async () => {
  const t = setup();
  try {
    t.commit('base');
    t.commit('feature\n\nfeature body');
    const fix = t.commit('fix typo');
    t.commit('next');
    const p = await t.uc.prepareFixup(fix);
    await t.uc.run(p.plan, p.items);
    assert.deepEqual(t.subjects(), ['next', 'feature', 'base']);
    assert.equal(t.git('log', '-1', '--format=%B', 'HEAD~1'), 'feature\n\nfeature body');
    assert.deepEqual(t.git('show', '--name-only', '--format=', 'HEAD~1').split('\n').sort(), ['feature.txt', 'fix_typo.txt']);
  } finally {
    t.cleanup();
  }
});

test('reword an older commit', async () => {
  const t = setup();
  try {
    t.commit('one');
    const two = t.commit('two');
    t.commit('three');
    const author = t.git('log', '-1', '--format=%an %ae %at', two);
    const p = await t.uc.prepareReword(two);
    assert.equal(p.items[p.index].action, 'reword');
    p.items[p.index] = { ...p.items[p.index], newMessage: 'two reworded\n\nwith body' };
    await t.uc.run(p.plan, p.items);
    assert.deepEqual(t.subjects(), ['three', 'two reworded', 'one']);
    assert.equal(t.git('log', '-1', '--format=%B', 'HEAD~1'), 'two reworded\n\nwith body');
    assert.equal(t.git('log', '-1', '--format=%an %ae %at', 'HEAD~1'), author, 'author kept');
  } finally {
    t.cleanup();
  }
});

test('drop several commits', async () => {
  const t = setup();
  try {
    t.commit('one');
    const two = t.commit('two');
    t.commit('three');
    const four = t.commit('four');
    t.commit('five');
    const p = await t.uc.prepareDrop([four, two]);
    assert.deepEqual(p.items.map((it) => it.action), ['drop', 'pick', 'drop', 'pick']);
    await t.uc.run(p.plan, p.items);
    assert.deepEqual(t.subjects(), ['five', 'three', 'one']);
    assert.equal(fs.existsSync(path.join(t.dir, 'two.txt')), false);
  } finally {
    t.cleanup();
  }
});

test('edit stops for amending, then continue finishes', async () => {
  const t = setup();
  try {
    t.commit('one');
    const two = t.commit('two');
    t.commit('three');
    const plan = await t.uc.prepare(two);
    const items = plan.items.map((it, i) => (i === 0 ? { ...it, action: 'edit' } : it));
    const r = await t.uc.run(plan, items);
    assert.equal(r.stopped, true);
    assert.equal(await t.repo.repoState(), 'rebasing');
    const progress = await t.repo.rebaseProgress();
    assert.deepEqual({ ...progress, stoppedSha: progress.stoppedSha && progress.stoppedSha.length },
      { current: 1, total: 2, stoppedForEdit: true, stoppedSha: 8, stoppedSubject: 'two' });
    await assert.rejects(t.uc.prepare(two), (e) => e instanceof RebaseRejected && /rebasing in progress/.test(e.message));
    // Amend as the Commit view does while rebasing.
    t.write('extra.txt', 'extra\n');
    await t.repo.commit({ message: 'two amended', paths: ['extra.txt'], amend: true, partial: false });
    await t.repo.continueOperation('rebasing');
    assert.equal(await t.repo.repoState(), 'normal');
    assert.equal(await t.repo.rebaseProgress(), null);
    assert.deepEqual(t.subjects(), ['three', 'two amended', 'one']);
    assert.match(t.git('show', '--name-only', '--format=', 'HEAD~1'), /extra\.txt/);
  } finally {
    t.cleanup();
  }
});

test('conflict stops the rebase and abort restores the original HEAD', async () => {
  const t = setup();
  try {
    t.commit('base', 'f.txt', '0\n');
    t.commit('first', 'f.txt', '1\n');
    t.commit('second', 'f.txt', '2\n');
    const head = t.git('rev-parse', 'HEAD');
    const p = await t.uc.prepareMove(head, 'down');
    const r = await t.uc.run(p.plan, p.items);
    assert.equal(r.stopped, true);
    assert.equal(await t.repo.repoState(), 'rebasing');
    const progress = await t.repo.rebaseProgress();
    assert.equal(progress.stoppedForEdit, false);
    assert.equal(progress.current, 1);
    assert.ok((await t.repo.status()).changes.some((c) => c.type === 'conflicted'));
    await t.repo.abortOperation('rebasing');
    assert.equal(t.git('rev-parse', 'HEAD'), head);
    assert.equal(t.git('symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(t.git('status', '--porcelain'), '');
  } finally {
    t.cleanup();
  }
});

test('range with a merge commit: reword both sides, the merge survives (--rebase-merges)', async () => {
  const t = setup();
  try {
    t.commit('base');
    t.git('checkout', '-q', '-b', 'side');
    t.commit('side one');
    t.commit('side two');
    t.git('checkout', '-q', 'main');
    const main1 = t.commit('main one');
    t.git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    t.commit('main two');

    const plan = await t.uc.prepare(main1);
    assert.equal(plan.rebaseMerges, true);
    assert.ok(plan.items.some((it) => it.kind === 'structural' && it.verb === 'merge'), 'merge line kept');
    assert.ok(plan.items.some((it) => it.kind === 'structural' && it.verb === 'label'));
    const reword = { 'side one': 'side one reworded', 'main one': 'main one reworded' };
    const items = plan.items.map((it) => (it.kind === 'commit' && reword[it.subject]
      ? { ...it, action: 'reword', newMessage: reword[it.subject] } : it));
    const r = await t.uc.run(plan, items);
    assert.equal(r.stopped, false);

    assert.equal(t.git('log', '-1', '--format=%s', 'HEAD'), 'main two');
    const merge = t.git('rev-parse', 'HEAD~1');
    assert.equal(t.git('log', '-1', '--format=%P', merge).split(' ').length, 2, 'still a merge');
    assert.equal(t.git('log', '-1', '--format=%s', merge), 'Merge side');
    assert.equal(t.git('log', '-1', '--format=%s', `${merge}^1`), 'main one reworded');
    assert.deepEqual(t.git('log', '--format=%s', `${merge}^1..${merge}^2`).split('\n'), ['side two', 'side one reworded']);
    assert.equal(t.git('merge-base', `${merge}^1`, `${merge}^2`), t.git('rev-parse', `${merge}^1^`), 'both sides fork from base');
  } finally {
    t.cleanup();
  }
});

test('autostash restores local changes after the rebase', async () => {
  const t = setup();
  try {
    t.commit('one', 'a.txt', 'a\n');
    const two = t.commit('two');
    t.commit('three');
    t.write('a.txt', 'local change\n');
    t.write('untracked.txt', 'u\n');
    const p = await t.uc.prepareDrop([two]);
    await t.uc.run(p.plan, p.items);
    assert.deepEqual(t.subjects(), ['three', 'one']);
    assert.equal(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), 'local change\n');
    assert.equal(fs.readFileSync(path.join(t.dir, 'untracked.txt'), 'utf8'), 'u\n');
    assert.equal(t.git('stash', 'list'), '');
  } finally {
    t.cleanup();
  }
});

test('commit-msg hook runs on reword; a rejecting hook stops the rebase', async () => {
  const t = setup();
  try {
    t.commit('one');
    const two = t.commit('two');
    t.commit('three');
    const hook = path.join(t.dir, '.git', 'hooks', 'commit-msg');
    // Appends a trailer, rejects messages containing "WIP".
    fs.writeFileSync(hook, '#!/bin/sh\nif grep -q WIP "$1"; then echo "no WIP" >&2; exit 1; fi\necho "Hooked: yes" >> "$1"\n');
    fs.chmodSync(hook, 0o755);

    let p = await t.uc.prepareReword(two);
    p.items[p.index] = { ...p.items[p.index], newMessage: 'two reworded' };
    await t.uc.run(p.plan, p.items);
    assert.equal(t.git('log', '-1', '--format=%B', 'HEAD~1'), 'two reworded\nHooked: yes');

    const head = t.git('rev-parse', 'HEAD');
    p = await t.uc.prepareReword(t.git('rev-parse', 'HEAD~1'));
    p.items[p.index] = { ...p.items[p.index], newMessage: 'WIP' };
    const r = await t.uc.run(p.plan, p.items);
    assert.equal(r.stopped, true);
    assert.equal(await t.repo.repoState(), 'rebasing');
    assert.ok(fs.existsSync(path.join(stateDir(t), 'msg-1.txt')), 'message files kept while rebasing');
    await t.repo.abortOperation('rebasing');
    assert.equal(t.git('rev-parse', 'HEAD'), head);
    await t.repo.cleanupRebaseState();
    assert.equal(fs.existsSync(stateDir(t)), false);
  } finally {
    t.cleanup();
  }
});

test('pushed commits are counted for the force push warning', async () => {
  const t = setup();
  try {
    const one = t.commit('one');
    t.commit('two');
    const remote = `${t.dir}_remote.git`;
    execFileSync('git', ['init', '-q', '--bare', remote]);
    t.git('remote', 'add', 'origin', remote);
    t.git('push', '-q', '-u', 'origin', 'main');
    t.commit('three');
    try {
      assert.equal((await t.uc.prepare(t.git('rev-parse', 'HEAD'))).pushed, 0);
      const plan = await t.uc.prepare(one);
      assert.equal(plan.pushed, 2);
      assert.equal(plan.upstream, 'origin/main');
      assert.equal(plan.base, null, 'root commit: --root');
      assert.deepEqual(plan.items.map((it) => it.subject), ['one', 'two', 'three']);
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  } finally {
    t.cleanup();
  }
});

test('the plan is rejected when the branch moved in the meantime', async () => {
  const t = setup();
  try {
    t.commit('one');
    const two = t.commit('two');
    const p = await t.uc.prepareDrop([two]);
    t.commit('three');
    await assert.rejects(t.uc.run(p.plan, p.items), (e) => e instanceof RebaseRejected && /changed/.test(e.message));
  } finally {
    t.cleanup();
  }
});
