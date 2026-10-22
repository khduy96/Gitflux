// @ts-check
'use strict';

/**
 * Contracts the data layer implements. JavaScript has no interfaces, so they
 * are JSDoc types: use cases and views depend on these shapes, and only
 * extension.js knows the concrete classes.
 *
 * @typedef {import('./entities').FileChange} FileChange
 * @typedef {import('./entities').Commit} Commit
 * @typedef {import('./entities').Stash} Stash
 * @typedef {import('./entities').Shelf} Shelf
 * @typedef {import('./entities').ShelfFile} ShelfFile
 *
 * @typedef {(line: string, kind: 'command'|'output'|'error'|'info') => void} GitLog
 *
 * @typedef {object} LogOptions
 * @property {string[]} [revisions] Revisions to walk (all refs when omitted).
 * @property {string} [path] History of one file (follows renames).
 * @property {number} [limit]
 * @property {string[]} [authors] Substrings of the author name or email, case-insensitive, any of them.
 * @property {string} [since] git date, committer date after it.
 * @property {string} [until] git date, committer date before it.
 * @property {import('./logic/history').ContentSearch} [search] Commits whose diff contains the text (-S) or matches the regex (-G).
 *
 * @typedef {object} GitRepository Git operations on one repository.
 * @property {string} root
 * @property {string} name
 * @property {() => Promise<import('./entities').Status>} status
 * @property {() => Promise<string|null>} pendingMergeMessage
 *
 * @property {(o?: LogOptions) => Promise<Commit[]>} log
 * @property {(rev: string) => Promise<Commit|null>} commitInfo One commit, also one no ref reaches.
 * @property {(ref?: string, limit?: number) => Promise<import('./entities').ReflogEntry[]>} reflog Newest first.
 * @property {() => Promise<{name: string, email: string}>} currentUser user.name / user.email ('' when unset).
 * @property {(from: string, to: string) => Promise<Commit[]>} commitsBetween Commits reachable from `to` but not from `from`.
 * @property {(ref: string, remote: string, remoteRef: string|null) => Promise<Commit[]>} outgoing
 * @property {(hash: string) => Promise<string>} commitBody
 * @property {(from: string|null, to: string) => Promise<FileChange[]>} changedFiles Null `from` = empty tree.
 * @property {(hash: string) => Promise<string[]>} branchesContaining
 * @property {(ref: string) => Promise<boolean>} refExists
 * @property {() => Promise<string[]>} recentSubjects
 * @property {() => Promise<string>} lastCommitMessage
 *
 * @property {() => Promise<import('./entities').Branch[]>} branches
 * @property {() => Promise<import('./entities').Tag[]>} tags
 * @property {() => Promise<import('./entities').Remote[]>} remotes
 * @property {() => Promise<Stash[]>} stashes
 * @property {(stash: Stash) => Promise<FileChange[]>} stashFiles
 *
 * @property {(rev: string, rel: string) => Promise<Buffer|null>} show Content at a revision ('' = index).
 * @property {(rev: string, rel: string) => Promise<string|null>} contentAt Text for the diff editor ('WORKTREE', '' = index, commit).
 * @property {(rel: string) => string} workingText Working tree file text ('' when missing).
 * @property {(rel: string) => Promise<string>} fileDiff HEAD → working tree diff of one file.
 * @property {(changes: FileChange[], base: string|null) => Promise<Map<string, string>>} diffPerFile
 *
 * @property {() => boolean} hasGitmodules
 * @property {() => Promise<import('./entities').Submodule[]>} submodules
 * @property {() => Promise<string[]>} nestedRepositories
 * @property {(rel: string) => Promise<string>} nestedOriginUrl URL of `origin` in a nested repository, or ''.
 * @property {(rel: string, url: string) => Promise<any>} registerSubmodule
 * @property {(paths?: string[], recursive?: boolean) => Promise<any>} updateSubmodules
 * @property {(paths?: string[]) => Promise<any>} syncSubmodules
 * @property {(url: string, rel: string) => Promise<any>} addSubmodule
 *
 * @property {(o: {message: string, paths: string[], amend?: boolean, signOff?: boolean, partial?: boolean, sign?: boolean|null}) => Promise<void>} commit
 *   sign: -S / --no-gpg-sign (null: commit.gpgsign decides).
 * @property {(o: {message: string, fullPaths: string[], partial: {path: string, content: string}[], amend?: boolean, signOff?: boolean,
 *   sign?: boolean|null}) => Promise<void>} commitSelected
 * @property {(paths: string[]) => Promise<any>} add Starts tracking files.
 * @property {(paths: string[]) => Promise<any>} untrack Stops tracking files, keeping them on disk.
 * @property {(changes: FileChange[], hasHead: boolean, deleteAdded: boolean) => Promise<void>} rollback
 * @property {(paths: string[]) => void} deleteFiles
 * @property {(patterns: string[]) => void} addToGitignore
 * @property {(hash: string, rel: string) => Promise<any>} checkoutFile
 *
 * @property {(ref: string) => Promise<any>} checkout
 * @property {(localName: string, remoteBranch: string) => Promise<any>} checkoutTracking
 * @property {(name: string, o?: {startPoint?: string, checkout?: boolean, fromRemote?: boolean}) => Promise<void>} createBranch
 * @property {(oldName: string, newName: string) => Promise<any>} renameBranch
 * @property {(name: string, force?: boolean) => Promise<any>} deleteBranch
 * @property {(remote: string, branch: string) => Promise<any>} deleteRemoteBranch
 * @property {(ref: string, o?: import('./entities').MergeOptions) => Promise<any>} merge Default options: --no-edit.
 * @property {(ref: string) => Promise<import('./entities').MergePreview>} mergePreview
 * @property {() => Promise<string|null>} squashMessage SQUASH_MSG left by `merge --squash`, or null.
 * @property {(onto: string, branch?: string) => Promise<any>} rebase
 *
 * @property {(o: import('./entities').CleanOptions) => Promise<import('./entities').CleanEntry[]>} cleanPreview
 *   What `git clean -n` would remove (nested repositories included, flagged).
 * @property {(o: import('./entities').CleanOptions, entries: import('./entities').CleanEntry[]) => Promise<void>} clean
 *   git clean -f of exactly these entries (-ff when one is a nested repository).
 *
 * @property {() => Promise<import('./entities').Worktree[]>} worktrees
 * @property {(o: {path: string, branch?: string, newBranch?: string, startPoint?: string, detach?: boolean}) => Promise<any>} addWorktree
 *   Existing branch, new branch (-b) from startPoint, or detached at startPoint.
 * @property {(path: string, reason?: string) => Promise<any>} lockWorktree
 * @property {(path: string) => Promise<any>} unlockWorktree
 * @property {(path: string, force?: boolean) => Promise<any>} removeWorktree
 * @property {(dryRun: boolean) => Promise<string[]>} pruneWorktrees Lines of `git worktree prune -v` (-n when dryRun).
 * @property {(path: string) => Promise<boolean>} worktreeHasChanges Modified or untracked files in that worktree.
 *
 * @property {() => Promise<import('./entities').BisectState|null>} bisectState Null when no bisect is in progress.
 * @property {(mark: 'good'|'bad'|'skip', rev?: string) => Promise<string>} bisectMark
 *   Starts a session first when none is in progress; returns git's output.
 * @property {() => Promise<any>} bisectReset Back to the branch the session started from.
 * @property {(command: string) => Promise<{code: number, output: string}>} bisectRun git bisect run (output streamed to the log).
 *
 * @property {(rel: string, contents?: string, lines?: {start: number, end: number}) => Promise<import('./entities').Blame>} blame
 *   git blame --porcelain of the committed file, or of `contents` (unsaved editor) with --contents -; `lines` limits it (-L).
 *
 * @property {() => Promise<{name: string|null, hash: string}|null>} previousCheckout
 *   `@{-1}`: the branch checked out before (name null when it was a detached HEAD).
 * @property {(message: string, exclude?: string[]) => Promise<void>} wipCommit
 *   Commits everything (untracked too) but `exclude`, no hooks, no signing.
 * @property {() => Promise<boolean>} headPushed HEAD is already on its upstream.
 * @property {(rel: string, start: number, end: number, limit?: number) => Promise<import('./logic/quickActions').LineHistoryEntry[]>} lineHistory
 *   git log -L of lines start…end (1-based) of the file at HEAD.
 * @property {(base: string) => Promise<string[]>} mergedBranches Local branches merged into `base`.
 * @property {(state: import('./entities').RepoState, sign?: boolean|null) => Promise<any>} continueOperation
 *   sign: -S / --no-gpg-sign for the commit that concludes a merge.
 * @property {(state: import('./entities').RepoState) => Promise<any>} abortOperation
 * @property {() => Promise<any>} skipRebaseCommit
 *
 * @property {() => Promise<string>} rebaseStateDir Folder for the todo and message files (git rev-parse --git-path).
 * @property {() => Promise<void>} cleanupRebaseState
 * @property {() => Promise<string>} commentChar core.commentChar ('#' when unset or auto).
 * @property {(ancestor: string, descendant: string) => Promise<boolean>} isAncestor
 * @property {(hash: string) => Promise<string|null>} parentOf First parent, null for a root commit.
 * @property {(base: string|null) => Promise<import('./entities').RangeCommit[]>} rangeCommits base..HEAD (all of HEAD when null).
 * @property {(base: string|null) => Promise<number>} commitsOnUpstream Commits of base..HEAD already on @{u}.
 * @property {(o: {base: string|null, rebaseMerges: boolean}) => Promise<string>} rebaseTodoPreview
 *   The todo git generates for rebase -i, leaving the repository untouched.
 * @property {(o: {base: string|null, rebaseMerges: boolean, todo: string, messages: Map<string, string>, sign?: boolean|null}) => Promise<{stopped: boolean, output: string}>} runRebaseTodo
 *   sign: --gpg-sign / --no-gpg-sign for the rewritten commits.
 * @property {() => Promise<import('./entities').RebaseProgress|null>} rebaseProgress
 *
 * @property {() => Promise<any>} fetchAll
 * @property {(remote: string, remoteBranch: string, localBranch: string) => Promise<any>} fetchInto
 * @property {(remote: string, branch: string, mode: import('./entities').PullMode) => Promise<any>} pull
 * @property {(o: {remote: string, branch: string, target: string, force?: boolean, tags?: boolean, setUpstream?: boolean}) => Promise<any>} push
 * @property {(remote: string, tag: string) => Promise<any>} pushTag
 * @property {(name: string, url: string) => Promise<any>} addRemote
 * @property {(name: string, url: string) => Promise<any>} setRemoteUrl
 * @property {(name: string) => Promise<any>} removeRemote
 *
 * @property {(c: Commit) => Promise<any>} cherryPick
 * @property {(c: Commit) => Promise<any>} revert
 * @property {(hash: string, mode: import('./entities').ResetMode) => Promise<any>} reset
 * @property {() => Promise<any>} undoLastCommit
 * @property {(name: string, hash: string, message?: string, sign?: boolean|null) => Promise<any>} createTag
 *   Annotated when there is a message; sign: -s (signed annotated tag) / --no-sign / null (tag.gpgsign).
 *
 * @property {(scope?: 'local'|'global') => Promise<import('./entities').SigningConfig>} signingConfig
 *   Effective settings, or those of one config file.
 * @property {(key: string, value: string|null, scope: 'local'|'global') => Promise<void>} setConfig Null removes the key.
 * @property {(o?: {format?: import('./entities').SigningFormat, key?: string|null}) => Promise<{ok: boolean, output: string}>} testSigning
 *   Signs a throwaway commit object (no ref); output: git's error when it failed.
 * @property {(hashes: string[]) => Promise<Map<string, import('./entities').Signature>>} signatures %G? and co. of these commits only.
 * @property {(name: string) => Promise<{name: string, signed: boolean, signature: import('./entities').Signature|null,
 *   output: string}|null>} verifyTag git tag -v; null for a lightweight tag.
 * @property {(name: string) => Promise<any>} deleteTag
 *
 * @property {(o?: {message?: string, includeUntracked?: boolean, keepIndex?: boolean}) => Promise<any>} stash
 * @property {(ref: string, pop?: boolean) => Promise<any>} stashApply
 * @property {() => Promise<any>} stashPop Pops the most recent stash.
 * @property {(ref: string) => Promise<any>} stashDrop
 * @property {(ref: string, branch: string) => Promise<any>} stashBranch
 *
 * @property {(paths: string[], base: string|null) => Promise<{patch: Buffer, files: ShelfFile[]}>} buildPatch
 *   Patch (git diff --binary --full-index -M) of the working tree content of `paths` against `base`, built in a
 *   temporary index (new and deleted files included). Null `base` = empty tree.
 * @property {(files: ShelfFile[], base: string) => Promise<void>} discardChanges
 *   Reverts files to `base` in the index and working tree; new files are deleted.
 * @property {(patch: Buffer) => Promise<import('./entities').PatchFile[]>} patchFiles git apply --numstat --summary.
 * @property {(patch: Buffer, targets: string[]) => Promise<import('./entities').PatchCheck>} checkPatch git apply --check --3way.
 * @property {(patch: Buffer, targets: string[]) => Promise<{conflicted: string[], output: string}>} applyPatch
 *   git apply --3way on the working tree, the index of clean targets left as it was; throws when refused.
 * @property {(patch: Buffer) => Promise<{stopped: boolean, output: string}>} applyMailbox git am --3way.
 * @property {(hashes: string[]) => Promise<Buffer>} formatPatch git format-patch --stdout of each commit, in order.
 * @property {(base: string, patch: Buffer, paths: string[]) => Promise<Map<string, {mode: string, sha: string}>>} patchedEntries
 *   Blobs of `paths` once `patch` is applied to `base` (temporary index).
 * @property {(sha: string) => Promise<Buffer>} blob
 * @property {(base: string, patch: Buffer, removePaths: string[]) => Promise<{patch: Buffer, files: ShelfFile[]}>} removeFromPatch
 * @property {() => Promise<string[]>} unmergedPaths
 * @property {() => Promise<any>} skipMailboxPatch git am --skip.
 *
 * @property {(change: FileChange, ours: boolean) => Promise<void>} acceptSide
 * @property {(rel: string) => Promise<string>} mergeFromStages Conflicted content rebuilt from the index stages.
 * @property {(rel: string, content?: string) => Promise<void>} markResolved Writes `content` first when given.
 *
 * @typedef {object} ShelfStore Shelved changes of one repository (format shared with the Flutter app).
 * @property {() => Promise<Shelf[]>} list Newest first.
 * @property {(id: string) => Promise<Shelf|null>} get
 * @property {(o: {name: string, created: Date, base: string, branch: string|null, files: ShelfFile[], patch: Buffer}) => Promise<Shelf>} create
 *   Also creates the ref keeping `base` alive.
 * @property {(id: string) => Promise<Buffer>} readPatch
 * @property {(id: string, name: string) => Promise<void>} rename
 * @property {(id: string, o: {files: ShelfFile[], patch: Buffer}) => Promise<void>} update
 * @property {(id: string) => Promise<void>} remove Deletes the folder and the ref.
 *
 * @typedef {object} ChangelistStore Changelists of one worktree (changelists.json, format shared with the Flutter app).
 * @property {() => Promise<import('./entities').ChangelistsData>} read
 *   Only the default list when there is no file yet; throws when the file cannot be read as changelists.
 * @property {(data: import('./entities').ChangelistsData) => Promise<void>} write Atomic (temporary file, then rename).
 *
 * @typedef {object} GitService Git operations not bound to an opened repository.
 * @property {(dir: string) => Promise<string|null>} findRoot Top level of the repository containing `dir`.
 * @property {(root: string, o?: {log?: GitLog}) => GitRepository} open
 * @property {(repo: GitRepository) => ShelfStore} shelfStore Shelves of a repository opened by open().
 * @property {() => SigningKeys} signingKeys Keys offered by the Signing Settings dialog.
 * @property {(repo: GitRepository) => ChangelistStore} changelistStore Changelists of a repository opened by open().
 * @property {(dir: string, depth: number) => string[]} scan Folders below `dir` (up to `depth` levels) that hold a repository.
 * @property {(dir: string) => boolean} isRepository
 * @property {(repo: GitRepository) => GitLfs} lfs Git LFS commands of a repository opened by open().
 *
 * @typedef {object} GitLfs Git LFS commands of one repository.
 * @property {() => Promise<string|null>} version `git lfs version`, null when git-lfs is missing (cached per session).
 * @property {() => Promise<boolean>} available
 * @property {(paths: string[]) => Promise<Set<string>>} lfsPaths Paths with filter=lfs (git check-attr).
 * @property {(ref?: string) => Promise<import('./logic/lfs').LfsFile[]>} lsFiles
 * @property {() => Promise<import('./entities').LfsPattern[]>} trackedPatterns
 * @property {(pattern: string, o?: {filename?: boolean}) => Promise<any>} track
 * @property {(p: import('./entities').LfsPattern|string) => Promise<void>} untrack
 * @property {() => Promise<any>} pull
 * @property {() => Promise<any>} fetch
 * @property {(dryRun: boolean) => Promise<string[]>} prune Output lines (--dry-run --verbose when dryRun).
 * @property {() => Promise<import('./entities').LfsLock[]|null>} locks Null when the remote has no lock support (or no answer).
 * @property {(rel: string) => Promise<any>} lock
 * @property {(rel: string, force?: boolean) => Promise<any>} unlock
 * @property {(rev: string, rel: string) => Promise<import('./entities').LfsPointer|null>} pointerAt '' = index.
 * @property {(rel: string) => Promise<import('./entities').LfsPointer|null>} workingPointer
 * @property {(oid: string) => Promise<string|null>} objectFile Local copy of an object, null when not downloaded.
 *
 * @typedef {object} SigningKeys Keys of this machine that git can sign with (never changes anything).
 * @property {(program?: string|null) => Promise<import('./logic/signing').GpgKey[]>} gpgKeys
 *   `gpg --list-secret-keys --with-colons` (gpg.program, or git's bundled gpg); throws when gpg cannot run.
 * @property {() => Promise<{path: string, privatePath: string|null, key: import('./logic/signing').SshKey}[]>} sshKeyFiles
 *   `~/.ssh/*.pub`, with the private key file next to it when there is one.
 * @property {() => Promise<import('./logic/signing').SshKey[]>} sshAgentKeys `ssh-add -L` ([] without an agent).
 *
 * @typedef {object} CommitMessageAi
 * @property {(req: import('./prompt').CommitRequest, onText: (text: string) => void) => Promise<string>} generate
 * @property {() => Promise<void>} testConnection
 * @property {() => void} cancel
 *
 * @typedef {(provider: 'claude'|'gemini', o: {apiKey: string, model: string}) => CommitMessageAi} CreateAi
 */

module.exports = {};
