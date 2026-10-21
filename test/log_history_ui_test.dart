import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/repositories/settings_store.dart';
import 'package:git_tools/presentation/state/app_settings.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/log/branch_picker.dart';
import 'package:git_tools/presentation/ui/log/branches_tree.dart';
import 'package:git_tools/presentation/ui/log/compare_commits_view.dart';
import 'package:git_tools/presentation/ui/log/log_panel.dart';
import 'package:git_tools/presentation/ui/log/reflog_panel.dart';
import 'package:path/path.dart' as p;

class _MemoryStore implements SettingsStore {
  @override
  String get location => 'memory';
  @override
  Future<Map<String, dynamic>?> read() async => null;
  @override
  Future<void> write(Map<String, dynamic> values) async {}
}

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

/// The log history views render on a real repository.
void main() {
  late Directory tmp;
  late String dir;

  String git(List<String> args) {
    final r = Process.runSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@t', ...args], workingDirectory: dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_history_ui_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    for (final n in ['one', 'two', 'three']) {
      File(p.join(dir, '$n.txt')).writeAsStringSync('$n\n');
      git(['add', '-A']);
      git(['commit', '-qm', n]);
    }
    git(['reset', '-q', '--hard', 'HEAD~1']);
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  /// Lets the git processes started by the widgets run (they need real
  /// time, their callbacks fake time) until [found] shows up.
  Future<void> settle(WidgetTester tester, Finder found) async {
    for (var i = 0; i < 100 && found.evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 10));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    }
    await tester.pump();
  }

  Future<RepoController> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1400, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final ctrl = RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi);
    await tester.runAsync(ctrl.refreshAll);
    addTearDown(ctrl.dispose);
    return ctrl;
  }

  Widget host(Widget child) => MaterialApp(theme: buildTheme(), home: Scaffold(body: child));

  testWidgets('log filter bar and the Reflog node', (tester) async {
    final ctrl = await open(tester);
    await tester.pumpWidget(host(LogPanel(controller: ctrl)));
    await settle(tester, find.text('two'));
    expect(find.text('User: All'), findsOneWidget);
    expect(find.text('Date: All'), findsOneWidget);
    expect(find.text('Reflog'), findsOneWidget);
    expect(find.text('Reset filters'), findsNothing);

    await tester.tap(find.text('Reflog'));
    expect(ctrl.bottomTab.value, RepoController.reflogTab);
    await settle(tester, find.text('never'));
    expect(ctrl.reflog.value.first.action, 'reset');
  });

  testWidgets('branches in folders: tree and Branch filter picker', (tester) async {
    // On other commits than HEAD: one row holding every ref chip would overflow.
    git(['branch', 'feature/cart', 'HEAD~1']);
    git(['branch', 'feature/ui/login', 'HEAD@{1}']);
    final ctrl = await open(tester);
    await tester.pumpWidget(host(LogPanel(controller: ctrl)));
    await settle(tester, find.text('two'));

    final tree = find.byType(BranchesTree);
    Finder inTree(String label) => find.descendant(of: tree, matching: find.text(label));
    expect(inTree('feature'), findsOneWidget);
    expect(inTree('cart'), findsNothing);
    await tester.tap(inTree('feature'));
    await tester.pump();
    expect(inTree('cart'), findsOneWidget);
    expect(inTree('ui'), findsOneWidget);

    await tester.tap(find.text('Branch: All'));
    await tester.pumpAndSettle();
    Finder inPicker(String label) => find.descendant(
        of: find.descendant(of: find.byType(BranchPicker), matching: find.byType(HoverRow)), matching: find.text(label));
    expect(inPicker('feature'), findsOneWidget);
    await tester.enterText(find.descendant(of: find.byType(BranchPicker), matching: find.byType(TextField)), 'login');
    await tester.pumpAndSettle();
    await tester.tap(inPicker('login'));
    await settle(tester, find.text('Branch: feature/ui/login'));
    await tester.pump(const Duration(milliseconds: 300)); // closing transition
    expect(find.byType(BranchPicker), findsNothing);
    expect(ctrl.logFilter.value.branch, 'feature/ui/login');
    expect(find.text('Branch: feature/ui/login'), findsOneWidget);
    // The tree opens the folders down to the branch shown in the Log.
    expect(inTree('login'), findsOneWidget);
  });

  testWidgets('reflog panel lists the entries', (tester) async {
    final ctrl = await open(tester);
    await tester.pumpWidget(host(ReflogPanel(controller: ctrl)));
    ctrl.showReflog();
    await settle(tester, find.text('HEAD@{0}'));
    expect(find.text('HEAD@{0}'), findsOneWidget);
    expect(find.text('reset'), findsOneWidget);
    expect(find.text('three'), findsOneWidget);
    expect(find.text('4 entries'), findsOneWidget);
  });

  testWidgets('compare view shows both commits and swaps', (tester) async {
    final ctrl = await open(tester);
    final settings = (await tester.runAsync(() => AppSettings.load(_MemoryStore())))!;
    final commits = ctrl.commits.value;
    await tester.pumpWidget(host(CompareCommitsView(
      controller: ctrl,
      tab: CompareTab(commits[0], commits[1]),
      settings: settings,
    )));
    await settle(tester, find.text('1 file changed'));
    expect(find.text('Swap sides'), findsOneWidget);
    expect(find.text('1 file changed'), findsOneWidget);
    expect(find.text('two.txt'), findsWidgets);
    final left = find.textContaining(commits[1].shortHash);
    expect(tester.getTopLeft(left.first).dx, lessThan(tester.getTopLeft(find.textContaining(commits[0].shortHash).first).dx));
    await tester.tap(find.text('Swap sides'));
    await settle(tester, find.text('never'));
    expect(tester.getTopLeft(left.first).dx, greaterThan(tester.getTopLeft(find.textContaining(commits[0].shortHash).first).dx));
    expect(find.text('1 file changed'), findsOneWidget);
  });
}
