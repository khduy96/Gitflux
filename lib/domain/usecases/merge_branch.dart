import '../entities/git_models.dart';
import '../entities/merge.dart';
import '../errors.dart';
import '../repositories/git_repository.dart';

/// "Merge…" of a branch, tag or commit into the current branch.
class MergeBranch {
  MergeBranch(this._repo);

  final GitRepository _repo;

  /// Commits [ref] would bring and whether HEAD can be fast-forwarded.
  Future<MergePreview> preview(String ref) async {
    final status = await _repo.status();
    if (!status.hasCommits) return const MergePreview(commits: 0, fastForward: true);
    final results = await Future.wait([
      _repo.countCommits('HEAD', ref),
      _repo.isAncestor('HEAD', ref),
    ]);
    return MergePreview(commits: results[0] as int, fastForward: results[1] as bool);
  }

  /// Merges [ref] with [options]. After a squash merge the prepared message
  /// is returned so it can be committed by hand. Throws [MergeRejected] for
  /// contradicting options or an operation in progress, [GitException] when
  /// git refuses (e.g. not a fast-forward with "Fast-forward only").
  Future<MergeOutcome> call(String ref, MergeOptions options) async {
    final error = options.error;
    if (error != null) throw MergeRejected('Invalid merge options', details: error);
    final status = await _repo.status();
    if (status.state != RepoState.normal) {
      throw MergeRejected('Cannot merge now', details: 'Finish or abort the ${status.state.operation} first.');
    }
    await _repo.merge(ref, options: options);
    if (options.squash) return MergeOutcome(squashMessage: await _repo.squashMessage());
    return MergeOutcome(stopped: await _repo.repoState() == RepoState.merging);
  }
}
