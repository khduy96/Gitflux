import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/dialogs/shelve_dialogs.dart';
import 'package:git_tools/presentation/ui/shelf/shelf_panel.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

/// The Shelf tab and the Shelve / Unshelve dialogs on a real repository.
void main() {
  late Directory tmp;
  late String dir;

  String git(List<String> args) {
    final r = Process.runSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@t', ...args], workingDirectory: dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  void write(String name, String content) => File(p.join(dir, name)).writeAsStringSync(content);

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_shelf_ui_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'core.autocrlf', 'false']);
    write('a.txt', 'a\n');
    write('b.txt', 'b\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
    write('a.txt', 'changed a\n');
    write('b.txt', 'changed b\n');
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

  /// Waits for the operation started by the UI and the refresh after it
  /// (busy is cleared before the refresh).
  Future<void> idle(WidgetTester tester, RepoController ctrl, bool Function() done) async {
    for (var i = 0; i < 300 && (ctrl.busy.value != null || !done()); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump(const Duration(milliseconds: 10));
    }
  }

  Future<RepoController> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final ctrl = RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi);
    await tester.runAsync(ctrl.refreshAll);
    addTearDown(ctrl.dispose);
    return ctrl;
  }

  Widget host(Widget child) => MaterialApp(theme: buildTheme(), home: Scaffold(body: child));

  testWidgets('shelve dialog shelves the checked files and the Shelf tab lists them', (tester) async {
    final ctrl = await open(tester);
    ctrl.commitMessage.text = 'Login form\n\ndetails';
    final a = ctrl.status.value.changes.firstWhere((c) => c.path == 'a.txt');
    await tester.pumpWidget(host(Column(children: [
      Builder(
        builder: (context) => TextButton(
          onPressed: () => showShelveDialog(context, ctrl, [a]),
          child: const Text('open'),
        ),
      ),
      Expanded(child: ShelfPanel(controller: ctrl)),
    ])));
    expect(find.text('No shelved changes'), findsOneWidget);

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Keep changes in working tree'), findsOneWidget);
    expect(find.text('Login form'), findsOneWidget);
    expect(find.text('1 of 2 files selected'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Shelve Changes'));
    await tester.pump();
    await idle(tester, ctrl, () => ctrl.shelves.value.isNotEmpty);
    await settle(tester, find.text('Login form'));

    expect(File(p.join(dir, 'a.txt')).readAsStringSync(), 'a\n');
    expect(File(p.join(dir, 'b.txt')).readAsStringSync(), 'changed b\n');
    expect(ctrl.shelves.value.single.files.single.path, 'a.txt');
    expect(find.text('Login form'), findsOneWidget);
    expect(find.text('1 file'), findsOneWidget);
    expect(find.text('main'), findsOneWidget);
    expect(find.text('just now'), findsOneWidget);

    // Expand the shelf, then click its file: base ↔ shelved diff.
    await tester.tap(find.text('Login form'));
    await tester.pump();
    expect(find.text('a.txt'), findsOneWidget);
    await tester.tap(find.text('a.txt'));
    await settle(tester, find.text('never'));
    final tab = ctrl.tabs.value.single as DiffTab;
    expect(tab.request.left, isA<CommitRev>());
    expect(tab.request.right, isA<PatchedRev>());
    expect(tab.request.rightTitle, 'Shelved: Login form');
  });

  testWidgets('unshelve dialog applies the shelf', (tester) async {
    final ctrl = await open(tester);
    final changes = ctrl.status.value.changes;
    await tester.runAsync(() => ctrl.shelveChanges('both', changes));
    final shelf = ctrl.shelves.value.single;
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(
        onPressed: () => showUnshelveDialog(context, ctrl, shelf),
        child: const Text('open'),
      ),
    )));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Remove successfully applied files from shelf'), findsOneWidget);
    expect(find.text('2 of 2 files selected'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Unshelve'));
    await tester.pump();
    await idle(tester, ctrl, () => ctrl.shelves.value.isEmpty);
    expect(File(p.join(dir, 'a.txt')).readAsStringSync(), 'changed a\n');
    expect(File(p.join(dir, 'b.txt')).readAsStringSync(), 'changed b\n');
    expect(ctrl.shelves.value, isEmpty);
  });
}
