import 'dart:io';
import 'dart:math';

import 'package:path/path.dart' as p;

import '../../domain/entities/shelf.dart';
import '../../domain/logic/shelf_format.dart';
import '../../domain/repositories/git_repository.dart';
import '../../domain/repositories/shelf_repository.dart';

/// [ShelfRepository] in `<git-common-dir>/git-tools/shelf/<id>/`: shared by
/// the worktrees of the repository and never tracked.
class FileShelfRepository implements ShelfRepository {
  FileShelfRepository(this._repo);

  final GitRepository _repo;
  final _random = Random.secure();

  static const _json = 'shelf.json';
  static const _patch = 'changes.patch';

  Future<Directory> _root() async => Directory(p.join(await _repo.commonDir(), 'git-tools', 'shelf'));

  Future<Directory> _dir(Shelf s) async => Directory(p.join((await _root()).path, s.id));

  /// Folders without a readable `shelf.json` (being written, or from a newer
  /// version) are skipped.
  @override
  Future<List<Shelf>> list() async {
    final root = await _root();
    if (!await root.exists()) return const [];
    final result = <Shelf>[];
    await for (final e in root.list()) {
      final id = p.basename(e.path);
      if (e is! Directory || !isShelfId(id)) continue;
      final json = File(p.join(e.path, _json));
      try {
        if (!await File(p.join(e.path, _patch)).exists()) continue;
        result.add(decodeShelf(id, await json.readAsString()));
      } on FormatException {
        continue;
      } on FileSystemException {
        continue;
      }
    }
    result.sort((a, b) {
      final c = b.created.compareTo(a.created);
      return c != 0 ? c : b.id.compareTo(a.id);
    });
    return result;
  }

  /// The ref comes first so the base is never unreferenced, `shelf.json`
  /// last so a half-written shelf is not listed.
  @override
  Future<Shelf> create({
    required String name,
    required String base,
    String? branch,
    required List<ShelvedFile> files,
    required List<int> patch,
  }) async {
    final root = await _root();
    final now = DateTime.now();
    var id = newShelfId(now, _random);
    while (await Directory(p.join(root.path, id)).exists()) {
      id = newShelfId(now, _random);
    }
    final shelf = Shelf(id: id, name: name, created: now.toUtc(), base: base, branch: branch, files: files);
    final dir = await Directory(p.join(root.path, id)).create(recursive: true);
    try {
      await _repo.updateRef(shelf.ref, base);
      await File(p.join(dir.path, _patch)).writeAsBytes(patch, flush: true);
      await File(p.join(dir.path, _json)).writeAsString(encodeShelf(shelf), flush: true);
    } catch (_) {
      await _deleteQuietly(shelf, dir);
      rethrow;
    }
    return shelf;
  }

  @override
  Future<List<int>> patch(Shelf shelf) async => File(p.join((await _dir(shelf)).path, _patch)).readAsBytes();

  @override
  Future<String> patchPath(Shelf shelf) async => p.join((await _dir(shelf)).path, _patch);

  @override
  Future<Shelf> update(Shelf shelf, {String? name, List<ShelvedFile>? files, List<int>? patch}) async {
    final dir = await _dir(shelf);
    final updated = shelf.copyWith(name: name, files: files);
    if (patch != null) await _replace(File(p.join(dir.path, _patch)), (f) => f.writeAsBytes(patch, flush: true));
    await _replace(File(p.join(dir.path, _json)), (f) => f.writeAsString(encodeShelf(updated), flush: true));
    return updated;
  }

  /// Writes a sibling file, then renames it over [file].
  static Future<void> _replace(File file, Future<void> Function(File) write) async {
    final tmp = File('${file.path}.tmp');
    await write(tmp);
    await tmp.rename(file.path);
  }

  @override
  Future<void> delete(Shelf shelf) async {
    final dir = await _dir(shelf);
    if (await dir.exists()) await dir.delete(recursive: true);
    await _repo.deleteRef(shelf.ref);
  }

  Future<void> _deleteQuietly(Shelf shelf, Directory dir) async {
    try {
      if (await dir.exists()) await dir.delete(recursive: true);
      await _repo.deleteRef(shelf.ref);
    } catch (_) {}
  }
}
