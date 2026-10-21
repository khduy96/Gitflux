import 'git_models.dart';

/// Status of a shelved file, stored as one letter in `shelf.json`.
enum ShelfFileStatus {
  modified('M'),
  added('A'),
  deleted('D'),
  renamed('R');

  const ShelfFileStatus(this.letter);

  final String letter;

  static ShelfFileStatus? fromLetter(String letter) =>
      values.where((s) => s.letter == letter).firstOrNull;

  /// Status in a shelf of a change of the patch (type changes count as
  /// modifications, copies as additions).
  static ShelfFileStatus of(ChangeType type) => switch (type) {
        ChangeType.added || ChangeType.untracked || ChangeType.copied => ShelfFileStatus.added,
        ChangeType.deleted => ShelfFileStatus.deleted,
        ChangeType.renamed => ShelfFileStatus.renamed,
        _ => ShelfFileStatus.modified,
      };

  ChangeType get changeType => switch (this) {
        ShelfFileStatus.modified => ChangeType.modified,
        ShelfFileStatus.added => ChangeType.added,
        ShelfFileStatus.deleted => ChangeType.deleted,
        ShelfFileStatus.renamed => ChangeType.renamed,
      };
}

/// One file of a shelf: an entry of its patch.
class ShelvedFile {
  const ShelvedFile({required this.path, this.oldPath, required this.status});

  ShelvedFile.fromChange(FileChange c)
      : path = c.path,
        oldPath = c.type == ChangeType.renamed ? c.oldPath : null,
        status = ShelfFileStatus.of(c.type);

  /// Path after the change (the deleted path for a deletion).
  final String path;

  /// Path before a rename.
  final String? oldPath;
  final ShelfFileStatus status;

  String get fileName {
    final i = path.lastIndexOf('/');
    return i < 0 ? path : path.substring(i + 1);
  }

  String get directory {
    final i = path.lastIndexOf('/');
    return i < 0 ? '' : path.substring(0, i);
  }

  List<String> get allPaths => [path, ?oldPath];

  FileChange get change => FileChange(path: path, oldPath: oldPath, type: status.changeType);

  @override
  bool operator ==(Object other) =>
      other is ShelvedFile && other.path == path && other.oldPath == oldPath && other.status == status;

  @override
  int get hashCode => Object.hash(path, oldPath, status);
}

/// Changes put aside per file (Android Studio "Shelve Changes"): a named
/// patch relative to [base], independent of git's stash stack.
class Shelf {
  const Shelf({
    required this.id,
    required this.name,
    required this.created,
    required this.base,
    required this.files,
    this.branch,
  });

  /// Folder name, `yyyyMMdd-HHmmss-<6 hex>`.
  final String id;
  final String name;

  /// When the shelf was created (UTC).
  final DateTime created;

  /// HEAD commit when the changes were shelved; the patch applies to it.
  final String base;

  /// Branch the changes were shelved from (null when HEAD was detached).
  final String? branch;
  final List<ShelvedFile> files;

  /// Ref that keeps [base] (and the blobs the 3-way apply needs) alive.
  String get ref => 'refs/git-tools/shelf/$id';

  String get shortBase => base.length > 8 ? base.substring(0, 8) : base;

  Shelf copyWith({String? name, List<ShelvedFile>? files}) => Shelf(
        id: id,
        name: name ?? this.name,
        created: created,
        base: base,
        branch: branch,
        files: files ?? this.files,
      );
}

/// Result of "Shelve Changes".
class ShelveOutcome {
  const ShelveOutcome(this.shelf, {this.skipped = const []});

  final Shelf shelf;

  /// Submodules and nested repositories left out.
  final List<String> skipped;
}

/// Result of "Unshelve" / "Apply" of a shelf.
class UnshelveOutcome {
  const UnshelveOutcome({required this.applied, required this.conflicted, required this.shelf});

  /// Files applied cleanly.
  final List<ShelvedFile> applied;

  /// Files left with conflict markers (and unmerged index entries); they
  /// stay in the shelf.
  final List<ShelvedFile> conflicted;

  /// The shelf after removing the applied files, null when it was deleted.
  final Shelf? shelf;
}
