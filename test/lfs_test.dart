import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/logic/lfs_parser.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/repositories/settings_store.dart';
import 'package:git_tools/presentation/state/app_settings.dart';
import 'package:git_tools/presentation/state/lfs_state.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/commit/lfs_widgets.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/diff/diff_view.dart';
import 'package:path/path.dart' as p;

/// Git LFS on real temporary repositories (skipped when git-lfs is not
/// installed). Only the local config of the temporary repository is changed.
void main() {
  final lfsInstalled = Process.runSync('git', ['lfs', 'version']).exitCode == 0;
  final skip = lfsInstalled ? null : 'git-lfs is not installed';

  late Directory tmp;
  late String dir;
  late GitCliRepository repo;

  String git(List<String> args) {
    final r = Process.runSync('git', args, workingDirectory: dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  File file(String name) => File(p.join(dir, name));

  final binary = [0, 1, 2, 3, 255, 0, 42, 7, 0, 9, 10, 13, 0];

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_lfs_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    repo = GitCliRepository(dir);
    file('x.bin').writeAsBytesSync(binary);
    file('t.txt').writeAsStringSync('text\n');
  });

  tearDown(() {
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {}
  });

  test('git-lfs is detected', () async {
    expect(await repo.lfsAvailable(), isTrue);
  }, skip: skip);

  test('track *.bin, commit a binary as a pointer, read the object back, untrack', () async {
    await repo.lfsTrack(['*.bin']);
    expect(file('.gitattributes').readAsStringSync(), contains('*.bin filter=lfs'));
    // The filters exist (installed in the local config when git had none).
    expect(git(['config', 'filter.lfs.clean']), isNotEmpty);

    final patterns = await repo.lfsTrackPatterns();
    expect(patterns.map((pt) => pt.pattern), contains('*.bin'));
    expect(patterns.firstWhere((pt) => pt.pattern == '*.bin').source, '.gitattributes');

    // Badge detection.
    expect(await repo.lfsFilteredPaths(['x.bin', 't.txt', '.gitattributes', 'sub/new.bin']), {'x.bin', 'sub/new.bin'});
    expect(await repo.lfsFilteredPaths(const []), isEmpty);

    await repo.commit(message: 'add binary', paths: ['.gitattributes', 'x.bin', 't.txt']);
    expect(git(['show', 'HEAD:x.bin']), startsWith('version https://git-lfs'));
    expect(git(['show', 'HEAD:t.txt']), 'text');

    final pointer = parseLfsPointer(await repo.fileBytes(const CommitRev('HEAD'), 'x.bin'))!;
    expect(pointer.size, binary.length);
    // The clean filter stored the object locally.
    expect(await repo.lfsObject(pointer), binary);
    expect(await repo.lfsPointerOfFile('x.bin'), pointer);
    expect(await repo.lfsPointerOfFile('missing.bin'), isNull);

    final files = await repo.lfsFiles();
    expect(files.map((f) => f.path), ['x.bin']);
    expect(files.single.oid, pointer.oid);
    expect(files.single.downloaded, isTrue);

    // A changed working tree file: new pointer, object not stored yet.
    file('x.bin').writeAsBytesSync([...binary, 1]);
    final changed = (await repo.lfsPointerOfFile('x.bin'))!;
    expect(changed.size, binary.length + 1);
    expect(changed.oid, isNot(pointer.oid));
    expect(await repo.lfsObject(changed), isNull);

    await repo.lfsUntrack(['*.bin']);
    expect(file('.gitattributes').readAsStringSync(), isNot(contains('*.bin')));
    expect(await repo.lfsFilteredPaths(['x.bin']), isEmpty);
    expect((await repo.status()).changes.map((c) => c.path), contains('.gitattributes'));
  }, skip: skip);

  test('exact path with glob characters and spaces is escaped', () async {
    file('a [1].psd').writeAsBytesSync(binary);
    await repo.lfsTrack(['a [1].psd'], literal: true);
    final pt = (await repo.lfsTrackPatterns()).single;
    expect(lfsPatternMatches(pt, 'a [1].psd'), isTrue);
    expect(lfsPatternMatches(pt, 'a 1.psd'), isFalse);
    expect(await repo.lfsFilteredPaths(['a [1].psd', 'a 1.psd']), {'a [1].psd'});
    await repo.lfsUntrack([pt.pattern]);
    expect(await repo.lfsTrackPatterns(), isEmpty);
  }, skip: skip);

  test('locks fail without a remote; prune preview works', () async {
    await expectLater(repo.lfsLocks(), throwsA(isA<GitException>()));
    await repo.lfsTrack(['*.bin']);
    await repo.commit(message: 'add', paths: ['.gitattributes', 'x.bin']);
    // Nothing was pushed: every object is kept.
    expect((await repo.lfsPruneDryRun()).objects, isEmpty);
  }, skip: skip);

  test('LfsState marks the changed files stored in LFS and hides locks', () async {
    await repo.lfsTrack(['*.bin']);
    final errors = <String>[];
    final state = LfsState(repo, onError: errors.add);
    final tracked = Completer<void>();
    state.tracked.addListener(() {
      if (!tracked.isCompleted) tracked.complete();
    });
    state.refresh(await repo.status());
    await tracked.future.timeout(const Duration(seconds: 30));
    expect(state.available.value, isTrue);
    expect(state.tracked.value, {'x.bin'});
    expect(state.isTracked('t.txt'), isFalse);
    // The lock request runs after the badges; without a remote it fails.
    await state.refreshLocks();
    expect(state.locksSupported.value, isFalse);
    expect(state.locks.value, isEmpty);
    expect(errors, isEmpty);
  }, skip: skip);

  testWidgets('diff of an LFS file shows the pointers and switches to the content; menu items', (tester) async {
    tester.view.physicalSize = const Size(1400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final ctrl = RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi);
    addTearDown(ctrl.dispose);
    final settings = (await tester.runAsync(() => AppSettings.load(_MemoryStore())))!;
    await tester.runAsync(() async {
      await repo.lfsTrack(['*.bin']);
      file('a.txt').writeAsStringSync('a\n');
      await repo.commit(message: 'add', paths: ['.gitattributes', 'x.bin', 't.txt']);
      file('x.bin').writeAsBytesSync([...binary, 5]);
      file('new.bin').writeAsBytesSync(binary);
      await ctrl.refreshStatus();
      // The LFS state is refreshed in the background after the status.
      for (var i = 0; i < 200 && !ctrl.lfs.isTracked('x.bin'); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    });
    expect(ctrl.lfs.tracked.value, {'x.bin', 'new.bin'});

    final x = ctrl.status.value.changes.firstWhere((c) => c.path == 'x.bin');
    final a = ctrl.status.value.changes.firstWhere((c) => c.path == 'a.txt');
    final added = ctrl.status.value.changes.firstWhere((c) => c.path == 'new.bin');
    List<String?> ids(List<PopupMenuEntry<String>> items) =>
        [for (final i in items) if (i is PopupMenuItem<String>) i.value];
    expect(ids(lfsMenuItems(ctrl, [a])), ['lfs:track']);
    expect(ids(lfsMenuItems(ctrl, [added])), ['lfs:untrack']);
    // Without a remote locking is not offered.
    expect(ids(lfsMenuItems(ctrl, [x])), ['lfs:untrack']);
    expect(lfsFileTooltip(ctrl, x), 'Stored in Git LFS');
    expect(lfsFileTooltip(ctrl, a), isNull);

    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(),
      home: Scaffold(body: DiffView(controller: ctrl, request: ctrl.localDiffRequest(x), settings: settings)),
    ));
    for (var i = 0; i < 200 && find.text('Show Pointers').evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump(const Duration(milliseconds: 10));
    }
    // Both contents are local: the binary contents are compared.
    expect(find.text('Show Pointers'), findsOneWidget);
    expect(find.textContaining('Binary files differ'), findsOneWidget);
    expect(find.textContaining('oid '), findsOneWidget);

    await tester.tap(find.text('Show Pointers'));
    for (var i = 0; i < 100 && find.text('Show Content').evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(find.text('Show Content'), findsOneWidget);
    expect(find.textContaining('size ${binary.length}'), findsWidgets);
    expect(find.textContaining('size ${binary.length + 1}'), findsWidgets);
  }, skip: !lfsInstalled);
}

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
