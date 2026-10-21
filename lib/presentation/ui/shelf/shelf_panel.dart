import 'package:flutter/material.dart';

import '../../../domain/entities/shelf.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import '../dialogs/patch_dialogs.dart';
import '../dialogs/shelve_dialogs.dart';

const _rowHeight = 24.0;

/// "Shelf" tab of the Git tool window: shelves (newest first) and their
/// files. Clicking a file shows base ↔ shelved content.
class ShelfPanel extends StatefulWidget {
  const ShelfPanel({super.key, required this.controller});

  final RepoController controller;

  @override
  State<ShelfPanel> createState() => _ShelfPanelState();
}

class _ShelfPanelState extends State<ShelfPanel> {
  RepoController get ctrl => widget.controller;
  final _scroll = ScrollController();
  final Set<String> _expanded = {};

  /// Selected row: a shelf id, or `<id>/<path>` for a file.
  String? _selected;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Shelf? _selectedShelf(List<Shelf> shelves) {
    final key = _selected;
    if (key == null) return null;
    final id = key.contains('/') ? key.substring(0, key.indexOf('/')) : key;
    return shelves.where((s) => s.id == id).firstOrNull;
  }

  void _toggle(Shelf s) => setState(() => _expanded.contains(s.id) ? _expanded.remove(s.id) : _expanded.add(s.id));

  Future<void> _shelfMenu(Offset pos, Shelf s) async {
    setState(() => _selected = s.id);
    final r = await showContextMenu<String>(context, pos, [
      menuItem('unshelve', 'Unshelve…', icon: Icons.unarchive_outlined),
      menuItem('apply', 'Apply (keep in shelf)', icon: Icons.download_done),
      const PopupMenuDivider(height: 8),
      menuItem('rename', 'Rename…', icon: Icons.edit_outlined),
      menuItem('delete', 'Delete…', icon: Icons.delete_outline),
      const PopupMenuDivider(height: 8),
      menuItem('patch', 'Create Patch…', icon: Icons.save_alt),
      menuItem('copy', 'Copy as Patch', icon: Icons.copy),
    ]);
    if (r == null || !mounted) return;
    switch (r) {
      case 'unshelve':
        await showUnshelveDialog(context, ctrl, s);
      case 'apply':
        await ctrl.unshelve(s, removeApplied: false);
      case 'rename':
        await renameShelfDialog(context, ctrl, s);
      case 'delete':
        await deleteShelfDialog(context, ctrl, s);
      case 'patch':
        final patch = await ctrl.shelfPatch(s);
        if (mounted) await savePatch(context, ctrl, patch, defaultPatchName(ctrl, s.name));
      case 'copy':
        final patch = await ctrl.shelfPatch(s);
        if (mounted) copyPatch(context, patch);
    }
  }

