/// A working tree of the repository (`git worktree list --porcelain`).
class Worktree {
  const Worktree({
    required this.path,
    this.head,
    this.branch,
    this.detached = false,
    this.bare = false,
    this.locked = false,
    this.lockReason,
    this.prunable = false,
    this.prunableReason,
    this.isMain = false,
    this.isCurrent = false,
  });

  /// Absolute path as git prints it (forward slashes).
  final String path;

  /// Checked out commit; null for a bare repository.
  final String? head;

  /// Short name of the checked out branch, null when detached or bare.
  final String? branch;
  final bool detached;
  final bool bare;
  final bool locked;

  /// Reason given to `git worktree lock --reason`, null or empty when none.
  final String? lockReason;

  /// Its folder is gone: `git worktree prune` would remove it.
  final bool prunable;
  final String? prunableReason;

  /// The main working tree (first entry).
  final bool isMain;

  /// The working tree of the opened repository.
  final bool isCurrent;

  String get name {
    final trimmed = path.endsWith('/') ? path.substring(0, path.length - 1) : path;
    final i = trimmed.lastIndexOf('/');
    return i < 0 ? trimmed : trimmed.substring(i + 1);
  }

  String? get shortHead => head == null || head!.length < 8 ? head : head!.substring(0, 8);

  /// What is checked out: the branch, `detached at <hash>` or `bare`.
  String get description => bare
      ? 'bare'
      : branch ?? 'detached at ${shortHead ?? '?'}';
}

/// What "New Worktree…" checks out in the new folder.
sealed class WorktreeCheckout {
  const WorktreeCheckout();
}

/// An existing local branch not checked out anywhere else.
class ExistingBranchCheckout extends WorktreeCheckout {
  const ExistingBranchCheckout(this.branch);
  final String branch;
}

/// A new branch (`-b`) created at [startPoint] (HEAD when null).
class NewBranchCheckout extends WorktreeCheckout {
  const NewBranchCheckout(this.branch, {this.startPoint});
  final String branch;
  final String? startPoint;
}

/// A detached HEAD at [revision] (HEAD when null).
class DetachedCheckout extends WorktreeCheckout {
  const DetachedCheckout({this.revision});
  final String? revision;
}
