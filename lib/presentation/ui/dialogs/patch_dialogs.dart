import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../domain/entities/git_models.dart';
import '../../../domain/entities/patch.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import '../widgets/file_check_list.dart';
import 'basic_dialogs.dart';
import 'shelve_dialogs.dart';

/// Default file name of a patch: `<branch>.patch`.
String defaultPatchName(RepoController ctrl, [String? name]) {
  final base = (name ?? ctrl.status.value.branch ?? 'changes').replaceAll(RegExp(r'[\\/:*?"<>|\s]+'), '-');
  return '${base.isEmpty ? 'changes' : base}.patch';
}

/// Asks where to save [patch] and writes it.
Future<void> savePatch(BuildContext context, RepoController ctrl, List<int> patch, String fileName) async {
  try {
    final uri = await FilePicker.saveFile(
      dialogTitle: 'Save Patch',
      fileName: fileName,
      bytes: Uint8List.fromList(patch),
      type: FileType.custom,
      allowedExtensions: const ['patch', 'diff'],
    );
    if (uri == null) return;
    ctrl.notify(AppNotification('Patch saved', details: uri.scheme == 'file' ? uri.toFilePath() : '$uri'));
  } catch (e) {
    ctrl.notify(AppNotification('Save patch failed', details: '$e', isError: true));
  }
}

/// Puts [patch] on the clipboard as text.
void copyPatch(BuildContext context, List<int> patch) =>
    copyToClipboard(context, utf8.decode(patch, allowMalformed: true), label: 'Patch copied to clipboard');

// -----------------------------------------------------------------------------
// Create Patch
// -----------------------------------------------------------------------------

/// "Create Patch…" from the Commit panel: [chosen] files are checked.
Future<void> showCreatePatchDialog(BuildContext context, RepoController ctrl, List<FileChange> chosen) async {
  final changes = ctrl.status.value.changes.where(canShelve).toList();
  if (changes.isEmpty) {
    ctrl.notify(AppNotification('No changes to put in a patch', isError: true));
    return;
  }
  final r = await showDialog<({bool clipboard, List<FileChange> files})>(
    context: context,
    builder: (_) => _CreatePatchDialog(
      changes: changes,
      chosen: {for (final c in chosen) if (canShelve(c)) c.path},
    ),
  );
  if (r == null) return;
  final patch = await ctrl.createPatch(r.files);
  if (patch == null || !context.mounted) return;
  if (r.clipboard) {
    copyPatch(context, patch);
  } else {
    await savePatch(context, ctrl, patch, defaultPatchName(ctrl));
  }
}

class _CreatePatchDialog extends StatefulWidget {
  const _CreatePatchDialog({required this.changes, required this.chosen});

  final List<FileChange> changes;
  final Set<String> chosen;

  @override
  State<_CreatePatchDialog> createState() => _CreatePatchDialogState();
}

class _CreatePatchDialogState extends State<_CreatePatchDialog> {
  late Set<String> _checked = {...widget.chosen};

  void _create({required bool clipboard}) => Navigator.pop(
      context, (clipboard: clipboard, files: widget.changes.where((c) => _checked.contains(c.path)).toList()));

  @override
  Widget build(BuildContext context) {
    final none = _checked.isEmpty;
    return AppDialog(
      title: 'Create Patch',
      width: 600,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        OutlinedButton(
          onPressed: none ? null : () => _create(clipboard: true),
          child: const Text('Copy Patch to Clipboard'),
        ),
        FilledButton(onPressed: none ? null : () => _create(clipboard: false), child: const Text('Save Patch…')),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Changes relative to HEAD, new files included (git diff --binary).',
              style: TextStyle(fontSize: 12.5, color: AppColors.textDim)),
          const SizedBox(height: 8),
          Flexible(
            child: FileCheckList(
              items: [
                for (final c in widget.changes) FileCheckItem(path: c.path, oldPath: c.oldPath, type: c.type),
              ],
              checked: _checked,
              onChanged: (v) => setState(() => _checked = v),
            ),
          ),
        ],
      ),
    );
  }
}

