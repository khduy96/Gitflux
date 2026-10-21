import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/log_query.dart';
import 'package:git_tools/domain/usecases/compare_commits.dart';
import 'package:path/path.dart' as p;

/// Reflog, author / date / content filters and commit comparison on real
/// temporary repositories.
void main() {
  late Directory tmp;
  late String dir;
  late GitCliRepository repo;

  String git(List<String> args, {Map<String, String>? env}) {
    final r = Process.runSync(
        'git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.autocrlf=false', ...args],
        workingDirectory: dir, environment: env);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  void write(String file, String content) => File(p.join(dir, file)).writeAsStringSync(content);

  /// Commits [file] with [content] and returns the commit id. [date] sets
  /// both author and committer dates; [author] is `Name <email>`.
  String commit(String msg, {String? file, String? content, DateTime? date, String? author}) {
    write(file ?? '$msg.txt', content ?? '$msg\n');
    git(['add', '-A']);
    final d = date == null ? null : '@${date.millisecondsSinceEpoch ~/ 1000} +0000';
    git(['commit', '-qm', msg, if (author != null) '--author=$author'],
        env: d == null ? null : {'GIT_AUTHOR_DATE': d, 'GIT_COMMITTER_DATE': d});
    return git(['rev-parse', 'HEAD']);
  }

  Future<List<String>> subjects({int limit = 3000, LogQuery query = const LogQuery(), String? path}) async =>
      (await repo.log(limit: limit, query: query, path: path)).map((c) => c.subject).toList();

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_history_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    repo = GitCliRepository(dir);
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  group('reflog', () {
    test('shows a commit dropped by reset --hard and New Branch Here recovers it', () async {
      commit('one');
      final lost = commit('two: with colon', file: 'two.txt');
      git(['reset', '-q', '--hard', 'HEAD~1']);
      expect(await subjects(), ['one']);

      final reflog = await repo.reflog();
      expect(reflog.first.selector, 'HEAD@{0}');
      expect(reflog.first.action, 'reset');
      expect(reflog.first.message, 'moving to HEAD~1');
      final entry = reflog.firstWhere((e) => e.hash == lost);
      expect(entry.action, 'commit');
      expect(entry.message, 'two: with colon');
      expect(entry.index, 1);
      expect(entry.exists, isTrue);
      expect(DateTime.now().difference(entry.time).inMinutes, lessThan(5));

      // Show in Log of an unreachable commit still finds its details.
      final c = await repo.findCommit(entry.hash);
      expect(c?.subject, 'two: with colon');
      expect((await repo.commitDetails(c!)).files.single.path, 'two.txt');

      await repo.createBranch('recovered', startPoint: entry.hash, checkout: false);
      expect(git(['rev-parse', 'recovered']), lost);
      expect(await subjects(), ['two: with colon', 'one']);
    });

    test('reflog of the current branch', () async {
      commit('one');
      commit('two');
      git(['commit', '-q', '--amend', '-m', 'two amended']);
      final list = await repo.reflog(ref: 'refs/heads/main');
      expect(list.first.selector, 'main@{0}');
      expect(list.first.action, 'commit (amend)');
      expect(list.map((e) => e.action), ['commit (amend)', 'commit', 'commit (initial)']);
    });

    test('an entry whose commit is gone is listed as missing', () async {
      final one = commit('one');
      final two = commit('two');
      // A reflog line pointing to an object that does not exist.
      final ghost = 'f' * 40;
      File(p.join(dir, '.git', 'logs', 'HEAD')).writeAsStringSync(
          '$two $ghost Tester <tester@example.com> 1700000000 +0000\tcommit: ghost\n'
          '$ghost $two Tester <tester@example.com> 1700000100 +0000\tcheckout: moving from x to main\n',
          mode: FileMode.append);
      final list = await repo.reflog();
      expect(list.map((e) => e.index), [0, 1, 2, 3]);
      expect(list[1].exists, isFalse);
      expect(list[1].hash, ghost);
      expect(list[1].message, 'ghost');
      expect([list[0], list[2], list[3]].every((e) => e.exists), isTrue);
      expect(list[3].hash, one);
      expect(await repo.findCommit(ghost), isNull);
    });

    test('a repository without commits has an empty reflog', () async {
      expect(await repo.reflog(), isEmpty);
    });
  });

  group('author filter', () {
    test('finds a commit beyond the loaded limit, by name or email, ignoring case', () async {
      commit('by bob', author: 'Bob Builder <bob@build.io>');
      for (var i = 0; i < 4; i++) {
        commit('mine $i');
      }
      expect(await subjects(limit: 2), ['mine 3', 'mine 2']);
      expect(await subjects(limit: 2, query: const LogQuery(authors: ['bob builder'])), ['by bob']);
      expect(await subjects(limit: 2, query: const LogQuery(authors: ['BUILD.IO'])), ['by bob']);
      // Any pattern may match ("Me" passes the name and the email).
      expect(await subjects(query: const LogQuery(authors: ['nobody', 'tester@example.com'])),
          ['mine 3', 'mine 2', 'mine 1', 'mine 0']);
    });

    test('the value is matched literally', () async {
      commit('dots', author: 'J.R. Smith <jr@x.io>');
      commit('plain', author: 'JxR Smith <jxr@x.io>');
      expect(await subjects(query: const LogQuery(authors: ['J.R.'])), ['dots']);
      expect(await subjects(query: const LogQuery(authors: ['[x]'])), isEmpty);
    });
  });

  test('date filter with --since and --until', () async {
    commit('january', date: DateTime.utc(2024, 1, 10, 12));
    commit('march', date: DateTime.utc(2024, 3, 10, 12));
    commit('may', date: DateTime.utc(2024, 5, 10, 12));
    expect(await subjects(query: LogQuery(since: DateTime.utc(2024, 3, 1))), ['may', 'march']);
    expect(await subjects(query: LogQuery(until: DateTime.utc(2024, 3, 31))), ['march', 'january']);
    expect(await subjects(query: LogQuery(since: DateTime.utc(2024, 2, 1), until: DateTime.utc(2024, 4, 1))), ['march']);
    // Combined with the author filter.
    expect(await subjects(query: LogQuery(since: DateTime.utc(2024, 2, 1), authors: const ['nobody'])), isEmpty);
  });

  test('content search with -S and -G, combined with the path filter', () async {
    commit('add', file: 'a.txt', content: 'alpha\nneedle = 1\n');
    commit('other', file: 'b.txt', content: 'needle = 2\n');
    commit('touch', file: 'a.txt', content: 'alpha\nneedle = 1\nbeta\n');
    commit('remove', file: 'a.txt', content: 'beta\n');
    // -S: the number of occurrences changed (not "touch").
    expect(await subjects(query: const LogQuery(changes: 'needle = 1')), ['remove', 'add']);
    expect(await subjects(query: const LogQuery(changes: 'NEEDLE')), ['remove', 'other', 'add']);
    // -G: an added or removed line matches the regex.
    expect(await subjects(query: const LogQuery(changes: r'needle = [0-9]', changesRegex: true)), ['remove', 'other', 'add']);
    expect(await subjects(query: const LogQuery(changes: '^beta', changesRegex: true)), ['touch']);
    expect(await subjects(path: 'a.txt', query: const LogQuery(changes: 'needle')), ['remove', 'add']);
  });

  test('compare two non-ancestor commits lists the files with renames', () async {
    final lines = List.generate(30, (i) => 'line $i').join('\n');
    commit('base', file: 'a.txt', content: '$lines\n', date: DateTime.utc(2024, 1, 1));
    git(['checkout', '-q', '-b', 'one']);
    commit('add c', file: 'c.txt', content: 'c\n', date: DateTime.utc(2024, 1, 2));
    final one = (await repo.log(revisions: ['one'])).first;
    git(['checkout', '-q', 'main']);
    git(['checkout', '-q', '-b', 'two']);
    git(['mv', 'a.txt', 'b.txt']);
    commit('rename a', file: 'b.txt', content: '$lines\nextra\n', date: DateTime.utc(2024, 1, 3));
    final two = (await repo.log(revisions: ['two'])).first;
    expect(await repo.isAncestor(one.hash, two.hash), isFalse);

    final compare = CompareCommits(repo);
    // The older commit goes left whatever the selection order.
    final cmp = await compare(two, one);
    expect(cmp.left.hash, one.hash);
    expect(cmp.right.hash, two.hash);
    expect(cmp.files.map((f) => (f.type, f.oldPath, f.path)), [
      (ChangeType.renamed, 'a.txt', 'b.txt'),
      (ChangeType.deleted, null, 'c.txt'),
    ]);
    final req = cmp.diffRequest(cmp.files.first);
    expect((req.leftPath, req.rightPath), ('a.txt', 'b.txt'));
    expect((req.left as CommitRev).hash, one.hash);
    expect(cmp.diffRequest(cmp.files[1]).right, isA<EmptyRev>());

    final swapped = await compare(two, one, swapped: true);
    expect(swapped.left.hash, two.hash);
    expect(swapped.files.map((f) => (f.type, f.oldPath, f.path)), [
      (ChangeType.renamed, 'b.txt', 'a.txt'),
      (ChangeType.added, null, 'c.txt'),
    ]);
  });
}
