import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/branches/branch_menu.dart';
import 'package:git_tools/presentation/ui/branches/delete_current_branch_dialog.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

/// "Delete" on the current branch: a repository with an origin, main and
/// feature (checked out, pushed without upstream, merged into main).
void main() {
  late Directory tmp;
  late String origin;
  late String dir;

  String run(String cwd, List<String> args) {
    final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
        workingDirectory: cwd);
    if (r.exitCode != 0) throw StateError('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  String git(List<String> args) => run(dir, args);
  bool exists(String ref) => Process.runSync('git', ['rev-parse', '--verify', '-q', ref], workingDirectory: dir).exitCode == 0;
  String head() => git(['rev-parse', '--abbrev-ref', 'HEAD']);
  void write(String f, String text) => File(p.join(dir, f)).writeAsStringSync(text);
  void commit(String f, String text, String msg) {
    write(f, text);
    git(['add', '-A']);
    git(['commit', '-qm', msg]);
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_delete_current_');
    origin = p.join(tmp.path, 'origin.git');
    dir = p.join(tmp.path, 'repo');
    run(tmp.path, ['init', '-q', '--bare', '-b', 'main', origin]);
    run(tmp.path, ['init', '-q', '-b', 'main', dir]);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'commit.gpgsign': 'false', 'core.autocrlf': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    commit('a.txt', 'a\n', 'init');
    git(['remote', 'add', 'origin', origin]);
    git(['push', '-q', '-u', 'origin', 'main']);
    git(['checkout', '-q', '-b', 'feature']);
    git(['push', '-q', 'origin', 'feature']);
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
    for (var i = 0; i < 400 && !done(); i++) {
      await tester.pump(const Duration(milliseconds: 10));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    }
    await tester.pump();
  }

  Widget host(Widget child) => MaterialApp(theme: buildTheme(), home: Scaffold(body: child));

  const title = "Delete Current Branch 'feature'";
  bool shown(String text) => find.text(text).evaluate().isNotEmpty;
  bool selected(WidgetTester tester, String name) =>
      tester.widget<HoverRow>(find.ancestor(of: find.text(name), matching: find.byType(HoverRow))).selected;

  /// Opens the branch menu of feature (the current branch) and chooses Delete.
  Future<void> openDelete(WidgetTester tester, RepoController ctrl) async {
    final feature = ctrl.branches.value.firstWhere((x) => x.name == 'feature');
    expect(feature.isCurrent, isTrue);
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(
          onPressed: () => showBranchMenu(context, ctrl, feature, const Offset(20, 20)), child: const Text('feature menu')),
    )));
    await tester.tap(find.text('feature menu'));
    await tester.pumpAndSettle();
    final delete = find.ancestor(of: find.text('Delete'), matching: find.byType(PopupMenuItem<String>));
    expect(tester.widget<PopupMenuItem<String>>(delete).enabled, isTrue);
    await tester.tap(find.text('Delete'));
    await settle(tester, () => shown(title));
    expect(find.byWidgetPredicate((w) => w is RadioListTile), findsNWidgets(2));
    expect(find.text('Checkout Another Branch and Delete'), findsOneWidget);
    expect(find.text('Create New Branch and Delete'), findsOneWidget);
  }

  testWidgets('Delete is enabled on the current branch; option 1, Enter at once: main is checked out, feature deleted',
      (tester) async {
    final ctrl = await open(tester);
    await openDelete(tester, ctrl);
    expect(selected(tester, 'main'), isTrue);
    expect(selected(tester, 'origin/main'), isFalse);
    expect(find.text('feature'), findsNothing, reason: 'the branch being deleted is not a target');
    expect(find.text('origin/feature'), findsNothing, reason: 'its checkout lands back on feature');

    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester, () => ctrl.busy.value == null && !exists('refs/heads/feature'));
    expect(head(), 'main');
    expect(exists('refs/heads/feature'), isFalse);
    expect(exists('refs/remotes/origin/feature'), isTrue, reason: 'only the local branch is deleted');
    expect(run(origin, ['branch', '--list', 'feature']), contains('feature'));
    await settle(tester, () => ctrl.notifications.value?.title == 'Deleted branch feature, now on main');
    expect(ctrl.notifications.value?.title, 'Deleted branch feature, now on main');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets("option 1: local changes block the checkout, Don't Checkout keeps feature checked out", (tester) async {
    commit('a.txt', 'feature\n', 'feature work');
    write('a.txt', 'uncommitted\n');
    final ctrl = await open(tester);
    await openDelete(tester, ctrl);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester, () => shown('Git Checkout Problem'));
    await tester.tap(find.text("Don't Checkout"));
    await settle(tester, () => ctrl.busy.value == null && !shown('Git Checkout Problem'));
    await tester.runAsync(ctrl.refreshAll);
    expect(head(), 'feature');
    expect(exists('refs/heads/feature'), isTrue);
    expect(File(p.join(dir, 'a.txt')).readAsStringSync(), 'uncommitted\n');
    expect(ctrl.status.value.branch, 'feature');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('option 1: Smart Checkout moves HEAD but its unstash conflicts: feature is kept, the error stays shown',
      (tester) async {
    // feature is merged into main, which then changes a.txt: the unstash on main conflicts.
    commit('a.txt', 'feature\n', 'feature work');
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--ff-only', 'feature']);
    commit('a.txt', 'main\n', 'main work');
    git(['checkout', '-q', 'feature']);
    write('a.txt', 'uncommitted\n');
    final ctrl = await open(tester);
    await openDelete(tester, ctrl);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester, () => shown('Git Checkout Problem'));
    await tester.tap(find.text('Smart Checkout'));
    await settle(tester, () => ctrl.busy.value == null && ctrl.notifications.value?.isError == true);
    // Leaves time for a delete that must not come.
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 10));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    }
    expect(head(), 'main');
    expect(exists('refs/heads/feature'), isTrue);
    expect(shown('Branch Is Not Fully Merged'), isFalse);
    expect(ctrl.busy.value, isNull);
    expect(ctrl.notifications.value?.isError, isTrue);
    expect(ctrl.notifications.value?.title, 'Checkout main failed');
    await tester.pump(const Duration(seconds: 8));
  });

  testWidgets('option 2, Enter with the default start point: on the new branch; feature not merged, Force declined',
      (tester) async {
    commit('f.txt', 'feature\n', 'feature work');
    final ctrl = await open(tester);
    await openDelete(tester, ctrl);
    await tester.tap(find.text('Create New Branch and Delete'));
    await tester.pumpAndSettle();
    expect(find.byType(CheckboxListTile), findsNothing, reason: 'no Overwrite, no Checkout option');
    expect(selected(tester, 'main'), isTrue);
    expect(find.text('feature'), findsOneWidget, reason: 'the branch being deleted is a start point');

    final name = find.byType(TextField).first;
    await tester.enterText(name, 'feature');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(find.text('A branch named "feature" already exists'), findsOneWidget);
    expect(shown(title), isTrue);

    await tester.enterText(name, 'next');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester, () => shown('Branch Is Not Fully Merged'));
    expect(head(), 'next');
    expect(git(['rev-parse', 'next']), git(['rev-parse', 'main']));
    // Lets the Delete Current Branch dialog finish closing.
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.text('Cancel'));
    await settle(tester, () => ctrl.busy.value == null && ctrl.notifications.value?.title.contains('not deleted') == true);
    expect(ctrl.notifications.value?.title, 'feature was not deleted: it is not fully merged. You are on next.');
    expect(exists('refs/heads/feature'), isTrue);
    expect(head(), 'next');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('Cancel and Esc change nothing', (tester) async {
    final ctrl = await open(tester);
    final branches = git(['branch', '-a']);
    await openDelete(tester, ctrl);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(shown(title), isFalse);

    await openDelete(tester, ctrl);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(shown(title), isFalse);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    expect(head(), 'feature');
    expect(git(['branch', '-a']), branches);
    expect(git(['status', '--porcelain']), '');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('during a merge: only a notification, no dialog and no git command', (tester) async {
    commit('a.txt', 'feature\n', 'feature work');
    git(['checkout', '-q', 'main']);
    commit('a.txt', 'main\n', 'main work');
    git(['checkout', '-q', 'feature']);
    expect(Process.runSync('git', ['merge', '--no-edit', 'main'], workingDirectory: dir).exitCode, isNot(0));
    final ctrl = await open(tester);
    expect(ctrl.status.value.state, RepoState.merging);
    final feature = ctrl.branches.value.firstWhere((x) => x.name == 'feature');
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(
          onPressed: () => runBranchAction(context, ctrl, feature, 'delete'), child: const Text('delete')),
    )));
    await tester.tap(find.text('delete'));
    await tester.pumpAndSettle();
    expect(shown(title), isFalse);
    expect(ctrl.notifications.value?.title, 'Finish or abort the merge in progress first: feature cannot be deleted now.');
    expect(head(), 'feature');
    expect(exists('MERGE_HEAD'), isTrue);
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('without main or master nothing is preselected and Enter does nothing', (tester) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    const branches = [
      Branch(name: 'feature', isRemote: false, hash: '', isCurrent: true),
      Branch(name: 'dev', isRemote: false, hash: ''),
      Branch(name: 'origin/dev', isRemote: true, hash: ''),
    ];
    LeaveBranchChoice? result;
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(
          onPressed: () async =>
              result = await showDeleteCurrentBranchDialog(context, deleting: 'feature', branches: branches),
          child: const Text('open')),
    )));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(tester.widgetList<HoverRow>(find.byType(HoverRow)).where((r) => r.selected), isEmpty);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text(title), findsOneWidget);

    await tester.tap(find.text('dev'));
    // The row also handles double taps: a single tap waits for their timeout.
    await tester.pump(kDoubleTapTimeout);
    expect(selected(tester, 'dev'), isTrue);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text(title), findsNothing);
    expect(result, isA<CheckoutAndDelete>().having((c) => c.target.name, 'target', 'dev'));
  });

  /// Opens the dialog on [branches] (feature being deleted); its result goes to [done].
  Future<void> openDialog(WidgetTester tester, List<Branch> branches, void Function(LeaveBranchChoice?) done) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(
          onPressed: () async =>
              done(await showDeleteCurrentBranchDialog(context, deleting: 'feature', branches: branches)),
          child: const Text('open')),
    )));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('the filter keeps the default: it comes back once the filter is cleared', (tester) async {
    const branches = [
      Branch(name: 'feature', isRemote: false, hash: '', isCurrent: true),
      Branch(name: 'main', isRemote: false, hash: ''),
      Branch(name: 'dev', isRemote: false, hash: ''),
      Branch(name: 'origin/dev', isRemote: true, hash: ''),
    ];
    LeaveBranchChoice? result;
    await openDialog(tester, branches, (r) => result = r);
    final search = find.byType(TextField).first;
    expect(selected(tester, 'main'), isTrue);

    await tester.enterText(search, 'zzz');
    await tester.pump();
    expect(find.text('No branch matches'), findsOneWidget);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text(title), findsOneWidget, reason: 'nothing is selected');

    await tester.enterText(search, '');
    await tester.pump();
    expect(selected(tester, 'main'), isTrue, reason: 'the default is selected again');

    await tester.enterText(search, 'ai');
    await tester.pump();
    expect(selected(tester, 'main'), isTrue);

    await tester.enterText(search, 'dev');
    await tester.pump();
    expect(selected(tester, 'dev'), isTrue, reason: 'main hidden: the first match');
    expect(selected(tester, 'origin/dev'), isFalse);

    await tester.enterText(search, '');
    await tester.pump();
    expect(selected(tester, 'main'), isTrue);
    expect(selected(tester, 'dev'), isFalse);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text(title), findsNothing);
    expect(result, isA<CheckoutAndDelete>().having((c) => c.target.name, 'target', 'main'));
  });

  testWidgets('without a default, a filter with a single match selects it', (tester) async {
    const branches = [
      Branch(name: 'feature', isRemote: false, hash: '', isCurrent: true),
      Branch(name: 'dev', isRemote: false, hash: ''),
      Branch(name: 'origin/dev', isRemote: true, hash: ''),
    ];
    LeaveBranchChoice? result;
    await openDialog(tester, branches, (r) => result = r);
    final search = find.byType(TextField).first;
    bool anySelected() => tester.widgetList<HoverRow>(find.byType(HoverRow)).any((r) => r.selected);

    await tester.enterText(search, 'dev');
    await tester.pump();
    expect(anySelected(), isFalse, reason: 'two matches, no default');

    await tester.enterText(search, 'origin');
    await tester.pump();
    expect(selected(tester, 'origin/dev'), isTrue);

    await tester.enterText(search, '');
    await tester.pump();
    expect(anySelected(), isFalse, reason: 'still no default without a filter');

    await tester.enterText(search, 'origin');
    await tester.pump();
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(result, isA<CheckoutAndDelete>().having((c) => c.target.name, 'target', 'origin/dev'));
  });
}
