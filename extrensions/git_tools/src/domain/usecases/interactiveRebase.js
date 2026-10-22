// @ts-check
'use strict';

const { RebaseRejected } = require('../errors');
const {
  parseTodo, analyzeTodo, buildTodo, sameShape, indexOfCommit, runIds,
} = require('../logic/rebaseTodo');

/** @typedef {import('../ports').GitRepository} GitRepository */
/** @typedef {import('../logic/rebaseTodo').TodoItem} TodoItem */
/** @typedef {import('../logic/rebaseTodo').CommitItem} CommitItem */

/**
 * An interactive rebase ready to be edited and run.
 * @typedef {{target: string, base: string|null, rebaseMerges: boolean, branch: string, head: string,
 *   upstream: string|null, pushed: number, items: TodoItem[]}} RebasePlan
 *   base: parent of the target (null = --root); pushed: commits already on the upstream.
 */

/**
 * A plan with the edit of one log action applied.
 * @typedef {{plan: RebasePlan, items: TodoItem[], index: number}} PreparedRebase
 *   index: the commit the action is about (the head of a squash group).
 */

const short = (h) => h.slice(0, 8);

/**
 * Interactive rebase: git generates the todo (so label / reset / merge /
 * update-ref lines are right), the user edits actions and order, and the
 * edited todo is run. Message changes are applied with `git commit --amend`
 * from exec lines, so commit hooks run.
 */
class InteractiveRebase {
  /** @param {GitRepository} repo */
  constructor(repo) {
    this.repo = repo;
  }

  /**
   * Checks the repository and gets git's todo for `target^..HEAD`.
   * @param {string} target oldest commit to rewrite
   * @returns {Promise<RebasePlan>}
   */
  async prepare(target) {
    const status = await this.repo.status();
    if (status.state !== 'normal') throw new RebaseRejected(`Finish the ${status.state} in progress first.`);
    if (!status.branch || !status.head) throw new RebaseRejected('HEAD is detached. Checkout a branch to rewrite its history.');
    if (!(await this.repo.isAncestor(target, 'HEAD'))) {
      throw new RebaseRejected(`${short(target)} is not in the history of ${status.branch}.`);
    }
    const base = await this.repo.parentOf(target);
    const commits = await this.repo.rangeCommits(base);
    const rebaseMerges = commits.some((c) => c.parents.length > 1);
    const todo = await this.repo.rebaseTodoPreview({ base, rebaseMerges });
    const [commentChar, pushed] = await Promise.all([this.repo.commentChar(), this.repo.commitsOnUpstream(base)]);
    const items = parseTodo(todo, commentChar).map((it) => {
      if (it.kind !== 'commit') return it;
      const c = commits.find((x) => x.hash.startsWith(it.hash));
      if (!c) return it;
      return { ...it, hash: c.hash, short: it.hash, subject: c.subject, author: c.author, time: c.time, message: c.message };
    });
    return { target, base, rebaseMerges, branch: status.branch, head: status.head, upstream: status.upstream, pushed, items };
  }

  /** @param {TodoItem[]} items */
  analyze(items) {
    return analyzeTodo(items);
  }

  /**
   * Runs the edited todo. Resolves with stopped = true when git stopped
   * (conflict, edit, failing hook or exec): the repository is then rebasing.
   * sign: the rewritten commits are signed (-S) / not (--no-gpg-sign); null = commit.gpgsign.
   * @param {RebasePlan} plan
   * @param {TodoItem[]} items
   * @param {{sign?: boolean|null}} [o]
   */
  async run(plan, items, o = {}) {
    if (!sameShape(plan.items, items)) throw new RebaseRejected('Commits can only be reordered between the merge structure lines.');
    const { errors } = analyzeTodo(items);
    if (errors.length) throw new RebaseRejected(errors[0].message);
    const status = await this.repo.status();
    if (status.state !== 'normal' || status.head !== plan.head || status.branch !== plan.branch) {
      throw new RebaseRejected(`${plan.branch} changed since the rebase was prepared. Start it again.`);
    }
    const sign = o.sign === undefined ? null : o.sign;
    const { todo, messages } = buildTodo(items, { stateDir: await this.repo.rebaseStateDir(), sign });
    return this.repo.runRebaseTodo({ base: plan.base, rebaseMerges: plan.rebaseMerges, todo, messages, sign });
  }

  // ------------------------------------------------------------- log actions

