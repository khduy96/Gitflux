import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../../../domain/entities/git_models.dart';
import '../../../domain/entities/worktree.dart';
import '../../../domain/errors.dart';
import '../../../domain/logic/worktree_parser.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import 'basic_dialogs.dart';

// -----------------------------------------------------------------------------
// New Worktree
// -----------------------------------------------------------------------------

/// "New Worktree…", or "Checkout in New Worktree…" when [branch] is given:
/// a free local branch is checked out as is, a remote branch or a branch
/// already checked out somewhere becomes the start point of a new branch.
Future<void> showNewWorktreeDialog(BuildContext context, RepoController ctrl, {Branch? branch}) async {
  final r = await showDialog<({String path, WorktreeCheckout checkout})>(
    context: context,
    builder: (_) => _NewWorktreeDialog(ctrl: ctrl, branch: branch),
  );
  if (r == null) return;
  final ok = await ctrl.addWorktree(r.path, r.checkout);
  if (ok) {
    ctrl.notify(AppNotification('Worktree created',
        details: r.path, actionLabel: 'Open', onAction: () => ctrl.openRepo(r.path)));
  }
}

enum _Mode { existing, newBranch, detached }

class _NewWorktreeDialog extends StatefulWidget {
  const _NewWorktreeDialog({required this.ctrl, this.branch});

  final RepoController ctrl;
  final Branch? branch;

  @override
  State<_NewWorktreeDialog> createState() => _NewWorktreeDialogState();
}

class _NewWorktreeDialogState extends State<_NewWorktreeDialog> {
  late final List<Branch> _local = widget.ctrl.branches.value.where((b) => !b.isRemote).toList();

  /// Local branches that can be checked out in a new folder.
  late final List<String> _free = [
    for (final b in _local)
      if (!b.isCurrent && b.worktree == null) b.name,
  ];

  final _path = TextEditingController();
  final _name = TextEditingController();
  final _start = TextEditingController(text: 'HEAD');
  final _revision = TextEditingController(text: 'HEAD');
  _Mode _mode = _Mode.newBranch;
  String? _existing;
  bool _pathEdited = false;
  String? _pathError;
  String? _nameError;

  @override
  void initState() {
    super.initState();
    final b = widget.branch;
    if (b != null && !b.isRemote && _free.contains(b.name)) {
      _mode = _Mode.existing;
      _existing = b.name;
    } else if (b != null) {
      // Remote branch: a local one of the same name; a branch checked out
      // here or elsewhere: a new branch the user names.
      _name.text = b.isRemote ? b.shortName : '';
      _start.text = b.name;
    }
    _existing ??= _free.firstOrNull;
    _updateDefaultPath();
  }

  @override
  void dispose() {
    _path.dispose();
    _name.dispose();
    _start.dispose();
    _revision.dispose();
    super.dispose();
  }

  /// Name the default folder is derived from.
  String? get _pathSource => switch (_mode) {
        _Mode.existing => _existing,
        _Mode.newBranch => _name.text,
        _Mode.detached => _revision.text,
      };

  /// Keeps the default path in sync until the user edits it.
  void _updateDefaultPath() {
    if (_pathEdited) return;
    _path.text = defaultWorktreePath(widget.ctrl.root, _pathSource);
  }

  void _setMode(_Mode m) => setState(() {
        _mode = m;
        _nameError = null;
        _updateDefaultPath();
      });

  Future<void> _browse() async {
    final d = await FilePicker.getDirectoryPath(dialogTitle: 'Worktree Location');
    if (d == null || !mounted) return;
    // An empty folder is used as is, otherwise the worktree goes inside it.
    final dir = Directory(d);
    final empty = !dir.existsSync() || dir.listSync().isEmpty;
    setState(() {
      _pathEdited = true;
      _pathError = null;
      _path.text = empty ? d : p.join(d, p.basename(defaultWorktreePath(widget.ctrl.root, _pathSource)));
    });
  }

  String? _validatePath(String path) {
    if (path.isEmpty) return 'Enter the folder of the worktree';
    if (FileSystemEntity.isFileSync(path)) return 'A file exists at this path';
    final dir = Directory(path);
    if (dir.existsSync() && dir.listSync().isNotEmpty) return 'The folder already exists and is not empty';
    return null;
  }

