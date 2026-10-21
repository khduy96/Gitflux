import 'dart:convert';

import '../entities/git_models.dart';
import '../entities/patch.dart';
import '../errors.dart';
import '../logic/patch_parser.dart';
import '../repositories/git_repository.dart';

/// "Create Patch…" from working tree files or from commits of the log.
class CreatePatch {
  CreatePatch(this._repo);

  final GitRepository _repo;

  /// Patch of [changes] as they are in the working tree, relative to HEAD
  /// (new files included). Throws [PatchRejected].
  Future<List<int>> fromChanges(RepoStatus status, List<FileChange> changes) async {
    if (!status.hasCommits) throw PatchRejected('Cannot create a patch', details: 'The repository has no commits.');
    final files = changes.where((c) => !c.isSubmodule && !c.nestedRepo && c.type != ChangeType.conflicted);
    if (files.isEmpty) throw PatchRejected('No files to put in the patch');
    final diff = await _repo.diffWorkingTree(status.headHash!, files.expand((c) => c.allPaths).toSet().toList());
    if (diff.patch.isEmpty) throw PatchRejected('The selected files have no changes');
    return diff.patch;
  }

  /// [commits] as one mailbox (`git format-patch`), oldest first. Throws
  /// [PatchRejected] when they are all merge commits.
  Future<List<int>> fromCommits(List<Commit> commits) async {
    final plain = commits.where((c) => !c.isMerge).map((c) => c.hash).toList();
    if (plain.isEmpty) throw PatchRejected('Merge commits cannot be exported as a patch');
    return _repo.formatPatch(plain);
  }
}

/// "Apply Patch…": preview, then apply as commits (`git am`) or as working
/// tree changes (`git apply --3way`).
class ApplyPatch {
  ApplyPatch(this._repo);

  final GitRepository _repo;

  /// Files of [patch] and whether it applies. Throws [GitException] when it
  /// is not a patch git can read, [PatchRejected] when it changes nothing.
  Future<PatchPreview> preview(List<int> patch) async {
    final text = utf8.decode(patch, allowMalformed: true);
    final mailbox = isMailboxPatch(text);
    final files = parsePatchStats(await _repo.patchStats(patch));
    if (files.isEmpty) throw PatchRejected('The patch contains no changes');
    try {
      final check = await _repo.applyPatch(patch, check: true);
      return PatchPreview(
        mailbox: mailbox,
        subjects: mailbox ? mailboxSubjects(text) : const [],
        files: files,
        applies: true,
        conflicts: check.conflicts,
        checkOutput: check.output,
      );
    } on GitException catch (e) {
      return PatchPreview(
        mailbox: mailbox,
        subjects: mailbox ? mailboxSubjects(text) : const [],
        files: files,
        applies: false,
        checkOutput: e.message,
      );
    }
  }

  /// Applies [patch]. [asCommits] (mailbox only) runs `git am --3way`, which
  /// may stop on a conflict ([RepoState.applyingMailbox]); otherwise the
  /// changes go to the working tree. Throws [PatchRejected], or
  /// [GitException] when git refuses the patch.
  Future<({bool stopped, List<String> conflicts})> call(List<int> patch, {bool asCommits = false}) async {
    final status = await _repo.status();
    if (status.state != RepoState.normal) {
      throw PatchRejected('Cannot apply a patch now', details: 'Finish or abort the ${status.state.operation} first.');
    }
    if (status.conflicts.isNotEmpty) {
      throw PatchRejected('Cannot apply a patch now', details: 'Resolve the conflicts in the working tree first.');
    }
    if (asCommits) {
      if (!status.hasCommits) throw PatchRejected('Cannot apply as commits', details: 'The repository has no commits.');
      final done = await _repo.applyMailbox(patch);
      return (stopped: !done, conflicts: done ? const <String>[] : (await _repo.status()).conflicts.map((c) => c.path).toList());
    }
    final r = await _repo.applyPatch(patch);
    return (stopped: false, conflicts: r.conflicts);
  }
}
