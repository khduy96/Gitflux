import 'dart:convert';

import '../entities/lfs.dart';

/// Pointer files are small: git-lfs never treats a blob of 1024 bytes or
/// more as a pointer.
const lfsPointerMaxSize = 1024;

final _pointerVersion = RegExp(r'^version https://(git-lfs|hawser)\.github\.com/spec/v1$');
final _pointerOid = RegExp(r'^oid (\w+):([0-9a-f]{64})$');
final _pointerSize = RegExp(r'^size (\d+)$');

/// The pointer stored in [bytes] (a blob or a working tree file), or null
/// when it is not an LFS pointer.
LfsPointer? parseLfsPointer(List<int>? bytes) {
  if (bytes == null || bytes.isEmpty || bytes.length >= lfsPointerMaxSize) return null;
  // Cheap check before decoding: every pointer starts with "version ".
  const prefix = 'version ';
  if (bytes.length < prefix.length) return null;
  for (var i = 0; i < prefix.length; i++) {
    if (bytes[i] != prefix.codeUnitAt(i)) return null;
  }
  final lines = utf8.decode(bytes, allowMalformed: true).split('\n').map((l) => l.trimRight()).toList();
  if (!_pointerVersion.hasMatch(lines.first)) return null;
  String? oid, type;
  int? size;
  for (final l in lines.skip(1)) {
    final o = _pointerOid.firstMatch(l);
    if (o != null) {
      type = o.group(1);
      oid = o.group(2);
      continue;
    }
    final s = _pointerSize.firstMatch(l);
    if (s != null) size = int.tryParse(s.group(1)!);
  }
  if (oid == null || size == null) return null;
  return LfsPointer(oid: oid, size: size, oidType: type!);
}

/// Paths whose `filter` attribute is `lfs`, from
/// `git check-attr -z filter` (`<path> NUL filter NUL <value> NUL`, one
/// triple per path).
Set<String> parseCheckAttrLfs(String out) {
  final fields = out.split('\x00');
  final result = <String>{};
  for (var i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 1] == 'filter' && fields[i + 2] == 'lfs') result.add(fields[i]);
  }
  return result;
}

/// `git lfs ls-files --json`.
List<LfsFile> parseLfsLsFilesJson(String out) {
  if (out.trim().isEmpty) return const [];
  final json = jsonDecode(out);
  final files = json is Map ? json['files'] : null;
  if (files is! List) return const [];
  return [
    for (final f in files.whereType<Map>())
      if (f['name'] is String)
        LfsFile(
          path: f['name'] as String,
          oid: '${f['oid'] ?? ''}',
          size: (f['size'] as num?)?.toInt(),
          downloaded: f['downloaded'] != false && f['checkout'] != false,
        ),
  ];
}

final _lsFilesLine = RegExp(r'^([0-9a-f]+) ([*-]) (.+)$');

/// `git lfs ls-files` / `--long`: `<oid> <*|-> <path>`, where `*` means the
/// content is checked out and `-` that only the pointer is.
List<LfsFile> parseLfsLsFiles(String out) => [
      for (final l in const LineSplitter().convert(out))
        if (_lsFilesLine.firstMatch(l) case final m?)
          LfsFile(path: m.group(3)!, oid: m.group(1)!, downloaded: m.group(2) == '*'),
    ];

/// `git lfs locks --json` (a list) or `git lfs locks --verify --json`
/// (`{"ours": [...], "theirs": [...]}`), sorted by path.
List<LfsLock> parseLfsLocksJson(String out) {
  if (out.trim().isEmpty) return const [];
  final json = jsonDecode(out);
  final result = <LfsLock>[];
  void addAll(Object? list, bool? ours) {
    if (list is! List) return;
    for (final l in list.whereType<Map>()) {
      final path = l['path'];
      if (path is! String) continue;
      final owner = l['owner'];
      final at = l['locked_at'];
      result.add(LfsLock(
        id: '${l['id'] ?? ''}',
        path: path,
        owner: owner is Map ? '${owner['name'] ?? ''}' : '',
        lockedAt: at is String ? DateTime.tryParse(at)?.toLocal() : null,
        ours: ours,
      ));
    }
  }

  if (json is List) {
    addAll(json, null);
  } else if (json is Map) {
    addAll(json['ours'], true);
    addAll(json['theirs'], false);
  }
  result.sort((a, b) => a.path.compareTo(b.path));
  return result;
}

