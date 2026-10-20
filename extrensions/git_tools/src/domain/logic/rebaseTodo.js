// @ts-check
'use strict';

/**
 * Interactive rebase todo list: parses the todo git generates and builds the
 * one that is run. Pure functions, no git.
 *
 * Commit lines carry an action the user can change. Every other line (label,
 * reset, merge, update-ref, exec, break) is structural: kept verbatim, and
 * commits are only reordered within the run of commit lines between two
 * structural lines.
 *
 * @typedef {'pick'|'reword'|'edit'|'squash'|'fixup'|'drop'} RebaseAction
 * @typedef {{id: number, kind: 'commit', hash: string, short: string, subject: string, action: RebaseAction,
 *   author?: string, time?: number, message?: string, newMessage?: string, groupMessage?: string}} CommitItem
 *   newMessage: message of a reworded commit; groupMessage: message of the squash group this commit heads.
 * @typedef {{id: number, kind: 'structural', verb: string, text: string}} StructuralItem
 * @typedef {CommitItem|StructuralItem} TodoItem
 * @typedef {{head: number, members: number[], squash: boolean, message: string|null, defaultMessage: string|null}} CommitGroup
 *   A commit and the squash / fixup commits melded into it (indexes into the items). `message` is
 *   the message the group ends with when it differs from the head's own (null = unchanged).
 * @typedef {{index: number, message: string}} TodoProblem
 */

/** @type {RebaseAction[]} */
const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

/** Abbreviated verbs (rebase.abbreviateCommands). */
const VERBS = {
  p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop',
  x: 'exec', b: 'break', l: 'label', t: 'reset', m: 'merge', u: 'update-ref',
};

/**
 * Parses a todo list. Blank lines and lines starting with the comment
 * string (core.commentChar) are skipped.
 * @param {string} text
 * @param {string} [commentChar]
 * @returns {TodoItem[]}
 */
function parseTodo(text, commentChar = '#') {
  /** @type {TodoItem[]} */
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(commentChar)) continue;
    const m = /^(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const verb = VERBS[m[1]] || m[1];
    if (verb === 'noop') continue;
    const c = ACTIONS.includes(/** @type {any} */ (verb)) ? /^(?:-[cC]\s+)?(\S+)\s*(.*)$/.exec(m[2]) : null;
    if (c) {
      items.push({ id: items.length, kind: 'commit', hash: c[1], short: c[1], subject: c[2], action: /** @type {RebaseAction} */ (verb) });
    } else {
      items.push({ id: items.length, kind: 'structural', verb, text: line });
    }
  }
  return items;
}

/**
 * Run number of every item: commit lines between two structural lines share
 * one; structural lines get -1.
 * @param {TodoItem[]} items
 */
function runIds(items) {
  let run = 0;
  let open = false;
  return items.map((it) => {
    if (it.kind !== 'commit') {
      if (open) run++;
      open = false;
      return -1;
    }
    open = true;
    return run;
  });
}

/** Message of a commit after a reword (its own message otherwise). @param {CommitItem} it */
const rewordedMessage = (it) => (it.action === 'reword' && it.newMessage !== undefined ? it.newMessage : it.message || it.subject);

const trimEnd = (s) => s.replace(/\s+$/, '');

/**
 * Checks the todo and groups each commit with the squash / fixup commits
 * melded into it.
 * @param {TodoItem[]} items
 * @returns {{errors: TodoProblem[], warnings: string[], groups: CommitGroup[]}}
 */
function analyzeTodo(items) {
  /** @type {TodoProblem[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {CommitGroup[]} */
  const groups = [];
  const runs = runIds(items);
  /** @type {CommitGroup|null} */
  let group = null;
  let run = -2;
  items.forEach((it, i) => {
    if (it.kind !== 'commit') {
      group = null;
      return;
    }
    if (runs[i] !== run) {
      group = null;
      run = runs[i];
    }
    if (it.action === 'drop') return;
    if (it.action === 'squash' || it.action === 'fixup') {
      if (!group) {
        errors.push({ index: i, message: `${it.short}: cannot ${it.action}, there is no older commit to meld it into` });
        return;
      }
      group.members.push(i);
      if (it.action === 'squash') group.squash = true;
      return;
    }
    group = { head: i, members: [i], squash: false, message: null, defaultMessage: null };
    groups.push(group);
  });

  for (const g of groups) {
    const head = /** @type {CommitItem} */ (items[g.head]);
    if (g.squash) {
      // Squashed messages are joined; fixup messages are left out.
      g.defaultMessage = [rewordedMessage(head), ...g.members.slice(1)
        .map((i) => /** @type {CommitItem} */ (items[i]))
        .filter((it) => it.action === 'squash')
        .map((it) => it.message || it.subject)]
        .map(trimEnd).join('\n\n');
      g.message = head.groupMessage !== undefined ? head.groupMessage : g.defaultMessage;
    } else if (head.action === 'reword') {
      g.defaultMessage = head.message || head.subject;
      g.message = rewordedMessage(head);
    }
    if (g.message !== null && !g.message.trim()) {
      errors.push({ index: g.head, message: `${head.short}: the commit message cannot be empty` });
    }
  }

  const commits = items.filter((it) => it.kind === 'commit');
  if (commits.length && commits.every((it) => it.action === 'drop')) {
    warnings.push('All commits will be dropped.');
  }
  errors.sort((a, b) => a.index - b.index);
  return { errors, warnings, groups };
}

