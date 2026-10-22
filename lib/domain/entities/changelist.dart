/// Id of the list that always exists (renameable, not deletable).
const defaultChangelistId = 'default';

/// Name of the default list when it has to be created.
const defaultChangelistName = 'Changes';

/// A named group of tracked changes (Android Studio changelist), stored in
/// `changelists.json` (format shared with the VS Code extension).
class Changelist {
  const Changelist({
    required this.id,
    required this.name,
    this.comment = '',
    this.files = const [],
    this.raw = const {},
  });

  /// `default`, or `yyyyMMdd-HHmmss-<6 hex>` (as shelf ids).
  final String id;
  final String name;

  /// Draft commit message of the list.
  final String comment;

  /// Repository relative paths with forward slashes.
  final List<String> files;

  /// The fields as read from the file, unknown ones included, in file
  /// order: rewriting the file keeps them and their order.
  final Map<String, Object?> raw;

  bool get isDefault => id == defaultChangelistId;

  Changelist copyWith({String? name, String? comment, List<String>? files}) => Changelist(
        id: id,
        name: name ?? this.name,
        comment: comment ?? this.comment,
        files: files ?? this.files,
        raw: raw,
      );
}

/// Every changelist of a worktree and which one is active.
class Changelists {
  const Changelists({
    this.version = 1,
    this.active = defaultChangelistId,
    this.lists = const [Changelist(id: defaultChangelistId, name: defaultChangelistName)],
    this.raw = const {},
  });

  final int version;

  /// Id of the list new changes go to.
  final String active;
  final List<Changelist> lists;

  /// The top level fields as read from the file (unknown ones included), in
  /// file order.
  final Map<String, Object?> raw;

  Changelist? byId(String id) => lists.where((l) => l.id == id).firstOrNull;

  /// The active list (the default one when [active] is unknown).
  Changelist get activeList => byId(active) ?? byId(defaultChangelistId) ?? lists.first;

  /// The list holding [path], or null.
  Changelist? listOf(String path) => lists.where((l) => l.files.contains(path)).firstOrNull;

  /// The list named [name] (trimmed, ignoring case), or null.
  Changelist? byName(String name) {
    final n = name.trim().toLowerCase();
    return lists.where((l) => l.name.trim().toLowerCase() == n).firstOrNull;
  }

  Changelists copyWith({String? active, List<Changelist>? lists}) => Changelists(
        version: version,
        active: active ?? this.active,
        lists: lists ?? this.lists,
        raw: raw,
      );
}
