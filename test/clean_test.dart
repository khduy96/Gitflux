import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/clean.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/logic/clean_parser.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/usecases/clean_working_tree.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/dialogs/clean_dialog.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

void main() {
  group('parseCleanDryRun', () {
    test('plain lines, directories keep the trailing slash', () {
      expect(parseCleanDryRun('Would remove a.txt\nWould remove build/\nWould remove sp ace.txt\n'),
          ['a.txt', 'build/', 'sp ace.txt']);
    });

    test('skipped repositories, CRLF and noise', () {
      expect(parseCleanDryRun('Would skip repository nested/\r\nwarning: x\r\n\r\nWould remove b\r\n'),
          ['nested/', 'b']);
    });

    test('C-quoted paths are unquoted', () {
      expect(parseCleanDryRun(r'Would remove "\303\251t\303\251.txt"'), ['été.txt']);
      expect(parseCleanDryRun(r'Would remove "dir \"q\"/"'), ['dir "q"/']);
      expect(parseCleanDryRun(r'Would remove "tab\there"'), ['tab\there']);
    });

    test('empty output', () => expect(parseCleanDryRun(''), isEmpty));
  });

  group('buildCleanEntries', () {
    test('nested repositories are the entries only listed with -ff', () {
      final e = buildCleanEntries(plain: ['b.txt', 'dir/'], forced: ['b.txt', 'dir/', 'nested/']);
      expect(e, const [
        CleanEntry(path: 'b.txt'),
        CleanEntry(path: 'dir', isDirectory: true),
        CleanEntry(path: 'nested', isDirectory: true, nestedRepo: true),
      ]);
      expect(e[1].pathspec, 'dir/');
    });

    test('ignored entries are the ones missing without -x', () {
      final e = buildCleanEntries(
        plain: ['a.log', 'u.txt'],
        forced: ['a.log', 'n/', 'u.txt'],
        notIgnored: ['n/', 'u.txt'],
      );
      expect(e.firstWhere((x) => x.path == 'a.log').ignored, isTrue);
      expect(e.firstWhere((x) => x.path == 'u.txt').ignored, isFalse);
      final n = e.firstWhere((x) => x.path == 'n');
      expect(n.nestedRepo, isTrue);
      expect(n.ignored, isFalse);
    });

    test('nothing is ignored without notIgnored', () {
      expect(buildCleanEntries(plain: ['x'], forced: ['x']).single.ignored, isFalse);
    });

    test('sorted by path, case-insensitive', () {
      final e = buildCleanEntries(plain: ['b', 'A', 'c/d.txt'], forced: ['b', 'A', 'c/d.txt']);
      expect(e.map((x) => x.path), ['A', 'b', 'c/d.txt']);
      expect(e[2].fileName, 'd.txt');
      expect(e[2].directory, 'c');
    });
  });

  group('chunkArgs', () {
    test('splits under the limit and keeps order', () {
      final args = [for (var i = 0; i < 10; i++) 'a$i'];
      final chunks = chunkArgs(args, maxChars: 12);
      expect(chunks.expand((c) => c), args);
      expect(chunks.length, greaterThan(1));
      for (final c in chunks) {
        expect(c.fold<int>(0, (n, a) => n + a.length + 3), lessThanOrEqualTo(12));
      }
    });

    test('a single huge argument goes alone', () {
      final huge = 'x' * 100;
      expect(chunkArgs(['a', huge, 'b'], maxChars: 20), [
        ['a'],
        [huge],
        ['b'],
      ]);
    });

    test('everything in one chunk when small, nothing when empty', () {
      expect(chunkArgs(['a', 'b']), [
        ['a', 'b'],
      ]);
      expect(chunkArgs([]), isEmpty);
    });
  });

  group('on a repository', () {
    late Directory tmp;
    late String dir;
    late CleanWorkingTree clean;

    String git(String cwd, List<String> args) {
      final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], workingDirectory: cwd);
      if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
      return (r.stdout as String).trim();
    }

    String path(String name) => p.join(dir, name);
    void write(String name, String content) =>
        (File(path(name))..parent.createSync(recursive: true)).writeAsStringSync(content);
    bool exists(String name) => FileSystemEntity.typeSync(path(name)) != FileSystemEntityType.notFound;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('gt_clean_');
      dir = p.join(tmp.path, 'repo');
      Directory(dir).createSync();
      git(dir, ['init', '-q', '-b', 'main']);
      for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
        git(dir, ['config', kv.key, kv.value]);
      }
      write('.gitignore', '*.log\n');
      write('tracked.txt', 'v1\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'init']);
      write('tracked.txt', 'v2\n');
      write('u.txt', 'u\n');
      write('sp ace.txt', 's\n');
      write('build/out.txt', 'o\n');
      write('app.log', 'l\n');
      clean = CleanWorkingTree(GitCliRepository(dir));
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

    void nestedRepo() {
      write('nested/n.txt', 'n\n');
      final n = path('nested');
      git(n, ['init', '-q', '-b', 'main']);
      git(n, ['add', '-A']);
      git(n, ['commit', '-qm', 'nested']);
    }

    test('preview with -d lists untracked files and directories only', () async {
      final e = await clean.preview(const CleanOptions());
      expect(e, const [
        CleanEntry(path: 'build', isDirectory: true),
        CleanEntry(path: 'sp ace.txt'),
        CleanEntry(path: 'u.txt'),
      ]);
    });

    test('preview with -x lists ignored files marked ignored', () async {
      final e = await clean.preview(const CleanOptions(includeIgnored: true));
      expect(e, const [
        CleanEntry(path: 'app.log', ignored: true),
        CleanEntry(path: 'build', isDirectory: true),
        CleanEntry(path: 'sp ace.txt'),
        CleanEntry(path: 'u.txt'),
      ]);
    });

    test('preview without -d has no directory entry', () async {
      final e = await clean.preview(const CleanOptions(directories: false));
      expect(e.where((x) => x.isDirectory), isEmpty);
      expect(e.where((x) => x.path.startsWith('build')), isEmpty);
      expect(e.map((x) => x.path), ['sp ace.txt', 'u.txt']);
    });

    test('only the checked entries are removed, tracked files untouched', () async {
      const options = CleanOptions();
      final e = await clean.preview(options);
      final n = await clean([for (final x in e) if (x.path != 'u.txt') x], options);
      expect(n, 2);
      expect(exists('u.txt'), isTrue);
      expect(exists('sp ace.txt'), isFalse);
      expect(exists('build'), isFalse);
      expect(exists('app.log'), isTrue);
      expect(File(path('tracked.txt')).readAsStringSync(), 'v2\n');
      expect(git(dir, ['status', '--porcelain']).split('\n'), ['M tracked.txt', '?? u.txt']);
      expect((await clean.preview(options)).map((x) => x.path), ['u.txt']);
    });

    test('a path with spaces is removed alone', () async {
      const options = CleanOptions();
      final e = await clean.preview(options);
      await clean([e.firstWhere((x) => x.path == 'sp ace.txt')], options);
      expect(exists('sp ace.txt'), isFalse);
      expect(exists('u.txt'), isTrue);
      expect(exists('build/out.txt'), isTrue);
    });

    test('-x removes a checked ignored file', () async {
      const options = CleanOptions(includeIgnored: true);
      final e = await clean.preview(options);
      await clean([e.firstWhere((x) => x.ignored)], options);
      expect(exists('app.log'), isFalse);
      expect(exists('u.txt'), isTrue);
      expect(exists('.gitignore'), isTrue);
    });

    test('nested repositories are listed and only removed when checked', () async {
      nestedRepo();
      const options = CleanOptions();
      var e = await clean.preview(options);
      expect(e.firstWhere((x) => x.path == 'nested'),
          const CleanEntry(path: 'nested', isDirectory: true, nestedRepo: true));
      expect(e.where((x) => x.nestedRepo), hasLength(1));

      await clean([for (final x in e) if (!x.nestedRepo) x], options);
      expect(exists('nested/n.txt'), isTrue);
      expect(exists('nested/.git'), isTrue);
      expect(exists('u.txt'), isFalse);

      e = await clean.preview(options);
      expect(e, const [CleanEntry(path: 'nested', isDirectory: true, nestedRepo: true)]);
      await clean(e, options);
      expect(exists('nested'), isFalse);
      expect(await clean.preview(options), isEmpty);
    });

    test('nothing selected is rejected', () async {
      expect(() => clean([], const CleanOptions()), throwsA(isA<CleanRejected>()));
    });
  });

  group('dialog', () {
    late Directory tmp;
    late String dir;

    String git(String cwd, List<String> args) {
      final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], workingDirectory: cwd);
      if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
      return (r.stdout as String).trim();
    }

    void write(String name, String content) =>
        (File(p.join(dir, name))..parent.createSync(recursive: true)).writeAsStringSync(content);
    bool exists(String name) => FileSystemEntity.typeSync(p.join(dir, name)) != FileSystemEntityType.notFound;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('gt_clean_ui_');
      dir = p.join(tmp.path, 'repo');
      Directory(dir).createSync();
      git(dir, ['init', '-q', '-b', 'main']);
      git(dir, ['config', 'core.autocrlf', 'false']);
      write('.gitignore', '*.log\n');
      write('tracked.txt', 't\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'init']);
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

    Future<void> settle(WidgetTester tester, Finder found) async {
      for (var i = 0; i < 200 && found.evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 10));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }
      await tester.pump();
    }

    Future<RepoController> open(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1400, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final ctrl = RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi);
      await tester.runAsync(ctrl.refreshAll);
      addTearDown(ctrl.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(),
        home: Scaffold(
          body: Builder(
            builder: (context) =>
                TextButton(onPressed: () => showCleanDialog(context, ctrl), child: const Text('open')),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pump();
      return ctrl;
    }

    FilledButton cleanButton(WidgetTester tester) =>
        tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Clean…'));

    testWidgets('empty preview disables Clean', (tester) async {
      await open(tester);
      await settle(tester, find.text('Nothing to clean'));
      expect(find.text('Nothing to clean'), findsOneWidget);
      expect(cleanButton(tester).onPressed, isNull);
    });

    testWidgets('lists entries, warns for nested repositories and cleans the checked ones', (tester) async {
      write('u.txt', 'u\n');
      write('build/out.txt', 'o\n');
      write('app.log', 'l\n');
      write('nested/n.txt', 'n\n');
      final n = p.join(dir, 'nested');
      git(n, ['init', '-q', '-b', 'main']);
      git(n, ['add', '-A']);
      git(n, ['commit', '-qm', 'nested']);
      final ctrl = await open(tester);

      await settle(tester, find.text('u.txt'));
      expect(find.text('build/'), findsOneWidget);
      expect(find.text('nested/'), findsOneWidget);
      expect(find.text('nested repository'), findsOneWidget);
      expect(find.text('app.log'), findsNothing);
      expect(find.text('2 of 3 items selected'), findsOneWidget);
      expect(find.textContaining('whole history'), findsNothing);

      // Checking the nested repository shows the warning.
      await tester.tap(find.text('nested/'));
      await tester.pump();
      expect(find.text('3 of 3 items selected'), findsOneWidget);
      expect(find.textContaining('whole history'), findsOneWidget);
      await tester.tap(find.text('nested/'));
      await tester.pump();

      // -x recomputes the preview with the ignored file.
      await tester.tap(find.text('Include ignored files'));
      await tester.pump();
      await settle(tester, find.text('app.log'));
      expect(find.text('ignored'), findsOneWidget);
      expect(find.text('3 of 4 items selected'), findsOneWidget);

      // Keep u.txt.
      await tester.tap(find.text('u.txt'));
      await tester.pump();
      expect(find.text('2 of 4 items selected'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Clean…'));
      await tester.pumpAndSettle();
      expect(find.text('Delete 2 untracked items? This cannot be undone.'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pump();
      for (var i = 0; i < 300 && (exists('app.log') || ctrl.busy.value != null); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump(const Duration(milliseconds: 10));
      }
      await tester.pumpAndSettle();

      expect(exists('app.log'), isFalse);
      expect(exists('build'), isFalse);
      expect(exists('u.txt'), isTrue);
      expect(exists('nested/n.txt'), isTrue);
      expect(exists('tracked.txt'), isTrue);
      expect(find.text('Clean Working Tree'), findsNothing);
    });
  });
}
