import 'package:flutter/material.dart';

import '../../../domain/entities/changelist.dart';
import '../../../domain/entities/git_models.dart';
import '../../../domain/logic/changelists.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import 'basic_dialogs.dart';

/// "New Changelist…": name, draft commit message and "Set active". Returns
/// the id of the new list.
Future<String?> showNewChangelistDialog(BuildContext context, RepoController ctrl) async {
  final r = await showDialog<_ChangelistInput>(
    context: context,
    builder: (_) => _ChangelistDialog(ctrl: ctrl, title: 'New Changelist', confirmLabel: 'Create'),
  );
  if (r == null) return null;
  return ctrl.createChangelist(r.name, comment: r.comment, active: r.active);
}

/// "Edit Changelist…". The comment of the active list is the commit
/// message box.
Future<void> showEditChangelistDialog(BuildContext context, RepoController ctrl, Changelist list) async {
  final isActive = list.id == ctrl.changelists.value.active;
  final r = await showDialog<_ChangelistInput>(
    context: context,
    builder: (_) => _ChangelistDialog(
      ctrl: ctrl,
      title: 'Edit Changelist',
      confirmLabel: 'OK',
      list: list,
      comment: isActive ? ctrl.draftMessage : list.comment,
      active: isActive,
    ),
  );
  if (r == null) return;
  await ctrl.editChangelist(list.id, name: r.name, comment: r.comment, active: r.active);
}

/// "Delete Changelist…" after a confirmation naming where its files go.
Future<void> deleteChangelistDialog(BuildContext context, RepoController ctrl, Changelist list) async {
  final lists = ctrl.changelists.value;
  final target = lists.byId(deleteTarget(lists, list.id));
  final n = list.files.length;
  final ok = await showConfirm(
    context,
    title: 'Delete Changelist',
    message: 'Delete changelist "${list.name}"?'
        '${n == 0 || target == null ? '' : '\n$n file${n == 1 ? '' : 's'} will be moved to "${target.name}".'}'
        '${list.id == lists.active && target != null ? '\n"${target.name}" becomes the active changelist.' : ''}',
    confirmLabel: 'Delete',
    destructive: true,
  );
  if (ok) await ctrl.deleteChangelist(list.id);
}

/// "Move to Another Changelist…" (F6): an existing list or a new one.
Future<void> showMoveToChangelistDialog(BuildContext context, RepoController ctrl, List<FileChange> files) async {
  final movable = files.where((c) => c.type != ChangeType.conflicted && !c.nestedRepo).toList();
  if (movable.isEmpty) return;
  final r = await showDialog<({String? id, String? newName, bool active})>(
    context: context,
    builder: (_) => _MoveDialog(ctrl: ctrl, files: movable),
  );
  if (r == null) return;
  var id = r.id;
  final newName = r.newName;
  if (newName != null) id = await ctrl.createChangelist(newName, active: r.active);
  if (id != null) await ctrl.moveToChangelist(movable, id);
}

/// Not asked again in this session once ticked.
bool _dontAskDeleteEmpty = false;

/// After a commit emptied list [id] (not the default one): "Delete
/// changelist "name"?".
Future<void> offerDeleteEmptyChangelist(BuildContext context, RepoController ctrl, String id) async {
  final list = ctrl.changelists.value.byId(id);
  if (_dontAskDeleteEmpty || list == null || list.isDefault || list.files.isNotEmpty) return;
  var dontAsk = false;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setLocal) => AppDialog(
        title: 'Delete Changelist',
        leftActions: [
          InkWell(
            onTap: () => setLocal(() => dontAsk = !dontAsk),
            child: Row(children: [
              Transform.scale(
                scale: 0.8,
                child: Checkbox(value: dontAsk, onChanged: (v) => setLocal(() => dontAsk = v ?? false)),
              ),
              const Text("Don't ask again for this session", style: TextStyle(fontSize: 12.5)),
            ]),
          ),
        ],
        actions: [
          OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep')),
          FilledButton(autofocus: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
        child: Text("Delete changelist '${list.name}'?\nAll its changes were committed.",
            style: const TextStyle(fontSize: 13, height: 1.4)),
      ),
    ),
  );
  if (dontAsk) _dontAskDeleteEmpty = true;
  if (ok == true) await ctrl.deleteChangelist(id);
}

class _ChangelistInput {
  const _ChangelistInput(this.name, this.comment, this.active);

  final String name;
  final String comment;
  final bool active;
}

class _ChangelistDialog extends StatefulWidget {
  const _ChangelistDialog({
    required this.ctrl,
    required this.title,
    required this.confirmLabel,
    this.list,
    this.comment = '',
    this.active = false,
  });

