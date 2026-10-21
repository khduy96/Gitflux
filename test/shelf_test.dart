import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/file_shelf_repository.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/shelf.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/usecases/shelve_changes.dart';
import 'package:path/path.dart' as p;

/// Shelve / unshelve on real temporary repositories.
void main() {
  late Directory tmp;
  late String dir;
  late GitCliRepository repo;
  late FileShelfRepository shelves;
  late ShelveChanges shelve;
  late UnshelveChanges unshelve;

  String git(List<String> args) {
    final r = Process.runSync('git', args, workingDirectory: dir);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  File file(String name) => File(p.join(dir, name));
  void write(String name, String content) => (file(name)..parent.createSync(recursive: true)).writeAsStringSync(content);
  String read(String name) => file(name).readAsStringSync();

  String commitAll(String msg) {
    git(['add', '-A']);
    git(['commit', '-qm', msg]);
    return git(['rev-parse', 'HEAD']);
  }

  /// Every file of the work tree (outside .git) with its bytes.
  Map<String, List<int>> workTree() => {
        for (final f in Directory(dir).listSync(recursive: true).whereType<File>())
          if (!p.split(p.relative(f.path, from: dir)).contains('.git'))
            p.relative(f.path, from: dir).replaceAll(r'\', '/'): f.readAsBytesSync(),
      };

  /// Index entries (mode, blob, stage, path).
  String index() => git(['ls-files', '-s']);

  Future<List<FileChange>> changes(Iterable<String> paths) async =>
      (await repo.status()).changes.where((c) => paths.contains(c.path)).toList();

  String shelfDir(Shelf s) => p.join(dir, '.git', 'git-tools', 'shelf', s.id);
  bool refExists(String ref) => Process.runSync('git', ['rev-parse', '--verify', '--quiet', ref], workingDirectory: dir).exitCode == 0;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('gt_shelf_');
    dir = p.join(tmp.path, 'repo');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    repo = GitCliRepository(dir);
    shelves = FileShelfRepository(repo);
    shelve = ShelveChanges(repo, shelves);
    unshelve = UnshelveChanges(repo, shelves);
    for (final n in ['a', 'b', 'c', 'd']) {
      write('$n.txt', '${[for (var i = 1; i <= 6; i++) '$n$i'].join('\n')}\n');
    }
    commitAll('init');
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  test('shelves 2 of 3 modified files, an untracked and a deleted file; unshelve restores them', () async {
    write('a.txt', read('a.txt').replaceFirst('a2', 'A2'));
    write('b.txt', read('b.txt').replaceFirst('b5', 'B5'));
    write('c.txt', read('c.txt').replaceFirst('c1', 'C1'));
    git(['add', 'c.txt']);
    write('c.txt', '${read('c.txt')}unstaged\n');
    file('d.txt').deleteSync();
    write('dir/new.txt', 'new file\n');
    final before = workTree();
    final indexBefore = index();
    final head = git(['rev-parse', 'HEAD']);

    final out = await shelve(
        name: 'WIP', changes: await changes(['a.txt', 'b.txt', 'd.txt', 'dir/new.txt']));
    final s = out.shelf;
    expect(s.name, 'WIP');
    expect(s.base, head);
    expect(s.branch, 'main');
    expect({for (final f in s.files) f.path: f.status.letter},
        {'a.txt': 'M', 'b.txt': 'M', 'd.txt': 'D', 'dir/new.txt': 'A'});
    // Reverted to HEAD; the third file and the real index are untouched.
    expect(read('a.txt'), '${git(['show', 'HEAD:a.txt'])}\n');
    expect(read('b.txt'), '${git(['show', 'HEAD:b.txt'])}\n');
    expect(file('d.txt').existsSync(), isTrue);
    expect(file('dir/new.txt').existsSync(), isFalse);
    expect(file('c.txt').readAsBytesSync(), before['c.txt']);
    expect(index(), indexBefore);
    expect(git(['status', '--porcelain']), 'MM c.txt');

    // On disk: the shared format and the ref keeping the base alive.
    final json = jsonDecode(File(p.join(shelfDir(s), 'shelf.json')).readAsStringSync()) as Map<String, dynamic>;
    expect(json['version'], 1);
    expect(json['base'], head);
    expect(json['created'], matches(RegExp(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')));
    expect(File(p.join(shelfDir(s), 'changes.patch')).readAsStringSync(), contains('diff --git a/dir/new.txt b/dir/new.txt'));
    expect(git(['rev-parse', s.ref]), head);
    expect(await shelves.list(), hasLength(1));

    final r = await unshelve(s);
    expect(r.conflicted, isEmpty);
    expect(r.applied, hasLength(4));
    expect(r.shelf, isNull);
    expect(workTree(), before);
    expect(index(), indexBefore);
    expect(Directory(shelfDir(s)).existsSync(), isFalse);
    expect(refExists(s.ref), isFalse);
    expect(await shelves.list(), isEmpty);
  });

  test('a staged rename is shelved as a rename', () async {
    git(['mv', 'c.txt', 'e.txt']);
    final s = (await shelve(name: 'rename', changes: await changes(['e.txt']))).shelf;
    expect(s.files.single, const ShelvedFile(path: 'e.txt', oldPath: 'c.txt', status: ShelfFileStatus.renamed));
    expect(file('c.txt').existsSync(), isTrue);
    expect(file('e.txt').existsSync(), isFalse);
    expect(git(['status', '--porcelain']), isEmpty);

    await unshelve(s);
    expect(file('c.txt').existsSync(), isFalse);
    expect(read('e.txt'), startsWith('c1'));
  });

  test('keep changes in the working tree', () async {
    write('a.txt', 'changed\n');
    write('n.txt', 'new\n');
    final before = workTree();
    final out = await shelve(name: 'Keep', changes: await changes(['a.txt', 'n.txt']), keep: true);
    expect(workTree(), before);
    expect(out.shelf.files.map((f) => f.path), unorderedEquals(['a.txt', 'n.txt']));
    expect(await shelves.list(), hasLength(1));
  });

  test('partial unshelve keeps the other files in the shelf', () async {
    write('a.txt', 'A\n');
    write('b.txt', 'B\n');
    write('n.txt', 'N\n');
    final s = (await shelve(name: 'three', changes: await changes(['a.txt', 'b.txt', 'n.txt']))).shelf;

    final r = await unshelve(s, paths: ['b.txt']);
    expect(r.applied.map((f) => f.path), ['b.txt']);
    expect(read('b.txt'), 'B\n');
    expect(read('a.txt'), startsWith('a1'));
    expect(file('n.txt').existsSync(), isFalse);
    expect(r.shelf!.files.map((f) => f.path), unorderedEquals(['a.txt', 'n.txt']));
    final patch = File(p.join(shelfDir(s), 'changes.patch')).readAsStringSync();
    expect(patch, isNot(contains('b.txt')));
    expect((await shelves.list()).single.files, hasLength(2));

    // Apply (keep in shelf) leaves the shelf as it is.
    final kept = await unshelve(r.shelf!, removeApplied: false);
    expect(kept.shelf!.files, hasLength(2));
    expect(read('a.txt'), 'A\n');
    expect(read('n.txt'), 'N\n');
  });

  test('unshelve after HEAD moved: conflict markers, clean files leave the shelf', () async {
    write('a.txt', read('a.txt').replaceFirst('a3', 'shelved'));
    write('b.txt', read('b.txt').replaceFirst('b3', 'B3'));
    final s = (await shelve(name: 'two', changes: await changes(['a.txt', 'b.txt']))).shelf;
    write('a.txt', read('a.txt').replaceFirst('a3', 'committed'));
    commitAll('conflicting');

    final r = await unshelve(s);
    expect(r.applied.map((f) => f.path), ['b.txt']);
    expect(r.conflicted.map((f) => f.path), ['a.txt']);
    expect(read('a.txt'), allOf(contains('<<<<<<<'), contains('shelved'), contains('committed')));
    expect(read('b.txt'), contains('B3'));
    final status = await repo.status();
    expect(status.conflicts.map((c) => c.path), ['a.txt']);
    // The clean file is not staged.
    expect(git(['diff', '--cached', '--name-only']), isNot(contains('b.txt')));
    expect(r.shelf!.files.map((f) => f.path), ['a.txt']);

    // Unshelving again is refused until the conflict is resolved.
    await expectLater(unshelve(r.shelf!), throwsA(isA<ShelfRejected>()));
  });

  test('local changes of an unshelved file are merged', () async {
    write('a.txt', read('a.txt').replaceFirst('a1', 'shelved'));
    final s = (await shelve(name: 'one', changes: await changes(['a.txt']))).shelf;
    write('a.txt', read('a.txt').replaceFirst('a6', 'local'));
    final r = await unshelve(s);
    expect(r.conflicted, isEmpty);
    expect(read('a.txt'), allOf(contains('shelved'), contains('local')));
    expect(git(['diff', '--cached', '--name-only']), isEmpty);
  });

  test('staged changes of an unshelved file stay staged', () async {
    write('a.txt', read('a.txt').replaceFirst('a1', 'shelved'));
    final s = (await shelve(name: 'one', changes: await changes(['a.txt']))).shelf;
    write('a.txt', read('a.txt').replaceFirst('a6', 'staged'));
    git(['add', 'a.txt']);
    final staged = index();
    final r = await unshelve(s);
    expect(r.conflicted, isEmpty);
    expect(index(), staged);
    expect(read('a.txt'), allOf(contains('shelved'), contains('staged')));
    expect(git(['status', '--porcelain']), 'MM a.txt');
  });

  test('a shelved new file over an untracked file gives an add/add conflict', () async {
    write('n.txt', 'shelved\n');
    write('b.txt', 'B\n');
    final s = (await shelve(name: 'new file', changes: await changes(['n.txt', 'b.txt']))).shelf;
    write('n.txt', 'other\n');
    final r = await unshelve(s);
    expect(r.conflicted.map((f) => f.path), ['n.txt']);
    expect(read('n.txt'), allOf(contains('<<<<<<<'), contains('shelved'), contains('other')));
    expect(read('b.txt'), 'B\n');
    expect(r.shelf!.files.map((f) => f.path), ['n.txt']);
    expect((await repo.status()).conflicts.map((c) => c.path), ['n.txt']);
  });

  test('a refused patch changes nothing', () async {
    write('a.txt', 'shelved a\n');
    write('b.txt', 'shelved b\n');
    final s = (await shelve(name: 'two', changes: await changes(['a.txt', 'b.txt']))).shelf;
    file('a.txt').deleteSync();
    final before = workTree();
    final indexBefore = index();
    await expectLater(unshelve(s), throwsA(isA<GitException>()));
    expect(workTree(), before);
    expect(index(), indexBefore);
    expect((await shelves.list()).single.files, hasLength(2));
  });

  test('partial unshelve of names with glob characters', () async {
    write('[id].txt', 'x\n');
    write('i.txt', 'i\n');
    commitAll('globs');
    write('[id].txt', 'shelved x\n');
    write('i.txt', 'shelved i\n');
    final s = (await shelve(name: 'globs', changes: await changes(['[id].txt', 'i.txt']))).shelf;
    final r = await unshelve(s, paths: ['[id].txt']);
    expect(r.applied.map((f) => f.path), ['[id].txt']);
    expect(read('[id].txt'), 'shelved x\n');
    expect(read('i.txt'), 'i\n');
    expect(r.shelf!.files.map((f) => f.path), ['i.txt']);
  });

  test('non UTF-8 content round-trips byte for byte', () async {
    final latin1 = [0x63, 0x61, 0x66, 0xE9, 0x0A]; // "café" in Latin-1
    file('l.txt').writeAsBytesSync(latin1);
    commitAll('latin1');
    final changed = [...latin1, 0xFC, 0xE8, 0x0A];
    file('l.txt').writeAsBytesSync(changed);
    file('n.txt').writeAsBytesSync([0xFF, 0xFE, 0x41, 0x0A]);
    final s = (await shelve(name: 'latin1', changes: await changes(['l.txt', 'n.txt']))).shelf;
    final patch = File(p.join(shelfDir(s), 'changes.patch')).readAsBytesSync();
    expect(patch, containsAllInOrder([0xFC, 0xE8]));
    expect(patch.contains(13), isFalse);
    // Removing a file keeps the bytes of the other entries.
    final left = await unshelve(s, paths: ['n.txt']);
    expect(file('n.txt').readAsBytesSync(), [0xFF, 0xFE, 0x41, 0x0A]);
    await unshelve(left.shelf!);
    expect(file('l.txt').readAsBytesSync(), changed);
  });

  test('binary files round-trip', () async {
    final bin = List<int>.generate(3000, (i) => (i * 7) % 256);
    file('img.bin').writeAsBytesSync(bin);
    commitAll('binary');
    final changed = [...bin]..[10] = 0..[2000] = 255;
    file('img.bin').writeAsBytesSync(changed);
    file('new.bin').writeAsBytesSync([0, 1, 2, 0, 255, 254]);
    final before = workTree();
    final s = (await shelve(name: 'bin', changes: await changes(['img.bin', 'new.bin']))).shelf;
    expect(file('img.bin').readAsBytesSync(), bin);
    expect(file('new.bin').existsSync(), isFalse);

    final patchFile = await shelves.patchPath(s);
    expect(await repo.fileBytes(PatchedRev(s.base, patchFile), 'img.bin'), changed);

    await unshelve(s);
    expect(workTree(), before);
  });

  test('shelf survives a rewritten base and gc', () async {
    write('g.txt', 'g\n');
    commitAll('base commit');
    write('a.txt', 'shelved a\n');
    final s = (await shelve(name: 'old base', changes: await changes(['a.txt']))).shelf;
    git(['reset', '-q', '--hard', 'HEAD~1']);
    git(['reflog', 'expire', '--expire=now', '--all']);
    git(['gc', '-q', '--prune=now']);
    expect(git(['cat-file', '-t', s.base]), 'commit');

    final patchFile = await shelves.patchPath(s);
    expect(utf8.decode((await repo.fileBytes(PatchedRev(s.base, patchFile), 'a.txt'))!), 'shelved a\n');
    final r = await unshelve(s);
    expect(r.conflicted, isEmpty);
    expect(read('a.txt'), 'shelved a\n');
  });

  test('rename and delete a shelf', () async {
    write('a.txt', 'x\n');
    final s = (await shelve(name: 'first', changes: await changes(['a.txt']))).shelf;
    final renamed = await shelves.update(s, name: 'second');
    expect((await shelves.list()).single.name, 'second');
    await shelves.delete(renamed);
    expect(await shelves.list(), isEmpty);
    expect(refExists(s.ref), isFalse);
  });

  test('refuses to shelve during a merge', () async {
    git(['checkout', '-qb', 'other']);
    write('a.txt', 'other\n');
    commitAll('other');
    git(['checkout', '-q', 'main']);
    write('a.txt', 'main\n');
    commitAll('main');
    Process.runSync('git', ['merge', 'other'], workingDirectory: dir);
    expect(await repo.repoState(), RepoState.merging);
    write('b.txt', 'x\n');
    await expectLater(shelve(name: 'x', changes: await changes(['b.txt'])), throwsA(isA<ShelfRejected>()));
  });
}
