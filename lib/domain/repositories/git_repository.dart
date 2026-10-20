import '../entities/git_models.dart';
import '../entities/rebase.dart';

/// A change noticed in the repository folder.
enum RepoEvent {
  /// Working tree files or the index changed.
  status,

  /// Branches, tags, HEAD or the state of an operation changed.
  refs,
}

/// Git operations on one repository. Implemented by the data layer; the
/// rest of the app only depends on this interface.
abstract interface class GitRepository {
  /// Top level directory of the work tree.
  String get root;
  String get name;

  /// Absolute path of the `.git` directory.
  Future<String> gitDir();

  /// Changes in the repository folder, for automatic refresh.
  Stream<RepoEvent> watch();

  /// Runs a git command typed by the user, logging it to the console.
  Future<String> runCommand(List<String> args);

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  Future<RepoStatus> status();
  Future<RepoState> repoState();

  /// Prepared commit message during merge / cherry-pick / revert.
  Future<String?> pendingMergeMessage();

  // ---------------------------------------------------------------------------
  // Log
  // ---------------------------------------------------------------------------

  /// Loads commits for the log. [revisions] defaults to all refs.
  Future<List<Commit>> log({List<String>? revisions, String? path, int limit = 3000});

  /// Commits reachable from [to] but not from [from].
  Future<List<Commit>> commitsBetween(String from, String to);

  /// Commits of [ref] that are not on [remoteRef], or not on any branch of
  /// [remote] when [remoteRef] is null (new branch).
  Future<List<Commit>> outgoingCommits(String ref, {String? remoteRef, required String remote});

  Future<bool> refExists(String ref);
  Future<CommitDetails> commitDetails(Commit c);

  /// Branches (local and remote) that contain the commit.
  Future<List<String>> branchesContaining(String hash);

  /// Files changed between two revisions. A null [from] means the empty tree.
  Future<List<FileChange>> changedFiles(String? from, String to);

  /// Files that differ between two refs using merge base (`a...b`).
  Future<List<FileChange>> diffFilesSymmetric(String a, String b);

  Future<List<String>> recentSubjects({int count = 15});
  Future<String> lastCommitMessage();

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------

  Future<List<Branch>> branches();
  Future<List<Tag>> tags();
  Future<List<Remote>> remotes();
  Future<List<Stash>> stashes();
  Future<List<FileChange>> stashFiles(Stash s);

  // ---------------------------------------------------------------------------
  // File content
  // ---------------------------------------------------------------------------

  /// Raw bytes of [path] at [rev]. Returns null if the file does not exist.
  Future<List<int>?> fileBytes(Revision rev, String path);

  /// Diff of one tracked file: HEAD → working tree.
  Future<String> fileDiff(String path);

  /// Unified diff of [changes] against [base] (working tree side), one entry
  /// per file. Without a base every file is rendered as a whole-file addition.
  Future<Map<String, String>> diffPerFile(List<FileChange> changes, {String? base});

  Future<List<BlameLine>> blame(String path);

  // ---------------------------------------------------------------------------
  // Submodules
  // ---------------------------------------------------------------------------

  bool get hasGitmodules;

  /// Submodules declared in `.gitmodules` with their state.
  Future<List<Submodule>> submodules();

  /// URL of `origin` in the repository nested at [path], or empty.
  Future<String> nestedOriginUrl(String path);

  /// Registers an existing nested repository as a submodule.
  Future<void> registerSubmodule(String path, String url);

  /// Checks out the recorded commit of the submodules (all when [paths] is
  /// empty), initializing them first.
  Future<void> updateSubmodules({List<String> paths = const [], bool recursive = true});
  Future<void> syncSubmodules({List<String> paths = const []});
  Future<void> addSubmodule(String url, String path);

  // ---------------------------------------------------------------------------
  // Commit / changes
  // ---------------------------------------------------------------------------

  /// Commits [paths] as they are in the working tree.
  Future<void> commit({
    required String message,
    required List<String> paths,
    bool amend = false,
    bool signOff = false,
    String? author,
    bool partial = true,
  });

  /// Commits [fullPaths] as in the working tree and, for [partial], the
  /// exact content given per path, leaving the rest as local changes.
  Future<void> commitSelected({
    required String message,
    required List<String> fullPaths,
    required Map<String, String> partial,
    bool amend = false,
    bool signOff = false,
    String? author,
  });

  Future<void> stage(List<String> paths);

  /// Reverts tracked changes to HEAD (Android Studio "Rollback").
  Future<void> rollback(List<FileChange> changes, {bool deleteAdded = false, required bool hasHead});
  Future<void> deleteFiles(List<String> paths);
  Future<void> addToGitignore(List<String> patterns);

