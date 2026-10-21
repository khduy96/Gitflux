import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../domain/entities/git_models.dart';
import '../../../domain/logic/branch_folders.dart';
import '../common.dart';

/// Opens the branch picker under [anchor]: All, HEAD and the branches as a
/// tree of folders. [current] is the branch shown in the Log, null for all.
/// Returns the picked branch, `''` for All, null when dismissed.
Future<String?> showBranchPicker(
  BuildContext context, {
  required Rect anchor,
  required List<Branch> branches,
  required String? current,
}) {
  return showDialog<String>(
    context: context,
    barrierColor: Colors.transparent,
    builder: (ctx) {
      final screen = MediaQuery.sizeOf(ctx);
      final top = anchor.bottom + 2;
      return Stack(
        children: [
          Positioned(
            left: anchor.left.clamp(0.0, math.max(0.0, screen.width - BranchPicker.width - 4)),
            top: top,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxHeight: math.max(160.0, screen.height - top - 8)),
              child: BranchPicker(branches: branches, current: current),
            ),
          ),
        ],
      );
    },
  );
}

/// Search box over All, HEAD and the Local / Remote branch folders. Opens
/// with every folder closed but the ones down to [current], or to the checked
/// out branch when [current] is null; that branch is the active line. Folders
/// open and close on click or ← / →; ↑ / ↓ and Enter pick a branch.
class BranchPicker extends StatefulWidget {
  const BranchPicker({super.key, required this.branches, required this.current});

  static const width = 300.0;

  final List<Branch> branches;
  final String? current;

  @override
  State<BranchPicker> createState() => _BranchPickerState();
}

/// Line of the picker: All / HEAD, a folder or a branch.
class _Line {
  const _Line.ref(String this.ref, this.label) : row = null;
  _Line.row(BranchTreeRow this.row) : ref = row.branch?.name, label = row.label;

  /// Value picked: '' for All, null for a folder.
  final String? ref;
  final String label;
  final BranchTreeRow? row;

  bool get isFolder => ref == null;
  int get depth => row?.depth ?? 0;
}

class _BranchPickerState extends State<BranchPicker> {
  static const _rowHeight = 24.0;

  final _query = TextEditingController();
  final _scroll = ScrollController();
  late final _roots = [
    buildBranchFolder('Local', 'Local', widget.branches.where((b) => !b.isRemote)),
    buildBranchFolder('Remote', 'Remote', widget.branches.where((b) => b.isRemote)),
  ];
  /// Branch revealed on opening: the one shown in the Log, else the checked out one.
  late final _target = widget.current ?? widget.branches.where((b) => b.isCurrent).firstOrNull?.name ?? '';

