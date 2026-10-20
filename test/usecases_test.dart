import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/commit_message_request.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/errors.dart';
import 'package:git_tools/domain/logic/line_selection.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/repositories/git_repository.dart';
import 'package:git_tools/domain/usecases/commit_changes.dart';
import 'package:git_tools/domain/usecases/generate_commit_message.dart';

const _diff = '''
diff --git a/a.txt b/a.txt
index 0000001..0000002 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@
-a
+A
 b
+c
''';

/// In-memory [GitRepository]: only the members used by the use cases.
class _FakeRepo implements GitRepository {
  String diff = _diff;
  Map<String, String> perFile = {};
  final commits = <String, Map<String, Object?>>{};

  @override
  Future<String> fileDiff(String path) async => diff;

  @override
  Future<List<int>?> fileBytes(Revision rev, String path) async => utf8.encode('a\nb\n');

  @override
  Future<Map<String, String>> diffPerFile(List<FileChange> changes, {String? base}) async => {...perFile};

  @override
  Future<List<String>> recentSubjects({int count = 15}) async => ['Fix the build'];

  @override
  Future<void> commit({
    required String message,
    required List<String> paths,
    bool amend = false,
    bool signOff = false,
    String? author,
    bool partial = true,
  }) async =>
      commits['commit'] = {'paths': paths, 'partial': partial};

  @override
  Future<void> commitSelected({
    required String message,
    required List<String> fullPaths,
    required Map<String, String> partial,
    bool amend = false,
    bool signOff = false,
    String? author,
  }) async =>
      commits['commitSelected'] = {'fullPaths': fullPaths, 'partial': partial};

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeAi implements CommitMessageGenerator {
  CommitMessageRequest? request;

  @override
  Future<String> generate(CommitMessageRequest req, {required void Function(String text) onText}) async {
    request = req;
    onText('Add c');
    return 'Add c';
  }

  @override
  Future<void> testConnection() async {}

  @override
  void cancel() {}
}

const _a = FileChange(path: 'a.txt', type: ChangeType.modified);
const _b = FileChange(path: 'b.txt', type: ChangeType.modified);
const _status = RepoStatus(branch: 'main', headHash: 'abc', changes: [_a, _b]);

void main() {
  group('CommitChanges', () {
    late _FakeRepo repo;
    late CommitChanges commitChanges;

    setUp(() {
      repo = _FakeRepo();
      commitChanges = CommitChanges(repo);
    });

    Future<PreparedCommit> prepare({
      RepoStatus status = _status,
      String message = 'msg',
      List<FileChange> changes = const [_a, _b],
      Map<String, LineSelection> lines = const {},
    }) =>
        commitChanges.prepare(status: status, message: message, changes: changes, lineSelections: lines);

    test('rejects invalid commits', () async {
      Matcher rejected(String title) =>
          throwsA(isA<CommitRejected>().having((e) => e.title, 'title', title));
      expect(prepare(message: ''), rejected('Commit message is empty'));
      expect(prepare(changes: const []), rejected('No changes selected for commit'));
      expect(
          prepare(status: const RepoStatus(headHash: 'abc', changes: [
            FileChange(path: 'x', type: ChangeType.conflicted),
          ])),
          rejected('Resolve all conflicts before committing'));
      final sel = LineSelection(parseDiff(_diff).signature, {'0:0'}, 3);
      expect(
          prepare(
              status: const RepoStatus(headHash: 'abc', state: RepoState.merging),
              lines: {'a.txt': sel}),
          rejected('Cannot commit selected lines during a merge or rebase'));
    });

    test('whole files are committed with --only outside a merge', () async {
      await commitChanges(await prepare());
      expect(repo.commits['commit'], {'paths': ['a.txt', 'b.txt'], 'partial': true});

      await commitChanges(await prepare(status: const RepoStatus(headHash: 'abc', state: RepoState.merging)));
      expect(repo.commits['commit']!['partial'], false);
    });

    test('files with a line selection are committed partially', () async {
      final parsed = parseDiff(_diff);
      final sel = LineSelection(parsed.signature, {'0:3'}, 3);
      await commitChanges(await prepare(lines: {'a.txt': sel}));
      expect(repo.commits['commitSelected'], {
        'fullPaths': ['b.txt'],
        'partial': {'a.txt': buildContent('a\nb\n', parsed, {'0:3'})},
      });
      expect(repo.commits, isNot(contains('commit')));
    });

    test('a changed diff makes the selection stale', () async {
      final sel = LineSelection('outdated', {'0:0'}, 3);
      expect(prepare(lines: {'a.txt': sel}),
          throwsA(isA<StaleSelectionException>().having((e) => e.path, 'path', 'a.txt')));
    });
  });

  group('GenerateCommitMessage', () {
    test('sends small diffs and lists large ones by name', () async {
      final repo = _FakeRepo()
        ..perFile = {
          'a.txt': 'diff of a\n',
          'b.txt': 'x' * 50000,
        };
      final ai = _FakeAi();
      ({AiProvider provider, String apiKey, String model})? created;
      final generate = GenerateCommitMessage(repo, (provider, {required apiKey, required model}) {
        created = (provider: provider, apiKey: apiKey, model: model);
        return ai;
      });
      final streamed = <String>[];
      final result = await generate(
        status: _status,
        changes: const [_a, _b],
        lineSelections: const {},
        config: const AiConfig(provider: AiProvider.gemini, apiKey: 'k', model: 'm', language: 'English'),
        onText: streamed.add,
      );

      expect(result.message, 'Add c');
      expect(result.omitted, ['b.txt']);
      expect(streamed, ['Add c']);
      expect(created, (provider: AiProvider.gemini, apiKey: 'k', model: 'm'));
      final req = ai.request!;
      expect(req.branch, 'main');
      expect(req.language, 'English');
      expect(req.recentSubjects, ['Fix the build']);
      expect(req.files, ['Modified: a.txt', 'Modified: b.txt']);
      expect(req.diff, contains('diff of a'));
      expect(req.diff, contains('diff of b.txt omitted: too large'));
    });
  });
}
