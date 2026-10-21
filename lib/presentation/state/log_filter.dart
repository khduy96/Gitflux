import '../../domain/entities/log_query.dart';
import '../../domain/logic/log_filters.dart';

/// What the search box of the log looks for.
enum LogTextMode {
  /// Subject, hash, author and refs of the loaded commits (client side).
  message,

  /// Commits whose changes contain the text (`git log -S` / `-G`).
  changes,
}

class LogFilter {
  const LogFilter({
    this.branch,
    this.path,
    this.text = '',
    this.textMode = LogTextMode.message,
    this.regex = false,
    this.author,
    this.date = const DateFilter(),
  });

  /// Ref to show (null = all branches).
  final String? branch;

  /// Show history for this path only.
  final String? path;

  /// Text of the search box, see [textMode].
  final String text;
  final LogTextMode textMode;

  /// Content search with a regular expression (`-G`) instead of a plain
  /// text (`-S`).
  final bool regex;

  /// "User" filter (null = all).
  final AuthorFilter? author;

  /// "Date" filter.
  final DateFilter date;

  /// Minimum length of a content search.
  static const minChangesLength = 2;

  /// Text of the client side filter (message mode only).
  String get messageText => textMode == LogTextMode.message ? text.trim() : '';

  /// Content searched in git, null when not searching by content.
  String? get changesText =>
      textMode == LogTextMode.changes && text.trim().length >= minChangesLength ? text : null;

  /// Whether git loads only some commits of the history (author, date or
  /// content filter).
  bool get filtersHistory => author != null || date.isActive || changesText != null;

  /// Whether the shown commits are a subset of the history, so the graph
  /// would be wrong.
  bool get hidesGraph => messageText.isNotEmpty || filtersHistory;

  bool get hasFilters => branch != null || path != null || text.trim().isNotEmpty || author != null || date.isActive;

  /// Options of `git log` at [now].
  LogQuery query(DateTime now) {
    final (:since, :until) = dateRange(date, now);
    return LogQuery(
      authors: author?.patterns ?? const [],
      since: since,
      until: until,
      changes: changesText,
      changesRegex: regex,
    );
  }

  /// Whether the commits to load differ from [other] (anything but the
  /// client side text filter).
  bool loadsDifferently(LogFilter other) =>
      branch != other.branch ||
      path != other.path ||
      author != other.author ||
      date != other.date ||
      changesText != other.changesText ||
      (changesText != null && regex != other.regex);

  LogFilter copyWith({
    String? Function()? branch,
    String? Function()? path,
    String? text,
    LogTextMode? textMode,
    bool? regex,
    AuthorFilter? Function()? author,
    DateFilter? date,
  }) =>
      LogFilter(
        branch: branch != null ? branch() : this.branch,
        path: path != null ? path() : this.path,
        text: text ?? this.text,
        textMode: textMode ?? this.textMode,
        regex: regex ?? this.regex,
        author: author != null ? author() : this.author,
        date: date ?? this.date,
      );
}