  void _submit() {
    final t = _path.text.trim();
    final path = t.isEmpty || p.isAbsolute(t) ? t : p.join(widget.ctrl.root, t);
    final pathError = _validatePath(path);
    String? nameError;
    WorktreeCheckout? checkout;
    String? rev(TextEditingController c) => c.text.trim().isEmpty || c.text.trim() == 'HEAD' ? null : c.text.trim();
    switch (_mode) {
      case _Mode.existing:
        if (_existing != null) checkout = ExistingBranchCheckout(_existing!);
      case _Mode.newBranch:
        final n = _name.text.trim();
        nameError = validateRefName(n, existing: _local.map((b) => b.name));
        checkout = NewBranchCheckout(n, startPoint: rev(_start));
      case _Mode.detached:
        checkout = DetachedCheckout(revision: rev(_revision));
    }
    if (pathError != null || nameError != null || checkout == null) {
      setState(() {
        _pathError = pathError;
        _nameError = nameError;
      });
      return;
    }
    Navigator.pop(context, (path: path, checkout: checkout));
  }

  Widget _field(TextEditingController c, {String? error, bool autofocus = false, bool enabled = true}) => TextField(
        controller: c,
        enabled: enabled,
        autofocus: autofocus,
        style: const TextStyle(fontSize: 13),
        decoration: InputDecoration(isDense: true, errorText: error),
        onChanged: (_) => setState(() {
          _nameError = null;
          _updateDefaultPath();
        }),
        onSubmitted: (_) => _submit(),
      );

  Widget _labeled(String label, Widget field) => Padding(
        padding: const EdgeInsets.only(left: 32, bottom: 6),
        child: Row(children: [
          SizedBox(width: 90, child: Text(label, style: const TextStyle(fontSize: 13, color: AppColors.textDim))),
          Expanded(child: field),
        ]),
      );

  RadioListTile<_Mode> _radio(_Mode m, String title, {bool enabled = true}) => RadioListTile<_Mode>(
        dense: true,
        contentPadding: EdgeInsets.zero,
        value: m,
        enabled: enabled,
        title: Text(title, style: const TextStyle(fontSize: 13)),
      );

  @override
  Widget build(BuildContext context) {
    final b = widget.branch;
    return AppDialog(
      title: b == null ? 'New Worktree' : 'Checkout ${b.name} in New Worktree',
      width: 560,
      onSubmit: _submit,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _submit, child: const Text('Create')),
      ],
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Path:', style: TextStyle(fontSize: 13, color: AppColors.textDim)),
            const SizedBox(height: 6),
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: TextField(
                  controller: _path,
                  style: const TextStyle(fontSize: 13),
                  decoration: InputDecoration(isDense: true, errorText: _pathError),
                  onChanged: (_) => setState(() {
                    _pathEdited = true;
                    _pathError = null;
                  }),
                  onSubmitted: (_) => _submit(),
                ),
              ),
              const SizedBox(width: 6),
              ToolButton(icon: Icons.folder_open, tooltip: 'Browse…', onPressed: _browse),
            ]),
            const SizedBox(height: 12),
            RadioGroup<_Mode>(
              groupValue: _mode,
              onChanged: (v) => _setMode(v!),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _radio(_Mode.existing, 'Existing branch', enabled: _free.isNotEmpty),
                  if (_mode == _Mode.existing)
                    _labeled(
                      'Branch:',
                      DropdownButton<String>(
                        value: _existing,
                        isDense: true,
                        isExpanded: true,
                        style: const TextStyle(fontSize: 13, color: AppColors.text),
                        dropdownColor: AppColors.panel,
                        items: [for (final n in _free) DropdownMenuItem(value: n, child: Text(n))],
                        onChanged: (v) => setState(() {
                          _existing = v;
                          _updateDefaultPath();
                        }),
                      ),
                    ),
                  _radio(_Mode.newBranch, 'New branch'),
                  if (_mode == _Mode.newBranch) ...[
                    _labeled('Name:', _field(_name, error: _nameError, autofocus: true)),
                    _labeled('Start point:', _field(_start)),
                  ],
                  _radio(_Mode.detached, 'Detached HEAD'),
                  if (_mode == _Mode.detached) _labeled('Revision:', _field(_revision)),
                ],
              ),
            ),
            if (_free.isEmpty)
              const Text('Every local branch is already checked out in a worktree.',
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ],
        ),
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// Worktree actions
// -----------------------------------------------------------------------------

