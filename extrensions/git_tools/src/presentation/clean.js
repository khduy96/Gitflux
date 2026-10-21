// @ts-check
'use strict';

const vscode = require('vscode');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').CleanEntry} CleanEntry */
/** @typedef {import('../domain/entities').CleanOptions} CleanOptions */

/** Options of the last Clean dialog, for the session. @type {CleanOptions} */
let lastOptions = { ignored: false, directories: true };

const onOff = (v) => (v ? 'on' : 'off');

/**
 * "Clean Working Tree…" / "Clean Unversioned Files…": the untracked files
 * `git clean -n` would remove with the chosen options, each with a checkbox.
 * Toolbar buttons switch "Include ignored files" (-x) and "Remove untracked
 * directories" (-d). Nested repositories are listed unchecked (removing them
 * needs -ff). Removes only the checked entries, after a confirmation.
 * @param {RepoModel} m
 */
async function cleanWorkingTree(m) {
  /** @type {CleanOptions} */
  let opts = { ...lastOptions };
  /** Paths the user unchecked (kept while the options change). */
  const unchecked = new Set();
  const qp = vscode.window.createQuickPick();
  qp.canSelectMany = true;
  qp.ignoreFocusOut = true;
  qp.matchOnDescription = true;
  qp.placeholder = 'Untracked files to delete (uncheck to keep); the toolbar buttons change the options';
  /** @type {any[]} */
  let shown = [];
  let gen = 0;
  let syncing = false;
  const buttons = () => [
    {
      iconPath: new vscode.ThemeIcon(opts.ignored ? 'eye' : 'eye-closed'),
      tooltip: `Include ignored files (-x): ${onOff(opts.ignored)}`,
      id: 'ignored',
    },
    {
      iconPath: new vscode.ThemeIcon(opts.directories ? 'folder' : 'file'),
      tooltip: `Remove untracked directories (-d): ${onOff(opts.directories)}`,
      id: 'directories',
    },
  ];
  const load = async () => {
    const g = ++gen;
    qp.buttons = buttons();
    qp.title = `Clean Working Tree · directories (-d): ${onOff(opts.directories)} · ignored (-x): ${onOff(opts.ignored)}`;
    qp.busy = true;
    try {
      const entries = await m.repo.cleanPreview(opts);
      if (g !== gen) return;
      shown = entries.map((e) => ({
        label: `${e.nestedRepo ? '$(repo)' : e.directory ? '$(folder)' : '$(file)'} ${e.path}${e.directory ? '/' : ''}`,
        description: e.nestedRepo ? 'nested repository: deleted with its history (git clean -ff)' : '',
        entry: e,
        // Nested repositories only when the user checks them.
        picked: !unchecked.has(e.path) && !e.nestedRepo,
      }));
      syncing = true;
      qp.items = shown;
      qp.selectedItems = shown.filter((i) => i.picked);
      syncing = false;
      if (!shown.length) qp.placeholder = 'Nothing to clean with these options';
      else qp.placeholder = `${shown.length} untracked item${shown.length === 1 ? '' : 's'}: uncheck what to keep, then press Enter`;
    } catch (e) {
      if (g === gen) qp.items = [{ label: `$(error) ${String(e.message).split('\n')[0]}` }];
    } finally {
      if (g === gen) qp.busy = false;
    }
  };
  qp.onDidChangeSelection((sel) => {
    if (syncing) return;
    const picked = new Set(sel.map((i) => /** @type {any} */ (i).entry && /** @type {any} */ (i).entry.path));
    for (const i of shown) {
      if (picked.has(i.entry.path)) unchecked.delete(i.entry.path);
      else unchecked.add(i.entry.path);
    }
  });
  qp.onDidTriggerButton((b) => {
    const id = /** @type {any} */ (b).id;
    opts = { ...opts, [id]: !opts[id] };
    load();
  });
  const chosen = await new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems.map((i) => /** @type {any} */ (i).entry).filter(Boolean));
      qp.hide();
    });
    qp.onDidHide(() => resolve(null));
    qp.show();
    load();
  });
  qp.dispose();
  if (!chosen) return;
  lastOptions = opts;
  /** @type {CleanEntry[]} */
  const entries = chosen;
  if (!entries.length) {
    vscode.window.showInformationMessage(shown.length ? 'Nothing selected: no files were deleted.' : 'Nothing to clean.');
    return;
  }
  const nested = entries.filter((e) => e.nestedRepo);
  if (nested.length) {
    const ok = await vscode.window.showWarningMessage(
      `Delete ${nested.length} nested repositor${nested.length === 1 ? 'y' : 'ies'}?`,
      {
        modal: true,
        detail: `${nested.slice(0, 8).map((e) => e.path).join('\n')}${nested.length > 8 ? '\n…' : ''}\n\n` +
          'Each is a Git repository of its own: its history, branches and uncommitted work are deleted too (git clean -ff).',
      },
      'Delete Repositories');
    if (!ok) return;
  }
  const dirs = entries.filter((e) => e.directory).length;
  const ok = await vscode.window.showWarningMessage(
    `Delete ${entries.length} untracked item${entries.length === 1 ? '' : 's'}?`,
    {
      modal: true,
      detail: `${dirs ? `${dirs} of them ${dirs === 1 ? 'is a folder' : 'are folders'} with everything inside. ` : ''}` +
        `${opts.ignored ? 'Ignored files are included. ' : ''}This cannot be undone.`,
    },
    'Delete');
  if (!ok) return;
  await m.run('Clean working tree', () => m.repo.clean(opts, entries),
    { success: `${entries.length} untracked item${entries.length === 1 ? '' : 's'} deleted` });
}

module.exports = { cleanWorkingTree };
