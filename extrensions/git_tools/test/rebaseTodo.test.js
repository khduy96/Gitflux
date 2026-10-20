// Interactive rebase todo: parsing, validation and the todo that is run. No git.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTodo, analyzeTodo, buildTodo, moveItem, sameShape, indexOfCommit, runIds, shQuote,
} = require('../src/domain/logic/rebaseTodo');

const GIT_TODO = [
  'pick 1111111 First',
  'p 2222222 Second',
  '',
  '# Rebase 0000000..3333333 onto 0000000 (3 commands)',
  '#',
  '# Commands:',
  'pick 3333333 Third',
  '',
].join('\n');

/** Commit items with messages, as InteractiveRebase.prepare() returns them. */
function commits(...specs) {
  return specs.map(([hash, action, message], id) => ({
    id, kind: 'commit', hash: hash.repeat(40 / hash.length), short: hash, subject: message.split('\n')[0], action, message,
  }));
}

test('parseTodo reads commit lines, abbreviated verbs and skips comments', () => {
  const items = parseTodo(GIT_TODO);
  assert.deepEqual(items.map((it) => [it.kind, it.action, it.hash, it.subject]), [
    ['commit', 'pick', '1111111', 'First'],
    ['commit', 'pick', '2222222', 'Second'],
    ['commit', 'pick', '3333333', 'Third'],
  ]);
  assert.deepEqual(items.map((it) => it.id), [0, 1, 2]);
});

test('parseTodo respects core.commentChar', () => {
  const todo = '; Rebase comment\npick 1111111 #1 fix\n# not a comment with ;\n\n; end\n';
  const items = parseTodo(todo, ';');
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'commit');
  assert.equal(items[0].subject, '#1 fix');
  // With ';' as comment char a '#' line is an (unknown) structural line, kept verbatim.
  assert.deepEqual([items[1].kind, items[1].text], ['structural', '# not a comment with ;']);
  assert.deepEqual(parseTodo(todo).map((it) => it.kind), ['structural', 'commit', 'structural'],
    'with # the ; lines are structural and the # line a comment');
});

test('parseTodo keeps merge structure lines verbatim and splits runs', () => {
  const todo = [
    'label onto',
    '',
    '# Branch side',
    'reset onto',
    'pick aaaaaaa Side 1',
    'pick bbbbbbb Side 2',
    'label side',
    '',
    'reset onto',
    'pick ccccccc Main 1',
    'merge -C ddddddd side # Merge branch \'side\'',
    'update-ref refs/heads/other',
    'pick eeeeeee Main 2',
    'noop',
  ].join('\n');
  const items = parseTodo(todo);
  assert.deepEqual(items.map((it) => (it.kind === 'commit' ? it.hash : it.text)), [
    'label onto', 'reset onto', 'aaaaaaa', 'bbbbbbb', 'label side', 'reset onto', 'ccccccc',
    'merge -C ddddddd side # Merge branch \'side\'', 'update-ref refs/heads/other', 'eeeeeee',
  ]);
  assert.deepEqual(items.filter((it) => it.kind === 'structural').map((it) => it.verb),
    ['label', 'reset', 'label', 'reset', 'merge', 'update-ref']);
  assert.deepEqual(runIds(items), [-1, -1, 0, 0, -1, -1, 1, -1, -1, 2]);
  // Commits move only within their run.
  assert.ok(moveItem(items, 2, 3));
  assert.equal(moveItem(items, 3, 4), null);
  assert.equal(moveItem(items, 6, 9), null);
  const moved = /** @type {any[]} */ (moveItem(items, 3, 2));
  assert.ok(sameShape(items, moved));
  const crossed = [...items];
  [crossed[6], crossed[9]] = [crossed[9], crossed[6]];
  assert.equal(sameShape(items, crossed), false);
  const reordered = [...items];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.equal(sameShape(items, reordered), false);
  assert.equal(indexOfCommit(items, 'ccccccc0123'), 6);
});

test('buildTodo: pick, edit, drop, reword', () => {
  const items = commits(['a', 'pick', 'A'], ['b', 'reword', 'B\n\nbody'], ['c', 'edit', 'C'], ['d', 'drop', 'D']);
  items[1].newMessage = 'B2\n\nnew body\n\n';
  const { todo, messages } = buildTodo(items, { stateDir: 'D:\\repo\\.git\\git-tools-rebase' });
  assert.equal(todo, [
    `pick ${'a'.repeat(40)} A`,
    `pick ${'b'.repeat(40)} B`,
    'exec git commit --amend --allow-empty -F \'D:/repo/.git/git-tools-rebase/msg-1.txt\'',
    `edit ${'c'.repeat(40)} C`,
    `drop ${'d'.repeat(40)} D`,
    '',
  ].join('\n'));
  assert.deepEqual([...messages], [['msg-1.txt', 'B2\n\nnew body\n']]);
});

