// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { ShelfRejected } = require('../domain/errors');
const { defaultShelfName } = require('../domain/logic/shelf');
const { revUri, EMPTY } = require('./diff');
const { savePatch } = require('./patches');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').Shelf} Shelf */
/** @typedef {import('../domain/entities').ShelfFile} ShelfFile */
/** @typedef {import('../domain/entities').FileChange} FileChange */

const SHELF_SCHEME = 'gittools-shelf';

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });

/** Status words of shelved files. */
const STATUS_WORD = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed' };

/** Changes that can be shelved: not conflicted, not a submodule or nested repository. @param {FileChange} c */
const shelvable = (c) => c.type !== 'conflicted' && !c.submodule && !c.nestedRepo;

/**
 * Serves shelved file contents: gittools-shelf:/path?{root, id, path}.
 */
class ShelfContentProvider {
  /** @param {import('./model').RepoManager} manager */
  constructor(manager) {
    this.manager = manager;
  }

  /** @param {vscode.Uri} uri */
  async provideTextDocumentContent(uri) {
    const q = JSON.parse(uri.query);
    const m = this.manager.get(q.root);
    if (!m) return '';
    const shelf = m.shelves.find((s) => s.id === q.id) || await m.shelfStore.get(q.id);
    if (!shelf) return '(the shelf no longer exists)';
    try {
      const bytes = await m.shelve.content(shelf, q.path);
      if (!bytes) return '';
      if (bytes.subarray(0, 8000).includes(0)) return `(binary file, ${bytes.length} bytes)`;
      return bytes.toString('utf8');
    } catch (e) {
      return `(cannot read the shelved content: ${String(e && e.message ? e.message : e).split('\n')[0]})`;
    }
  }
}

/** @param {string} root @param {Shelf} shelf @param {string} filePath */
function shelfUri(root, shelf, filePath) {
  return vscode.Uri.from({
    scheme: SHELF_SCHEME,
    path: `/${filePath} (shelved)`.replace(/\\/g, '/'),
    query: JSON.stringify({ root, id: shelf.id, path: filePath }),
  });
}

/**
 * Read-only diff: the file at the shelf's base ↔ its shelved content.
 * @param {RepoModel} m @param {Shelf} shelf @param {ShelfFile} f
 */
async function openShelfDiff(m, shelf, f, preview = true) {
  const left = f.status === 'A' ? revUri(m.root, EMPTY, f.path) : revUri(m.root, shelf.base, f.oldPath || f.path);
  const right = f.status === 'D' ? revUri(m.root, EMPTY, f.path) : shelfUri(m.root, shelf, f.path);
  await vscode.commands.executeCommand('vscode.diff', left, right,
    `${path.basename(f.path)} (${shelf.base.slice(0, 8)} ↔ Shelved: ${shelf.name})`, { preview });
}

/**
 * Shelve Changes dialog: name, files (the chosen ones ticked) and "Keep
 * changes in working tree".
 * @param {RepoModel} m
 * @param {FileChange[]} chosen
 */
async function shelveChanges(m, chosen) {
  const all = m.status.changes.filter(shelvable);
  try {
    // Repository state first: no dialog when shelving is not possible.
    m.shelve.prepare({ status: m.status, changes: all.length ? all : chosen, name: 'check' });
  } catch (e) {
    if (e instanceof ShelfRejected) return vscode.window.showWarningMessage(e.message);
    throw e;
  }
  const picked = new Set(chosen.filter(shelvable).map((c) => c.path));
  const name = await vscode.window.showInputBox({
    title: 'Shelve Changes (1/2)',
    prompt: 'Name of the shelf',
    value: defaultShelfName(m.message, new Date()),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : 'Enter a name'),
  });
  if (!name) return;
  const keep = { label: '$(pin) Keep changes in working tree', description: 'only save a copy in the shelf', option: true, picked: false };
  const files = [...all].sort((a, b) => Number(picked.has(b.path)) - Number(picked.has(a.path)))
    .map((c) => ({
      label: path.basename(c.path),
      description: `${c.type}${c.oldPath ? ` · ${c.oldPath} →` : ''} · ${c.path}`,
      picked: picked.has(c.path),
      change: c,
    }));
  const picks = /** @type {any[]|undefined} */ (await vscode.window.showQuickPick(/** @type {any[]} */ ([keep, sep('Files'), ...files]), {
    title: `Shelve Changes (2/2): ${name.trim()}`,
    placeHolder: 'Ticked files are saved to the shelf and reverted to HEAD',
    canPickMany: true,
    matchOnDescription: true,
    ignoreFocusOut: true,
  }));
  if (!picks) return;
  const changes = picks.filter((p) => p.change).map((p) => p.change);
  if (!changes.length) return vscode.window.showInformationMessage('No files selected to shelve.');
  const skippedSubmodules = chosen.filter((c) => c.submodule || c.nestedRepo);
  let prepared;
  try {
    prepared = m.shelve.prepare({ status: m.status, changes, name, keep: picks.includes(keep) });
  } catch (e) {
    if (e instanceof ShelfRejected) return vscode.window.showWarningMessage(e.message);
    throw e;
  }
  /** @type {Shelf|null} */
  let shelf = null;
  await m.run(`Shelve ${changes.length} file(s)`, async () => { shelf = await m.shelve.run(prepared); }, {
    success: prepared.keep ? `${changes.length} file(s) copied to the shelf "${prepared.name}"` : `${changes.length} file(s) shelved to "${prepared.name}"`,
  });
  if (shelf && skippedSubmodules.length) {
    vscode.window.showInformationMessage(`Submodules are not shelved: ${skippedSubmodules.map((c) => c.path).join(', ')}`);
  }
}