  /**
   * The commit of `hashes` every other one descends from.
   * @param {string[]} hashes
   */
  async oldest(hashes) {
    for (const h of hashes) {
      let all = true;
      for (const o of hashes) {
        if (o !== h && !(await this.repo.isAncestor(h, o))) {
          all = false;
          break;
        }
      }
      if (all) return h;
    }
    throw new RebaseRejected('The selected commits are not on one line of history.');
  }

  /**
   * @param {RebasePlan} plan
   * @param {string} hash
   */
  commitIndex(plan, hash) {
    const i = indexOfCommit(plan.items, hash);
    if (i < 0) throw new RebaseRejected(`${short(hash)} cannot be rewritten (merge commits keep their place).`);
    return i;
  }

  /**
   * Edit Commit Message: reword `hash` (the message is set by the caller on
   * items[index].newMessage).
   * @param {string} hash
   * @returns {Promise<PreparedRebase>}
   */
  async prepareReword(hash) {
    const plan = await this.prepare(hash);
    const index = this.commitIndex(plan, hash);
    const items = plan.items.map((it, i) => (i === index ? { ...it, action: /** @type {const} */ ('reword') } : it));
    return { plan, items, index };
  }

  /**
   * Squash Commits: the oldest is kept, the others are squashed into it. The
   * commits must be consecutive in the todo. The group message is set by the
   * caller on items[index].groupMessage (default: analyze().groups).
   * @param {string[]} hashes
   * @returns {Promise<PreparedRebase>}
   */
  async prepareSquash(hashes) {
    if (hashes.length < 2) throw new RebaseRejected('Select at least two commits to squash.');
    const plan = await this.prepare(await this.oldest(hashes));
    const indexes = hashes.map((h) => this.commitIndex(plan, h)).sort((a, b) => a - b);
    const runs = runIds(plan.items);
    for (let k = 1; k < indexes.length; k++) {
      if (indexes[k] !== indexes[k - 1] + 1 || runs[indexes[k]] !== runs[indexes[0]]) {
        throw new RebaseRejected('Only consecutive commits can be squashed.');
      }
    }
    const rest = new Set(indexes.slice(1));
    const items = plan.items.map((it, i) => (rest.has(i) ? { ...it, action: /** @type {const} */ ('squash') } : it));
    return { plan, items, index: indexes[0] };
  }

  /**
   * Fixup into Previous: melds `hash` into the commit before it, keeping that
   * commit's message.
   * @param {string} hash
   * @returns {Promise<PreparedRebase>}
   */
  async prepareFixup(hash) {
    const parent = await this.repo.parentOf(hash);
    if (!parent) throw new RebaseRejected(`${short(hash)} has no previous commit.`);
    const plan = await this.prepare(parent);
    const index = this.commitIndex(plan, hash);
    const prev = plan.items[index - 1];
    if (!prev || prev.kind !== 'commit') throw new RebaseRejected(`${short(hash)} has no previous commit on the same line of history.`);
    const items = plan.items.map((it, i) => (i === index ? { ...it, action: /** @type {const} */ ('fixup') } : it));
    return { plan, items, index: index - 1 };
  }

  /**
   * Move Commit Up (newer) / Down (older): swaps it with the adjacent commit.
   * @param {string} hash
   * @param {'up'|'down'} direction
   * @returns {Promise<PreparedRebase>}
   */
  async prepareMove(hash, direction) {
    let target = hash;
    if (direction === 'down') {
      const parent = await this.repo.parentOf(hash);
      if (!parent) throw new RebaseRejected(`${short(hash)} is the first commit.`);
      target = parent;
    }
    const plan = await this.prepare(target);
    const index = this.commitIndex(plan, hash);
    const other = index + (direction === 'up' ? 1 : -1);
    const it = plan.items[other];
    if (!it || it.kind !== 'commit') {
      throw new RebaseRejected(`${short(hash)} cannot move ${direction}: ${it ? 'it would cross a merge' : `it is the ${direction === 'up' ? 'newest' : 'oldest'} commit`}.`);
    }
    const items = [...plan.items];
    [items[index], items[other]] = [items[other], items[index]];
    return { plan, items, index: other };
  }

  /**
   * Drop Commits.
   * @param {string[]} hashes
   * @returns {Promise<PreparedRebase>}
   */
  async prepareDrop(hashes) {
    const plan = await this.prepare(await this.oldest(hashes));
    const drop = new Set(hashes.map((h) => this.commitIndex(plan, h)));
    const items = plan.items.map((it, i) => (drop.has(i) ? { ...it, action: /** @type {const} */ ('drop') } : it));
    return { plan, items, index: Math.min(...drop) };
  }
}

module.exports = { InteractiveRebase };
