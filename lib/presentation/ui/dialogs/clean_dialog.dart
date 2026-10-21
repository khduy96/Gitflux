import 'package:flutter/material.dart';

import '../../../domain/entities/clean.dart';
import '../../../domain/entities/git_models.dart';
import '../../../domain/errors.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import 'basic_dialogs.dart';

/// "Clean Working Tree…": lists what `git clean` would remove and deletes the checked entries.
Future<void> showCleanDialog(BuildContext context, RepoController ctrl) async {
  await showDialog<void>(
    context: context,
    builder: (_) => _CleanDialog(ctrl: ctrl),
  );
}

class _CleanDialog extends StatefulWidget {
  const _CleanDialog({required this.ctrl});

  final RepoController ctrl;

  @override
  State<_CleanDialog> createState() => _CleanDialogState();
}

class _CleanDialogState extends State<_CleanDialog> {
  CleanOptions _options = const CleanOptions();
  List<CleanEntry>? _entries;
  String? _error;
  int _load = 0;

  /// Choices of the user by pathspec; kept when the preview is recomputed.
  final Map<String, bool> _choice = {};

  @override
  void initState() {
    super.initState();
    _preview();
  }

  Future<void> _preview() async {
    final load = ++_load;
    try {
      final entries = await widget.ctrl.cleanPreview(_options);
      if (mounted && load == _load) setState(() => _entries = entries);
    } catch (e) {
      if (mounted && load == _load) setState(() => _error = e is GitException ? e.message : '$e');
    }
  }

  void _setOptions(CleanOptions options) {
    setState(() {
      _options = options;
      _entries = null;
      _error = null;
    });
    _preview();
  }

  bool _checked(CleanEntry e) => _choice[e.pathspec] ?? !e.nestedRepo;

  List<CleanEntry> get _selected => [for (final e in _entries ?? const <CleanEntry>[]) if (_checked(e)) e];

  Future<void> _clean() async {
    final selected = _selected;
    if (selected.isEmpty) return;
    final n = selected.length;
    final nested = selected.where((e) => e.nestedRepo).length;
    final ok = await showConfirm(
      context,
      title: 'Clean Working Tree',
      message: 'Delete $n untracked item${n == 1 ? '' : 's'}? This cannot be undone.'
          '${nested == 0 ? '' : '\n\n$nested nested repositor${nested == 1 ? 'y is' : 'ies are'} '
              'deleted with their whole history.'}',
      confirmLabel: 'Delete',
      destructive: true,
    );
    if (!ok || !mounted) return;
    Navigator.pop(context);
    await widget.ctrl.clean(selected, _options);
  }

  @override
  Widget build(BuildContext context) {
    final entries = _entries;
    final selected = _selected;
    final nested = selected.where((e) => e.nestedRepo).toList();
    return AppDialog(
      title: 'Clean Working Tree',
      width: 620,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AppColors.error),
          onPressed: selected.isEmpty ? null : _clean,
          child: const Text('Clean…'),
        ),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Option(
            label: 'Remove untracked directories',
            value: _options.directories,
            onChanged: (v) => _setOptions(_options.copyWith(directories: v)),
          ),
          _Option(
            label: 'Include ignored files',
            value: _options.includeIgnored,
            onChanged: (v) => _setOptions(_options.copyWith(includeIgnored: v)),
          ),
          const SizedBox(height: 8),
          Flexible(
            child: Container(
              constraints: const BoxConstraints(maxHeight: 320, minHeight: 80),
              decoration: BoxDecoration(
                border: Border.all(color: AppColors.border),
                color: AppColors.background,
              ),
              child: _error != null
                  ? EmptyHint(_error!, icon: Icons.error_outline)
                  : entries == null
                      ? const Center(
                          child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
                      : entries.isEmpty
                          ? const EmptyHint('Nothing to clean')
                          : ListView(
                              shrinkWrap: true,
                              children: [
                                for (final e in entries)
                                  _EntryRow(
                                    entry: e,
                                    checked: _checked(e),
                                    onChanged: (v) => setState(() => _choice[e.pathspec] = v),
                                  ),
                              ],
                            ),
            ),
          ),
          const SizedBox(height: 6),
          Row(children: [
            Expanded(
              child: Text(
                entries == null ? '' : '${selected.length} of ${entries.length} items selected',
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
              ),
            ),
            TextButton(
              // Nested repositories keep their state: they are only deleted on purpose.
              onPressed: entries == null || entries.every((e) => e.nestedRepo || _checked(e))
                  ? null
                  : () => setState(() {
                        for (final e in entries) {
                          if (!e.nestedRepo) _choice[e.pathspec] = true;
                        }
                      }),
              child: const Text('Select All'),
            ),
            TextButton(
              onPressed: selected.isEmpty
                  ? null
                  : () => setState(() {
                        for (final e in entries!) {
                          _choice[e.pathspec] = false;
                        }
                      }),
              child: const Text('Select None'),
            ),
          ]),
          if (nested.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Icon(Icons.warning_amber_rounded, size: 15, color: AppColors.warning),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'Nested repositories are removed with git clean -ff, together with their whole history: '
                    '${nested.map((e) => e.path).join(', ')}',
                    style: const TextStyle(fontSize: 12, color: AppColors.warning),
                  ),
                ),
              ]),
            ),
        ],
      ),
    );
  }
}

class _Option extends StatelessWidget {
  const _Option({required this.label, required this.value, required this.onChanged});

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) => CheckboxListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
        controlAffinity: ListTileControlAffinity.leading,
        value: value,
        title: Text(label, style: const TextStyle(fontSize: 13)),
        onChanged: (v) => onChanged(v ?? false),
      );
}

/// A file or directory of the preview, with its checkbox and tags.
class _EntryRow extends StatelessWidget {
  const _EntryRow({required this.entry, required this.checked, required this.onChanged});

  final CleanEntry entry;
  final bool checked;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final e = entry;
    final color = e.ignored ? AppColors.textDim : changeColor(ChangeType.untracked);
    final icon = e.nestedRepo
        ? Icons.folder_special_outlined
        : e.isDirectory
            ? Icons.folder_outlined
            : fileIcon(e.fileName);
    return HoverRow(
      onTap: () => onChanged(!checked),
      child: Row(children: [
        Transform.scale(
          scale: 0.8,
          child: Checkbox(value: checked, onChanged: (v) => onChanged(v == true)),
        ),
        Icon(icon, size: 15, color: color),
        const SizedBox(width: 6),
        Text(e.isDirectory ? '${e.fileName}/' : e.fileName, style: TextStyle(fontSize: 13, color: color)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(e.directory,
              overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
        ),
        if (e.nestedRepo) const _Tag('nested repository', AppColors.warning),
        if (e.ignored) const _Tag('ignored', AppColors.textMuted),
      ]),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.text, this.color);

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(left: 8),
        child: Text(text, style: monoStyle(size: 11.5, color: color)),
      );
}
