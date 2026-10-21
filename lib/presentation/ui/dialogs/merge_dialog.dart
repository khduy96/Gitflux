import 'package:flutter/material.dart';

import '../../../domain/entities/merge.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import 'basic_dialogs.dart';

/// Android Studio "Merge" dialog: merges [ref] (shown as [label], e.g. a tag or short hash) into the current branch with the chosen options.
Future<void> showMergeDialog(BuildContext context, RepoController ctrl, String ref, {String? label}) async {
  final options = await showDialog<MergeOptions>(
    context: context,
    builder: (_) => _MergeDialog(ctrl: ctrl, ref: ref, label: label ?? _shortRef(ref)),
  );
  if (options == null) return;
  await ctrl.merge(ref, options, label: label);
}

String _shortRef(String ref) => ref.replaceFirst(RegExp(r'^refs/(heads|remotes|tags)/'), '');

class _MergeDialog extends StatefulWidget {
  const _MergeDialog({required this.ctrl, required this.ref, required this.label});

  final RepoController ctrl;
  final String ref;
  final String label;

  @override
  State<_MergeDialog> createState() => _MergeDialogState();
}

class _MergeDialogState extends State<_MergeDialog> {
  RepoController get ctrl => widget.ctrl;

  late MergeOptions _options = ctrl.lastMergeOptions;
  final _message = TextEditingController();
  bool _loading = true;
  MergePreview? _preview;

  static const _flags = [
    (MergeFlag.ffOnly, 'Fast-forward only', '--ff-only', 'Refuse to merge unless the current branch can be fast-forwarded'),
    (MergeFlag.noFf, 'No fast-forward', '--no-ff', 'Always create a merge commit, even when a fast-forward is possible'),
    (MergeFlag.squash, 'Squash', '--squash', 'Put all the changes in the index as one change, without a merge commit'),
    (MergeFlag.noCommit, 'No commit', '--no-commit', 'Stop before committing so the result can be reviewed'),
  ];

  @override
  void initState() {
    super.initState();
    ctrl.mergePreview(widget.ref).then((p) {
      if (mounted) {
        setState(() {
          _preview = p;
          _loading = false;
        });
      }
    });
  }

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  String get _into => ctrl.status.value.branch ?? 'HEAD';

  /// Unknown preview counts as "not a fast-forward".
  bool get _createsCommit => _options.createsMergeCommit(fastForward: _preview?.fastForward ?? false);

  /// Subject git writes with `--no-edit` (fmt-merge-msg; the `into branch`
  /// suffix is left out for main / master).
  String get _defaultMessage {
    final name = _shortRef(widget.ref);
    final branches = ctrl.branches.value;
    final kind = branches.any((b) => !b.isRemote && b.name == name)
        ? 'branch'
        : branches.any((b) => b.isRemote && b.name == name)
            ? 'remote-tracking branch'
            : ctrl.tags.value.any((t) => t.name == name)
                ? 'tag'
                : 'commit';
    final into = ctrl.status.value.branch;
    final suffix = into == null || into == 'main' || into == 'master' ? '' : ' into $into';
    return "Merge $kind '${kind == 'commit' ? widget.ref : name}'$suffix";
  }

  void _submit() {
    if (_options.error != null) return;
    Navigator.pop(context, _options.withMessage(_createsCommit ? _message.text : null));
  }

  Widget _previewLine() {
    if (_loading) {
      return const Row(
        children: [
          SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5)),
          SizedBox(width: 8),
          Text('Counting commits…', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
        ],
      );
    }
    final p = _preview;
    if (p == null) return const SizedBox.shrink();
    final n = p.commits;
    final parts = [
      if (p.upToDate) 'Already up to date' else '$n ${n == 1 ? 'commit' : 'commits'} will be merged',
      if (p.fastForward && !p.upToDate) 'Fast-forward possible',
    ];
    final refused = _options.ffOnly && !p.fastForward && !p.upToDate;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(parts.join(' · '), style: const TextStyle(fontSize: 12, color: AppColors.textDim)),
        if (refused)
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text('Not a fast-forward: git will refuse this merge with "Fast-forward only"',
                style: TextStyle(fontSize: 12, color: AppColors.warning)),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final createsCommit = _createsCommit;
    return AppDialog(
      title: 'Merge',
      width: 520,
      onSubmit: _submit,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _options.error == null ? _submit : null, child: const Text('Merge')),
      ],
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text.rich(
              TextSpan(children: [
                const TextSpan(text: 'Merge '),
                TextSpan(text: "'${widget.label}'", style: const TextStyle(fontWeight: FontWeight.w600)),
                const TextSpan(text: ' into '),
                TextSpan(text: "'$_into'", style: const TextStyle(fontWeight: FontWeight.w600)),
              ]),
              style: const TextStyle(fontSize: 13, height: 1.4),
            ),
            const SizedBox(height: 6),
            _previewLine(),
            const SizedBox(height: 10),
            for (final (flag, title, arg, desc) in _flags)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _options.flag(flag),
                title: Text(title, style: const TextStyle(fontSize: 13)),
                subtitle: Text('$arg · $desc', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                // A squash never commits: "No commit" stays checked while it is on.
                onChanged: flag == MergeFlag.noCommit && _options.squash
                    ? null
                    : (v) => setState(() => _options = _options.withFlag(flag, v ?? false)),
              ),
            const SizedBox(height: 8),
            TextField(
              controller: _message,
              enabled: createsCommit,
              minLines: 1,
              maxLines: 4,
              style: const TextStyle(fontSize: 13),
              decoration: InputDecoration(
                labelText: 'Commit message (-m)',
                floatingLabelBehavior: FloatingLabelBehavior.always,
                hintText: _defaultMessage,
                helperText: createsCommit ? 'Leave empty to use the default message' : 'No merge commit will be created',
              ),
            ),
          ],
        ),
      ),
    );
  }
}