/// "Create Patch…" of commits of the log (`git format-patch`).
Future<void> createPatchFromCommits(BuildContext context, RepoController ctrl, List<Commit> commits) async {
  final plain = commits.where((c) => !c.isMerge).toList();
  final r = await showDialog<String>(
    context: context,
    builder: (ctx) => AppDialog(
      title: 'Create Patch',
      width: 560,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        OutlinedButton(onPressed: () => Navigator.pop(ctx, 'copy'), child: const Text('Copy Patch to Clipboard')),
        FilledButton(onPressed: () => Navigator.pop(ctx, 'save'), child: const Text('Save Patch…')),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '${plain.length} commit${plain.length == 1 ? '' : 's'} as one mailbox (git format-patch), '
            'oldest first. Apply it with Apply Patch… or git am.',
            style: const TextStyle(fontSize: 12.5, color: AppColors.textDim),
          ),
          if (plain.length < commits.length)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text('Merge commits are left out.', style: TextStyle(fontSize: 12.5, color: AppColors.warning)),
            ),
          const SizedBox(height: 8),
          Container(
            constraints: const BoxConstraints(maxHeight: 220),
            decoration: BoxDecoration(border: Border.all(color: AppColors.border), color: AppColors.background),
            child: ListView(
              shrinkWrap: true,
              children: [
                for (final c in plain.reversed)
                  SizedBox(
                    height: 24,
                    child: Row(children: [
                      const SizedBox(width: 8),
                      Text(c.shortHash, style: monoStyle(size: 12, color: AppColors.textMuted)),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(c.subject, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                      ),
                    ]),
                  ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
  if (r == null || !context.mounted) return;
  final patch = await ctrl.createPatchFromCommits(plain);
  if (patch == null || !context.mounted) return;
  if (r == 'copy') {
    copyPatch(context, patch);
  } else {
    await savePatch(context, ctrl, patch, plain.length == 1 ? defaultPatchName(ctrl, plain.first.shortHash) : defaultPatchName(ctrl));
  }
}

// -----------------------------------------------------------------------------
// Apply Patch
// -----------------------------------------------------------------------------

/// "Apply Patch…" (a file) or "Apply Patch from Clipboard".
Future<void> showApplyPatchDialog(BuildContext context, RepoController ctrl, {bool fromClipboard = false}) async {
  List<int> patch;
  String source;
  if (fromClipboard) {
    final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text ?? '';
    if (text.trim().isEmpty) {
      ctrl.notify(AppNotification('The clipboard is empty', isError: true));
      return;
    }
    // Patches use LF; a copy through a Windows clipboard may add CR.
    patch = utf8.encode(text.contains('\r\n') && !text.replaceAll('\r\n', '').contains('\n') ? text.replaceAll('\r\n', '\n') : text);
    source = 'Clipboard';
  } else {
    final PlatformFile? file;
    try {
      file = await FilePicker.pickFile(dialogTitle: 'Apply Patch', initialDirectory: ctrl.root);
    } catch (e) {
      ctrl.notify(AppNotification('Cannot open the patch', details: '$e', isError: true));
      return;
    }
    final path = file?.path;
    if (path == null) return;
    try {
      patch = await File(path).readAsBytes();
    } on FileSystemException catch (e) {
      ctrl.notify(AppNotification('Cannot read the patch', details: e.message, isError: true));
      return;
    }
    source = path;
  }
  final preview = await ctrl.previewPatch(patch);
  if (preview == null || !context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (_) => _ApplyPatchDialog(ctrl: ctrl, patch: patch, preview: preview, source: source),
  );
}

class _ApplyPatchDialog extends StatefulWidget {
  const _ApplyPatchDialog({required this.ctrl, required this.patch, required this.preview, required this.source});

  final RepoController ctrl;
  final List<int> patch;
  final PatchPreview preview;
  final String source;

  @override
  State<_ApplyPatchDialog> createState() => _ApplyPatchDialogState();
}

class _ApplyPatchDialogState extends State<_ApplyPatchDialog> {
  late bool _asCommits = widget.preview.mailbox;

  Future<void> _apply() async {
    Navigator.pop(context);
    await widget.ctrl.applyPatch(widget.patch, asCommits: _asCommits);
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.preview;
    final (icon, color, text) = !p.applies
        ? (Icons.error_outline, AppColors.error, 'Does not apply')
        : p.conflicts.isNotEmpty
            ? (Icons.warning_amber_rounded, AppColors.warning, 'Applies with conflicts in ${p.conflicts.join(', ')}')
            : (Icons.check_circle_outline, AppColors.success, 'Applies cleanly');
    return AppDialog(
      title: 'Apply Patch',
      width: 640,
      onSubmit: _apply,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _apply, child: Text(_asCommits ? 'Apply as Commits' : 'Apply')),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(widget.source,
              overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, color: AppColors.textDim)),
          if (p.mailbox && p.subjects.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              '${p.subjects.length} commit${p.subjects.length == 1 ? '' : 's'}: ${p.subjects.take(3).join(' · ')}'
              '${p.subjects.length > 3 ? ' …' : ''}',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12.5),
            ),
          ],
          const SizedBox(height: 8),
          Flexible(
            child: Container(
              constraints: const BoxConstraints(maxHeight: 260),
              decoration: BoxDecoration(border: Border.all(color: AppColors.border), color: AppColors.background),
              child: ListView(
                shrinkWrap: true,
                children: [for (final f in p.files) _fileRow(f)],
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(icon, size: 15, color: color),
            const SizedBox(width: 6),
            Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, color: color))),
          ]),
          if (!p.applies && p.checkOutput.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.all(6),
              constraints: const BoxConstraints(maxHeight: 90),
              color: AppColors.background,
              child: SingleChildScrollView(
                child: SelectableText(p.checkOutput, style: monoStyle(size: 11.5, color: AppColors.textDim)),
              ),
            ),
          const SizedBox(height: 6),
          if (p.mailbox) ...[
            RadioGroup<bool>(
              groupValue: _asCommits,
              onChanged: (v) => setState(() => _asCommits = v ?? true),
              child: const Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  RadioListTile<bool>(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    value: true,
                    title: Text('Apply as commits (git am --3way)', style: TextStyle(fontSize: 13)),
                  ),
                  RadioListTile<bool>(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    value: false,
                    title: Text('Apply changes only (to the working tree)', style: TextStyle(fontSize: 13)),
                  ),
                ],
              ),
            ),
          ] else
            const Text('The changes are applied to the working tree with a 3-way merge (git apply --3way).',
                style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
        ],
      ),
    );
  }

  Widget _fileRow(PatchFile f) => SizedBox(
        height: 24,
        child: Row(children: [
          const SizedBox(width: 8),
          SizedBox(
            width: 16,
            child: Text(f.type.letter, style: monoStyle(size: 12, color: changeColor(f.type))),
          ),
          Icon(fileIcon(f.fileName), size: 15, color: changeColor(f.type)),
          const SizedBox(width: 6),
          Text(f.fileName, style: TextStyle(fontSize: 13, color: changeColor(f.type))),
          const SizedBox(width: 8),
          Expanded(
            child: Text(f.oldPath != null ? '← ${f.oldPath}' : f.directory,
                overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ),
          Text(f.binary ? 'binary' : '+${f.added} −${f.deleted}', style: monoStyle(size: 11.5, color: AppColors.textDim)),
          const SizedBox(width: 8),
        ]),
      );
}
