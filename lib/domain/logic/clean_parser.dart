import '../entities/clean.dart';
import 'patch_parser.dart';

final _line = RegExp(r'^Would (remove|skip repository) (.+)$');

/// Pathspecs of `git clean -n` output (`Would remove <path>`), with git's
/// quoting undone. Directories keep their trailing slash.
List<String> parseCleanDryRun(String out) => [
      for (final line in out.split('\n'))
        if (_line.firstMatch(line.trimRight()) case final m?) unquotePath(m.group(2)!),
    ];

/// Entries of the Clean dialog from three `git clean -n` runs with the same
/// options: [plain] (single `-f`, nested repositories left out), [forced]
/// (`-ff`, nested repositories listed) and [notIgnored] (`-ff` without `-x`,
/// null when ignored files are not included). Sorted by path.
List<CleanEntry> buildCleanEntries({
  required List<String> plain,
  required List<String> forced,
  List<String>? notIgnored,
}) {
  final plainSet = plain.toSet();
  final notIgnoredSet = notIgnored?.toSet();
  final all = {...forced, ...plain};
  final entries = [
    for (final spec in all)
      CleanEntry(
        path: spec.endsWith('/') ? spec.substring(0, spec.length - 1) : spec,
        isDirectory: spec.endsWith('/'),
        nestedRepo: !plainSet.contains(spec),
        ignored: notIgnoredSet != null && !notIgnoredSet.contains(spec),
      ),
  ];
  entries.sort((a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()));
  return entries;
}

/// Splits [args] into groups whose total length stays under [maxChars], so
/// each `git clean` command line fits the operating system limit (git clean
/// has no `--pathspec-from-file`).
List<List<String>> chunkArgs(List<String> args, {int maxChars = 24000}) {
  final chunks = <List<String>>[];
  var current = <String>[];
  var size = 0;
  for (final a in args) {
    if (current.isNotEmpty && size + a.length + 3 > maxChars) {
      chunks.add(current);
      current = [];
      size = 0;
    }
    current.add(a);
    size += a.length + 3;
  }
  if (current.isNotEmpty) chunks.add(current);
  return chunks;
}
