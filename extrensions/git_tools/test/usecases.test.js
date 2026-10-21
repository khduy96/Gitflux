// Use cases with an in-memory repository: no git, no VS Code.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CommitChanges } = require('../src/domain/usecases/commitChanges');
const { GenerateCommitMessage } = require('../src/domain/usecases/generateCommitMessage');
const { CommitRejected, StaleSelectionError } = require('../src/domain/errors');
const { parseDiff, buildContent } = require('../src/domain/logic/lineSelection');

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 0000001..0000002 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,3 @@',
  '-a',
  '+A',
  ' b',
  '+c',
  '',
].join('\n');

/** Only the members the use cases call. */
function fakeRepo(o = {}) {
  const calls = {};
  return {
    calls,
    fileDiff: async () => DIFF,
    show: async () => Buffer.from('a\nb\n'),
    diffPerFile: async () => new Map(Object.entries(o.perFile || {})),
    recentSubjects: async () => ['Fix the build'],
    lastCommitMessage: async () => '',
    refExists: async () => true,
    changedFiles: async () => [],
    commit: async (x) => { calls.commit = x; },
    commitSelected: async (x) => { calls.commitSelected = x; },
  };
}

const a = { path: 'a.txt', type: 'modified' };
const b = { path: 'b.txt', type: 'modified' };
const status = (o = {}) => ({ branch: 'main', head: 'abc', upstream: null, ahead: 0, behind: 0, changes: [a, b], state: 'normal', ...o });

test('CommitChanges rejects invalid commits in order', async () => {
  const uc = new CommitChanges(/** @type {any} */ (fakeRepo()));
  const prepare = (o) => uc.prepare({ status: status(), message: 'msg', changes: [a, b], lineSelections: new Map(), ...o });
  const rejected = (msg) => (e) => e instanceof CommitRejected && e.message.startsWith(msg);
  await assert.rejects(prepare({ message: '' }), rejected('Commit message is empty'));
  await assert.rejects(prepare({ status: status({ changes: [{ path: 'x', type: 'conflicted' }] }) }), rejected('Resolve all conflicts'));
  await assert.rejects(prepare({ changes: [] }), rejected('No changes selected'));
  const sel = { signature: parseDiff(DIFF).signature, excluded: new Set(['0:0']), total: 3 };
  await assert.rejects(prepare({ status: status({ state: 'merging' }), lineSelections: new Map([['a.txt', sel]]) }),
    rejected('Selecting individual lines is not possible'));
});

test('CommitChanges commits whole files with --only outside an operation', async () => {
  const repo = fakeRepo();
  const uc = new CommitChanges(/** @type {any} */ (repo));
  await uc.run(await uc.prepare({ status: status(), message: 'msg', changes: [a, { path: 'n.txt', oldPath: 'o.txt', type: 'renamed' }], lineSelections: new Map() }));
  assert.deepEqual(repo.calls.commit, { message: 'msg', paths: ['a.txt', 'n.txt', 'o.txt'], amend: false, signOff: false, sign: null, partial: true });

  await uc.run(await uc.prepare({ status: status({ state: 'merging' }), message: 'msg', changes: [], lineSelections: new Map() }));
  assert.equal(repo.calls.commit.partial, false);
});

test('CommitChanges commits selected lines through commitSelected', async () => {
  const repo = fakeRepo();
  const uc = new CommitChanges(/** @type {any} */ (repo));
  const parsed = parseDiff(DIFF);
  const sel = { signature: parsed.signature, excluded: new Set(['0:3']), total: 3 };
  await uc.run(await uc.prepare({ status: status(), message: 'msg', changes: [a, b], lineSelections: new Map([['a.txt', sel]]) }));
  assert.equal(repo.calls.commit, undefined);
  assert.deepEqual(repo.calls.commitSelected, {
    message: 'msg',
    fullPaths: ['b.txt'],
    partial: [{ path: 'a.txt', content: buildContent('a\nb\n', parsed, sel.excluded) }],
    amend: false,
    signOff: false,
    sign: null,
  });
});

test('CommitChanges reports a stale line selection', async () => {
  const uc = new CommitChanges(/** @type {any} */ (fakeRepo()));
  const sel = { signature: 'outdated', excluded: new Set(['0:0']), total: 3 };
  await assert.rejects(uc.prepare({ status: status(), message: 'msg', changes: [a], lineSelections: new Map([['a.txt', sel]]) }),
    (e) => e instanceof StaleSelectionError && e.path === 'a.txt');
});

test('GenerateCommitMessage sends small diffs and lists large ones by name', async () => {
  const repo = fakeRepo({ perFile: { 'a.txt': 'diff of a\n', 'b.txt': 'x'.repeat(50000) } });
  let created;
  let request;
  const uc = new GenerateCommitMessage(/** @type {any} */ (repo), (provider, o) => {
    created = { provider, ...o };
    return {
      generate: async (req, onText) => { request = req; onText('Add c'); return 'Add c'; },
      testConnection: async () => {},
      cancel: () => {},
    };
  });
  const streamed = [];
  const info = [];
  const result = await uc.run({
    status: status(),
    changes: [a, b],
    amend: false,
    lineSelections: new Map(),
    config: { provider: 'gemini', apiKey: 'k', model: 'm', language: 'English' },
    onText: (t) => streamed.push(t),
    onInfo: (t) => info.push(t),
  });

  assert.deepEqual(result, { message: 'Add c', omitted: ['b.txt'] });
  assert.deepEqual(streamed, ['Add c']);
  assert.deepEqual(created, { provider: 'gemini', apiKey: 'k', model: 'm' });
  assert.match(info[0], /^Generating commit message with m \(2 files/);
  assert.equal(request.branch, 'main');
  assert.equal(request.language, 'English');
  assert.deepEqual(request.recentSubjects, ['Fix the build']);
  assert.deepEqual(request.files, ['modified: a.txt', 'modified: b.txt']);
  assert.match(request.diff, /diff of a/);
  assert.match(request.diff, /diff of b\.txt omitted: too large/);
});
