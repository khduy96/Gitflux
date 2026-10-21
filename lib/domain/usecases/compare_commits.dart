import '../entities/git_models.dart';
import '../repositories/git_repository.dart';

/// Two commits and the files that differ between them.
class CommitComparison {
  const CommitComparison({required this.left, required this.right, required this.files});

  /// Old side of the diff.
  final Commit left;

  /// New side of the diff.
  final Commit right;

  /// Changes from [left] to [right].
  final List<FileChange> files;

  /// Diff of one changed file, `left:file ↔ right:file`.
  DiffRequest diffRequest(FileChange f) {
    final Revision l = f.type == ChangeType.added ? const EmptyRev() : CommitRev(left.hash);
    final Revision r = f.type == ChangeType.deleted ? const EmptyRev() : CommitRev(right.hash);
    return DiffRequest(
      title: '${f.fileName} (${left.shortHash} ↔ ${right.shortHash})',
      leftPath: f.oldPath ?? f.path,
      rightPath: f.path,
      left: l,
      right: r,
      leftTitle: l is EmptyRev ? '(does not exist)' : left.shortHash,
      rightTitle: r is EmptyRev ? '(deleted)' : right.shortHash,
    );
  }
}

/// Compares any two commits, also when neither is an ancestor of the other
/// (`git diff --name-status -M <a> <b>`).
class CompareCommits {
  const CompareCommits(this._repo);

  final GitRepository _repo;

  /// The older commit (earlier committer date, else the ancestor) goes left
  /// unless [swapped].
  Future<CommitComparison> call(Commit a, Commit b, {bool swapped = false}) async {
    var (left, right) = olderFirst(a, b);
    if (left.commitTime == right.commitTime && await _repo.isAncestor(right.hash, left.hash)) {
      (left, right) = (right, left);
    }
    if (swapped) (left, right) = (right, left);
    final files = await _repo.diffFiles(left.hash, right.hash);
    return CommitComparison(left: left, right: right, files: files);
  }

  static (Commit, Commit) olderFirst(Commit a, Commit b) =>
      b.commitTime.isBefore(a.commitTime) ? (b, a) : (a, b);
}
