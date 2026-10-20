/// Input for one commit message generation.
class CommitMessageRequest {
  const CommitMessageRequest({
    required this.files,
    required this.diff,
    this.branch = '',
    this.recentSubjects = const [],
    this.language = '',
    this.instructions = '',
    this.amendOf,
  });

  /// Current branch name (empty when detached).
  final String branch;

  /// `<status> <path>` lines of the changes being committed.
  final List<String> files;
  final String diff;
  final List<String> recentSubjects;

  /// Language for the message; empty lets the model follow the history.
  final String language;
  final String instructions;

  /// Message of the commit being amended, if any.
  final String? amendOf;

  String toPrompt() {
    final b = StringBuffer();
    if (language.trim().isNotEmpty) {
      b
        ..writeln('Write the commit message in ${language.trim()}.')
        ..writeln();
    }
    if (instructions.trim().isNotEmpty) {
      b
        ..writeln('Additional instructions from the developer:')
        ..writeln(instructions.trim())
        ..writeln();
    }
    if (branch.isNotEmpty) b.writeln('Branch: $branch');
    if (recentSubjects.isNotEmpty) {
      b
        ..writeln()
        ..writeln('Recent commit subjects in this repository (newest first):')
        ..writeln(recentSubjects.map((s) => '- $s').join('\n'));
    }
    if (amendOf != null) {
      b
        ..writeln()
        ..writeln('This amends the previous commit, whose current message is:')
        ..writeln(amendOf);
    }
    b
      ..writeln()
      ..writeln('Files in this commit:')
      ..writeln(files.join('\n'))
      ..writeln()
      ..writeln('<diff>')
      ..writeln(diff)
      ..writeln('</diff>');
    return b.toString();
  }
}

const systemPrompt = '''
You write git commit messages for the changes a developer is about to commit.

Write the message the way an experienced engineer on this project would:
- First line: a concise summary of what the change does, in the imperative mood ("Add", "Fix", "Refactor"), at most 72 characters, no trailing period.
- If the change is more than trivial, add a blank line and then a short body explaining what changed and why, wrapped at about 72 characters. Bullet points are fine for several independent changes. Skip the body for small, self-explanatory changes.
- Follow the conventions visible in the project's recent commit subjects (for example a "feat:"/"fix:" prefix, ticket ids, capitalization, language) when they are consistent.
- Describe the intent of the change, not a file-by-file narration. Do not invent motivations that the diff does not support.

Reply with the commit message only: no preamble, no quotes, no Markdown code fences.''';
