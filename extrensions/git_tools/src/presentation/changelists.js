// @ts-check
'use strict';

const vscode = require('vscode');
const { DEFAULT_LIST } = require('../domain/logic/changelists');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').FileChange} FileChange */

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });

/** "3 files" / "1 file". @param {number} n */
const files = (n) => `${n} file${n === 1 ? '' : 's'}`;

/**
 * Commit message draft of a list as an input box can edit it: the message
 * box for the active list. Null when it has several lines (an input box has
 * one), which are kept.
 * @param {RepoModel} m @param {string} id
 */
function editableComment(m, id) {
  const list = m.changelists.list(id);
  const text = id === m.changelists.active ? m.message : list ? list.comment : '';
  return /\r?\n/.test(text.trim()) ? null : text.trim();
}

/**
 * Asks for the name and comment of a list (steps 1 and 2 of `total`).
 * Returns null when cancelled; comment undefined when it was not editable.
 * @param {RepoModel} m
 * @param {{title: string, total: number, id?: string}} o
 */
async function askNameAndComment(m, o) {
  const list = o.id ? m.changelists.list(o.id) : null;
  const name = await vscode.window.showInputBox({
    title: `${o.title} (1/${o.total})`,
    prompt: 'Name of the changelist',
    value: list ? list.name : '',
    ignoreFocusOut: true,
    validateInput: (v) => m.changelists.validateName(v, o.id || null),
  });
  if (name === undefined) return null;
  const current = o.id ? editableComment(m, o.id) : '';
  if (current === null) return { name: name.trim(), comment: undefined };
  const comment = await vscode.window.showInputBox({
    title: `${o.title} (2/${o.total})`,
    prompt: 'Comment: the commit message draft of this changelist (optional)',
    value: current,
    ignoreFocusOut: true,
  });
  if (comment === undefined) return null;
  return { name: name.trim(), comment };
}

/**
 * New Changelist… dialog: name, comment and whether it becomes active.
 * `paths` (tracked files) are moved into it. Returns its id.
 * @param {RepoModel} m
 * @param {string[]} [paths]
 */
async function newChangelist(m, paths = []) {
  const title = paths.length ? `New Changelist for ${files(paths.length)}` : 'New Changelist';
  const r = await askNameAndComment(m, { title, total: 3 });
  if (!r) return undefined;
  const how = /** @type {any} */ (await vscode.window.showQuickPick([
    { label: '$(add) Create', id: 'create' },
    { label: '$(pass-filled) Create and Set Active', id: 'active', description: 'tick its files and use its commit message' },
  ], { title: `${title} (3/3): ${r.name}`, ignoreFocusOut: true }));
  if (!how) return undefined;
  return m.createChangelist({ name: r.name, comment: r.comment || '', active: how.id === 'active', paths });
}

/**
 * Edit Changelist… dialog: name, comment and "Set active".
 * @param {RepoModel} m
 * @param {string} id
 */
async function editChangelist(m, id) {
  const list = m.changelists.list(id);
  if (!list) return;
  const active = id === m.changelists.active;
  const title = `Edit Changelist "${list.name}"`;
  const r = await askNameAndComment(m, { title, total: active ? 2 : 3, id });
  if (!r) return;
  let setActive = false;
  if (!active) {
    const how = /** @type {any} */ (await vscode.window.showQuickPick([
      { label: '$(check) Save', id: 'save' },
      { label: '$(pass-filled) Save and Set Active', id: 'active', description: 'tick its files and use its commit message' },
    ], { title: `${title} (3/3)`, ignoreFocusOut: true }));
    if (!how) return;
    setActive = how.id === 'active';
  }
  await m.editChangelist(id, { name: r.name, comment: r.comment, active: setActive });
}

/**
 * Delete Changelist…: after a confirmation its files move to the active list
 * (to the default list when the active one is deleted).
 * @param {RepoModel} m
 * @param {string} id
 */
