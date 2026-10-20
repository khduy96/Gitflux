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
 * @typedef {'normal'|'merging'|'rebasing'|'cherryPicking'|'reverting'} RepoState
 * @typedef {{branch: string|null, head: string|null, upstream: string|null, ahead: number, behind: number, changes: FileChange[], state: RepoState}} Status
 * @typedef {{name: string, kind: 'head'|'local'|'remote'|'tag'}} RefLabel
 * @typedef {{hash: string, parents: string[], author: string, email: string, time: number, committer: string, commitTime: number, refs: RefLabel[], subject: string}} Commit
 * @typedef {{name: string, remote: boolean, hash: string, current: boolean, upstream: string|null, ahead: number, behind: number, gone: boolean}} Branch
 * @typedef {{name: string, hash: string}} Tag
 * @typedef {{name: string, url: string}} Remote
 * @typedef {{index: number, ref: string, hash: string, time: number, message: string}} Stash
 * @typedef {'soft'|'mixed'|'hard'|'keep'} ResetMode
 * @typedef {'merge'|'rebase'|'ff'} PullMode
 * @typedef {{signature: string, excluded: Set<string>, total: number}} LineSelection
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