  /// Keys of the open folders.
  late final _open = {
    for (final b in widget.branches)
      if (b.name == _target) ...branchFolderPath(b.isRemote ? 'Remote' : 'Local', b.name),
  };
  late var _lines = _build();
  late var _active = math.max(0, _lines.indexWhere((l) => l.ref == _target));

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reveal());
  }

  @override
  void dispose() {
    _query.dispose();
    _scroll.dispose();
    super.dispose();
  }

  List<_Line> _build() {
    final q = _query.text.trim();
    final lines = [
      if (q.isEmpty) ...const [_Line.ref('', 'All'), _Line.ref('HEAD', 'HEAD')],
    ];
    for (final root in _roots) {
      final open = q.isNotEmpty || _open.contains(root.key);
      final inner = open
          ? branchTreeRows(root, isOpen: (f) => _open.contains(f.key), query: q, depth: 1)
          : const <BranchTreeRow>[];
      if (root.count == 0 || (q.isNotEmpty && inner.isEmpty)) continue;
      lines
        ..add(_Line.row(BranchTreeRow.folder(root, depth: 0, open: open)))
        ..addAll(inner.map(_Line.row));
    }
    return lines;
  }

  void _setActive(int i) {
    setState(() => _active = i.clamp(0, math.max(0, _lines.length - 1)));
    _reveal();
  }

  /// Scrolls the active line into view.
  void _reveal() {
    if (!_scroll.hasClients) return;
    final top = _active * _rowHeight;
    final view = _scroll.position.viewportDimension;
    if (top < _scroll.offset) {
      _scroll.jumpTo(top);
    } else if (top + _rowHeight > _scroll.offset + view) {
      _scroll.jumpTo(math.min(top + _rowHeight - view, _scroll.position.maxScrollExtent));
    }
  }

  /// A folder opens / closes (all stay open while searching); a branch is
  /// the answer.
  void _pick(_Line l) {
    if (!l.isFolder) {
      Navigator.pop(context, l.ref);
      return;
    }
    if (_query.text.trim().isNotEmpty) return;
    final key = l.row!.folder!.key;
    setState(() {
      if (!_open.remove(key)) _open.add(key);
      _lines = _build();
    });
  }

  KeyEventResult _onKey(FocusNode _, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    final l = _lines.isEmpty ? null : _lines[_active];
    final key = e.logicalKey;
    if (key == LogicalKeyboardKey.arrowDown || key == LogicalKeyboardKey.arrowUp) {
      _setActive(_active + (key == LogicalKeyboardKey.arrowDown ? 1 : -1));
    } else if (key == LogicalKeyboardKey.enter && l != null) {
      _pick(l);
    } else if (l != null &&
        l.isFolder &&
        _query.text.isEmpty &&
        (key == LogicalKeyboardKey.arrowRight && !l.row!.open || key == LogicalKeyboardKey.arrowLeft && l.row!.open)) {
      _pick(l);
    } else {
      return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.panel,
      elevation: 8,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(6),
        side: const BorderSide(color: AppColors.border),
      ),
      child: SizedBox(
        width: BranchPicker.width,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(6),
              child: SizedBox(
                height: 26,
                child: Focus(
                  skipTraversal: true,
                  onKeyEvent: _onKey,
                  child: TextField(
                    controller: _query,
                    autofocus: true,
                    style: const TextStyle(fontSize: 12.5),
                    decoration: const InputDecoration(
                      hintText: 'Search branches',
                      prefixIcon: Icon(Icons.search, size: 15),
                      prefixIconConstraints: BoxConstraints(minWidth: 28),
                      contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                    ),
                    onChanged: (_) {
                      setState(() => _lines = _build());
                      _setActive(math.max(0, _lines.indexWhere((l) => !l.isFolder)));
                    },
                  ),
                ),
              ),
            ),
            if (_lines.isEmpty)
              const Padding(
                padding: EdgeInsets.fromLTRB(12, 4, 12, 10),
                child: Text('No branches', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
              )
            else
              Flexible(
                child: ListView.builder(
                  controller: _scroll,
                  shrinkWrap: true,
                  padding: const EdgeInsets.only(bottom: 4),
                  itemExtent: _rowHeight,
                  itemCount: _lines.length,
                  itemBuilder: (_, i) => _line(i),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _line(int i) {
    final l = _lines[i];
    final b = l.row?.branch;
    final current = !l.isFolder && l.ref == (widget.current ?? '');
    final (icon, color) = l.isFolder
        ? (
            l.depth > 0
                ? Icons.folder_outlined
                : l.label == 'Remote'
                ? Icons.cloud_outlined
                : Icons.computer,
            AppColors.textDim,
          )
        : b != null
        ? (Icons.call_split, b.isRemote ? AppColors.remoteRef : AppColors.localRef)
        : l.ref == 'HEAD'
        ? (Icons.my_location, AppColors.headRef)
        : (Icons.all_inclusive, AppColors.textDim);
    final row = HoverRow(
      selected: i == _active,
      padding: EdgeInsets.only(left: 4.0 + l.depth * 14, right: 8),
      onTap: () {
        setState(() => _active = i);
        _pick(l);
      },
      child: Row(
        children: [
          SizedBox(
            width: 16,
            child: l.isFolder
                ? Icon(l.row!.open ? Icons.expand_more : Icons.chevron_right, size: 16, color: AppColors.textDim)
                : null,
          ),
          const SizedBox(width: 2),
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              l.label,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, fontWeight: current ? FontWeight.w600 : null),
            ),
          ),
          if (l.isFolder)
            Text('${l.row!.folder!.count}', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
          if (current) const Icon(Icons.check, size: 14, color: AppColors.textDim),
        ],
      ),
    );
    return b == null ? row : Tooltip(message: b.name, waitDuration: const Duration(milliseconds: 600), child: row);
  }
}
