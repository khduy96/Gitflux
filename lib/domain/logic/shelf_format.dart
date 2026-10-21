import 'dart:convert';
import 'dart:math';

import '../entities/shelf.dart';

/// Version written in `shelf.json` (format shared with the VS Code
/// extension).
const shelfFormatVersion = 1;

final _idPattern = RegExp(r'^\d{8}-\d{6}-[0-9a-f]{6}$');

String _two(int v) => v.toString().padLeft(2, '0');

/// New shelf id: `yyyyMMdd-HHmmss-<6 random hex>` (UTC time).
String newShelfId(DateTime now, Random random) {
  final t = now.toUtc();
  final hex = List.generate(6, (_) => random.nextInt(16).toRadixString(16)).join();
  return '${t.year.toString().padLeft(4, '0')}${_two(t.month)}${_two(t.day)}'
      '-${_two(t.hour)}${_two(t.minute)}${_two(t.second)}-$hex';
}

/// Whether [name] is a shelf folder name.
bool isShelfId(String name) => _idPattern.hasMatch(name);

/// ISO-8601 UTC with milliseconds, as JavaScript's `Date.toISOString()`.
String isoUtc(DateTime t) {
  final u = t.toUtc();
  return '${u.year.toString().padLeft(4, '0')}-${_two(u.month)}-${_two(u.day)}'
      'T${_two(u.hour)}:${_two(u.minute)}:${_two(u.second)}.${u.millisecond.toString().padLeft(3, '0')}Z';
}

/// Content of `shelf.json`.
String encodeShelf(Shelf s) => '${const JsonEncoder.withIndent('  ').convert({
      'version': shelfFormatVersion,
      'name': s.name,
      'created': isoUtc(s.created),
      'base': s.base,
      'branch': s.branch,
      'files': [
        for (final f in s.files) {'path': f.path, 'oldPath': f.oldPath, 'status': f.status.letter},
      ],
    })}\n';

/// Reads `shelf.json` of the shelf [id]. Throws [FormatException] when it is
/// not a shelf this version understands.
Shelf decodeShelf(String id, String json) {
  final Object? data;
  try {
    data = jsonDecode(json);
  } on FormatException catch (e) {
    throw FormatException('Invalid shelf.json: ${e.message}');
  }
  if (data is! Map<String, dynamic>) throw const FormatException('shelf.json is not an object');
  final version = data['version'];
  if (version is! int || version < 1) throw const FormatException('shelf.json has no version');
  if (version > shelfFormatVersion) {
    throw FormatException('shelf.json version $version is newer than this app supports');
  }
  final name = data['name'], created = data['created'], base = data['base'], branch = data['branch'];
  final files = data['files'];
  if (name is! String || created is! String || base is! String || files is! List) {
    throw const FormatException('shelf.json misses name, created, base or files');
  }
  if (branch != null && branch is! String) throw const FormatException('Invalid branch in shelf.json');
  final time = DateTime.tryParse(created);
  if (time == null) throw FormatException('Invalid date in shelf.json: $created');
  return Shelf(
    id: id,
    name: name,
    created: time.toUtc(),
    base: base,
    branch: branch as String?,
    files: [
      for (final f in files)
        if (f is Map<String, dynamic>) _file(f) else throw const FormatException('Invalid file in shelf.json'),
    ],
  );
}

ShelvedFile _file(Map<String, dynamic> f) {
  final path = f['path'], oldPath = f['oldPath'], status = f['status'];
  final s = status is String ? ShelfFileStatus.fromLetter(status) : null;
  if (path is! String || path.isEmpty || s == null || (oldPath != null && oldPath is! String)) {
    throw const FormatException('Invalid file in shelf.json');
  }
  return ShelvedFile(path: path, oldPath: oldPath as String?, status: s);
}

/// Default name of a new shelf: the first line of the commit message, or
/// `Changes from yyyy-MM-dd HH:mm`.
String defaultShelfName(String commitMessage, DateTime now) {
  final first = commitMessage.trim().split('\n').first.trim();
  if (first.isNotEmpty) return first;
  return 'Changes from ${now.year}-${_two(now.month)}-${_two(now.day)} ${_two(now.hour)}:${_two(now.minute)}';
}
