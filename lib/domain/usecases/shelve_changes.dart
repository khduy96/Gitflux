import '../entities/git_models.dart';
import '../entities/shelf.dart';
import '../errors.dart';
import '../logic/patch_parser.dart';
import '../repositories/git_repository.dart';
import '../repositories/shelf_repository.dart';

/// Rejects shelving while an operation is in progress.
void _checkState(RepoStatus status, String action) {
  if (status.state != RepoState.normal) {
    throw ShelfRejected('Cannot $action now', details: 'Finish or abort the ${status.state.operation} first.');
  }
}

/// "Shelve Changes": saves the chosen files as a patch in a new shelf, then
/// reverts exactly those files to HEAD (unless they are kept).
class ShelveChanges {
  ShelveChanges(this._repo, this._shelves);

  final GitRepository _repo;
  final ShelfRepository _shelves;

  /// Throws [ShelfRejected] when nothing can be shelved now.
  Future<ShelveOutcome> call({required String name, required List<FileChange> changes, bool keep = false}) async {
    final status = await _repo.status();
    _checkState(status, 'shelve');
    if (!status.hasCommits) throw ShelfRejected('Cannot shelve', details: 'The repository has no commits.');
    if (name.trim().isEmpty) throw ShelfRejected('Enter a name for the shelf');
    // A submodule is a commit id, not file content: it cannot be put in a patch.
    bool skip(FileChange c) => c.isSubmodule || c.nestedRepo || c.type == ChangeType.conflicted;
    final skipped = [for (final c in changes) if (skip(c)) c.path];
    final files = changes.where((c) => !skip(c)).toList();
    if (files.isEmpty) {
      throw ShelfRejected('Nothing to shelve',
          details: skipped.isEmpty ? null : 'Submodules and conflicted files cannot be shelved.');
    }
    final base = status.headHash!;
    final diff = await _repo.diffWorkingTree(base, files.expand((c) => c.allPaths).toSet().toList());
    if (diff.files.isEmpty) throw ShelfRejected('Nothing to shelve', details: 'The selected files have no changes.');
    final shelf = await _shelves.create(
      name: name.trim(),
      base: base,
      branch: status.branch,
      files: diff.files.map(ShelvedFile.fromChange).toList(),
      patch: diff.patch,
    );
    if (!keep) {
      final untracked = [for (final c in files) if (c.type == ChangeType.untracked) c.path];
      final tracked = files.where((c) => c.type != ChangeType.untracked).toList();
      if (tracked.isNotEmpty) await _repo.rollback(tracked, deleteAdded: true, hasHead: true);
      if (untracked.isNotEmpty) await _repo.deleteFiles(untracked);
    }
    return ShelveOutcome(shelf, skipped: skipped);
  }
}

/// "Unshelve" / "Apply" of a shelf: applies its patch to the working tree
/// with a 3-way merge, then drops the cleanly applied files from the shelf.
class UnshelveChanges {
  UnshelveChanges(this._repo, this._shelves);

  final GitRepository _repo;
  final ShelfRepository _shelves;

  /// Applies the files of [shelf] whose path is in [paths] (all when null).
  /// With [removeApplied] they are removed from the shelf, which is deleted
  /// once empty; conflicted files always stay. Throws [ShelfRejected], or
  /// [GitException] when git refuses the patch (nothing changed then).
  Future<UnshelveOutcome> call(Shelf shelf, {List<String>? paths, bool removeApplied = true}) async {
    final status = await _repo.status();
    _checkState(status, 'unshelve');
    if (status.conflicts.isNotEmpty) {
      throw ShelfRejected('Cannot unshelve now', details: 'Resolve the conflicts in the working tree first.');
    }
    final files = paths == null ? shelf.files : shelf.files.where((f) => paths.contains(f.path)).toList();
    if (files.isEmpty) throw ShelfRejected('No files selected');
    final patch = await _shelves.patch(shelf);
    // Selected files: the patch reduced to their entries (no `--include`
    // globs, no command line length limit).
    final result = await _repo.applyPatch(
        files.length == shelf.files.length ? patch : await _subPatch(patch, {for (final f in files) f.path}));
    final conflicts = result.conflicts.toSet();
    final conflicted = files.where((f) => f.allPaths.any(conflicts.contains)).toList();
    final applied = files.where((f) => !conflicted.contains(f)).toList();
    final left = removeApplied && applied.isNotEmpty ? await removeFiles(shelf, applied) : shelf;
    return UnshelveOutcome(applied: applied, conflicted: conflicted, shelf: left);
  }

  /// Removes [files] from [shelf] (its patch keeps the other entries
  /// unchanged). Deletes the shelf when no file is left and returns null.
  Future<Shelf?> removeFiles(Shelf shelf, Iterable<ShelvedFile> files) async {
    final drop = {for (final f in files) f.path};
    final rest = shelf.files.where((f) => !drop.contains(f.path)).toList();
    if (rest.isEmpty) {
      await _shelves.delete(shelf);
      return null;
    }
    final patch = await _subPatch(await _shelves.patch(shelf), {for (final f in rest) f.path});
    return _shelves.update(shelf, files: rest, patch: patch);
  }

  /// The entries of [patch] for [paths], byte for byte.
  Future<List<int>> _subPatch(List<int> patch, Set<String> paths) async =>
      filterPatch(patch, patchEntryPaths(await _repo.patchStats(patch)), paths);
}
