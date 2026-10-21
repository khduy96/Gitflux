// @ts-check
'use strict';

/**
 * Plain data shared by all layers.
 *
 * @typedef {'modified'|'added'|'deleted'|'renamed'|'copied'|'typeChanged'|'untracked'|'conflicted'} ChangeType
 * @typedef {{newCommits: boolean, modifiedContent: boolean, untrackedContent: boolean}} SubmoduleChange
 * @typedef {{path: string, oldPath?: string, type: ChangeType, conflictCode?: string, nestedRepo?: boolean,
 *   submodule?: SubmoduleChange}} FileChange
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
 * @typedef {'none'|'claude'|'gemini'} AiProvider
 * @typedef {{provider: 'claude'|'gemini', apiKey: string, model: string, language?: string, instructions?: string}} AiConfig
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
