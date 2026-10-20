import '../entities/rebase.dart';
import '../errors.dart';

/// A line of a todo list written by git.
sealed class TodoLine {
  const TodoLine();
}

/// `pick` / `reword` / `edit` / `squash` / `fixup` / `drop` of a commit.
class TodoCommitLine extends TodoLine {
  const TodoCommitLine(this.action, this.hash);

  final RebaseAction action;

  /// Commit id as written by git (usually abbreviated).
  final String hash;
}

/// Any other command, kept verbatim.
class TodoOtherLine extends TodoLine {
  const TodoOtherLine(this.line);

  final String line;
}

const _commitVerbs = {
  'pick': RebaseAction.pick, 'p': RebaseAction.pick,
  'reword': RebaseAction.reword, 'r': RebaseAction.reword,
  'edit': RebaseAction.edit, 'e': RebaseAction.edit,
  'squash': RebaseAction.squash, 's': RebaseAction.squash,
  'fixup': RebaseAction.fixup, 'f': RebaseAction.fixup,
  'drop': RebaseAction.drop, 'd': RebaseAction.drop,
};

/// Comment prefix of the todo from `core.commentString` / `core.commentChar`.
/// `auto` only applies to commit messages, so the todo keeps `#`.
String todoCommentPrefix(String? commentString, String? commentChar) {
  final v = commentString ?? commentChar;
  if (v == null || v.isEmpty || v == 'auto') return '#';
  return v;
}

/// Parses a todo list. Blank lines and lines starting with [comment] are
/// skipped; abbreviated commands (`p`, `f`, `l`, ...) are understood.
List<TodoLine> parseTodo(String text, {String comment = '#'}) {
  final result = <TodoLine>[];
  for (final raw in text.split('\n')) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith(comment)) continue;
    final words = line.split(RegExp(r'\s+'));
    var action = _commitVerbs[words[0]];
    var h = 1;
    // `fixup -C` / `-c` keeps the message of this commit (autosquash of
    // `amend!` commits): closest to a squash with an editable message.
    if (action == RebaseAction.fixup && words.length > 2 && (words[1] == '-C' || words[1] == '-c')) {
      action = RebaseAction.squash;
      h = 2;
    }
    if (action != null && words.length > h && RegExp(r'^[0-9a-f]{4,}$').hasMatch(words[h])) {
      result.add(TodoCommitLine(action, words[h]));
    } else {
      result.add(TodoOtherLine(line));
    }
  }
  return result;
}

/// Quotes [s] for `sh`.
String shellQuote(String s) => "'${s.replaceAll("'", r"'\''")}'";

// -----------------------------------------------------------------------------
// Runs and squash groups
// -----------------------------------------------------------------------------

/// Bounds `[start, end)` of the run of commit lines containing [i]. Commits
/// are only reordered within their run.
(int, int) commitRun(List<RebaseEntry> entries, int i) {
  var start = i, end = i + 1;
  while (start > 0 && entries[start - 1] is RebaseCommitEntry) {
    start--;
  }
  while (end < entries.length && entries[end] is RebaseCommitEntry) {
    end++;
  }
  return (start, end);
}

/// Index of the commit a squash / fixup at [i] melds into (skipping dropped
/// commits and other melds), [i] itself when it is not a meld, or null when
/// nothing precedes it in its run.
int? groupLead(List<RebaseEntry> entries, int i) {
  final e = entries[i];
  if (e is! RebaseCommitEntry) return null;
  if (!e.action.isMeld) return e.action == RebaseAction.drop ? null : i;
  for (var j = i - 1; j >= 0; j--) {
    final p = entries[j];
    if (p is! RebaseCommitEntry) return null;
    if (p.action == RebaseAction.drop || p.action.isMeld) continue;
    return j;
  }
  return null;
}

/// Squash / fixup commits melded into the commit at [lead].
List<int> groupMembers(List<RebaseEntry> entries, int lead) {
  final members = <int>[];
  for (var j = lead + 1; j < entries.length; j++) {
    final e = entries[j];
    if (e is! RebaseCommitEntry) break;
    if (e.action == RebaseAction.drop) continue;
    if (!e.action.isMeld) break;
    members.add(j);
  }
  return members;
}

