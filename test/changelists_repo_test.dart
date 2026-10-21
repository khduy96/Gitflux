import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/file_changelist_repository.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/changelist.dart';
import 'package:git_tools/domain/logic/changelists.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:path/path.dart' as p;

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();

/// Changelists on real temporary repositories, through the controller of
/// the Commit panel.
void main() {
  late Directory tmp;
  late String dir;
  late RepoController ctrl;

  String git(List<String> args, {String? cwd}) {
    final r = Process.runSync('git', args, workingDirectory: cwd ?? dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  void write(String name, String content) =>
      (File(p.join(dir, name))..parent.createSync(recursive: true)).writeAsStringSync(content);
  File jsonFile() => File(p.join(dir, '.git', 'git-tools', 'changelists.json'));
  Changelists saved() => decodeChangelists(jsonFile().readAsStringSync());
  Set<String> included() => ctrl.included.value;

  setUp(() async {
    tmp = Directory.systemTemp.createTempSync('gt_changelists_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false', 'commit.gpgsign': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    for (final n in ['a', 'b', 'c', 'd']) {
      write('$n.txt', '$n\n');
    }
    write('sub/c.txt', 'c\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
    ctrl = RepoController(dir, git: const GitCliService(), commitMessageAi: _noAi);
  });

  tearDown(() async {
    ctrl.dispose();
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

  test('two lists: only the active one is ticked and committed, the other is untouched', () async {
    write('a.txt', 'a2\n');
    await ctrl.refreshStatus();
    expect(saved().byId(defaultChangelistId)!.files, ['a.txt']);

    final feature = (await ctrl.createChangelist('Feature', active: true))!;
    write('b.txt', 'b2\n');
    write('c.txt', 'c2\n');
    await ctrl.refreshStatus();
    // First seen while "Feature" is active.
    expect(saved().byId(feature)!.files, ['b.txt', 'c.txt']);
    expect(included(), {'b.txt', 'c.txt'});

    // Changing the active list does not move the files.
    await ctrl.setActiveChangelist(defaultChangelistId);
    await ctrl.refreshStatus();
    expect(saved().byId(feature)!.files, ['b.txt', 'c.txt']);
    expect(included(), {'a.txt'});

    await ctrl.setActiveChangelist(feature);
    expect(included(), {'b.txt', 'c.txt'});
    ctrl.commitMessage.text = 'Feature commit';
    expect(await ctrl.commit(sign: false), isTrue);
    expect(git(['show', '--name-only', '--format=', 'HEAD']).split('\n'), ['b.txt', 'c.txt']);
    expect(File(p.join(dir, 'a.txt')).readAsStringSync(), 'a2\n');
    expect(git(['status', '--porcelain']), 'M a.txt');
    final after = saved();
    expect(after.byId(feature)!.files, isEmpty);
    expect(after.byId(defaultChangelistId)!.files, ['a.txt']);
    // The draft of the committed list was used.
    expect(after.byId(feature)!.comment, '');
  });

  test('the commit message is saved per list when switching', () async {
    write('a.txt', 'a2\n');
    await ctrl.open();
    final other = (await ctrl.createChangelist('Other'))!;
    ctrl.commitMessage.text = 'message of Changes';
    await ctrl.setActiveChangelist(other);
    expect(ctrl.commitMessage.text, '');
    expect(saved().byId(defaultChangelistId)!.comment, 'message of Changes');
    ctrl.commitMessage.text = 'message of Other';
    await ctrl.setActiveChangelist(defaultChangelistId);
    expect(ctrl.commitMessage.text, 'message of Changes');
    expect(saved().byId(other)!.comment, 'message of Other');
    await ctrl.setActiveChangelist(other);
    expect(ctrl.commitMessage.text, 'message of Other');
  });

  test('move files (keeping ticks), drop an unversioned file into a list, delete a list', () async {
    write('a.txt', 'a2\n');
    write('b.txt', 'b2\n');
    await ctrl.refreshStatus();
    final later = (await ctrl.createChangelist('Later'))!;
    final changes = ctrl.status.value.tracked;
    await ctrl.moveToChangelist(changes.where((c) => c.path == 'b.txt').toList(), later);
    expect(saved().byId(later)!.files, ['b.txt']);
    expect(included(), {'a.txt', 'b.txt'});

    write('new.txt', 'new\n');
    await ctrl.refreshStatus();
    final unversioned = ctrl.status.value.untracked;
    expect(unversioned.map((c) => c.path), ['new.txt']);
    await ctrl.moveToChangelist(unversioned, later);
    expect(git(['status', '--porcelain', 'new.txt']), 'A  new.txt');
    expect(saved().byId(later)!.files, ['b.txt', 'new.txt']);

    // Deleting a list that is not active: its files go to the active list.
    await ctrl.deleteChangelist(later);
    final c = saved();
    expect(c.byId(later), isNull);
    expect(c.byId(defaultChangelistId)!.files, ['a.txt', 'b.txt', 'new.txt']);
    await ctrl.refreshStatus();
    expect(saved().byId(defaultChangelistId)!.files, ['a.txt', 'b.txt', 'new.txt']);
  });

  test('deleting the active list moves its files to the default list, which becomes active', () async {
    write('a.txt', 'a2\n');
    await ctrl.refreshStatus();
    final f = (await ctrl.createChangelist('F', active: true))!;
    write('b.txt', 'b2\n');
    await ctrl.refreshStatus();
    await ctrl.deleteChangelist(f);
    final c = saved();
    expect(c.active, defaultChangelistId);
    expect(c.byId(defaultChangelistId)!.files, ['a.txt', 'b.txt']);
    expect(included(), {'a.txt', 'b.txt'});
  });

  test('a changelists.json written by the VS Code extension is read and kept', () async {
    final fixture = File('test/fixtures/changelists_extension.json').readAsStringSync().replaceAll('\r\n', '\n');
    jsonFile()
      ..parent.createSync(recursive: true)
      ..writeAsStringSync(fixture);
    for (final f in ['a.txt', 'b.txt', 'sub/c.txt']) {
      write(f, 'changed\n');
    }
    await ctrl.open();
    final lists = ctrl.changelists.value;
    expect(lists.activeList.name, 'Feature Y');
    expect(lists.byId(defaultChangelistId)!.files, ['a.txt']);
    expect(lists.activeList.files, ['b.txt', 'sub/c.txt']);
    expect(included(), {'b.txt', 'sub/c.txt'});
    expect(ctrl.commitMessage.text, 'Draft from VS Code\n\nBody line.');
    // Nothing to change: the file is left as written.
    expect(jsonFile().readAsStringSync(), fixture);
    // A change keeps the fields of the extension.
    await ctrl.setActiveChangelist(defaultChangelistId);
    final text = jsonFile().readAsStringSync();
    expect(text, contains('"createdBy": {'));
    expect(text, contains('"lastWriter": "vscode"'));
    expect(decodeChangelists(text).active, defaultChangelistId);
  });

  test('a list shelved as a whole goes back into the list of that name on unshelve', () async {
    write('a.txt', 'a2\n');
    await ctrl.refreshStatus();
    final f = (await ctrl.createChangelist('Feature', active: true))!;
    write('b.txt', 'b2\n');
    write('c.txt', 'c2\n');
    await ctrl.refreshStatus();
    await ctrl.setActiveChangelist(defaultChangelistId);
    final files = ctrl.status.value.tracked.where((c) => saved().byId(f)!.files.contains(c.path)).toList();
    expect(await ctrl.shelveChanges('Feature', files), isTrue);
    expect(saved().byId(f)!.files, isEmpty);
    await ctrl.refreshShelves();
    expect(await ctrl.unshelve(ctrl.shelves.value.single), isTrue);
    expect(saved().byId(f)!.files, ['b.txt', 'c.txt']);
    expect(saved().byId(defaultChangelistId)!.files, ['a.txt']);
  });

  test('the file of another worktree is separate; external edits are re-read before a change', () async {
    final wt = p.join(tmp.path, 'wt');
    git(['worktree', 'add', '-q', wt, '-b', 'other']);
    final repoWt = GitCliRepository(wt);
    final store = FileChangelistRepository(repoWt);
    await store.update((c) => createChangelist(c, id: '20260101-000000-aaaaaa', name: 'In worktree'));
    final path = await repoWt.gitPath('git-tools/changelists.json');
    expect(path.replaceAll(r'\', '/'), endsWith('.git/worktrees/wt/git-tools/changelists.json'));
    expect(jsonFile().existsSync(), isFalse);

    // Another app adds a list between two changes.
    final edited = File(path).readAsStringSync().replaceFirst('"lists": [', '"lists": [\n    {"id": "x", "name": "From VS Code", "files": []},');
    File(path).writeAsStringSync(edited);
    final c = await store.update((c) => editChangelist(c, defaultChangelistId, comment: 'draft'));
    expect(c.lists.map((l) => l.name), ['From VS Code', 'Changes', 'In worktree']);
    expect(Directory(p.dirname(path)).listSync().map((e) => p.basename(e.path)), ['changelists.json']);
  });
}