/// `git lfs track --json`.
List<LfsTrackPattern> parseLfsTrackJson(String out) {
  if (out.trim().isEmpty) return const [];
  final json = jsonDecode(out);
  final patterns = json is Map ? json['patterns'] : null;
  if (patterns is! List) return const [];
  return [
    for (final e in patterns.whereType<Map>())
      if (e['pattern'] is String)
        LfsTrackPattern(
          pattern: e['pattern'] as String,
          source: '${e['source'] ?? '.gitattributes'}',
          tracked: e['tracked'] != false,
          lockable: e['lockable'] == true,
        ),
  ];
}

final _trackLine = RegExp(r'^\s+(.+?) \(([^()]+)\)$');

/// `git lfs track` without arguments (older git-lfs without `--json`):
/// tracked patterns, then excluded ones, as `    <pattern> (<source>)`.
List<LfsTrackPattern> parseLfsTrackList(String out) {
  final result = <LfsTrackPattern>[];
  var tracked = true;
  for (final l in const LineSplitter().convert(out)) {
    if (l.startsWith('Listing excluded')) tracked = false;
    if (l.startsWith('Listing tracked')) tracked = true;
    final m = _trackLine.firstMatch(l);
    if (m == null) continue;
    var pattern = m.group(1)!;
    final lockable = pattern.endsWith(' [lockable]');
    if (lockable) pattern = pattern.substring(0, pattern.length - 11);
    result.add(LfsTrackPattern(pattern: pattern, source: m.group(2)!, tracked: tracked, lockable: lockable));
  }
  return result;
}

final _pruneObject = RegExp(r'^\s*\*\s+([0-9a-f]{64})(?:\s+\(([^)]*)\))?');

/// `git lfs prune --dry-run --verbose`: summary lines (`prune: ...`) and
/// one ` * <oid> (<size>)` line per object that would be deleted.
LfsPrunePreview parseLfsPruneDryRun(String out) {
  final objects = <({String oid, String size})>[];
  final summary = <String>[];
  // Progress lines are rewritten with carriage returns: keep the last state.
  for (final raw in const LineSplitter().convert(out)) {
    final l = raw.split('\r').lastWhere((s) => s.trim().isNotEmpty, orElse: () => '');
    final m = _pruneObject.firstMatch(l);
    if (m != null) {
      objects.add((oid: m.group(1)!, size: m.group(2) ?? ''));
    } else if (l.trim().startsWith('prune:')) {
      summary.add(l.trim());
    }
  }
  return LfsPrunePreview(objects: objects, summary: summary, output: out.trim());
}

/// Whether the attributes [pattern] declared in [source] (e.g.
/// `.gitattributes` or `assets/.gitattributes`) applies to the repository
/// relative [path], following gitattributes rules: a pattern without `/`
/// matches the file name at any depth, otherwise the path relative to the
/// attributes file; `*` and `?` never match `/`, `**` does.
bool lfsPatternMatches(LfsTrackPattern pattern, String path) {
  final dir = pattern.sourceDir;
  var rel = path.replaceAll('\\', '/');
  if (dir.isNotEmpty) {
    if (!rel.startsWith('$dir/')) return false;
    rel = rel.substring(dir.length + 1);
  }
  var pat = pattern.pattern;
  if (pat.endsWith('/')) return false; // matches directories only
  if (!pat.contains('/')) {
    final i = rel.lastIndexOf('/');
    return globToRegExp(pat).hasMatch(i < 0 ? rel : rel.substring(i + 1));
  }
  if (pat.startsWith('/')) pat = pat.substring(1);
  return globToRegExp(pat).hasMatch(rel);
}

const _posixClasses = {
  'space': r'\s',
  'alpha': 'a-zA-Z',
  'digit': '0-9',
  'alnum': 'a-zA-Z0-9',
  'upper': 'A-Z',
  'lower': 'a-z',
  'xdigit': '0-9a-fA-F',
  'punct': r'!-\/:-@\[-`{-~',
  'blank': r' \t',
};

