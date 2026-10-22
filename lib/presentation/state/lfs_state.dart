import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../../domain/entities/git_models.dart';
import '../../domain/entities/lfs.dart';
import '../../domain/repositories/git_repository.dart';

/// Git LFS information shown in the Commit panel: whether git-lfs is
/// installed, which changed files are stored in LFS and the locks of the
/// server. Refreshed with the status; every failure only hides LFS UI.
class LfsState {
  LfsState(this.repo, {required this.onError});

  final GitRepository repo;

  /// Reports a failed refresh (to the console).
  final void Function(String message) onError;

  /// git-lfs is installed; all LFS UI is hidden otherwise.
  final available = ValueNotifier<bool>(false);

  /// Changed files (paths of the status) whose `filter` attribute is `lfs`.
  final tracked = ValueNotifier<Set<String>>(const {});

  /// Locks of the server by path.
  final locks = ValueNotifier<Map<String, LfsLock>>(const {});

  /// The remote answered `git lfs locks`; Lock / Unlock are hidden
  /// otherwise.
  final locksSupported = ValueNotifier<bool>(false);

  /// Locks need a request to the server: they are reloaded at most this
  /// often with the status (and right after Lock / Unlock).
  static const locksInterval = Duration(minutes: 1);

  int _gen = 0;
  DateTime? _locksAt;
  bool _locksLoading = false;

  bool isTracked(String path) => tracked.value.contains(path);
  LfsLock? lockOf(String path) => locks.value[path];

  /// Recomputes the LFS state for status [s]. Fire-and-forget: errors go
  /// to [onError].
  void refresh(RepoStatus s) => _refresh(s);

  Future<void> _refresh(RepoStatus s) async {
    final gen = ++_gen;
    try {
      if (!await repo.lfsAvailable()) {
        available.value = false;
        return;
      }
      available.value = true;
      final paths = [
        for (final c in s.changes)
          if (!c.isSubmodule && !c.nestedRepo) c.path,
      ];
      final set = await repo.lfsFilteredPaths(paths);
      if (gen != _gen) return;
      if (!setEquals(set, tracked.value)) tracked.value = set;
      if (set.isNotEmpty || await _usesLfs()) {
        final at = _locksAt;
        if (at == null || DateTime.now().difference(at) >= locksInterval) await refreshLocks();
      }
    } catch (e) {
      if (gen == _gen) onError('$e');
    }
  }

  /// Whether the root `.gitattributes` stores files in LFS (avoids asking
  /// the server for locks in repositories that do not use LFS).
  Future<bool> _usesLfs() async {
    try {
      final f = File(p.join(repo.root, '.gitattributes'));
      return await f.exists() && (await f.readAsString()).contains('filter=lfs');
    } catch (_) {
      return false;
    }
  }

  /// Reloads the locks from the server; any error (no remote, server
  /// without locking) hides the lock UI.
  Future<void> refreshLocks() async {
    if (_locksLoading) return;
    _locksLoading = true;
    _locksAt = DateTime.now();
    try {
      final list = await repo.lfsLocks();
      locks.value = {for (final l in list) l.path: l};
      locksSupported.value = true;
    } catch (_) {
      locks.value = const {};
      locksSupported.value = false;
    } finally {
      _locksLoading = false;
    }
  }
}
