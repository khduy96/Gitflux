import 'package:flutter/material.dart';

import '../../../domain/entities/git_models.dart';
import '../../../domain/entities/lfs.dart';
import '../../../domain/errors.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import '../dialogs/basic_dialogs.dart';
import '../dialogs/lfs_dialogs.dart';

/// Small "LFS" pill shown after the name of a file stored in Git LFS.
class LfsBadge extends StatelessWidget {
  const LfsBadge({super.key});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5),
        decoration: BoxDecoration(
          color: AppColors.tagRef.withValues(alpha: 0.15),
          border: Border.all(color: AppColors.tagRef.withValues(alpha: 0.6)),
          borderRadius: BorderRadius.circular(8),
        ),
        child: const Text('LFS',
            style: TextStyle(fontSize: 10, height: 1.4, fontWeight: FontWeight.w600, color: AppColors.tagRef)),
      );
}

/// LFS marks of a file row of the Commit panel: the "LFS" badge and a lock
/// icon, with the lock owner as tooltip. Rebuilds itself when the LFS state
/// changes; empty when the file has neither.
class LfsFileMarks extends StatelessWidget {
  const LfsFileMarks({super.key, required this.ctrl, required this.change});

  final RepoController ctrl;
  final FileChange change;

  @override
  Widget build(BuildContext context) {
    final lfs = ctrl.lfs;
    return ListenableBuilder(
      listenable: Listenable.merge([lfs.available, lfs.tracked, lfs.locks]),
      builder: (context, _) {
        if (!lfs.available.value) return const SizedBox.shrink();
        final tracked = lfs.isTracked(change.path);
        final lock = lfs.lockOf(change.path);
        if (!tracked && lock == null) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.only(left: 6),
          child: Tooltip(
            message: lfsFileTooltip(ctrl, change) ?? '',
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              if (tracked) const LfsBadge(),
              if (lock != null) ...[
                if (tracked) const SizedBox(width: 4),
                Icon(Icons.lock, size: 13, color: lock.ours == false ? AppColors.warning : AppColors.textDim),
              ],
            ]),
          ),
        );
      },
    );
  }
}

/// Tooltip of a file row for LFS: the lock owner ("Locked by …") and
/// whether the file is stored in LFS; null when neither applies.
String? lfsFileTooltip(RepoController ctrl, FileChange c) {
  final lfs = ctrl.lfs;
  if (!lfs.available.value) return null;
  final lock = lfs.lockOf(c.path);
  final lines = [
    if (lock != null)
      'Locked by ${lock.owner.isEmpty ? 'unknown user' : lock.owner}'
          '${lock.ours == true ? ' (you)' : ''}'
          '${lock.lockedAt == null ? '' : ' since ${formatDate(lock.lockedAt!)}'}',
    if (lfs.isTracked(c.path)) 'Stored in Git LFS',
  ];
  return lines.isEmpty ? null : lines.join('\n');
}

/// Files of [sel] LFS can act on (not submodules or nested repositories).
List<FileChange> _files(List<FileChange> sel) => sel.where((c) => !c.isSubmodule && !c.nestedRepo).toList();

/// LFS entries of the file context menu of the Commit panel for the
/// selection [sel], preceded by a divider; empty when git-lfs is missing or
/// nothing applies. Ids start with `lfs:`; pass the chosen id to
/// [handleLfsMenu].
List<PopupMenuEntry<String>> lfsMenuItems(RepoController ctrl, List<FileChange> sel) {
  final lfs = ctrl.lfs;
  final files = _files(sel);
  if (!lfs.available.value || files.isEmpty) return const [];
  final inLfs = files.where((c) => lfs.isTracked(c.path)).length;
  final unversioned = files.every((c) => c.type == ChangeType.untracked);
  // Only files known to the server can be locked.
  final canLock = lfs.locksSupported.value &&
      inLfs == files.length &&
      files.every((c) => c.type != ChangeType.untracked && c.type != ChangeType.added);
  final locked = files.where((c) => lfs.lockOf(c.path) != null).length;
  final items = [
    if (unversioned && inLfs < files.length)
      menuItem('lfs:track', 'Track with LFS…', icon: Icons.cloud_upload_outlined),
    if (inLfs > 0) menuItem('lfs:untrack', 'Untrack from LFS…', icon: Icons.cloud_off_outlined),
    if (canLock && locked < files.length) menuItem('lfs:lock', 'Lock', icon: Icons.lock_outline),
    if (canLock && locked > 0) menuItem('lfs:unlock', 'Unlock', icon: Icons.lock_open),
  ];
  return items.isEmpty ? const [] : [const PopupMenuDivider(height: 8), ...items];
}

