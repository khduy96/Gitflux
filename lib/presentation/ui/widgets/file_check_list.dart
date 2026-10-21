import 'package:flutter/material.dart';

import '../../../domain/entities/git_models.dart';
import '../common.dart';

/// A file of a [FileCheckList].
class FileCheckItem {
  const FileCheckItem({required this.path, required this.type, this.oldPath, this.note});

  final String path;
  final String? oldPath;
  final ChangeType type;

  /// Shown after the directory, e.g. "+3 −1".
  final String? note;

  String get fileName {
    final i = path.lastIndexOf('/');
    return i < 0 ? path : path.substring(i + 1);
  }

  String get directory {
    final i = path.lastIndexOf('/');
    return i < 0 ? '' : path.substring(0, i);
  }
}

/// Bordered list of files with a checkbox each, as in the dialogs of
/// Android Studio (Rollback, Shelve, Unshelve, Create Patch).
class FileCheckList extends StatelessWidget {
  const FileCheckList({
    super.key,
    required this.items,
    required this.checked,
    required this.onChanged,
    this.maxHeight = 280,
  });

  final List<FileCheckItem> items;

  /// Paths of the checked items.
  final Set<String> checked;
  final void Function(Set<String> checked) onChanged;
  final double maxHeight;

  void _toggle(String path, bool value) =>
      onChanged(value ? ({...checked, path}) : ({...checked}..remove(path)));

  @override
  Widget build(BuildContext context) {
    final all = items.isNotEmpty && items.every((i) => checked.contains(i.path));
    final none = items.every((i) => !checked.contains(i.path));
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          constraints: BoxConstraints(maxHeight: maxHeight),
          decoration: BoxDecoration(
            border: Border.all(color: AppColors.border),
            color: AppColors.background,
          ),
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final c in items)
                HoverRow(
                  onTap: () => _toggle(c.path, !checked.contains(c.path)),
                  child: Row(children: [
                    Transform.scale(
                      scale: 0.8,
                      child: Checkbox(
                        value: checked.contains(c.path),
                        onChanged: (v) => _toggle(c.path, v == true),
                      ),
                    ),
                    Icon(fileIcon(c.fileName), size: 15, color: changeColor(c.type)),
                    const SizedBox(width: 6),
                    Text(c.fileName,
                        style: TextStyle(
                          fontSize: 13,
                          color: changeColor(c.type),
                          decoration: c.type == ChangeType.deleted ? TextDecoration.lineThrough : null,
                          decorationColor: AppColors.deleted,
                        )),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(c.oldPath != null ? '← ${c.oldPath}' : c.directory,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                    ),
                    if (c.note != null)
                      Padding(
                        padding: const EdgeInsets.only(left: 8),
                        child: Text(c.note!, style: monoStyle(size: 11.5, color: AppColors.textDim)),
                      ),
                  ]),
                ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        Row(children: [
          Expanded(
            child: Text('${items.where((i) => checked.contains(i.path)).length} of ${items.length} files selected',
                overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ),
          TextButton(
            onPressed: all ? null : () => onChanged({for (final i in items) i.path}),
            child: const Text('Select All'),
          ),
          TextButton(
            onPressed: none ? null : () => onChanged({}),
            child: const Text('Select None'),
          ),
        ]),
      ],
    );
  }
}
