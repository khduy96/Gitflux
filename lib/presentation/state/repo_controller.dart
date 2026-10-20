import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:path/path.dart' as p;

import '../../domain/entities/console_entry.dart';
import '../../domain/entities/git_models.dart';
import '../../domain/entities/rebase.dart';
import '../../domain/errors.dart';
import '../../domain/logic/graph_layout.dart';
import '../../domain/logic/line_selection.dart';
import '../../domain/repositories/commit_message_generator.dart';
import '../../domain/repositories/git_repository.dart';
import '../../domain/repositories/git_service.dart';
import '../../domain/usecases/commit_changes.dart';
import '../../domain/usecases/generate_commit_message.dart';
import '../../domain/usecases/get_selected_line_contents.dart';
import '../../domain/usecases/interactive_rebase.dart';
import 'app_settings.dart';

enum GenerateResult { done, needsSetup, failed }

class AppNotification {
  AppNotification(this.title, {this.details, this.isError = false, this.actionLabel, this.onAction})
      : id = _next++;

  static int _next = 0;
  final int id;
  final String title;
  final String? details;
  final bool isError;

  /// Optional button shown on the notification.
  final String? actionLabel;
  final VoidCallback? onAction;
}

/// A tab in the central editor area.
sealed class EditorTab {
  String get key;
  String get title;
}

class DiffTab extends EditorTab {
  DiffTab(this.request);
  final DiffRequest request;

  @override
  String get key => 'diff:${request.key}';
  @override
  String get title => request.title;
}

class BlameTab extends EditorTab {
  BlameTab(this.path);
  final String path;

  @override
  String get key => 'blame:$path';
  @override
  String get title => '${p.basename(path)} (Annotate)';
}

/// Line selection (partial commit) of a modified file.
class LinesTab extends EditorTab {
  LinesTab(this.path);
  final String path;

  @override
  String get key => 'lines:$path';
  @override
  String get title => '${p.basename(path)} (Commit Lines)';
}

class LogFilter {
  const LogFilter({this.branch, this.path, this.text = ''});

  /// Ref to show (null = all branches).
  final String? branch;

  /// Show history for this path only.
  final String? path;

  /// Client side filter on subject / hash / author.
  final String text;

  LogFilter copyWith({
    String? Function()? branch,
    String? Function()? path,
    String? text,
  }) =>
      LogFilter(
        branch: branch != null ? branch() : this.branch,
        path: path != null ? path() : this.path,
        text: text ?? this.text,
      );
}

class RepoController {
  RepoController(
    String root, {
    required GitService git,
    required CommitMessageGeneratorFactory commitMessageAi,
  }) {
    repo = git.open(root, onConsole: _addConsole);
    _commitChanges = CommitChanges(repo);
    _generateMessage = GenerateCommitMessage(repo, commitMessageAi);
    _selectedContents = GetSelectedLineContents(repo);
    _rebase = InteractiveRebase(repo);
  }

  late final GitRepository repo;
  late final CommitChanges _commitChanges;
  late final GenerateCommitMessage _generateMessage;
  late final GetSelectedLineContents _selectedContents;
  late final InteractiveRebase _rebase;

  final status = ValueNotifier<RepoStatus>(const RepoStatus());

  /// Position of the rebase in progress (null when not rebasing).
  final rebaseProgress = ValueNotifier<RebaseProgress?>(null);
  final branches = ValueNotifier<List<Branch>>(const []);
  final tags = ValueNotifier<List<Tag>>(const []);
  final remotes = ValueNotifier<List<Remote>>(const []);
  final stashes = ValueNotifier<List<Stash>>(const []);
  final submodules = ValueNotifier<List<Submodule>>(const []);

  /// Set to a repository path the workspace should open (e.g. a submodule).
  final openRepoRequest = ValueNotifier<String?>(null);
  final commits = ValueNotifier<List<Commit>>(const []);
  final graph = ValueNotifier<List<GraphRow>>(const []);
  final logFilter = ValueNotifier<LogFilter>(const LogFilter());
  final logLoading = ValueNotifier<bool>(false);
  final selectedCommit = ValueNotifier<Commit?>(null);