/// Anchored regular expression of a git wildmatch glob (with
/// `FNM_PATHNAME`): `*` / `?` stop at `/`, `**/`, `/**/` and `/**` span
/// directories, `[...]` classes (including `[[:space:]]`) and `\` escapes.
RegExp globToRegExp(String glob) {
  final b = StringBuffer('^');
  var i = 0;
  while (i < glob.length) {
    final c = glob[i];
    if (c == '*') {
      final double = i + 1 < glob.length && glob[i + 1] == '*';
      final atStart = i == 0 || glob[i - 1] == '/';
      if (double && atStart && (i + 2 == glob.length || glob[i + 2] == '/')) {
        if (i + 2 == glob.length) {
          b.write('.*');
          i += 2;
        } else {
          b.write('(?:.*/)?');
          i += 3;
        }
        continue;
      }
      b.write('[^/]*');
      i += double ? 2 : 1;
    } else if (c == '?') {
      b.write('[^/]');
      i++;
    } else if (c == '\\' && i + 1 < glob.length) {
      b.write(RegExp.escape(glob[i + 1]));
      i += 2;
    } else if (c == '[') {
      final end = _classEnd(glob, i);
      if (end < 0) {
        b.write(r'\[');
        i++;
        continue;
      }
      b.write(_classToRegExp(glob.substring(i + 1, end)));
      i = end + 1;
    } else {
      b.write(RegExp.escape(c));
      i++;
    }
  }
  b.write(r'$');
  return RegExp(b.toString());
}

/// Index of the `]` closing the class opened at [start], or -1.
int _classEnd(String glob, int start) {
  var i = start + 1;
  if (i < glob.length && (glob[i] == '!' || glob[i] == '^')) i++;
  if (i < glob.length && glob[i] == ']') i++; // a leading ] is literal
  while (i < glob.length) {
    if (glob.startsWith('[:', i)) {
      final close = glob.indexOf(':]', i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    if (glob[i] == ']') return i;
    i++;
  }
  return -1;
}

String _classToRegExp(String body) {
  final b = StringBuffer('[');
  var i = 0;
  if (body.startsWith('!') || body.startsWith('^')) {
    b.write('^');
    i = 1;
  }
  while (i < body.length) {
    if (body.startsWith('[:', i)) {
      final close = body.indexOf(':]', i + 2);
      b.write(_posixClasses[body.substring(i + 2, close)] ?? '');
      i = close + 2;
      continue;
    }
    final c = body[i];
    b.write(c == '-' ? '-' : RegExp.escape(c));
    i++;
  }
  b.write(']');
  return b.toString();
}

/// Patterns offered by "Track with LFS…" for the repository relative
/// [paths]: the files themselves, their extensions (`*.psd`) when they all
/// have one, and their folders (`assets/**`) when none is at the root.
List<LfsPatternOption> lfsTrackOptions(List<String> paths) {
  if (paths.isEmpty) return const [];
  final names = [for (final path in paths) path.replaceAll('\\', '/')];
  final exts = <String>{};
  final dirs = <String>{};
  var allExt = true, allInDir = true;
  for (final n in names) {
    final slash = n.lastIndexOf('/');
    final file = slash < 0 ? n : n.substring(slash + 1);
    final dot = file.lastIndexOf('.');
    if (dot <= 0 || dot == file.length - 1) {
      allExt = false;
    } else {
      exts.add('*${file.substring(dot)}');
    }
    if (slash < 0) {
      allInDir = false;
    } else {
      dirs.add('${n.substring(0, slash)}/**');
    }
  }
  return [
    LfsPatternOption(names.length == 1 ? 'Exact path' : 'Exact paths', names, literal: true),
    if (allExt) LfsPatternOption(exts.length == 1 ? 'By extension' : 'By extensions', exts.toList()..sort()),
    if (allInDir) LfsPatternOption(dirs.length == 1 ? 'By folder' : 'By folders', dirs.toList()..sort()),
  ];
}
