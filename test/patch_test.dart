import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/usecases/patches.dart';
import 'package:path/path.dart' as p;

/// Create Patch / Apply Patch on real temporary repositories.
void main() {
  late Directory tmp;
  late String dir;
  late GitCliRepository repo;
  late CreatePatch create;
  late ApplyPatch apply;

  String git(List<String> args) {
    final r = Process.runSync('git', args, workingDirectory: dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  File file(String name) => File(p.join(dir, name));
  void write(String name, String content) => file(name).writeAsStringSync(content);
  String read(String name) => file(name).readAsStringSync();

  String commit(String msg, String name, String content) {
    write(name, content);
    git(['add', '-A']);
    git(['commit', '-qm', msg]);
    return git(['rev-parse', 'HEAD']);
  }

  List<String> subjects([String rev = 'HEAD']) => git(['log', '--format=%s', rev]).split('\n');

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_patch_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    repo = GitCliRepository(dir);
    create = CreatePatch(repo);
    apply = ApplyPatch(repo);
    commit('init', 'f.txt', 'one\ntwo\nthree\n');
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  test('patch of commits applied with git am on another branch reproduces them', () async {
    git(['branch', 'other']);
    final c1 = commit('first change', 'f.txt', 'one\nTWO\nthree\n');
    final c2 = commit('add g', 'g.txt', 'g\n');
    final commits = (await repo.log()).where((c) => c.hash == c1 || c.hash == c2).toList();
    expect(commits.first.hash, c2); // newest first, as in the log

    final patch = await create.fromCommits(commits);
    final text = String.fromCharCodes(patch);
    expect(text.indexOf('first change'), lessThan(text.indexOf('add g')));

    git(['checkout', '-q', 'other']);
    final preview = await apply.preview(patch);
    expect(preview.mailbox, isTrue);
    expect(preview.subjects, ['first change', 'add g']);
    expect(preview.files.map((f) => f.path), ['f.txt', 'g.txt']);
    expect(preview.files[1].type, ChangeType.added);
    expect(preview.applies, isTrue);

    final r = await apply(patch, asCommits: true);
    expect(r.stopped, isFalse);
    expect(subjects(), ['add g', 'first change', 'init']);
    expect(git(['diff', 'main', 'HEAD']), isEmpty);
  });

  test('plain diff of working tree files applies to the working tree', () async {
    write('f.txt', 'one\ntwo\nthree\nfour\n');
    write('new.txt', 'new\n');
    write('other.txt', 'not in the patch\n');
    final status = await repo.status();
    final patch = await create.fromChanges(
        status, status.changes.where((c) => c.path != 'other.txt').toList());
    final text = String.fromCharCodes(patch);
    expect(text, contains('diff --git a/new.txt b/new.txt'));
    expect(text, isNot(contains('other.txt')));
    // The real index is not touched.
    expect(git(['diff', '--cached', '--name-only']), isEmpty);

    git(['stash', '-u', '-q']);
    final preview = await apply.preview(patch);
    expect(preview.mailbox, isFalse);
    expect(preview.applies, isTrue);
    expect({for (final f in preview.files) f.path: (f.added, f.deleted)}, {'f.txt': (1, 0), 'new.txt': (1, 0)});

    final r = await apply(patch);
    expect(r.conflicts, isEmpty);
    expect(read('f.txt'), 'one\ntwo\nthree\nfour\n');
    expect(read('new.txt'), 'new\n');
    expect(git(['diff', '--cached', '--name-only']), isEmpty);
  });

  test('git am conflict is detected and abort restores the branch', () async {
    git(['branch', 'other']);
    commit('main change', 'f.txt', 'one\nmain\nthree\n');
    final patch = await create.fromCommits((await repo.log(revisions: ['HEAD'], limit: 1)));
    git(['checkout', '-q', 'other']);
    final head = commit('other change', 'f.txt', 'one\nother\nthree\n');

    final preview = await apply.preview(patch);
    expect(preview.conflicts, ['f.txt']);
    final r = await apply(patch, asCommits: true);
    expect(r.stopped, isTrue);
    expect(await repo.repoState(), RepoState.applyingMailbox);
    final progress = (await repo.rebaseProgress())!;
    expect((progress.done, progress.total), (1, 1));
    expect(progress.stoppedSubject, 'main change');
    expect((await repo.status()).conflicts.map((c) => c.path), ['f.txt']);
    await expectLater(apply(patch), throwsA(isA<PatchRejected>()));

    await repo.abortOperation(RepoState.applyingMailbox);
    expect(await repo.repoState(), RepoState.normal);
    expect(git(['rev-parse', 'HEAD']), head);
    expect(read('f.txt'), 'one\nother\nthree\n');
  });

  test('git am skip and continue', () async {
    git(['branch', 'other']);
    commit('conflicting', 'f.txt', 'one\nmain\nthree\n');
    commit('clean', 'h.txt', 'h\n');
    final patch = await create.fromCommits(await repo.log(revisions: ['HEAD'], limit: 2));
    git(['checkout', '-q', 'other']);
    commit('other change', 'f.txt', 'one\nother\nthree\n');

    final base = git(['rev-parse', 'HEAD']);
    expect((await apply(patch, asCommits: true)).stopped, isTrue);
    await repo.skipMailboxPatch();
    expect(await repo.repoState(), RepoState.normal);
    expect(subjects(), ['clean', 'other change', 'init']);

    git(['reset', '-q', '--hard', base]);
    expect((await apply(patch, asCommits: true)).stopped, isTrue);
    await repo.markResolved('f.txt', 'one\nresolved\nthree\n');
    await repo.continueOperation(RepoState.applyingMailbox);
    expect(await repo.repoState(), RepoState.normal);
    expect(subjects(), ['clean', 'conflicting', 'other change', 'init']);
    expect(read('f.txt'), 'one\nresolved\nthree\n');
  });

  test('merge commits are rejected', () async {
    git(['checkout', '-qb', 'side']);
    commit('side', 's.txt', 's\n');
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
    final merge = (await repo.log(revisions: ['HEAD'], limit: 1)).single;
    expect(merge.isMerge, isTrue);
    await expectLater(create.fromCommits([merge]), throwsA(isA<PatchRejected>()));
  });

  test('preview of something that is not a patch fails', () async {
    await expectLater(apply.preview('hello\nworld\n'.codeUnits), throwsA(anything));
  });
}
