import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/worktree.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/logic/worktree_parser.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/dialogs/worktree_dialogs.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

void main() {
  group('parseWorktrees', () {
    const out = 'worktree C:/src/app\x00HEAD 1111111111111111\x00branch refs/heads/main\x00\x00'
        'worktree C:/src/app feat\x00HEAD 2222222222222222\x00branch refs/heads/feature/x\x00locked\x00\x00'
        'worktree C:/src/wt2\x00HEAD 3333333333333333\x00detached\x00locked on usb drive\x00\x00'
        'worktree C:/src/gone\x00HEAD 4444444444444444\x00detached\x00'
        'prunable gitdir file points to non-existent location\x00\x00';

    test('reads branches, detached, locked and prunable entries', () {
      final list = parseWorktrees(out, currentPath: 'C:/src/app');
      expect(list.map((w) => w.path), ['C:/src/app', 'C:/src/app feat', 'C:/src/wt2', 'C:/src/gone']);
      expect(list.map((w) => w.isMain), [true, false, false, false]);

      final main = list[0];
      expect(main.branch, 'main');
      expect(main.head, '1111111111111111');
      expect(main.detached, isFalse);
      expect(main.locked, isFalse);
      expect(main.prunable, isFalse);

      final feat = list[1];
      expect(feat.name, 'app feat');
      expect(feat.branch, 'feature/x');
      expect(feat.locked, isTrue);
      expect(feat.lockReason, isNull);

      final wt2 = list[2];
      expect(wt2.branch, isNull);
      expect(wt2.detached, isTrue);
      expect(wt2.description, 'detached at 33333333');
      expect(wt2.locked, isTrue);
      expect(wt2.lockReason, 'on usb drive');

      final gone = list[3];
      expect(gone.prunable, isTrue);
      expect(gone.prunableReason, 'gitdir file points to non-existent location');
      expect(gone.locked, isFalse);
    });

    test('detects the current worktree whatever the slashes or drive letter case', () {
      final list = parseWorktrees(out, currentPath: r'c:\src\app feat\');
      expect(list.map((w) => w.isCurrent), [false, true, false, false]);
      expect(parseWorktrees(out).any((w) => w.isCurrent), isFalse);
    });

    test('bare main repository', () {
      final list = parseWorktrees(
        'worktree /srv/repo.git\x00bare\x00\x00worktree /home/u/wt\x00HEAD abc\x00branch refs/heads/dev\x00\x00',
        currentPath: '/home/u/wt/',
      );
      expect(list, hasLength(2));
      expect(list[0].bare, isTrue);
      expect(list[0].head, isNull);
      expect(list[0].description, 'bare');
      expect(list[0].isMain, isTrue);
      expect(list[0].isCurrent, isFalse);
      expect(list[1].branch, 'dev');
      expect(list[1].isMain, isFalse);
      expect(list[1].isCurrent, isTrue);
    });

    test('samePath', () {
      expect(samePath('C:/a b/wt', r'c:\a b\wt\'), isTrue);
      expect(samePath('/home/U/wt', '/home/u/wt'), isFalse);
      expect(samePath('/home/u/wt/', '/home/u/wt'), isTrue);
    });
  });

  group('default worktree path', () {
    test('sanitizeForPath', () {
      expect(sanitizeForPath('feature/x y'), 'feature-x-y');
      expect(sanitizeForPath('fix//a:b'), 'fix-a-b');
      expect(sanitizeForPath('/'), 'worktree');
    });

    test('next to the repository', () {
      expect(defaultWorktreePath('C:/src/app', 'feature/login'), 'C:/src/app-feature-login');
      expect(defaultWorktreePath(r'C:\src\app\', 'dev'), 'C:/src/app-dev');
      expect(defaultWorktreePath('/home/u/app', 'feature/x y'), '/home/u/app-feature-x-y');
      expect(defaultWorktreePath('/app', 'dev'), '/app-dev');
      expect(defaultWorktreePath('/home/u/app', null), '/home/u/app-worktree');
      expect(defaultWorktreePath('/home/u/app', '  '), '/home/u/app-worktree');
    });
  });

  group('worktreeOfCheckoutError', () {
    test('both git messages', () {
      expect(worktreeOfCheckoutError("fatal: 'feat' is already used by worktree at 'C:/a b/wt'\n"), 'C:/a b/wt');
      expect(worktreeOfCheckoutError("fatal: 'feat' is already checked out at '/x/wt'"), '/x/wt');
    });

    test('null for other errors', () {
      expect(worktreeOfCheckoutError("error: pathspec 'nope' did not match any file(s) known to git"), isNull);
      expect(worktreeOfCheckoutError(''), isNull);
    });
  });

  group('on a repository', () {
    late Directory tmp;
    late String dir;
    late GitCliRepository repo;

    String git(List<String> args, {String? cwd}) {
      final r = Process.runSync('git', args, workingDirectory: cwd ?? dir);
      if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
      return (r.stdout as String).trim();
    }

    /// [path] as git prints it may be long while the temp folder is an 8.3
    /// short path on Windows: compare resolved paths.
    String real(String path) => Directory(path).resolveSymbolicLinksSync();
    String wt(String name) => p.join(tmp.path, name);

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('gt_worktree_');
      dir = p.join(tmp.path, 'repo');
      Directory(dir).createSync();
      git(['init', '-q', '-b', 'main']);
      for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
        git(['config', kv.key, kv.value]);
      }
      File(p.join(dir, 'a.txt')).writeAsStringSync('a\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'first']);
      git(['branch', 'other']);
      File(p.join(dir, 'a.txt')).writeAsStringSync('a2\n');
      git(['commit', '-qam', 'second']);
      git(['branch', 'feat']);
      repo = GitCliRepository(dir);
    });

    // Git may still hold files of the worktrees for a moment on Windows.
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

    test('adds worktrees for an existing branch, a new branch and a detached HEAD', () async {
      await repo.addWorktree(wt('wt feat'), const ExistingBranchCheckout('feat'));
      await repo.addWorktree(wt('wt-topic'), const NewBranchCheckout('topic', startPoint: 'other'));
      await repo.addWorktree(wt('wt-detached'), const DetachedCheckout(revision: 'HEAD~1'));

      final list = await repo.worktrees();
      expect(list, hasLength(4));
      expect(list.map((w) => w.isMain), [true, false, false, false]);
      expect(list.map((w) => w.isCurrent), [true, false, false, false]);
      expect(samePath(real(list[0].path), real(dir)), isTrue);

      final byBranch = {for (final w in list) w.branch: w};
      expect(byBranch['main'], same(list[0]));
      expect(samePath(real(byBranch['feat']!.path), real(wt('wt feat'))), isTrue);
      expect(byBranch['feat']!.name, 'wt feat');
      expect(byBranch['topic']!.head, git(['rev-parse', 'other']));
      expect(git(['branch', '--show-current'], cwd: wt('wt-topic')), 'topic');

      final detached = list.singleWhere((w) => w.detached);
      expect(detached.branch, isNull);
      expect(detached.head, git(['rev-parse', 'HEAD~1']));
      expect(samePath(real(detached.path), real(wt('wt-detached'))), isTrue);
      expect(list.any((w) => w.locked || w.prunable || w.bare), isFalse);
    });

    test('lock with and without a reason, unlock', () async {
      await repo.addWorktree(wt('wt-a'), const DetachedCheckout());
      await repo.addWorktree(wt('wt-b'), const DetachedCheckout());
      await repo.lockWorktree(wt('wt-a'), reason: 'on usb drive');
      await repo.lockWorktree(wt('wt-b'));

      var list = await repo.worktrees();
      final a = list.singleWhere((w) => w.name == 'wt-a');
      final b = list.singleWhere((w) => w.name == 'wt-b');
      expect(a.locked, isTrue);
      expect(a.lockReason, 'on usb drive');
      expect(b.locked, isTrue);
      expect(b.lockReason ?? '', isEmpty);

      await repo.unlockWorktree(wt('wt-a'));
      list = await repo.worktrees();
      expect(list.singleWhere((w) => w.name == 'wt-a').locked, isFalse);
      expect(list.singleWhere((w) => w.name == 'wt-b').locked, isTrue);
    });

    test('a branch checked out in another worktree', () async {
      await repo.addWorktree(wt('wt feat'), const ExistingBranchCheckout('feat'));

      final branches = await repo.branches();
      final feat = branches.singleWhere((b) => b.name == 'feat');
      final main = branches.singleWhere((b) => b.name == 'main');
      expect(feat.worktree, isNotNull);
      expect(samePath(real(feat.worktree!), real(wt('wt feat'))), isTrue);
      expect(main.isCurrent, isTrue);
      expect(main.worktree, isNull);
      expect(branches.singleWhere((b) => b.name == 'other').worktree, isNull);

      try {
        await repo.checkout('feat');
        fail('checkout should fail');
      } on GitException catch (e) {
        final path = worktreeOfCheckoutError(e.stderr);
        expect(path, isNotNull);
        expect(samePath(real(path!), real(wt('wt feat'))), isTrue);
      }
    });

    test('remove a clean worktree; one with local changes needs force', () async {
      await repo.addWorktree(wt('wt-clean'), const DetachedCheckout());
      await repo.addWorktree(wt('wt-dirty'), const ExistingBranchCheckout('feat'));
      File(p.join(wt('wt-dirty'), 'new.txt')).writeAsStringSync('x\n');
      File(p.join(wt('wt-dirty'), 'a.txt')).writeAsStringSync('changed\n');

      await repo.removeWorktree(wt('wt-clean'));
      expect(Directory(wt('wt-clean')).existsSync(), isFalse);
      expect((await repo.worktrees()).map((w) => w.name), isNot(contains('wt-clean')));

      await expectLater(
        repo.removeWorktree(wt('wt-dirty')),
        throwsA(isA<GitException>().having((e) => e.stderr, 'stderr', contains('modified or untracked files'))),
      );
      expect(Directory(wt('wt-dirty')).existsSync(), isTrue);

      await repo.removeWorktree(wt('wt-dirty'), force: true);
      expect(Directory(wt('wt-dirty')).existsSync(), isFalse);
      expect(await repo.worktrees(), hasLength(1));
      // The branch is kept.
      expect((await repo.branches()).any((b) => b.name == 'feat' && b.worktree == null), isTrue);
    });

    test('a locked worktree is not removed', () async {
      await repo.addWorktree(wt('wt-locked'), const DetachedCheckout());
      await repo.lockWorktree(wt('wt-locked'), reason: 'keep');
      await expectLater(
        repo.removeWorktree(wt('wt-locked')),
        throwsA(isA<GitException>().having((e) => e.stderr, 'stderr', contains('locked working tree'))),
      );
      expect(Directory(wt('wt-locked')).existsSync(), isTrue);
    });

    test('prune a worktree whose folder was deleted', () async {
      await repo.addWorktree(wt('wt-gone'), const DetachedCheckout());
      await repo.addWorktree(wt('wt-kept'), const DetachedCheckout());
      expect(await repo.pruneWorktrees(dryRun: true), isEmpty);
      Directory(wt('wt-gone')).deleteSync(recursive: true);

      var list = await repo.worktrees();
      expect(list.singleWhere((w) => w.name == 'wt-gone').prunable, isTrue);
      expect(list.singleWhere((w) => w.name == 'wt-kept').prunable, isFalse);

      final preview = await repo.pruneWorktrees(dryRun: true);
      expect(preview, contains('wt-gone'));
      expect(preview, isNot(contains('wt-kept')));
      expect((await repo.worktrees()).map((w) => w.name), contains('wt-gone'));

      await repo.pruneWorktrees();
      list = await repo.worktrees();
      expect(list.map((w) => w.name), isNot(contains('wt-gone')));
      expect(list.map((w) => w.name), contains('wt-kept'));
    });
  });

  group('New Worktree dialog', () {
    late Directory tmp;
    late String dir;

    String git(List<String> args) {
      final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], workingDirectory: dir);
      if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
      return (r.stdout as String).trim();
    }

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('gt_worktree_ui_');
      dir = p.join(tmp.path, 'app');
      Directory(dir).createSync();
      git(['init', '-q', '-b', 'main']);
      git(['config', 'core.autocrlf', 'false']);
      File(p.join(dir, 'a.txt')).writeAsStringSync('a\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'init']);
      git(['branch', 'feature/login']);
      git(['update-ref', 'refs/remotes/origin/feat', 'HEAD']);
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

    Future<RepoController> open(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1400, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final ctrl = RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi);
      await tester.runAsync(ctrl.refreshAll);
      addTearDown(ctrl.dispose);
      return ctrl;
    }

    Future<void> show(WidgetTester tester, RepoController ctrl, {String? branch}) async {
      final b = branch == null ? null : ctrl.branches.value.singleWhere((x) => x.name == branch);
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showNewWorktreeDialog(context, ctrl, branch: b),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    String fieldText(WidgetTester tester, int index) =>
        tester.widget<TextField>(find.byType(TextField).at(index)).controller!.text;

    testWidgets('preselects the mode from the branch', (tester) async {
      final ctrl = await open(tester);
      final parent = p.dirname(dir).replaceAll(r'\', '/');

      await show(tester, ctrl, branch: 'feature/login');
      expect(find.text('Checkout feature/login in New Worktree'), findsOneWidget);
      expect(fieldText(tester, 0), '$parent/app-feature-login');
      expect(find.text('Branch:'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      await show(tester, ctrl, branch: 'origin/feat');
      expect(fieldText(tester, 0), '$parent/app-feat');
      expect(fieldText(tester, 1), 'feat');
      expect(fieldText(tester, 2), 'origin/feat');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // The current branch: a new branch starting from it.
      await show(tester, ctrl, branch: 'main');
      expect(fieldText(tester, 1), isEmpty);
      expect(fieldText(tester, 2), 'main');
      // The default path follows the name until the path is edited.
      await tester.enterText(find.byType(TextField).at(1), 'fix/x');
      await tester.pump();
      expect(fieldText(tester, 0), '$parent/app-fix-x');
      await tester.enterText(find.byType(TextField).at(0), '$parent/custom');
      await tester.enterText(find.byType(TextField).at(1), 'fix/y');
      await tester.pump();
      expect(fieldText(tester, 0), '$parent/custom');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
    });

    testWidgets('validates and creates a worktree on a new branch', (tester) async {
      final ctrl = await open(tester);
      await show(tester, ctrl);

      // Existing branch name and non-empty folder are refused.
      await tester.enterText(find.byType(TextField).at(1), 'feature/login');
      await tester.enterText(find.byType(TextField).at(0), dir);
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pump();
      expect(find.text('A branch named "feature/login" already exists'), findsOneWidget);
      expect(find.text('The folder already exists and is not empty'), findsOneWidget);

      final target = p.join(tmp.path, 'app wt');
      await tester.enterText(find.byType(TextField).at(0), target);
      await tester.enterText(find.byType(TextField).at(1), 'topic');
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pump();
      // The notification with "Open" comes after the refresh.
      for (var i = 0; i < 300 && ctrl.notifications.value?.actionLabel != 'Open'; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump(const Duration(milliseconds: 10));
      }
      // Let the dialog's exit transition finish.
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Create'), findsNothing);
      expect(ctrl.worktrees.value.map((w) => w.branch), ['main', 'topic']);
      expect(ctrl.notifications.value?.actionLabel, 'Open');
      expect(File(p.join(target, 'a.txt')).existsSync(), isTrue);
    });
  });
}