  final console = ValueNotifier<List<ConsoleEntry>>(const []);
  final busy = ValueNotifier<String?>(null);
  final notifications = ValueNotifier<AppNotification?>(null);

  final tabs = ValueNotifier<List<EditorTab>>(const []);
  final activeTab = ValueNotifier<String?>(null);

  /// Bottom tool window tab requested by actions (0 = Log, 1 = Console...).
  final bottomTab = ValueNotifier<int>(0);

  // Changes view inclusion (Android Studio checkbox model).
  final included = ValueNotifier<Set<String>>(const {});
  final Set<String> _excludedTracked = {};
  final Set<String> _includedUntracked = {};

  final commitMessage = TextEditingController();
  final amend = ValueNotifier<bool>(false);
  String _messageBeforeAmend = '';
  String? _prefilledMessage;

  StreamSubscription<RepoEvent>? _watch;
  Timer? _debounce;
  bool _refsDirty = false;
  bool _disposed = false;
  int _logGen = 0;

  String get root => repo.root;
  String get name => repo.name;

  Future<void> open() async {
    await refreshAll();
    final msg = await repo.pendingMergeMessage();
    if (msg != null && commitMessage.text.isEmpty) {
      commitMessage.text = msg;
      _prefilledMessage = msg;
    }
    _startWatching();
  }

