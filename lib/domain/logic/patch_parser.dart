import 'dart:convert';

import '../entities/git_models.dart';
import '../entities/patch.dart';

final _mboxFrom = RegExp(r'^From [0-9a-f]{40} ');
final _numstat = RegExp(r'^(\d+|-)\t(\d+|-)\t(.*)$');
final _similarity = RegExp(r' \(\d+%\)$');

/// Whether [text] is a mailbox made by `git format-patch` (a `From <hash> `
/// first line, or `From:` / `Subject:` mail headers before the diff).
bool isMailboxPatch(String text) {
  final lines = const LineSplitter().convert(text.length > 20000 ? text.substring(0, 20000) : text);
  final first = lines.where((l) => l.trim().isNotEmpty).firstOrNull;
  if (first == null) return false;
  if (_mboxFrom.hasMatch(first)) return true;
  var from = false, subject = false;
  for (final l in lines) {
    if (l.startsWith('diff --git ') || l.startsWith('--- ')) break;
    if (l.startsWith('From: ')) from = true;
    if (l.startsWith('Subject: ')) subject = true;
  }
  return from && subject;
}

/// Commit subjects of a mailbox, without the `[PATCH n/m]` prefix. Folded
/// header lines are joined.
List<String> mailboxSubjects(String text) {
  final lines = const LineSplitter().convert(text);
  final result = <String>[];
  // Mail headers: from the start (or a `From <hash>` line) to a blank line.
  var header = true;
  for (var i = 0; i < lines.length; i++) {
    if (_mboxFrom.hasMatch(lines[i])) header = true;
    if (lines[i].isEmpty) header = false;
    if (!header || !lines[i].startsWith('Subject: ')) continue;
    var s = lines[i].substring(9);
    while (i + 1 < lines.length && lines[i + 1].startsWith(RegExp(r'[ \t]')) && lines[i + 1].trim().isNotEmpty) {
      s += ' ${lines[++i].trim()}';
    }
    result.add(s.replaceFirst(RegExp(r'^\[[^\]]*PATCH[^\]]*\]\s*'), '').trim());
  }
  return result;
}

/// Files of `git apply --numstat --summary` output, in patch order. A file
/// patched several times (a mailbox of several commits) is listed once with
/// the counts added up.
List<PatchFile> parsePatchStats(String output) {
  final files = <PatchFile>[];
  final byPath = <String, int>{};
  final kinds = <String, ({ChangeType type, String? oldPath})>{};
  for (final line in const LineSplitter().convert(output)) {
    final m = _numstat.firstMatch(line);
    if (m != null) {
      final path = unquotePath(m.group(3)!);
      final added = int.tryParse(m.group(1)!), deleted = int.tryParse(m.group(2)!);
      final i = byPath[path];
      if (i == null) {
        byPath[path] = files.length;
        files.add(PatchFile(path: path, type: ChangeType.modified, added: added, deleted: deleted));
      } else {
        final f = files[i];
        files[i] = PatchFile(
          path: path,
          type: f.type,
          added: f.added == null || added == null ? null : f.added! + added,
          deleted: f.deleted == null || deleted == null ? null : f.deleted! + deleted,
        );
      }
      continue;
    }
    if (!line.startsWith(' ')) continue;
    final s = line.trim();
    if (s.startsWith('create mode ')) {
      kinds.putIfAbsent(_afterMode(s), () => (type: ChangeType.added, oldPath: null));
    } else if (s.startsWith('delete mode ')) {
      kinds[_afterMode(s)] = (type: ChangeType.deleted, oldPath: null);
    } else if (s.startsWith('rename ') || s.startsWith('copy ')) {
      final (from, to) = expandRename(s.substring(s.indexOf(' ') + 1).replaceFirst(_similarity, ''));
      kinds[to] = (type: s.startsWith('rename ') ? ChangeType.renamed : ChangeType.copied, oldPath: from);
    }
  }
  return [
    for (final f in files)
      if (kinds[f.path] case final k?) f.copyWith(type: k.type, oldPath: k.oldPath) else f,
  ];
}

