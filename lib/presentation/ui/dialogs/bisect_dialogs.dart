import 'package:flutter/material.dart';

import '../../state/repo_controller.dart';
import '../common.dart';
import 'basic_dialogs.dart';

/// Command of the last "Run Script…", offered again while the app runs.
String _lastRunCommand = '';

/// "Run Script…" of a bisect session: `git bisect run <command>` tests the
/// remaining commits automatically; its output goes to the Console.
Future<void> showBisectRunDialog(BuildContext context, RepoController ctrl) async {
  final command = await showDialog<String>(
    context: context,
    builder: (_) => _BisectRunDialog(ctrl: ctrl, initial: _lastRunCommand),
  );
  if (command == null || command.trim().isEmpty) return;
  _lastRunCommand = command.trim();
  await ctrl.bisectRun(_lastRunCommand);
}

class _BisectRunDialog extends StatefulWidget {
  const _BisectRunDialog({required this.ctrl, required this.initial});

  final RepoController ctrl;
  final String initial;

  @override
  State<_BisectRunDialog> createState() => _BisectRunDialogState();
}

class _BisectRunDialogState extends State<_BisectRunDialog> {
  late final _command = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _command.dispose();
    super.dispose();
  }

  void _run() {
    if (_command.text.trim().isEmpty) return;
    Navigator.pop(context, _command.text.trim());
  }

  @override
  Widget build(BuildContext context) {
    final left = widget.ctrl.bisect.value?.revisionsLeft;
    return AppDialog(
      title: 'Bisect: Run Script',
      width: 560,
      onSubmit: _run,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        ValueListenableBuilder<TextEditingValue>(
          valueListenable: _command,
          builder: (context, v, _) =>
              FilledButton(onPressed: v.text.trim().isEmpty ? null : _run, child: const Text('Run')),
        ),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'git bisect run checks out each commit left to test and runs the command through '
            "git's shell in the repository root${left == null ? '' : ' (~$left revision${left == 1 ? '' : 's'} left)'}.",
            style: const TextStyle(fontSize: 12.5, color: AppColors.textDim, height: 1.4),
          ),
          const SizedBox(height: 10),
          const Text('Command', style: TextStyle(fontSize: 12.5)),
          const SizedBox(height: 4),
          TextField(
            controller: _command,
            autofocus: true,
            style: monoStyle(),
            decoration: const InputDecoration(hintText: 'e.g. flutter test test/login_test.dart'),
            onSubmitted: (_) => _run(),
          ),
          const SizedBox(height: 10),
          const Text(
            'Exit code 0: good · 125: skip · 1–127 (except 125): bad · anything else stops the run.\n'
            'The output goes to the Console.',
            style: TextStyle(fontSize: 12, color: AppColors.textDim, height: 1.4),
          ),
        ],
      ),
    );
  }
}
