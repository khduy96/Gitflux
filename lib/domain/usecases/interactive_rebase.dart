import '../entities/git_models.dart';
import '../entities/rebase.dart';
import '../errors.dart';
import '../logic/rebase_todo.dart';
import '../repositories/git_repository.dart';

/// Interactive rebase of the current branch: git generates the todo
/// ([prepare]), the user edits it, then it runs without any editor ([start]).
class InteractiveRebase {
  InteractiveRebase(this._repo);

  final GitRepository _repo;

  /// Checks that the history from [target] to HEAD can be rewritten and
  /// returns the todo git would use. Throws [RebaseRejected].
  Future<RebasePlan> prepare(String target) async {
    final status = await _repo.status();
    _checkState(status);
    final head = status.headHash!;
    if (!await _repo.isAncestor(target, head)) {
      throw RebaseRejected('Cannot rebase from this commit',
          details: 'The commit is not an ancestor of HEAD (${status.branch}).');
    }
    final base = await _repo.refExists('$target^') ? '$target^' : null;
    final merges = await _repo.rangeHasMerges(base);
    final comment = todoCommentPrefix(
        await _repo.config('core.commentString'), await _repo.config('core.commentChar'));
    final todo = await _repo.generateRebaseTodo(base, rebaseMerges: merges);
    final commits = await _repo.rebaseRange(base);

    final entries = <RebaseEntry>[];
    for (final line in parseTodo(todo, comment: comment)) {
      switch (line) {
        case TodoOtherLine(:final line):
          entries.add(RebaseStructuralEntry(line));
        case TodoCommitLine(:final action, :final hash):
          final c = commits.where((c) => c.commit.hash.startsWith(hash)).firstOrNull;
          if (c == null) {
            throw RebaseRejected('Cannot read the rebase todo', details: 'Unknown commit $hash');
          }
          entries.add(RebaseCommitEntry(commit: c.commit, message: c.message, action: action));
      }
    }
    return RebasePlan(
      target: target,
      base: base,
      head: head,
      branch: status.branch!,
      entries: entries,
      rebaseMerges: merges,
      pushedCount: await _repo.pushedCount(base),
      upstream: status.upstream,
    );
  }

  /// Runs the edited [entries] of [plan]. Throws [RebaseRejected] when they
  /// are invalid or the branch moved since [prepare].
  Future<RebaseOutcome> start(RebasePlan plan, List<RebaseEntry> entries) async {
    final status = await _repo.status();
    _checkState(status);
    if (status.headHash != plan.head || status.branch != plan.branch) {
      throw RebaseRejected('The branch changed since the rebase was prepared',
          details: 'Start the interactive rebase again.');
    }
    final built = buildTodo(entries, stateDir: await _repo.rebaseStateDir());
    return _repo.runRebaseTodo(plan.base,
        todo: built.todo, messages: built.messages, rebaseMerges: plan.rebaseMerges);
  }

  static void _checkState(RepoStatus status) {
    if (status.state != RepoState.normal) {
      throw RebaseRejected('Cannot rebase now', details: 'Finish or abort the ${status.state.name} operation first.');
    }
    if (!status.hasCommits) throw RebaseRejected('Cannot rebase', details: 'The repository has no commits.');
    if (status.detached) {
      throw RebaseRejected('Cannot rebase', details: 'HEAD is detached. Checkout a branch first.');
    }
  }
}
