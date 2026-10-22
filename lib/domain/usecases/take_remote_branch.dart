import '../entities/git_models.dart';
import '../repositories/git_repository.dart';

/// "Drop Local and Take `<upstream>`": instead of a pull that conflicts, the
/// local branch is deleted and checked out again from its remote branch.
/// Uncommitted changes go along (stash, checkout, unstash).
class TakeRemoteBranch {
  const TakeRemoteBranch(this.repo);

  final GitRepository repo;

  /// Fetches [ref] (`origin/x`) and returns the commits of [branch] it does
  /// not have: what taking it drops.
  Future<List<Commit>> preview(String branch, String ref) async {
    final slash = ref.indexOf('/');
    await repo.fetchBranch(ref.substring(0, slash), ref.substring(slash + 1));
    return repo.commitsBetween(ref, branch);
  }

  /// Aborts [abort] (the merge / rebase of a pull stopped on conflicts),
  /// then checks [branch] out again from [ref]. Returns false when the
  /// uncommitted changes did not apply again: they stay in the stash.
  Future<bool> call(String branch, String ref, {RepoState? abort}) async {
    if (abort != null) await repo.abortOperation(abort);
    final dirty = (await repo.status()).changes.isNotEmpty;
    if (dirty) await repo.stash(message: 'Uncommitted changes before taking $ref', includeUntracked: true);
    try {
      await repo.checkoutFrom(branch, ref);
    } catch (_) {
      if (dirty) await repo.stashPop();
      rethrow;
    }
    if (!dirty) return true;
    try {
      await repo.stashPop();
      return true;
    } catch (_) {
      return false;
    }
  }
}