/// Whether the commit at [lead] (with its melds) gets a new message: it is
/// reworded or something is squashed into it. A group made only of fixups
/// keeps the first message.
bool needsMessage(List<RebaseEntry> entries, int lead) {
  final e = entries[lead];
  if (e is! RebaseCommitEntry || e.action == RebaseAction.drop || e.action.isMeld) return false;
  return e.action == RebaseAction.reword ||
      groupMembers(entries, lead).any((j) => (entries[j] as RebaseCommitEntry).action == RebaseAction.squash);
}

/// Messages of the group joined by a blank line, fixup messages excluded.
String defaultGroupMessage(List<RebaseEntry> entries, int lead) {
  final parts = [
    (entries[lead] as RebaseCommitEntry).message,
    for (final j in groupMembers(entries, lead))
      if ((entries[j] as RebaseCommitEntry).action == RebaseAction.squash) (entries[j] as RebaseCommitEntry).message,
  ];
  return parts.map((m) => m.trim()).where((m) => m.isNotEmpty).join('\n\n');
}

/// Message the commit at [lead] ends up with.
String groupMessage(List<RebaseEntry> entries, int lead) {
  final e = entries[lead] as RebaseCommitEntry;
  if (e.newMessage != null) return e.newMessage!;
  if (groupMembers(entries, lead).isEmpty) return e.message;
  return defaultGroupMessage(entries, lead);
}

// -----------------------------------------------------------------------------
// Validation and todo
// -----------------------------------------------------------------------------

/// A problem of an edited todo, attached to the entry at [index] (-1 for the
/// whole list).
class RebaseIssue {
  const RebaseIssue(this.index, this.message, {this.isError = true});

  final int index;
  final String message;
  final bool isError;

  @override
  String toString() => message;
}

List<RebaseIssue> validateTodo(List<RebaseEntry> entries) {
  final issues = <RebaseIssue>[];
  for (var i = 0; i < entries.length; i++) {
    final e = entries[i];
    if (e is! RebaseCommitEntry) continue;
    if (e.action.isMeld && groupLead(entries, i) == null) {
      issues.add(RebaseIssue(i, 'Cannot ${e.action.name} ${e.shortHash}: there is no previous commit to meld into'));
    } else if (needsMessage(entries, i) && groupMessage(entries, i).trim().isEmpty) {
      issues.add(RebaseIssue(i, 'Commit message of ${e.shortHash} cannot be empty'));
    }
  }
  final commits = entries.whereType<RebaseCommitEntry>();
  if (commits.isNotEmpty && commits.every((c) => c.action == RebaseAction.drop)) {
    issues.add(const RebaseIssue(-1, 'All commits will be dropped', isError: false));
  }
  return issues;
}

/// The todo to hand to git and the message files it refers to.
class BuiltTodo {
  const BuiltTodo(this.todo, this.messages);

  final String todo;

  /// File name (in the state directory) → commit message.
  final Map<String, String> messages;
}

/// Turns the edited entries into a todo git runs without asking anything:
/// a reword becomes `pick` + `exec git commit --amend --allow-empty -F <file>`
/// (`--allow-empty` so empty commits can be reworded too; hooks still run),
/// a squash group becomes `pick` + `fixup`s + one amend with the group message.
/// Message files live in [stateDir] (forward slashes). Throws
/// [RebaseRejected] when the entries are not valid.
BuiltTodo buildTodo(List<RebaseEntry> entries, {required String stateDir}) {
  final errors = validateTodo(entries).where((i) => i.isError).toList();
  if (errors.isNotEmpty) {
    throw RebaseRejected('Invalid rebase', details: errors.join('\n'));
  }
  final lines = <String>[];
  final messages = <String, String>{};
  // Index of the last member of a group → message to amend after it.
  final amendAfter = <int, String>{};
  for (var i = 0; i < entries.length; i++) {
    final e = entries[i];
    if (e is RebaseStructuralEntry) {
      lines.add(e.line);
      continue;
    }
    e as RebaseCommitEntry;
    final verb = switch (e.action) {
      RebaseAction.pick || RebaseAction.reword => 'pick',
      RebaseAction.edit => 'edit',
      RebaseAction.squash || RebaseAction.fixup => 'fixup',
      RebaseAction.drop => 'drop',
    };
    lines.add('$verb ${e.hash} ${e.subject}');
    if (!e.action.isMeld && needsMessage(entries, i)) {
      final members = groupMembers(entries, i);
      amendAfter[members.isEmpty ? i : members.last] = groupMessage(entries, i);
    }
    final msg = amendAfter.remove(i);
    if (msg != null) {
      final name = 'msg-${messages.length + 1}.txt';
      messages[name] = msg.endsWith('\n') ? msg : '$msg\n';
      lines.add('exec git commit --amend --allow-empty -F ${shellQuote('$stateDir/$name')}');
    }
  }
  return BuiltTodo('${lines.join('\n')}\n', messages);
}

