// Annotate with Git Blame: annotation lines (runs, age buckets) and the hover Markdown.
// Run: node --test test/blameAnnotate.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  annotationLines, annotationText, escapeMarkdown, commandUri, hoverMarkdown, fullDate, shortDate,
} = require('../src/domain/logic/blame');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);
const commit = (hash, o = {}) => ({
  hash, author: 'Jane Doe', email: 'jane@example.com', time: 0, summary: 's', previous: null, filename: 'f.txt', uncommitted: false, ...o,
});

function sample() {
  const commits = new Map([
    [A, commit(A, { time: 1000 })],
    [B, commit(B, { author: 'Bob', time: 2000, previous: A })],
    [Z, commit(Z, { author: 'Not Committed Yet', time: 3000, uncommitted: true })],
  ]);
  const lines = [
    { hash: A, line: 1, origLine: 1 },
    { hash: A, line: 2, origLine: 2 },
    { hash: B, line: 3, origLine: 1 },
    { hash: A, line: 4, origLine: 3 },
    { hash: Z, line: 5, origLine: 5 },
    { hash: Z, line: 6, origLine: 6 },
    { hash: A, line: 8, origLine: 4 },
  ];
  return { commits, lines };
}

test('annotationLines: 0-based lines, text on the first line of each run, same width blanks', () => {
  const items = annotationLines(sample(), { buckets: 10 });
  assert.deepEqual(items.map((a) => a.line), [0, 1, 2, 3, 4, 5, 7]);
  assert.deepEqual(items.map((a) => a.first), [true, false, true, true, true, false, true]);
  const width = annotationText(commit(A)).length;
  for (const a of items) assert.equal(a.text.length, width);
  assert.equal(items[0].text, annotationText(sample().commits.get(A)));
  assert.equal(items[1].text.trim(), '');
  assert.match(items[2].text, /^bbbbbbbb {2}Bob/);
  assert.match(items[4].text, /^Not Committed Yet/);
  // A gap in the line numbers starts a new run.
  assert.equal(items[6].text, items[0].text);
  assert.deepEqual(items.map((a) => a.uncommitted), [false, false, false, false, true, true, false]);
});

test('annotationLines: age buckets oldest 0 … newest buckets-1, uncommitted newest', () => {
  const items = annotationLines(sample(), { buckets: 10 });
  assert.equal(items[0].bucket, 0);
  assert.equal(items[2].bucket, 9);
  assert.equal(items[4].bucket, 9);
  assert.deepEqual(annotationLines({ commits: new Map(), lines: [] }), []);
  // Lines whose commit is unknown are skipped.
  assert.deepEqual(annotationLines({ commits: new Map(), lines: [{ hash: A, line: 1, origLine: 1 }] }), []);
});

test('escapeMarkdown neutralizes links, emphasis and HTML', () => {
  assert.equal(escapeMarkdown('*a* [b](c) <i>_x_</i> `y` # 1.'), '\\*a\\* \\[b\\]\\(c\\) \\<i\\>\\_x\\_\\</i\\> \\`y\\` \\# 1\\.');
  assert.equal(escapeMarkdown('plain words'), 'plain words');
});

test('commandUri encodes the argument array (parentheses too)', () => {
  const uri = commandUri('gitTools.blame.showDiff', { path: 'a (1).txt' });
  assert.ok(uri.startsWith('command:gitTools.blame.showDiff?'));
  assert.ok(!/[()]/.test(uri.slice(uri.indexOf('?'))));
  assert.deepEqual(JSON.parse(decodeURIComponent(uri.slice(uri.indexOf('?') + 1))), [{ path: 'a (1).txt' }]);
});

test('hoverMarkdown: hash, author <email>, date, escaped message, links with args', () => {
  const c = commit(B, { author: 'Bob_*', email: 'bob@example.com', time: Date.UTC(2024, 4, 1, 12), previous: A, filename: 'old (name).txt' });
  const md = hoverMarkdown(c, 'Fix [bug]\n\nDetails *here*', 'C:\\repo');
  assert.ok(md.startsWith('`bbbbbbbb`'));
  assert.ok(md.includes('**Bob\\_\\* \\<bob@example\\.com\\>**'));
  assert.ok(md.includes(fullDate(c.time)));
  assert.ok(fullDate(c.time).startsWith(shortDate(c.time)));
  assert.ok(md.includes('Fix \\[bug\\]  \n  \nDetails \\*here\\*'));
  const links = [...md.matchAll(/\[(Show in Log|Show Diff)\]\((command:[^ )]+)/g)];
  assert.deepEqual(links.map((l) => l[1]), ['Show in Log', 'Show Diff']);
  const args = links.map((l) => JSON.parse(decodeURIComponent(l[2].slice(l[2].indexOf('?') + 1)))[0]);
  assert.deepEqual(args[0], { root: 'C:\\repo', hash: B });
  assert.deepEqual(args[1], { root: 'C:\\repo', hash: B, path: 'old (name).txt', previous: A });
  // Empty message → the summary.
  assert.ok(hoverMarkdown(c, '', 'r').includes('\n\ns\n\n'));
});

test('hoverMarkdown: lines not committed yet have no links', () => {
  const md = hoverMarkdown(commit(Z, { uncommitted: true, author: 'External file (--contents)' }), '', 'r');
  assert.equal(md, '**Not Committed Yet**');
});
