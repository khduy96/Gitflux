import 'dart:async';

import 'package:flutter/material.dart';

import '../../../domain/entities/git_models.dart';
import '../../../domain/entities/log_query.dart';
import '../../../domain/logic/log_filters.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import '../dialogs/basic_dialogs.dart';
import 'branch_picker.dart';

/// Filter bar of the Log: search box (message or content), branch, user,
/// date and path filters.
class LogFilterBar extends StatefulWidget {
  const LogFilterBar({super.key, required this.controller});

  final RepoController controller;

  @override
  State<LogFilterBar> createState() => _LogFilterBarState();
}

class _LogFilterBarState extends State<LogFilterBar> {
  RepoController get ctrl => widget.controller;
  late final _search = TextEditingController(text: ctrl.logFilter.value.text);
  Timer? _debounce;

  /// Delay before a content search runs git.
  static const _changesDelay = Duration(milliseconds: 450);

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  void _onText(String v) {
    _debounce?.cancel();
    if (ctrl.logFilter.value.textMode == LogTextMode.message) {
      ctrl.setLogFilter(ctrl.logFilter.value.copyWith(text: v));
    } else {
      _debounce = Timer(_changesDelay, () {
        if (mounted) ctrl.setLogFilter(ctrl.logFilter.value.copyWith(text: v));
      });
    }
  }

  void _reset() {
    _debounce?.cancel();
    _search.clear();
    ctrl.resetLogFilters();
  }

  Future<void> _modeMenu(Offset pos, LogFilter f) async {
    final changes = f.textMode == LogTextMode.changes;
    final r = await showContextMenu<String>(context, pos, [
      menuItem('message', 'Message / hash / author', icon: changes ? null : Icons.check),
      menuItem('changes', 'Changes containing text', icon: changes && !f.regex ? Icons.check : null),
      menuItem('regex', 'Changes matching regex (-G)', icon: changes && f.regex ? Icons.check : null),
    ]);
    if (r == null) return;
    _debounce?.cancel();
    ctrl.setLogFilter(ctrl.logFilter.value.copyWith(
      text: _search.text,
      textMode: r == 'message' ? LogTextMode.message : LogTextMode.changes,
      regex: r == 'regex',
    ));
  }

  /// Branch picker under the chip of [chip]: folders of branch names.
  Future<void> _branchPicker(BuildContext chip) async {
    final box = chip.findRenderObject()! as RenderBox;
    final r = await showBranchPicker(
      context,
      anchor: box.localToGlobal(Offset.zero) & box.size,
      branches: ctrl.branches.value,
      current: ctrl.logFilter.value.branch,
    );
    if (r != null) ctrl.setLogFilter(ctrl.logFilter.value.copyWith(branch: () => r.isEmpty ? null : r));
  }

  Future<void> _userMenu(Offset pos, LogFilter f) async {
    final authors = ctrl.logAuthors.value.take(30).toList();
    final r = await showContextMenu<String>(context, pos, [
      menuItem('__all__', 'All'),
      menuItem('__me__', 'Me', icon: Icons.person_outline),
      if (authors.isNotEmpty) const PopupMenuDivider(height: 8),
      for (final a in authors) menuItem('a:${a.name}', '${a.name}  (${a.count})'),
      const PopupMenuDivider(height: 8),
      menuItem('__select__', 'Select…'),
    ]);
    if (r == null || !mounted) return;
    AuthorFilter? author;
    switch (r) {
      case '__all__':
        author = null;
      case '__me__':
        author = await ctrl.currentUserFilter();
        if (author == null) {
          ctrl.notify(AppNotification('user.name and user.email are not set', isError: true));
          return;
        }
      case '__select__':
        final text = await showInput(context,
            title: 'Filter by User',
            label: 'Name or email contains:',
            initial: f.author?.label == 'Me' ? '' : f.author?.label ?? '',
            validator: (v) => v.trim().isEmpty ? 'Enter a name or an email' : null);
        if (text == null) return;
        author = AuthorFilter(text.trim(), [text.trim()]);
      default:
        final name = r.substring(2);
        author = AuthorFilter(name, [name]);
    }
    ctrl.setLogFilter(ctrl.logFilter.value.copyWith(author: () => author));
  }

