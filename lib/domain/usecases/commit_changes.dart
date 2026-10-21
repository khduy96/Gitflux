import '../entities/git_models.dart';
import '../errors.dart';
import '../logic/line_selection.dart';
import '../repositories/git_repository.dart';
import 'get_selected_line_contents.dart';

/// A checked commit, ready to run.
class PreparedCommit {
  const PreparedCommit({
    required this.message,
    required this.paths,
    required this.partial,
    required this.amend,
    required this.inMerge,
    this.signOff = false,
    this.author,
    this.sign,
  });

  final String message;

  /// All paths of the included changes (old paths of renames too).
  final List<String> paths;

  /// Files committed with their selected lines only: path → content.
  final Map<String, String> partial;
  final bool amend;

  /// A merge / rebase / cherry-pick is being concluded.
  final bool inMerge;
  final bool signOff;
  final String? author;

  /// true `-S`, false `--no-gpg-sign`, null: `commit.gpgsign`.
  final bool? sign;
}

/// Commits the included changes, whole files or selected lines.
class CommitChanges {
  CommitChanges(this._repo) : _selectedContents = GetSelectedLineContents(_repo);

  final GitRepository _repo;
  final GetSelectedLineContents _selectedContents;

  /// Checks the commit rules and computes the partial contents. Throws
  /// [CommitRejected], or [StaleSelectionException] when a line selection
  /// is out of date.
  Future<PreparedCommit> prepare({
    required RepoStatus status,
    required String message,
    required List<FileChange> changes,
    required Map<String, LineSelection> lineSelections,
    bool amend = false,
    bool signOff = false,
    String? author,
    bool? sign,
  }) async {
    final inMerge = status.state != RepoState.normal;
    if (message.isEmpty) throw CommitRejected('Commit message is empty');
    if (changes.isEmpty && !amend && !inMerge) {
      throw CommitRejected('No changes selected for commit');
    }
    if (status.conflicts.isNotEmpty) {
      throw CommitRejected('Resolve all conflicts before committing');
    }
    final hasLines = changes.any((c) => lineSelections.containsKey(c.path));
    if (hasLines && inMerge) {
      throw CommitRejected('Cannot commit selected lines during a merge or rebase',
          details: 'Include whole files instead.');
    }
    return PreparedCommit(
      message: message,
      paths: changes.expand((c) => c.allPaths).toSet().toList(),
      partial: hasLines
          ? {for (final x in await _selectedContents(changes, lineSelections)) x.path: x.content}
          : const {},
      amend: amend,
      inMerge: inMerge,
      signOff: signOff,
      author: author,
      sign: sign,
    );
  }

  Future<void> call(PreparedCommit c) => c.partial.isNotEmpty
      ? _repo.commitSelected(
          message: c.message,
          fullPaths: c.paths.where((p) => !c.partial.containsKey(p)).toList(),
          partial: c.partial,
          amend: c.amend,
          signOff: c.signOff,
          author: c.author,
          sign: c.sign,
        )
      : _repo.commit(
          message: c.message,
          paths: c.paths,
          amend: c.amend,
          signOff: c.signOff,
          author: c.author,
          sign: c.sign,
          partial: !c.inMerge,
        );
}
