import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/rebase.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/logic/rebase_todo.dart';

RebaseCommitEntry _c(String id, [RebaseAction action = RebaseAction.pick, String? newMessage]) => RebaseCommitEntry(
      commit: Commit(
        hash: id.padRight(40, '0'),
        parents: const [],
        authorName: 'T',
        authorEmail: 't@t',
        authorTime: DateTime(2024),
        committerName: 'T',
        commitTime: DateTime(2024),
        subject: 'subject $id',
        refs: const [],
      ),
      message: 'subject $id\n\nbody $id',
      action: action,
      newMessage: newMessage,
    );

String _h(String id) => id.padRight(40, '0');

const _dir = 'D:/repo/.git/git-tools-rebase';

void main() {
  group('parseTodo', () {
    test('commit lines, structural lines, comments and blank lines', () {
      const todo = '''
label onto

# Branch side
reset onto
pick 0a4fb30 m1
p 5d1846e s1 with  spaces
label side
reset branch-point # m1
merge -C 890baa2 side # Merge side
update-ref refs/heads/side
fixup -C ecc84e9 amend! m1
f abc1234 fix
d 1234abc gone
exec make test

# Rebase 4177a54..ecc84e9 onto 4177a54 (10 commands)
#
# Commands:
# p, pick <commit> = use commit
''';
      final lines = parseTodo(todo);
      String show(TodoLine l) => switch (l) {
            TodoCommitLine(:final action, :final hash) => '${action.name} $hash',
            TodoOtherLine(:final line) => '= $line',
          };
      expect(lines.map(show), [
        '= label onto',
        '= reset onto',
        'pick 0a4fb30',
        'pick 5d1846e',
        '= label side',
        '= reset branch-point # m1',
        '= merge -C 890baa2 side # Merge side',
        '= update-ref refs/heads/side',
        'squash ecc84e9',
        'fixup abc1234',
        'drop 1234abc',
        '= exec make test',
      ]);
    });

    test('respects core.commentChar', () {
      const todo = '; Rebase a..b\npick 0a4fb30 m1\n;pick 1111111 commented\n';
      final lines = parseTodo(todo, comment: ';');
      expect(lines, hasLength(1));
      expect((lines.single as TodoCommitLine).hash, '0a4fb30');
      expect(todoCommentPrefix(null, ';'), ';');
      expect(todoCommentPrefix('//', ';'), '//');
      expect(todoCommentPrefix(null, 'auto'), '#');
      expect(todoCommentPrefix(null, null), '#');
    });
  });

  group('buildTodo', () {
    test('pick, edit and drop keep their verb', () {
      final t = buildTodo([_c('a'), _c('b', RebaseAction.edit), _c('c', RebaseAction.drop)], stateDir: _dir);
      expect(t.todo, 'pick ${_h('a')} subject a\nedit ${_h('b')} subject b\ndrop ${_h('c')} subject c\n');
      expect(t.messages, isEmpty);
    });

    test('reword becomes pick + amend with a message file', () {
      final t = buildTodo([_c('a', RebaseAction.reword, 'New\n\nbody'), _c('b')], stateDir: _dir);
      expect(t.todo.split('\n'), [
        'pick ${_h('a')} subject a',
        "exec git commit --amend --allow-empty -F '$_dir/msg-1.txt'",
        'pick ${_h('b')} subject b',
        '',
      ]);
      expect(t.messages, {'msg-1.txt': 'New\n\nbody\n'});
    });

    test('squash group: pick + fixups + one amend with the joined messages', () {
      final t = buildTodo([
        _c('a'),
        _c('b', RebaseAction.squash),
        _c('c', RebaseAction.fixup),
        _c('d', RebaseAction.squash),
        _c('e'),
      ], stateDir: _dir);
      expect(t.todo.split('\n'), [
        'pick ${_h('a')} subject a',
        'fixup ${_h('b')} subject b',
        'fixup ${_h('c')} subject c',
        'fixup ${_h('d')} subject d',
        "exec git commit --amend --allow-empty -F '$_dir/msg-1.txt'",
        'pick ${_h('e')} subject e',
        '',
      ]);
      expect(t.messages['msg-1.txt'], 'subject a\n\nbody a\n\nsubject b\n\nbody b\n\nsubject d\n\nbody d\n');
    });

    test('the group message chosen by the user wins', () {
      final t = buildTodo([_c('a', RebaseAction.pick, 'Combined'), _c('b', RebaseAction.squash)], stateDir: _dir);
      expect(t.messages, {'msg-1.txt': 'Combined\n'});
    });

    test('a group made only of fixups keeps the first message', () {
      final t = buildTodo([_c('a'), _c('b', RebaseAction.fixup), _c('c', RebaseAction.fixup)], stateDir: _dir);
      expect(t.todo, 'pick ${_h('a')} subject a\nfixup ${_h('b')} subject b\nfixup ${_h('c')} subject c\n');
      expect(t.messages, isEmpty);
    });

    test('reworded lead with fixups amends after the last fixup', () {
      final t = buildTodo([_c('a', RebaseAction.reword, 'R'), _c('b', RebaseAction.fixup)], stateDir: _dir);
      expect(t.todo.split('\n')[2], "exec git commit --amend --allow-empty -F '$_dir/msg-1.txt'");
      expect(t.messages, {'msg-1.txt': 'R\n'});
    });

    test('an edit group head stays edit and keeps its message with fixups', () {
      final t = buildTodo([_c('a', RebaseAction.edit), _c('b', RebaseAction.fixup)], stateDir: _dir);
      expect(t.todo, 'edit ${_h('a')} subject a\nfixup ${_h('b')} subject b\n');
      expect(t.messages, isEmpty);
    });

    test('dropped commits inside a group are skipped', () {
      final entries = [_c('a'), _c('b', RebaseAction.drop), _c('c', RebaseAction.squash)];
      expect(groupLead(entries, 2), 0);
      final t = buildTodo(entries, stateDir: _dir);
      expect(t.todo.split('\n').sublist(0, 4), [
        'pick ${_h('a')} subject a',
        'drop ${_h('b')} subject b',
        'fixup ${_h('c')} subject c',
        "exec git commit --amend --allow-empty -F '$_dir/msg-1.txt'",
      ]);
      expect(t.messages['msg-1.txt'], 'subject a\n\nbody a\n\nsubject c\n\nbody c\n');
    });

    test('structural lines are kept and split the runs', () {
      final entries = <RebaseEntry>[
        const RebaseStructuralEntry('label onto'),
        _c('a'),
        _c('b', RebaseAction.reword, 'B2'),
        const RebaseStructuralEntry('label side'),
        const RebaseStructuralEntry('reset onto'),
        _c('c'),
        const RebaseStructuralEntry('merge -C 1234567 side # Merge'),
      ];
      final t = buildTodo(entries, stateDir: _dir);
      expect(t.todo.split('\n'), [
        'label onto',
        'pick ${_h('a')} subject a',
        'pick ${_h('b')} subject b',
        "exec git commit --amend --allow-empty -F '$_dir/msg-1.txt'",
        'label side',
        'reset onto',
        'pick ${_h('c')} subject c',
        'merge -C 1234567 side # Merge',
        '',
      ]);
      expect(commitRun(entries, 2), (1, 3));
      expect(moveEntry(entries, 2, 1), isNull);
      expect(moveEntry(entries, 2, -1)!.whereType<RebaseCommitEntry>().map((e) => e.subject),
          ['subject b', 'subject a', 'subject c']);
    });

    test('quotes the state directory for sh', () {
      final t = buildTodo([_c('a', RebaseAction.reword, 'x')], stateDir: "C:/it's/dir");
      expect(t.todo, contains(r"-F 'C:/it'\''s/dir/msg-1.txt'"));
    });
  });

  group('validateTodo', () {
    test('a meld needs a previous commit in its run', () {
      expect(validateTodo([_c('a', RebaseAction.squash), _c('b')]).single.index, 0);
      expect(validateTodo([_c('a', RebaseAction.drop), _c('b', RebaseAction.fixup)]).single.index, 1);
      final entries = [_c('a'), const RebaseStructuralEntry('label x'), _c('b', RebaseAction.fixup)];
      expect(validateTodo(entries).single.index, 2);
      expect(() => buildTodo(entries, stateDir: _dir), throwsA(isA<RebaseRejected>()));
    });

    test('empty messages are rejected', () {
      expect(validateTodo([_c('a', RebaseAction.reword, '  \n')]).single.isError, isTrue);
      expect(validateTodo([_c('a', RebaseAction.pick, ''), _c('b', RebaseAction.squash)]).single.index, 0);
      expect(validateTodo([_c('a', RebaseAction.pick, ''), _c('b', RebaseAction.fixup)]), isEmpty);
    });

    test('dropping everything is only a warning', () {
      final issues = validateTodo([_c('a', RebaseAction.drop), _c('b', RebaseAction.drop)]);
      expect(issues.single.isError, isFalse);
      expect(buildTodo([_c('a', RebaseAction.drop)], stateDir: _dir).todo, 'drop ${_h('a')} subject a\n');
    });
  });

  group('menu edits', () {
    final entries = <RebaseEntry>[_c('a'), _c('b'), _c('c'), const RebaseStructuralEntry('label x'), _c('d')];

    test('squash consecutive commits into the oldest', () {
      final r = squashCommits(entries, [_h('c'), _h('b')], 'BC');
      final cs = r.whereType<RebaseCommitEntry>().toList();
      expect(cs.map((e) => e.action), [RebaseAction.pick, RebaseAction.pick, RebaseAction.squash, RebaseAction.pick]);
      expect(cs[1].newMessage, 'BC');
      expect(() => squashCommits(entries, [_h('a'), _h('c')], 'x'), throwsA(isA<RebaseRejected>()));
      expect(() => squashCommits(entries, [_h('c'), _h('d')], 'x'), throwsA(isA<RebaseRejected>()));
    });

    test('fixup, move, reword and drop', () {
      expect((fixupCommit(entries, _h('b'))[1] as RebaseCommitEntry).action, RebaseAction.fixup);
      expect(() => fixupCommit(entries, _h('a')), throwsA(isA<RebaseRejected>()));
      expect(() => fixupCommit(entries, _h('d')), throwsA(isA<RebaseRejected>()));
      expect((moveCommit(entries, _h('a'), 1)[0] as RebaseCommitEntry).subject, 'subject b');
      expect(() => moveCommit(entries, _h('c'), 1), throwsA(isA<RebaseRejected>()));
      final rw = rewordCommit(entries, _h('b'), 'new')[1] as RebaseCommitEntry;
      expect((rw.action, rw.newMessage), (RebaseAction.reword, 'new'));
      expect(dropCommits(entries, [_h('a'), _h('d')]).whereType<RebaseCommitEntry>().map((e) => e.action.name),
          ['drop', 'pick', 'pick', 'drop']);
      expect(() => dropCommits(entries, [_h('z')]), throwsA(isA<RebaseRejected>()));
    });
  });
}