/// Runs the LFS entry [id] chosen in the menu of [lfsMenuItems] for [sel].
/// Returns false when [id] is not an LFS entry.
Future<bool> handleLfsMenu(BuildContext context, RepoController ctrl, String id, List<FileChange> sel) async {
  final lfs = ctrl.lfs;
  final files = _files(sel);
  switch (id) {
    case 'lfs:track':
      await showLfsTrackDialog(context, ctrl, [
        for (final c in files)
          if (!lfs.isTracked(c.path)) c.path,
      ]);
    case 'lfs:untrack':
      await showLfsUntrackForFiles(context, ctrl, [
        for (final c in files)
          if (lfs.isTracked(c.path)) c.path,
      ]);
    case 'lfs:lock':
      final paths = [
        for (final c in files)
          if (lfs.lockOf(c.path) == null) c.path,
      ];
      final ok = await ctrl.run('Lock ${paths.length == 1 ? paths.first : '${paths.length} files'}', () async {
        for (final path in paths) {
          await ctrl.repo.lfsLock(path);
        }
      }, success: paths.length == 1 ? 'Locked ${paths.first}' : 'Locked ${paths.length} files', refresh: false);
      // Some files may have been locked before a failure.
      if (ok || paths.length > 1) await lfs.refreshLocks();
    case 'lfs:unlock':
      if (!context.mounted) return true;
      await _unlock(context, ctrl, [
        for (final c in files) ?lfs.lockOf(c.path),
      ]);
    default:
      return false;
  }
  return true;
}

/// Unlocks [locks]. Locks of someone else need `--force`, asked first;
/// when the server cannot tell the owner, a refused unlock offers to force.
Future<void> _unlock(BuildContext context, RepoController ctrl, List<LfsLock> locks) async {
  if (locks.isEmpty) return;
  String describe(LfsLock l) => '${l.path}${l.owner.isEmpty ? '' : ' (${l.owner})'}';
  final theirs = locks.where((l) => l.ours == false).toList();
  if (theirs.isNotEmpty) {
    final ok = await showConfirm(
      context,
      title: 'Force Unlock',
      message: 'Locked by someone else:\n${theirs.take(8).map(describe).join('\n')}'
          '${theirs.length > 8 ? '\n…' : ''}\n\n'
          'Breaking another user\'s lock can make them lose work. Unlock anyway?',
      confirmLabel: 'Force Unlock',
      destructive: true,
    );
    if (!ok) return;
  }
  final refused = <LfsLock, String>{};
  final ok = await ctrl.run('Unlock', () async {
    for (final l in locks) {
      try {
        await ctrl.repo.lfsUnlock(l.path, force: l.ours == false);
      } on GitException catch (e) {
        if (l.ours != null) rethrow;
        refused[l] = e.message;
      }
    }
  }, refresh: false);
  if (ok && refused.isEmpty) {
    ctrl.notify(AppNotification(locks.length == 1 ? 'Unlocked ${locks.first.path}' : 'Unlocked ${locks.length} files'));
  }
  if (refused.isNotEmpty && context.mounted) {
    final force = await showConfirm(
      context,
      title: 'Force Unlock',
      message: 'The server refused to unlock:\n'
          '${refused.entries.take(8).map((e) => '${describe(e.key)}: ${e.value}').join('\n')}\n\n'
          'The lock may belong to someone else. Force unlock?',
      confirmLabel: 'Force Unlock',
      destructive: true,
    );
    if (force) {
      await ctrl.run('Force unlock', () async {
        for (final l in refused.keys) {
          await ctrl.repo.lfsUnlock(l.path, force: true);
        }
      }, success: 'Unlocked ${refused.length == 1 ? refused.keys.first.path : '${refused.length} files'}', refresh: false);
    }
  }
  await ctrl.lfs.refreshLocks();
}