test('buildTodo: squash group gets one message, fixup-only group keeps the first', () => {
  const items = commits(
    ['a', 'pick', 'A\n\nbody A'], ['b', 'squash', 'B'], ['c', 'fixup', 'C'], ['d', 'squash', 'D'],
    ['e', 'pick', 'E'], ['f', 'fixup', 'F'],
  );
  const a = analyzeTodo(items);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.groups.map((g) => [g.head, g.members, g.squash]), [[0, [0, 1, 2, 3], true], [4, [4, 5], false]]);
  assert.equal(a.groups[0].message, 'A\n\nbody A\n\nB\n\nD', 'fixup messages are left out');
  assert.equal(a.groups[1].message, null);

  let { todo, messages } = buildTodo(items, { stateDir: '/r/.git/s' });
  assert.deepEqual(todo.trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' ')), [
    `pick ${'a'.repeat(40)}`, `fixup ${'b'.repeat(40)}`, `fixup ${'c'.repeat(40)}`, `fixup ${'d'.repeat(40)}`,
    'exec git', `pick ${'e'.repeat(40)}`, `fixup ${'f'.repeat(40)}`,
  ]);
  assert.deepEqual([...messages], [['msg-1.txt', 'A\n\nbody A\n\nB\n\nD\n']]);

  items[0].groupMessage = 'Combined';
  ({ messages } = buildTodo(items, { stateDir: '/r/.git/s' }));
  assert.deepEqual([...messages.values()], ['Combined\n']);
});

test('buildTodo: reworded head of a fixup group, edit head of a squash group, drops inside a group', () => {
  const items = commits(['a', 'reword', 'A'], ['b', 'drop', 'B'], ['c', 'fixup', 'C'], ['d', 'edit', 'D'], ['e', 'squash', 'E']);
  items[0].newMessage = 'A2';
  const { todo, messages } = buildTodo(items, { stateDir: '/s' });
  assert.deepEqual(todo.trim().split('\n').map((l) => l.split(' ')[0]), ['pick', 'drop', 'fixup', 'exec', 'edit', 'fixup', 'exec']);
  assert.deepEqual([...messages.values()], ['A2\n', 'D\n\nE\n']);
});

test('analyzeTodo reports a squash without a commit before it, empty messages and all-dropped', () => {
  const items = commits(['a', 'squash', 'A'], ['b', 'reword', 'B'], ['c', 'pick', 'C']);
  items[1].newMessage = '  \n';
  let a = analyzeTodo(items);
  assert.deepEqual(a.errors.map((e) => e.index), [0, 1]);
  assert.match(a.errors[0].message, /no older commit/);
  assert.match(a.errors[1].message, /cannot be empty/);
  assert.throws(() => buildTodo(items, { stateDir: '/s' }), /no older commit/);

  // A dropped first commit does not give the squash a target.
  const dropped = commits(['a', 'drop', 'A'], ['b', 'fixup', 'B']);
  assert.equal(analyzeTodo(dropped).errors.length, 1);

  // First commit of a run after a structural line.
  const runs = [...commits(['a', 'pick', 'A']), { id: 9, kind: 'structural', verb: 'label', text: 'label x' }, ...commits(['b', 'squash', 'B']).map((c) => ({ ...c, id: 10 }))];
  assert.equal(analyzeTodo(runs).errors[0].index, 2);

  const squash = commits(['a', 'pick', 'A'], ['b', 'squash', 'B']);
  squash[0].groupMessage = '';
  assert.match(analyzeTodo(squash).errors[0].message, /cannot be empty/);

  a = analyzeTodo(commits(['a', 'drop', 'A'], ['b', 'drop', 'B']));
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.warnings, ['All commits will be dropped.']);
  assert.equal(buildTodo(commits(['a', 'drop', 'A']), { stateDir: '/s' }).todo, `drop ${'a'.repeat(40)} A\n`);
});

test('buildTodo keeps structural lines and quotes the message path for sh', () => {
  const items = [
    { id: 0, kind: 'structural', verb: 'label', text: 'label onto' },
    ...commits(['a', 'reword', 'A']).map((c) => ({ ...c, id: 1, newMessage: 'A2' })),
    { id: 2, kind: 'structural', verb: 'merge', text: 'merge -C 1234567 side # Merge' },
  ];
  const { todo } = buildTodo(items, { stateDir: 'C:/Users/O\'Brien/repo/.git/git-tools-rebase/' });
  const lines = todo.split('\n');
  assert.equal(lines[0], 'label onto');
  assert.equal(lines[2], 'exec git commit --amend --allow-empty -F \'C:/Users/O\'\\\'\'Brien/repo/.git/git-tools-rebase/msg-1.txt\'');
  assert.equal(lines[3], 'merge -C 1234567 side # Merge');
  assert.equal(shQuote('a b'), '\'a b\'');
});