  void dispose() {
    _disposed = true;
    _generateMessage.cancel();
    _watch?.cancel();
    _debounce?.cancel();
    commitMessage.dispose();
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  Future<void> refreshAll() async {
    final headBefore = status.value.headHash;
    await Future.wait([
      refreshStatus(),
      refreshRefs(),
    ]);
    _checkSubmodulesAfterHeadChange(headBefore);
    await refreshLog();
  }

  /// After checkout / pull / merge / reset of the parent repository, offers
  /// to bring submodules to the recorded commits.
  void _checkSubmodulesAfterHeadChange(String? headBefore) {
    if (headBefore == null || headBefore == status.value.headHash) return;
    final stale = submodules.value
        .where((s) => s.status == SubmoduleStatus.outOfDate || s.status == SubmoduleStatus.uninitialized)
        .toList();
    if (stale.isEmpty) return;
    notify(AppNotification(
      '${stale.length} submodule${stale.length == 1 ? ' is' : 's are'} not at the recorded commit',
      details: stale.map((s) => s.path).take(5).join(', '),
      actionLabel: 'Update Submodules',
      onAction: () => updateSubmodules(),
    ));
  }

  Future<void> updateSubmodules({List<String> paths = const []}) => run(
        paths.length == 1 ? 'Update submodule ${paths.first}' : 'Update submodules',
        () => repo.updateSubmodules(paths: paths),
        success: 'Submodules updated',
      );

  /// Asks the workspace to open [path] (relative to this repository).
  void openSubmodule(String path) => openRepoRequest.value = p.normalize(p.join(root, path));

  Future<void> refreshStatus() async {
    try {
      final s = await repo.status();
      if (_disposed) return;
      final previous = status.value.state;
      status.value = s;
      _recomputeIncluded();
      if (s.state == RepoState.rebasing) {
        final progress = await repo.rebaseProgress();
        if (!_disposed) rebaseProgress.value = progress;
      } else {
        rebaseProgress.value = null;
        // The rebase may have ended outside this tool (e.g. in a terminal).
        if (busy.value == null) await repo.cleanupRebaseState();
      }
      // Prefill the prepared message when a merge / cherry-pick starts.
      if (previous == RepoState.normal &&
          s.state != RepoState.normal &&
          commitMessage.text.trim().isEmpty) {
        final msg = await repo.pendingMergeMessage();
        if (msg != null && !_disposed) {
          commitMessage.text = msg;
          _prefilledMessage = msg;
        }
      } else if (s.state == RepoState.normal &&
          _prefilledMessage != null &&
          commitMessage.text.trim() == _prefilledMessage!.trim()) {
        // The operation was continued or aborted outside the commit box.
        commitMessage.clear();
        _prefilledMessage = null;
      }
    } catch (e) {
      _addConsole(ConsoleEntry('status failed: $e', ConsoleKind.error));
    }
  }

  Future<void> refreshRefs() async {
    try {
      final results = await Future.wait([
        repo.branches(),
        repo.tags(),
        repo.remotes(),
        repo.stashes(),
        repo.submodules(),
      ]);
      if (_disposed) return;
      branches.value = results[0] as List<Branch>;
      tags.value = results[1] as List<Tag>;
      remotes.value = results[2] as List<Remote>;
      stashes.value = results[3] as List<Stash>;
      submodules.value = results[4] as List<Submodule>;
    } catch (e) {
      _addConsole(ConsoleEntry('refs failed: $e', ConsoleKind.error));
    }
  }

  Future<void> refreshLog() async {
    final gen = ++_logGen;
    logLoading.value = true;
    try {
      final f = logFilter.value;
      final list = await repo.log(
        revisions: f.branch == null ? null : [f.branch!],
        path: f.path,
      );
      if (_disposed || gen != _logGen) return;
      commits.value = list;
      graph.value = layoutGraph(list);
      final sel = selectedCommit.value;
      if (sel != null) {
        selectedCommit.value =
            list.where((c) => c.hash == sel.hash).firstOrNull;
      }
    } catch (e) {
      _addConsole(ConsoleEntry('log failed: $e', ConsoleKind.error));
    } finally {
      if (gen == _logGen) logLoading.value = false;
    }
  }

  void setLogFilter(LogFilter f) {
    final old = logFilter.value;
    logFilter.value = f;
    if (old.branch != f.branch || old.path != f.path) refreshLog();
  }

  void showHistory(String path) {
    setLogFilter(logFilter.value.copyWith(path: () => path, branch: () => null));
    bottomTab.value = 0;
  }

  void _startWatching() {
    try {
      _watch = repo.watch().listen(_onRepoEvent);
    } catch (e) {
      _addConsole(ConsoleEntry('File watching unavailable: $e', ConsoleKind.info));
    }
  }

  void _onRepoEvent(RepoEvent e) {
    if (e == RepoEvent.refs) _refsDirty = true;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 600), () {
      if (busy.value != null) return; // refreshed when the operation ends
      if (_refsDirty) {
        _refsDirty = false;
        refreshAll();
      } else {
        refreshStatus();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Inclusion
  // ---------------------------------------------------------------------------

  void _recomputeIncluded() {
    final s = status.value;
    final paths = {for (final c in s.changes) c.path};
    _excludedTracked.removeWhere((p) => !paths.contains(p));
    _includedUntracked.removeWhere((p) => !paths.contains(p));
    final stale = lineSelections.value.keys
        .where((p) => !canSelectLines(s.changes.where((c) => c.path == p).firstOrNull))
        .toList();
    if (stale.isNotEmpty) {
      lineSelections.value = {...lineSelections.value}..removeWhere((k, _) => stale.contains(k));
    }
    included.value = {
      for (final c in s.changes)
        // A nested repository is never committed as files.
        if (!c.nestedRepo &&
            (c.type == ChangeType.untracked
                ? _includedUntracked.contains(c.path)
                : !_excludedTracked.contains(c.path)))
          c.path,
    };
  }

  void setIncluded(Iterable<FileChange> changes, bool value) {
    final selections = {...lineSelections.value};
    // Ticking / unticking the whole file drops a line selection.
    for (final c in changes) {
      selections.remove(c.path);
    }
    if (selections.length != lineSelections.value.length) lineSelections.value = selections;
    for (final c in changes) {
      final untracked = c.type == ChangeType.untracked;
      if (untracked) {
        value ? _includedUntracked.add(c.path) : _includedUntracked.remove(c.path);
      } else {
        value ? _excludedTracked.remove(c.path) : _excludedTracked.add(c.path);
      }
    }
    _recomputeIncluded();
  }

  List<FileChange> get includedChanges => status.value.changes
      .where((c) => included.value.contains(c.path))
      .toList();

  // ---------------------------------------------------------------------------
  // Line selection (partial commit)
  // ---------------------------------------------------------------------------

  /// Files committed partially: path → excluded line keys of its diff.
  final lineSelections = ValueNotifier<Map<String, LineSelection>>(const {});

  /// Whether lines of this change can be selected individually.
  bool canSelectLines(FileChange? c) =>
      c != null && c.type == ChangeType.modified && !c.isSubmodule && status.value.hasCommits;

  void openLineSelection(String path) => openTab(LinesTab(path));

  /// Stores which changed lines of [path] are left out of the commit. No
  /// exclusions means the whole file, all excluded means nothing.
  void setLineSelection(String path, String signature, Set<String> excluded, int total) {
    final selections = {...lineSelections.value};
    if (excluded.isEmpty) {
      selections.remove(path);
      _excludedTracked.remove(path);
    } else if (excluded.length >= total) {
      selections.remove(path);
      _excludedTracked.add(path);
    } else {
      selections[path] = LineSelection(signature, {...excluded}, total);
      _excludedTracked.remove(path);
    }
    lineSelections.value = selections;
    _recomputeIncluded();
  }

  /// Content to commit for every included file with a line selection.
  /// Throws [StaleSelectionException] when a file changed since selection.
  Future<List<SelectedContent>> selectedContents() =>
      _selectedContents(includedChanges, lineSelections.value);

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  /// Runs a git operation with progress indication and error reporting.
  /// Returns false when it failed.
  Future<bool> run(
    String label,
    Future<void> Function() action, {
    String? success,
    bool refresh = true,
  }) async {
    busy.value = label;
    _addConsole(ConsoleEntry('$label…', ConsoleKind.info));
    try {
      await action();
      if (success != null) notify(AppNotification(success));
      return true;
    } on GitException catch (e) {
      notify(AppNotification('$label failed', details: e.message, isError: true));
      return false;
    } on RebaseRejected catch (e) {
      notify(AppNotification(e.title, details: e.details, isError: true));
      return false;
    } catch (e) {
      notify(AppNotification('$label failed', details: '$e', isError: true));
      return false;
    } finally {
      busy.value = null;
      if (refresh && !_disposed) await refreshAll();
    }
  }

  void notify(AppNotification n) {
    if (_disposed) return;
    notifications.value = n;
    if (n.isError) {
      _addConsole(ConsoleEntry('${n.title}: ${n.details ?? ''}', ConsoleKind.error));
    }
  }

  Future<void> toggleAmend(bool value) async {
    amend.value = value;
    if (value) {
      _messageBeforeAmend = commitMessage.text;
      if (commitMessage.text.trim().isEmpty && status.value.hasCommits) {
        commitMessage.text = await repo.lastCommitMessage();
      }
    } else {
      commitMessage.text = _messageBeforeAmend;
    }
  }

  Future<bool> commit({bool signOff = false, String? author}) async {
    final changes = includedChanges;
    final PreparedCommit prepared;
    try {
      prepared = await _commitChanges.prepare(
        status: status.value,
        message: commitMessage.text.trim(),
        changes: changes,
        lineSelections: lineSelections.value,
        amend: amend.value,
        signOff: signOff,
        author: author,
      );
    } on CommitRejected catch (e) {
      notify(AppNotification(e.title, details: e.details, isError: true));
      return false;
    } on StaleSelectionException catch (e) {
      notify(AppNotification('Line selection is out of date', details: '$e', isError: true));
      openLineSelection(e.path);
      return false;
    }
    final partial = prepared.partial;
    final ok = await run(
      amend.value ? 'Amend commit' : 'Commit',
      () => _commitChanges(prepared),
      success: amend.value
          ? 'Amended commit'
          : '${changes.length} file${changes.length == 1 ? '' : 's'} committed'
              '${partial.isEmpty ? '' : ' (${partial.length} partially)'}: ${prepared.message.split('\n').first}',
    );
    if (ok) {
      commitMessage.clear();
      amend.value = false;
      _messageBeforeAmend = '';
      _includedUntracked.clear();
      _excludedTracked.clear();
      lineSelections.value = const {};
      _recomputeIncluded();
    }
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Interactive rebase
  // ---------------------------------------------------------------------------

  /// Lets git generate the todo for rebasing the current branch from
  /// [target]. Null (with a notification) when it cannot be rebased.
  Future<RebasePlan?> prepareRebase(String target) async {
    RebasePlan? plan;
    await run('Prepare rebase', () async => plan = await _rebase.prepare(target), refresh: false);
    return plan;
  }

  /// Runs the edited todo of [plan]. Returns false when it failed. A rebase
  /// that stopped (conflict, edit, failing hook) is left to the banner of the
  /// Commit panel.
  Future<bool> runRebase(
    RebasePlan plan,
    List<RebaseEntry> entries, {
    required String label,
    required String success,
  }) async {
    RebaseOutcome? outcome;
    final ok = await run(label, () async => outcome = await _rebase.start(plan, entries));
    final out = outcome;
    if (!ok || out == null) return false;
    final progress = rebaseProgress.value;
    if (!out.stopped) {
      notify(AppNotification(success));
    } else if (status.value.conflicts.isNotEmpty) {
      notify(AppNotification('$label stopped: conflicts need to be resolved',
          details: 'Resolve the conflicts, then click Continue in the Commit panel (or Abort).',
          isError: true));
    } else if (progress != null && progress.stoppedForEdit) {
      notify(AppNotification('Stopped at ${progress.stoppedShort} for editing',
          details: 'Amend the commit, then click Continue in the Commit panel.'));
    } else {
      final lines = out.output.trim().split('\n');
      notify(AppNotification('$label stopped',
          details: lines.sublist((lines.length - 6).clamp(0, lines.length)).join('\n'), isError: true));
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // AI commit message
  // ---------------------------------------------------------------------------

  final generating = ValueNotifier<bool>(false);

  void cancelGeneration() => _generateMessage.cancel();

  /// Fills the commit message box with a message generated from the
  /// selected changes (or the amended commit).
  Future<GenerateResult> generateCommitMessage(AppSettings settings) async {
    if (!settings.aiConfigured) return GenerateResult.needsSetup;
    if (generating.value) return GenerateResult.failed;
    final s = status.value;
    final changes = includedChanges
        .where((c) => c.type != ChangeType.conflicted)
        .toList();
    final isAmend = amend.value && s.hasCommits;
    if (changes.isEmpty && !isAmend) {
      notify(AppNotification('Select the files to commit first',
          details: 'The message is generated from the checked changes.', isError: true));
      return GenerateResult.failed;
    }

    final previous = commitMessage.text;
    generating.value = true;
    try {
      final (:message, :omitted) = await _generateMessage(
        status: s,
        changes: changes,
        amend: isAmend,
        lineSelections: lineSelections.value,
        config: settings.aiConfig,
        onInfo: (t) => _addConsole(ConsoleEntry(t, ConsoleKind.info)),
        onText: (t) {
          if (!_disposed) commitMessage.text = t;
        },
      );
      if (_disposed) return GenerateResult.done;
      commitMessage.text = message;
      if (omitted.isNotEmpty) {
        notify(AppNotification('Commit message generated',
            details: 'Large diffs were left out and only listed by name: '
                '${omitted.take(5).join(', ')}${omitted.length > 5 ? ', …' : ''}'));
      }
      return GenerateResult.done;
    } on AiException catch (e) {
      if (!_disposed) {
        commitMessage.text = previous;
        if (!e.cancelled) {
          notify(AppNotification('Generate commit message failed',
              details: e.message, isError: true));
        }
      }
      return GenerateResult.failed;
    } catch (e) {
      if (!_disposed) {
        commitMessage.text = previous;
        notify(AppNotification('Generate commit message failed', details: '$e', isError: true));
      }
      return GenerateResult.failed;
    } finally {
      if (!_disposed) generating.value = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Editor tabs
  // ---------------------------------------------------------------------------

  /// Key of the tab opened in preview mode (replaced by the next preview).
  final previewTab = ValueNotifier<String?>(null);

  void openTab(EditorTab tab, {bool preview = false}) {
    final list = [...tabs.value];
    final existing = list.indexWhere((t) => t.key == tab.key);
    if (existing >= 0) {
      if (!preview && previewTab.value == tab.key) previewTab.value = null;
    } else if (preview) {
      final pi = list.indexWhere((t) => t.key == previewTab.value);
      if (pi >= 0) {
        list[pi] = tab;
      } else {
        list.add(tab);
      }
      previewTab.value = tab.key;
    } else {
      list.add(tab);
    }
    tabs.value = list;
    activeTab.value = tab.key;
  }

  void closeTab(String key) {
    final list = [...tabs.value];
    final i = list.indexWhere((t) => t.key == key);
    if (i < 0) return;
    list.removeAt(i);
    if (previewTab.value == key) previewTab.value = null;
    tabs.value = list;
    if (activeTab.value == key) {
      activeTab.value =
          list.isEmpty ? null : list[i.clamp(0, list.length - 1)].key;
    }
  }

  void closeAllTabs() {
    tabs.value = const [];
    activeTab.value = null;
    previewTab.value = null;
  }

  /// Diff of a working tree change against HEAD.
  void showLocalDiff(FileChange c, {bool preview = false}) =>
      openTab(DiffTab(localDiffRequest(c)), preview: preview);

  DiffRequest localDiffRequest(FileChange c) {
    final hasHead = status.value.hasCommits;
    final Revision left = switch (c.type) {
      ChangeType.untracked || ChangeType.added => const EmptyRev(),
      _ => hasHead ? const CommitRev('HEAD') : const IndexRev(),
    };
    final Revision right = c.type == ChangeType.deleted
        ? const EmptyRev()
        : const WorkingTreeRev();
    return DiffRequest(
      title: c.fileName,
      leftPath: c.oldPath ?? c.path,
      rightPath: c.path,
      left: left,
      right: right,
      leftTitle: left is EmptyRev ? '(does not exist)' : 'HEAD',
      rightTitle: right is EmptyRev ? '(deleted)' : 'Your version',
    );
  }

  /// Diff of a file changed in commit [hash] relative to [parent].
  void showCommitDiff(FileChange f, String hash, String? parent,
      {String? titleSuffix, bool preview = false}) {
    openTab(DiffTab(commitDiffRequest(f, hash, parent, titleSuffix: titleSuffix)),
        preview: preview);
  }

  DiffRequest commitDiffRequest(FileChange f, String hash, String? parent,
      {String? titleSuffix}) {
    final short = shortRef(hash);
    final pShort = parent == null ? '' : shortRef(parent);
    final Revision left = parent == null ||
            f.type == ChangeType.added ||
            f.type == ChangeType.untracked
        ? const EmptyRev()
        : CommitRev(parent);
    final Revision right =
        f.type == ChangeType.deleted ? const EmptyRev() : CommitRev(hash);
    return DiffRequest(
      title: '${f.fileName} ${titleSuffix ?? '($short)'}',
      leftPath: f.oldPath ?? f.path,
      rightPath: f.path,
      left: left,
      right: right,
      leftTitle: left is EmptyRev ? '(does not exist)' : pShort,
      rightTitle: right is EmptyRev ? '(deleted)' : short,
    );
  }

  static final _fullHash = RegExp(r'^[0-9a-f]{40}');

  /// Abbreviates full commit hashes, keeps symbolic refs.
  static String shortRef(String ref) => _fullHash.hasMatch(ref)
      ? ref.substring(0, 8) + ref.substring(40)
      : ref;

  // ---------------------------------------------------------------------------
  // Console
  // ---------------------------------------------------------------------------

  void _addConsole(ConsoleEntry e) {
    if (_disposed) return;
    final list = [...console.value, e];
    console.value =
        list.length > 5000 ? list.sublist(list.length - 5000) : list;
  }

  void clearConsole() => console.value = const [];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  Branch? get currentBranch =>
      branches.value.where((b) => b.isCurrent).firstOrNull;

  /// Default remote for push / pull.
  String? get defaultRemote {
    final up = status.value.upstream;
    if (up != null && up.contains('/')) return up.substring(0, up.indexOf('/'));
    final r = remotes.value;
    if (r.isEmpty) return null;
    return r.any((e) => e.name == 'origin') ? 'origin' : r.first.name;
  }
}