// -----------------------------------------------------------------------------
// Edits used by the log menu
// -----------------------------------------------------------------------------

int _indexOf(List<RebaseEntry> entries, String hash) {
  final i = entries.indexWhere((e) => e is RebaseCommitEntry && e.hash == hash);
  if (i < 0) {
    throw RebaseRejected('Commit is not part of the rebase',
        details: '${hash.substring(0, hash.length.clamp(0, 8))} is a merge commit or is not on the current branch.');
  }
  return i;
}

List<RebaseEntry> _set(List<RebaseEntry> entries, int i, RebaseAction action, {String? Function()? newMessage}) =>
    [...entries]..[i] = (entries[i] as RebaseCommitEntry).copyWith(action: action, newMessage: newMessage);

/// Swaps the entry at [i] with the commit at `i + delta` (+1 = later, i.e.
/// newer). Returns null when that is not a commit of the same run.
List<RebaseEntry>? moveEntry(List<RebaseEntry> entries, int i, int delta) {
  final j = i + delta;
  if (entries[i] is! RebaseCommitEntry || j < 0 || j >= entries.length || entries[j] is! RebaseCommitEntry) {
    return null;
  }
  final list = [...entries];
  list[i] = entries[j];
  list[j] = entries[i];
  return list;
}

List<RebaseEntry> rewordCommit(List<RebaseEntry> entries, String hash, String message) =>
    _set(entries, _indexOf(entries, hash), RebaseAction.reword, newMessage: () => message);

/// Squashes [hashes] (consecutive in the todo) into the oldest of them.
List<RebaseEntry> squashCommits(List<RebaseEntry> entries, Iterable<String> hashes, String message) {
  final idx = [for (final h in hashes) _indexOf(entries, h)]..sort();
  for (var k = 1; k < idx.length; k++) {
    if (idx[k] != idx[k - 1] + 1) {
      throw RebaseRejected('Cannot squash these commits',
          details: 'The selected commits must be consecutive and not separated by a merge.');
    }
  }
  var list = _set(entries, idx.first, RebaseAction.pick, newMessage: () => message);
  for (final i in idx.skip(1)) {
    list = _set(list, i, RebaseAction.squash);
  }
  return list;
}

/// Melds [hash] into the commit before it, keeping that commit's message.
List<RebaseEntry> fixupCommit(List<RebaseEntry> entries, String hash) {
  final i = _indexOf(entries, hash);
  if (i == 0 || entries[i - 1] is! RebaseCommitEntry) {
    throw RebaseRejected('Cannot fixup this commit', details: 'Its parent is a merge commit or is not part of the rebase.');
  }
  return _set(entries, i, RebaseAction.fixup);
}

/// Moves [hash] one position up (newer, [delta] = 1) or down (older, -1).
List<RebaseEntry> moveCommit(List<RebaseEntry> entries, String hash, int delta) {
  final moved = moveEntry(entries, _indexOf(entries, hash), delta);
  if (moved == null) {
    throw RebaseRejected('Cannot move this commit', details: 'Commits cannot be moved across a merge.');
  }
  return moved;
}

List<RebaseEntry> dropCommits(List<RebaseEntry> entries, Iterable<String> hashes) {
  var list = entries;
  for (final h in hashes) {
    list = _set(list, _indexOf(list, h), RebaseAction.drop);
  }
  return list;
}