/// Path of each numstat line of `git apply --numstat`: one per patch entry,
/// in patch order (the new path, or the old one for a deletion).
List<String> patchEntryPaths(String output) => [
      for (final line in const LineSplitter().convert(output))
        if (_numstat.firstMatch(line) case final m?) unquotePath(m.group(3)!),
    ];

/// Path after `create mode 100644 ` / `delete mode 100644 `.
String _afterMode(String s) {
  final parts = s.split(' ');
  return unquotePath(parts.length > 3 ? parts.sublist(3).join(' ') : s);
}

/// `old => new`, or the compact form `dir/{old => new}/file`, as the two
/// paths.
(String, String) expandRename(String s) {
  final open = s.indexOf('{'), close = s.lastIndexOf('}');
  final arrow = s.indexOf(' => ');
  if (open >= 0 && close > arrow && arrow > open) {
    final prefix = s.substring(0, open), suffix = s.substring(close + 1);
    String join(String mid) => '$prefix$mid$suffix'.replaceAll('//', '/').replaceFirst(RegExp('^/'), '');
    return (unquotePath(join(s.substring(open + 1, arrow))), unquotePath(join(s.substring(arrow + 4, close))));
  }
  if (arrow < 0) return (unquotePath(s), unquotePath(s));
  return (unquotePath(s.substring(0, arrow)), unquotePath(s.substring(arrow + 4)));
}

/// Undoes git's C-style quoting of a path (`"a\tb"`, `"\303\251"`).
String unquotePath(String s) {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  final bytes = <int>[];
  final body = s.substring(1, s.length - 1);
  for (var i = 0; i < body.length; i++) {
    final c = body[i];
    if (c != r'\' || i + 1 >= body.length) {
      bytes.addAll(utf8.encode(c));
      continue;
    }
    final n = body[++i];
    const simple = {'a': 7, 'b': 8, 't': 9, 'n': 10, 'v': 11, 'f': 12, 'r': 13, '"': 34, r'\': 92};
    if (simple[n] case final v?) {
      bytes.add(v);
    } else if (RegExp('[0-7]').hasMatch(n) && i + 2 < body.length) {
      bytes.add(int.parse(body.substring(i, i + 3), radix: 8));
      i += 2;
    } else {
      bytes.addAll(utf8.encode(n));
    }
  }
  return utf8.decode(bytes, allowMalformed: true);
}

final _diffHeader = utf8.encode('diff --git ');

/// Byte ranges of the entries of a git patch, one per `diff --git` header.
/// Text before the first header is not part of any entry.
List<List<int>> splitPatch(List<int> patch) {
  final starts = <int>[];
  for (var i = 0; i < patch.length; i++) {
    if (i > 0 && patch[i - 1] != 10) continue;
    var match = i + _diffHeader.length <= patch.length;
    for (var j = 0; match && j < _diffHeader.length; j++) {
      if (patch[i + j] != _diffHeader[j]) match = false;
    }
    if (match) starts.add(i);
  }
  return [
    for (var k = 0; k < starts.length; k++)
      patch.sublist(starts[k], k + 1 < starts.length ? starts[k + 1] : patch.length),
  ];
}

/// [patch] with only the entries whose path is in [keep]. [entries] are the
/// files of the patch in order (one per `diff --git` header, as
/// `git apply --numstat` lists them). Throws [FormatException] when they do
/// not match.
List<int> filterPatch(List<int> patch, List<String> entries, Set<String> keep) {
  final chunks = splitPatch(patch);
  if (chunks.length != entries.length) {
    throw FormatException('The patch has ${chunks.length} entries, git lists ${entries.length}');
  }
  return [
    for (var i = 0; i < chunks.length; i++)
      if (keep.contains(entries[i])) ...chunks[i],
  ];
}