  Future<void> _fileMenu(Offset pos, Shelf s, ShelvedFile f) async {
    setState(() => _selected = '${s.id}/${f.path}');
    final r = await showContextMenu<String>(context, pos, [
      menuItem('unshelve', 'Unshelve This File', icon: Icons.unarchive_outlined),
      menuItem('diff', 'Show Diff', icon: Icons.difference_outlined),
    ]);
    if (r == null || !mounted) return;
    switch (r) {
      case 'unshelve':
        await ctrl.unshelve(s, paths: [f.path]);
      case 'diff':
        await ctrl.showShelfDiff(s, f);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AppColors.background,
      child: ValueListenableBuilder<List<Shelf>>(
        valueListenable: ctrl.shelves,
        builder: (context, shelves, _) {
          final sel = _selectedShelf(shelves);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                height: 34,
                color: AppColors.panel,
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Row(children: [
                  ToolButton(
                    icon: Icons.unarchive_outlined,
                    tooltip: 'Unshelve…',
                    onPressed: sel == null ? null : () => showUnshelveDialog(context, ctrl, sel),
                  ),
                  ToolButton(
                    icon: Icons.download_done,
                    tooltip: 'Apply (keep in shelf)',
                    onPressed: sel == null ? null : () => ctrl.unshelve(sel, removeApplied: false),
                  ),
                  ToolButton(
                    icon: Icons.delete_outline,
                    tooltip: 'Delete…',
                    onPressed: sel == null ? null : () => deleteShelfDialog(context, ctrl, sel),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'Shelve files from the Commit panel (right-click ▸ Shelve Changes…); '
                      'right-click a shelf to unshelve it',
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                    ),
                  ),
                  Text('${shelves.length} shel${shelves.length == 1 ? 'f' : 'ves'}',
                      style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  ToolButton(
                    icon: Icons.unfold_more,
                    tooltip: 'Expand All',
                    onPressed: () => setState(() => _expanded.addAll(shelves.map((s) => s.id))),
                  ),
                  ToolButton(
                    icon: Icons.unfold_less,
                    tooltip: 'Collapse All',
                    onPressed: () => setState(_expanded.clear),
                  ),
                  ToolButton(icon: Icons.refresh, tooltip: 'Refresh', onPressed: ctrl.refreshShelves),
                ]),
              ),
              const Divider(),
              Expanded(child: shelves.isEmpty ? const EmptyHint('No shelved changes', icon: Icons.inventory_outlined) : _list(shelves)),
            ],
          );
        },
      ),
    );
  }

  Widget _list(List<Shelf> shelves) {
    final rows = <Widget Function()>[
      for (final s in shelves) ...[
        () => _shelfRow(s),
        if (_expanded.contains(s.id))
          for (final f in s.files) () => _fileRow(s, f),
      ],
    ];
    return Scrollbar(
      controller: _scroll,
      child: ListView.builder(
        controller: _scroll,
        itemExtent: _rowHeight,
        itemCount: rows.length,
        itemBuilder: (context, i) => rows[i](),
      ),
    );
  }

  Widget _shelfRow(Shelf s) {
    final expanded = _expanded.contains(s.id);
    final n = s.files.length;
    final created = s.created.toLocal();
    return HoverRow(
      selected: _selected == s.id,
      height: _rowHeight,
      padding: const EdgeInsets.only(left: 4, right: 8),
      onTap: () {
        setState(() => _selected = s.id);
        _toggle(s);
      },
      onSecondaryTapDown: (d) => _shelfMenu(d.globalPosition, s),
      child: Row(children: [
        Icon(expanded ? Icons.expand_more : Icons.chevron_right, size: 16, color: AppColors.textDim),
        const SizedBox(width: 2),
        const Icon(Icons.inventory_outlined, size: 15, color: AppColors.textDim),
        const SizedBox(width: 6),
        Flexible(
          child: Text(s.name,
              overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
        ),
        const SizedBox(width: 10),
        Text('$n file${n == 1 ? '' : 's'}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
        if (s.branch != null) ...[
          const SizedBox(width: 10),
          const Icon(Icons.call_split, size: 12, color: AppColors.textMuted),
          const SizedBox(width: 3),
          Flexible(
            child: Text(s.branch!,
                overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ),
        ],
        const Spacer(),
        Tooltip(
          message: formatDateFull(created),
          child: Text(formatRelative(created), style: const TextStyle(fontSize: 12.5, color: AppColors.textDim)),
        ),
      ]),
    );
  }

  Widget _fileRow(Shelf s, ShelvedFile f) {
    final color = changeColor(f.status.changeType);
    return HoverRow(
      selected: _selected == '${s.id}/${f.path}',
      height: _rowHeight,
      padding: const EdgeInsets.only(left: 40, right: 8),
      onTap: () {
        setState(() => _selected = '${s.id}/${f.path}');
        ctrl.showShelfDiff(s, f, preview: true);
      },
      onDoubleTap: () => ctrl.showShelfDiff(s, f),
      onSecondaryTapDown: (d) => _fileMenu(d.globalPosition, s, f),
      child: Row(children: [
        Icon(fileIcon(f.fileName), size: 15, color: color.withValues(alpha: 0.85)),
        const SizedBox(width: 6),
        Text(
          f.fileName,
          style: TextStyle(
            fontSize: 13,
            color: color,
            decoration: f.status == ShelfFileStatus.deleted ? TextDecoration.lineThrough : null,
            decorationColor: AppColors.deleted,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(f.oldPath != null ? '← ${f.oldPath}' : f.directory,
              overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
        ),
      ]),
    );
  }
}
