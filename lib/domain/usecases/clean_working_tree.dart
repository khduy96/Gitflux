import '../entities/clean.dart';
import '../errors.dart';
import '../logic/clean_parser.dart';
import '../repositories/git_repository.dart';

/// "Clean Working Tree…": lists what `git clean` would remove, then removes
/// the entries the user kept checked.
class CleanWorkingTree {
  CleanWorkingTree(this._repo);

  final GitRepository _repo;

  /// Untracked (and with [CleanOptions.includeIgnored], ignored) files and
  /// directories, nested repositories included.
  Future<List<CleanEntry>> preview(CleanOptions options) async {
    final runs = await Future.wait([
      _repo.cleanDryRun(options),
      _repo.cleanDryRun(options, nested: true),
      if (options.includeIgnored) _repo.cleanDryRun(options.copyWith(includeIgnored: false), nested: true),
    ]);
    return buildCleanEntries(plain: runs[0], forced: runs[1], notIgnored: runs.length > 2 ? runs[2] : null);
  }

  /// Removes [entries] and returns how many were removed. Nested
  /// repositories need `-ff`, so they are removed by a separate command.
  /// Throws [CleanRejected] when nothing is selected.
  Future<int> call(List<CleanEntry> entries, CleanOptions options) async {
    if (entries.isEmpty) throw CleanRejected('Nothing selected to clean');
    // A directory entry only exists with -d.
    final opts = entries.any((e) => e.isDirectory) ? options.copyWith(directories: true) : options;
    final plain = entries.where((e) => !e.nestedRepo).map((e) => e.pathspec).toList();
    final nested = entries.where((e) => e.nestedRepo).map((e) => e.pathspec).toList();
    if (plain.isNotEmpty) await _repo.clean(plain, opts);
    if (nested.isNotEmpty) await _repo.clean(nested, opts, nested: true);
    return entries.length;
  }
}
