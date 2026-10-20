import '../entities/console_entry.dart';
import 'git_repository.dart';

/// Git operations that are not bound to an opened repository.
abstract interface class GitService {
  /// Version of the installed git, or null when git cannot be run.
  Future<String?> version();

  /// Returns the top level directory of the repository containing [dir],
  /// or null when [dir] is not inside a git work tree.
  Future<String?> findRoot(String dir);

  Future<void> init(String dir);

  Future<void> clone(
    String url,
    String parentDir,
    String folderName, {
    void Function(ConsoleEntry)? onConsole,
    bool recurseSubmodules = true,
  });

  /// The repository whose work tree is [root].
  GitRepository open(String root, {void Function(ConsoleEntry)? onConsole});
}
