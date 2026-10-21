import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/merge.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/usecases/merge_branch.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/dialogs/merge_dialog.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

/// Merge options (validation, git arguments) and `git merge` on real
/// temporary repositories.
void main() {
  group('MergeOptions', () {
    const none = MergeOptions();

    test('fast-forward only, no fast-forward and squash exclude each other', () {
      final all = [MergeFlag.ffOnly, MergeFlag.noFf, MergeFlag.squash];
      for (final from in all) {
        for (final to in all.where((f) => f != from)) {
          final o = none.withFlag(from, true).withFlag(to, true);
          expect(o.flag(to), isTrue, reason: '$from then $to');
          for (final other in all.where((f) => f != to)) {
            expect(o.flag(other), isFalse, reason: '$from then $to: $other');
          }
          expect(o.error, isNull);
        }
      }
    });

    test('squash forces no commit while it is on', () {
      final squash = none.withFlag(MergeFlag.squash, true);
      expect(squash.noCommit, isTrue);
      expect(squash.withFlag(MergeFlag.noCommit, false).noCommit, isTrue);
      expect(squash.withFlag(MergeFlag.squash, false).noCommit, isFalse);
      // Switching to another mode leaves "no commit" off as well.
      expect(squash.withFlag(MergeFlag.noFf, true).noCommit, isFalse);
      expect(squash.withFlag(MergeFlag.ffOnly, true).noCommit, isFalse);
    });

    test('no commit is independent of the fast-forward modes', () {
      final o = none.withFlag(MergeFlag.noCommit, true).withFlag(MergeFlag.noFf, true);
      expect((o.noFf, o.noCommit), (true, true));
      expect(o.withFlag(MergeFlag.noFf, false).noCommit, isTrue);
      expect(o.withFlag(MergeFlag.noCommit, false).noCommit, isFalse);
    });

    test('message is kept by withFlag', () {
      final o = none.withMessage('msg').withFlag(MergeFlag.noFf, true).withFlag(MergeFlag.squash, true);
      expect(o.message, 'msg');
    });

    test('error for contradicting options', () {
      expect(none.error, isNull);
      expect(const MergeOptions(ffOnly: true, noFf: true).error, isNotNull);
      expect(const MergeOptions(ffOnly: true, squash: true, noCommit: true).error, isNotNull);
      expect(const MergeOptions(noFf: true, squash: true, noCommit: true).error, isNotNull);
      expect(const MergeOptions(squash: true).error, isNotNull);
      expect(const MergeOptions(squash: true, noCommit: true).error, isNull);
      expect(const MergeOptions(noFf: true, noCommit: true).error, isNull);
    });

    test('args', () {
      expect(none.args, isEmpty);
      expect(const MergeOptions(ffOnly: true).args, ['--ff-only']);
      expect(const MergeOptions(noFf: true, noCommit: true).args, ['--no-ff', '--no-commit']);
      expect(const MergeOptions(noCommit: true).args, ['--no-ff', '--no-commit']);
      expect(const MergeOptions(squash: true, noCommit: true).args, ['--squash']);
      expect(const MergeOptions(noFf: true, message: '  Merge it \n').args, ['--no-ff', '-m', 'Merge it']);
      expect(const MergeOptions(message: '   ').args, isEmpty);
    });

    test('createsMergeCommit', () {
      bool c(MergeOptions o, bool ff) => o.createsMergeCommit(fastForward: ff);
      expect(c(none, false), isTrue);
      expect(c(none, true), isFalse);
      expect(c(const MergeOptions(noFf: true), true), isTrue);
      expect(c(const MergeOptions(noFf: true), false), isTrue);
      expect(c(const MergeOptions(ffOnly: true), true), isFalse);
      expect(c(const MergeOptions(ffOnly: true), false), isFalse);
      expect(c(const MergeOptions(squash: true, noCommit: true), false), isFalse);
      expect(c(const MergeOptions(noCommit: true), false), isFalse);
      expect(c(const MergeOptions(noFf: true, noCommit: true), true), isFalse);
      expect(const MergeOptions(squash: true, noCommit: true).leavesChangesToCommit, isTrue);
      expect(none.leavesChangesToCommit, isFalse);
    });
  });

  group('git merge', () {
    late Directory tmp;
    late String dir;
    late MergeBranch merge;

    String git(List<String> args) {
      final r = Process.runSync('git', args, workingDirectory: dir);
      if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
      return (r.stdout as String).trim();
    }

    void write(String name, String content) => File(p.join(dir, name)).writeAsStringSync(content);

    String commit(String file, String msg) {
      write(file, '$msg\n');
      git(['add', '-A']);
      git(['commit', '-qm', msg]);
      return git(['rev-parse', 'HEAD']);
    }

    String head() => git(['rev-parse', 'HEAD']);
    int parents(String rev) => git(['rev-list', '--parents', '-n', '1', rev]).split(' ').length - 1;

    /// main: init; feature: init + f1 + f2 (fast-forwardable from main).
    void feature() {
      git(['checkout', '-q', '-b', 'feature']);
      commit('f1.txt', 'f1');
      commit('f2.txt', 'f2');
      git(['checkout', '-q', 'main']);
    }

    /// Same as [feature] plus a commit on main.
    void diverged() {
      feature();
      commit('m.txt', 'm1');
    }

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('gt_merge_');
      dir = p.join(tmp.path, 'repo');
      Directory(dir).createSync();
      git(['init', '-q', '-b', 'main']);
      for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
        git(['config', kv.key, kv.value]);
      }
      commit('a.txt', 'init');
      merge = MergeBranch(GitCliRepository(dir));
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

    test('fast-forward only refuses diverged branches', () async {
      diverged();
      final before = head();
      await expectLater(merge('feature', const MergeOptions(ffOnly: true)), throwsA(isA<GitException>()));
      expect(head(), before);
      expect(await GitCliRepository(dir).repoState(), RepoState.normal);
    });

    test('fast-forward only moves HEAD to the branch tip', () async {
      feature();
      final out = await merge('feature', const MergeOptions(ffOnly: true));
      expect(out.stopped, isFalse);
      expect(head(), git(['rev-parse', 'feature']));
      expect(parents('HEAD'), 1);
    });

    test('no fast-forward creates a merge commit with the given message', () async {
      feature();
      final before = head();
      await merge('feature', const MergeOptions(noFf: true, message: ' Merge the feature \n'));
      expect(parents('HEAD'), 2);
      expect(git(['rev-parse', 'HEAD^1']), before);
      expect(git(['rev-parse', 'HEAD^2']), git(['rev-parse', 'feature']));
      expect(git(['log', '-1', '--format=%s']), 'Merge the feature');
    });

    test('no fast-forward without a message uses the git default', () async {
      feature();
      await merge('feature', const MergeOptions(noFf: true));
      expect(parents('HEAD'), 2);
      expect(git(['log', '-1', '--format=%s']), "Merge branch 'feature'");
    });

    test('squash stages the changes without committing', () async {
      diverged();
      final before = head();
      final out = await merge('feature', const MergeOptions(squash: true, noCommit: true));
      expect(head(), before);
      expect(git(['diff', '--cached', '--name-only']).split('\n'), ['f1.txt', 'f2.txt']);
      expect(await GitCliRepository(dir).repoState(), RepoState.normal);
      expect(out.squashMessage, startsWith('Squashed commit of the following:'));
      expect(out.squashMessage, contains('f2'));
    });

    test('no commit stops with the merge in progress', () async {
      diverged();
      final before = head();
      final out = await merge('feature', const MergeOptions(noCommit: true));
      expect(out.stopped, isTrue);
      expect(head(), before);
      expect(await GitCliRepository(dir).repoState(), RepoState.merging);
    });

    test('preview of a fast-forwardable branch', () async {
      feature();
      final pv = await merge.preview('feature');
      expect((pv.commits, pv.fastForward, pv.upToDate), (2, true, false));
    });

    test('preview of diverged branches', () async {
      diverged();
      final pv = await merge.preview('feature');
      expect((pv.commits, pv.fastForward), (2, false));
      final back = await merge.preview('main~1');
      expect((back.commits, back.upToDate), (0, true));
    });

    test('invalid options are rejected before running git', () async {
      feature();
      final before = head();
      await expectLater(merge('feature', const MergeOptions(ffOnly: true, noFf: true)), throwsA(isA<MergeRejected>()));
      await expectLater(merge('feature', const MergeOptions(squash: true)), throwsA(isA<MergeRejected>()));
      expect(head(), before);
    });

    test('merge is rejected while another merge is in progress', () async {
      diverged();
      await merge('feature', const MergeOptions(noCommit: true));
      await expectLater(merge('feature', const MergeOptions()), throwsA(isA<MergeRejected>()));
    });
  });

  group('Merge dialog', () {
    late Directory tmp;
    late String dir;

    String git(List<String> args) {
      final r = Process.runSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@t', ...args], workingDirectory: dir);
      if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
      return (r.stdout as String).trim();
    }

    void commit(String file, String msg) {
      File(p.join(dir, file)).writeAsStringSync('$msg\n');
      git(['add', '-A']);
      git(['commit', '-qm', msg]);
    }

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('gt_merge_ui_');
      dir = p.join(tmp.path, 'repo');
      Directory(dir).createSync();
      git(['init', '-q', '-b', 'main']);
      git(['config', 'core.autocrlf', 'false']);
      commit('a.txt', 'init');
      git(['checkout', '-q', '-b', 'feature']);
      commit('f.txt', 'f1');
      git(['checkout', '-q', 'main']);
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

    Future<void> settle(WidgetTester tester, Finder found) async {
      for (var i = 0; i < 100 && found.evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 10));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }
      await tester.pump();
    }

    CheckboxListTile tile(WidgetTester tester, String title) =>
        tester.widget<CheckboxListTile>(find.widgetWithText(CheckboxListTile, title));

    testWidgets('squash disables no commit and the message, then stages the changes', (tester) async {
      tester.view.physicalSize = const Size(1400, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final ctrl = RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi);
      await tester.runAsync(ctrl.refreshAll);
      addTearDown(ctrl.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showMergeDialog(context, ctrl, 'feature'),
              child: const Text('open'),
            ),
          ),
        ),
      ));

      await tester.tap(find.text('open'));
      await tester.pump();
      await settle(tester, find.text('1 commit will be merged · Fast-forward possible'));
      expect(find.text('1 commit will be merged · Fast-forward possible'), findsOneWidget);
      expect(find.textContaining("Merge 'feature' into 'main'", findRichText: true), findsOneWidget);
      // Fast-forward: no merge commit, so the message is disabled.
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);

      await tester.tap(find.text('No fast-forward'));
      await tester.pump();
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);

      await tester.tap(find.text('Squash'));
      await tester.pump();
      expect(tile(tester, 'Squash').value, isTrue);
      expect(tile(tester, 'No fast-forward').value, isFalse);
      expect(tile(tester, 'No commit').value, isTrue);
      expect(tile(tester, 'No commit').onChanged, isNull);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);

      await tester.tap(find.widgetWithText(FilledButton, 'Merge'));
      await tester.pump();
      for (var i = 0; i < 300 && (ctrl.busy.value != null || git(['diff', '--cached', '--name-only']).isEmpty); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump(const Duration(milliseconds: 10));
      }
      expect(git(['diff', '--cached', '--name-only']), 'f.txt');
      expect(ctrl.lastMergeOptions.squash, isTrue);
      expect(find.byType(Dialog), findsNothing);
      // Let the refresh after the merge finish before the folder is deleted.
      for (var i = 0; i < 50 && ctrl.busy.value != null; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }
    });
  });
}
