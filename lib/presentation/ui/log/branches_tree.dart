import 'package:flutter/material.dart';

import '../../../domain/entities/git_models.dart';
import '../../state/repo_controller.dart';
import '../actions.dart';
import '../branches/branch_menu.dart';
import '../common.dart';
import '../dialogs/basic_dialogs.dart';

/// Left part of the Log tab: HEAD, local and remote branches, tags,
/// submodules.
class BranchesTree extends StatefulWidget {
  const BranchesTree({super.key, required this.controller});

  final RepoController controller;

  @override
  State<BranchesTree> createState() => _BranchesTreeState();
}

class _BranchesTreeState extends State<BranchesTree> {
  RepoController get ctrl => widget.controller;
  final Set<String> _collapsed = {'tags'};
  final _search = TextEditingController();
  bool _searching = false;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _filter(String? ref) {
    ctrl.setLogFilter(ctrl.logFilter.value.copyWith(branch: () => ref, path: () => null));
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AppColors.panel,
      child: ListenableBuilder(
        listenable: Listenable.merge([ctrl.branches, ctrl.tags, ctrl.logFilter, ctrl.status, ctrl.submodules]),
        builder: (context, _) {
          final q = _search.text.trim().toLowerCase();
          bool match(String n) => q.isEmpty || n.toLowerCase().contains(q);
          final branches = ctrl.branches.value;
          final local = branches.where((b) => !b.isRemote && match(b.name)).toList();
          final remote = branches.where((b) => b.isRemote && match(b.name)).toList();
          final byRemote = <String, List<Branch>>{};
          for (final b in remote) {
            byRemote.putIfAbsent(b.remoteName, () => []).add(b);
          }
          final tags = ctrl.tags.value.where((t) => match(t.name)).toList();
          final filter = ctrl.logFilter.value.branch;
          final s = ctrl.status.value;

          final rows = <Widget>[
            _row(
              key: 'head',
              depth: 0,
              icon: Icons.my_location,
              iconColor: AppColors.headRef,
              label: s.detached
                  ? 'HEAD (detached at ${s.headHash?.substring(0, 8) ?? '?'})'
                  : 'HEAD (Current Branch)',
              selected: filter == 'HEAD',
              onTap: () => _filter(filter == 'HEAD' ? null : 'HEAD'),
            ),
            _group('local', 'Local', local.length),
            if (!_collapsed.contains('local'))
              for (final b in local) _branchRow(b, 1, filter),
            _group('remote', 'Remote', remote.length),
            if (!_collapsed.contains('remote'))
              for (final entry in byRemote.entries) ...[
                _group('remote:${entry.key}', entry.key, entry.value.length, depth: 1, icon: Icons.cloud_outlined),
                if (!_collapsed.contains('remote:${entry.key}'))
                  for (final b in entry.value) _branchRow(b, 2, filter),
              ],
            _group('tags', 'Tags', tags.length),
            if (!_collapsed.contains('tags'))
              for (final t in tags)
                Builder(builder: (rowCtx) {
                  return _row(
                    key: 'tag:${t.name}',
                    depth: 1,
                    icon: Icons.sell_outlined,
                    iconColor: AppColors.tagRef,
                    label: t.name,
                    selected: filter == 'refs/tags/${t.name}',
                    onTap: () => _filter('refs/tags/${t.name}'),
                    onSecondary: (pos) => showTagMenu(context, ctrl, t, pos),
                  );
                }),
            if (ctrl.repo.hasGitmodules || ctrl.submodules.value.isNotEmpty) ...[
              _group('submodules', 'Submodules', ctrl.submodules.value.length,
                  icon: Icons.account_tree_outlined, onSecondary: _submodulesMenu),
              if (!_collapsed.contains('submodules'))
                for (final sm in ctrl.submodules.value.where((x) => match(x.path))) _submoduleRow(sm),
            ],
          ];

          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                height: 30,
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Row(children: [
                  ToolButton(
                    icon: Icons.add,
                    tooltip: 'New Branch…',
                    onPressed: () => newBranchDialog(context, ctrl),
                  ),
                  ToolButton(
                    icon: Icons.search,
                    tooltip: 'Search branches',
                    selected: _searching,
                    onPressed: () => setState(() {
                      _searching = !_searching;
                      if (!_searching) _search.clear();
                    }),
                  ),
                  ToolButton(
                    icon: Icons.download,
                    tooltip: 'Fetch All Remotes',
                    onPressed: () => ctrl.run('Fetch', () => ctrl.repo.fetch(), success: 'Fetched all remotes'),
                  ),
                  const Spacer(),
                  if (filter != null)
                    ToolButton(
                      icon: Icons.filter_alt_off_outlined,
                      tooltip: 'Show all branches',
                      onPressed: () => _filter(null),
                    ),
                ]),
              ),
              if (_searching)
                Padding(
                  padding: const EdgeInsets.fromLTRB(6, 0, 6, 4),
                  child: TextField(
                    controller: _search,
                    autofocus: true,
                    style: const TextStyle(fontSize: 12.5),
                    decoration: const InputDecoration(hintText: 'Filter branches'),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
              const Divider(),
              Expanded(child: ListView(children: rows)),
            ],
          );
        },
      ),
    );
  }

  Widget _submoduleRow(Submodule sm) {
    final (badge, color) = switch (sm.status) {
      SubmoduleStatus.upToDate => ('', AppColors.textMuted),
      SubmoduleStatus.uninitialized => ('not initialized', AppColors.warning),
      SubmoduleStatus.outOfDate => ('out of date', AppColors.modified),
      SubmoduleStatus.conflict => ('conflict', AppColors.conflict),
      SubmoduleStatus.notRegistered => ('not registered', AppColors.warning),
    };
    return Tooltip(
      message: sm.status == SubmoduleStatus.notRegistered
          ? '${sm.path}\nDeclared in .gitmodules but not recorded in the parent repository.\n'
              'Right-click ▸ Register as Submodule to add it.'
          : '${sm.path}\n${sm.url.isEmpty ? '' : '${sm.url}\n'}${sm.sha.substring(0, 10)}'
              '${sm.describe.isEmpty ? '' : ' (${sm.describe})'}',
      waitDuration: const Duration(milliseconds: 600),
      child: _row(
        key: 'sub:${sm.path}',
        depth: 1,
        icon: Icons.account_tree_outlined,
        iconColor: color == AppColors.textMuted ? AppColors.textDim : color,
        label: sm.path,
        trailing: [
          if (badge.isNotEmpty) Text(' $badge', style: TextStyle(fontSize: 11.5, color: color))
          else Text(sm.sha.length >= 7 ? sm.sha.substring(0, 7) : sm.sha, style: monoStyle(size: 11, color: AppColors.textMuted)),
        ],
        onDoubleTap: sm.status == SubmoduleStatus.uninitialized || sm.sha.isEmpty ? null : () => ctrl.openSubmodule(sm.path),
        onSecondary: (pos) => _submoduleMenu(sm, pos),
      ),
    );
  }

  Future<void> _submoduleMenu(Submodule sm, Offset pos) async {
    final unregistered = sm.status == SubmoduleStatus.notRegistered;
    final initialized = sm.status != SubmoduleStatus.uninitialized && sm.sha.isNotEmpty;
    final r = await showContextMenu<String>(context, pos, [
      menuItem('open', 'Open Submodule', icon: Icons.account_tree_outlined, enabled: initialized),
      if (unregistered)
        menuItem('register', 'Register as Submodule…', icon: Icons.add_link)
      else ...[
        menuItem('update', initialized ? 'Update (checkout recorded commit)' : 'Initialize and Update', icon: Icons.sync),
        menuItem('sync', 'Sync URL from .gitmodules', icon: Icons.link),
      ],
      const PopupMenuDivider(height: 8),
      menuItem('copy', 'Copy Path', icon: Icons.copy),
      menuItem('explorer', 'Show in Explorer', icon: Icons.folder_open_outlined, enabled: initialized),
    ]);
    if (!mounted) return;
    switch (r) {
      case 'open':
        ctrl.openSubmodule(sm.path);
      case 'update':
        await ctrl.updateSubmodules(paths: [sm.path]);
      case 'register':
        await registerNestedRepo(context, ctrl, sm.path);
      case 'sync':
        await ctrl.run('Sync submodule URL', () => ctrl.repo.syncSubmodules(paths: [sm.path]), success: 'Submodule URL synced');
      case 'copy':
        copyToClipboard(context, sm.path);
      case 'explorer':
        openFolder('${ctrl.root}/${sm.path}');
    }
  }

  Future<void> _submodulesMenu(Offset pos) async {
    final r = await showContextMenu<String>(context, pos, [
      menuItem('update', 'Update All Submodules', icon: Icons.sync),
      menuItem('sync', 'Sync All URLs', icon: Icons.link),
      const PopupMenuDivider(height: 8),
      menuItem('add', 'Add Submodule…', icon: Icons.add),
    ]);
    if (!mounted) return;
    switch (r) {
      case 'update':
        await ctrl.updateSubmodules();
      case 'sync':
        await ctrl.run('Sync submodule URLs', () => ctrl.repo.syncSubmodules(), success: 'Submodule URLs synced');
      case 'add':
        await _addSubmodule();
    }
  }

  Future<void> _addSubmodule() async {
    final url = await showInput(context, title: 'Add Submodule', label: 'Repository URL:', confirmLabel: 'Next');
    if (url == null || url.trim().isEmpty || !mounted) return;
    var name = url.trim().split(RegExp(r'[/\\:]')).lastWhere((s) => s.isNotEmpty, orElse: () => 'submodule');
    if (name.endsWith('.git')) name = name.substring(0, name.length - 4);
    final path = await showInput(context,
        title: 'Add Submodule',
        label: 'Path inside this repository:',
        initial: name,
        confirmLabel: 'Add',
        validator: (v) => v.trim().isEmpty ? 'Enter a path' : null);
    if (path == null) return;
    await ctrl.run('Add submodule', () => ctrl.repo.addSubmodule(url.trim(), path.trim().replaceAll('\\', '/')),
        success: 'Submodule added: commit .gitmodules and ${path.trim()} to record it');
  }

  Widget _group(String key, String label, int count,
      {int depth = 0, IconData? icon, void Function(Offset)? onSecondary}) {
    final collapsed = _collapsed.contains(key);
    return HoverRow(
      padding: EdgeInsets.only(left: 4.0 + depth * 14),
      onSecondaryTapDown: onSecondary == null ? null : (d) => onSecondary(d.globalPosition),
      onTap: () => setState(() => collapsed ? _collapsed.remove(key) : _collapsed.add(key)),
      child: Row(children: [
        Icon(collapsed ? Icons.chevron_right : Icons.expand_more, size: 16, color: AppColors.textDim),
        const SizedBox(width: 2),
        Icon(icon ?? Icons.folder_outlined, size: 14, color: AppColors.textDim),
        const SizedBox(width: 6),
        Text(label, style: const TextStyle(fontSize: 13)),
        const SizedBox(width: 6),
        Text('$count', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
      ]),
    );
  }

  Widget _branchRow(Branch b, int depth, String? filter) {
    return _row(
      key: b.name,
      depth: depth,
      icon: b.isCurrent ? Icons.sell : (b.isFavorite ? Icons.star : Icons.call_split),
      iconColor: b.isCurrent
          ? AppColors.headRef
          : b.isFavorite
              ? AppColors.warning
              : (b.isRemote ? AppColors.remoteRef : AppColors.localRef),
      label: b.isRemote ? b.shortName : b.name,
      bold: b.isCurrent,
      trailing: [
        if (b.ahead > 0) Text('↑${b.ahead}', style: const TextStyle(fontSize: 11.5, color: AppColors.added)),
        if (b.behind > 0) Text(' ↓${b.behind}', style: const TextStyle(fontSize: 11.5, color: AppColors.modified)),
        if (b.gone) const Text(' gone', style: TextStyle(fontSize: 11.5, color: AppColors.error)),
      ],
      selected: filter == b.name,
      onTap: () => _filter(b.name),
      onDoubleTap: () => checkoutBranch(context, ctrl, b),
      onSecondary: (pos) => showBranchMenu(context, ctrl, b, pos),
    );
  }

  Widget _row({
    required String key,
    required int depth,
    required IconData icon,
    required Color iconColor,
    required String label,
    bool selected = false,
    bool bold = false,
    List<Widget> trailing = const [],
    VoidCallback? onTap,
    VoidCallback? onDoubleTap,
    void Function(Offset)? onSecondary,
  }) {
    return HoverRow(
      selected: selected,
      padding: EdgeInsets.only(left: 22.0 + depth * 14, right: 6),
      onTap: onTap,
      onDoubleTap: onDoubleTap,
      onSecondaryTapDown: onSecondary == null ? null : (d) => onSecondary(d.globalPosition),
      child: Row(children: [
        Icon(icon, size: 14, color: iconColor),
        const SizedBox(width: 6),
        Expanded(
          child: Text(label,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, fontWeight: bold ? FontWeight.w600 : null)),
        ),
        ...trailing,
      ]),
    );
  }
}
