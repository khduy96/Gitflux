import 'package:flutter/material.dart';

import '../../../domain/entities/reflog.dart';
import '../../state/repo_controller.dart';
import '../actions.dart';
import '../common.dart';

const _rowHeight = 24.0;

/// "Reflog" tab of the Git tool window: where HEAD (or the current branch)
/// pointed over time, to get back commits lost by a reset, rebase or drop.
class ReflogPanel extends StatefulWidget {
  const ReflogPanel({super.key, required this.controller});

  final RepoController controller;

  @override
  State<ReflogPanel> createState() => _ReflogPanelState();
}

class _ReflogPanelState extends State<ReflogPanel> {
  RepoController get ctrl => widget.controller;
  final _scroll = ScrollController();
  int? _selected;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _refMenu(Offset pos) async {
    final branch = ctrl.status.value.branch;
    final r = await showContextMenu<String>(context, pos, [
      menuItem('HEAD', 'HEAD'),
      if (branch != null) menuItem('refs/heads/$branch', branch, icon: Icons.call_split),
    ]);
    if (r != null) ctrl.setReflogRef(r == 'HEAD' ? null : r);
  }

  Future<void> _contextMenu(Offset pos, ReflogEntry e) async {
    setState(() => _selected = e.index);
    final ok = e.exists;
    final r = await showContextMenu<String>(context, pos, [
      menuItem('log', 'Show in Log', icon: Icons.history, enabled: ok),
      menuItem('checkout', 'Checkout Revision \'${e.shortHash}\'', icon: Icons.login, enabled: ok),
      menuItem('branch', 'New Branch Here…', icon: Icons.call_split, enabled: ok),
      menuItem('reset', 'Reset Current Branch to Here…', icon: Icons.restore, enabled: ok),
      const PopupMenuDivider(height: 8),
      menuItem('copy', 'Copy Revision Number', icon: Icons.copy),
    ]);
    if (r == null || !mounted) return;
    switch (r) {
      case 'log':
        await ctrl.showInLog(e.hash);
      case 'checkout':
        await smartCheckout(context, ctrl, 'Checkout ${e.shortHash}', () => ctrl.repo.checkout(e.hash));
      case 'branch':
        await newBranchDialog(context, ctrl, startPoint: e.hash, startLabel: e.shortHash);
      case 'reset':
        final c = await ctrl.repo.findCommit(e.hash);
        if (c != null && mounted) await resetDialog(context, ctrl, c);
      case 'copy':
        copyToClipboard(context, e.hash);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AppColors.background,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 34,
            color: AppColors.panel,
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Row(children: [
              ValueListenableBuilder<String?>(
                valueListenable: ctrl.reflogRef,
                builder: (context, ref, _) => GestureDetector(
                  onTapDown: (d) => _refMenu(d.globalPosition),
                  child: Container(
                    height: 24,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text('Reflog: ${ref == null ? 'HEAD' : ref.substring('refs/heads/'.length)}',
                          style: const TextStyle(fontSize: 12)),
                      const Icon(Icons.arrow_drop_down, size: 16, color: AppColors.textDim),
                    ]),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              const Expanded(
                child: Text(
                  'Right-click an entry ▸ New Branch Here… to get back a lost commit',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                ),
              ),
              ValueListenableBuilder<bool>(
                valueListenable: ctrl.reflogLoading,
                builder: (_, loading, _) => loading
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.5))
                    : const SizedBox(),
              ),
              const SizedBox(width: 6),
              ValueListenableBuilder<List<ReflogEntry>>(
                valueListenable: ctrl.reflog,
                builder: (_, list, _) => Text('${list.length} entries',
                    style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ),
              ToolButton(icon: Icons.refresh, tooltip: 'Refresh', onPressed: ctrl.refreshReflog),
            ]),
          ),
          const Divider(),
          Expanded(
            child: ListenableBuilder(
              listenable: Listenable.merge([ctrl.reflog, ctrl.reflogLoading]),
              builder: (context, _) {
                final list = ctrl.reflog.value;
                if (list.isEmpty) {
                  return ctrl.reflogLoading.value
                      ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                      : const EmptyHint('No reflog entries', icon: Icons.history_toggle_off);
                }
                return Scrollbar(
                  controller: _scroll,
                  child: ListView.builder(
                    controller: _scroll,
                    itemExtent: _rowHeight,
                    itemCount: list.length,
                    itemBuilder: (context, i) => _row(list[i]),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(ReflogEntry e) {
    final row = HoverRow(
      selected: _selected == e.index,
      height: _rowHeight,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      onTap: () => setState(() => _selected = e.index),
      onDoubleTap: e.exists ? () => ctrl.showInLog(e.hash) : null,
      onSecondaryTapDown: (d) => _contextMenu(d.globalPosition, e),
      child: Row(children: [
        SizedBox(
          width: 96,
          child: Text(e.selector, overflow: TextOverflow.ellipsis, style: monoStyle(size: 12, color: AppColors.textDim)),
        ),
        SizedBox(
          width: 72,
          child: Text(e.shortHash, style: monoStyle(size: 12, color: AppColors.textMuted)),
        ),
        SizedBox(
          width: 150,
          child: Align(alignment: Alignment.centerLeft, child: _ActionLabel(e.action)),
        ),
        Expanded(
          child: Text(e.message,
              overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 110,
          child: Tooltip(
            message: formatDateFull(e.time),
            child: Text(formatRelative(e.time),
                style: const TextStyle(fontSize: 12.5, color: AppColors.textDim)),
          ),
        ),
      ]),
    );
    if (e.exists) return row;
    return Tooltip(
      message: 'The commit ${e.shortHash} no longer exists (garbage collected)',
      waitDuration: const Duration(milliseconds: 600),
      child: Opacity(opacity: 0.45, child: row),
    );
  }
}

/// Operation of a reflog entry, colored by kind.
class _ActionLabel extends StatelessWidget {
  const _ActionLabel(this.action);

  final String action;

  @override
  Widget build(BuildContext context) {
    final a = action.toLowerCase();
    final color = a.startsWith('reset')
        ? AppColors.error
        : a.startsWith('rebase')
            ? AppColors.warning
            : a.startsWith('commit (amend)')
                ? AppColors.modified
                : a.startsWith('commit') || a.startsWith('cherry-pick')
                    ? AppColors.added
                    : a.startsWith('merge') || a.startsWith('pull')
                        ? AppColors.remoteRef
                        : AppColors.textDim;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        border: Border.all(color: color.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(action,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 11.5, color: color, height: 1.1)),
    );
  }
}
