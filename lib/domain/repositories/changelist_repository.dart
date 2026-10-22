import '../entities/changelist.dart';

/// Changelists of one worktree, kept in `changelists.json` under
/// `git rev-parse --git-path git-tools` (the format shared with the VS Code
/// extension, which may change the file at any time). Implemented by the
/// data layer.
abstract interface class ChangelistRepository {
  /// The lists as saved (only the default list when there is no file).
  /// Throws [FormatException] when the file is damaged.
  Future<Changelists> read();

  /// Reads the file again, applies [change] and writes the result
  /// atomically when it differs. Calls are serialized. Returns the saved
  /// lists.
  Future<Changelists> update(Changelists Function(Changelists current) change);
}