async function deleteChangelist(m, id) {
  const list = m.changelists.list(id);
  if (!list) return;
  if (id === DEFAULT_LIST) return vscode.window.showInformationMessage(`"${list.name}" is the default changelist: it cannot be deleted.`);
  const target = m.changelists.list(m.changelists.deleteTarget(id));
  const ok = await vscode.window.showWarningMessage(`Delete changelist '${list.name}'?`, {
    modal: true,
    detail: list.files.length
      ? `Its ${files(list.files.length)} move${list.files.length === 1 ? 's' : ''} to "${target ? target.name : 'Changes'}". The files are not changed.`
      : 'It has no files.',
  }, 'Delete');
  if (ok) await m.deleteChangelist(id);
}

/**
 * Move to Another Changelist… (F6): an existing list or a new one.
 * Unversioned files are left out (they are in no list).
 * @param {RepoModel} m
 * @param {FileChange[]} changes
 */
async function moveToChangelist(m, changes) {
  const paths = changes.filter((c) => c.type !== 'untracked').map((c) => c.path);
  if (!paths.length) return vscode.window.showInformationMessage('Unversioned files are not in changelists. Add them to Git first.');
  const from = new Set(paths.map((p) => m.changelists.listOf(p)));
  const only = from.size === 1 ? [...from][0] : null;
  const items = m.changelists.data.lists.map((l) => ({
    label: `$(list-unordered) ${l.name}`,
    description: [l.id === m.changelists.active ? 'active' : '', l.id === only ? 'current' : '', files(l.files.length)].filter(Boolean).join(' · '),
    id: l.id,
  }));
  const pick = /** @type {any} */ (await vscode.window.showQuickPick([
    ...items.filter((it) => it.id !== only),
    sep(''),
    { label: '$(add) New Changelist…', id: null },
  ], { title: `Move ${files(paths.length)} to Another Changelist` }));
  if (!pick) return;
  if (pick.id === null) return newChangelist(m, paths);
  await m.moveToChangelist(paths, pick.id);
}

/** Set Active Changelist (command palette). @param {RepoModel} m */
async function pickActiveChangelist(m) {
  const pick = /** @type {any} */ (await vscode.window.showQuickPick([
    ...m.changelists.data.lists.map((l) => ({
      label: `${l.id === m.changelists.active ? '$(pass-filled)' : '$(circle-large-outline)'} ${l.name}`,
      description: `${l.id === m.changelists.active ? 'active · ' : ''}${files(l.files.length)}`,
      id: l.id,
    })),
    sep(''),
    { label: '$(add) New Changelist…', id: null },
  ], { title: 'Set Active Changelist' }));
  if (!pick) return;
  if (pick.id === null) return newChangelist(m);
  await m.setActiveChangelist(pick.id);
}

/**
 * Commands of the changelists: "Show / Hide Empty Changelists" (Commit view
 * title menu, context key gitTools.showEmptyChangelists), New Changelist…
 * and Set Active Changelist….
 * @param {vscode.ExtensionContext} context
 * @param {import('./model').RepoManager} manager
 * @param {import('./commitView').CommitViewProvider} commitView
 */
function registerChangelistCommands(context, manager, commitView) {
  const withRepo = (fn) => () => {
    const m = manager.current;
    if (!m) return vscode.window.showWarningMessage('No Git repository found in this workspace.');
    return fn(m);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('gitTools.commit.showEmptyChangelists', () => commitView.setShowEmptyChangelists(true)),
    vscode.commands.registerCommand('gitTools.commit.hideEmptyChangelists', () => commitView.setShowEmptyChangelists(false)),
    vscode.commands.registerCommand('gitTools.changelist.new', withRepo((m) => newChangelist(m))),
    vscode.commands.registerCommand('gitTools.changelist.setActive', withRepo((m) => pickActiveChangelist(m))),
  );
}

module.exports = {
  newChangelist, editChangelist, deleteChangelist, moveToChangelist, pickActiveChangelist, registerChangelistCommands,
};
