// Git LFS: parsing of the git-lfs outputs, pattern matching and temporary repositories.
// Run: node --test test/lfs.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { GitLfs } = require('../src/data/gitLfs');
const {
  parsePointer, parseCheckAttrLfs, parseLsFiles, parseLocksJson, parseVerifyLocksJson, parseTrackList, parsePruneDryRun,
  trackPatternOptions, patternMatches, patternsFor, removeAttrPattern, isLfsError, lfsErrorLines, formatSize, describePointer, describeLock,
} = require('../src/domain/logic/lfs');

const OID = '516a5e926ce20c5f4d80f00e1a01abdf14986def6588d6abeed9fce090bc660c';
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 7\n`;

/** Whether git-lfs is installed: the integration tests are skipped otherwise. */
const hasLfs = (() => {
  try {
    return /git-lfs\//.test(execFileSync('git', ['lfs', 'version'], { stdio: 'pipe' }).toString());
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------- parsing

test('pointer files: oid and size; anything else is not a pointer', () => {
  assert.deepEqual(parsePointer(POINTER), { oid: OID, size: 7 });
  assert.deepEqual(parsePointer(Buffer.from(POINTER.replace(/\n/g, '\r\n'))), { oid: OID, size: 7 });
  assert.deepEqual(parsePointer(`version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'a'.repeat(64)}\noid sha256:${OID}\nsize 0\n`), { oid: OID, size: 0 });
  assert.equal(parsePointer('hello world\n'), null);
  assert.equal(parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\n`), null, 'size missing');
  assert.equal(parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:xyz\nsize 7\n`), null);
  assert.equal(parsePointer(POINTER + 'x'.repeat(2000)), null, 'too big');
  assert.equal(parsePointer(null), null);
});

test('check-attr -z: the paths whose filter is lfs', () => {
  const out = 'x.bin\0filter\0lfs\0a.txt\0filter\0unspecified\0dir/b c.png\0filter\0lfs\0o.dat\0filter\0unset\0';
  assert.deepEqual([...parseCheckAttrLfs(out)], ['x.bin', 'dir/b c.png']);
  assert.equal(parseCheckAttrLfs('').size, 0);
});

test('lfs ls-files: JSON and the text listing', () => {
  const json = JSON.stringify({ files: [
    { name: 'assets/a.txt', size: 3, checkout: true, downloaded: true, oid_type: 'sha256', oid: OID, version: 'https://git-lfs.github.com/spec/v1' },
    { name: 'x.bin', size: 7, checkout: false, downloaded: false, oid: 'b'.repeat(64) },
  ] }, null, 1);
  assert.deepEqual(parseLsFiles(json), [
    { oid: OID, path: 'assets/a.txt', size: 3, downloaded: true },
    { oid: 'b'.repeat(64), path: 'x.bin', size: 7, downloaded: false },
  ]);
  assert.deepEqual(parseLsFiles(`${OID} * assets/a b.txt\n${'c'.repeat(10)} - x.bin\n`), [
    { oid: OID, path: 'assets/a b.txt', size: null, downloaded: true },
    { oid: 'c'.repeat(10), path: 'x.bin', size: null, downloaded: false },
  ]);
  assert.deepEqual(parseLsFiles('{"files": nope'), []);
});

test('lfs locks --json and --verify --json', () => {
  const locks = '[{"id":"12","path":"art/a.psd","owner":{"name":"Ann"},"locked_at":"2026-10-21T14:03:00Z"},{"id":3,"path":"b.psd"}]';
  assert.deepEqual(parseLocksJson(locks), [
    { id: '12', path: 'art/a.psd', owner: 'Ann', lockedAt: '2026-10-21T14:03:00Z' },
    { id: '3', path: 'b.psd', owner: '', lockedAt: '' },
  ]);
  assert.deepEqual(parseLocksJson('[]'), []);
  assert.equal(parseLocksJson('Error while retrieving locks'), null);
  assert.equal(parseLocksJson('{"ours":[]}'), null);
  const v = parseVerifyLocksJson('{"ours":[{"id":"1","path":"a","owner":{"name":"me"}}],"theirs":[{"id":"2","path":"b","owner":{"name":"Bob"}}]}');
  assert.deepEqual(v && v.ours.map((l) => l.id), ['1']);
  assert.deepEqual(v && v.theirs.map((l) => l.owner), ['Bob']);
  assert.equal(parseVerifyLocksJson('[]'), null);
  assert.equal(describeLock({ id: '1', path: 'a', owner: 'Ann', lockedAt: '2026-10-21T14:03:00Z', mine: true }), 'Locked by Ann (you) since 2026-10-21 14:03');
  assert.equal(describeLock({ id: '1', path: 'a', owner: '', lockedAt: '' }), 'Locked by unknown user');
});

test('lfs track listing: JSON and text; excluded patterns left out, sources with forward slashes', () => {
  const json = JSON.stringify({ patterns: [
    { pattern: 'sub/*.dat', source: 'sub\\.gitattributes', lockable: false, tracked: true },
    { pattern: '*.psd', source: '.gitattributes', lockable: true, tracked: true },
    { pattern: '!*.tmp', source: '.gitattributes', lockable: false, tracked: false },
  ] });
  const expected = [
    { pattern: 'sub/*.dat', source: 'sub/.gitattributes', lockable: false },
    { pattern: '*.psd', source: '.gitattributes', lockable: true },
  ];
  assert.deepEqual(parseTrackList(json), expected);
  const text = [
    'Listing tracked patterns',
    '    sub/*.dat (sub\\.gitattributes)',
    '    *.psd [lockable] (.gitattributes)',
    'Listing excluded patterns',
    '    !*.tmp (.gitattributes)',
    '',
  ].join('\n');
  assert.deepEqual(parseTrackList(text), expected);
  assert.deepEqual(parseTrackList('Listing tracked patterns\nListing excluded patterns\n'), []);
});

test('lfs prune --dry-run --verbose: objects and summary (progress redraws with \\r)', () => {
  const out = `prune: 5 local objects, 4 retained\rprune: 5 local objects, 4 retained, done.\n\rprune: 1 file would be pruned (12 B), done.\n * ${OID} (12 B)\n`;
  assert.deepEqual(parsePruneDryRun(out), { objects: [{ oid: OID, size: '12 B' }], summary: '1 file would be pruned (12 B)' });
  assert.deepEqual(parsePruneDryRun('prune: 4 local objects, 4 retained, done.\n'), { objects: [], summary: '4 local objects, 4 retained' });
});

test('Track with LFS options: exact paths, extensions, folders, no duplicates', () => {
  assert.deepEqual(trackPatternOptions(['assets/img/a.png', 'assets/img/b.png', 'Makefile']).map((o) => `${o.kind}:${o.pattern}`), [
    'path:assets/img/a.png', 'path:assets/img/b.png', 'path:Makefile', 'extension:*.png', 'directory:assets/img/**',
  ]);
  assert.deepEqual(trackPatternOptions(['.env']).map((o) => o.pattern), ['.env'], 'a dot file has no extension');
});

test('gitattributes patterns: which tracked pattern covers a file', () => {
  const p = (pattern, source = '.gitattributes') => ({ pattern, source, lockable: false });
  assert.ok(patternMatches(p('*.bin'), 'x.bin'));
  assert.ok(patternMatches(p('*.bin'), 'a/b/x.bin'), 'no slash: any depth');
  assert.ok(!patternMatches(p('*.bin'), 'x.binary'));
  assert.ok(patternMatches(p('assets/**'), 'assets/a/b.png'));
  assert.ok(!patternMatches(p('assets/**'), 'x/assets/b.png'), 'with a slash: anchored');
  assert.ok(patternMatches(p('docs/*.pdf'), 'docs/a.pdf'));
  assert.ok(!patternMatches(p('docs/*.pdf'), 'docs/sub/a.pdf'), '* stays in one folder');
  assert.ok(patternMatches(p('**/raw/*.wav'), 'a/b/raw/x.wav'));
  assert.ok(patternMatches(p('**/raw/*.wav'), 'raw/x.wav'));
  assert.ok(patternMatches(p('my[[:space:]]file.bin'), 'my file.bin'));
  assert.ok(patternMatches(p('a\\[1\\][[:space:]]b.png'), 'a[1] b.png'));
  assert.ok(patternMatches(p('img?.[pj]ng'), 'img1.png'));
  assert.ok(!patternMatches(p('img?.[!p]ng'), 'img1.png'));
  // Nested .gitattributes: listed with its folder, applies below it at any depth.
  assert.ok(patternMatches(p('sub/*.dat', 'sub/.gitattributes'), 'sub/x/y.dat'));
  assert.ok(!patternMatches(p('sub/*.dat', 'sub/.gitattributes'), 'y.dat'));
  assert.deepEqual(patternsFor([p('*.bin'), p('*.png'), p('assets/**')], ['assets/a.png']).map((x) => x.pattern), ['*.png', 'assets/**']);
});

test('removing a pattern from a .gitattributes keeps the other lines', () => {
  const text = '*.bin filter=lfs diff=lfs merge=lfs -text\r\n*.txt text eol=lf\r\n*.bin -diff\r\n*.psd filter=lfs diff=lfs merge=lfs -text lockable\r\n';
  assert.equal(removeAttrPattern(text, '*.bin'), '*.txt text eol=lf\r\n*.bin -diff\r\n*.psd filter=lfs diff=lfs merge=lfs -text lockable\r\n');
  assert.equal(removeAttrPattern(text, '*.zip'), text);
});

test('LFS errors in push output', () => {
  const stderr = 'Uploading LFS objects:   0% (0/1), 0 B | 0 B/s\nbatch response: Authentication required\nerror: failed to push some refs to \'origin\'';
  assert.ok(isLfsError(stderr));
  assert.deepEqual(lfsErrorLines(stderr), ['Uploading LFS objects:   0% (0/1), 0 B | 0 B/s', 'batch response: Authentication required']);
  assert.ok(isLfsError('error: failed to push some refs\nhint: git-lfs pre-push hook failed'));
  assert.ok(!isLfsError('! [rejected] main -> main (fetch first)'));
});

test('pointer descriptions and sizes', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(30 * 1024 * 1024), '30 MB');
  const text = describePointer({ oid: OID, size: 7 }, { label: 'HEAD', present: true });
  assert.match(text, /oid sha256:516a5e/);
  assert.match(text, /size 7 \(7 B\)/);
  assert.match(text, /object present locally/);
  assert.match(describePointer(null, { label: 'HEAD' }), /no Git LFS pointer/);
});

// ---------------------------------------------------------------- temporary repositories

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt_lfs_'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  // Filters and hooks in this repository only: the global config is not touched.
  git('lfs', 'install', '--local');
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  };
  const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
  const repo = new Repository(dir);
  return { dir, git, write, read, repo, lfs: new GitLfs(repo), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('track *.bin, commit a binary: pointer in the commit, badge, pointers, local object, untrack', { skip: !hasLfs && 'git-lfs is not installed' }, async () => {
  const t = setup();
  try {
    assert.ok(await t.lfs.available());
    assert.match(await t.lfs.version(), /^git-lfs\//);
    await t.lfs.track('*.bin');
    assert.match(t.read('.gitattributes'), /^\*\.bin filter=lfs diff=lfs merge=lfs -text$/m);
    const content = Buffer.from([0, 1, 2, 3, 255, 0, 7]);
    t.write('x.bin', content);
    t.write('a.txt', 'text\n');
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'init');
    assert.ok(t.git('show', 'HEAD:x.bin').startsWith('version https://git-lfs'));

    const sha = crypto.createHash('sha256').update(content).digest('hex');
    assert.deepEqual([...(await t.lfs.lfsPaths(['x.bin', 'a.txt', 'new/y.bin']))].sort(), ['new/y.bin', 'x.bin']);
    assert.equal((await t.lfs.lfsPaths([])).size, 0);
    assert.deepEqual(await t.lfs.pointerAt('HEAD', 'x.bin'), { oid: sha, size: content.length });
    assert.deepEqual(await t.lfs.pointerAt('', 'x.bin'), { oid: sha, size: content.length }, 'index');
    assert.equal(await t.lfs.pointerAt('HEAD', 'a.txt'), null);
    assert.deepEqual(await t.lfs.workingPointer('x.bin'), { oid: sha, size: content.length });
    assert.equal(await t.lfs.workingPointer('missing.bin'), null);
    const obj = await t.lfs.objectFile(sha);
    assert.ok(obj && fs.readFileSync(obj).equals(content));
    assert.equal(await t.lfs.objectFile('0'.repeat(64)), null);
    assert.deepEqual((await t.lfs.lsFiles()).map((f) => [f.path, f.oid, f.downloaded]), [['x.bin', sha, true]]);

    // The working file is a changed version: its own pointer.
    t.write('x.bin', Buffer.from([9, 9, 0]));
    const changed = await t.lfs.workingPointer('x.bin');
    assert.equal(changed && changed.size, 3);
    assert.notEqual(changed && changed.oid, sha);

    // Exact file names are taken literally; nested .gitattributes are listed with their folder.
    await t.lfs.track('my file[1].psd', { filename: true });
    t.write('sub/.gitattributes', '*.dat filter=lfs diff=lfs merge=lfs -text\n*.txt text\n');
    const patterns = await t.lfs.trackedPatterns();
    assert.deepEqual(patterns.map((p) => `${p.pattern} @ ${p.source}`).sort(),
      ['*.bin @ .gitattributes', 'my[[:space:]]file\\[1\\].psd @ .gitattributes', 'sub/*.dat @ sub/.gitattributes'].sort());
    assert.ok(patternsFor(patterns, ['my file[1].psd']).length === 1);
    assert.ok((await t.lfs.lfsPaths(['my file[1].psd'])).has('my file[1].psd'));

    await t.lfs.untrack('*.bin');
    assert.doesNotMatch(t.read('.gitattributes'), /\*\.bin/);
    const literal = patterns.find((p) => p.pattern.startsWith('my'));
    await t.lfs.untrack(/** @type {any} */ (literal));
    assert.doesNotMatch(t.read('.gitattributes'), /my/);
    await t.lfs.untrack(/** @type {any} */ (patterns.find((p) => p.source === 'sub/.gitattributes')));
    assert.equal(t.read('sub/.gitattributes'), '*.txt text\n');
    assert.ok(t.git('status', '--porcelain').includes('.gitattributes'), '.gitattributes shows as changed');
    assert.equal((await t.lfs.lfsPaths(['x.bin'])).size, 0);
  } finally {
    t.cleanup();
  }
});

test('prune dry run lists objects no commit references', { skip: !hasLfs && 'git-lfs is not installed' }, async () => {
  const t = setup();
  try {
    await t.lfs.track('*.bin');
    t.write('x.bin', 'one\n');
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'init');
    // An object in the local storage that no commit uses.
    const orphan = execFileSync('git', ['lfs', 'clean', '--', 'o.bin'], { cwd: t.dir, input: 'orphan data\n' }).toString();
    const oid = /** @type {{oid: string}} */ (parsePointer(orphan)).oid;
    assert.ok(await t.lfs.objectFile(oid));
    const r = parsePruneDryRun((await t.lfs.prune(true)).join('\n'));
    assert.deepEqual(r.objects.map((o) => o.oid), [oid]);
    assert.ok(await t.lfs.objectFile(oid), 'dry run deletes nothing');
    await t.lfs.prune(false);
    assert.equal(await t.lfs.objectFile(oid), null);
  } finally {
    t.cleanup();
  }
});

test('locks: null without a remote and with a remote that does not answer', { skip: !hasLfs && 'git-lfs is not installed' }, async () => {
  const t = setup();
  try {
    assert.equal(await t.lfs.locks(), null);
    t.git('remote', 'add', 'origin', 'https://127.0.0.1:9/none.git');
    const started = Date.now();
    assert.equal(await t.lfs.locks(), null);
    assert.ok(Date.now() - started < 20000);
  } finally {
    t.cleanup();
  }
});
