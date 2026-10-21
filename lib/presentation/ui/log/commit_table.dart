import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../domain/entities/bisect.dart';
import '../../../domain/entities/git_models.dart';
import '../../../domain/logic/graph_layout.dart';
import '../../state/repo_controller.dart';
import '../actions.dart';
import '../branches/compare_dialog.dart';
import '../common.dart';
import '../dialogs/bisect_dialogs.dart';
import '../dialogs/merge_dialog.dart';
import '../dialogs/patch_dialogs.dart';
import 'commit_refs.dart';
import 'graph_painter.dart';
import 'log_filter_bar.dart';
import 'signature_badge.dart';

const _rowHeight = 24.0;

class CommitTable extends StatefulWidget {
  const CommitTable({super.key, required this.controller});

  final RepoController controller;

  @override
  State<CommitTable> createState() => _CommitTableState();
}

class _CommitTableState extends State<CommitTable> {
  RepoController get ctrl => widget.controller;
  final _scroll = ScrollController();
  final _focus = FocusNode();
  Set<String> _multi = {};

  /// Rows of the last build, for loading the signatures of the visible ones.
  List<(Commit, GraphRow?)> _rows = const [];
  Timer? _signatureTimer;

  @override
  void initState() {
    super.initState();
    ctrl.revealCommit.addListener(_reveal);
    _scroll.addListener(_scheduleSignatures);
  }

