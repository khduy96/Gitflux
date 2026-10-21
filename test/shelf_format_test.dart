import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/shelf.dart';
import 'package:git_tools/domain/logic/patch_parser.dart';
import 'package:git_tools/domain/logic/shelf_format.dart';

void main() {
  group('shelf.json', () {
    final shelf = Shelf(
      id: '20261021-093015-0a1b2c',
      name: 'WIP "login" ✓',
      created: DateTime.utc(2026, 10, 21, 9, 30, 15, 120, 999),
      base: 'a' * 40,
      branch: 'feature/x',
      files: const [
        ShelvedFile(path: 'src/a.dart', status: ShelfFileStatus.modified),
        ShelvedFile(path: 'new.txt', status: ShelfFileStatus.added),
        ShelvedFile(path: 'gone.txt', status: ShelfFileStatus.deleted),
        ShelvedFile(path: 'lib/b.dart', oldPath: 'lib/old_b.dart', status: ShelfFileStatus.renamed),
      ],
    );

    test('writes the shared format', () {
      final json = encodeShelf(shelf);
      expect(json, endsWith('}\n'));
      expect(jsonDecode(json), {
        'version': 1,
        'name': 'WIP "login" ✓',
        'created': '2026-10-21T09:30:15.120Z',
        'base': 'a' * 40,
        'branch': 'feature/x',
        'files': [
          {'path': 'src/a.dart', 'oldPath': null, 'status': 'M'},
          {'path': 'new.txt', 'oldPath': null, 'status': 'A'},
          {'path': 'gone.txt', 'oldPath': null, 'status': 'D'},
          {'path': 'lib/b.dart', 'oldPath': 'lib/old_b.dart', 'status': 'R'},
        ],
      });
    });

    test('round-trips', () {
      final s = decodeShelf(shelf.id, encodeShelf(shelf));
      expect(s.id, shelf.id);
      expect(s.name, shelf.name);
      expect(s.created, DateTime.utc(2026, 10, 21, 9, 30, 15, 120));
      expect(s.created.isUtc, isTrue);
      expect(s.base, shelf.base);
      expect(s.branch, 'feature/x');
      expect(s.files, shelf.files);
      expect(s.ref, 'refs/git-tools/shelf/20261021-093015-0a1b2c');
    });

    test('reads a shelf written by the extension (no branch, compact JSON)', () {
      final s = decodeShelf('20261021-093015-ffffff',
          '{"version":1,"name":"x","created":"2026-10-21T02:30:15.000Z","base":"${'b' * 40}","branch":null,'
          '"files":[{"path":"a b.txt","oldPath":null,"status":"M"}]}');
      expect(s.branch, isNull);
      expect(s.created, DateTime.utc(2026, 10, 21, 2, 30, 15));
      expect(s.files.single.path, 'a b.txt');
      expect(s.files.single.change.type, ChangeType.modified);
    });

    test('rejects invalid or newer files', () {
      expect(() => decodeShelf('x', 'not json'), throwsFormatException);
      expect(() => decodeShelf('x', '[]'), throwsFormatException);
      expect(() => decodeShelf('x', '{"version":2,"name":"x","created":"2026-10-21T02:30:15Z","base":"b","files":[]}'),
          throwsFormatException);
      expect(() => decodeShelf('x', '{"version":1,"name":"x","created":"2026-10-21T02:30:15Z","base":"b",'
          '"files":[{"path":"a","status":"X"}]}'), throwsFormatException);
      expect(() => decodeShelf('x', '{"version":1,"name":"x","created":"yesterday","base":"b","files":[]}'),
          throwsFormatException);
    });

    test('status letters from change types', () {
      expect(ShelfFileStatus.of(ChangeType.untracked), ShelfFileStatus.added);
      expect(ShelfFileStatus.of(ChangeType.typeChanged), ShelfFileStatus.modified);
      expect(ShelvedFile.fromChange(const FileChange(path: 'n', oldPath: 'o', type: ChangeType.renamed)),
          const ShelvedFile(path: 'n', oldPath: 'o', status: ShelfFileStatus.renamed));
    });
  });

  group('shelf id', () {
    test('format', () {
      final id = newShelfId(DateTime.utc(2026, 1, 2, 3, 4, 5), Random(1));
      expect(id, matches(RegExp(r'^20260102-030405-[0-9a-f]{6}$')));
      expect(isShelfId(id), isTrue);
      expect(isShelfId('20260102-030405-ABCDEF'), isFalse);
      expect(isShelfId('2026010-030405-abcdef'), isFalse);
      expect(isShelfId('20260102-030405-abcdef.tmp'), isFalse);
    });

    test('is in UTC', () {
      final local = DateTime(2026, 6, 1, 12);
      expect(newShelfId(local, Random(1)), newShelfId(local.toUtc(), Random(1)));
      expect(newShelfId(DateTime.utc(2026, 6, 1, 12), Random(1)), startsWith('20260601-120000-'));
    });
  });

  test('default shelf name', () {
    expect(defaultShelfName('  Fix login\n\nbody', DateTime(2026)), 'Fix login');
    expect(defaultShelfName('', DateTime(2026, 3, 4, 5, 6)), 'Changes from 2026-03-04 05:06');
  });

  group('mailbox detection', () {
    test('format-patch output', () {
      expect(isMailboxPatch('From ${'1' * 40} Mon Sep 17 00:00:00 2001\nFrom: T <t@t>\nSubject: [PATCH] x\n\n---\n'), isTrue);
      expect(isMailboxPatch('From: T <t@t>\nDate: now\nSubject: [PATCH 1/2] x\n\ndiff --git a/a b/a\n'), isTrue);
    });

    test('plain diffs', () {
      expect(isMailboxPatch('diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-From: x\n+Subject: y\n'), isFalse);
      expect(isMailboxPatch('--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-a\n+b\n'), isFalse);
      expect(isMailboxPatch(''), isFalse);
    });

    test('subjects', () {
      final mbox = 'From ${'1' * 40} Mon Sep 17 00:00:00 2001\nFrom: T <t@t>\nSubject: [PATCH 1/2] First\n line\n\n'
          'Subject: in the body\n---\ndiff --git a/a b/a\n'
          'From ${'2' * 40} Mon Sep 17 00:00:00 2001\nFrom: T <t@t>\nSubject: Second\n\nbody\n';
      expect(mailboxSubjects(mbox), ['First line', 'Second']);
    });
  });

  group('numstat / summary', () {
    test('parses counts, binaries, creations, deletions and renames', () {
      const out = '1\t2\tsrc/a.dart\n'
          '-\t-\timg.png\n'
          '3\t0\tnew file.txt\n'
          '0\t4\tgone.txt\n'
          '0\t0\tlib/new/b.dart\n'
          '1\t1\t"t\\303\\251st\\tx.txt"\n'
          ' create mode 100644 new file.txt\n'
          ' delete mode 100644 gone.txt\n'
          ' rename lib/{old => new}/b.dart (100%)\n'
          ' mode change 100644 => 100755 src/a.dart\n';
      final files = parsePatchStats(out);
      expect(files.map((f) => f.path), ['src/a.dart', 'img.png', 'new file.txt', 'gone.txt', 'lib/new/b.dart', 'tést\tx.txt']);
      expect(files[0].type, ChangeType.modified);
      expect((files[0].added, files[0].deleted), (1, 2));
      expect(files[1].binary, isTrue);
      expect(files[2].type, ChangeType.added);
      expect(files[3].type, ChangeType.deleted);
      expect(files[4].type, ChangeType.renamed);
      expect(files[4].oldPath, 'lib/old/b.dart');
      expect(patchEntryPaths(out), hasLength(6));
    });

    test('a file patched by several commits is listed once', () {
      final files = parsePatchStats('1\t0\ta.txt\n2\t1\ta.txt\n-\t-\tb.bin\n-\t-\tb.bin\n');
      expect(files, hasLength(2));
      expect((files[0].added, files[0].deleted), (3, 1));
      expect(files[1].binary, isTrue);
      expect(patchEntryPaths('1\t0\ta.txt\n2\t1\ta.txt\n'), ['a.txt', 'a.txt']);
    });

    test('rename forms', () {
      expect(expandRename('a.txt => b.txt'), ('a.txt', 'b.txt'));
      expect(expandRename('src/{a => b}/c.txt'), ('src/a/c.txt', 'src/b/c.txt'));
      expect(expandRename('{ => sub}/c.txt'), ('c.txt', 'sub/c.txt'));
      expect(expandRename('dir/{a.txt => }'), ('dir/a.txt', 'dir/'));
      expect(unquotePath('"a\\"b\\\\c"'), 'a"b\\c');
      expect(unquotePath('plain'), 'plain');
    });
  });

  test('filter keeps whole entries', () {
    const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-diff --git x\n+a\n'
        'diff --git a/b.bin b/b.bin\nGIT binary patch\nliteral 3\nKcmZQzU|;|M00aO5\n\n'
        'diff --git a/c.txt b/d.txt\nsimilarity index 100%\nrename from c.txt\nrename to d.txt\n';
    final bytes = utf8.encode(patch);
    expect(splitPatch(bytes), hasLength(3));
    final kept = utf8.decode(filterPatch(bytes, ['a.txt', 'b.bin', 'd.txt'], {'a.txt', 'd.txt'}));
    expect(kept, startsWith('diff --git a/a.txt'));
    expect(kept, contains('-diff --git x\n+a\ndiff --git a/c.txt b/d.txt\n'));
    expect(kept, isNot(contains('b.bin')));
    expect(() => filterPatch(bytes, ['a.txt'], {'a.txt'}), throwsFormatException);
  });
}
