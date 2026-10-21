import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:path/path.dart' as p;

import '../../domain/entities/bisect.dart';
import '../../domain/entities/clean.dart';
import '../../domain/entities/console_entry.dart';
import '../../domain/entities/git_models.dart';
import '../../domain/entities/log_query.dart';
import '../../domain/entities/merge.dart';
import '../../domain/entities/patch.dart';
import '../../domain/entities/rebase.dart';
import '../../domain/entities/reflog.dart';
import '../../domain/entities/shelf.dart';
import '../../domain/entities/worktree.dart';
import '../../domain/errors.dart';
import '../../domain/logic/graph_layout.dart';
import '../../domain/logic/line_selection.dart';
import '../../domain/logic/log_filters.dart';
import '../../domain/logic/shelf_format.dart';
import '../../domain/repositories/commit_message_generator.dart';
import '../../domain/repositories/git_repository.dart';
import '../../domain/repositories/git_service.dart';
import '../../domain/repositories/shelf_repository.dart';
import '../../domain/usecases/bisect.dart';
import '../../domain/usecases/clean_working_tree.dart';
import '../../domain/usecases/commit_changes.dart';
import '../../domain/usecases/compare_commits.dart';
import '../../domain/usecases/generate_commit_message.dart';
import '../../domain/usecases/get_selected_line_contents.dart';
import '../../domain/usecases/interactive_rebase.dart';
import '../../domain/usecases/merge_branch.dart';
import '../../domain/usecases/patches.dart';
import '../../domain/usecases/shelve_changes.dart';
import 'app_settings.dart';
import 'log_filter.dart';

export 'log_filter.dart';

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

/// Comparison of two commits of the log, with the diff of its files.
class CompareTab extends EditorTab {
  CompareTab(this.a, this.b);

  /// The two commits in any order (the view puts the older one left).
  final Commit a;
  final Commit b;

  @override
  String get key => 'compare:${([a.hash, b.hash]..sort()).join('..')}';
  @override
  String get title {
    final (left, right) = CompareCommits.olderFirst(a, b);
    return '${left.shortHash} ↔ ${right.shortHash}';
  }
}

/// User / date filters of the log chosen in this session, by repository
/// root. Not saved across restarts.
final _sessionLogFilters = <String, (AuthorFilter?, DateFilter)>{};