/** Single quotes a word for sh. */
const shQuote = (s) => `'${s.replace(/'/g, '\'\\\'\'')}'`;

/**
 * Builds the todo to run and the message files its exec lines read.
 *   pick / edit / drop / fixup: same verb.
 *   reword: pick + exec git commit --amend -F <message file>.
 *   squash group: first commit picked, the others fixup, then one exec with
 *   the group message; a group of fixups only keeps the first message.
 * Message changes go through `git commit --amend` so commit hooks run.
 * @param {TodoItem[]} items
 * @param {{stateDir: string}} o directory the message files are written to
 * @returns {{todo: string, messages: Map<string, string>}}
 */
function buildTodo(items, o) {
  const { errors, groups } = analyzeTodo(items);
  if (errors.length) throw new Error(errors[0].message);
  /** @type {Map<number, CommitGroup>} */
  const groupOf = new Map();
  for (const g of groups) for (const i of g.members) groupOf.set(i, g);
  const dir = o.stateDir.replace(/\\/g, '/').replace(/\/+$/, '');
  /** @type {string[]} */
  const lines = [];
  /** @type {Map<string, string>} */
  const messages = new Map();
  items.forEach((it, i) => {
    if (it.kind !== 'commit') {
      lines.push(it.text);
      return;
    }
    const subject = it.subject ? ` ${it.subject}` : '';
    if (it.action === 'drop') {
      lines.push(`drop ${it.hash}${subject}`);
      return;
    }
    const g = /** @type {CommitGroup} */ (groupOf.get(i));
    const verb = i !== g.head ? 'fixup' : it.action === 'edit' ? 'edit' : 'pick';
    lines.push(`${verb} ${it.hash}${subject}`);
    if (i === g.members[g.members.length - 1] && g.message !== null) {
      const name = `msg-${messages.size + 1}.txt`;
      messages.set(name, `${trimEnd(g.message.replace(/\r\n?/g, '\n'))}\n`);
      // --allow-empty: rewording a commit that has no changes of its own.
      lines.push(`exec git commit --amend --allow-empty -F ${shQuote(`${dir}/${name}`)}`);
    }
  });
  return { todo: `${lines.join('\n')}\n`, messages };
}

/**
 * Moves the commit at `from` to position `to` when every line in between is
 * a commit line (same run). Returns the new list, or null when not allowed.
 * @param {TodoItem[]} items
 * @param {number} from
 * @param {number} to
 */
function moveItem(items, from, to) {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return null;
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    if (items[i].kind !== 'commit') return null;
  }
  const out = [...items];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/**
 * Whether `edited` only changed what the user may change: structural lines
 * stay in place and commits stay in their run.
 * @param {TodoItem[]} original
 * @param {TodoItem[]} edited
 */
function sameShape(original, edited) {
  if (original.length !== edited.length) return false;
  const runs = runIds(original);
  const indexOf = new Map(original.map((it, i) => [it.id, i]));
  const seen = new Set();
  return edited.every((it, i) => {
    const from = indexOf.get(it.id);
    if (from === undefined || seen.has(it.id) || original[from].kind !== it.kind) return false;
    seen.add(it.id);
    return it.kind === 'commit' ? runs[from] === runs[i] : from === i;
  });
}

/**
 * Index of the commit line for `hash` (full or abbreviated on either side).
 * @param {TodoItem[]} items
 * @param {string} hash
 */
function indexOfCommit(items, hash) {
  return items.findIndex((it) => it.kind === 'commit' && (it.hash.startsWith(hash) || hash.startsWith(it.hash)));
}

module.exports = {
  ACTIONS, parseTodo, runIds, analyzeTodo, buildTodo, moveItem, sameShape, indexOfCommit, shQuote,
};