  @override
  void dispose() {
    ctrl.revealCommit.removeListener(_reveal);
    _signatureTimer?.cancel();
    _scroll.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// "Show in Log": selects the commit and scrolls it into view when it is
  /// shown.
  void _reveal() {
    final hash = ctrl.revealCommit.value;
    if (hash == null) return;
    setState(() => _multi = {hash});
    final i = _visible().indexWhere((r) => r.$1.hash == hash);
    if (i < 0) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final pos = _scroll.position;
      final top = i * _rowHeight;
      if (top < pos.pixels || top + _rowHeight > pos.pixels + pos.viewportDimension) {
        _scroll.jumpTo((top - pos.viewportDimension / 3).clamp(0, pos.maxScrollExtent));
      }
    });
  }

  /// Verifying signatures is slow: they are loaded only for the rows on
  /// screen, once scrolling has paused.
  void _scheduleSignatures() {
    _signatureTimer?.cancel();
    _signatureTimer = Timer(const Duration(milliseconds: 250), _loadSignatures);
  }

  void _loadSignatures() {
    if (!mounted || _rows.isEmpty) return;
    var first = 0, count = 60;
    if (_scroll.hasClients) {
      final pos = _scroll.position;
      first = (pos.pixels / _rowHeight).floor();
      count = (pos.viewportDimension / _rowHeight).ceil() + 1;
    }
    first = first.clamp(0, _rows.length);
    final end = (first + count).clamp(first, _rows.length);
    ctrl.signing.loadSignatures([for (final r in _rows.sublist(first, end)) r.$1.hash]);
  }

  List<(Commit, GraphRow?)> _visible() {
    final commits = ctrl.commits.value;
    final graph = ctrl.graph.value;
    final q = ctrl.logFilter.value.messageText.toLowerCase();
    if (q.isEmpty) {
      return [
        for (var i = 0; i < commits.length; i++)
          (commits[i], i < graph.length ? graph[i] : null),
      ];
    }
    return [
      for (final c in commits)
        if (c.subject.toLowerCase().contains(q) ||
            c.hash.startsWith(q) ||
            c.authorName.toLowerCase().contains(q) ||
            c.authorEmail.toLowerCase().contains(q) ||
            c.refs.any((r) => r.name.toLowerCase().contains(q)))
          (c, null),
    ];
  }

  void _select(Commit c, List<(Commit, GraphRow?)> rows) {
    final keys = HardwareKeyboard.instance;
    setState(() {
      if (keys.isControlPressed) {
        _multi = {..._multi};
        _multi.contains(c.hash) ? _multi.remove(c.hash) : _multi.add(c.hash);
      } else if (keys.isShiftPressed && ctrl.selectedCommit.value != null) {
        final hashes = rows.map((r) => r.$1.hash).toList();
        final a = hashes.indexOf(ctrl.selectedCommit.value!.hash), b = hashes.indexOf(c.hash);
        if (a >= 0 && b >= 0) {
          _multi = hashes.sublist(a < b ? a : b, (a < b ? b : a) + 1).toSet();
        }
        return;
      } else {
        _multi = {c.hash};
      }
    });
    ctrl.selectCommit(c);
  }

  void _move(List<(Commit, GraphRow?)> rows, int delta) {
    if (rows.isEmpty) return;
    final cur = ctrl.selectedCommit.value;
    var i = cur == null ? -1 : rows.indexWhere((r) => r.$1.hash == cur.hash);
    i = (i + delta).clamp(0, rows.length - 1);
    final c = rows[i].$1;
    setState(() => _multi = {c.hash});
    ctrl.selectCommit(c);
    if (_scroll.hasClients) {
      final top = i * _rowHeight;
      final pos = _scroll.position;
      if (top < pos.pixels) {
        _scroll.jumpTo(top);
      } else if (top + _rowHeight > pos.pixels + pos.viewportDimension) {
        _scroll.jumpTo(top + _rowHeight - pos.viewportDimension);
      }
    }
  }

  List<Commit> _selectedCommits(List<(Commit, GraphRow?)> rows) =>
      [for (final r in rows) if (_multi.contains(r.$1.hash)) r.$1];

  Future<void> _contextMenu(Offset pos, Commit c, List<(Commit, GraphRow?)> rows) async {
    if (!_multi.contains(c.hash)) {
      setState(() => _multi = {c.hash});
      ctrl.selectCommit(c);
    }
    final selected = _selectedCommits(rows);
    final isHead = c.hash == ctrl.status.value.headHash;
    final r = await showContextMenu<String>(context, pos, _menuItems(c, selected, rows, isHead: isHead));
    if (r == null || !mounted) return;
    switch (r) {
      case 'copy':
        copyToClipboard(context, selected.map((x) => x.hash).join(' '));
      case 'cherry':
        await cherryPickAction(ctrl, selected);
      case 'checkout':
        await smartCheckout(context, ctrl, 'Checkout ${c.shortHash}', () => ctrl.repo.checkout(c.hash));
      case 'compare':
        await showCompareDialog(context, ctrl, c.hash);
      case 'merge':
        await showMergeDialog(context, ctrl, c.hash, label: c.shortHash);
      case 'bisect':
        await _bisectMenu(pos, c);
      case 'compareCommits':
        ctrl.openCompare(selected[0], selected[1]);
      case 'patch':
        await createPatchFromCommits(context, ctrl, selected);
      case 'reset':
        await resetDialog(context, ctrl, c);
      case 'revert':
        await revertAction(ctrl, selected);
      case 'undo':
        await undoCommit(context, ctrl);
      case 'reword':
        await editCommitMessage(context, ctrl, c);
      case 'fixup':
        await fixupIntoPreviousAction(context, ctrl, c);
      case 'squash':
        await squashCommitsAction(context, ctrl, selected);
      case 'drop':
        await dropCommitsAction(context, ctrl, selected);
      case 'up' || 'down':
        await moveCommitAction(context, ctrl, c, up: r == 'up');
      case 'rebase':
        await interactiveRebaseAction(context, ctrl, c);
      case 'branch':
        await newBranchDialog(context, ctrl, startPoint: c.hash, startLabel: c.shortHash);
      case 'tag':
        await newTagDialog(context, ctrl, c);
    }
  }

  /// Second level of "Bisect ▸": start a session by marking the commit, or
  /// mark it / reset during one.
  Future<void> _bisectMenu(Offset pos, Commit c) async {
    final session = ctrl.bisect.value;
    final r = await showContextMenu<String>(context, pos, [
      if (session == null) ...[
        menuItem('bad', 'Start: Mark Bad', icon: Icons.thumb_down_outlined, color: AppColors.error),
        menuItem('good', 'Start: Mark Good', icon: Icons.thumb_up_outlined, color: AppColors.success),
      ] else ...[
        menuItem('bad', 'Mark Bad', icon: Icons.thumb_down_outlined, color: AppColors.error),
        menuItem('good', 'Mark Good', icon: Icons.thumb_up_outlined, color: AppColors.success),
        menuItem('skip', 'Skip', icon: Icons.redo),
        const PopupMenuDivider(height: 8),
        menuItem('run', 'Run Script…', icon: Icons.play_arrow_outlined, enabled: session.hasGood && session.hasBad),
        menuItem('reset', 'Reset Bisect', icon: Icons.stop_circle_outlined),
      ],
    ]);
    if (r == null || !mounted) return;
    switch (r) {
      case 'bad' || 'good' || 'skip':
        await ctrl.bisectMark(BisectMark.values.byName(r), commit: c);
      case 'run':
        await showBisectRunDialog(context, ctrl);
      case 'reset':
        await ctrl.bisectReset();
    }
  }

  /// Commits of the current branch (HEAD and its ancestors among the loaded
  /// commits). Empty when history cannot be rewritten (detached HEAD or an
  /// operation in progress).
  Set<String> _branchCommits() {
    final s = ctrl.status.value;
    if (s.detached || s.headHash == null || s.state != RepoState.normal) return const {};
    final byHash = {for (final c in ctrl.commits.value) c.hash: c};
    final result = <String>{};
    final stack = [s.headHash!];
    while (stack.isNotEmpty) {
      final h = stack.removeLast();
      final c = byHash[h];
      if (c == null || !result.add(h)) continue;
      stack.addAll(c.parents);
    }
    return result;
  }

  List<PopupMenuEntry<String>> _menuItems(Commit c, List<Commit> selected, List<(Commit, GraphRow?)> rows,
      {required bool isHead}) {
    final single = selected.length == 1;
    final branch = _branchCommits();
    final byHash = {for (final x in ctrl.commits.value) x.hash: x};
    // A plain commit of the current branch: a pick line of the rebase todo.
    bool rewritable(Commit x) => branch.contains(x.hash) && !x.isMerge;
    final parent = c.parents.isEmpty ? null : byHash[c.parents.first];
    final hasPrevious = rewritable(c) && parent != null && rewritable(parent);
    final hasNext = rewritable(c) &&
        branch.any((h) => byHash[h]!.parents.length == 1 && byHash[h]!.parents.first == c.hash);
    final hashes = rows.map((r) => r.$1.hash).toList();
    final idx = [for (final x in selected) hashes.indexOf(x.hash)]..sort();
    final contiguous = idx.isNotEmpty && idx.last - idx.first == idx.length - 1;
    return [
      menuItem('copy', 'Copy Revision Number', icon: Icons.copy, shortcut: 'Ctrl+Alt+Shift+C'),
      const PopupMenuDivider(height: 8),
      menuItem('cherry', 'Cherry-Pick', icon: Icons.local_florist_outlined),
      menuItem('checkout', 'Checkout Revision \'${c.shortHash}\'', icon: Icons.login, enabled: single),
      menuItem('compare', 'Compare with Local', icon: Icons.compare_arrows, enabled: single),
      menuItem('compareCommits', 'Compare Commits', icon: Icons.difference_outlined, enabled: selected.length == 2),
      menuItem('merge', 'Merge into Current…', icon: Icons.merge_type,
          enabled: single && !isHead && ctrl.status.value.state == RepoState.normal),
      menuItem('patch', 'Create Patch…', icon: Icons.save_alt, enabled: selected.any((x) => !x.isMerge)),
      const PopupMenuDivider(height: 8),
      menuItem('reset', 'Reset Current Branch to Here…', icon: Icons.restore, enabled: single),
      menuItem('revert', 'Revert Commit', icon: Icons.undo),
      menuItem('undo', 'Undo Commit…', icon: Icons.settings_backup_restore, enabled: single && isHead && c.parents.isNotEmpty),
      const PopupMenuDivider(height: 8),
      menuItem('reword', 'Edit Commit Message…', icon: Icons.edit_outlined,
          enabled: single && (isHead || (rewritable(c) && c.parents.isNotEmpty))),
      menuItem('fixup', 'Fixup into Previous', icon: Icons.merge_type, enabled: single && hasPrevious),
      menuItem('squash', 'Squash Commits…', icon: Icons.compress,
          enabled: selected.length >= 2 && contiguous && selected.every(rewritable)),
      menuItem('drop', single ? 'Drop Commit' : 'Drop Commits', icon: Icons.delete_outline,
          enabled: selected.every((x) => rewritable(x) && x.parents.isNotEmpty)),
      menuItem('up', 'Move Commit Up', icon: Icons.arrow_upward, enabled: single && hasNext),
      menuItem('down', 'Move Commit Down', icon: Icons.arrow_downward, enabled: single && hasPrevious),
      menuItem('rebase', 'Interactively Rebase from Here…', icon: Icons.low_priority,
          enabled: single && branch.contains(c.hash)),
      const PopupMenuDivider(height: 8),
      menuItem('bisect', ctrl.bisect.value == null ? 'Bisect ▸' : 'Bisect (in progress) ▸', icon: Icons.troubleshoot,
          enabled: single),
      const PopupMenuDivider(height: 8),
      menuItem('branch', 'New Branch…', icon: Icons.call_split, enabled: single),
      menuItem('tag', 'New Tag…', icon: Icons.sell_outlined, enabled: single),
    ];
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AppColors.background,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          LogFilterBar(controller: ctrl),
          const Divider(),
          Expanded(
            child: ListenableBuilder(
              listenable: Listenable.merge([
                ctrl.commits,
                ctrl.graph,
                ctrl.logFilter,
                ctrl.selectedCommit,
                ctrl.status,
                ctrl.bisect,
              ]),
              builder: (context, _) {
                final rows = _rows = _visible();
                _scheduleSignatures();
                if (rows.isEmpty) {
                  return ctrl.logLoading.value
                      ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                      : const EmptyHint('No commits', icon: Icons.history);
                }
                final noGraph = ctrl.logFilter.value.hidesGraph;
                final head = ctrl.status.value.headHash;
                final sel = ctrl.selectedCommit.value?.hash;
                final marks = ctrl.bisect.value?.marks ?? const <String, BisectMark>{};
                return CallbackShortcuts(
                  bindings: {
                    const SingleActivator(LogicalKeyboardKey.arrowDown): () => _move(rows, 1),
                    const SingleActivator(LogicalKeyboardKey.arrowUp): () => _move(rows, -1),
                    const SingleActivator(LogicalKeyboardKey.pageDown): () => _move(rows, 20),
                    const SingleActivator(LogicalKeyboardKey.pageUp): () => _move(rows, -20),
                    const SingleActivator(LogicalKeyboardKey.keyC, control: true, alt: true, shift: true): () {
                      final c = ctrl.selectedCommit.value;
                      if (c != null) copyToClipboard(context, c.hash);
                    },
                  },
                  child: Focus(
                    focusNode: _focus,
                    child: Scrollbar(
                      controller: _scroll,
                      child: ListView.builder(
                        controller: _scroll,
                        itemExtent: _rowHeight,
                        itemCount: rows.length,
                        itemBuilder: (context, i) {
                          final (c, g) = rows[i];
                          return _commitRow(
                            c,
                            noGraph ? null : g,
                            isHead: c.hash == head,
                            selected: c.hash == sel || _multi.contains(c.hash),
                            rows: rows,
                            bisectMark: marks[c.hash],
                          );
                        },
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _commitRow(Commit c, GraphRow? g,
      {required bool isHead,
      required bool selected,
      required List<(Commit, GraphRow?)> rows,
      BisectMark? bisectMark}) {
    return HoverRow(
      selected: selected,
      height: _rowHeight,
      padding: const EdgeInsets.only(left: 2, right: 8),
      onTap: () {
        _focus.requestFocus();
        _select(c, rows);
      },
      onSecondaryTapDown: (d) => _contextMenu(d.globalPosition, c, rows),
      child: Row(
        children: [
          if (g != null)
            CustomPaint(
              size: Size(graphWidth(g), _rowHeight),
              painter: GraphRowPainter(g, isHead: isHead),
            )
          else
            const SizedBox(width: 10),
          CommitRefs(c.refs, focus: ctrl.logFilter.value.branch),
          if (bisectMark != null) _BisectChip(bisectMark),
          Expanded(
            child: Text(
              c.subject,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                fontWeight: isHead ? FontWeight.w600 : null,
              ),
            ),
          ),
          const SizedBox(width: 6),
          ValueListenableBuilder(
            valueListenable: ctrl.signing.signatures,
            builder: (context, signatures, _) => SignatureBadge(signatures[c.hash]),
          ),
          const SizedBox(width: 6),
          SizedBox(
            width: 140,
            child: Text(c.authorName,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12.5, color: AppColors.textDim)),
          ),
          SizedBox(
            width: 130,
            child: Text(formatDate(c.authorTime),
                style: const TextStyle(fontSize: 12.5, color: AppColors.textDim)),
          ),
          SizedBox(
            width: 68,
            child: Text(c.shortHash, style: monoStyle(size: 12, color: AppColors.textMuted)),
          ),
        ],
      ),
    );
  }
}

/// `good` / `bad` / `skip` label of a commit marked during a bisect.
class _BisectChip extends StatelessWidget {
  const _BisectChip(this.mark);

  final BisectMark mark;

  @override
  Widget build(BuildContext context) {
    final color = switch (mark) {
      BisectMark.good => AppColors.success,
      BisectMark.bad => AppColors.error,
      BisectMark.skip => AppColors.textDim,
    };
    return Container(
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        border: Border.all(color: color.withValues(alpha: 0.55)),
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(mark.name, style: TextStyle(fontSize: 11, color: color, height: 1.1)),
    );
  }
}
