import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/logic/branch_divergence.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/branches/branch_menu.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

/// Rebase / Merge "from origin" in the branch menu: on feature, right click
/// develop (behind its origin) and take origin/develop, fetched first.
void main() {
  late Directory tmp;
  late String dir;

  String run(String cwd, List<String> args) {
    final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
        workingDirectory: cwd);
    if (r.exitCode != 0) throw StateError('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  String git(List<String> args) => run(dir, args);

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_intremote_');
    final origin = p.join(tmp.path, 'origin.git');
    final other = p.join(tmp.path, 'other');
    dir = p.join(tmp.path, 'clone');
    void commit(String cwd, String f, String text, String msg) {
      File(p.join(cwd, f)).writeAsStringSync(text);
      run(cwd, ['add', '-A']);
      run(cwd, ['commit', '-qm', msg]);
    }

    run(tmp.path, ['init', '-q', '--bare', '-b', 'main', origin]);
    run(tmp.path, ['clone', '-q', '-c', 'core.autocrlf=false', origin, other]);
    commit(other, 'a.txt', 'a\n', 'init');
    run(other, ['checkout', '-q', '-b', 'develop']);
    commit(other, 'd.txt', 'd1\n', 'develop 1');
    run(other, ['push', '-q', 'origin', 'main', 'develop']);
    run(tmp.path, ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir]);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'commit.gpgsign': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    git(['branch', 'develop', 'origin/develop']);
    git(['branch', 'local-only']);
    git(['checkout', '-q', '-b', 'feature', 'main']);
    commit(dir, 'f.txt', 'f\n', 'feature work');
    // origin's develop moves on; the clone has not fetched it.
    commit(other, 'd.txt', 'd2\n', 'develop 2 (on origin only)');
    run(other, ['push', '-q', 'origin', 'develop']);
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

  Branch b(String name, {bool remote = false, String? upstream, bool gone = false}) =>
      Branch(name: name, isRemote: remote, hash: '', upstream: upstream, gone: gone);

  test('remoteBranchOf: the upstream, else a remote branch of that name, origin first', () {
    final all = [b('upstream/x', remote: true), b('origin/x', remote: true), b('fork/y', remote: true)];
    expect(remoteBranchOf(b('x', upstream: 'origin/other'), all), 'origin/other');
    expect(remoteBranchOf(b('x'), all), 'origin/x');
    expect(remoteBranchOf(b('x', upstream: 'origin/gone', gone: true), all), 'origin/x');
    expect(remoteBranchOf(b('y'), all), 'fork/y');
    expect(remoteBranchOf(b('z'), all), isNull);
    expect(remoteBranchOf(b('origin/x', remote: true), all), isNull);
  });

  Future<RepoController> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final ctrl = (await tester.runAsync(() async => RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi)))!;
    await tester.runAsync(ctrl.refreshAll);
    addTearDown(ctrl.dispose);
    return ctrl;
  }

  Future<void> settle(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await tester.pump(const Duration(milliseconds: 10));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    }
    await tester.pump();
  }

  Future<void> openMenu(WidgetTester tester, RepoController ctrl, String branch) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showBranchMenu(
                context, ctrl, ctrl.branches.value.firstWhere((x) => x.name == branch), const Offset(20, 20)),
            child: const Text('menu'),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('menu'));
    await tester.pumpAndSettle();
  }

  testWidgets('the "from origin" entries only for a local branch that has one on a remote', (tester) async {
    final ctrl = await open(tester);
    await openMenu(tester, ctrl, 'develop');
    expect(find.text("Rebase 'feature' onto 'origin/develop' (fetched)"), findsOneWidget);
    expect(find.text("Merge 'origin/develop' into 'feature'… (fetched)"), findsOneWidget);
    expect(find.text("Quick Merge 'origin/develop' into 'feature' (fetched, default options)"), findsOneWidget);
    await tester.tapAt(const Offset(1100, 800));
    await tester.pumpAndSettle();

    await openMenu(tester, ctrl, 'local-only');
    expect(find.textContaining('origin/'), findsNothing);
  });

  testWidgets('Rebase onto origin/develop fetches first: feature ends on the commit only origin had', (tester) async {
    final ctrl = await open(tester);
    final developBefore = git(['rev-parse', 'develop']);
    await openMenu(tester, ctrl, 'develop');
    await tester.tap(find.text("Rebase 'feature' onto 'origin/develop' (fetched)"));
    await settle(tester, () => git(['log', '--format=%s']).contains('develop 2'));
    await settle(tester, () => ctrl.busy.value == null);
    expect(git(['log', '--format=%s']).split('\n'), ['feature work', 'develop 2 (on origin only)', 'develop 1', 'init']);
    expect(git(['rev-parse', 'develop']), developBefore, reason: 'the local develop is not touched');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('Quick Merge origin/develop merges the fetched remote branch', (tester) async {
    final ctrl = await open(tester);
    await openMenu(tester, ctrl, 'develop');
    await tester.tap(find.text("Quick Merge 'origin/develop' into 'feature' (fetched, default options)"));
    await settle(tester, () => git(['rev-list', '--count', 'HEAD']) == '5');
    await settle(tester, () => ctrl.busy.value == null);
    expect(git(['rev-parse', 'HEAD^2']), git(['rev-parse', 'origin/develop']));
    expect(git(['log', '-1', '--format=%s', 'HEAD^2']), 'develop 2 (on origin only)');
    await tester.pump(const Duration(seconds: 5));
  });
}
