/// Filters of the log run by git itself, so commits outside the loaded
/// window are found too.
class LogQuery {
  const LogQuery({
    this.authors = const [],
    this.since,
    this.until,
    this.changes,
    this.changesRegex = false,
  });

  /// Commits whose author name or email contains any of these texts
  /// (case-insensitive).
  final List<String> authors;

  /// Committed at or after / at or before.
  final DateTime? since;
  final DateTime? until;

  /// Commits whose diff adds or removes this text (`-S`), or a line
  /// matching it as a regular expression when [changesRegex] (`-G`).
  final String? changes;
  final bool changesRegex;

  bool get isEmpty => authors.isEmpty && since == null && until == null && changes == null;

  @override
  bool operator ==(Object other) =>
      other is LogQuery &&
      other.authors.join('\x00') == authors.join('\x00') &&
      other.since == since &&
      other.until == until &&
      other.changes == changes &&
      other.changesRegex == changesRegex;

  @override
  int get hashCode => Object.hash(authors.join('\x00'), since, until, changes, changesRegex);
}

/// "User" filter of the log.
class AuthorFilter {
  const AuthorFilter(this.label, this.patterns);

  /// Shown in the filter bar ("Me" or the name typed / picked).
  final String label;

  /// Texts matched against the author name or email; any may match.
  final List<String> patterns;

  @override
  bool operator ==(Object other) =>
      other is AuthorFilter && other.label == label && other.patterns.join('\x00') == patterns.join('\x00');

  @override
  int get hashCode => Object.hash(label, patterns.join('\x00'));
}

enum DatePreset { all, last24Hours, last7Days, last30Days, custom }

/// "Date" filter of the log.
class DateFilter {
  const DateFilter([this.preset = DatePreset.all, this.from, this.to]);

  const DateFilter.custom({this.from, this.to}) : preset = DatePreset.custom;

  final DatePreset preset;

  /// First and last day of a [DatePreset.custom] range (either optional).
  final DateTime? from;
  final DateTime? to;

  bool get isActive => preset != DatePreset.all && (preset != DatePreset.custom || from != null || to != null);

  @override
  bool operator ==(Object other) =>
      other is DateFilter && other.preset == preset && other.from == from && other.to == to;

  @override
  int get hashCode => Object.hash(preset, from, to);
}

/// A commit author of the log with the number of loaded commits.
class LogAuthor {
  const LogAuthor(this.name, this.email, this.count);

  final String name;

  /// Most used email of [name].
  final String email;
  final int count;
}
