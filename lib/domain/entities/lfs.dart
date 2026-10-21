/// Content of a Git LFS pointer file: what git stores instead of the file.
class LfsPointer {
  const LfsPointer({required this.oid, required this.size, this.oidType = 'sha256'});

  /// Hash of the content (hex, without the `sha256:` prefix).
  final String oid;
  final String oidType;

  /// Size of the content in bytes.
  final int size;

  String get shortOid => oid.length > 10 ? oid.substring(0, 10) : oid;

  /// The pointer file as git stores it.
  String get text => 'version https://git-lfs.github.com/spec/v1\noid $oidType:$oid\nsize $size\n';

  @override
  bool operator ==(Object other) => other is LfsPointer && other.oid == oid && other.size == size;

  @override
  int get hashCode => Object.hash(oid, size);
}

/// A file of the checked out commit stored in LFS (`git lfs ls-files`).
class LfsFile {
  const LfsFile({required this.path, required this.oid, this.size, this.downloaded = true});

  final String path;

  /// Full oid with `--json` / `--long`, else the 10 first characters.
  final String oid;
  final int? size;

  /// The content is in the working tree (`*`), not only the pointer (`-`).
  final bool downloaded;
}

/// A lock on the LFS server (`git lfs locks --json`).
class LfsLock {
  const LfsLock({required this.id, required this.path, required this.owner, this.lockedAt, this.ours});

  final String id;
  final String path;

  /// Name of the user holding the lock (may be empty when the server does
  /// not tell).
  final String owner;
  final DateTime? lockedAt;

  /// Whether the current user holds it; null when unknown (the server does
  /// not support lock verification).
  final bool? ours;

  LfsLock withOurs(bool? value) => LfsLock(id: id, path: path, owner: owner, lockedAt: lockedAt, ours: value);
}

/// A pattern of a `.gitattributes` file (`git lfs track`).
class LfsTrackPattern {
  const LfsTrackPattern({
    required this.pattern,
    this.source = '.gitattributes',
    this.tracked = true,
    this.lockable = false,
  });

  /// The pattern as written in the attributes file (spaces escaped as
  /// `[[:space:]]`).
  final String pattern;

  /// Attributes file declaring it, relative to the work tree root.
  final String source;

  /// False for an excluded pattern (`-filter`).
  final bool tracked;
  final bool lockable;

  /// Directory of [source] (`''` for the root), with forward slashes.
  String get sourceDir {
    final s = source.replaceAll('\\', '/');
    final i = s.lastIndexOf('/');
    return i < 0 ? '' : s.substring(0, i);
  }

  /// `git lfs untrack` only edits the `.gitattributes` of the root.
  bool get inRootAttributes => sourceDir.isEmpty;

  /// The pattern with `[[:space:]]` shown as a space.
  String get display => pattern.replaceAll('[[:space:]]', ' ');
}

/// What `git lfs prune --dry-run --verbose` would delete.
class LfsPrunePreview {
  const LfsPrunePreview({required this.objects, required this.summary, required this.output});

  /// Objects that would be deleted: oid and size as git-lfs prints it.
  final List<({String oid, String size})> objects;

  /// Summary lines (`prune: ...`).
  final List<String> summary;

  /// Whole output, for display.
  final String output;
}

/// Pattern offered by "Track with LFS…".
class LfsPatternOption {
  const LfsPatternOption(this.label, this.patterns, {this.literal = false});

  /// e.g. `Exact path`, `By extension`, `By folder`.
  final String label;

  /// Patterns passed to `git lfs track` (repository relative).
  final List<String> patterns;

  /// The patterns are file names: glob characters in them are escaped
  /// (`git lfs track --filename`).
  final bool literal;
}
