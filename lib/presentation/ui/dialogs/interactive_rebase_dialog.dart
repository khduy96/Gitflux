import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../domain/entities/rebase.dart';
import '../../../domain/logic/rebase_todo.dart';
import '../common.dart';
import 'basic_dialogs.dart';

/// Warning shown before rewriting commits that are already pushed.
String pushedWarning(RebasePlan plan) {
  final n = plan.pushedCount;
  return '$n commit${n == 1 ? ' is' : 's are'} already pushed to ${plan.upstream ?? 'the upstream branch'}. '
      'Rewriting ${n == 1 ? 'it' : 'them'} will require a force push.';
}

/// Asks before rewriting pushed commits. True when there are none.
Future<bool> confirmRewritePushed(BuildContext context, RebasePlan plan) async {
  if (plan.pushedCount == 0) return true;
  return showConfirm(context,
      title: 'Commits Already Pushed',
      message: '${pushedWarning(plan)}\n\nContinue anyway?',
      confirmLabel: 'Rebase Anyway',
      destructive: true);
}

/// Interactive rebase editor. Returns the edited todo when the user starts
/// the rebase.
Future<List<RebaseEntry>?> showInteractiveRebaseDialog(BuildContext context, RebasePlan plan) =>
    showDialog<List<RebaseEntry>>(context: context, builder: (_) => InteractiveRebaseDialog(plan: plan));

Color rebaseActionColor(RebaseAction a) => switch (a) {
      RebaseAction.pick => AppColors.textDim,
      RebaseAction.reword => AppColors.accentHover,
      RebaseAction.edit => AppColors.warning,
      RebaseAction.squash || RebaseAction.fixup => AppColors.remoteRef,
      RebaseAction.drop => AppColors.error,
    };

/// Rows are shown newest first, like the log: "up" means newer, i.e. later
/// in the todo.
class InteractiveRebaseDialog extends StatefulWidget {
  const InteractiveRebaseDialog({super.key, required this.plan});

  final RebasePlan plan;

  @override
  State<InteractiveRebaseDialog> createState() => _InteractiveRebaseDialogState();
}

class _InteractiveRebaseDialogState extends State<InteractiveRebaseDialog> {
  late List<RebaseEntry> _entries = widget.plan.entries;
  final _focus = FocusNode();
  final _message = TextEditingController();

  /// Selected commits (hashes); [_primary] is the one clicked last.
  Set<String> _selected = {};
  String? _primary;

  /// Commit whose (group) message is in the editor.
  String? _editorLead;
  String? _hint;

  static const _keys = {
    RebaseAction.pick: LogicalKeyboardKey.keyP,
    RebaseAction.reword: LogicalKeyboardKey.keyR,
    RebaseAction.edit: LogicalKeyboardKey.keyE,
    RebaseAction.squash: LogicalKeyboardKey.keyS,
    RebaseAction.fixup: LogicalKeyboardKey.keyF,
    RebaseAction.drop: LogicalKeyboardKey.keyD,
  };

  @override
  void initState() {
    super.initState();
    final newest = _entries.whereType<RebaseCommitEntry>().lastOrNull;
    if (newest != null) _select(newest.hash);
  }

  @override
  void dispose() {
    _focus.dispose();
    _message.dispose();
    super.dispose();
  }

  int get _n => _entries.length;

  /// Entry index of a display row (and back: the mapping is symmetric).
  int _entryIndex(int row) => _n - 1 - row;

  int? _indexOf(String? hash) {
    if (hash == null) return null;
    final i = _entries.indexWhere((e) => e is RebaseCommitEntry && e.hash == hash);
    return i < 0 ? null : i;
  }

  void _select(String hash, {bool toggle = false}) {
    if (toggle) {
      _selected = {..._selected};
      if (!_selected.remove(hash)) _selected.add(hash);
    } else {
      _selected = {hash};
    }
    _primary = hash;
    _hint = null;
    _syncEditor();
  }

  void _setEntries(List<RebaseEntry> entries) {
    setState(() {
      _entries = entries;
      _hint = null;
      _syncEditor();
    });
  }

