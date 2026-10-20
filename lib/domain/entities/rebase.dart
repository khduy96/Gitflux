import 'git_models.dart';

/// What happens to a commit during an interactive rebase.
enum RebaseAction { pick, reword, edit, squash, fixup, drop }

extension RebaseActionInfo on RebaseAction {
  /// Shortcut key shown in the rebase dialog (P / R / E / S / F / D).
  String get key => name[0].toUpperCase();

  String get label => name[0].toUpperCase() + name.substring(1);

  /// Melds the commit into the previous one.
  bool get isMeld => this == RebaseAction.squash || this == RebaseAction.fixup;
}

/// One line of the rebase todo list.
sealed class RebaseEntry {
  const RebaseEntry();
}

/// A commit of the rewritten range.
class RebaseCommitEntry extends RebaseEntry {
  const RebaseCommitEntry({
    required this.commit,
    required this.message,
    this.action = RebaseAction.pick,
    this.newMessage,
  });

  final Commit commit;

  /// Full original commit message.
  final String message;
  final RebaseAction action;

  /// Message chosen by the user for a reword, or for the squash group this
  /// commit leads. Null keeps the default.
  final String? newMessage;

  String get hash => commit.hash;
  String get shortHash => commit.shortHash;
  String get subject => commit.subject;

  RebaseCommitEntry copyWith({
    RebaseAction? action,
    String? Function()? newMessage,
  }) =>
      RebaseCommitEntry(
        commit: commit,
        message: message,
        action: action ?? this.action,
        newMessage: newMessage != null ? newMessage() : this.newMessage,
      );
}

/// A line git generated that is kept as is (`label`, `reset`, `merge`,
/// `update-ref`, `exec`, `break`). Commits cannot be moved across it.
class RebaseStructuralEntry extends RebaseEntry {
  const RebaseStructuralEntry(this.line);

  final String line;
}

/// The todo git generated for "rebase from [target]", ready to be edited.
class RebasePlan {
  const RebasePlan({
    required this.target,
    required this.base,
    required this.head,
    required this.branch,
    required this.entries,
    this.rebaseMerges = false,
    this.pushedCount = 0,
    this.upstream,
  });

  /// Oldest commit of the range.
  final String target;

  /// Parent of [target], or null when the range starts at the root commit.
  final String? base;

  /// HEAD when the plan was made; the rebase is refused if it moved.
  final String head;
  final String branch;

  /// Todo lines in git order (oldest first).
  final List<RebaseEntry> entries;

  /// The range contains merge commits (`--rebase-merges`).
  final bool rebaseMerges;

  /// Commits of the range that are already on the upstream branch.
  final int pushedCount;
  final String? upstream;

  List<RebaseCommitEntry> get commits =>
      entries.whereType<RebaseCommitEntry>().toList();
}

/// How a started rebase ended.
class RebaseOutcome {
  const RebaseOutcome({required this.stopped, this.output = ''});

  /// Git stopped (conflict, `edit`, failing hook or exec) and the repository
  /// is in the rebasing state.
  final bool stopped;

  /// What git printed.
  final String output;
}

/// Position of a rebase in progress.
class RebaseProgress {
  const RebaseProgress({
    required this.done,
    required this.total,
    this.stoppedForEdit = false,
    this.stoppedHash,
    this.stoppedSubject,
  });

  /// Number of todo commands processed (`rebase-merge/msgnum`).
  final int done;

  /// Number of todo commands (`rebase-merge/end`).
  final int total;

  /// Git stopped after an `edit` so the commit can be amended.
  final bool stoppedForEdit;
  final String? stoppedHash;
  final String? stoppedSubject;

  String? get stoppedShort =>
      stoppedHash == null || stoppedHash!.length < 8 ? stoppedHash : stoppedHash!.substring(0, 8);
}
