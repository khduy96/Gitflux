import '../entities/git_models.dart';

/// A local branch and its upstream both moved on (↑ and ↓): pulling would
/// merge or rebase, and may conflict. Such a branch offers "Drop Local and
/// Take `<upstream>`".
bool divergedFromUpstream(Branch b) =>
    !b.isRemote && b.upstream != null && !b.gone && b.ahead > 0 && b.behind > 0;