  Future<void> _dateMenu(Offset pos, LogFilter f) async {
    const presets = [DatePreset.all, DatePreset.last24Hours, DatePreset.last7Days, DatePreset.last30Days];
    final r = await showContextMenu<DatePreset>(context, pos, [
      for (final p in presets) menuItem(p, dateFilterLabel(DateFilter(p))),
      const PopupMenuDivider(height: 8),
      menuItem(DatePreset.custom, 'Select…'),
    ]);
    if (r == null || !mounted) return;
    var date = DateFilter(r);
    if (r == DatePreset.custom) {
      final custom = await showDialog<DateFilter>(
        context: context,
        builder: (_) => _DateRangeDialog(initial: f.date),
      );
      if (custom == null) return;
      date = custom;
    }
    ctrl.setLogFilter(ctrl.logFilter.value.copyWith(date: date));
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 34,
      color: AppColors.panel,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      child: ValueListenableBuilder<LogFilter>(
        valueListenable: ctrl.logFilter,
        builder: (context, f, _) {
          final changes = f.textMode == LogTextMode.changes;
          return Row(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(children: [
                    SizedBox(
                      width: 240,
                      height: 26,
                      child: TextField(
                        controller: _search,
                        style: const TextStyle(fontSize: 12.5),
                        decoration: InputDecoration(
                          prefixIcon: Tooltip(
                            message: 'Search in: ${changes ? 'changes${f.regex ? ' (regex, -G)' : ' (-S)'}' : 'message / hash / author'}',
                            child: GestureDetector(
                              onTapDown: (d) => _modeMenu(d.globalPosition, f),
                              child: MouseRegion(
                                cursor: SystemMouseCursors.click,
                                child: Row(mainAxisSize: MainAxisSize.min, children: [
                                  const SizedBox(width: 6),
                                  Icon(changes ? Icons.manage_search : Icons.search,
                                      size: 15, color: changes ? AppColors.accentHover : null),
                                  const Icon(Icons.arrow_drop_down, size: 13, color: AppColors.textDim),
                                ]),
                              ),
                            ),
                          ),
                          prefixIconConstraints: const BoxConstraints(minWidth: 36),
                          hintText: changes
                              ? (f.regex ? 'Changes matching regex' : 'Changes containing text')
                              : 'Text or hash',
                          contentPadding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                        ),
                        onChanged: _onText,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Builder(
                      builder: (chip) => LogFilterChip(
                        label: 'Branch: ${f.branch ?? 'All'}',
                        active: f.branch != null,
                        onClear: () => ctrl.setLogFilter(f.copyWith(branch: () => null)),
                        onTap: (_) => _branchPicker(chip),
                      ),
                    ),
                    const SizedBox(width: 6),
                    LogFilterChip(
                      label: 'User: ${f.author?.label ?? 'All'}',
                      tooltip: f.author == null ? null : 'Author name or email contains: ${f.author!.patterns.join(' or ')}',
                      active: f.author != null,
                      onClear: () => ctrl.setLogFilter(f.copyWith(author: () => null)),
                      onTap: (pos) => _userMenu(pos, f),
                    ),
                    const SizedBox(width: 6),
                    LogFilterChip(
                      label: 'Date: ${dateFilterLabel(f.date)}',
                      active: f.date.isActive,
                      onClear: () => ctrl.setLogFilter(f.copyWith(date: const DateFilter())),
                      onTap: (pos) => _dateMenu(pos, f),
                    ),
                    if (f.path != null) ...[
                      const SizedBox(width: 6),
                      LogFilterChip(
                        label: 'Path: ${f.path}',
                        active: true,
                        onClear: () => ctrl.setLogFilter(f.copyWith(path: () => null)),
                      ),
                    ],
                    if (changes && f.text.trim().isNotEmpty && f.changesText == null) ...[
                      const SizedBox(width: 8),
                      Text('Type at least ${LogFilter.minChangesLength} characters',
                          style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                    ],
                    if (f.hasFilters) ...[
                      const SizedBox(width: 4),
                      TextButton(onPressed: _reset, child: const Text('Reset filters')),
                    ],
                  ]),
                ),
              ),
              const SizedBox(width: 6),
              ValueListenableBuilder<bool>(
                valueListenable: ctrl.logLoading,
                builder: (_, loading, _) => loading
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.5))
                    : const SizedBox(),
              ),
              const SizedBox(width: 6),
              ValueListenableBuilder<List<Commit>>(
                valueListenable: ctrl.commits,
                builder: (_, c, _) => Text('${c.length} commits',
                    style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ),
              ToolButton(
                icon: Icons.refresh,
                tooltip: 'Refresh',
                onPressed: () => ctrl.refreshAll(),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Filter of the log bar: a label with a drop-down and an × to clear it.
class LogFilterChip extends StatelessWidget {
  const LogFilterChip({
    super.key,
    required this.label,
    required this.active,
    this.tooltip,
    this.onTap,
    this.onClear,
  });

  final String label;
  final bool active;
  final String? tooltip;
  final void Function(Offset)? onTap;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    final chip = GestureDetector(
      onTapDown: onTap == null ? null : (d) => onTap!(d.globalPosition),
      child: Container(
        height: 24,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        decoration: BoxDecoration(
          color: active ? AppColors.selection : null,
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: active ? AppColors.accent : AppColors.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 260),
              child: Text(label, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
            ),
            if (onTap != null) const Icon(Icons.arrow_drop_down, size: 16, color: AppColors.textDim),
            if (active && onClear != null)
              InkWell(
                onTap: onClear,
                child: const Padding(
                  padding: EdgeInsets.only(left: 2),
                  child: Icon(Icons.close, size: 13, color: AppColors.textDim),
                ),
              ),
          ],
        ),
      ),
    );
    return tooltip == null ? chip : Tooltip(message: tooltip!, child: chip);
  }
}

/// "Date ▸ Select…": first and last day, either optional.
class _DateRangeDialog extends StatefulWidget {
  const _DateRangeDialog({required this.initial});

  final DateFilter initial;

  @override
  State<_DateRangeDialog> createState() => _DateRangeDialogState();
}

class _DateRangeDialogState extends State<_DateRangeDialog> {
  late DateTime? _from = widget.initial.preset == DatePreset.custom ? widget.initial.from : null;
  late DateTime? _to = widget.initial.preset == DatePreset.custom ? widget.initial.to : null;

  Future<void> _pick(bool from) async {
    final now = DateTime.now();
    final current = from ? _from : _to;
    final d = await showDatePicker(
      context: context,
      initialDate: current ?? now,
      firstDate: DateTime(1970),
      lastDate: DateTime(now.year + 1, 12, 31),
    );
    if (d == null) return;
    setState(() => from ? _from = d : _to = d);
  }

  String? get _error => _from != null && _to != null && _to!.isBefore(_from!) ? '"To" is before "From"' : null;

  @override
  Widget build(BuildContext context) {
    String day(DateTime d) =>
        '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year}';
    Widget field(String label, DateTime? value, bool from) => Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(children: [
            SizedBox(width: 50, child: Text(label, style: const TextStyle(fontSize: 13, color: AppColors.textDim))),
            OutlinedButton.icon(
              onPressed: () => _pick(from),
              icon: const Icon(Icons.calendar_today_outlined, size: 14),
              label: Text(value == null ? 'Any' : day(value)),
            ),
            if (value != null)
              ToolButton(
                icon: Icons.close,
                tooltip: 'Clear',
                onPressed: () => setState(() => from ? _from = null : _to = null),
              ),
          ]),
        );
    return AppDialog(
      title: 'Filter by Date',
      width: 360,
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: _error != null ? null : () => Navigator.pop(context, DateFilter.custom(from: _from, to: _to)),
          child: const Text('Apply'),
        ),
      ],
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          field('From', _from, true),
          field('To', _to, false),
          if (_error != null) Text(_error!, style: const TextStyle(fontSize: 12, color: AppColors.error)),
        ],
      ),
    );
  }
}
