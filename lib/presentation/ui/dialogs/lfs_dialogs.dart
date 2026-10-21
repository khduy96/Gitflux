import 'package:flutter/material.dart';

import '../../../domain/entities/lfs.dart';
import '../../../domain/errors.dart';
import '../../../domain/logic/lfs_parser.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import 'basic_dialogs.dart';

/// "Git LFS" of the Git menu: a second menu at [position] with Pull, Fetch,
/// Prune… and Show Tracked Patterns….
Future<void> showLfsMenu(BuildContext context, RepoController ctrl, Offset position) async {
  final r = await showContextMenu<String>(context, position, [
    menuItem('pull', 'Pull', icon: Icons.download),
    menuItem('fetch', 'Fetch', icon: Icons.sync),
    menuItem('prune', 'Prune…', icon: Icons.delete_sweep_outlined),
    const PopupMenuDivider(height: 8),
    menuItem('patterns', 'Show Tracked Patterns…', icon: Icons.filter_alt_outlined),
  ]);
  if (!context.mounted) return;
  switch (r) {
    case 'pull':
      await ctrl.run('Git LFS pull', ctrl.repo.lfsPull, success: 'LFS objects pulled');
    case 'fetch':
      await ctrl.run('Git LFS fetch', ctrl.repo.lfsFetch, success: 'LFS objects fetched', refresh: false);
    case 'prune':
      await showLfsPruneDialog(context, ctrl);
    case 'patterns':
      await showLfsPatternsDialog(context, ctrl);
  }
}

String _plural(int n, String word) => '$n $word${n == 1 ? '' : 's'}';

// -----------------------------------------------------------------------------
// Track with LFS
// -----------------------------------------------------------------------------

/// "Track with LFS…" for unversioned files: picks the pattern (exact path,
/// extension or folder) and runs `git lfs track`.
Future<void> showLfsTrackDialog(BuildContext context, RepoController ctrl, List<String> paths) async {
  final options = lfsTrackOptions(paths);
  if (options.isEmpty) return;
  final choice = await showDialog<LfsPatternOption>(
    context: context,
    builder: (_) => _TrackDialog(options: options, fileCount: paths.length),
  );
  if (choice == null) return;
  final shown = choice.patterns.take(3).join(', ') + (choice.patterns.length > 3 ? ', …' : '');
  await ctrl.run(
    'Track with LFS',
    () => ctrl.repo.lfsTrack(choice.patterns, literal: choice.literal),
    success: 'Tracking $shown with LFS (.gitattributes changed)',
  );
}

class _TrackDialog extends StatefulWidget {
  const _TrackDialog({required this.options, required this.fileCount});

  final List<LfsPatternOption> options;
  final int fileCount;

  @override
  State<_TrackDialog> createState() => _TrackDialogState();
}

class _TrackDialogState extends State<_TrackDialog> {
  // Extension patterns are the usual choice for binary assets.
  late LfsPatternOption _choice =
      widget.options.where((o) => o.label.startsWith('By extension')).firstOrNull ?? widget.options.first;

  void _ok() => Navigator.pop(context, _choice);

