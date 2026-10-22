// @ts-check
'use strict';

const vscode = require('vscode');
const { branchNameSuggestions } = require('../domain/logic/quickActions');

const LAST_PREFIX = 'gitTools.branchPrefix.last';

/** Where the last used prefix is kept (set once by extension.js). @type {vscode.Memento|null} */
let memento = null;

/** @param {vscode.Memento} m */
function useMemento(m) {
  memento = m;
}

const prefixes = () => /** @type {string[]} */ (vscode.workspace.getConfiguration('gitTools').get('branchPrefixes', []));

/**
 * Asks for a new branch name. With prefixes configured (gitTools.branchPrefixes)
 * the typed name is offered with each of them, the last used one first;
 * otherwise a plain input box.
 * @param {{title: string, validate: (name: string) => string|null}} o
 * @returns {Promise<string|undefined>}
 */
async function pickBranchName(o) {
  const list = prefixes();
  if (!list.length) {
    const name = await vscode.window.showInputBox({ title: o.title, prompt: 'New branch name', validateInput: o.validate });
    return name ? name.trim() : undefined;
  }
  const last = memento ? memento.get(LAST_PREFIX, null) : null;
  const qp = vscode.window.createQuickPick();
  qp.title = o.title;
  qp.placeholder = `Type the branch name; prefixes: ${list.join(', ')}`;
  const refresh = () => {
    qp.items = branchNameSuggestions(qp.value, list, last).map((s) => {
      const error = o.validate(s.name);
      return { label: `$(git-branch) ${s.name}`, description: error ? `$(error) ${error}` : s.prefix ? '' : 'no prefix', name: s.name, prefix: s.prefix, error };
    });
  };
  qp.onDidChangeValue(refresh);
  const picked = await new Promise((resolve) => {
    qp.onDidAccept(() => {
      const sel = /** @type {any} */ (qp.selectedItems[0]);
      if (!sel || sel.error) return;
      resolve(sel);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!picked) return undefined;
  if (memento) await memento.update(LAST_PREFIX, picked.prefix);
  return picked.name;
}

module.exports = { pickBranchName, useMemento };