/// Options last used in the Merge dialog (without the message), kept for
/// the session.
MergeOptions _sessionMergeOptions = const MergeOptions();

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
    compareCommits = CompareCommits(repo);
    shelfStore = git.shelves(repo);
    _shelve = ShelveChanges(repo, shelfStore);
    _unshelve = UnshelveChanges(repo, shelfStore);
    _createPatch = CreatePatch(repo);
    _applyPatch = ApplyPatch(repo);
    _merge = MergeBranch(repo);
    _clean = CleanWorkingTree(repo);
    _bisect = BisectCommits(repo);
    final session = _sessionLogFilters[repo.root];
    if (session != null) logFilter.value = LogFilter(author: session.$1, date: session.$2);
    bottomTab.addListener(_onBottomTab);
  }

  late final GitRepository repo;
  late final CommitChanges _commitChanges;
  late final GenerateCommitMessage _generateMessage;
  late final GetSelectedLineContents _selectedContents;
  late final InteractiveRebase _rebase;
  late final CompareCommits compareCommits;
  late final ShelfRepository shelfStore;
  late final ShelveChanges _shelve;
  late final UnshelveChanges _unshelve;
  late final CreatePatch _createPatch;
  late final ApplyPatch _applyPatch;
  late final MergeBranch _merge;
  late final CleanWorkingTree _clean;
  late final BisectCommits _bisect;

  final status = ValueNotifier<RepoStatus>(const RepoStatus());

  /// Position of the rebase in progress (null when not rebasing).
  final rebaseProgress = ValueNotifier<RebaseProgress?>(null);
  final branches = ValueNotifier<List<Branch>>(const []);
  final tags = ValueNotifier<List<Tag>>(const []);
  final remotes = ValueNotifier<List<Remote>>(const []);
  final stashes = ValueNotifier<List<Stash>>(const []);
  final submodules = ValueNotifier<List<Submodule>>(const []);

  /// Working trees of the repository, the main one first.
  final worktrees = ValueNotifier<List<Worktree>>(const []);

  /// Bisect session in progress, or null.
  final bisect = ValueNotifier<BisectState?>(null);

  /// Set to a repository path the workspace should open (e.g. a submodule).
  final openRepoRequest = ValueNotifier<String?>(null);
  final commits = ValueNotifier<List<Commit>>(const []);
  final graph = ValueNotifier<List<GraphRow>>(const []);
  final logFilter = ValueNotifier<LogFilter>(const LogFilter());
  final logLoading = ValueNotifier<bool>(false);
  final selectedCommit = ValueNotifier<Commit?>(null);

  /// Authors of the loaded commits for the "User" filter, most commits
  /// first (kept while an author filter is active).
  final logAuthors = ValueNotifier<List<LogAuthor>>(const []);

  /// Hash the commit table should scroll to (set by "Show in Log").
  final revealCommit = ValueNotifier<String?>(null);

  /// Selected commit that is not in the loaded log (e.g. from the reflog);
  /// kept when the log reloads.
  String? _outsideSelection;

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
    bottomTab.removeListener(_onBottomTab);
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
      refreshShelves(),
    ]);
    _checkSubmodulesAfterHeadChange(headBefore);
    await Future.wait([
      refreshLog(),
      if (_reflogShown) refreshReflog(),
    ]);
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

  /// Asks the workspace to open the repository at the absolute [path] (e.g.
  /// another worktree).
  void openRepo(String path) => openRepoRequest.value = p.normalize(path);

  Future<void> refreshStatus() async {
    try {
      final s = await repo.status();
      if (_disposed) return;
      final previous = status.value.state;
      status.value = s;
      _recomputeIncluded();
      if (s.state == RepoState.rebasing || s.state == RepoState.applyingMailbox) {
        final progress = await repo.rebaseProgress();
        if (!_disposed) rebaseProgress.value = progress;
      } else {
        rebaseProgress.value = null;
        // The rebase may have ended outside this tool (e.g. in a terminal).
        if (busy.value == null) await repo.cleanupRebaseState();
      }
      final bisecting = await repo.bisectState();
      if (!_disposed) bisect.value = bisecting;
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
        repo.worktrees().catchError((Object e) {
          _addConsole(ConsoleEntry('worktrees failed: $e', ConsoleKind.error));
          return const <Worktree>[];
        }),
      ]);
      if (_disposed) return;
      branches.value = results[0] as List<Branch>;
      tags.value = results[1] as List<Tag>;
      remotes.value = results[2] as List<Remote>;
      stashes.value = results[3] as List<Stash>;
      submodules.value = results[4] as List<Submodule>;
      worktrees.value = results[5] as List<Worktree>;
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
        query: f.query(DateTime.now()),
      );
      if (_disposed || gen != _logGen) return;
      commits.value = list;
      graph.value = f.filtersHistory ? const [] : layoutGraph(list);
      if (f.author == null || logAuthors.value.isEmpty) logAuthors.value = authorsByCount(list);
      final sel = selectedCommit.value;
      if (sel != null && sel.hash != _outsideSelection) {
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
    if (old.author != f.author || old.date != f.date) {
      _sessionLogFilters[root] = (f.author, f.date);
    }
    if (f.loadsDifferently(old)) refreshLog();
  }

  /// Clears every filter of the log.
  void resetLogFilters() => setLogFilter(const LogFilter());

  /// `user.name` and `user.email` for the "Me" author filter.
  Future<AuthorFilter?> currentUserFilter() async {
    final name = await repo.config('user.name');
    final email = await repo.config('user.email');
    final patterns = [?name, ?email];
    return patterns.isEmpty ? null : AuthorFilter('Me', patterns);
  }

  /// Selects [hash] in the Log and scrolls to it. A commit that is not in
  /// the loaded log (e.g. unreachable) is selected anyway, so its details
  /// and files are shown.
  Future<void> showInLog(String hash) async {
    bottomTab.value = 0;
    final loaded = commits.value.where((c) => c.hash == hash).firstOrNull;
    final c = loaded ?? await repo.findCommit(hash);
    if (_disposed) return;
    if (c == null) {
      notify(AppNotification('Commit not found', details: hash, isError: true));
      return;
    }
    _outsideSelection = loaded == null ? c.hash : null;
    selectedCommit.value = c;
    revealCommit.value = null;
    revealCommit.value = c.hash;
  }

  void selectCommit(Commit? c) {
    _outsideSelection = null;
    selectedCommit.value = c;
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
    } on ShelfRejected catch (e) {
      notify(AppNotification(e.title, details: e.details, isError: true));
      return false;
    } on PatchRejected catch (e) {
      notify(AppNotification(e.title, details: e.details, isError: true));
      return false;
    } on MergeRejected catch (e) {
      notify(AppNotification(e.title, details: e.details, isError: true));
      return false;
    } on CleanRejected catch (e) {
      notify(AppNotification(e.title, details: e.details, isError: true));
      return false;
    } on BisectRejected catch (e) {
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
  // Reflog
  // ---------------------------------------------------------------------------

  /// Index of the Reflog tab of the Git tool window.
  static const reflogTab = 3;

  final reflog = ValueNotifier<List<ReflogEntry>>(const []);

  /// Reflog shown: null for HEAD, else `refs/heads/<branch>`.
  final reflogRef = ValueNotifier<String?>(null);
  final reflogLoading = ValueNotifier<bool>(false);

  /// Loaded once the tab was opened, then refreshed with the rest.
  bool _reflogShown = false;
  int _reflogGen = 0;

  void showReflog() => bottomTab.value = reflogTab;

  void _onBottomTab() {
    if (bottomTab.value == reflogTab && !_reflogShown) {
      _reflogShown = true;
      refreshReflog();
    }
  }

  void setReflogRef(String? ref) {
    reflogRef.value = ref;
    refreshReflog();
  }

  Future<void> refreshReflog() async {
    final gen = ++_reflogGen;
    reflogLoading.value = true;
    try {
      final list = await repo.reflog(ref: reflogRef.value ?? 'HEAD');
      if (_disposed || gen != _reflogGen) return;
      reflog.value = list;
    } catch (e) {
      _addConsole(ConsoleEntry('reflog failed: $e', ConsoleKind.error));
    } finally {
      if (gen == _reflogGen && !_disposed) reflogLoading.value = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Compare commits
  // ---------------------------------------------------------------------------

  void openCompare(Commit a, Commit b) => openTab(CompareTab(a, b));

  // ---------------------------------------------------------------------------
  // Shelf
  // ---------------------------------------------------------------------------

  /// Index of the Shelf tab of the Git tool window.
  static const shelfTab = 4;

  final shelves = ValueNotifier<List<Shelf>>(const []);

  void showShelf() => bottomTab.value = shelfTab;

  Future<void> refreshShelves() async {
    try {
      final list = await shelfStore.list();
      if (!_disposed) shelves.value = list;
    } catch (e) {
      _addConsole(ConsoleEntry('shelf failed: $e', ConsoleKind.error));
    }
  }

  /// Name proposed for a new shelf: the commit message or the date.
  String get newShelfName => defaultShelfName(commitMessage.text, DateTime.now());

  /// Shelves [changes] and, unless [keep], reverts them to HEAD. Returns
  /// false when it failed.
  Future<bool> shelveChanges(String name, List<FileChange> changes, {bool keep = false}) async {
    ShelveOutcome? out;
    final ok = await run('Shelve changes',
        () async => out = await _shelve(name: name, changes: changes, keep: keep));
    final o = out;
    if (!ok || o == null) return false;
    final n = o.shelf.files.length;
    notify(AppNotification(
      '$n file${n == 1 ? '' : 's'} shelved to "${o.shelf.name}"',
      details: o.skipped.isNotEmpty
          ? 'Not shelved (submodules / conflicts): ${o.skipped.join(', ')}'
          : keep
              ? 'The changes were kept in the working tree.'
              : null,
      actionLabel: 'Show Shelf',
      onAction: showShelf,
    ));
    return true;
  }

  /// Applies the files of [shelf] in [paths] (all when null) to the working
  /// tree. With [removeApplied] the cleanly applied files leave the shelf.
  Future<bool> unshelve(Shelf shelf, {List<String>? paths, bool removeApplied = true}) async {
    UnshelveOutcome? out;
    final label = removeApplied ? 'Unshelve "${shelf.name}"' : 'Apply "${shelf.name}"';
    final ok = await run(label,
        () async => out = await _unshelve(shelf, paths: paths, removeApplied: removeApplied));
    final o = out;
    if (!ok || o == null) return false;
    final n = o.applied.length;
    if (o.conflicted.isEmpty) {
      notify(AppNotification('$n file${n == 1 ? '' : 's'} ${removeApplied ? 'unshelved' : 'applied'}'));
    } else {
      notify(AppNotification(
        '${o.conflicted.length} file${o.conflicted.length == 1 ? '' : 's'} unshelved with conflicts',
        details: '${o.conflicted.map((f) => f.path).take(5).join(', ')}\n'
            'Resolve them in the Commit panel; they stay in the shelf.',
        isError: true,
      ));
    }
    return true;
  }

  Future<void> renameShelf(Shelf shelf, String name) async {
    await run('Rename shelf', () => shelfStore.update(shelf, name: name.trim()), refresh: false);
    await refreshShelves();
  }

  Future<void> deleteShelf(Shelf shelf) async {
    await run('Delete shelf "${shelf.name}"', () => shelfStore.delete(shelf),
        success: 'Shelf "${shelf.name}" deleted', refresh: false);
    await refreshShelves();
  }

  /// Content of the patch of [shelf].
  Future<List<int>> shelfPatch(Shelf shelf) => shelfStore.patch(shelf);

  /// Diff of a shelved file: base commit ↔ shelved content (read-only).
  Future<void> showShelfDiff(Shelf shelf, ShelvedFile f, {bool preview = false}) async {
    final patch = await shelfStore.patchPath(shelf);
    if (!_disposed) openTab(DiffTab(shelfDiffRequest(shelf, f, patch)), preview: preview);
  }

  DiffRequest shelfDiffRequest(Shelf shelf, ShelvedFile f, String patchPath) {
    final Revision left = f.status == ShelfFileStatus.added ? const EmptyRev() : CommitRev(shelf.base);
    final Revision right = f.status == ShelfFileStatus.deleted ? const EmptyRev() : PatchedRev(shelf.base, patchPath);
    return DiffRequest(
      title: '${f.fileName} (shelved)',
      leftPath: f.oldPath ?? f.path,
      rightPath: f.path,
      left: left,
      right: right,
      leftTitle: left is EmptyRev ? '(does not exist)' : shelf.shortBase,
      rightTitle: right is EmptyRev ? '(deleted)' : 'Shelved: ${shelf.name}',
    );
  }

  // ---------------------------------------------------------------------------
  // Patches
  // ---------------------------------------------------------------------------

  /// Patch of [changes] relative to HEAD, or null (with a notification).
  Future<List<int>?> createPatch(List<FileChange> changes) async {
    List<int>? patch;
    await run('Create patch', () async => patch = await _createPatch.fromChanges(status.value, changes),
        refresh: false);
    return patch;
  }

  /// [commits] as one mailbox, oldest first, or null (with a notification).
  Future<List<int>?> createPatchFromCommits(List<Commit> commits) async {
    List<int>? patch;
    await run('Create patch', () async => patch = await _createPatch.fromCommits(commits), refresh: false);
    return patch;
  }

  /// Files of [patch] and whether it applies, or null (with a notification)
  /// when it cannot be read.
  Future<PatchPreview?> previewPatch(List<int> patch) async {
    PatchPreview? preview;
    await run('Read patch', () async => preview = await _applyPatch.preview(patch), refresh: false);
    return preview;
  }

  /// Applies [patch] to the working tree, or as commits (`git am`). Returns
  /// false when it failed.
  Future<bool> applyPatch(List<int> patch, {bool asCommits = false}) async {
    ({bool stopped, List<String> conflicts})? out;
    final ok = await run(asCommits ? 'Apply patch as commits' : 'Apply patch',
        () async => out = await _applyPatch(patch, asCommits: asCommits));
    final o = out;
    if (!ok || o == null) return false;
    if (o.stopped) {
      notify(AppNotification('Applying patches stopped',
          details: o.conflicts.isEmpty
              ? 'A patch does not apply. Skip it or Abort in the Commit panel.'
              : 'Resolve the conflicts, then click Continue in the Commit panel (or Skip / Abort).',
          isError: true));
    } else if (o.conflicts.isNotEmpty) {
      notify(AppNotification('Patch applied with conflicts',
          details: '${o.conflicts.take(5).join(', ')}\nResolve them in the Commit panel.', isError: true));
    } else {
      notify(AppNotification(asCommits ? 'Patches applied as commits' : 'Patch applied'));
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Merge
  // ---------------------------------------------------------------------------

  /// Options last used in the Merge dialog this session (no message).
  MergeOptions get lastMergeOptions => _sessionMergeOptions;

  /// Commits [ref] would bring and whether it is a fast-forward, or null
  /// when it cannot be computed.
  Future<MergePreview?> mergePreview(String ref) async {
    try {
      return await _merge.preview(ref);
    } catch (e) {
      _addConsole(ConsoleEntry('merge preview failed: $e', ConsoleKind.error));
      return null;
    }
  }

  /// Merges [ref] (shown as [label]) into the current branch. A squash
  /// merge leaves the changes staged and fills the commit message with
  /// git's SQUASH_MSG. Returns false when it failed.
  Future<bool> merge(String ref, MergeOptions options, {String? label}) async {
    _sessionMergeOptions = options.withMessage(null);
    final name = label ?? ref;
    final into = status.value.branch ?? 'HEAD';
    MergeOutcome? out;
    final ok = await run('Merge $name into $into', () async => out = await _merge(ref, options));
    final o = out;
    if (!ok || o == null) return false;
    if (options.squash) {
      final msg = o.squashMessage;
      if (msg != null && (commitMessage.text.trim().isEmpty || commitMessage.text == _prefilledMessage)) {
        commitMessage.text = msg;
        _prefilledMessage = msg;
      }
      notify(AppNotification('Squashed $name into the index',
          details: 'Review the changes and commit them in the Commit panel to finish the squash merge.'));
    } else if (status.value.conflicts.isNotEmpty) {
      notify(AppNotification('Conflicts need to be resolved',
          details: '${status.value.conflicts.length} file(s) have conflicts. Open the Commit panel and click "Resolve".',
          isError: true));
    } else if (o.stopped) {
      notify(AppNotification('Merge of $name prepared',
          details: 'The merge was not committed. Review the result and commit it in the Commit panel.'));
    } else {
      notify(AppNotification('Merged $name into $into'));
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Clean
  // ---------------------------------------------------------------------------

  /// What `git clean` would remove with [options].
  Future<List<CleanEntry>> cleanPreview(CleanOptions options) => _clean.preview(options);

  /// Removes [entries] for good. Returns false when it failed.
  Future<bool> clean(List<CleanEntry> entries, CleanOptions options) async {
    var n = 0;
    final ok = await run('Clean working tree', () async => n = await _clean(entries, options));
    if (ok) notify(AppNotification('Removed $n untracked item${n == 1 ? '' : 's'}'));
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Worktrees
  // ---------------------------------------------------------------------------

  Future<bool> addWorktree(String path, WorktreeCheckout checkout) => run(
        'Add worktree',
        () => repo.addWorktree(path, checkout),
        success: 'Worktree created at $path',
      );

  Future<bool> lockWorktree(Worktree w, {String? reason}) =>
      run('Lock worktree', () => repo.lockWorktree(w.path, reason: reason), success: 'Worktree ${w.name} locked');

  Future<bool> unlockWorktree(Worktree w) =>
      run('Unlock worktree', () => repo.unlockWorktree(w.path), success: 'Worktree ${w.name} unlocked');

  Future<bool> pruneWorktrees() =>
      run('Prune worktrees', () => repo.pruneWorktrees(), success: 'Stale worktrees pruned');

  // ---------------------------------------------------------------------------
  // Bisect
  // ---------------------------------------------------------------------------

  /// Marks [commit] (the commit under test when null) good, bad or skipped,
  /// starting a session if none is in progress.
  Future<bool> bisectMark(BisectMark mark, {Commit? commit}) async {
    BisectStep? step;
    final what = commit == null ? 'current commit' : commit.shortHash;
    final ok = await run('Bisect: mark $what ${mark.name}',
        () async => step = await _bisect.mark(mark, rev: commit?.hash));
    _reportBisect(step);
    return ok;
  }

  /// `git bisect run <command>`; its output goes to the console.
  Future<bool> bisectRun(String command) async {
    BisectStep? step;
    final ok = await run('Bisect run', () async => step = await _bisect.run(command));
    _reportBisect(step);
    return ok;
  }

  Future<bool> bisectReset() =>
      run('Reset bisect', _bisect.reset, success: 'Bisect finished, back to the original branch');

  void _reportBisect(BisectStep? step) {
    final bad = step?.firstBad;
    if (bad == null) return;
    final short = shortRef(bad);
    final subject = bisect.value?.log.firstBadSubject;
    notify(AppNotification(
      '$short is the first bad commit',
      details: '${subject == null || subject.isEmpty ? '' : '$subject\n'}'
          'The session stays open until you click Reset in the Commit panel.',
      actionLabel: 'Show in Log',
      onAction: () => showInLog(bad),
    ));
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
