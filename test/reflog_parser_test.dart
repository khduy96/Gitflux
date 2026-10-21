import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/logic/reflog_parser.dart';

const _us = '\x1f';

/// Records of `git reflog show -z --format=%gd%x1f%H%x1f%gs`.
String _entries(List<(String, String, String)> e) => e.map((x) => '${x.$1}$_us${x.$2}$_us${x.$3}').join('\x00');

/// Records of `git reflog show -z --date=unix --format=%gd`.
String _times(List<int> secs) => secs.map((s) => 'HEAD@{$s}').join('\x00');

final _a = 'a' * 40, _b = 'b' * 40, _c = 'c' * 40;

void main() {
  group('reflog subject', () {
    test('splits the operation from the message at the first ": "', () {
      expect(splitReflogSubject('commit (amend): Fix: typo'), (action: 'commit (amend)', message: 'Fix: typo'));
      expect(splitReflogSubject('rebase (finish): returning to refs/heads/main'),
          (action: 'rebase (finish)', message: 'returning to refs/heads/main'));
      expect(splitReflogSubject('reset: moving to HEAD~1'), (action: 'reset', message: 'moving to HEAD~1'));
      expect(splitReflogSubject('commit (initial): first: colon'), (action: 'commit (initial)', message: 'first: colon'));
    });

    test('a subject without ": " is all operation', () {
      expect(splitReflogSubject('custom update'), (action: 'custom update', message: ''));
      expect(splitReflogSubject('pull:'), (action: 'pull', message: ''));
      expect(splitReflogSubject(': odd'), (action: ': odd', message: ''));
    });

    test('the operation never spans lines', () {
      expect(splitReflogSubject('weird\naction: x'), (action: 'weird action: x', message: ''));
      expect(splitReflogSubject('commit: line one\nline: two'), (action: 'commit', message: 'line one\nline: two'));
    });

    test('selector index', () {
      expect(reflogIndex('HEAD@{12}'), 12);
      expect(reflogIndex('feature/x@{0}'), 0);
      expect(reflogIndex('HEAD@{1700000000}'), 1700000000);
      expect(reflogIndex('HEAD'), isNull);
    });
  });

  group('parseReflog', () {
    test('reads selector, commit, operation, message and time', () {
      final list = parseReflog(
        '${_entries([
          ('HEAD@{0}', _a, 'checkout: moving from main to x'),
          ('HEAD@{1}', _b, 'commit: Add $_us separator: and more'),
          ('HEAD@{2}', _c, 'commit (initial): init'),
        ])}\x00',
        _times([300, 200, 100]),
      );
      expect(list.map((e) => e.selector), ['HEAD@{0}', 'HEAD@{1}', 'HEAD@{2}']);
      expect(list.map((e) => e.index), [0, 1, 2]);
      expect(list[0].action, 'checkout');
      expect(list[0].message, 'moving from main to x');
      expect(list[1].hash, _b);
      expect(list[1].message, 'Add $_us separator: and more');
      expect(list[2].action, 'commit (initial)');
      expect(list[2].time, DateTime.fromMillisecondsSinceEpoch(100 * 1000));
      expect(list.every((e) => e.exists), isTrue);
      expect(list[1].shortHash, 'bbbbbbbb');
    });

    test('keeps a newline inside the message and skips broken records', () {
      final list = parseReflog(
        [_entries([('HEAD@{0}', _a, 'commit: one\ntwo')]), 'garbage', '\n'].join('\x00'),
        _times([5]),
      );
      expect(list.single.message, 'one\ntwo');
    });

    test('missing times fall back to the epoch', () {
      final list = parseReflog(_entries([('HEAD@{0}', _a, 'reset: moving to x')]), '');
      expect(list.single.time.millisecondsSinceEpoch, 0);
    });
  });

  group('missing entries', () {
    const raw = '0000000000000000000000000000000000000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa A U <a@x> 100 +0700\tcommit (initial): init\n'
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa dddddddddddddddddddddddddddddddddddddddd A U <a@x> 200 +0700\tcommit: gone\n'
        'dddddddddddddddddddddddddddddddddddddddd aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa A U <a@x> 300 -0100\treset: moving to HEAD~1\r\n';

    test('raw reflog lines by index, newest = 0', () {
      final m = parseRawReflog(raw, 'HEAD');
      expect(m.keys.toSet(), {0, 1, 2});
      expect(m[1]!.hash, 'd' * 40);
      expect(m[1]!.action, 'commit');
      expect(m[1]!.message, 'gone');
      expect(m[0]!.time, DateTime.fromMillisecondsSinceEpoch(300 * 1000));
      expect(m[2]!.selector, 'HEAD@{2}');
    });

    test('entries git skipped come back dimmed', () {
      final shown = parseReflog(
        _entries([('main@{0}', _a, 'reset: moving to HEAD~1'), ('main@{2}', _a, 'commit (initial): init')]),
        _times([300, 100]),
      );
      final list = addMissingReflogEntries(shown, parseRawReflog(raw, 'refs/heads/main'));
      expect(list.map((e) => e.index), [0, 1, 2]);
      expect(list[1].exists, isFalse);
      expect(list[1].selector, 'main@{1}');
      expect(list[1].subject, 'commit: gone');
      expect(list[0].exists && list[2].exists, isTrue);
    });
  });
}
