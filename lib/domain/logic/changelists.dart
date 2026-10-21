import 'dart:convert';
import 'dart:math';

import '../entities/changelist.dart';
import '../entities/git_models.dart';
import 'shelf_format.dart';

/// Version written in `changelists.json` (format shared with the VS Code
/// extension).
const changelistsFormatVersion = 1;

/// New changelist id: the shelf id format (`yyyyMMdd-HHmmss-<6 hex>`, UTC).
String newChangelistId(DateTime now, Random random) => newShelfId(now, random);

/// Repository relative path with forward slashes.
String _norm(String path) {
  final p = path.replaceAll(r'\', '/');
  return p.startsWith('./') ? p.substring(2) : p;
}

/// Reads `changelists.json` and applies the invariants: lists with a string
/// id (duplicates dropped), each file in one list only (the first wins), the
/// default list present (first when it had to be added) and `active` naming
/// an existing list (the default one otherwise). Unknown fields are kept.
/// Throws [FormatException] when the text is not a JSON object, so that a
/// damaged file is not overwritten with empty lists.
Changelists decodeChangelists(String json) {
  final Object? data;
  try {
    data = jsonDecode(json.startsWith('﻿') ? json.substring(1) : json);
  } on FormatException catch (e) {
    throw FormatException('Invalid changelists.json: ${e.message}');
  }
  if (data is! Map<String, dynamic>) throw const FormatException('changelists.json is not an object');
  final ids = <String>{};
  final seen = <String>{};
  final lists = <Changelist>[];
  final rawLists = data['lists'];
  for (final l in rawLists is List ? rawLists : const []) {
    if (l is! Map<String, dynamic>) continue;
    final id = l['id'];
    if (id is! String || id.isEmpty || !ids.add(id)) continue;
    final files = <String>[];
    final rawFiles = l['files'];
    for (final f in rawFiles is List ? rawFiles : const []) {
      if (f is! String || f.isEmpty) continue;
      final path = _norm(f);
      if (seen.add(path)) files.add(path);
    }
    final name = l['name'], comment = l['comment'];
    lists.add(Changelist(
      id: id,
      name: name is String && name.trim().isNotEmpty
          ? name
          : id == defaultChangelistId
              ? defaultChangelistName
              : id,
      comment: comment is String ? comment : '',
      files: files,
      raw: l,
    ));
  }
  if (!ids.contains(defaultChangelistId)) {
    lists.insert(0, const Changelist(id: defaultChangelistId, name: defaultChangelistName));
  }
  final active = data['active'];
  final version = data['version'];
  return Changelists(
    version: version is int ? version : changelistsFormatVersion,
    active: active is String && ids.contains(active) ? active : defaultChangelistId,
    lists: lists,
    raw: data,
  );
}

/// Content of `changelists.json`: 2-space indented, trailing newline. Fields
/// read from the file keep their order; new ones are appended.
String encodeChangelists(Changelists c) => '${const JsonEncoder.withIndent('  ').convert({
      ...c.raw,
      'version': c.version,
      'active': c.active,
      'lists': [
        for (final l in c.lists)
          {...l.raw, 'id': l.id, 'name': l.name, 'comment': l.comment, 'files': l.files},
      ],
    })}\n';

/// Why [name] cannot name a list, or null. Names are unique (ignoring case);
/// [exceptId] is the list being renamed.
String? validateChangelistName(Changelists c, String name, {String? exceptId}) {
  if (name.trim().isEmpty) return 'Enter a name';
  final other = c.byName(name);
  return other != null && other.id != exceptId ? 'A changelist named "${other.name}" already exists' : null;
}

/// Brings the lists in line with the working tree status:
/// - rename: the new path takes the place of its old path in that list;
/// - prune: paths that are no longer changed leave their list;
/// - first seen: a changed file in no list goes to the active list.
///
/// Unversioned files are never in a list.
Changelists reconcileChangelists(Changelists c, List<FileChange> changes) {
  final tracked = changes.where((x) => x.type != ChangeType.untracked).toList();
  final current = {for (final x in tracked) x.path};
  final files = [for (final l in c.lists) [...l.files]];
  final owner = <String, int>{
    for (var i = 0; i < files.length; i++)
      for (final f in files[i]) f: i,
  };
  for (final x in tracked) {
    final old = x.oldPath;
    if (x.type != ChangeType.renamed || old == null || owner.containsKey(x.path)) continue;
    final i = owner.remove(old);
    if (i == null) continue;
    files[i][files[i].indexOf(old)] = x.path;
    owner[x.path] = i;
  }
  for (final f in files) {
    f.retainWhere(current.contains);
  }
  final assigned = {for (final f in files) ...f};
  final active = c.lists.indexOf(c.activeList);
  for (final x in tracked) {
    if (assigned.add(x.path)) files[active].add(x.path);
  }
  return c.copyWith(lists: [for (var i = 0; i < files.length; i++) c.lists[i].copyWith(files: files[i])]);
}

/// Moves [paths] to the list [toId], out of any other list. Files already
/// in the target keep their place, the others are appended.
Changelists moveToChangelist(Changelists c, Iterable<String> paths, String toId) {
  if (c.byId(toId) == null) throw ArgumentError('Unknown changelist: $toId');
  final moved = {for (final p in paths) _norm(p)};
  return c.copyWith(lists: [
    for (final l in c.lists)
      l.id == toId
          ? l.copyWith(files: [...l.files, ...moved.where((f) => !l.files.contains(f))])
          : l.copyWith(files: l.files.where((f) => !moved.contains(f)).toList()),
  ]);
}

/// Adds an empty list after the others.
Changelists createChangelist(Changelists c, {required String id, required String name, String comment = ''}) {
  if (c.byId(id) != null) throw ArgumentError('Changelist $id already exists');
  return c.copyWith(lists: [...c.lists, Changelist(id: id, name: name.trim(), comment: comment)]);
}

/// Renames list [id] and / or replaces its comment.
Changelists editChangelist(Changelists c, String id, {String? name, String? comment}) {
  if (c.byId(id) == null) throw ArgumentError('Unknown changelist: $id');
  return c.copyWith(lists: [
    for (final l in c.lists) l.id == id ? l.copyWith(name: name?.trim(), comment: comment) : l,
  ]);
}

/// Where the files of list [id] go when it is deleted: the active list, or
/// the default list when the active one is deleted.
String deleteTarget(Changelists c, String id) =>
    id == c.active || c.byId(c.active) == null ? defaultChangelistId : c.active;

/// Deletes list [id]; its files move to [deleteTarget]. Deleting the active
/// list makes the default list active. The default list cannot be deleted.
Changelists deleteChangelist(Changelists c, String id) {
  if (id == defaultChangelistId) throw ArgumentError('The default changelist cannot be deleted.');
  final gone = c.byId(id);
  if (gone == null) throw ArgumentError('Unknown changelist: $id');
  final target = deleteTarget(c, id);
  return c.copyWith(
    active: c.active == id ? defaultChangelistId : c.active,
    lists: [
      for (final l in c.lists)
        if (l.id == target)
          l.copyWith(files: [...l.files, ...gone.files.where((f) => !l.files.contains(f))])
        else if (l.id != id)
          l,
    ],
  );
}

Changelists setActiveChangelist(Changelists c, String id) {
  if (c.byId(id) == null) throw ArgumentError('Unknown changelist: $id');
  return c.copyWith(active: id);
}
