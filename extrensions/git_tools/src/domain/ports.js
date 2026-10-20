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
 *
 * @typedef {(line: string, kind: 'command'|'output'|'error'|'info') => void} GitLog
 *
 * @typedef {object} GitRepository Git operations on one repository.
 * @property {string} root
 * @property {string} name
 * @property {() => Promise<import('./entities').Status>} status
 * @property {() => Promise<string|null>} pendingMergeMessage
 *
 * @property {(o?: {revisions?: string[], path?: string, limit?: number}) => Promise<Commit[]>} log
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
 * @property {(o: {message: string, paths: string[], amend?: boolean, signOff?: boolean, partial?: boolean}) => Promise<void>} commit
 * @property {(o: {message: string, fullPaths: string[], partial: {path: string, content: string}[], amend?: boolean, signOff?: boolean}) => Promise<void>} commitSelected
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
 * @property {(ref: string) => Promise<any>} merge
 * @property {(onto: string, branch?: string) => Promise<any>} rebase
 * @property {(state: import('./entities').RepoState) => Promise<any>} continueOperation
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
 * @property {(o: {base: string|null, rebaseMerges: boolean, todo: string, messages: Map<string, string>}) => Promise<{stopped: boolean, output: string}>} runRebaseTodo
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
 * @property {(name: string, hash: string, message?: string) => Promise<any>} createTag
 * @property {(name: string) => Promise<any>} deleteTag
 *
 * @property {(o?: {message?: string, includeUntracked?: boolean, keepIndex?: boolean}) => Promise<any>} stash
 * @property {(ref: string, pop?: boolean) => Promise<any>} stashApply
 * @property {() => Promise<any>} stashPop Pops the most recent stash.
 * @property {(ref: string) => Promise<any>} stashDrop
 * @property {(ref: string, branch: string) => Promise<any>} stashBranch
 *
 * @property {(change: FileChange, ours: boolean) => Promise<void>} acceptSide
 * @property {(rel: string) => Promise<string>} mergeFromStages Conflicted content rebuilt from the index stages.
 * @property {(rel: string, content?: string) => Promise<void>} markResolved Writes `content` first when given.
 *
 * @typedef {object} GitService Git operations not bound to an opened repository.
 * @property {(dir: string) => Promise<string|null>} findRoot Top level of the repository containing `dir`.
 * @property {(root: string, o?: {log?: GitLog}) => GitRepository} open
 * @property {(dir: string, depth: number) => string[]} scan Folders below `dir` (up to `depth` levels) that hold a repository.
 * @property {(dir: string) => boolean} isRepository
 *
 * @typedef {object} CommitMessageAi
 * @property {(req: import('./prompt').CommitRequest, onText: (text: string) => void) => Promise<string>} generate
 * @property {() => Promise<void>} testConnection
 * @property {() => void} cancel
 *
 * @typedef {(provider: 'claude'|'gemini', o: {apiKey: string, model: string}) => CommitMessageAi} CreateAi
 */

module.exports = {};
