import '../entities/worktree.dart';

/// Parses `git worktree list --porcelain -z`: one attribute per NUL
/// terminated field, an empty field ends each worktree. [currentPath] is the
/// top level of the opened work tree (`git rev-parse --show-toplevel`).
List<Worktree> parseWorktrees(String out, {String? currentPath}) {
  final result = <Worktree>[];
  Map<String, String?>? attrs;

  void flush() {
    final a = attrs;
    attrs = null;
    final path = a?['worktree'];
    if (a == null || path == null) return;
    final branch = a['branch'];
    result.add(Worktree(
      path: path,
      head: a['HEAD'],
      branch: branch == null
          ? null
          : branch.startsWith('refs/heads/')
              ? branch.substring(11)
              : branch,
      detached: a.containsKey('detached'),
      bare: a.containsKey('bare'),
      locked: a.containsKey('locked'),
      lockReason: a['locked'],
      prunable: a.containsKey('prunable'),
      prunableReason: a['prunable'],
      isMain: result.isEmpty,
      isCurrent: currentPath != null && samePath(path, currentPath),
    ));
  }

  for (final field in out.split('\x00')) {
    if (field.isEmpty) {
      flush();
      continue;
    }
    final sp = field.indexOf(' ');
    final key = sp < 0 ? field : field.substring(0, sp);
    final value = sp < 0 ? null : field.substring(sp + 1);
    if (key == 'worktree') flush();
    (attrs ??= {})[key] = value;
  }
  flush();
  return result;
}

/// Whether two absolute paths name the same folder: slashes and a trailing
/// separator are ignored, and Windows paths (drive letter) ignore case.
bool samePath(String a, String b) {
  String norm(String s) {
    var r = s.replaceAll('\\', '/');
    while (r.length > 1 && r.endsWith('/')) {
      r = r.substring(0, r.length - 1);
    }
    return RegExp(r'^[A-Za-z]:').hasMatch(r) ? r.toLowerCase() : r;
  }

  return norm(a) == norm(b);
}

/// Branch name made safe for a folder name: anything but letters, digits,
/// `.`, `_` and `-` becomes `-`.
String sanitizeForPath(String name) {
  final s = name
      .replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '-')
      .replaceAll(RegExp(r'-{2,}'), '-')
      .replaceAll(RegExp(r'^[-.]+|[-.]+$'), '');
  return s.isEmpty ? 'worktree' : s;
}

/// Default folder of a new worktree: `../<repo-name>-<branch>` next to the
/// repository at [root] (forward slashes).
String defaultWorktreePath(String root, String? branch) {
  var r = root.replaceAll('\\', '/');
  while (r.length > 1 && r.endsWith('/')) {
    r = r.substring(0, r.length - 1);
  }
  final i = r.lastIndexOf('/');
  final parent = i < 0 ? '.' : (i == 0 ? '/' : r.substring(0, i));
  final name = i < 0 ? r : r.substring(i + 1);
  final suffix = branch == null || branch.trim().isEmpty ? 'worktree' : sanitizeForPath(branch.trim());
  return '${parent.endsWith('/') ? parent : '$parent/'}$name-$suffix';
}

/// Path of the worktree named in git's refusal to check out a branch that
/// is checked out elsewhere, or null for other errors. Git 2.42+ says
/// `'x' is already used by worktree at '<path>'`, older versions
/// `'x' is already checked out at '<path>'`.
String? worktreeOfCheckoutError(String stderr) => RegExp(
      r"is already (?:used by worktree|checked out) at '([^'\n]+)'",
    ).firstMatch(stderr)?.group(1);