/**
 * Unshelve dialog: files (all ticked, or `only`) and "Remove successfully
 * applied files from shelf".
 * @param {RepoModel} m @param {Shelf} shelf @param {string[]} [only]
 */
async function unshelveDialog(m, shelf, only) {
  const remove = { label: '$(trash) Remove successfully applied files from shelf', option: true, picked: true };
  const files = shelf.files.map((f) => ({
    label: path.basename(f.path),
    description: `${STATUS_WORD[f.status]} · ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}`,
    picked: !only || only.includes(f.path),
    file: f,
  }));
  const picks = /** @type {any[]|undefined} */ (await vscode.window.showQuickPick(/** @type {any[]} */ ([remove, sep('Files'), ...files]), {
    title: `Unshelve "${shelf.name}"`,
    placeHolder: 'Ticked files are applied to the working tree (3-way merge with the shelf\'s base)',
    canPickMany: true,
    matchOnDescription: true,
    ignoreFocusOut: true,
  }));
  if (!picks) return;
  const paths = picks.filter((p) => p.file).map((p) => p.file.path);
  if (!paths.length) return vscode.window.showInformationMessage('No files selected to unshelve.');
  return unshelve(m, shelf, paths, picks.includes(remove));
}

/**
 * Applies files of a shelf (all when `paths` is null); conflicted files stay
 * in the shelf and are left to the Merge Conflicts UI.
 * @param {RepoModel} m @param {Shelf} shelf @param {string[]|null} paths @param {boolean} remove
 */
async function unshelve(m, shelf, paths, remove) {
  /** @type {{applied: ShelfFile[], conflicted: ShelfFile[], shelfDeleted: boolean}|null} */
  let r = null;
  await m.run(remove ? `Unshelve ${shelf.name}` : `Apply ${shelf.name}`, async () => {
    r = await m.shelve.unshelve({ shelf, paths, remove });
  });
  if (!r) return;
  const n = r.applied.length;
  if (r.conflicted.length) {
    const which = r.conflicted.map((f) => f.path).slice(0, 5).join(', ');
    const choice = await vscode.window.showWarningMessage(
      `${n ? `${n} file(s) unshelved. ` : ''}${r.conflicted.length} file(s) merged with conflicts and stay in the shelf: ${which}`,
      'Resolve…');
    if (choice) vscode.commands.executeCommand('gitTools.resolveConflicts');
    return;
  }
  vscode.window.setStatusBarMessage(`$(check) ${n} file(s) unshelved${r.shelfDeleted ? `, shelf "${shelf.name}" is empty and was removed` : ''}`, 5000);
}

/** @param {RepoModel} m @param {Shelf} shelf */
async function renameShelf(m, shelf) {
  const name = await vscode.window.showInputBox({
    title: 'Rename Shelf', value: shelf.name, validateInput: (v) => (v.trim() ? null : 'Enter a name'),
  });
  if (!name || name.trim() === shelf.name) return;
  await m.run('Rename shelf', () => m.shelfStore.rename(shelf.id, name.trim()), { refresh: false });
  await m.refreshRefs();
}

/** @param {RepoModel} m @param {Shelf} shelf */
async function deleteShelf(m, shelf) {
  const ok = await vscode.window.showWarningMessage(`Delete the shelf "${shelf.name}"?`,
    { modal: true, detail: `Its ${shelf.files.length} shelved file(s) are lost.` }, 'Delete');
  if (!ok) return;
  await m.run('Delete shelf', () => m.shelfStore.remove(shelf.id), { refresh: false });
  await m.refreshRefs();
}

/** Saves the shelf's patch to a file, or copies it. @param {RepoModel} m @param {Shelf} shelf */
async function shelfPatch(m, shelf, toClipboard) {
  const patch = await m.shelfStore.readPatch(shelf.id);
  if (toClipboard) {
    await vscode.env.clipboard.writeText(patch.toString('utf8'));
    return vscode.window.setStatusBarMessage('$(check) Patch copied to the clipboard', 4000);
  }
  const name = shelf.name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'shelf';
  await savePatch(m, patch, `${name}.patch`);
}

module.exports = {
  SHELF_SCHEME, ShelfContentProvider, shelfUri, openShelfDiff, shelveChanges, unshelveDialog, unshelve, renameShelf,
  deleteShelf, shelfPatch, shelvable, STATUS_WORD,
};