  @override
  Widget build(BuildContext context) {
    return AppDialog(
      title: 'Track with LFS',
      width: 520,
      onSubmit: _ok,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _ok, child: const Text('Track')),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Store ${widget.fileCount == 1 ? 'this file' : 'these ${widget.fileCount} files'} in Git LFS, matching:',
              style: const TextStyle(fontSize: 13)),
          const SizedBox(height: 6),
          RadioGroup<LfsPatternOption>(
            groupValue: _choice,
            onChanged: (v) => setState(() => _choice = v ?? _choice),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final o in widget.options)
                  RadioListTile<LfsPatternOption>(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    value: o,
                    title: Text(o.label, style: const TextStyle(fontSize: 13)),
                    subtitle: Text(
                      o.patterns.take(4).join('   ') + (o.patterns.length > 4 ? '   …' : ''),
                      overflow: TextOverflow.ellipsis,
                      style: monoStyle(size: 12, color: AppColors.textDim),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            'Runs git lfs track and adds the pattern to .gitattributes; commit .gitattributes together with the files.',
            style: TextStyle(fontSize: 12, color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// Untrack
// -----------------------------------------------------------------------------

/// "Untrack from LFS…" for files stored in LFS: finds the patterns of the
/// attributes files that match [paths] and lets the user remove them.
Future<void> showLfsUntrackForFiles(BuildContext context, RepoController ctrl, List<String> paths) async {
  List<LfsTrackPattern> all;
  try {
    all = await ctrl.repo.lfsTrackPatterns();
  } catch (e) {
    ctrl.notify(AppNotification('Cannot read LFS patterns', details: e is GitException ? e.message : '$e', isError: true));
    return;
  }
  final matching = [
    for (final pt in all)
      if (pt.tracked && paths.any((path) => lfsPatternMatches(pt, path))) pt,
  ];
  if (!context.mounted) return;
  if (matching.isEmpty) {
    ctrl.notify(AppNotification('No LFS pattern of .gitattributes matches',
        details: 'The files may be tracked through .git/info/attributes or core.attributesFile.', isError: true));
    return;
  }
  final chosen = await showDialog<List<LfsTrackPattern>>(
    context: context,
    builder: (_) => _UntrackDialog(patterns: matching, paths: paths),
  );
  if (chosen == null || chosen.isEmpty) return;
  await untrackLfsPatterns(ctrl, chosen);
}

/// Runs `git lfs untrack` for [patterns] (of the root `.gitattributes`).
Future<bool> untrackLfsPatterns(RepoController ctrl, List<LfsTrackPattern> patterns) => ctrl.run(
      'Untrack from LFS',
      () => ctrl.repo.lfsUntrack([for (final pt in patterns) pt.pattern]),
      success: 'Untracked ${patterns.map((pt) => pt.display).join(', ')} (.gitattributes changed)',
    );

class _UntrackDialog extends StatefulWidget {
  const _UntrackDialog({required this.patterns, required this.paths});

  final List<LfsTrackPattern> patterns;
  final List<String> paths;

  @override
  State<_UntrackDialog> createState() => _UntrackDialogState();
}

class _UntrackDialogState extends State<_UntrackDialog> {
  late final Set<LfsTrackPattern> _checked = {
    for (final pt in widget.patterns)
      if (pt.inRootAttributes) pt,
  };

  @override
  Widget build(BuildContext context) {
    final n = widget.paths.length;
    return AppDialog(
      title: 'Untrack from LFS',
      width: 520,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: _checked.isEmpty ? null : () => Navigator.pop(context, _checked.toList()),
          child: const Text('Untrack'),
        ),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('${n == 1 ? widget.paths.first : _plural(n, 'file')} '
              '${n == 1 ? 'is' : 'are'} stored in LFS because of:',
              style: const TextStyle(fontSize: 13)),
          const SizedBox(height: 6),
          for (final pt in widget.patterns)
            CheckboxListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              visualDensity: VisualDensity.compact,
              controlAffinity: ListTileControlAffinity.leading,
              value: _checked.contains(pt),
              onChanged: pt.inRootAttributes
                  ? (v) => setState(() => v == true ? _checked.add(pt) : _checked.remove(pt))
                  : null,
              title: Text(pt.display, style: monoStyle(size: 13)),
              subtitle: Text(
                pt.inRootAttributes ? pt.source : '${pt.source} (edit that file to remove it)',
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
              ),
            ),
          const SizedBox(height: 6),
          const Text(
            'The pattern is removed from .gitattributes: matching files are committed to Git directly from now on. '
            'Commits already made keep their LFS pointers.',
            style: TextStyle(fontSize: 12, color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// Tracked patterns
// -----------------------------------------------------------------------------

/// "Show Tracked Patterns…": the patterns of `git lfs track` with an
/// Untrack action.
Future<void> showLfsPatternsDialog(BuildContext context, RepoController ctrl) =>
    showDialog<void>(context: context, builder: (_) => _PatternsDialog(ctrl: ctrl));

class _PatternsDialog extends StatefulWidget {
  const _PatternsDialog({required this.ctrl});

  final RepoController ctrl;

  @override
  State<_PatternsDialog> createState() => _PatternsDialogState();
}

class _PatternsDialogState extends State<_PatternsDialog> {
  List<LfsTrackPattern>? _patterns;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await widget.ctrl.repo.lfsTrackPatterns();
      if (mounted) setState(() => _patterns = list);
    } catch (e) {
      if (mounted) setState(() => _error = e is GitException ? e.message : '$e');
    }
  }

  Future<void> _untrack(LfsTrackPattern pt) async {
    final ok = await showConfirm(
      context,
      title: 'Untrack from LFS',
      message: 'Remove "${pt.display}" from .gitattributes?\n\n'
          'Matching files are committed to Git directly from now on; commits already made keep their LFS pointers.',
      confirmLabel: 'Untrack',
    );
    if (!ok || !mounted) return;
    await untrackLfsPatterns(widget.ctrl, [pt]);
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final patterns = _patterns;
    return AppDialog(
      title: 'Git LFS Tracked Patterns',
      width: 560,
      actions: [FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Close'))],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Flexible(
            child: Container(
              constraints: const BoxConstraints(maxHeight: 360, minHeight: 80),
              decoration: BoxDecoration(border: Border.all(color: AppColors.border), color: AppColors.background),
              child: _error != null
                  ? EmptyHint(_error!, icon: Icons.error_outline)
                  : patterns == null
                      ? const Center(
                          child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
                      : patterns.isEmpty
                          ? const EmptyHint('No file is tracked with LFS')
                          : ListView(
                              shrinkWrap: true,
                              children: [for (final pt in patterns) _patternRow(pt)],
                            ),
            ),
          ),
          const SizedBox(height: 6),
          const Text('Untrack only edits the root .gitattributes; patterns of other attributes files are read-only here.',
              style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
        ],
      ),
    );
  }

  Widget _patternRow(LfsTrackPattern pt) => HoverRow(
        height: 30,
        child: Row(children: [
            const SizedBox(width: 6),
            Icon(pt.tracked ? Icons.cloud_outlined : Icons.block, size: 15, color: AppColors.textDim),
            const SizedBox(width: 8),
            Flexible(child: Text(pt.display, overflow: TextOverflow.ellipsis, style: monoStyle(size: 13))),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                [pt.source, if (!pt.tracked) 'excluded', if (pt.lockable) 'lockable'].join(' · '),
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
              ),
            ),
            if (pt.tracked && pt.inRootAttributes)
              TextButton(onPressed: () => _untrack(pt), child: const Text('Untrack')),
          ]),
      );
}

// -----------------------------------------------------------------------------
// Prune
// -----------------------------------------------------------------------------

/// "Prune…": shows what `git lfs prune` would delete, then deletes it after
/// a confirmation.
Future<void> showLfsPruneDialog(BuildContext context, RepoController ctrl) =>
    showDialog<void>(context: context, builder: (_) => _PruneDialog(ctrl: ctrl));

class _PruneDialog extends StatefulWidget {
  const _PruneDialog({required this.ctrl});

  final RepoController ctrl;

  @override
  State<_PruneDialog> createState() => _PruneDialogState();
}

class _PruneDialogState extends State<_PruneDialog> {
  LfsPrunePreview? _preview;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.ctrl.repo.lfsPruneDryRun().then(
      (v) => mounted ? setState(() => _preview = v) : null,
      onError: (Object e) => mounted ? setState(() => _error = e is GitException ? e.message : '$e') : null,
    );
  }

  Future<void> _prune() async {
    final n = _preview!.objects.length;
    final ok = await showConfirm(
      context,
      title: 'Prune LFS Objects',
      message: 'Delete ${_plural(n, 'local LFS object')}? '
          'They are not needed by the checked out commits and were pushed; they can be downloaded again.',
      confirmLabel: 'Prune',
      destructive: true,
    );
    if (!ok || !mounted) return;
    Navigator.pop(context);
    await widget.ctrl.run('Git LFS prune', widget.ctrl.repo.lfsPrune,
        success: 'Pruned ${_plural(n, 'LFS object')}', refresh: false);
  }

  @override
  Widget build(BuildContext context) {
    final preview = _preview;
    return AppDialog(
      title: 'Prune LFS Objects',
      width: 620,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AppColors.error),
          onPressed: preview == null || preview.objects.isEmpty ? null : _prune,
          child: const Text('Prune…'),
        ),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Objects git lfs prune would delete from the local store (dry run):',
              style: TextStyle(fontSize: 13)),
          const SizedBox(height: 6),
          Flexible(
            child: Container(
              constraints: const BoxConstraints(maxHeight: 320, minHeight: 80),
              decoration: BoxDecoration(border: Border.all(color: AppColors.border), color: AppColors.background),
              child: _error != null
                  ? EmptyHint(_error!, icon: Icons.error_outline)
                  : preview == null
                      ? const Center(
                          child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
                      : preview.objects.isEmpty
                          ? const EmptyHint('Nothing to prune')
                          : ListView(
                              shrinkWrap: true,
                              padding: const EdgeInsets.all(6),
                              children: [
                                for (final o in preview.objects)
                                  Text('${o.oid}  ${o.size}', style: monoStyle(size: 12, color: AppColors.textDim)),
                              ],
                            ),
            ),
          ),
          if (preview != null && preview.summary.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(preview.summary.join('\n'), style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ],
        ],
      ),
    );
  }
}
