import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/bisect.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/logic/bisect_parser.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/usecases/bisect.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/commit/bisect_banner.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

const _c1 = 'd87fabdfedbc587d7aa6ba32aa144ba4530b3f64';
const _c2 = '681d586f7919f51a225ac34e7ea3aeddb28cf590';
const _c3 = '42c72b5bcd279dac5e5b55e9523553fe499086ec';
const _c5 = '3dbdf8541374bd8d5578728c2a65b0cb2e498623';
const _c6 = '06b68d7f203e64c685dd1c8b8aa535c59754ae3e';
const _c8 = '0742142df405c70c877631246e6b4d79ca55fca2';
const _c10 = 'c942994f06cf7d8d4c8c0b0ea5824b78c18c7f65';

void main() {
  group('parseBisectLog', () {
    test('reads the marks and the first bad commit', () {
      final log = parseBisectLog('git bisect start\n'
          '# status: waiting for both good and bad commits\n'
          '# bad: [$_c10] c10\n'
          'git bisect bad $_c10\n'
          '# status: waiting for good commit(s), bad commit known\n'
          '# good: [$_c1] c1\n'
          'git bisect good $_c1\n'
          '# skip: [$_c5] c5\n'
          '# skip: [$_c8] c8\n'
          'git bisect skip $_c5 $_c8\n'
          '# good: [$_c3] c3\n'
          'git bisect good $_c3\r\n'
          '# bad: [$_c6] c6\n'
          'git bisect bad $_c6\n'
          '# first bad commit: [$_c6] c6: fix [login] form\n');
      expect(log.bad, [_c10, _c6]);
      expect(log.good, [_c1, _c3]);
      expect(log.skipped, [_c5, _c8]);
      expect(log.firstBad, _c6);
      expect(log.firstBadSubject, 'c6: fix [login] form');
      expect(log.candidates, isEmpty);
    });

    test('old / new terms', () {
      final log = parseBisectLog('git bisect start --term-old=old --term-new=new\n'
          '# new: [$_c10] c10\n'
          'git bisect new $_c10\n'
          '# old: [$_c1] c1\n'
          'git bisect old $_c1\n'
          '# first new commit: [$_c2] c2\n');
      expect(log.bad, [_c10]);
      expect(log.good, [_c1]);
      expect(log.firstBad, _c2);
      expect(log.firstBadSubject, 'c2');
    });

    test('only skipped commits left: candidates, no first bad commit', () {
      final log = parseBisectLog('git bisect start\n'
          '# bad: [$_c3] c3\n'
          'git bisect bad $_c3\n'
          '# good: [$_c1] c1\n'
          'git bisect good $_c1\n'
          '# skip: [$_c2] c2\n'
          'git bisect skip $_c2\n'
          '# only skipped commits left to test\n'
          '# possible first bad commit: [$_c3] c3\n'
          '# possible first bad commit: [$_c2] c2\n');
      expect(log.firstBad, isNull);
      expect(log.skipped, [_c2]);
      expect(log.candidates, [_c3, _c2]);
    });

    test('empty log', () {
      final log = parseBisectLog('');
      expect(log.good, isEmpty);
      expect(log.bad, isEmpty);
      expect(log.firstBad, isNull);
    });
  });

  test('parseBisectRefs maps refs/bisect/* to marks', () {
    expect(
      parseBisectRefs('$_c10 refs/bisect/bad\n'
          '$_c1 refs/bisect/good-$_c1\n'
          '$_c3 refs/bisect/good-$_c3\n'
          '$_c5 refs/bisect/skip-$_c5\n'
          '$_c8 refs/heads/main\n'
          '$_c6 refs/bisect/other\n'
          '\n'
          'garbage\n'),
      {_c10: BisectMark.bad, _c1: BisectMark.good, _c3: BisectMark.good, _c5: BisectMark.skip},
    );
    expect(parseBisectRefs(''), isEmpty);
  });

  test('parseBisectVars reads bisect_nr and bisect_steps', () {
    var v = parseBisectVars("bisect_rev='$_c5'\nbisect_nr=4\nbisect_good=4\nbisect_bad=3\nbisect_all=9\nbisect_steps=2\n");
    expect((v.left, v.steps), (4, 2));
    v = parseBisectVars("bisect_rev='$_c5'\r\nbisect_nr='1'\r\nbisect_steps='0'\r\n");
    expect((v.left, v.steps), (1, 0));
    v = parseBisectVars('');
    expect((v.left, v.steps), (null, null));
  });

  test('firstBadCommitIn', () {
    expect(
      firstBadCommitIn('$_c8 is the first bad commit\ncommit $_c8\nAuthor: T <t@t>\n\n    c8\n'),
      _c8,
    );
    expect(firstBadCommitIn('running sh -c test\n$_c6 is the first new commit\n'), _c6);
    expect(firstBadCommitIn('Bisecting: 4 revisions left to test after this (roughly 2 steps)\n[$_c5] c5'), isNull);
    expect(firstBadCommitIn('Commit $_c8 is the first bad commit'), isNull);
  });

  group('on a repository', () {
    late Directory tmp;
    late String dir;
    late GitCliRepository repo;
    late BisectCommits bisect;

    /// Commits c1..c10; `v.txt` is "broken" from c6 on (the first bad commit).
    late List<String> commits;

    String git(List<String> args) {
      final r = Process.runSync('git', args, workingDirectory: dir);
      if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
      return (r.stdout as String).trim();
    }

    File file(String name) => File(p.join(dir, name));
    String head() => git(['rev-parse', 'HEAD']);
    String branch() => git(['branch', '--show-current']);

    /// What a test of the checked-out commit says.
    BisectMark verdict() => file('v.txt').readAsStringSync().trim() == 'ok' ? BisectMark.good : BisectMark.bad;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('gt_bisect_');
      dir = p.join(tmp.path, 'repo');
      Directory(dir).createSync();
      git(['init', '-q', '-b', 'main']);
      for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
        git(['config', kv.key, kv.value]);
      }
      commits = [
        for (var i = 1; i <= 10; i++) () {
          file('n.txt').writeAsStringSync('$i\n');
          file('v.txt').writeAsStringSync(i >= 6 ? 'broken\n' : 'ok\n');
          git(['add', '-A']);
          git(['commit', '-qm', 'c$i']);
          return head();
        }(),
      ];
      repo = GitCliRepository(dir);
      bisect = BisectCommits(repo);
    });

    tearDown(() async {
      for (var i = 0;; i++) {
        try {
          tmp.deleteSync(recursive: true);
          return;
        } on FileSystemException {
          if (i == 20) rethrow;
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
      }
    });

    test('no session', () async {
      expect(await repo.bisectState(), isNull);
      await expectLater(bisect.mark(BisectMark.good), throwsA(isA<BisectRejected>()));
      await expectLater(bisect.mark(BisectMark.skip, rev: commits[3]), throwsA(isA<BisectRejected>()));
      await bisect.reset(); // nothing to reset
      expect(await repo.bisectState(), isNull);
    });

    test('mark bad / good, follow the steps to the first bad commit, reset', () async {
      final tip = commits.last;
      var step = await bisect.mark(BisectMark.bad, rev: tip);
      expect(step.firstBad, isNull);
      var state = (await repo.bisectState())!;
      expect(state.startRef, 'main');
      expect(state.hasBad, isTrue);
      expect(state.hasGood, isFalse);
      expect(state.revisionsLeft, isNull);
      expect(state.marks, {tip: BisectMark.bad});
      expect(branch(), 'main');

      step = await bisect.mark(BisectMark.good, rev: commits.first);
      final printed = RegExp(r'Bisecting: (\d+) revisions? left to test after this \(roughly (\d+) steps?\)')
          .firstMatch(step.output)!;
      state = (await repo.bisectState())!;
      expect(branch(), isEmpty, reason: 'HEAD is detached');
      expect(commits.sublist(1, 9), contains(head()));
      expect(state.revisionsLeft, int.parse(printed.group(1)!));
      expect(state.steps, int.parse(printed.group(2)!));
      expect(state.marks, {tip: BisectMark.bad, commits.first: BisectMark.good});
      expect(state.log.bad, [tip]);
      expect(state.log.good, [commits.first]);
      expect(state.currentHash, head());
      expect(state.currentShort, head().substring(0, 8));
      expect(state.currentSubject, 'c${commits.indexOf(head()) + 1}');
      expect(state.finished, isFalse);

      for (var i = 0; i < 10 && step.firstBad == null; i++) {
        step = await bisect.mark(verdict());
      }
      expect(step.firstBad, commits[5]);
      state = (await repo.bisectState())!;
      expect(state.finished, isTrue);
      expect(state.firstBad, commits[5]);
      expect(state.log.firstBadSubject, 'c6');
      expect(state.revisionsLeft, isNull);

      await bisect.reset();
      expect(await repo.bisectState(), isNull);
      expect(branch(), 'main');
      expect(head(), tip);
    });

    test('skip', () async {
      await bisect.mark(BisectMark.bad, rev: commits.last);
      await bisect.mark(BisectMark.good, rev: commits.first);
      final skipped = head();
      final step = await bisect.mark(BisectMark.skip);
      expect(step.firstBad, isNull);
      final state = (await repo.bisectState())!;
      expect(state.marks[skipped], BisectMark.skip);
      expect(state.log.skipped, [skipped]);
      expect(head(), isNot(skipped));
      expect(state.currentHash, head());
    });

    test('only skipped commits left: candidates', () async {
      // Through git: the step exits with 2 (see the skipped test below).
      git(['bisect', 'start', commits[2], commits[0]]);
      expect(head(), commits[1]);
      Process.runSync('git', ['bisect', 'skip'], workingDirectory: dir);
      final state = (await repo.bisectState())!;
      expect(state.finished, isFalse);
      expect(state.log.candidates, unorderedEquals([commits[1], commits[2]]));
    });

    test('marking the last commit to test as skipped reports the candidates', () async {
      await bisect.mark(BisectMark.bad, rev: commits[2]);
      await bisect.mark(BisectMark.good, rev: commits[0]);
      final step = await bisect.mark(BisectMark.skip);
      expect(step.firstBad, isNull);
      expect((await repo.bisectState())!.log.candidates, isNotEmpty);
    });

    test('run: git tests the commits with the script', () async {
      file('check.sh').writeAsStringSync('#!/bin/sh\ngrep -qx ok v.txt\n'); // untracked
      await bisect.mark(BisectMark.bad, rev: commits.last);
      await bisect.mark(BisectMark.good, rev: commits.first);
      final step = await bisect.run('./check.sh');
      expect(step.firstBad, commits[5]);
      expect((await repo.bisectState())!.firstBad, commits[5]);
      await expectLater(bisect.run('  '), throwsA(isA<BisectRejected>()));
    });

    test('run: a command with arguments', () async {
      await bisect.mark(BisectMark.bad, rev: commits.last);
      await bisect.mark(BisectMark.good, rev: commits.first);
      final step = await bisect.run('grep -qx ok v.txt');
      expect(step.firstBad, commits[5]);
    });

    test('local changes that block the checkout: BisectRejected', () async {
      await bisect.mark(BisectMark.bad, rev: commits.last);
      file('v.txt').writeAsStringSync('local\n');
      await expectLater(
        bisect.mark(BisectMark.good, rev: commits.first),
        throwsA(isA<BisectRejected>().having((e) => e.title, 'title', contains('Local changes'))),
      );
      expect(branch(), 'main');
      expect(file('v.txt').readAsStringSync(), 'local\n');
      // Git recorded the mark but could not check out the commit to test.
      expect((await repo.bisectState())!.checkoutPending, isTrue);
    });
  });

  group('BisectBanner', () {
    late Directory tmp;
    late String dir;
    late List<String> commits;

    String git(List<String> args) {
      final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], workingDirectory: dir);
      if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
      return (r.stdout as String).trim();
    }

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('gt_bisect_ui_');
      dir = p.join(tmp.path, 'repo');
      Directory(dir).createSync();
      git(['init', '-q', '-b', 'main']);
      git(['config', 'core.autocrlf', 'false']);
      commits = [
        for (var i = 1; i <= 10; i++) () {
          File(p.join(dir, 'v.txt')).writeAsStringSync('$i\n');
          git(['add', '-A']);
          git(['commit', '-qm', 'c$i']);
          return git(['rev-parse', 'HEAD']);
        }(),
      ];
    });

    // The refresh after an operation may still run git in the folder.
    tearDown(() async {
      for (var i = 0;; i++) {
        try {
          tmp.deleteSync(recursive: true);
          return;
        } on FileSystemException {
          if (i == 20) rethrow;
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
      }
    });

    /// Waits for the operation started by the UI and the refresh after it.
    Future<void> idle(WidgetTester tester, RepoController ctrl, bool Function() done) async {
      for (var i = 0; i < 300 && (ctrl.busy.value != null || !done()); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump(const Duration(milliseconds: 10));
      }
    }

    Future<RepoController> open(WidgetTester tester) async {
      tester.view.physicalSize = const Size(600, 400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final ctrl = RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi);
      await tester.runAsync(ctrl.refreshAll);
      addTearDown(ctrl.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(),
        home: Scaffold(body: Column(children: [BisectBanner(controller: ctrl)])),
      ));
      return ctrl;
    }

    testWidgets('nothing without a session', (tester) async {
      await open(tester);
      expect(find.byType(OutlinedButton), findsNothing);
      expect(find.textContaining('Bisecting'), findsNothing);
    });

    testWidgets('waiting for a good commit', (tester) async {
      git(['bisect', 'start']);
      git(['bisect', 'bad']);
      await open(tester);
      expect(find.text('Bisecting: mark a good commit'), findsOneWidget);
      expect(find.text('Use Bisect in the Log context menu'), findsOneWidget);
      expect(find.text('Reset'), findsOneWidget);
      expect(find.text('Good'), findsNothing);
    });

    testWidgets('Good marks the current commit, Reset ends the session', (tester) async {
      git(['bisect', 'start', commits.last, commits.first]);
      final ctrl = await open(tester);
      final first = ctrl.bisect.value!.currentHash!;
      expect(find.text('Bisecting: ~4 revisions left (~2 steps)'), findsOneWidget);
      expect(find.text('${first.substring(0, 8)} c5'), findsOneWidget);
      for (final label in ['Good', 'Bad', 'Skip', 'Run Script…', 'Reset']) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      expect(find.byTooltip('Reset (back to main)'), findsOneWidget);

      await tester.tap(find.text('Good'));
      await tester.pump();
      await idle(tester, ctrl, () => ctrl.bisect.value?.currentHash != first);
      final state = ctrl.bisect.value!;
      expect(state.marks[first], BisectMark.good);
      expect(find.text('${state.currentShort} ${state.currentSubject}'), findsOneWidget);
      expect(find.textContaining('left'), findsOneWidget);

      await tester.tap(find.text('Reset'));
      await tester.pump();
      await idle(tester, ctrl, () => ctrl.bisect.value == null);
      expect(ctrl.bisect.value, isNull);
      expect(find.text('Reset'), findsNothing);
      expect(git(['branch', '--show-current']), 'main');
    });

    testWidgets('first bad commit found: Show in Log and Reset', (tester) async {
      git(['bisect', 'start', commits[6], commits[5]]);
      final ctrl = await open(tester);
      expect(ctrl.bisect.value!.finished, isTrue);
      expect(find.text('${commits[6].substring(0, 8)} is the first bad commit'), findsOneWidget);
      expect(find.text('c7'), findsOneWidget);
      expect(find.text('Show in Log'), findsOneWidget);
      expect(find.text('Reset'), findsOneWidget);
      expect(find.text('Good'), findsNothing);
    });
  });
}
