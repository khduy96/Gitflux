/// Options of "Clean Working Tree" (`git clean`).
class CleanOptions {
  const CleanOptions({this.includeIgnored = false, this.directories = true});

  /// `-x`: also remove files ignored by .gitignore.
  final bool includeIgnored;

  /// `-d`: remove untracked directories as a whole.
  final bool directories;

  CleanOptions copyWith({bool? includeIgnored, bool? directories}) => CleanOptions(
        includeIgnored: includeIgnored ?? this.includeIgnored,
        directories: directories ?? this.directories,
      );

  /// `git clean` options besides `-n` / `-f`.
  List<String> get args => [if (directories) '-d', if (includeIgnored) '-x'];
}

/// A file or directory `git clean` would remove.
class CleanEntry {
  const CleanEntry({
    required this.path,
    this.isDirectory = false,
    this.nestedRepo = false,
    this.ignored = false,
  });

  /// Path relative to the work tree root, without trailing slash.
  final String path;
  final bool isDirectory;

  /// A repository of its own: only removed with `-ff`, unchecked by default.
  final bool nestedRepo;

  /// Ignored by .gitignore (listed only with `-x`).
  final bool ignored;

  /// Pathspec passed to `git clean` (directories keep the trailing slash).
  String get pathspec => isDirectory ? '$path/' : path;

  String get fileName {
    final i = path.lastIndexOf('/');
    return i < 0 ? path : path.substring(i + 1);
  }

  String get directory {
    final i = path.lastIndexOf('/');
    return i < 0 ? '' : path.substring(0, i);
  }

  @override
  bool operator ==(Object other) =>
      other is CleanEntry &&
      other.path == path &&
      other.isDirectory == isDirectory &&
      other.nestedRepo == nestedRepo &&
      other.ignored == ignored;

  @override
  int get hashCode => Object.hash(path, isDirectory, nestedRepo, ignored);

  @override
  String toString() => 'CleanEntry($pathspec${nestedRepo ? ', nested' : ''}${ignored ? ', ignored' : ''})';
}
