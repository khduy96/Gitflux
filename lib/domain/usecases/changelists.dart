import 'dart:math';

import '../entities/changelist.dart';
import '../entities/git_models.dart';
import '../errors.dart';
import '../logic/changelists.dart';
import '../repositories/changelist_repository.dart';

/// Changelists (Android Studio): the tracked changes split into named
/// lists, one of them active. Every change re-reads the file first, the
/// VS Code extension may have changed it.
class ManageChangelists {
  ManageChangelists(this._store, {Random? random}) : _random = random ?? Random.secure();

  final ChangelistRepository _store;
  final Random _random;

  Future<Changelists> read() => _guard(_store.read);

  /// Prunes, follows renames and assigns new changes to the active list.
  Future<Changelists> sync(List<FileChange> changes) =>
      _guard(() => _store.update((c) => reconcileChangelists(c, changes)));

  Future<Changelists> move(Iterable<String> paths, String toId) =>
      _guard(() => _store.update((c) => moveToChangelist(c, paths, _existing(c, toId))));

  /// Adds a list and returns it with the saved lists. With [active] it
  /// becomes the active list.
  Future<(Changelists, Changelist)> create(String name, {String comment = '', bool active = false}) async {
    late Changelist created;
    final saved = await _guard(() => _store.update((c) {
          _checkName(c, name);
          var id = newChangelistId(DateTime.now(), _random);
          while (c.byId(id) != null) {
            id = newChangelistId(DateTime.now(), _random);
          }
          var next = createChangelist(c, id: id, name: name, comment: comment);
          if (active) next = setActiveChangelist(next, id);
          created = next.byId(id)!;
          return next;
        }));
    return (saved, created);
  }

  /// Renames list [id], replaces its comment and, with [active], makes it
  /// the active list.
  Future<Changelists> edit(String id, {String? name, String? comment, bool active = false}) =>
      _guard(() => _store.update((c) {
            _existing(c, id);
            if (name != null) _checkName(c, name, exceptId: id);
            final next = editChangelist(c, id, name: name, comment: comment);
            return active ? setActiveChangelist(next, id) : next;
          }));

  /// Deletes list [id]; its files go to the active list (to the default
  /// list, which becomes active, when [id] is the active one).
  Future<Changelists> delete(String id) => _guard(() => _store.update((c) {
        if (id == defaultChangelistId) {
          throw ChangelistRejected('The default changelist cannot be deleted');
        }
        return deleteChangelist(c, _existing(c, id));
      }));

  /// Makes [id] active. [message] (the commit message box) is saved as the
  /// comment of the list that was active.
  Future<Changelists> setActive(String id, {String? message}) => _guard(() => _store.update((c) {
        _existing(c, id);
        final old = c.activeList.id;
        final next = message == null || old == id ? c : editChangelist(c, old, comment: message);
        return setActiveChangelist(next, id);
      }));

  Future<Changelists> saveComment(String id, String comment) =>
      _guard(() => _store.update((c) => c.byId(id) == null ? c : editChangelist(c, id, comment: comment)));

  static String _existing(Changelists c, String id) {
    if (c.byId(id) == null) throw ChangelistRejected('The changelist no longer exists', details: id);
    return id;
  }

  static void _checkName(Changelists c, String name, {String? exceptId}) {
    final error = validateChangelistName(c, name, exceptId: exceptId);
    if (error != null) throw ChangelistRejected(error);
  }

  static Future<Changelists> _guard(Future<Changelists> Function() action) async {
    try {
      return await action();
    } on FormatException catch (e) {
      throw ChangelistRejected('changelists.json cannot be read',
          details: '${e.message}\nFix or delete the file; it is not overwritten until then.');
    }
  }
}
