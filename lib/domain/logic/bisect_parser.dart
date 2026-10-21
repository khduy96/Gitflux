import '../entities/bisect.dart';

final _command = RegExp(r'^git bisect (good|bad|skip|new|old)((?:\s+[0-9a-fA-F]+)*)\s*$');
final _firstBad = RegExp(r'^# first (?:bad|new) commit: \[([0-9a-f]+)\]\s?(.*)$');
final _possible = RegExp(r'^# possible first (?:bad|new) commit: \[([0-9a-f]+)\]');

/// Parses `.git/BISECT_LOG`. Marks come from the `git bisect <mark> <hash>`
/// lines (default and old/new terms), the result from the comments git
/// writes once it is found.
BisectLog parseBisectLog(String text) {
  final good = <String>[], bad = <String>[], skipped = <String>[], candidates = <String>[];
  String? firstBad, firstBadSubject;
  for (final raw in text.split('\n')) {
    final line = raw.trimRight();
    if (_firstBad.firstMatch(line) case final m?) {
      firstBad = m.group(1);
      firstBadSubject = m.group(2)!.trim();
      continue;
    }
    if (_possible.firstMatch(line) case final m?) {
      candidates.add(m.group(1)!);
      continue;
    }
    final m = _command.firstMatch(line);
    if (m == null) continue;
    final hashes = m.group(2)!.trim().split(RegExp(r'\s+')).where((h) => h.isNotEmpty);
    switch (m.group(1)) {
      case 'good' || 'old':
        good.addAll(hashes);
      case 'bad' || 'new':
        bad.addAll(hashes);
      case 'skip':
        skipped.addAll(hashes);
    }
  }
  return BisectLog(
    good: good,
    bad: bad,
    skipped: skipped,
    firstBad: firstBad,
    firstBadSubject: firstBadSubject,
    candidates: firstBad == null ? candidates : const [],
  );
}

/// Marks of `git for-each-ref --format='%(objectname) %(refname)' refs/bisect`:
/// `refs/bisect/bad`, `refs/bisect/good-<hash>`, `refs/bisect/skip-<hash>`.
Map<String, BisectMark> parseBisectRefs(String out) {
  final marks = <String, BisectMark>{};
  for (final line in out.split('\n')) {
    final f = line.trim().split(' ');
    if (f.length < 2) continue;
    final ref = f[1];
    final mark = ref == 'refs/bisect/bad' || ref.startsWith('refs/bisect/bad-')
        ? BisectMark.bad
        : ref.startsWith('refs/bisect/good-')
            ? BisectMark.good
            : ref.startsWith('refs/bisect/skip-')
                ? BisectMark.skip
                : null;
    if (mark != null) marks[f[0]] = mark;
  }
  return marks;
}

/// `bisect_nr` and `bisect_steps` of `git rev-list --bisect-vars`: what git
/// prints as "N revisions left to test after this (roughly S steps)".
({int? left, int? steps}) parseBisectVars(String out) {
  int? value(String name) =>
      int.tryParse(RegExp('^$name=\'?(\\d+)\'?\$', multiLine: true).firstMatch(out)?.group(1) ?? '');
  return (left: value('bisect_nr'), steps: value('bisect_steps'));
}

/// The commit git reports as `<hash> is the first bad commit` in the output
/// of a `git bisect good|bad|skip|run`, or null.
String? firstBadCommitIn(String output) =>
    RegExp(r'^([0-9a-f]{7,64}) is the first (?:bad|new) commit', multiLine: true).firstMatch(output)?.group(1);
