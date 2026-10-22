import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/logic/branch_divergence.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/repositories/git_repository.dart';
import 'package:git_tools/domain/usecases/take_remote_branch.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/branches/branch_menu.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/conflicts/conflicts_dialog.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

/// "Drop Local and Take `<upstream>`": a bare origin, a clone where feature
/// has a local commit, and origin's feature moved on (same file: a pull
/// conflicts).
void main() {
  late Directory tmp;
  late String dir;
  late GitRepository repo;

  String run(String cwd, List<String> args) {
    final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
        workingDirectory: cwd);
    if (r.exitCode != 0) throw StateError('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  String git(List<String> args) => run(dir, args);
  bool fails(List<String> args) => Process.runSync('git', args, workingDirectory: dir).exitCode != 0;
  String read(String f) => File(p.join(dir, f)).readAsStringSync();
  void write(String f, String text) => File(p.join(dir, f)).writeAsStringSync(text);

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_take_');
    final origin = p.join(tmp.path, 'origin.git');
    final other = p.join(tmp.path, 'other');
    dir = p.join(tmp.path, 'clone');
    run(tmp.path, ['init', '-q', '--bare', '-b', 'main', origin]);
    run(tmp.path, ['clone', '-q', '-c', 'core.autocrlf=false', origin, other]);
    void commit(String cwd, String f, String text, String msg) {
      File(p.join(cwd, f)).writeAsStringSync(text);
      run(cwd, ['add', '-A']);
      run(cwd, ['commit', '-qm', msg]);
    }

    commit(other, 'a.txt', 'a\n', 'init');
    run(other, ['checkout', '-q', '-b', 'feature']);
    commit(other, 'f.txt', 'base\n', 'feature base');
    run(other, ['push', '-q', 'origin', 'main', 'feature']);
    run(tmp.path, ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir]);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'commit.gpgsign': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    git(['checkout', '-q', 'feature']);
    commit(dir, 'f.txt', 'mine\n', 'local work');
    commit(other, 'f.txt', 'theirs\n', 'origin work');
    run(other, ['push', '-q', 'origin', 'feature']);
    git(['fetch', '-q']);
    repo = const GitCliService().open(dir);
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

  Branch b({int ahead = 1, int behind = 1, String? upstream = 'origin/x', bool remote = false, bool gone = false}) =>
      Branch(name: 'x', isRemote: remote, hash: '', upstream: upstream, ahead: ahead, behind: behind, gone: gone);

  test('divergedFromUpstream: only a local branch both ahead and behind its upstream', () {
    expect(divergedFromUpstream(b()), isTrue);
    expect(divergedFromUpstream(b(ahead: 0)), isFalse, reason: 'only behind: a pull fast-forwards');
    expect(divergedFromUpstream(b(behind: 0)), isFalse, reason: 'only ahead: a push is enough');
    expect(divergedFromUpstream(b(upstream: null)), isFalse);
    expect(divergedFromUpstream(b(gone: true)), isFalse);
    expect(divergedFromUpstream(b(remote: true)), isFalse);
  });

  test('feature is diverged; from another branch with uncommitted changes, taking origin moves them over', () async {
    final feature = (await repo.branches()).firstWhere((x) => x.name == 'feature');
    expect(divergedFromUpstream(feature), isTrue);
    expect(divergedFromUpstream((await repo.branches()).firstWhere((x) => x.name == 'main')), isFalse);

    git(['checkout', '-q', 'main']);
    write('a.txt', 'edited\n');
    write('new.txt', 'untracked\n');
    final take = TakeRemoteBranch(repo);
    expect((await take.preview('feature', 'origin/feature')).map((c) => c.subject), ['local work']);
    expect(await take('feature', 'origin/feature'), isTrue);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
    expect(git(['rev-parse', 'HEAD']), git(['rev-parse', 'origin/feature']));
    expect(git(['rev-parse', '--abbrev-ref', 'feature@{upstream}']), 'origin/feature');
    expect(read('f.txt'), 'theirs\n');
    expect(read('a.txt'), 'edited\n');
    expect(read('new.txt'), 'untracked\n');
    expect(git(['stash', 'list']), '');
  });

  for (final rebase in [false, true]) {
    test('a ${rebase ? 'rebase' : 'merge'} pull that conflicts is found, aborted, and origin taken', () async {
      write('a.txt', 'kept\n');
      expect(fails(['pull', rebase ? '--rebase' : '--no-rebase', '--autostash', '--no-edit', 'origin', 'feature']), isTrue);
      final state = await repo.repoState();
      expect(state, rebase ? RepoState.rebasing : RepoState.merging);
      expect(await repo.pullInProgress(), (branch: 'feature', upstream: 'origin/feature'));
      expect(await TakeRemoteBranch(repo)('feature', 'origin/feature', abort: state), isTrue);
      expect(await repo.repoState(), RepoState.normal);
      expect(git(['rev-parse', 'HEAD']), git(['rev-parse', 'origin/feature']));
      expect(read('a.txt'), 'kept\n');
      expect(git(['stash', 'list']), '');
    });
  }

  test('a conflicting merge that is not a pull is not offered', () async {
    git(['checkout', '-q', '-b', 'other', 'origin/feature']);
    git(['checkout', '-q', 'feature']);
    git(['branch', '--unset-upstream']);
    expect(fails(['merge', '--no-edit', 'other']), isTrue);
    expect(await repo.pullInProgress(), isNull);
  });

  test('uncommitted changes that do not apply on origin stay in the stash', () async {
    write('f.txt', 'mine, uncommitted\n');
    expect(await TakeRemoteBranch(repo)('feature', 'origin/feature'), isFalse);
    expect(git(['rev-parse', 'HEAD']), git(['rev-parse', 'origin/feature']));
    expect(git(['stash', 'list']), contains('Uncommitted changes before taking origin/feature'));
  });

  group('UI', () {
    Future<RepoController> open(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      // Built in real time: its changelist queue would otherwise wait on the fake clock.
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

    Widget host(Widget child) => MaterialApp(theme: buildTheme(), home: Scaffold(body: child));

    testWidgets('branch menu: the option only for the diverged branch; confirm lists the commit, then takes origin',
        (tester) async {
      final ctrl = await open(tester);
      Branch named(String n) => ctrl.branches.value.firstWhere((x) => x.name == n);
      await tester.pumpWidget(host(Builder(
        builder: (context) => Column(children: [
          TextButton(onPressed: () => showBranchMenu(context, ctrl, named('main'), const Offset(20, 20)), child: const Text('main menu')),
          TextButton(onPressed: () => showBranchMenu(context, ctrl, named('feature'), const Offset(20, 20)), child: const Text('feature menu')),
        ]),
      )));
      await tester.tap(find.text('main menu'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Drop Local and Take'), findsNothing);
      await tester.tapAt(const Offset(1100, 700));
      await tester.pumpAndSettle();

      await tester.tap(find.text('feature menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text("Drop Local and Take 'origin/feature'… (↑1 ↓1)"));
      await settle(tester, () => find.text('Take origin/feature').evaluate().isNotEmpty);
      expect(find.text('Drop local feature and take origin/feature'), findsOneWidget);
      expect(find.textContaining('local work'), findsOneWidget);
      await tester.tap(find.text('Take origin/feature'));
      await settle(tester, () => ctrl.busy.value == null && ctrl.status.value.headHash == git(['rev-parse', 'origin/feature']));
      expect(git(['rev-parse', 'HEAD']), git(['rev-parse', 'origin/feature']));
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('after a pull with conflicts: the notification and the Conflicts dialog offer to take origin',
        (tester) async {
      expect(fails(['pull', '--no-rebase', '--no-edit', 'origin', 'feature']), isTrue);
      final ctrl = await open(tester);
      await tester.runAsync(ctrl.notifyPullConflicts);
      final n = ctrl.notifications.value!;
      expect(n.title, 'Update finished with conflicts');
      expect(n.actionLabel, 'Take origin/feature…');
      n.onAction!();
      expect(ctrl.takeRemoteRequest.value, (branch: 'feature', upstream: 'origin/feature', abort: RepoState.merging));
      ctrl.takeRemoteRequest.value = null;

      await tester.pumpWidget(host(Builder(
        builder: (context) => TextButton(onPressed: () => showConflictsDialog(context, ctrl), child: const Text('open')),
      )));
      await tester.tap(find.text('open'));
      await settle(tester, () => find.text('Abort and Take origin/feature…').evaluate().isNotEmpty);
      await tester.tap(find.text('Abort and Take origin/feature…'));
      await tester.pumpAndSettle();
      expect(find.text('Conflicts'), findsNothing);
      expect(ctrl.takeRemoteRequest.value, (branch: 'feature', upstream: 'origin/feature', abort: RepoState.merging));
    });
  });
}
