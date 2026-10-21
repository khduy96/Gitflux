import '../entities/reflog.dart';

const _us = '\x1f';

/// `--format` of `git reflog show -z` read by [parseReflog]: selector, commit
/// and subject. The subject is last so it may contain anything.
const reflogFormat = '%gd%x1f%H%x1f%gs';

/// `--format` of the second `git reflog show -z --date=unix` run: the
/// selector then holds the time of the entry (`HEAD@{1700000000}`).
const reflogTimeFormat = '%gd';

/// Parses the two `git reflog show -z` outputs (same walk, so the records
/// line up): [entries] with [reflogFormat] and [times] with
/// [reflogTimeFormat] and `--date=unix`.
List<ReflogEntry> parseReflog(String entries, String times) {
  final timeRecords = _records(times);
  final result = <ReflogEntry>[];
  final records = _records(entries);
  for (var i = 0; i < records.length; i++) {
    final f = records[i].split(_us);
    if (f.length < 3) continue;
    final index = reflogIndex(f[0]);
    if (index == null) continue;
    final (:action, :message) = splitReflogSubject(f.sublist(2).join(_us));
    final secs = i < timeRecords.length ? reflogIndex(timeRecords[i]) : null;
    result.add(ReflogEntry(
      selector: f[0],
      index: index,
      hash: f[1],
      action: action,
      message: message,
      time: DateTime.fromMillisecondsSinceEpoch((secs ?? 0) * 1000),
    ));
  }
  return result;
}

List<String> _records(String out) => [
      for (final r in out.split('\x00'))
        if (r.trim().isNotEmpty) r.replaceFirst(RegExp(r'^\s+'), ''),
    ];

/// The `n` of a selector such as `HEAD@{n}` (or the time with
/// `--date=unix`), null when there is none.
int? reflogIndex(String selector) {
  final m = RegExp(r'@\{(\d+)\}$').firstMatch(selector.trim());
  return m == null ? null : int.tryParse(m.group(1)!);
}

/// Splits a reflog subject such as `commit (amend): Fix: typo` into the
/// operation (`commit (amend)`) and the message (`Fix: typo`). A subject
/// whose first line has no `: ` is all operation.
({String action, String message}) splitReflogSubject(String subject) {
  final s = subject.trim();
  final firstLine = s.split('\n').first;
  var i = firstLine.indexOf(': ');
  if (i < 0 && firstLine.endsWith(':')) i = firstLine.length - 1;
  if (i <= 0) {
    return (action: s.replaceAll(RegExp(r'\s+'), ' '), message: '');
  }
  return (action: s.substring(0, i).trim(), message: s.substring(i + 1).trim());
}

/// Entries of a raw reflog file (`.git/logs/HEAD`, oldest first) by index,
/// newest = 0. Each line is `<old> <new> <name> <<email>> <time> <tz>\t<msg>`.
/// [name] is the selector prefix, e.g. `HEAD`.
Map<int, ReflogEntry> parseRawReflog(String content, String name) {
  final lines = content.split('\n').map((l) => l.replaceAll('\r', '')).where((l) => l.isNotEmpty).toList();
  final result = <int, ReflogEntry>{};
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    final tab = line.indexOf('\t');
    final head = tab < 0 ? line : line.substring(0, tab);
    final m = RegExp(r'^([0-9a-f]+) ([0-9a-f]+) .*> (\d+) [+-]\d{4}$').firstMatch(head);
    if (m == null) continue;
    final index = lines.length - 1 - i;
    final (:action, :message) = splitReflogSubject(tab < 0 ? '' : line.substring(tab + 1));
    result[index] = ReflogEntry(
      selector: '$name@{$index}',
      index: index,
      hash: m.group(2)!,
      action: action,
      message: message,
      time: DateTime.fromMillisecondsSinceEpoch(int.parse(m.group(3)!) * 1000),
      exists: false,
    );
  }
  return result;
}

/// `git reflog show` silently skips entries whose commit is gone. Adds them
/// back from [raw] (see [parseRawReflog]) as missing entries, within the
/// range of the loaded [entries].
List<ReflogEntry> addMissingReflogEntries(List<ReflogEntry> entries, Map<int, ReflogEntry> raw) {
  if (entries.isEmpty || raw.isEmpty) return entries;
  final present = {for (final e in entries) e.index};
  final last = entries.last.index;
  final prefix = entries.first.selector.substring(0, entries.first.selector.lastIndexOf('@{'));
  final missing = [
    for (final e in raw.values)
      if (e.index <= last && !present.contains(e.index))
        ReflogEntry(
          selector: '$prefix@{${e.index}}',
          index: e.index,
          hash: e.hash,
          action: e.action,
          message: e.message,
          time: e.time,
          exists: false,
        ),
  ];
  if (missing.isEmpty) return entries;
  return [...entries, ...missing]..sort((a, b) => a.index.compareTo(b.index));
}
