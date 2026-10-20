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
