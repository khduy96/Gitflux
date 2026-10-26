import 'package:flutter/material.dart';

import '../../../domain/entities/git_models.dart';
import '../../../domain/logic/leave_branch.dart';
import '../common.dart';
import '../dialogs/basic_dialogs.dart';

/// How to leave the current branch before deleting it.
sealed class LeaveBranchChoice {
  const LeaveBranchChoice();
}

/// "Checkout Another Branch and Delete": [target] is checked out.
class CheckoutAndDelete extends LeaveBranchChoice {
  const CheckoutAndDelete(this.target);

  final Branch target;
}

/// "Create New Branch and Delete": branch [name] is created at [startPoint]
/// and checked out.
class CreateAndDelete extends LeaveBranchChoice {
  const CreateAndDelete(this.name, this.startPoint);

  final String name;
  final String startPoint;
}

/// Asks how to leave [deleting], the current branch, before deleting it; null
/// when cancelled.
Future<LeaveBranchChoice?> showDeleteCurrentBranchDialog(
  BuildContext context, {
  required String deleting,
  required List<Branch> branches,
}) =>
    showDialog<LeaveBranchChoice>(
      context: context,
      builder: (_) => _DeleteCurrentBranchDialog(deleting: deleting, branches: branches),
    );

enum _Mode { checkout, create }

class _DeleteCurrentBranchDialog extends StatefulWidget {
  const _DeleteCurrentBranchDialog({required this.deleting, required this.branches});

  final String deleting;
  final List<Branch> branches;

  @override
  State<_DeleteCurrentBranchDialog> createState() => _DeleteCurrentBranchDialogState();
}

class _DeleteCurrentBranchDialogState extends State<_DeleteCurrentBranchDialog> {
  late final List<Branch> _targets = _sorted(checkoutTargets(widget.deleting, widget.branches));
  late final List<Branch> _starts = _sorted(startPoints(widget.branches));
  late Branch? _target = _local(_targets, defaultCheckoutTarget(widget.deleting, widget.branches));
  late Branch? _start = _local(_starts, defaultStartPoint(widget.branches));

  final _targetSearch = TextEditingController();
  final _startSearch = TextEditingController();
  final _name = TextEditingController();
  _Mode _mode = _Mode.checkout;
  String? _nameError;

  @override
  void dispose() {
    _targetSearch.dispose();
    _startSearch.dispose();
    _name.dispose();
    super.dispose();
  }

  /// Local branches first, then remote ones; main / master / develop first.
  static List<Branch> _sorted(List<Branch> branches) => [
        for (final remote in [false, true])
          ...branches.where((b) => b.isRemote == remote).toList()
            ..sort((a, b) {
              if (a.isFavorite != b.isFavorite) return a.isFavorite ? -1 : 1;
              return a.name.compareTo(b.name);
            }),
      ];

  static Branch? _local(List<Branch> branches, String? name) =>
      name == null ? null : branches.where((b) => !b.isRemote && b.name == name).firstOrNull;

  static List<Branch> _filter(List<Branch> branches, TextEditingController search) {
    final q = search.text.trim().toLowerCase();
    return q.isEmpty ? branches : branches.where((b) => b.name.toLowerCase().contains(q)).toList();
  }

  /// The highlighted branch of [all] filtered by [search]: [selected] (the
  /// default until a row is clicked) while the filter shows it, so clearing
  /// the filter brings it back; else the first match, or the only match when
  /// nothing is selected.
  static Branch? _visible(Branch? selected, List<Branch> all, TextEditingController search) {
    if (search.text.trim().isEmpty) return selected;
    final shown = _filter(all, search);
    if (selected != null && shown.contains(selected)) return selected;
    return selected != null || shown.length == 1 ? shown.firstOrNull : null;
  }

  Branch? get _shownTarget => _visible(_target, _targets, _targetSearch);
  Branch? get _shownStart => _visible(_start, _starts, _startSearch);
  Branch? get _selected => _mode == _Mode.checkout ? _shownTarget : _shownStart;

  void _submit() {
    switch (_mode) {
      case _Mode.checkout:
        final t = _shownTarget;
        if (t != null) Navigator.pop(context, CheckoutAndDelete(t));
      case _Mode.create:
        final s = _shownStart;
        if (s == null) return;
        final n = _name.text.trim();
        final err = validateRefName(n,
            existing: widget.branches.where((b) => !b.isRemote).map((b) => b.name));
        if (err != null) {
          setState(() => _nameError = err);
          return;
        }
        Navigator.pop(context, CreateAndDelete(n, s.name));
    }
  }

  RadioListTile<_Mode> _radio(_Mode m, String title) => RadioListTile<_Mode>(
        dense: true,
        contentPadding: EdgeInsets.zero,
        value: m,
        title: Text(title, style: const TextStyle(fontSize: 13)),
      );

