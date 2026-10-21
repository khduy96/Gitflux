import '../entities/bisect.dart';
import '../errors.dart';
import '../logic/bisect_parser.dart';
import '../repositories/git_repository.dart';

/// Result of one bisect step.
class BisectStep {
  const BisectStep({required this.output, this.firstBad});

  /// What git printed.
  final String output;

  /// Set when git found the first bad commit.
  final String? firstBad;
}

/// Bisect from the Log: marking a commit starts a session when none is in
/// progress; git checks out the next commit to test after each mark.
class BisectCommits {
  BisectCommits(this._repo);

  final GitRepository _repo;

  /// Marks [rev] (the commit checked out when null). Throws
  /// [BisectRejected] when local changes block the checkout of the next
  /// commit or there is no session to continue.
  Future<BisectStep> mark(BisectMark mark, {String? rev}) async {
    final state = await _repo.bisectState();
    if (state == null) {
      if (rev == null) throw BisectRejected('No bisect in progress', details: 'Mark a commit of the Log to start one.');
      if (mark == BisectMark.skip) throw BisectRejected('Start the bisect by marking a commit good or bad');
      await _repo.bisectStart();
    }
    try {
      final out = await _repo.bisectMark(mark, rev: rev);
      return BisectStep(output: out, firstBad: firstBadCommitIn(out));
    } on GitException catch (e) {
      throw _checkoutProblem(e) ?? e;
    }
  }

  /// `git bisect run`: git tests the remaining commits with [command] (exit
  /// code 0 good, 125 skip, other bad).
  Future<BisectStep> run(String command) async {
    if (await _repo.bisectState() == null) throw BisectRejected('No bisect in progress');
    if (command.trim().isEmpty) throw BisectRejected('Enter the command that tests a commit');
    try {
      final out = await _repo.bisectRun(command.trim());
      return BisectStep(output: out, firstBad: firstBadCommitIn(out));
    } on GitException catch (e) {
      throw _checkoutProblem(e) ?? e;
    }
  }

  /// Ends the session and goes back to where it started.
  Future<void> reset() async {
    if (await _repo.bisectState() == null) return;
    try {
      await _repo.bisectReset();
    } on GitException catch (e) {
      throw _checkoutProblem(e) ?? e;
    }
  }

  static BisectRejected? _checkoutProblem(GitException e) {
    final text = '${e.stderr}\n${e.stdout}';
    if (!text.contains('would be overwritten') && !text.contains('Please commit your changes')) return null;
    return BisectRejected('Local changes block the bisect checkout',
        details: 'Commit, stash or shelve your changes, then try again.\n\n${e.message}');
  }
}
