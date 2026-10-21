import 'package:flutter/material.dart';

import '../../../domain/entities/git_models.dart';
import '../../../domain/usecases/compare_commits.dart';
import '../../state/app_settings.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import '../diff/diff_view.dart';
import '../widgets/split_view.dart';

/// Editor tab comparing two commits of the log: the files that differ
/// between them and the diff of the selected one.
class CompareCommitsView extends StatefulWidget {
  const CompareCommitsView({
    super.key,
    required this.controller,
    required this.tab,
    required this.settings,
  });

  final RepoController controller;
  final CompareTab tab;
  final AppSettings settings;

  @override
  State<CompareCommitsView> createState() => _CompareCommitsViewState();
}

class _CompareCommitsViewState extends State<CompareCommitsView> {
  RepoController get ctrl => widget.controller;
  CommitComparison? _cmp;
  Object? _error;
  bool _swapped = false;
  FileChange? _selected;
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final gen = ++_gen;
    setState(() => _error = null);
    try {
      final cmp = await ctrl.compareCommits(widget.tab.a, widget.tab.b, swapped: _swapped);
      if (!mounted || gen != _gen) return;
      setState(() {
        _cmp = cmp;
        // Keep the selected file across a swap (the path stays the same).
        _selected = cmp.files.where((f) => f.path == _selected?.path).firstOrNull ?? cmp.files.firstOrNull;
      });
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _error = e);
    }
  }

  void _swap() {
    _swapped = !_swapped;
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final cmp = _cmp;
    return Container(
      color: AppColors.background,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 34,
            color: AppColors.panel,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(children: [
              if (cmp != null) ...[
                _side(cmp.left),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 10),
                  child: Text('↔', style: TextStyle(fontSize: 14, color: AppColors.textDim)),
                ),
                _side(cmp.right),
              ] else
                const Spacer(),
              const SizedBox(width: 8),
              Tooltip(
                message: 'Swap sides',
                child: TextButton.icon(
                  onPressed: cmp == null ? null : _swap,
                  icon: const Icon(Icons.swap_horiz, size: 16),
                  label: const Text('Swap sides'),
                ),
              ),
            ]),
          ),
          const Divider(),
          Expanded(
            child: _error != null
                ? EmptyHint('$_error', icon: Icons.error_outline)
                : cmp == null
                    ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                    : SplitView(
                        axis: Axis.horizontal,
                        initialSize: 300,
                        minSize: 160,
                        first: _fileList(cmp),
                        second: _selected == null
                            ? const EmptyHint('No differences', icon: Icons.check_circle_outline)
                            : DiffView(
                                controller: ctrl,
                                request: cmp.diffRequest(_selected!),
                                settings: widget.settings,
                              ),
                      ),
          ),
        ],
      ),
    );
  }

  Widget _side(Commit c) => Flexible(
        child: Tooltip(
          message: '${c.hash}\n${c.authorName}, ${formatDateFull(c.commitTime)}',
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(c.shortHash, style: monoStyle(size: 12, color: AppColors.accentHover)),
            const SizedBox(width: 6),
            Flexible(
              child: Text(c.subject, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
            ),
          ]),
        ),
      );

  Widget _fileList(CommitComparison cmp) {
    return Container(
      color: AppColors.panel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PanelHeader(title: '${cmp.files.length} file${cmp.files.length == 1 ? '' : 's'} changed'),
          Expanded(
            child: ListView.builder(
              itemCount: cmp.files.length,
              itemExtent: 24,
              itemBuilder: (context, i) {
                final f = cmp.files[i];
                return HoverRow(
                  selected: _selected?.path == f.path,
                  onTap: () => setState(() => _selected = f),
                  onDoubleTap: () => ctrl.openTab(DiffTab(cmp.diffRequest(f))),
                  onSecondaryTapDown: (d) => _fileMenu(d.globalPosition, cmp, f),
                  child: Row(children: [
                    SizedBox(
                      width: 16,
                      child: Text(f.type.letter,
                          style: monoStyle(size: 12, color: changeColor(f.type))),
                    ),
                    Icon(fileIcon(f.fileName), size: 14, color: changeColor(f.type)),
                    const SizedBox(width: 6),
                    Text(f.fileName, style: TextStyle(fontSize: 13, color: changeColor(f.type))),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        f.oldPath != null ? '← ${f.oldPath}' : f.directory,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                      ),
                    ),
                  ]),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _fileMenu(Offset pos, CommitComparison cmp, FileChange f) async {
    setState(() => _selected = f);
    final r = await showContextMenu<String>(context, pos, [
      menuItem('diff', 'Open Diff in New Tab', icon: Icons.difference_outlined),
      menuItem('history', 'Show History for File', icon: Icons.history),
      const PopupMenuDivider(height: 8),
      menuItem('copy', 'Copy Path', icon: Icons.copy),
    ]);
    if (r == null || !mounted) return;
    switch (r) {
      case 'diff':
        ctrl.openTab(DiffTab(cmp.diffRequest(f)));
      case 'history':
        ctrl.showHistory(f.path);
      case 'copy':
        copyToClipboard(context, f.path);
    }
  }
}
