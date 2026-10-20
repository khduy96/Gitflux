import '../entities/ai_config.dart';
import '../entities/commit_message_request.dart';
import '../entities/git_models.dart';
import '../errors.dart';
import '../logic/line_selection.dart';
import '../repositories/commit_message_generator.dart';
import '../repositories/git_repository.dart';
import 'get_selected_line_contents.dart';

/// A generated message and the files whose diff was too large to send.
typedef GeneratedCommitMessage = ({String message, List<String> omitted});

/// Writes a commit message for the changes about to be committed (or the
/// commit being amended) with the configured AI model.
class GenerateCommitMessage {
  GenerateCommitMessage(this._repo, this._createGenerator)
      : _selectedContents = GetSelectedLineContents(_repo);

  final GitRepository _repo;
  final CommitMessageGeneratorFactory _createGenerator;
  final GetSelectedLineContents _selectedContents;
  CommitMessageGenerator? _ai;

  static const _maxFileDiff = 40000;
  static const _maxTotalDiff = 150000;

  void cancel() => _ai?.cancel();

  /// [amend] includes the last commit's own changes. [onText] receives the
  /// message while it is streamed. Throws [AiException].
  Future<GeneratedCommitMessage> call({
    required RepoStatus status,
    required List<FileChange> changes,
    required Map<String, LineSelection> lineSelections,
    required AiConfig config,
    required void Function(String text) onText,
    bool amend = false,
    void Function(String info)? onInfo,
  }) async {
    String? base = status.hasCommits ? 'HEAD' : null;
    final files = [...changes];
    String? amendOf;
    if (amend) {
      amendOf = await _repo.lastCommitMessage();
      final hasParent = await _repo.refExists('HEAD~1');
      base = hasParent ? 'HEAD~1' : null;
      final headFiles = await _repo.changedFiles(hasParent ? 'HEAD~1' : null, 'HEAD');
      final known = files.map((f) => f.path).toSet();
      files.addAll(headFiles.where((f) => known.add(f.path)));
    }
    if (base == null) {
      // No parent commit: everything is a new file.
      for (var i = 0; i < files.length; i++) {
        files[i] = FileChange(path: files[i].path, type: ChangeType.added);
      }
    }

    final perFile = await _repo.diffPerFile(
      base == null
          ? files.map((f) => FileChange(path: f.path, type: ChangeType.untracked)).toList()
          : files,
      base: base,
    );
    // Files committed line by line: describe only the selected lines.
    if (!amend && lineSelections.isNotEmpty) {
      try {
        for (final x in await _selectedContents(changes, lineSelections)) {
          perFile[x.path] = filteredPatch(x.path, x.parsed, x.sel.excluded);
        }
      } on StaleSelectionException {
        // Out of date: the full diff is used instead.
      }
    }
    final diff = StringBuffer();
    final omitted = <String>[];
    for (final entry in perFile.entries) {
      final text = entry.value;
      if (text.length > _maxFileDiff || diff.length + text.length > _maxTotalDiff) {
        omitted.add(entry.key);
        diff.writeln('diff of ${entry.key} omitted: too large '
            '(${'\n'.allMatches(text).length} lines)');
      } else {
        diff.write(text);
      }
    }

    final req = CommitMessageRequest(
      branch: status.branch ?? '',
      files: [for (final f in files) '${f.type.label}: ${f.path}'],
      diff: diff.toString(),
      recentSubjects: status.hasCommits ? await _repo.recentSubjects() : const [],
      language: config.language,
      instructions: config.instructions,
      amendOf: amendOf,
    );

    final ai = _ai = _createGenerator(config.provider, apiKey: config.apiKey, model: config.model);
    onInfo?.call('Generating commit message with ${config.model} '
        '(${files.length} files, ${diff.length} chars of diff)…');
    try {
      return (message: await ai.generate(req, onText: onText), omitted: omitted);
    } finally {
      _ai = null;
    }
  }
}
