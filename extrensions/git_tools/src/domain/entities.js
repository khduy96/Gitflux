// @ts-check
'use strict';

/**
 * Plain data shared by all layers.
 *
 * @typedef {'modified'|'added'|'deleted'|'renamed'|'copied'|'typeChanged'|'untracked'|'conflicted'} ChangeType
 * @typedef {{newCommits: boolean, modifiedContent: boolean, untrackedContent: boolean}} SubmoduleChange
 * @typedef {{path: string, oldPath?: string, type: ChangeType, conflictCode?: string, nestedRepo?: boolean,
 *   submodule?: SubmoduleChange, staged?: boolean, unstaged?: boolean}} FileChange
 *   staged / unstaged (tracked changes): the index differs from HEAD / the working tree differs from the index.
 * @typedef {{path: string, sha: string, status: 'upToDate'|'uninitialized'|'outOfDate'|'conflict'|'notRegistered',
 *   url: string, describe: string, declared?: boolean}} Submodule
 * @typedef {'normal'|'merging'|'rebasing'|'cherryPicking'|'reverting'|'applyingMailbox'} RepoState
 *   applyingMailbox: `git am` stopped at a patch (rebase-apply/applying).
 * @typedef {{branch: string|null, head: string|null, upstream: string|null, ahead: number, behind: number, changes: FileChange[], state: RepoState}} Status
 * @typedef {{name: string, kind: 'head'|'local'|'remote'|'tag'}} RefLabel
 * @typedef {{hash: string, parents: string[], author: string, email: string, time: number, committer: string, commitTime: number, refs: RefLabel[], subject: string}} Commit
 * @typedef {{name: string, remote: boolean, hash: string, current: boolean, upstream: string|null, ahead: number, behind: number, gone: boolean}} Branch
 * @typedef {{selector: string, index: number, hash: string, action: string, message: string, time: number|null,
 *   missing: boolean}} ReflogEntry
 *   One reflog line: selector "HEAD@{2}", action "commit (amend)" and message (the subject around its first ": ").
 *   `missing`: the commit no longer exists (only selector and hash are known).
 * @typedef {{name: string, hash: string}} Tag
 * @typedef {{name: string, url: string}} Remote
 * @typedef {{index: number, ref: string, hash: string, time: number, message: string}} Stash
 * @typedef {'soft'|'mixed'|'hard'|'keep'} ResetMode
 * @typedef {'merge'|'rebase'|'ff'} PullMode
 * @typedef {{hash: string, parents: string[], author: string, time: number, subject: string, message: string}} RangeCommit
 *   A commit to rewrite, with its full message.
 * @typedef {{current: number, total: number, stoppedForEdit: boolean, stoppedSha: string|null, stoppedSubject: string}} RebaseProgress
 * @typedef {{signature: string, excluded: Set<string>, total: number}} LineSelection
 * @typedef {'M'|'A'|'D'|'R'} ShelfFileStatus
 * @typedef {{path: string, oldPath: string|null, status: ShelfFileStatus}} ShelfFile
 *   A shelved file; oldPath only for a rename.
 * @typedef {{id: string, name: string, created: number, base: string, branch: string|null, files: ShelfFile[]}} Shelf
 *   Changes put aside: `created` in ms, `base` the HEAD commit the patch is relative to.
 * @typedef {{path: string, oldPath: string|null, status: ShelfFileStatus, added: number|null, deleted: number|null}} PatchFile
 *   A file of a patch to apply; added / deleted lines are null for a binary file.
 * @typedef {{conflicts: string[], error: string|null}} PatchCheck
 *   `git apply --check --3way`: files that would conflict, or why the patch does not apply at all.
 * @typedef {{ignored: boolean, directories: boolean}} CleanOptions
 *   git clean -x (ignored files too) / -d (untracked directories).
 * @typedef {{path: string, directory: boolean, nestedRepo: boolean}} CleanEntry
 *   A path `git clean -n` lists; nestedRepo: a repository of its own, removed only with -ff.
 * @typedef {{fastForward: 'default'|'only'|'never', squash: boolean, noCommit: boolean, message: string|null,
 *   sign?: boolean|null}} MergeOptions
 *   --ff-only / --no-ff, --squash, --no-commit, -m (null: git's message); sign: -S / --no-gpg-sign (null: commit.gpgsign).
 * @typedef {{commits: number, fastForward: boolean}} MergePreview
 *   Commits of HEAD..ref; fastForward: HEAD is an ancestor of ref.
 * @typedef {{path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean, locked: boolean,
 *   lockReason: string, prunable: boolean, prunableReason: string, main: boolean, current: boolean}} Worktree
 *   One `git worktree list --porcelain` record; branch without refs/heads/; main: the first (main) worktree.
 * @typedef {'good'|'bad'|'skip'} BisectMark
 * @typedef {{start: string, bad: string|null, good: string[], skipped: string[], marks: Record<string, BisectMark>,
 *   remaining: number|null, steps: number|null, head: string|null, headSubject: string, firstBad: string|null,
 *   firstBadSubject: string}} BisectState
 *   A bisect session: `start` the branch (or commit) it started from; remaining / steps once a good and a bad commit
 *   are known; firstBad once git found it (the session lasts until reset).
 * @typedef {{hash: string, author: string, email: string, time: number, summary: string, previous: string|null,
 *   filename: string, uncommitted: boolean}} BlameCommit
 *   `time` in ms; previous: the parent the line came from (for Show Diff).
 * @typedef {{commits: Map<string, BlameCommit>, lines: {hash: string, line: number, origLine: number}[]}} Blame
 *   lines: 1-based final line numbers, in order.
 * @typedef {'none'|'claude'|'gemini'} AiProvider
 * @typedef {{provider: 'claude'|'gemini', apiKey: string, model: string, language?: string, instructions?: string}} AiConfig
 * @typedef {'openpgp'|'ssh'|'x509'} SigningFormat
 * @typedef {{commitSign: boolean, tagSign: boolean, format: SigningFormat, signingKey: string|null, program: string|null,
 *   sshProgram: string|null, allowedSignersFile: string|null}} SigningConfig
 *   commit.gpgsign, tag.gpgsign, gpg.format, user.signingkey, the signing program of the format (gpg.program…),
 *   gpg.ssh.program and gpg.ssh.allowedSignersFile.
 * @typedef {'good'|'warning'|'bad'|'none'} SignatureLevel
 * @typedef {{code: string, signer: string, key: string, trust: string, level: SignatureLevel, text: string}} Signature
 *   A commit or tag signature: `%G?` letter (G good, U untrusted, X / Y expired, R revoked key, B bad, E cannot be
 *   checked, N none), `%GS` signer, `%GK` key, `%GT` trust; level and text derived from the letter.
 * @typedef {{oid: string, size: number}} LfsPointer
 *   A Git LFS pointer file: sha256 `oid` and `size` in bytes of the real content.
 * @typedef {{id: string, path: string, owner: string, lockedAt: string, mine?: boolean}} LfsLock
 *   A lock on the LFS server; mine: held by the current user.
 * @typedef {{pattern: string, source: string, lockable: boolean}} LfsPattern
 *   A pattern tracked by LFS and the .gitattributes it comes from (repository relative, forward slashes).
 * @typedef {{id: string, name: string, comment: string, files: string[]}} Changelist
 *   A changelist: `comment` is its commit message draft, `files` repository relative paths (forward slashes).
 * @typedef {{version: number, active: string, lists: Changelist[]}} ChangelistsData
 *   changelists.json (shared with the Flutter app); unknown fields are kept when it is rewritten.
 */

/** Human readable summary of a submodule change. @param {SubmoduleChange|undefined} sm */
function describeSubmodule(sm) {
  if (!sm) return '';
  return [sm.newCommits && 'new commits', sm.modifiedContent && 'modified content', sm.untrackedContent && 'untracked content']
    .filter(Boolean).join(', ');
}

/** All paths git needs to commit this change (old path of a rename too). @param {FileChange} c */
const allPaths = (c) => (c.oldPath ? [c.path, c.oldPath] : [c.path]);

module.exports = { describeSubmodule, allPaths };
