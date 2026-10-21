import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/changelist.dart';
import 'package:git_tools/domain/logic/changelists.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/repositories/settings_store.dart';
import 'package:git_tools/presentation/state/app_settings.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/commit/commit_panel.dart';
import 'package:git_tools/presentation/ui/common.dart';
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

/// Dragging a whole group header of the Commit panel onto a changelist.
void main() {
  late Directory tmp;
  late String dir;

  String git(List<String> args) {
    final r = Process.runSync('git', args, workingDirectory: dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  void write(String name, String content) =>
      (File(p.join(dir, name))..parent.createSync(recursive: true)).writeAsStringSync(content);

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_commit_drag_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false', 'commit.gpgsign': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    write('a.txt', 'a\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
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

  /// Lets the git processes run (real time) until [done].
  Future<void> settleUntil(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await tester.pump(const Duration(milliseconds: 10));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    }
    await tester.pump();
  }

  /// Drags the row showing [from] onto the row showing [to].
  Future<void> drag(WidgetTester tester, String from, String to) async {
    final g = await tester.startGesture(tester.getCenter(find.text(from)));
    for (var i = 1; i <= 10; i++) {
      await g.moveTo(Offset.lerp(tester.getCenter(find.text(from)), tester.getCenter(find.text(to)), i / 10)!);
      await tester.pump();
    }
    await g.up();
    await tester.pump();
  }

  testWidgets('"Unversioned Files" dropped on a changelist adds all its files to it', (tester) async {
    tester.view.physicalSize = const Size(900, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    write('a.txt', 'a2\n');
    write('b.txt', 'b\n');
    git(['add', 'b.txt']);
    write('new1.txt', 'n1\n');
    write('sub/new2.txt', 'n2\n');
    // Built in real time: futures it creates (the changelist write queue) would
    // otherwise belong to the fake clock of the test and never complete.
    final ctrl = (await tester.runAsync(() async => RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi)))!;
    addTearDown(ctrl.dispose);
    final settings = (await tester.runAsync(() => AppSettings.load(_MemoryStore())))!;
    await tester.runAsync(ctrl.refreshStatus);
    final later = (await tester.runAsync(() => ctrl.createChangelist('Later')))!;
    // Empty lists are hidden: give "Later" a file.
    await tester.runAsync(() => ctrl.moveToChangelist(ctrl.status.value.tracked.where((c) => c.path == 'b.txt').toList(), later));

    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(),
      home: Scaffold(body: CommitPanel(controller: ctrl, settings: settings)),
    ));
    await settleUntil(tester, () => find.text('Unversioned Files').evaluate().isNotEmpty);
    expect(find.text('Unversioned Files'), findsOneWidget);
    expect(find.text('Later'), findsOneWidget);

    await drag(tester, 'Unversioned Files', 'Later');
    await settleUntil(tester, () => ctrl.status.value.untracked.isEmpty);

    expect(ctrl.status.value.untracked, isEmpty);
    expect(git(['status', '--porcelain', '--', 'new1.txt', 'sub/new2.txt']).split('\n'), ['A  new1.txt', 'A  sub/new2.txt']);
    final lists = decodeChangelists(File(p.join(dir, '.git', 'git-tools', 'changelists.json')).readAsStringSync());
    expect(lists.byId(later)!.files, unorderedEquals(['b.txt', 'new1.txt', 'sub/new2.txt']));
    expect(lists.byId(defaultChangelistId)!.files, ['a.txt'], reason: 'the tracked change stays where it was');
    expect(find.text('Unversioned Files'), findsNothing);
  });

  testWidgets('a changelist header dropped on another list moves all its files', (tester) async {
    tester.view.physicalSize = const Size(900, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    write('a.txt', 'a2\n');
    write('b.txt', 'b\n');
    git(['add', 'b.txt']);
    // Built in real time: futures it creates (the changelist write queue) would
    // otherwise belong to the fake clock of the test and never complete.
    final ctrl = (await tester.runAsync(() async => RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi)))!;
    addTearDown(ctrl.dispose);
    final settings = (await tester.runAsync(() => AppSettings.load(_MemoryStore())))!;
    await tester.runAsync(ctrl.refreshStatus);
    final later = (await tester.runAsync(() => ctrl.createChangelist('Later')))!;
    await tester.runAsync(() => ctrl.moveToChangelist(ctrl.status.value.tracked.where((c) => c.path == 'b.txt').toList(), later));

    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(),
      home: Scaffold(body: CommitPanel(controller: ctrl, settings: settings)),
    ));
    await settleUntil(tester, () => find.text('Later').evaluate().isNotEmpty);
    final changes = ctrl.changelists.value.byId(defaultChangelistId)!.name;
    expect(find.text(changes), findsOneWidget);

    await drag(tester, changes, 'Later');
    File jsonFile() => File(p.join(dir, '.git', 'git-tools', 'changelists.json'));
    await settleUntil(tester, () => decodeChangelists(jsonFile().readAsStringSync()).byId(later)!.files.length == 2);
    final lists = decodeChangelists(jsonFile().readAsStringSync());
    expect(lists.byId(later)!.files, unorderedEquals(['a.txt', 'b.txt']));
    expect(lists.byId(defaultChangelistId)!.files, isEmpty);
  });
}
