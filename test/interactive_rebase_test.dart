import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/rebase.dart';
import 'package:git_tools/domain/logic/rebase_todo.dart';
import 'package:git_tools/domain/usecases/interactive_rebase.dart';
import 'package:path/path.dart' as p;

/// Interactive rebase engine on real temporary repositories.
void main() {
  late Directory tmp;
  late String dir;
  late GitCliRepository repo;
  late InteractiveRebase rebase;

  String git(List<String> args, {bool allowFailure = false}) {
    final r = Process.runSync('git', args, workingDirectory: dir);
    if (r.exitCode != 0 && !allowFailure) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  void write(String file, String content) => File(p.join(dir, file)).writeAsStringSync(content);
  String read(String file) => File(p.join(dir, file)).readAsStringSync();

  /// Commits [file] with [content] and returns the commit id.
  String commit(String msg, {String? file, String? content}) {
    write(file ?? '$msg.txt', content ?? '$msg\n');
    git(['add', '-A']);
    git(['commit', '-qm', msg]);
    return git(['rev-parse', 'HEAD']);
  }

  List<String> subjects([String rev = 'HEAD']) => git(['log', '--format=%s', rev]).split('\n');
  String stateDir() => p.join(dir, '.git', 'git-tools-rebase');

  /// Everything a preview must leave untouched.
  Map<String, Object> snapshot() => {
        'head': git(['rev-parse', 'HEAD']),
        'branch': git(['symbolic-ref', 'HEAD']),
        'status': git(['--no-optional-locks', 'status', '--porcelain=v1', '-uall']),
        'index': File(p.join(dir, '.git', 'index')).readAsBytesSync(),
        'stash': git(['stash', 'list']),
        'reflog': git(['reflog', '-n', '5']),
        'files': {
          for (final f in Directory(dir).listSync(recursive: true).whereType<File>())
            if (!p.split(p.relative(f.path, from: dir)).contains('.git'))
              p.relative(f.path, from: dir): f.readAsStringSync(),
        },
      };

  Future<RebaseOutcome> run(RebasePlan plan, List<RebaseEntry> Function(List<RebaseEntry>) edit) =>
      rebase.start(plan, edit(plan.entries));

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_rebase_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    repo = GitCliRepository(dir);
    rebase = InteractiveRebase(repo);
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  group('preview', () {
    test('leaves a clean repository untouched', () async {
      commit('c1');
      final c2 = commit('c2');
      commit('c3');
      final before = snapshot();
      final plan = await rebase.prepare(c2);
      expect(snapshot(), before);
      expect(Directory(stateDir()).existsSync(), isFalse);
      expect(plan.base, '$c2^');
      expect(plan.rebaseMerges, isFalse);
      expect(plan.commits.map((c) => c.subject), ['c2', 'c3']);
      expect(plan.commits.map((c) => c.action), everyElement(RebaseAction.pick));
      expect(plan.commits.first.hash, c2);
      expect(plan.commits.first.message, 'c2');
    });

    test('leaves staged, unstaged, deleted and untracked changes untouched', () async {
      final c1 = commit('c1');
      commit('c2');
      commit('c3');
      write('c1.txt', 'staged\n');
      git(['add', 'c1.txt']);
      write('c1.txt', 'staged + unstaged\n');
      write('c2.txt', 'unstaged\n');
      File(p.join(dir, 'c3.txt')).deleteSync();
      write('new.txt', 'added\n');
      git(['add', 'new.txt']);
      write('untracked.txt', 'untracked\n');
      final before = snapshot();
      expect(before['status'] as String, contains('MM c1.txt'));
      final plan = await rebase.prepare(c1);
      expect(snapshot(), before);
      expect(Directory(stateDir()).existsSync(), isFalse);
      expect(plan.base, isNull);
      expect(plan.commits.map((c) => c.subject), ['c1', 'c2', 'c3']);
    });

    test('counts commits already on the upstream', () async {
      commit('c1');
      final c2 = commit('c2');
      final remote = p.join(tmp.path, 'remote.git');
      Process.runSync('git', ['init', '-q', '--bare', remote]);
      git(['remote', 'add', 'origin', remote]);
      git(['push', '-q', '-u', 'origin', 'main']);
      commit('c3');
      final plan = await rebase.prepare(c2);
      expect(plan.pushedCount, 1);
      expect(plan.upstream, 'origin/main');
      expect((await rebase.prepare(git(['rev-parse', 'HEAD']))).pushedCount, 0);
    });

    test('rejects a commit that is not an ancestor of HEAD', () async {
      commit('c1');
      git(['checkout', '-qb', 'other']);
      final o = commit('o1');
      git(['checkout', '-q', 'main']);
      commit('c2');
      await expectLater(rebase.prepare(o), throwsA(isA<Exception>()));
    });
  });

  group('run', () {
    test('reorder', () async {
      final c1 = commit('c1');
      commit('c2');
      commit('c3');
      final plan = await rebase.prepare(c1);
      final out = await run(plan, (e) => moveCommit(e, plan.commits[1].hash, 1));
      expect(out.stopped, isFalse);
      expect(subjects(), ['c2', 'c3', 'c1']);
      expect(git(['rev-parse', 'HEAD']), isNot(plan.head));
      expect(await repo.repoState(), RepoState.normal);
      expect(Directory(stateDir()).existsSync(), isFalse);
    });

    test('squash with a new message', () async {
      final c1 = commit('c1');
      commit('c2');
      commit('c3');
      commit('c4');
      final plan = await rebase.prepare(c1);
      final hashes = plan.commits.sublist(1, 3).map((c) => c.hash);
      final out = await run(plan, (e) => squashCommits(e, hashes, 'c2 + c3\n\nsquashed'));
      expect(out.stopped, isFalse);
      expect(subjects(), ['c4', 'c2 + c3', 'c1']);
      expect(git(['log', '-1', '--format=%B', 'HEAD~1']), 'c2 + c3\n\nsquashed');
      expect(git(['show', '--name-only', '--format=', 'HEAD~1']).split('\n'), ['c2.txt', 'c3.txt']);
    });

    test('fixup-only group keeps the first message', () async {
      final c1 = commit('c1');
      commit('c2');
      commit('c3');
      final plan = await rebase.prepare(c1);
      var entries = fixupCommit(plan.entries, plan.commits[1].hash);
      entries = fixupCommit(entries, plan.commits[2].hash);
      final out = await rebase.start(plan, entries);
      expect(out.stopped, isFalse);
      expect(subjects(), ['c1']);
      expect(git(['ls-tree', '--name-only', 'HEAD']).split('\n'), ['c1.txt', 'c2.txt', 'c3.txt']);
    });

    test('reword an older commit', () async {
      commit('c1');
      final c2 = commit('c2');
      commit('c3');
      final plan = await rebase.prepare(c2);
      await run(plan, (e) => rewordCommit(e, c2, 'c2 reworded\n\nwith body'));
      expect(subjects(), ['c3', 'c2 reworded', 'c1']);
      expect(git(['log', '-1', '--format=%B', 'HEAD~1']), 'c2 reworded\n\nwith body');
    });

    test('drop several commits', () async {
      final c1 = commit('c1');
      final c2 = commit('c2');
      commit('c3');
      final c4 = commit('c4');
      final plan = await rebase.prepare(c1);
      await run(plan, (e) => dropCommits(e, [c2, c4]));
      expect(subjects(), ['c3', 'c1']);
    });

    test('edit stops, then continue finishes', () async {
      commit('c1');
      final c2 = commit('c2');
      commit('c3');
      final plan = await rebase.prepare(c2);
      final out = await run(plan, (e) => [
            for (final x in e)
              x is RebaseCommitEntry && x.hash == c2 ? x.copyWith(action: RebaseAction.edit) : x,
          ]);
      expect(out.stopped, isTrue);
      expect(await repo.repoState(), RepoState.rebasing);
      final progress = await repo.rebaseProgress();
      expect(progress!.stoppedForEdit, isTrue);
      expect(progress.stoppedHash, c2);
      expect(progress.stoppedSubject, 'c2');
      expect((progress.done, progress.total), (1, 2));

      write('c2.txt', 'amended\n');
      git(['commit', '-q', '-a', '--amend', '--no-edit']);
      await repo.continueOperation(RepoState.rebasing);
      expect(await repo.repoState(), RepoState.normal);
      expect(subjects(), ['c3', 'c2', 'c1']);
      expect(git(['show', 'HEAD~1:c2.txt']), 'amended');
      expect(Directory(stateDir()).existsSync(), isFalse);
    });

    test('conflict, then abort restores the original HEAD', () async {
      final c1 = commit('c1', file: 'f.txt', content: 'one\n');
      commit('c2', file: 'f.txt', content: 'two\n');
      commit('c3', file: 'f.txt', content: 'three\n');
      final plan = await rebase.prepare(c1);
      final out = await run(plan, (e) => moveCommit(e, plan.commits[2].hash, -1));
      expect(out.stopped, isTrue);
      expect(await repo.repoState(), RepoState.rebasing);
      expect((await repo.status()).conflicts.map((c) => c.path), ['f.txt']);
      expect(Directory(stateDir()).existsSync(), isTrue);

      await repo.abortOperation(RepoState.rebasing);
      expect(await repo.repoState(), RepoState.normal);
      expect(git(['rev-parse', 'HEAD']), plan.head);
      expect(git(['symbolic-ref', 'HEAD']), 'refs/heads/main');
      expect(read('f.txt'), 'three\n');
      expect(Directory(stateDir()).existsSync(), isFalse);
    });

    test('range with a merge: rewords on both sides keep the topology', () async {
      commit('base');
      final m1 = commit('m1');
      git(['checkout', '-qb', 'side']);
      final s1 = commit('s1');
      commit('s2');
      git(['checkout', '-q', 'main']);
      final m2 = commit('m2');
      git(['merge', '-q', '--no-ff', 'side', '-m', 'Merge side']);
      commit('m3');
      final tree = git(['rev-parse', 'HEAD^{tree}']);

      final plan = await rebase.prepare(m1);
      expect(plan.rebaseMerges, isTrue);
      expect(plan.entries.whereType<RebaseStructuralEntry>().map((e) => e.line),
          containsAll(['label onto', 'merge -C ${git(['rev-parse', '--short', 'HEAD~1'])} side # Merge side']));
      expect(plan.commits.map((c) => c.subject).toSet(), {'m1', 's1', 's2', 'm2', 'm3'});

      var entries = rewordCommit(plan.entries, m2, 'm2 reworded');
      entries = rewordCommit(entries, s1, 's1 reworded');
      final out = await rebase.start(plan, entries);
      expect(out.stopped, isFalse);

      expect(git(['rev-parse', 'HEAD^{tree}']), tree);
      expect(subjects('--first-parent'), ['m3', 'Merge side', 'm2 reworded', 'm1', 'base']);
      expect(git(['rev-list', '--parents', '-n', '1', 'HEAD~1']).split(' '), hasLength(3));
      expect(subjects('HEAD~1^2'), ['s2', 's1 reworded', 'm1', 'base']);
      expect(git(['rev-parse', 'HEAD~2']), isNot(m2));
    });

    test('autostash restores local changes', () async {
      final c1 = commit('c1');
      commit('c2');
      write('c1.txt', 'local change\n');
      write('untracked.txt', 'untracked\n');
      final plan = await rebase.prepare(c1);
      final out = await run(plan, (e) => rewordCommit(e, c1, 'c1 reworded'));
      expect(out.stopped, isFalse);
      expect(subjects(), ['c2', 'c1 reworded']);
      expect(read('c1.txt'), 'local change\n');
      expect(read('untracked.txt'), 'untracked\n');
      expect(git(['stash', 'list']), isEmpty);
    });

    test('commit-msg hook runs on reword; a rejecting hook stops the rebase', () async {
      commit('c1');
      final c2 = commit('c2');
      commit('c3');
      final hook = p.join(dir, '.git', 'hooks', 'commit-msg');
      File(hook).writeAsStringSync('#!/bin/sh\necho "hook: rejected" >&2\nexit 1\n');
      if (!Platform.isWindows) Process.runSync('chmod', ['+x', hook]);

      final plan = await rebase.prepare(c2);
      final out = await run(plan, (e) => rewordCommit(e, c2, 'c2 reworded'));
      expect(out.stopped, isTrue);
      expect(out.output, contains('hook: rejected'));
      expect(await repo.repoState(), RepoState.rebasing);
      expect(File(p.join(stateDir(), 'msg-1.txt')).readAsStringSync(), 'c2 reworded\n');

      await repo.abortOperation(RepoState.rebasing);
      expect(git(['rev-parse', 'HEAD']), plan.head);

      // A hook that accepts sees the new message.
      File(hook).writeAsStringSync('#!/bin/sh\necho "checked" >> "\$1"\n');
      final again = await rebase.prepare(c2);
      await run(again, (e) => rewordCommit(e, c2, 'c2 reworded'));
      expect(git(['log', '-1', '--format=%B', 'HEAD~1']), 'c2 reworded\nchecked');
    });

    test('preview shows the real history even with rebase.autoSquash', () async {
      final c1 = commit('c1');
      commit('c2');
      commit('fixup! c1', file: 'c1.txt', content: 'fixed\n');
      git(['config', 'rebase.autoSquash', 'true']);
      final plan = await rebase.prepare(c1);
      expect(plan.commits.map((c) => c.subject), ['c1', 'c2', 'fixup! c1']);
      expect(plan.commits.map((c) => c.action), everyElement(RebaseAction.pick));
    });

    test('an empty commit can be reworded', () async {
      final c1 = commit('c1');
      git(['commit', '-q', '--allow-empty', '-m', 'empty']);
      commit('c2');
      final empty = git(['rev-parse', 'HEAD~1']);
      final plan = await rebase.prepare(c1);
      final out = await run(plan, (e) => rewordCommit(e, empty, 'empty reworded'));
      expect(out.stopped, isFalse);
      expect(subjects(), ['c2', 'empty reworded', 'c1']);
    });

    test('refuses to run when HEAD moved since the preview', () async {
      final c1 = commit('c1');
      commit('c2');
      final plan = await rebase.prepare(c1);
      commit('c3');
      await expectLater(run(plan, (e) => dropCommits(e, [c1])), throwsA(isA<Exception>()));
      expect(subjects(), ['c3', 'c2', 'c1']);
    });
  });
}
