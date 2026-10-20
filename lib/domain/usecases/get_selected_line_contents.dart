import 'dart:convert';

import '../entities/git_models.dart';
import '../errors.dart';
import '../logic/line_selection.dart';
import '../repositories/git_repository.dart';

/// What to commit for a file that has a line selection.
typedef SelectedContent = ({String path, String content, ParsedDiff parsed, LineSelection sel});

/// Builds the content to commit for every change that has a line selection.
class GetSelectedLineContents {
  const GetSelectedLineContents(this._repo);

  final GitRepository _repo;

  /// Throws [StaleSelectionException] when a file changed since selection.
  Future<List<SelectedContent>> call(
      List<FileChange> changes, Map<String, LineSelection> selections) async {
    final result = <SelectedContent>[];
    for (final c in changes) {
      final sel = selections[c.path];
      if (sel == null) continue;
      final parsed = parseDiff(await _repo.fileDiff(c.path));
      if (parsed.signature != sel.signature) throw StaleSelectionException(c.path);
      final head = await _repo.fileBytes(const CommitRev('HEAD'), c.path);
      final oldText = head == null ? '' : utf8.decode(head, allowMalformed: true);
      result.add((path: c.path, content: buildContent(oldText, parsed, sel.excluded), parsed: parsed, sel: sel));
    }
    return result;
  }
}
