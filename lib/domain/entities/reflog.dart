/// One entry of a reflog (`git reflog show`), newest first.
class ReflogEntry {
  const ReflogEntry({
    required this.selector,
    required this.index,
    required this.hash,
    required this.action,
    required this.message,
    required this.time,
    this.exists = true,
  });

  /// Selector as git prints it, e.g. `HEAD@{3}`.
  final String selector;

  /// Position in the reflog (the `n` of `@{n}`).
  final int index;

  /// Commit the ref pointed to after the operation.
  final String hash;

  /// Operation: the part of the reflog subject before `: `, e.g. `commit`,
  /// `rebase (finish)`, `reset`, `checkout`, `commit (amend)`.
  final String action;

  /// Rest of the reflog subject (may be empty).
  final String message;

  /// When the entry was written (not the commit date).
  final DateTime time;

  /// False when the commit is no longer in the repository (garbage
  /// collected): shown dimmed, without actions.
  final bool exists;

  String get shortHash => hash.length > 8 ? hash.substring(0, 8) : hash;

  /// Full reflog subject.
  String get subject => message.isEmpty ? action : '$action: $message';
}
