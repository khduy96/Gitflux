import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory tmp;
  late String app;
  late String lib;
  late GitCliRepository repo;

  String git(String dir, List<String> args) {
    final r = Process.runSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
        workingDirectory: dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return r.stdout as String;
  }

  void write(String file, String content) {
    File(file).parent.createSync(recursive: true);
    File(file).writeAsStringSync(content);
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_sub_');
    lib = p.join(tmp.path, 'lib');
    app = p.join(tmp.path, 'app');
    Directory(lib).createSync();
    git(lib, ['init', '-q', '-b', 'main']);
    write(p.join(lib, 'a.txt'), 'v1\n');
    git(lib, ['add', '-A']);
    git(lib, ['commit', '-qm', 'lib v1']);
    Directory(app).createSync();
    git(app, ['init', '-q', '-b', 'main']);
    write(p.join(app, 'main.txt'), 'app\n');
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'app init']);
    git(app, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'libs/core']);
    git(app, ['commit', '-qm', 'add submodule']);
    repo = GitCliRepository(app);
  });

  tearDown(() {
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {}
  });

  test('status reports submodule changes', () async {
    final sub = p.join(app, 'libs', 'core');
    write(p.join(sub, 'a.txt'), 'v2\n');
    git(sub, ['commit', '-qam', 'lib v2']);
    write(p.join(sub, 'a.txt'), 'v2 dirty\n');
    write(p.join(sub, 'new.txt'), 'u\n');
    final s = await repo.status();
    final c = s.changes.singleWhere((c) => c.path == 'libs/core');
    expect(c.isSubmodule, isTrue);
    expect(c.type, ChangeType.modified);
    expect(c.submodule!.newCommits, isTrue);
    expect(c.submodule!.modifiedContent, isTrue);
    expect(c.submodule!.untrackedContent, isTrue);
    expect(c.submodule!.description, 'new commits, modified content, untracked content');
    expect(s.changes.where((c) => c.path == '.gitmodules'), isEmpty);
  });

  test('submodule list, readable diff content and rollback', () async {
    final sub = p.join(app, 'libs', 'core');
    final recorded = git(app, ['ls-tree', 'HEAD', 'libs/core']).split(RegExp(r'\s+'))[2];
    write(p.join(sub, 'a.txt'), 'v2\n');
    git(sub, ['commit', '-qam', 'lib v2']);
    write(p.join(sub, 'untracked.txt'), 'u\n');

    var subs = await repo.submodules();
    expect(subs.single.path, 'libs/core');
    expect(subs.single.url, '../lib');
    expect(subs.single.status, SubmoduleStatus.outOfDate);

    final head = utf8.decode((await repo.fileBytes(const CommitRev('HEAD'), 'libs/core'))!);
    expect(head, contains('Submodule libs/core'));
    expect(head, contains('Commit $recorded'));
    expect(head, contains('lib v1'));
    final work = utf8.decode((await repo.fileBytes(const WorkingTreeRev(), 'libs/core'))!);
    expect(work, contains('lib v2'));
    expect(work, contains('Local changes inside the submodule'));

    // Rollback checks out the recorded commit again (untracked files stay).
    final change = (await repo.status()).changes.singleWhere((c) => c.path == 'libs/core');
    await repo.rollback([change], hasHead: true);
    expect(git(sub, ['rev-parse', 'HEAD']).trim(), recorded);
    subs = await repo.submodules();
    expect(subs.single.status, SubmoduleStatus.upToDate);
    final after = (await repo.status()).changes.singleWhere((c) => c.path == 'libs/core');
    expect(after.submodule!.newCommits, isFalse);
    expect(after.submodule!.untrackedContent, isTrue);
  });

  test('uninitialized submodule is reported', () async {
    git(app, ['submodule', 'deinit', '-q', '-f', 'libs/core']);
    final subs = await repo.submodules();
    expect(subs.single.status, SubmoduleStatus.uninitialized);
    final head = utf8.decode((await repo.fileBytes(const CommitRev('HEAD'), 'libs/core'))!);
    expect(head, contains('not available locally'));
  });

  test('declared but not registered submodule and nested repositories', () async {
    final wallet = p.join(app, 'lib', 'features', 'wallet');
    Directory(p.dirname(wallet)).createSync(recursive: true);
    git(p.dirname(wallet), ['-c', 'protocol.file.allow=always', 'clone', '-q', lib, 'wallet']);
    git(app, ['config', '-f', '.gitmodules', 'submodule.lib/features/wallet.path', 'lib/features/wallet']);
    git(app, ['config', '-f', '.gitmodules', 'submodule.lib/features/wallet.url', '../lib']);

    final subs = await repo.submodules();
    expect(subs.map((s) => '${s.path}:${s.status.name}'), ['lib/features/wallet:notRegistered', 'libs/core:upToDate']);
    expect(subs.first.sha, matches(RegExp(r'^[0-9a-f]{40}$')));

    final s = await repo.status();
    final nested = s.changes.where((c) => c.nestedRepo).toList();
    expect(nested.map((c) => c.path), ['lib/features/wallet']);
    expect(s.changes.any((c) => c.path.endsWith('/')), isFalse);

    await repo.registerSubmodule('lib/features/wallet', '../lib');
    expect(git(app, ['ls-files', '-s', 'lib/features/wallet']), startsWith('160000 '));
    expect((await repo.submodules()).firstWhere((x) => x.path == 'lib/features/wallet').status, SubmoduleStatus.upToDate);
  });

  test('repository without .gitmodules has no submodules', () async {
    expect(await GitCliRepository(lib).submodules(), isEmpty);
  });
}