  /// Restores [path] as it is in commit [hash].
  Future<void> checkoutFile(String hash, String path);

  // ---------------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------------

  Future<void> checkout(String ref);
  Future<void> checkoutRemote(Branch remote, {String? localName});

  /// Creates [name] at [startPoint] without an upstream.
  Future<void> createBranch(String name,
      {String? startPoint, bool checkout = true, bool force = false, bool fromRemote = false});
  Future<void> renameBranch(String oldName, String newName);
  Future<void> deleteBranch(String name, {bool force = false});
  Future<void> deleteRemoteBranch(Branch b);
  Future<void> merge(String ref, {bool noFf = false, bool squash = false});
  Future<void> rebase(String onto, {String? branch});
  Future<void> abortOperation(RepoState state);
  Future<void> continueOperation(RepoState state);
  Future<void> skipRebaseCommit();

  // ---------------------------------------------------------------------------
  // Remote operations
  // ---------------------------------------------------------------------------

  Future<void> fetch({String? remote, bool prune = true});

  /// Fetches [remoteBranch] of [remote] directly into [localBranch]
  /// (fast-forward only).
  Future<void> fetchInto(String remote, String remoteBranch, String localBranch);
  Future<void> pull({required String remote, required String branch, bool rebase = false, bool ffOnly = false});
  Future<void> push({
    required String remote,
    required String localRef,
    required String remoteBranch,
    bool force = false,
    bool setUpstream = false,
    bool tags = false,
  });
  Future<void> pushTag(String remote, String tag);
  Future<void> addRemote(String name, String url);
  Future<void> removeRemote(String name);
  Future<void> setRemoteUrl(String name, String url);

  // ---------------------------------------------------------------------------
  // Commit operations
  // ---------------------------------------------------------------------------

  Future<void> cherryPick(Commit c);
  Future<void> revert(Commit c);
  Future<void> reset(String hash, ResetMode mode);
  Future<void> undoLastCommit();
  Future<void> rewordHead(String message);
  Future<void> createTag(String name, String hash, {String? message});
  Future<void> deleteTag(String name);

  // ---------------------------------------------------------------------------
  // Interactive rebase
  // ---------------------------------------------------------------------------

  /// Whether [ancestor] is an ancestor of (or equal to) [descendant].
  Future<bool> isAncestor(String ancestor, String descendant);

  /// Commits of `base..HEAD` (all of HEAD when [base] is null), newest
  /// first, with their full message.
  Future<List<({Commit commit, String message})>> rebaseRange(String? base);

  /// Whether `base..HEAD` contains merge commits.
  Future<bool> rangeHasMerges(String? base);

  /// Number of commits of `base..HEAD` reachable from the upstream of the
  /// current branch (0 without upstream).
  Future<int> pushedCount(String? base);

  /// Directory where the todo and message files are kept
  /// (`git rev-parse --git-path git-tools-rebase`), with forward slashes.
  Future<String> rebaseStateDir();

  /// Lets `git rebase -i` write its todo for `base..HEAD` (from the root when
  /// [base] is null) and returns it, leaving the repository untouched.
  Future<String> generateRebaseTodo(String? base, {bool rebaseMerges = false});

  /// Writes [todo] and [messages] to the state directory and runs
  /// `git rebase -i --autostash` with it.
  Future<RebaseOutcome> runRebaseTodo(
    String? base, {
    required String todo,
    required Map<String, String> messages,
    bool rebaseMerges = false,
  });

  /// Position of the rebase in progress, or null.
  Future<RebaseProgress?> rebaseProgress();

  /// Deletes the state directory when no rebase is in progress.
  Future<void> cleanupRebaseState();

  // ---------------------------------------------------------------------------
  // Stash
  // ---------------------------------------------------------------------------

  Future<void> stash({String? message, bool includeUntracked = false, bool keepIndex = false});
  Future<void> stashApply(Stash s, {bool pop = false, bool index = false});

  /// Pops the most recent stash.
  Future<void> stashPop();
  Future<void> stashDrop(Stash s);
  Future<void> stashClear();
  Future<void> stashBranch(Stash s, String branch);

  // ---------------------------------------------------------------------------
  // Conflicts
  // ---------------------------------------------------------------------------

  /// Content of one conflict stage (1 = base, 2 = ours, 3 = theirs).
  Future<String?> conflictStage(String path, int stage);
  Future<void> acceptSide(FileChange c, {required bool ours});

  /// Re-creates the conflicted content of [path] from the index stages.
  Future<String> mergeFromStages(String path);
  Future<void> markResolved(String path, String content);

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  Future<String?> config(String key);
  Future<void> setConfig(String key, String value, {bool global = false});
}
