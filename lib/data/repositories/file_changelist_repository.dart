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

  /// The [update] running, so two changes never interleave. Null when idle:
  /// an update then starts at once, in the zone of its caller.
  Future<void>? _running;

  Future<File> _file() async => File(await _repo.gitPath('git-tools/changelists.json'));

  @override
  Future<Changelists> read() async {
    final f = await _file();
    if (!await f.exists()) return const Changelists();
    return decodeChangelists(await f.readAsString());
  }

  @override
  Future<Changelists> update(Changelists Function(Changelists current) change) {
    final previous = _running;
    final result = previous == null ? _update(change) : previous.then((_) => _update(change));
    late final Future<void> done;
    done = result.then<void>((_) {}, onError: (_) {}).whenComplete(() {
      if (identical(_running, done)) _running = null;
    });
    _running = done;
    return result;
  }

  Future<Changelists> _update(Changelists Function(Changelists current) change) async {
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
  }
}
