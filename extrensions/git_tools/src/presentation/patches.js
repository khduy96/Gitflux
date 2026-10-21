// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { PatchRejected } = require('../domain/errors');
const { patchFileName, normalizeClipboardPatch } = require('../domain/logic/patch');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').FileChange} FileChange */
/** @typedef {import('../domain/entities').Commit} Commit */

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });

const firstLine = (s) => String(s).trim().split('\n')[0];

/**
 * Save dialog for a patch (default: `name` in the repository folder).
 * @param {RepoModel} m @param {Buffer} patch @param {string} name
 */
async function savePatch(m, patch, name) {
  const uri = await vscode.window.showSaveDialog({
    title: 'Create Patch',
    defaultUri: vscode.Uri.file(path.join(m.root, name)),
    filters: { Patches: ['patch', 'diff'], 'All Files': ['*'] },
    saveLabel: 'Create Patch',
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, patch);
  const r = await vscode.window.showInformationMessage(`Patch saved to ${uri.fsPath}`, 'Open');
  if (r) await vscode.window.showTextDocument(uri);
}

/**
 * Create Patch from working tree files (relative to HEAD): saved to a file,
 * or copied to the clipboard.
 * @param {RepoModel} m @param {FileChange[]} changes @param {boolean} toClipboard
 */
async function createPatch(m, changes, toClipboard) {
  if (!changes.length) return vscode.window.showInformationMessage('Tick or select the files to put in the patch.');
  /** @type {Buffer|null} */
  let patch = null;
  await m.run('Create patch', async () => { patch = await m.patches.fromChanges(changes, m.status); }, { refresh: false });
  if (!patch) return;
  if (toClipboard) {
    await vscode.env.clipboard.writeText(patch.toString('utf8'));
    return vscode.window.setStatusBarMessage(`$(check) Patch of ${changes.length} file(s) copied to the clipboard`, 4000);
  }
  await savePatch(m, patch, patchFileName(m.status.branch));
}

/**
 * Log ▸ Create Patch…: the selected commits as one mailbox (git
 * format-patch), oldest first.
 * @param {RepoModel} m @param {Commit[]} commits
 */
async function createPatchFromCommits(m, commits) {
  /** @type {{patch: Buffer, count: number, skippedMerges: number}|null} */
  let r = null;
  await m.run('Create patch', async () => { r = await m.patches.fromCommits(commits, m.commits.map((c) => c.hash)); }, { refresh: false });
  if (!r) return;
  if (r.skippedMerges) vscode.window.showInformationMessage(`${r.skippedMerges} merge commit(s) left out: git format-patch does not export merges.`);
  const slug = (s) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const name = commits.length === 1 && slug(commits[0].subject) ? `${slug(commits[0].subject)}.patch` : patchFileName(m.status.branch);
  await savePatch(m, r.patch, name);
}

const LETTER_ICON = { M: '$(diff-modified)', A: '$(diff-added)', D: '$(diff-removed)', R: '$(diff-renamed)' };

/**
 * Apply Patch…: reads a patch file (or the clipboard), shows its files and a
 * dry run, then applies it as commits (git am --3way, for a mailbox) or to
 * the working tree (git apply --3way). Conflicts go to the Merge Conflicts UI.
 * @param {RepoModel} m @param {boolean} fromClipboard
 */
async function applyPatch(m, fromClipboard) {
  /** @type {Buffer} */
  let patch;
  let source;
  if (fromClipboard) {
    const text = await vscode.env.clipboard.readText();
    if (!text.trim()) return vscode.window.showInformationMessage('The clipboard is empty.');
    patch = Buffer.from(normalizeClipboardPatch(text), 'utf8');
    source = 'clipboard';
  } else {
    const uris = await vscode.window.showOpenDialog({
      title: 'Apply Patch',
      defaultUri: vscode.Uri.file(m.root),
      canSelectMany: false,
      filters: { Patches: ['patch', 'diff', 'mbox', 'eml', 'txt'], 'All Files': ['*'] },
      openLabel: 'Apply Patch…',
    });
    if (!uris || !uris.length) return;
    patch = Buffer.from(await vscode.workspace.fs.readFile(uris[0]));
    source = path.basename(uris[0].fsPath);
  }

  /** @type {import('../domain/usecases/patches').PatchPreview} */
  let preview;
  try {
    preview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading patch' },
      () => m.patches.inspect(patch));
  } catch (e) {
    if (e instanceof PatchRejected) return vscode.window.showWarningMessage(e.message);
    return vscode.window.showErrorMessage(`Cannot read the patch: ${firstLine(e && e.message ? e.message : e)}`);
  }

  const { files, check, mailbox } = preview;
  const result = check.error ? `$(error) git apply --check: ${firstLine(check.error)}`
    : check.conflicts.length ? `$(warning) Applies with conflicts in ${check.conflicts.length} file(s): ${check.conflicts.slice(0, 3).join(', ')}`
      : '$(check) Applies cleanly';
  const actions = mailbox
    ? [
      { label: '$(git-commit) Apply as Commits', description: 'git am --3way', id: 'am' },
      { label: '$(diff) Apply Changes Only', description: 'to the working tree, no commits (git apply --3way)', id: 'apply' },
    ]
    : [{ label: '$(diff) Apply to Working Tree', description: 'git apply --3way', id: 'apply' }];
  for (;;) {
    const pick = /** @type {any} */ (await vscode.window.showQuickPick(/** @type {any[]} */ ([
      ...actions,
      { label: result, id: 'check', detail: check.error ? firstLine(check.error.split('\n').slice(1).join(' ')) || undefined : undefined },
      sep(`${files.length} file${files.length === 1 ? '' : 's'}${mailbox ? ' · mailbox (git format-patch)' : ''}`),
      ...files.map((f) => ({
        label: `${LETTER_ICON[f.status]} ${path.basename(f.path)}`,
        description: [
          f.oldPath ? `${f.oldPath} →` : '',
          path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path),
          f.added === null ? 'binary' : `+${f.added} −${f.deleted}`,
        ].filter(Boolean).join('  '),
        file: f,
      })),
    ]), { title: `Apply Patch · ${source}`, matchOnDescription: true, ignoreFocusOut: true }));
    if (!pick) return;
    if (!pick.id || pick.id === 'check') continue;
    const asCommits = pick.id === 'am';
    /** @type {{conflicted: string[], stopped: boolean, output: string}|null} */
    let r = null;
    await m.run(asCommits ? 'Apply patch as commits' : 'Apply patch', async () => {
      r = await m.patches.apply(patch, { asCommits, files, status: m.status });
    });
    if (!r) return;
    if (r.stopped) {
      const choice = await vscode.window.showWarningMessage(
        `git am stopped at a patch${r.conflicted.length ? ` with conflicts in ${r.conflicted.slice(0, 5).join(', ')}` : ''}. Resolve, then Continue (or Skip / Abort) in the Commit view.`,
        ...(r.conflicted.length ? ['Resolve…'] : []));
      if (choice) vscode.commands.executeCommand('gitTools.resolveConflicts');
    } else if (r.conflicted.length) {
      const choice = await vscode.window.showWarningMessage(
        `Patch applied with conflicts in ${r.conflicted.length} file(s): ${r.conflicted.slice(0, 5).join(', ')}`, 'Resolve…');
      if (choice) vscode.commands.executeCommand('gitTools.resolveConflicts');
    } else {
      vscode.window.setStatusBarMessage(`$(check) Patch applied${asCommits ? ' as commits' : ''}`, 4000);
    }
    return;
  }
}

module.exports = { savePatch, createPatch, createPatchFromCommits, applyPatch };