  final RepoController ctrl;
  final String title;
  final String confirmLabel;

  /// The list being edited, null for a new one.
  final Changelist? list;
  final String comment;
  final bool active;

  @override
  State<_ChangelistDialog> createState() => _ChangelistDialogState();
}

class _ChangelistDialogState extends State<_ChangelistDialog> {
  late final _name = TextEditingController(text: widget.list?.name ?? '')
    ..selection = TextSelection(baseOffset: 0, extentOffset: widget.list?.name.length ?? 0);
  late final _comment = TextEditingController(text: widget.comment);
  late bool _active = widget.active;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _comment.dispose();
    super.dispose();
  }

  void _submit() {
    final error = validateChangelistName(widget.ctrl.changelists.value, _name.text, exceptId: widget.list?.id);
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    Navigator.pop(context, _ChangelistInput(_name.text.trim(), _comment.text, _active));
  }

  @override
  Widget build(BuildContext context) {
    // The active list stays active (another one is made active instead).
    final activeLocked = widget.active;
    return AppDialog(
      title: widget.title,
      onSubmit: _submit,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _submit, child: Text(widget.confirmLabel)),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _name,
            autofocus: true,
            style: const TextStyle(fontSize: 13),
            decoration: InputDecoration(labelText: 'Name', errorText: _error),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _comment,
            minLines: 3,
            maxLines: 8,
            style: const TextStyle(fontSize: 13),
            decoration: const InputDecoration(labelText: 'Comment (commit message draft)', alignLabelWithHint: true),
          ),
          const SizedBox(height: 4),
          CheckboxListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _active,
            title: const Text('Set active', style: TextStyle(fontSize: 13)),
            onChanged: activeLocked ? null : (v) => setState(() => _active = v ?? false),
          ),
        ],
      ),
    );
  }
}

class _MoveDialog extends StatefulWidget {
  const _MoveDialog({required this.ctrl, required this.files});

  final RepoController ctrl;
  final List<FileChange> files;

  @override
  State<_MoveDialog> createState() => _MoveDialogState();
}

class _MoveDialogState extends State<_MoveDialog> {
  /// Picked list id, or null for a new list.
  String? _target;
  final _name = TextEditingController();
  bool _active = false;
  String? _error;

  Changelists get _lists => widget.ctrl.changelists.value;

  @override
  void initState() {
    super.initState();
    // Proposes the first list that does not hold all the files.
    final from = {for (final f in widget.files) _lists.listOf(f.path)?.id};
    _target = _lists.lists.where((l) => !(from.length == 1 && from.contains(l.id))).firstOrNull?.id;
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _submit() {
    if (_target != null) {
      Navigator.pop(context, (id: _target, newName: null, active: false));
      return;
    }
    final error = validateChangelistName(_lists, _name.text);
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    Navigator.pop(context, (id: null, newName: _name.text.trim(), active: _active));
  }

  @override
  Widget build(BuildContext context) {
    final n = widget.files.length;
    final lists = _lists;
    Widget option(String? id, Widget label) => InkWell(
          onTap: () => setState(() => _target = id),
          child: Row(children: [
            Radio<String?>(value: id),
            const SizedBox(width: 2),
            Expanded(child: label),
          ]),
        );
    return AppDialog(
      title: 'Move to Another Changelist',
      onSubmit: _submit,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _submit, child: const Text('Move')),
      ],
      child: RadioGroup<String?>(
        groupValue: _target,
        onChanged: (v) => setState(() => _target = v),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(n == 1 ? 'Move ${widget.files.first.path} to:' : 'Move $n files to:',
                overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, color: AppColors.textDim)),
            const SizedBox(height: 6),
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final l in lists.lists)
                      option(
                        l.id,
                        Text(
                          '${l.name}${l.id == lists.active ? ' (active)' : ''}',
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 13, fontWeight: l.id == lists.active ? FontWeight.w600 : FontWeight.normal),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            option(null, const Text('New Changelist…', style: TextStyle(fontSize: 13))),
            if (_target == null) ...[
              Padding(
                padding: const EdgeInsets.only(left: 36),
                child: TextField(
                  controller: _name,
                  autofocus: true,
                  style: const TextStyle(fontSize: 13),
                  decoration: InputDecoration(labelText: 'Name', errorText: _error),
                  onChanged: (_) {
                    if (_error != null) setState(() => _error = null);
                  },
                  onSubmitted: (_) => _submit(),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(left: 28),
                child: CheckboxListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _active,
                  title: const Text('Set active', style: TextStyle(fontSize: 13)),
                  onChanged: (v) => setState(() => _active = v ?? false),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