/// Asks for an optional reason and locks [w] (`git worktree lock`).
Future<void> lockWorktreeAction(BuildContext context, RepoController ctrl, Worktree w) async {
  final reason = await showInput(context,
      title: 'Lock Worktree ${w.name}', label: 'Reason (optional):', confirmLabel: 'Lock');
  if (reason == null) return;
  await ctrl.lockWorktree(w, reason: reason.trim().isEmpty ? null : reason.trim());
}

bool _hasLocalChanges(GitException e) =>
    e.stderr.contains('contains modified or untracked files') || e.stderr.contains('use --force');

bool _isLocked(GitException e) =>
    e.stderr.contains('is locked') || e.stderr.contains('cannot remove a locked working tree');

/// Removes [w] and its folder, asking again before deleting local changes.
Future<void> removeWorktreeAction(BuildContext context, RepoController ctrl, Worktree w) async {
  if (w.isMain || w.isCurrent) {
    ctrl.notify(AppNotification('Cannot remove this worktree',
        details: w.isMain ? 'The main worktree cannot be removed.' : 'It is the worktree opened here.',
        isError: true));
    return;
  }
  void lockedError() => ctrl.notify(AppNotification('Worktree ${w.name} is locked',
      details: '${w.lockReason?.isNotEmpty == true ? 'Reason: ${w.lockReason}\n' : ''}Unlock it first.',
      isError: true));
  if (w.locked) {
    lockedError();
    return;
  }
  final ok = await showConfirm(context,
      title: 'Remove Worktree',
      message: 'Remove worktree ${w.name}?\nThe folder ${w.path} will be deleted'
          '${w.branch == null ? '' : ', branch ${w.branch} is kept'}.',
      confirmLabel: 'Remove',
      destructive: true);
  if (!ok || !context.mounted) return;
  ctrl.busy.value = 'Remove worktree ${w.name}';
  try {
    await ctrl.repo.removeWorktree(w.path);
    ctrl.notify(AppNotification('Worktree ${w.name} removed'));
  } on GitException catch (e) {
    ctrl.busy.value = null;
    if (_isLocked(e)) {
      lockedError();
    } else if (_hasLocalChanges(e) && context.mounted) {
      final force = await showConfirm(context,
          title: 'Worktree Has Local Changes',
          message: 'Worktree ${w.name} has local changes.\nDelete them and remove the worktree?',
          confirmLabel: 'Delete and Remove',
          destructive: true);
      if (force) {
        await ctrl.run('Remove worktree ${w.name}', () => ctrl.repo.removeWorktree(w.path, force: true),
            success: 'Worktree ${w.name} removed');
      }
    } else {
      ctrl.notify(AppNotification('Remove worktree failed', details: e.message, isError: true));
    }
  } finally {
    ctrl.busy.value = null;
    await ctrl.refreshAll();
  }
}

/// Shows what `git worktree prune` would remove and prunes after confirming.
Future<void> pruneWorktreesAction(BuildContext context, RepoController ctrl) async {
  final String preview;
  try {
    preview = await ctrl.repo.pruneWorktrees(dryRun: true);
  } on GitException catch (e) {
    ctrl.notify(AppNotification('Prune worktrees failed', details: e.message, isError: true));
    return;
  }
  if (preview.trim().isEmpty) {
    ctrl.notify(AppNotification('Nothing to prune', details: 'Every worktree folder exists.'));
    return;
  }
  if (!context.mounted) return;
  final ok = await showConfirm(context,
      title: 'Prune Worktrees',
      message: 'Forget the worktrees whose folder is gone?\n\n${preview.trim()}',
      confirmLabel: 'Prune');
  if (ok) await ctrl.pruneWorktrees();
}

/// Explains that [branch] is checked out in the worktree at [path] and offers to open it.
Future<void> showBranchInWorktreeDialog(BuildContext context, RepoController ctrl, String branch, String path) async {
  final open = await showDialog<bool>(
    context: context,
    builder: (ctx) => AppDialog(
      title: 'Branch Is Checked Out Elsewhere',
      width: 520,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(
            autofocus: true, onPressed: () => Navigator.pop(ctx, true), child: const Text('Open that worktree')),
      ],
      child: Text(
        "Branch '$branch' is already checked out in worktree $path.\n\n"
        'Git does not check out a branch in two worktrees at once: open that worktree to work on it.',
        style: const TextStyle(fontSize: 13, height: 1.4),
      ),
    ),
  );
  if (open == true) ctrl.openRepo(path);
}