  // ---------------------------------------------------------------------------
  // Message editor
  // ---------------------------------------------------------------------------

  /// Lead of the reword / squash group of the primary row, if it gets a new
  /// message.
  int? _messageLead() {
    final i = _indexOf(_primary);
    if (i == null) return null;
    final lead = groupLead(_entries, i);
    return lead != null && needsMessage(_entries, lead) ? lead : null;
  }

  /// Puts the message of the current group in the editor, unless the user
  /// is typing it.
  void _syncEditor({bool force = false}) {
    final lead = _messageLead();
    if (lead == null) {
      _editorLead = null;
      return;
    }
    final e = _entries[lead] as RebaseCommitEntry;
    if (force || e.hash != _editorLead || e.newMessage == null) {
      _editorLead = e.hash;
      final text = groupMessage(_entries, lead);
      if (_message.text != text) _message.text = text;
    }
  }

  void _onMessageChanged(String text) {
    final lead = _messageLead();
    if (lead == null) return;
    setState(() => _entries = [..._entries]
      ..[lead] = (_entries[lead] as RebaseCommitEntry).copyWith(newMessage: () => text));
  }

  // ---------------------------------------------------------------------------
  // Edits
  // ---------------------------------------------------------------------------

  void _setAction(RebaseAction action, {Iterable<String>? hashes}) {
    final list = [..._entries];
    for (final h in hashes ?? _selected) {
      final i = _indexOf(h);
      if (i != null) list[i] = (list[i] as RebaseCommitEntry).copyWith(action: action);
    }
    _setEntries(list);
  }

  /// Moves the primary commit up (newer, [delta] = 1) or down.
  void _move(int delta) {
    final i = _indexOf(_primary);
    if (i == null) return;
    final moved = moveEntry(_entries, i, delta);
    if (moved == null) {
      setState(() => _hint = 'Commits cannot be moved across merge / label lines.');
      return;
    }
    _setEntries(moved);
  }

  /// Moves the selection to the next commit row.
  void _step(int rowDelta) {
    final i = _indexOf(_primary);
    var row = i == null ? -1 : _entryIndex(i);
    while (true) {
      row += rowDelta;
      if (row < 0 || row >= _n) return;
      final e = _entries[_entryIndex(row)];
      if (e is RebaseCommitEntry) {
        setState(() => _select(e.hash));
        return;
      }
    }
  }

  void _reorder(int oldRow, int newRow) {
    final from = _entryIndex(oldRow);
    if (_entries[from] is! RebaseCommitEntry) return;
    final (start, end) = commitRun(_entries, from);
    // Rows of the run once the dragged row is taken out.
    if (newRow < _n - end || newRow > _n - start - 1) {
      setState(() => _hint = 'Commits cannot be moved across merge / label lines.');
      return;
    }
    final rows = _entries.reversed.toList();
    rows.insert(newRow, rows.removeAt(oldRow));
    _setEntries(rows.reversed.toList());
  }

  void _reset() {
    setState(() {
      _entries = widget.plan.entries;
      _hint = null;
      _syncEditor(force: true);
    });
  }

