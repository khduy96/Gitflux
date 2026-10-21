import 'package:flutter/material.dart';

import '../../../domain/entities/git_models.dart';
import '../../../domain/entities/shelf.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import '../widgets/file_check_list.dart';
import 'basic_dialogs.dart';

/// Files that can be put in a shelf (not conflicted, not a submodule or a
/// nested repository).
bool canShelve(FileChange c) => c.type != ChangeType.conflicted && !c.isSubmodule && !c.nestedRepo;

/// "Shelve Changes…": all local changes are listed, [chosen] are checked.
/// [name] is proposed as the shelf name (e.g. the name of a changelist).
Future<void> showShelveDialog(BuildContext context, RepoController ctrl, List<FileChange> chosen, {String? name}) async {
  final s = ctrl.status.value;
  if (s.state != RepoState.normal) {
    ctrl.notify(AppNotification('Cannot shelve now',
        details: 'Finish or abort the ${s.state.operation} first.', isError: true));
    return;
  }
  final changes = s.changes.where(canShelve).toList();
  if (changes.isEmpty) {
    ctrl.notify(AppNotification('No changes to shelve', isError: true));
    return;
  }
  await showDialog<void>(
    context: context,
    builder: (_) => _ShelveDialog(
      ctrl: ctrl,
      changes: changes,
      chosen: {for (final c in chosen) if (canShelve(c)) c.path},
      skipped: [for (final c in chosen) if (c.isSubmodule || c.nestedRepo) c.path],
      name: name,
    ),
  );
}

class _ShelveDialog extends StatefulWidget {
  const _ShelveDialog(
      {required this.ctrl, required this.changes, required this.chosen, required this.skipped, this.name});

  final RepoController ctrl;
  final List<FileChange> changes;
  final Set<String> chosen;
  final List<String> skipped;
  final String? name;

  @override
  State<_ShelveDialog> createState() => _ShelveDialogState();
}

class _ShelveDialogState extends State<_ShelveDialog> {
  late final TextEditingController _name = () {
    final name = widget.name ?? widget.ctrl.newShelfName;
    return TextEditingController(text: name)..selection = TextSelection(baseOffset: 0, extentOffset: name.length);
  }();
  late Set<String> _checked = {...widget.chosen};
  bool _keep = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  List<FileChange> get _selected => widget.changes.where((c) => _checked.contains(c.path)).toList();

  bool get _canShelve => _checked.isNotEmpty && _name.text.trim().isNotEmpty;

  Future<void> _shelve() async {
    if (!_canShelve) return;
    final selected = _selected;
    Navigator.pop(context);
    await widget.ctrl.shelveChanges(_name.text.trim(), selected, keep: _keep);
  }

  @override
  Widget build(BuildContext context) {
    final partial = _selected.where((c) => widget.ctrl.lineSelections.value.containsKey(c.path)).toList();
    return AppDialog(
      title: 'Shelve Changes',
      width: 600,
      onSubmit: _shelve,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _canShelve ? _shelve : null, child: const Text('Shelve Changes')),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _name,
            autofocus: true,
            style: const TextStyle(fontSize: 13),
            decoration: const InputDecoration(labelText: 'Name'),
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _shelve(),
          ),
          const SizedBox(height: 10),
          Flexible(
            child: FileCheckList(
              items: [
                for (final c in widget.changes) FileCheckItem(path: c.path, oldPath: c.oldPath, type: c.type),
              ],
              checked: _checked,
              onChanged: (v) => setState(() => _checked = v),
            ),
          ),
          CheckboxListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _keep,
            title: const Text('Keep changes in working tree', style: TextStyle(fontSize: 13)),
            onChanged: (v) => setState(() => _keep = v ?? false),
          ),
          if (partial.isNotEmpty)
            _Note('Only some lines of ${partial.map((c) => c.fileName).join(', ')} are selected for commit; '
                'shelving takes the whole file.'),
          if (widget.skipped.isNotEmpty)
            _Note('Submodules are not shelved: ${widget.skipped.join(', ')}'),
        ],
      ),
    );
  }
}

/// "Unshelve…": the files of [shelf] (or [paths] of it) are checked.
Future<void> showUnshelveDialog(BuildContext context, RepoController ctrl, Shelf shelf, {Set<String>? paths}) async {
  await showDialog<void>(
    context: context,
    builder: (_) => _UnshelveDialog(ctrl: ctrl, shelf: shelf, initial: paths),
  );
}

class _UnshelveDialog extends StatefulWidget {
  const _UnshelveDialog({required this.ctrl, required this.shelf, this.initial});

  final RepoController ctrl;
  final Shelf shelf;
  final Set<String>? initial;

  @override
  State<_UnshelveDialog> createState() => _UnshelveDialogState();
}

class _UnshelveDialogState extends State<_UnshelveDialog> {
  late Set<String> _checked = widget.initial ?? {for (final f in widget.shelf.files) f.path};
  bool _remove = true;

  Future<void> _unshelve() async {
    if (_checked.isEmpty) return;
    final all = _checked.length == widget.shelf.files.length;
    final paths = [for (final f in widget.shelf.files) if (_checked.contains(f.path)) f.path];
    Navigator.pop(context);
    await widget.ctrl.unshelve(widget.shelf, paths: all ? null : paths, removeApplied: _remove);
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.shelf;
    return AppDialog(
      title: 'Unshelve Changes',
      width: 600,
      onSubmit: _unshelve,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _checked.isEmpty ? null : _unshelve, child: const Text('Unshelve')),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(s.name, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          const SizedBox(height: 2),
          Text(
            'Shelved ${formatRelative(s.created.toLocal())}'
            '${s.branch == null ? '' : ' on ${s.branch}'} · base ${s.shortBase}',
            style: const TextStyle(fontSize: 12, color: AppColors.textDim),
          ),
          const SizedBox(height: 10),
          Flexible(
            child: FileCheckList(
              items: [
                for (final f in s.files) FileCheckItem(path: f.path, oldPath: f.oldPath, type: f.status.changeType),
              ],
              checked: _checked,
              onChanged: (v) => setState(() => _checked = v),
            ),
          ),
          CheckboxListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _remove,
            title: const Text('Remove successfully applied files from shelf', style: TextStyle(fontSize: 13)),
            onChanged: (v) => setState(() => _remove = v ?? true),
          ),
          const _Note('Changes are merged with your local changes (3-way). Conflicting files get conflict '
              'markers and stay in the shelf.'),
        ],
      ),
    );
  }
}

/// Rename of a shelf.
Future<void> renameShelfDialog(BuildContext context, RepoController ctrl, Shelf shelf) async {
  final name = await showInput(context,
      title: 'Rename Shelf',
      label: 'New name:',
      initial: shelf.name,
      confirmLabel: 'Rename',
      validator: (v) => v.trim().isEmpty ? 'Name cannot be empty' : null);
  if (name == null || name.trim() == shelf.name) return;
  await ctrl.renameShelf(shelf, name);
}

/// Delete of a shelf, after confirmation.
Future<void> deleteShelfDialog(BuildContext context, RepoController ctrl, Shelf shelf) async {
  final n = shelf.files.length;
  final ok = await showConfirm(context,
      title: 'Delete Shelf',
      message: 'Delete the shelf "${shelf.name}" ($n file${n == 1 ? '' : 's'})? This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true);
  if (ok) await ctrl.deleteShelf(shelf);
}

class _Note extends StatelessWidget {
  const _Note(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Icon(Icons.info_outline, size: 14, color: AppColors.textMuted),
          const SizedBox(width: 6),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 12, color: AppColors.textMuted))),
        ]),
      );
}
