import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:path/path.dart' as p;

/// Regression: a branch created from `origin/<base>` must not track `<base>`, and
/// the first push must publish it under its own name.
void main() {
  late Directory tmp;
  late String remote;
  late String parent;
  late String child;
  late GitCliRepository repo;

  String git(String dir, List<String> args) {
    final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
        workingDirectory: dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_up_');
    final seed = p.join(tmp.path, 'seed');
    Directory(seed).createSync();
    git(seed, ['init', '-q', '-b', 'main']);
    File(p.join(seed, 'a.txt')).writeAsStringSync('v1\n');
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-qm', 'init']);
    git(seed, ['branch', 'feat/cloud_upgrade']);
    remote = p.join(tmp.path, 'cloud_storage.git');
    git(tmp.path, ['clone', '-q', '--bare', seed, remote]);
    // Independent repo nested inside another one (not a submodule).
    parent = p.join(tmp.path, 'app');
    Directory(parent).createSync();
    git(parent, ['init', '-q', '-b', 'main']);
    child = p.join(parent, 'lib', 'features', 'cloud_storage');
    Directory(p.dirname(child)).createSync(recursive: true);
    git(tmp.path, ['clone', '-q', remote, child]);
    repo = GitCliRepository(child);
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  test('new branch from a remote branch is published under its own name', () async {
    const base = 'origin/feat/cloud_upgrade';
    const branch = 'felix/cloud_upgrade/fixBug';
    final baseBefore = git(remote, ['rev-parse', 'refs/heads/feat/cloud_upgrade']);

    await repo.createBranch(branch, startPoint: base, fromRemote: true);
    expect((await repo.status()).upstream, isNull);
    expect(await repo.config('branch.$branch.vscode-merge-base'), base);

    File(p.join(child, 'a.txt')).writeAsStringSync('fix\n');
    git(child, ['commit', '-qam', 'fix']);
    await repo.push(remote: 'origin', localRef: 'refs/heads/$branch', remoteBranch: branch, setUpstream: true);

    expect(git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/$branch']), 'refs/heads/$branch');
    expect(git(child, ['rev-parse', '--abbrev-ref', '$branch@{upstream}']), 'origin/$branch');
    expect(git(remote, ['rev-parse', 'refs/heads/feat/cloud_upgrade']), baseBefore);
    expect(git(parent, ['for-each-ref', 'refs/heads/felix']), isEmpty);
  });

  test('create without checkout does not track either', () async {
    await repo.createBranch('felix/other', startPoint: 'origin/feat/cloud_upgrade', checkout: false);
    expect(git(child, ['for-each-ref', '--format=%(upstream)', 'refs/heads/felix/other']), isEmpty);
  });
}
