import '../entities/bisect.dart';
import '../entities/clean.dart';
import '../entities/git_models.dart';
import '../entities/lfs.dart';
import '../entities/log_query.dart';
import '../entities/merge.dart';
import '../entities/patch.dart';
import '../entities/rebase.dart';
import '../entities/reflog.dart';
import '../entities/signing.dart';
import '../entities/worktree.dart';

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

  /// Absolute `git rev-parse --git-path` of [name] (per worktree).
  Future<String> gitPath(String name);

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

  /// Loads commits for the log. [revisions] defaults to all refs; [query]
  /// filters by author, date and content change.
  Future<List<Commit>> log({
    List<String>? revisions,
    String? path,
    int limit = 3000,
    LogQuery query = const LogQuery(),
  });

  /// One commit (any revision), or null when it does not exist.
  Future<Commit?> findCommit(String rev);

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

  /// Files that differ between two revisions (`git diff -M a b`), with
  /// rename detection.
  Future<List<FileChange>> diffFiles(String a, String b);

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

  /// Entries of the reflog of [ref] (`HEAD` or `refs/heads/<branch>`),
  /// newest first, including the ones whose commit is gone.
  Future<List<ReflogEntry>> reflog({String ref = 'HEAD', int limit = 500});

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

  /// Commits [paths] as they are in the working tree. [sign] true passes
  /// `-S`, false `--no-gpg-sign`, null leaves it to `commit.gpgsign`.
  Future<void> commit({
    required String message,
    required List<String> paths,
    bool amend = false,
    bool signOff = false,
    String? author,
    bool partial = true,
    bool? sign,
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
    bool? sign,
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
  Future<void> merge(String ref, {MergeOptions options = const MergeOptions()});

  /// Number of commits reachable from [to] but not from [from].
  Future<int> countCommits(String from, String to);

  /// First lines of `SQUASH_MSG` (left by `git merge --squash`) without
  /// comments, or null.
  Future<String?> squashMessage({int maxLines = 30});

  /// [sign]: `--gpg-sign` / `--no-gpg-sign` for the rewritten commits.
  Future<void> rebase(String onto, {String? branch, bool? sign});
  Future<void> abortOperation(RepoState state);

  /// Concludes the operation in progress. [sign] (`-S` / `--no-gpg-sign`)
  /// applies to the merge commit; the other operations keep the choice they
  /// were started with (or `commit.gpgsign`).
  Future<void> continueOperation(RepoState state, {bool? sign});
  Future<void> skipRebaseCommit();

  /// Skips the patch `git am` stopped on.
  Future<void> skipMailboxPatch();

  // ---------------------------------------------------------------------------
  // Clean
  // ---------------------------------------------------------------------------

  /// Pathspecs `git clean -n` lists with [options] (directories end with
  /// `/`). [nested] passes `-ff` so repositories nested in the work tree are
  /// listed too.
  Future<List<String>> cleanDryRun(CleanOptions options, {bool nested = false});

  /// Removes exactly [pathspecs] (relative, directories ending with `/`)
  /// with `git clean -f`, `-ff` when [nested]. Tracked files are never
  /// touched.
  Future<void> clean(List<String> pathspecs, CleanOptions options, {bool nested = false});

  // ---------------------------------------------------------------------------
  // Worktrees
  // ---------------------------------------------------------------------------

  /// Working trees of the repository, the main one first.
  Future<List<Worktree>> worktrees();

  /// `git worktree add` at [path] (absolute, or relative to [root]).
  Future<void> addWorktree(String path, WorktreeCheckout checkout);
  Future<void> lockWorktree(String path, {String? reason});
  Future<void> unlockWorktree(String path);

  /// `git worktree remove`; [force] also removes local changes.
  Future<void> removeWorktree(String path, {bool force = false});

  /// `git worktree prune -v` (with [dryRun], `-n`): what was (or would be)
  /// removed, one line per worktree.
  Future<String> pruneWorktrees({bool dryRun = false});

  // ---------------------------------------------------------------------------
  // Bisect
  // ---------------------------------------------------------------------------

  /// The bisect session in progress, or null.
  Future<BisectState?> bisectState();
  Future<void> bisectStart();

  /// Marks [rev] (HEAD when null) and returns what git printed (it names the
  /// first bad commit once found).
  Future<String> bisectMark(BisectMark mark, {String? rev});

  /// Ends the session and checks out the branch it started from.
  Future<void> bisectReset();

  /// `git bisect run <command>` (run through git's shell); returns its
  /// output.
  Future<String> bisectRun(String command);

  // ---------------------------------------------------------------------------
  // Remote operations
  // ---------------------------------------------------------------------------

  Future<void> fetch({String? remote, bool prune = true});

  /// Fetches [remoteBranch] of [remote] directly into [localBranch]
  /// (fast-forward only).
  Future<void> fetchInto(String remote, String remoteBranch, String localBranch);

  /// Fetches [branch] of [remote] into its remote-tracking branch.
  Future<void> fetchBranch(String remote, String branch);

  /// Checks the local branch [name] out again from [ref], tracking it, as if
  /// deleted and recreated (`git checkout -B`): its commits not on [ref] are
  /// dropped. The working tree must be clean.
  Future<void> checkoutFrom(String name, String ref);

  /// The pull of a branch from its upstream that stopped on conflicts: a
  /// merge of the upstream (MERGE_HEAD is its tip) or a rebase of the branch
  /// onto it. Null for any other merge or rebase.
  Future<({String branch, String upstream})?> pullInProgress();
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
  Future<void> rewordHead(String message, {bool? sign});

  /// A [message] makes an annotated tag. [sign] true makes a signed tag
  /// (`-s`, annotated; the name is the message when none is given), false
  /// passes `--no-sign` (overrides `tag.gpgsign`).
  Future<void> createTag(String name, String hash, {String? message, bool? sign});
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
  /// `git rebase -i --autostash` with it ([sign]: `--gpg-sign` /
  /// `--no-gpg-sign` for the picked commits).
  Future<RebaseOutcome> runRebaseTodo(
    String? base, {
    required String todo,
    required Map<String, String> messages,
    bool rebaseMerges = false,
    bool? sign,
  });

  /// Position of the rebase (or `git am`) in progress, or null.
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
  // Patches
  // ---------------------------------------------------------------------------

  /// Absolute path of the git directory shared by all worktrees
  /// (`git rev-parse --git-common-dir`).
  Future<String> commonDir();

  /// `git diff --binary --full-index -M` of [paths] as they are in the work
  /// tree (untracked and deleted files included) relative to [base], with
  /// the files of the patch. Made through a temporary index: the real index
  /// is not touched.
  Future<WorkingTreePatch> diffWorkingTree(String base, List<String> paths);

  /// The selected commits as one mailbox (`git format-patch --stdout`),
  /// in topological order, oldest first. Merge commits are left out.
  Future<List<int>> formatPatch(List<String> hashes);

  /// Output of `git apply --numstat --summary` for [patch].
  Future<String> patchStats(List<int> patch);

  /// Applies [patch] to the working tree with `git apply --3way`. Local
  /// changes of the patched files (staged or not) take part in the 3-way
  /// merge, and a new file that already exists untracked gives an add/add
  /// conflict. The index keeps its entries for the files that apply cleanly
  /// (they are not staged); conflicting files get conflict markers and
  /// unmerged index entries. With [check] nothing is changed. Throws
  /// [GitException] when git refuses the patch (then nothing was changed).
  Future<PatchApplyResult> applyPatch(List<int> patch, {bool check = false});

  /// Applies a mailbox as commits (`git am --3way`). Returns false when it
  /// stopped on a patch (state [RepoState.applyingMailbox]).
  Future<bool> applyMailbox(List<int> patch);

  Future<void> updateRef(String ref, String hash);
  Future<void> deleteRef(String ref);

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

  // ---------------------------------------------------------------------------
  // LFS
  // ---------------------------------------------------------------------------

  /// Whether git-lfs is installed (`git lfs version`); checked once per
  /// process.
  Future<bool> lfsAvailable();

  /// The paths among [paths] whose `filter` attribute is `lfs`
  /// (`git check-attr`), i.e. stored in LFS when committed.
  Future<Set<String>> lfsFilteredPaths(List<String> paths);

  /// Patterns of the attributes files (`git lfs track`).
  Future<List<LfsTrackPattern>> lfsTrackPatterns();

  /// `git lfs track` (edits the root `.gitattributes`); [literal] escapes
  /// glob characters (`--filename`). Sets up the LFS filters of the
  /// repository first when git has none.
  Future<void> lfsTrack(List<String> patterns, {bool literal = false});
  Future<void> lfsUntrack(List<String> patterns);

  /// Files of HEAD stored in LFS (`git lfs ls-files --json`).
  Future<List<LfsFile>> lfsFiles();

  /// Locks of the LFS server, with their owner when the server can tell
  /// which are ours. Throws [GitException] when the remote does not support
  /// locking (or there is no remote).
  Future<List<LfsLock>> lfsLocks();
  Future<void> lfsLock(String path);

  /// [force] removes a lock held by someone else.
  Future<void> lfsUnlock(String path, {bool force = false});
  Future<void> lfsPull();
  Future<void> lfsFetch();

  /// What `git lfs prune` would delete, without deleting it.
  Future<LfsPrunePreview> lfsPruneDryRun();
  Future<void> lfsPrune();

  /// Pointer the LFS clean filter makes of the working tree file [path]
  /// (`git lfs pointer --file`), or null when it does not exist.
  Future<LfsPointer?> lfsPointerOfFile(String path);

  /// Content of the object of [pointer] when it is in the local LFS store,
  /// else null (nothing is downloaded).
  Future<List<int>?> lfsObject(LfsPointer pointer);

  // ---------------------------------------------------------------------------
  // Signing
  // ---------------------------------------------------------------------------

  /// Effective signing configuration (`commit.gpgsign`, `gpg.format`, ...).
  Future<SigningConfig> signingConfig();

  /// Writes [settings] to the repository (`--local`) or user (`--global`)
  /// configuration.
  Future<void> saveSigningSettings(SigningSettings settings, ConfigScope scope);

  /// Secret keys of the gpg git signs with (`gpg.program`, else git's gpg).
  Future<List<GpgKey>> gpgSecretKeys();

  /// Public keys of `~/.ssh/*.pub` and of the ssh agent (`ssh-add -L`).
  Future<List<SshKey>> sshKeys();

  /// Signs a throwaway commit object (`git commit-tree -S`, no ref) with
  /// [format] and [key] (the configuration when null) and verifies it.
  Future<SigningTestResult> testSigning({SigningFormat? format, String? key});

  /// Signature verification (`%G?`) of the commits [hashes]. Slow: gpg or
  /// ssh-keygen runs for every signed commit.
  Future<Map<String, SignatureInfo>> commitSignatures(List<String> hashes);

  /// Signature of the tag [name] (`git verify-tag --raw`).
  Future<SignatureInfo> tagSignature(String name);
}
