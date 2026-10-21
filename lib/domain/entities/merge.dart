/// An option of the Merge dialog that can be switched on or off.
enum MergeFlag { ffOnly, noFf, squash, noCommit }

/// Options of `git merge` chosen in the Merge dialog.
class MergeOptions {
  const MergeOptions({
    this.ffOnly = false,
    this.noFf = false,
    this.squash = false,
    this.noCommit = false,
    this.message,
    this.sign,
  });

  /// `--ff-only`: refuse unless the merge is a fast-forward.
  final bool ffOnly;

  /// `--no-ff`: create a merge commit even when a fast-forward is possible.
  final bool noFf;

  /// `--squash`: put the changes in the index and stop (never commits).
  final bool squash;

  /// `--no-commit`: stop before creating the merge commit.
  final bool noCommit;

  /// Message of the merge commit (`-m`); null or blank keeps git's default.
  final String? message;

  /// Signing of the merge commit: true `-S`, false `--no-gpg-sign`, null
  /// leaves it to `commit.gpgsign`.
  final bool? sign;

  bool flag(MergeFlag f) => switch (f) {
        MergeFlag.ffOnly => ffOnly,
        MergeFlag.noFf => noFf,
        MergeFlag.squash => squash,
        MergeFlag.noCommit => noCommit,
      };

  MergeOptions _copy({bool? ffOnly, bool? noFf, bool? squash, bool? noCommit, String? Function()? message,
          bool? Function()? sign}) =>
      MergeOptions(
        ffOnly: ffOnly ?? this.ffOnly,
        noFf: noFf ?? this.noFf,
        squash: squash ?? this.squash,
        noCommit: noCommit ?? this.noCommit,
        message: message == null ? this.message : message(),
        sign: sign == null ? this.sign : sign(),
      );

  /// Switches [f] to [value] keeping the options consistent: fast-forward
  /// only, no fast-forward and squash exclude each other, and a squash never
  /// commits (git behavior), so it forces "no commit" while it is on.
  MergeOptions withFlag(MergeFlag f, bool value) {
    if (f == MergeFlag.noCommit && squash) return this;
    final on = value;
    return switch (f) {
      MergeFlag.ffOnly => _copy(ffOnly: on, noFf: on ? false : noFf, squash: on ? false : squash,
          noCommit: on && squash ? false : noCommit),
      MergeFlag.noFf => _copy(ffOnly: on ? false : ffOnly, noFf: on, squash: on ? false : squash,
          noCommit: on && squash ? false : noCommit),
      MergeFlag.squash => _copy(ffOnly: on ? false : ffOnly, noFf: on ? false : noFf, squash: on, noCommit: on),
      MergeFlag.noCommit => _copy(noCommit: on),
    };
  }

  MergeOptions withMessage(String? message) => _copy(message: () => message);

  MergeOptions withSign(bool? sign) => _copy(sign: () => sign);

  /// Why these options cannot be used together, or null when they can.
  String? get error {
    if ([ffOnly, noFf, squash].where((x) => x).length > 1) {
      return 'Fast-forward only, No fast-forward and Squash cannot be combined';
    }
    if (squash && !noCommit) return 'A squash merge never creates a commit';
    return null;
  }

  /// Whether git will create a merge commit right away. [fastForward] tells
  /// whether HEAD is an ancestor of the merged revision.
  bool createsMergeCommit({required bool fastForward}) =>
      !squash && !noCommit && !ffOnly && (noFf || !fastForward);

  /// Whether the merge leaves the result in the index for the user to commit.
  bool get leavesChangesToCommit => squash || noCommit;

  /// `git merge` options (without the merged revision).
  List<String> get args => [
        if (ffOnly) '--ff-only',
        // A fast-forward cannot stop before committing: "No commit" alone implies --no-ff.
        if (noFf || (noCommit && !squash && !ffOnly)) '--no-ff',
        if (squash) '--squash',
        if (noCommit && !squash) '--no-commit',
        if (message != null && message!.trim().isNotEmpty) ...['-m', message!.trim()],
        if (sign == true) '--gpg-sign',
        if (sign == false) '--no-gpg-sign',
      ];
}

/// What the Merge dialog shows before merging.
class MergePreview {
  const MergePreview({required this.commits, required this.fastForward});

  /// Commits of the merged revision that are not on HEAD.
  final int commits;

  /// HEAD is an ancestor of the merged revision.
  final bool fastForward;

  bool get upToDate => commits == 0;
}

/// How a merge ended.
class MergeOutcome {
  const MergeOutcome({this.squashMessage, this.stopped = false});

  /// First lines of `SQUASH_MSG` after a squash merge (to commit by hand).
  final String? squashMessage;

  /// Git stopped before committing (`--no-commit` or conflicts): the merge
  /// is in progress.
  final bool stopped;
}
