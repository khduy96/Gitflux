import '../entities/git_models.dart';

/// A local branch and its upstream both moved on (↑ and ↓): pulling would
/// merge or rebase, and may conflict. Such a branch offers "Drop Local and
/// Take `<upstream>`".
bool divergedFromUpstream(Branch b) =>
    !b.isRemote && b.upstream != null && !b.gone && b.ahead > 0 && b.behind > 0;

/// Remote branch of the local branch [b], for "Rebase / Merge from origin":
/// its upstream, else a remote branch of the same name in [branches]
/// (origin first); null when there is none.
String? remoteBranchOf(Branch b, List<Branch> branches) {
  if (b.isRemote) return null;
  if (b.upstream != null && !b.gone) return b.upstream;
  final same = branches.where((x) => x.isRemote && x.shortName == b.name).toList();
  return (same.where((x) => x.remoteName == 'origin').firstOrNull ?? same.firstOrNull)?.name;
}
