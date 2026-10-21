import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/changelist.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/logic/changelists.dart';
import 'package:git_tools/domain/logic/shelf_format.dart';

/// changelists.json (format shared with the VS Code extension) and the
/// pure list operations.
void main() {
  FileChange mod(String path) => FileChange(path: path, type: ChangeType.modified);
  FileChange renamed(String path, String old) => FileChange(path: path, oldPath: old, type: ChangeType.renamed);
  FileChange untracked(String path) => FileChange(path: path, type: ChangeType.untracked);

  Changelists two() => const Changelists(active: 'default', lists: [
        Changelist(id: 'default', name: 'Changes', files: ['a.txt']),
        Changelist(id: '20260101-000000-aaaaaa', name: 'Feature', comment: 'msg', files: ['b.txt']),
      ]);

  group('format', () {
    test('a file written by the extension is rewritten byte for byte, unknown fields kept', () {
      final text = File('test/fixtures/changelists_extension.json').readAsStringSync().replaceAll('\r\n', '\n');
      final c = decodeChangelists(text);
      expect(c.active, '20260415-093000-c0ffee');
      expect(c.activeList.name, 'Feature Y');
      expect(c.activeList.comment, 'Draft from VS Code\n\nBody line.');
      expect(c.lists.map((l) => l.files.length), [1, 2, 0]);
      expect(encodeChangelists(c), text);
      // Changed known fields keep the unknown ones and the key order.
      final edited = encodeChangelists(moveToChangelist(c, ['a.txt'], c.active));
      expect(edited, contains('"createdBy": {'));
      expect(edited, contains('"lastWriter": "vscode"'));
      expect(edited.indexOf('"readOnly"'), greaterThan(edited.indexOf('"sub/c.txt"')));
      expect(decodeChangelists(edited).activeList.files, ['b.txt', 'sub/c.txt', 'a.txt']);
    });

    test('new file: 2-space indent, trailing newline, shared field names', () {
      expect(encodeChangelists(const Changelists()), '''
{
  "version": 1,
  "active": "default",
  "lists": [
    {
      "id": "default",
      "name": "Changes",
      "comment": "",
      "files": []
    }
  ]
}
''');
    });

    test('invariants: default list added, unknown active, duplicate paths and ids, backslashes', () {
      final c = decodeChangelists('{"version":1,"active":"nope","lists":['
          '{"id":"x","name":"X","files":["a\\\\b.txt","c.txt"]},'
          '{"id":"x","name":"Dup","files":["d.txt"]},'
          '{"id":"y","name":"","files":["c.txt","e.txt"]},'
          '{"name":"no id"}]}');
      expect(c.lists.map((l) => l.id), ['default', 'x', 'y']);
      expect(c.lists.first.name, 'Changes');
      expect(c.active, 'default');
      expect(c.byId('x')!.files, ['a/b.txt', 'c.txt']);
      expect(c.byId('y')!.files, ['e.txt']);
      expect(c.byId('y')!.name, 'y');
    });

    test('a file that is not a JSON object is rejected (never overwritten)', () {
      expect(() => decodeChangelists('{oops'), throwsFormatException);
      expect(() => decodeChangelists('[]'), throwsFormatException);
      expect(decodeChangelists('﻿{"lists":[]}').lists.single.id, 'default');
    });

    test('ids use the shelf id format', () {
      expect(isShelfId(newChangelistId(DateTime.utc(2026, 3, 1, 10, 15), Random(1))), isTrue);
      expect(newChangelistId(DateTime.utc(2026, 3, 1, 10, 15), Random(1)), startsWith('20260301-101500-'));
    });
  });

  group('reconcile', () {
    test('a new change goes to the active list and stays there when the active list changes', () {
      var c = setActiveChangelist(two(), '20260101-000000-aaaaaa');
      c = reconcileChangelists(c, [mod('a.txt'), mod('b.txt'), mod('new.txt')]);
      expect(c.byId('20260101-000000-aaaaaa')!.files, ['b.txt', 'new.txt']);
      c = setActiveChangelist(c, 'default');
      c = reconcileChangelists(c, [mod('a.txt'), mod('b.txt'), mod('new.txt'), mod('later.txt')]);
      expect(c.byId('20260101-000000-aaaaaa')!.files, ['b.txt', 'new.txt']);
      expect(c.byId('default')!.files, ['a.txt', 'later.txt']);
    });

    test('paths no longer changed are pruned; unversioned files are never listed', () {
      final c = reconcileChangelists(two(), [mod('a.txt'), untracked('u.txt')]);
      expect(c.byId('default')!.files, ['a.txt']);
      expect(c.byId('20260101-000000-aaaaaa')!.files, isEmpty);
      expect(c.byId('20260101-000000-aaaaaa')!.comment, 'msg');
    });

    test('a renamed file takes the place of its old path', () {
      final c = reconcileChangelists(two(), [mod('a.txt'), renamed('dir/b2.txt', 'b.txt')]);
      expect(c.byId('20260101-000000-aaaaaa')!.files, ['dir/b2.txt']);
      expect(c.byId('default')!.files, ['a.txt']);
    });
  });

  group('operations', () {
    test('move: out of every other list, appended to the target', () {
      final c = moveToChangelist(two(), ['a.txt', 'b.txt'], '20260101-000000-aaaaaa');
      expect(c.byId('default')!.files, isEmpty);
      expect(c.byId('20260101-000000-aaaaaa')!.files, ['b.txt', 'a.txt']);
      expect(() => moveToChangelist(two(), ['a.txt'], 'nope'), throwsArgumentError);
    });

    test('create / edit / names are unique ignoring case', () {
      var c = createChangelist(two(), id: '20260102-000000-bbbbbb', name: ' Later ');
      expect(c.lists.last.name, 'Later');
      expect(validateChangelistName(c, 'later'), isNotNull);
      expect(validateChangelistName(c, 'LATER', exceptId: '20260102-000000-bbbbbb'), isNull);
      expect(validateChangelistName(c, '  '), isNotNull);
      c = editChangelist(c, 'default', name: 'Main', comment: 'draft');
      expect(c.byId('default')!.name, 'Main');
      expect(c.byId('default')!.comment, 'draft');
    });

    test('delete: files go to the active list; deleting the active list activates the default one', () {
      var c = createChangelist(two(), id: '20260102-000000-bbbbbb', name: 'Later');
      c = moveToChangelist(c, ['x.txt'], '20260102-000000-bbbbbb');
      c = setActiveChangelist(c, '20260101-000000-aaaaaa');
      final d1 = deleteChangelist(c, '20260102-000000-bbbbbb');
      expect(d1.byId('20260101-000000-aaaaaa')!.files, ['b.txt', 'x.txt']);
      expect(d1.active, '20260101-000000-aaaaaa');
      expect(deleteTarget(c, '20260101-000000-aaaaaa'), 'default');
      final d2 = deleteChangelist(c, '20260101-000000-aaaaaa');
      expect(d2.active, 'default');
      expect(d2.byId('default')!.files, ['a.txt', 'b.txt']);
      expect(() => deleteChangelist(c, 'default'), throwsArgumentError);
    });
  });
}
