import '../entities/git_models.dart';
import '../entities/log_query.dart';

/// Distinct authors of [commits] (by name, ignoring case), most commits
/// first.
List<LogAuthor> authorsByCount(Iterable<Commit> commits) {
  final names = <String, String>{};
  final counts = <String, int>{};
  final emails = <String, Map<String, int>>{};
  for (final c in commits) {
    final name = c.authorName.trim();
    if (name.isEmpty && c.authorEmail.isEmpty) continue;
    final key = (name.isEmpty ? c.authorEmail : name).toLowerCase();
    names.putIfAbsent(key, () => name.isEmpty ? c.authorEmail : name);
    counts[key] = (counts[key] ?? 0) + 1;
    final e = emails.putIfAbsent(key, () => {});
    e[c.authorEmail] = (e[c.authorEmail] ?? 0) + 1;
  }
  final result = [
    for (final key in names.keys)
      LogAuthor(
        names[key]!,
        (emails[key]!.entries.toList()..sort((a, b) => b.value.compareTo(a.value))).first.key,
        counts[key]!,
      ),
  ];
  result.sort((a, b) {
    final byCount = b.count.compareTo(a.count);
    return byCount != 0 ? byCount : a.name.toLowerCase().compareTo(b.name.toLowerCase());
  });
  return result;
}

/// Time range of [f] at [now]. A custom range covers whole days.
({DateTime? since, DateTime? until}) dateRange(DateFilter f, DateTime now) => switch (f.preset) {
      DatePreset.all => (since: null, until: null),
      DatePreset.last24Hours => (since: now.subtract(const Duration(hours: 24)), until: null),
      DatePreset.last7Days => (since: now.subtract(const Duration(days: 7)), until: null),
      DatePreset.last30Days => (since: now.subtract(const Duration(days: 30)), until: null),
      DatePreset.custom => (
          since: f.from == null ? null : DateTime(f.from!.year, f.from!.month, f.from!.day),
          until: f.to == null ? null : DateTime(f.to!.year, f.to!.month, f.to!.day, 23, 59, 59),
        ),
    };

String dateFilterLabel(DateFilter f) {
  String day(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year}';
  return switch (f.preset) {
    DatePreset.all => 'All',
    DatePreset.last24Hours => 'Last 24 hours',
    DatePreset.last7Days => 'Last 7 days',
    DatePreset.last30Days => 'Last 30 days',
    DatePreset.custom => f.from != null && f.to != null
        ? '${day(f.from!)} – ${day(f.to!)}'
        : f.from != null
            ? 'Since ${day(f.from!)}'
            : f.to != null
                ? 'Until ${day(f.to!)}'
                : 'All',
  };
}

/// Escapes [text] for a POSIX basic regular expression (`--author` with
/// `--basic-regexp`), so it matches literally.
String escapeBasicRegex(String text) => text.replaceAllMapped(RegExp(r'[\\.\[\]*^$]'), (m) => '\\${m[0]}');
