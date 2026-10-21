import 'git_models.dart';

/// An entry of a patch, from `git apply --numstat --summary`.
class PatchFile {
  const PatchFile({required this.path, required this.type, this.oldPath, this.added, this.deleted});

  /// Path after the change; the deleted path for a deletion (the name
  /// `git apply --numstat` prints).
  final String path;

  /// Path before a rename or copy.
  final String? oldPath;
  final ChangeType type;

  /// Added / deleted lines; null for a binary file.
  final int? added;
  final int? deleted;

  bool get binary => added == null;

  String get fileName {
    final i = path.lastIndexOf('/');
    return i < 0 ? path : path.substring(i + 1);
  }

  String get directory {
    final i = path.lastIndexOf('/');
    return i < 0 ? '' : path.substring(0, i);
  }

  PatchFile copyWith({String? oldPath, ChangeType? type}) => PatchFile(
        path: path,
        type: type ?? this.type,
        oldPath: oldPath ?? this.oldPath,
        added: added,
        deleted: deleted,
      );
}

/// Patch made from the working tree (`git diff --binary`) and its files.
typedef WorkingTreePatch = ({List<int> patch, List<FileChange> files});

/// Result of applying a patch to the working tree.
class PatchApplyResult {
  const PatchApplyResult({this.conflicts = const [], this.output = ''});

  /// Paths left with conflict markers.
  final List<String> conflicts;

  /// What git printed.
  final String output;

  bool get clean => conflicts.isEmpty;
}

/// What "Apply Patch…" shows before applying.
class PatchPreview {
  const PatchPreview({
    required this.mailbox,
    required this.files,
    required this.applies,
    this.subjects = const [],
    this.conflicts = const [],
    this.checkOutput = '',
  });

  /// Made by `git format-patch`: can be applied as commits (`git am`).
  final bool mailbox;

  /// Commit subjects of a mailbox.
  final List<String> subjects;
  final List<PatchFile> files;

  /// `git apply --check --3way` passed.
  final bool applies;

  /// Paths the check reported as conflicting (applied with conflicts).
  final List<String> conflicts;
  final String checkOutput;
}
