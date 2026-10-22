import '../entities/git_models.dart';

/// Refs of a commit under one name: a local branch with its remote
/// branches (`main`, `origin/main`), a remote branch alone, a tag, or a
/// detached HEAD.
class RefGroup {
  const RefGroup({
    required this.name,
    required this.refs,
    this.isHead = false,
    this.local = false,
    this.remotes = const [],
    this.isTag = false,
  });

  /// Branch name without the remote (`main`), tag name, or `HEAD`.
  final String name;

  /// The refs merged here, as git shows them.
  final List<RefLabel> refs;

  /// HEAD points here: the current branch, or a detached HEAD.
  final bool isHead;

  /// A local branch has this name.
  final bool local;

  /// Remotes having a branch of this name (`origin`).
  final List<String> remotes;
  final bool isTag;

  /// HEAD alone, not on a branch.
  bool get isDetachedHead => isHead && !local && remotes.isEmpty && !isTag;

  /// Name that designates the group: the local branch, else the first remote
  /// branch (`origin/x`), or the tag; null for a detached HEAD.
  String? get refName => local || isTag
      ? name
      : refs.where((r) => r.kind == RefKind.remoteBranch).firstOrNull?.name;
}

class _Branch {
  bool head = false;
  bool local = false;
  final remotes = <String>[];
  final refs = <RefLabel>[];
}

/// Groups the [refs] of a commit by name, most relevant first: a detached
/// HEAD or the current branch, local branches, remote only branches, tags.
List<RefGroup> groupRefs(List<RefLabel> refs) {
  final branches = <String, _Branch>{};
  final tags = <RefGroup>[];
  RefGroup? detached;
  for (var i = 0; i < refs.length; i++) {
    final r = refs[i];
    switch (r.kind) {
      case RefKind.head:
        // `HEAD -> main` comes as HEAD then main; HEAD alone is detached.
        final next = i + 1 < refs.length ? refs[i + 1] : null;
        if (next != null && next.kind == RefKind.localBranch) {
          branches.putIfAbsent(next.name, _Branch.new)
            ..head = true
            ..refs.add(r);
        } else {
          detached = RefGroup(name: 'HEAD', refs: [r], isHead: true);
        }
      case RefKind.localBranch:
        branches.putIfAbsent(r.name, _Branch.new)
          ..local = true
          ..refs.add(r);
      case RefKind.remoteBranch:
        final slash = r.name.indexOf('/');
        branches.putIfAbsent(r.name.substring(slash + 1), _Branch.new)
          ..remotes.add(slash < 0 ? '' : r.name.substring(0, slash))
          ..refs.add(r);
      case RefKind.tag:
        tags.add(RefGroup(name: r.name, refs: [r], isTag: true));
    }
  }
  final groups = [
    for (final MapEntry(key: name, value: b) in branches.entries)
      RefGroup(name: name, refs: b.refs, isHead: b.head, local: b.local, remotes: b.remotes),
  ];
  int rank(RefGroup g) => g.isHead ? 0 : (g.local ? 1 : 2);
  // A stable sort: same rank keeps the order of git.
  final sorted = [for (final r in [0, 1, 2]) ...groups.where((g) => rank(g) == r)];
  return [?detached, ...sorted, ...tags];
}

/// Group of [groups] showing the Log filter [focus]: a branch (`main`,
/// `origin/main`), `HEAD` or a tag (`refs/tags/v1`). Null when the commit
/// does not carry it.
RefGroup? focusedRefGroup(List<RefGroup> groups, String focus) {
  if (focus == 'HEAD') return groups.where((g) => g.isHead).firstOrNull;
  if (focus.startsWith('refs/tags/')) {
    final tag = focus.substring('refs/tags/'.length);
    return groups.where((g) => g.isTag && g.name == tag).firstOrNull;
  }
  return groups
      .where((g) => !g.isTag && g.refs.any((r) => r.kind != RefKind.head && r.name == focus))
      .firstOrNull;
}
