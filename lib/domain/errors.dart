/// A git command exited with a non-zero code.
class GitException implements Exception {
  GitException(this.args, this.exitCode, this.stderr, this.stdout);

  final List<String> args;
  final int exitCode;
  final String stderr;
  final String stdout;

  String get message {
    final err = stderr.trim();
    if (err.isNotEmpty) return err;
    final out = stdout.trim();
    if (out.isNotEmpty) return out;
    return 'git ${args.join(' ')} failed with exit code $exitCode';
  }

  @override
  String toString() => message;
}

/// Raised when an AI call fails, is declined or is cancelled.
class AiException implements Exception {
  AiException(this.message, {this.cancelled = false});

  final String message;
  final bool cancelled;

  @override
  String toString() => message;
}

/// The diff of a file changed after its lines were selected.
class StaleSelectionException implements Exception {
  StaleSelectionException(this.path);
  final String path;

  @override
  String toString() => '$path changed after its lines were selected. Review the selection again.';
}

/// A commit was not started because the input breaks a rule (empty
/// message, unresolved conflicts, ...).
class CommitRejected implements Exception {
  CommitRejected(this.title, {this.details});

  final String title;
  final String? details;

  @override
  String toString() => details == null ? title : '$title: $details';
}

/// An interactive rebase cannot be started (wrong repository state, invalid
/// todo, commit outside the current branch, ...).
class RebaseRejected implements Exception {
  RebaseRejected(this.title, {this.details});

  final String title;
  final String? details;

  @override
  String toString() => details == null ? title : '$title: $details';
}

/// Changes cannot be shelved or unshelved now (operation in progress,
/// unresolved conflicts, nothing to shelve, ...).
class ShelfRejected implements Exception {
  ShelfRejected(this.title, {this.details});

  final String title;
  final String? details;

  @override
  String toString() => details == null ? title : '$title: $details';
}

/// A patch cannot be created or applied (wrong repository state, empty
/// patch, merge commits only, ...).
class PatchRejected implements Exception {
  PatchRejected(this.title, {this.details});

  final String title;
  final String? details;

  @override
  String toString() => details == null ? title : '$title: $details';
}

/// A merge cannot be started (contradicting options, operation in
/// progress, ...).
class MergeRejected implements Exception {
  MergeRejected(this.title, {this.details});

  final String title;
  final String? details;

  @override
  String toString() => details == null ? title : '$title: $details';
}

/// Nothing to clean, or the selection cannot be cleaned.
class CleanRejected implements Exception {
  CleanRejected(this.title, {this.details});

  final String title;
  final String? details;

  @override
  String toString() => details == null ? title : '$title: $details';
}

/// A bisect step cannot be done (no session, local changes block the
/// checkout, ...).
class BisectRejected implements Exception {
  BisectRejected(this.title, {this.details});

  final String title;
  final String? details;

  @override
  String toString() => details == null ? title : '$title: $details';
}

/// A changelist cannot be created, renamed or deleted (duplicate name, the
/// default list, damaged changelists.json, ...).
class ChangelistRejected implements Exception {
  ChangelistRejected(this.title, {this.details});

  final String title;
  final String? details;

  @override
  String toString() => details == null ? title : '$title: $details';
}