  Future<void> _start() async {
    if (validateTodo(_entries).any((i) => i.isError)) return;
    if (!await confirmRewritePushed(context, widget.plan)) return;
    if (mounted) Navigator.pop(context, _entries);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final plan = widget.plan;
    final issues = validateTodo(_entries);
    final hasErrors = issues.any((i) => i.isError);
    final count = plan.commits.length;
    final onto = plan.base == null ? 'the root' : _short(plan.target);
    return AppDialog(
      title: 'Rebasing $count commit${count == 1 ? '' : 's'} of ${plan.branch}',
      width: 1040,
      height: 600,
      onSubmit: hasErrors ? null : _start,
      leftActions: [
        OutlinedButton(onPressed: _reset, child: const Text('Reset')),
      ],
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: hasErrors ? null : _start, child: const Text('Start Rebasing')),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (plan.pushedCount > 0) ...[
            _Notice(pushedWarning(plan), color: AppColors.warning, icon: Icons.warning_amber_rounded),
            const SizedBox(height: 8),
          ],
          Text(
            'From $onto up to HEAD'
            '${plan.rebaseMerges ? ' · merge commits are recreated (--rebase-merges) and shown as read-only lines' : ''}',
            style: const TextStyle(fontSize: 12, color: AppColors.textDim),
          ),
          const SizedBox(height: 6),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: _list(issues)),
                const SizedBox(width: 12),
                SizedBox(width: 320, child: _editor()),
              ],
            ),
          ),
          const SizedBox(height: 6),
          for (final i in issues)
            _Notice(i.message,
                color: i.isError ? AppColors.error : AppColors.warning,
                icon: i.isError ? Icons.error_outline : Icons.warning_amber_rounded),
          if (_hint != null) _Notice(_hint!, color: AppColors.textDim, icon: Icons.info_outline),
          const Text(
            'Drag rows or press Alt+↑ / Alt+↓ to move · P, R, E, S, F, D change the action of the selected commits',
            style: TextStyle(fontSize: 11.5, color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }

  Widget _list(List<RebaseIssue> issues) {
    final errors = {for (final i in issues) if (i.isError) i.index: i.message};
    return Container(
      decoration: BoxDecoration(border: Border.all(color: AppColors.border), color: AppColors.background),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 24,
            color: AppColors.panelAlt,
            padding: const EdgeInsets.only(left: 22, right: 8),
            child: const Row(children: [
              SizedBox(width: 92, child: _Header('Action')),
              SizedBox(width: 72, child: _Header('Hash')),
              Expanded(child: _Header('Subject')),
              SizedBox(width: 120, child: _Header('Author')),
              SizedBox(width: 118, child: _Header('Date')),
            ]),
          ),
          const Divider(),
          Expanded(
            child: CallbackShortcuts(
              bindings: {
                const SingleActivator(LogicalKeyboardKey.arrowUp, alt: true): () => _move(1),
                const SingleActivator(LogicalKeyboardKey.arrowDown, alt: true): () => _move(-1),
                const SingleActivator(LogicalKeyboardKey.arrowUp): () => _step(-1),
                const SingleActivator(LogicalKeyboardKey.arrowDown): () => _step(1),
                for (final e in _keys.entries) SingleActivator(e.value): () => _setAction(e.key),
              },
              child: Focus(
                focusNode: _focus,
                autofocus: true,
                child: ReorderableListView.builder(
                  buildDefaultDragHandles: false,
                  itemCount: _n,
                  onReorderItem: _reorder,
                  itemBuilder: (context, row) {
                    final i = _entryIndex(row);
                    final e = _entries[i];
                    return switch (e) {
                      RebaseStructuralEntry() => _structuralRow(e, key: ValueKey('line$i')),
                      RebaseCommitEntry() => _commitRow(e, i, row, errors[i]),
                    };
                  },
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _structuralRow(RebaseStructuralEntry e, {required Key key}) => Container(
        key: key,
        height: 24,
        padding: const EdgeInsets.only(left: 22, right: 8),
        alignment: Alignment.centerLeft,
        child: Text(e.line,
            overflow: TextOverflow.ellipsis,
            style: monoStyle(size: 12, color: AppColors.textMuted).copyWith(fontStyle: FontStyle.italic)),
      );

  Widget _commitRow(RebaseCommitEntry e, int i, int row, String? error) {
    final lead = groupLead(_entries, i);
    final newSubject = lead == i && needsMessage(_entries, i) && e.newMessage != null
        ? groupMessage(_entries, i).split('\n').first
        : null;
    final dropped = e.action == RebaseAction.drop;
    return KeyedSubtree(
      key: ValueKey(e.hash),
      child: HoverRow(
        selected: _selected.contains(e.hash),
        height: 26,
        padding: const EdgeInsets.only(right: 8),
        onTap: () {
          _focus.requestFocus();
          setState(() => _select(e.hash, toggle: HardwareKeyboard.instance.isControlPressed));
        },
        child: Row(
          children: [
            ReorderableDragStartListener(
              index: row,
              child: const MouseRegion(
                cursor: SystemMouseCursors.grab,
                child: SizedBox(width: 22, child: Icon(Icons.drag_indicator, size: 14, color: AppColors.textMuted)),
              ),
            ),
            SizedBox(width: 92, child: _actionButton(e)),
            SizedBox(
              width: 72,
              child: Text(e.shortHash, style: monoStyle(size: 12, color: AppColors.textMuted)),
            ),
            Expanded(
              child: Text(
                newSubject ?? e.subject,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  color: dropped || e.action.isMeld ? AppColors.textMuted : AppColors.text,
                  fontStyle: newSubject != null ? FontStyle.italic : null,
                  decoration: dropped ? TextDecoration.lineThrough : null,
                ),
              ),
            ),
            if (error != null)
              Tooltip(
                message: error,
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 4),
                  child: Icon(Icons.error_outline, size: 15, color: AppColors.error),
                ),
              ),
            SizedBox(
              width: 120,
              child: Text(e.commit.authorName,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12.5, color: AppColors.textDim)),
            ),
            SizedBox(
              width: 110,
              child: Text(formatDate(e.commit.authorTime),
                  style: const TextStyle(fontSize: 12.5, color: AppColors.textDim)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _actionButton(RebaseCommitEntry e) {
    final color = rebaseActionColor(e.action);
    return PopupMenuButton<RebaseAction>(
      tooltip: 'Action',
      padding: EdgeInsets.zero,
      position: PopupMenuPosition.under,
      onOpened: () => setState(() {
        if (!_selected.contains(e.hash)) _select(e.hash);
      }),
      onSelected: (a) => _setAction(a),
      itemBuilder: (_) => [
        for (final a in RebaseAction.values)
          menuItem(a, a.label, shortcut: a.key, color: a == RebaseAction.pick ? null : rebaseActionColor(a)),
      ],
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: Text(e.action.label,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12.5, color: color, fontWeight: FontWeight.w600)),
          ),
          Icon(Icons.arrow_drop_down, size: 16, color: color),
        ],
      ),
    );
  }

  Widget _editor() {
    final lead = _messageLead();
    final i = _indexOf(_primary);
    final String title;
    final Widget body;
    if (lead != null) {
      final e = _entries[lead] as RebaseCommitEntry;
      final members = groupMembers(_entries, lead);
      title = members.isEmpty
          ? 'New message of ${e.shortHash}'
          : 'Message of ${members.length + 1} combined commits';
      body = TextField(
        controller: _message,
        maxLines: null,
        expands: true,
        textAlignVertical: TextAlignVertical.top,
        style: monoStyle(size: 12.5),
        onChanged: _onMessageChanged,
      );
    } else if (i != null) {
      final e = _entries[i] as RebaseCommitEntry;
      title = 'Message of ${e.shortHash}';
      body = Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(border: Border.all(color: AppColors.border)),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SelectableText(e.message, style: monoStyle(size: 12.5, color: AppColors.textDim)),
              const SizedBox(height: 12),
              Text(
                e.action.isMeld
                    ? 'This commit is melded into the one below it.'
                    : 'Choose Reword, or Squash a commit into this one, to change the message.',
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
              ),
            ],
          ),
        ),
      );
    } else {
      title = 'Commit message';
      body = const EmptyHint('Select a commit');
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 24,
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(title, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          ),
        ),
        const SizedBox(height: 2),
        Expanded(child: body),
      ],
    );
  }
}

String _short(String hash) => hash.length > 8 ? hash.substring(0, 8) : hash;

class _Header extends StatelessWidget {
  const _Header(this.text);

  final String text;

  @override
  Widget build(BuildContext context) =>
      Text(text, style: const TextStyle(fontSize: 12, color: AppColors.textMuted, fontWeight: FontWeight.w600));
}

class _Notice extends StatelessWidget {
  const _Notice(this.text, {required this.color, required this.icon});

  final String text;
  final Color color;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 15, color: color),
            const SizedBox(width: 6),
            Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, color: color))),
          ],
        ),
      );
}
