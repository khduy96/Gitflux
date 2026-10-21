/// How a commit was marked during a bisect session.
enum BisectMark { good, bad, skip }

/// What `.git/BISECT_LOG` records.
class BisectLog {
  const BisectLog({
    this.good = const [],
    this.bad = const [],
    this.skipped = const [],
    this.firstBad,
    this.firstBadSubject,
    this.candidates = const [],
  });

  /// Commits marked good / bad / skipped, in order.
  final List<String> good;
  final List<String> bad;
  final List<String> skipped;

  /// Set once git found the first bad commit.
  final String? firstBad;
  final String? firstBadSubject;

  /// "Possible first bad commits" when only skipped commits are left.
  final List<String> candidates;
}

/// State of the bisect session in progress.
class BisectState {
  const BisectState({
    required this.startRef,
    this.marks = const {},
    this.log = const BisectLog(),
    this.revisionsLeft,
    this.steps,
    this.currentHash,
    this.currentSubject,
    this.expectedHash,
  });

  /// Branch (or commit) the session started from (`BISECT_START`);
  /// `git bisect reset` returns to it.
  final String startRef;

  /// Marked commits from `refs/bisect/*`, by full hash.
  final Map<String, BisectMark> marks;
  final BisectLog log;

  /// What git prints as "N revisions left to test after this (roughly S
  /// steps)"; null until a good and a bad commit are known.
  final int? revisionsLeft;
  final int? steps;

  /// Commit checked out for testing (HEAD).
  final String? currentHash;
  final String? currentSubject;

  /// Commit git wants tested next (`BISECT_EXPECTED_REV`).
  final String? expectedHash;

  /// Git could not check out the commit to test (e.g. local changes were in
  /// the way): HEAD is not the commit to mark.
  bool get checkoutPending =>
      !finished && expectedHash != null && currentHash != null && expectedHash != currentHash;

  bool get hasGood => marks.values.contains(BisectMark.good);
  bool get hasBad => marks.values.contains(BisectMark.bad);

  /// The first bad commit, once found.
  String? get firstBad => log.firstBad;
  bool get finished => log.firstBad != null;

  String? get currentShort =>
      currentHash == null || currentHash!.length < 8 ? currentHash : currentHash!.substring(0, 8);
}