  Widget _search(TextEditingController c, {bool autofocus = false}) => TextField(
        controller: c,
        autofocus: autofocus,
        style: const TextStyle(fontSize: 13),
        decoration: const InputDecoration(
          isDense: true,
          prefixIcon: Icon(Icons.search, size: 16),
          prefixIconConstraints: BoxConstraints(minWidth: 30),
          hintText: 'Search branches',
        ),
        onChanged: (_) => setState(() {}),
        // Keeps the focus when Enter does nothing (no branch selected).
        onEditingComplete: () {},
        onSubmitted: (_) => _submit(),
      );

  /// Clicking a row keeps the focus in the text field, where Enter confirms.
  Widget _list(List<Branch> shown, Branch? selected, ValueChanged<Branch> select, {required String empty}) =>
      TextFieldTapRegion(
        child: Container(
          height: 220,
          decoration: BoxDecoration(border: Border.all(color: AppColors.border)),
          child: shown.isEmpty
              ? Center(child: Text(empty, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)))
              : ListView(
                  children: [
                    for (final remote in [false, true])
                      if (shown.any((b) => b.isRemote == remote)) ...[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(8, 6, 8, 2),
                          child: Text(remote ? 'Remote' : 'Local',
                              style: const TextStyle(
                                  fontSize: 12, color: AppColors.textMuted, fontWeight: FontWeight.w600)),
                        ),
                        for (final b in shown.where((b) => b.isRemote == remote))
                          HoverRow(
                            height: 26,
                            selected: identical(b, selected),
                            padding: const EdgeInsets.only(left: 20, right: 8),
                            onTap: () => select(b),
                            onDoubleTap: () {
                              select(b);
                              _submit();
                            },
                            child: Row(children: [
                              Icon(
                                b.isCurrent ? Icons.sell : (b.isFavorite ? Icons.star : Icons.call_split),
                                size: 14,
                                color: b.isCurrent
                                    ? AppColors.headRef
                                    : b.isFavorite
                                        ? AppColors.warning
                                        : AppColors.textDim,
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(b.name,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(fontSize: 13, fontWeight: b.isCurrent ? FontWeight.w600 : null)),
                              ),
                              if (b.worktree != null)
                                const Text('in another worktree',
                                    style: TextStyle(fontSize: 11.5, color: AppColors.warning)),
                            ]),
                          ),
                      ],
                  ],
                ),
        ),
      );

  Widget _indented(Widget child) => Padding(padding: const EdgeInsets.only(left: 32, bottom: 6), child: child);

  @override
  Widget build(BuildContext context) {
    final targets = _filter(_targets, _targetSearch);
    final starts = _filter(_starts, _startSearch);
    return AppDialog(
      title: "Delete Current Branch '${widget.deleting}'",
      width: 540,
      onSubmit: _submit,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AppColors.error),
          onPressed: _selected == null ? null : _submit,
          child: Text(_mode == _Mode.checkout ? 'Checkout and Delete' : 'Create and Delete'),
        ),
      ],
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${widget.deleting} is checked out: leave it first, then it is deleted locally.',
                style: const TextStyle(fontSize: 13, color: AppColors.textDim)),
            const SizedBox(height: 8),
            RadioGroup<_Mode>(
              groupValue: _mode,
              onChanged: (v) => setState(() {
                _mode = v!;
                _nameError = null;
              }),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _radio(_Mode.checkout, 'Checkout Another Branch and Delete'),
                  if (_mode == _Mode.checkout) ...[
                    _indented(_search(_targetSearch, autofocus: true)),
                    _indented(_list(targets, _shownTarget, (b) => setState(() => _target = b),
                        empty: _targets.isEmpty ? 'No other branch to check out' : 'No branch matches')),
                  ],
                  _radio(_Mode.create, 'Create New Branch and Delete'),
                  if (_mode == _Mode.create) ...[
                    _indented(const Text('New branch name:', style: TextStyle(fontSize: 13, color: AppColors.textDim))),
                    _indented(TextField(
                      controller: _name,
                      autofocus: true,
                      style: const TextStyle(fontSize: 13),
                      decoration: InputDecoration(isDense: true, errorText: _nameError),
                      onChanged: (_) {
                        if (_nameError != null) setState(() => _nameError = null);
                      },
                      onEditingComplete: () {},
                      onSubmitted: (_) => _submit(),
                    )),
                    _indented(const Text('From:', style: TextStyle(fontSize: 13, color: AppColors.textDim))),
                    _indented(_search(_startSearch)),
                    _indented(_list(starts, _shownStart, (b) => setState(() => _start = b), empty: 'No branch matches')),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
