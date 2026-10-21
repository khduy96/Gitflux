import 'dart:io';

import '../../domain/entities/changelist.dart';
import '../../domain/logic/changelists.dart';
import '../../domain/repositories/changelist_repository.dart';
import '../../domain/repositories/git_repository.dart';

/// [ChangelistRepository] in `$(git rev-parse --git-path
/// git-tools/changelists.json)`: one file per worktree, never tracked.
class FileChangelistRepository implements ChangelistRepository {
  FileChangelistRepository(this._repo);

  final GitRepository _repo;

  /// Pending [update]s, so two changes never interleave.
  Future<void> _queue = Future.value();

  Future<File> _file() async => File(await _repo.gitPath('git-tools/changelists.json'));

  @override
  Future<Changelists> read() async {
    final f = await _file();
    if (!await f.exists()) return const Changelists();
    return decodeChangelists(await f.readAsString());
  }

  @override
  Future<Changelists> update(Changelists Function(Changelists current) change) {
    final result = _queue.then((_) async {
      final f = await _file();
      final exists = await f.exists();
      final before = exists ? await f.readAsString() : null;
      final current = before == null ? const Changelists() : decodeChangelists(before);
      final next = change(current);
      final text = encodeChangelists(next);
      if (text != before && (exists || text != encodeChangelists(const Changelists()))) {
        await f.parent.create(recursive: true);
        // Written next to the file, then renamed over it.
        final tmp = File('${f.path}.$pid.tmp');
        await tmp.writeAsString(text, flush: true);
        await tmp.rename(f.path);
      }
      return next;
    });
    _queue = result.then((_) {}, onError: (_) {});
    return result;
  }
}
