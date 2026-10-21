// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitError } = require('../domain/errors');
const {
  trackPatternOptions, patternsFor, parsePruneDryRun, describePointer, parsePointer,
} = require('../domain/logic/lfs');
const { fileUri } = require('./diff');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').FileChange} FileChange */
/** @typedef {import('../domain/entities').LfsPattern} LfsPattern */

const LFS_SCHEME = 'gittools-lfs';
/** Revision of a side that does not exist (added / deleted file). */
const NONE = '__none__';
const WORKTREE = 'WORKTREE';

const NOT_INSTALLED = 'Git LFS is not installed (git lfs version failed). Install it from https://git-lfs.com and run "git lfs install".';

/** Files whose content diff was offered this session (not offered again on every click). */
const offered = new Set();

/**
 * Serves one side of an LFS diff: the pointer (oid, size) and whether the
 * object is downloaded. gittools-lfs:/path?{root, rev, path, label}
 */
class LfsContentProvider {
  /** @param {import('./model').RepoManager} manager */
  constructor(manager) {
    this.manager = manager;
  }

  /** @param {vscode.Uri} uri */
  async provideTextDocumentContent(uri) {
    const q = JSON.parse(uri.query);
    const m = this.manager.get(q.root);
    if (!m) return '';
    if (q.rev === NONE) return `${q.label}\n\n(none)\n`;
    try {
      const p = q.rev === WORKTREE ? await m.lfs.workingPointer(q.path) : await m.lfs.pointerAt(q.rev, q.path);
      const present = p ? !!(await m.lfs.objectFile(p.oid)) : null;
      let note;
      if (!p) note = q.rev === WORKTREE ? '(the file does not exist)' : '(not stored in Git LFS at this revision)';
      else if (q.rev === WORKTREE && !present) note = 'the working tree file is the pointer itself (object not downloaded)';
      return describePointer(p, { label: q.label, present, note });
    } catch (e) {
      return `${q.label}\n\n(cannot read the pointer: ${String(e && e.message ? e.message : e).split('\n')[0]})\n`;
    }
  }
}

/** @param {string} root @param {string} rev @param {string} filePath @param {string} label */
function lfsUri(root, rev, filePath, label) {
  return vscode.Uri.from({
    scheme: LFS_SCHEME,
    path: `/${filePath} (LFS ${label})`.replace(/\\/g, '/'),
    query: JSON.stringify({ root, rev, path: filePath, label: `Git LFS pointer · ${label}` }),
  });
}

/**
 * Diff of an LFS file: the pointers (oid, size) of HEAD and the working
 * tree. When the HEAD object is downloaded, "Show Content Diff" opens the
 * normal diff of the real content (images in the image diff).
 * @param {RepoModel} m @param {FileChange} c
 */
async function openLfsDiff(m, c, preview = true) {
  const name = path.basename(c.path);
  const before = c.oldPath || c.path;
  const noHead = c.type === 'untracked' || c.type === 'added' || !m.status.head;
  const left = lfsUri(m.root, noHead ? NONE : 'HEAD', before, 'HEAD');
  const right = lfsUri(m.root, c.type === 'deleted' ? NONE : WORKTREE, c.path, 'Working Tree');
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (LFS pointer: HEAD ↔ Working Tree)`, { preview });
  if (noHead) return;
  const head = await m.lfs.pointerAt('HEAD', before).catch(() => null);
  if (!head || !(await m.lfs.objectFile(head.oid))) return;
  const key = `${m.root}\0${c.path}\0${head.oid}`;
  if (preview && offered.has(key)) return;
  offered.add(key);
  const r = await vscode.window.showInformationMessage(`${name} is stored in Git LFS: the diff shows its pointers.`, 'Show Content Diff');
  if (r) await showLfsContentDiff(m, c);
}

/**
 * Diff of the real content of an LFS file: the HEAD object (a copy with the
 * same name, so VS Code picks the right editor) ↔ the working tree file.
 * @param {RepoModel} m @param {FileChange} c
 */
async function showLfsContentDiff(m, c) {
  const before = c.oldPath || c.path;
  const head = await m.lfs.pointerAt('HEAD', before);
  const object = head && await m.lfs.objectFile(head.oid);
  if (!head || !object) {
    return vscode.window.showWarningMessage(`The HEAD version of ${before} is not downloaded. Use LFS ▸ Pull first.`);
  }
  const left = vscode.Uri.file(objectCopy(head.oid, object, before));
  const name = path.basename(c.path);
  if (c.type === 'deleted' || !fs.existsSync(path.join(m.root, c.path))) {
    return vscode.commands.executeCommand('vscode.open', left);
  }
  // The working file may be the pointer itself (not checked out): its object then, when downloaded.
  const full = path.join(m.root, c.path);
  const pointer = fs.statSync(full).size <= 1024 ? parsePointer(fs.readFileSync(full)) : null;
  const workObject = pointer ? await m.lfs.objectFile(pointer.oid) : null;
  const right = pointer && workObject ? vscode.Uri.file(objectCopy(pointer.oid, workObject, c.path)) : fileUri(m.root, c.path);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (HEAD ↔ Working Tree, LFS content)`);
}

/** A read-only temporary copy of an LFS object named like `rel`. */
function objectCopy(oid, object, rel) {
  const dir = path.join(os.tmpdir(), 'git-tools-lfs', oid.slice(0, 16));
  const file = path.join(dir, path.basename(rel));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(object, file);
    try { fs.chmodSync(file, 0o444); } catch { /* ignore */ }
  }
  return file;
}

/** Warns and returns false when git-lfs is missing. @param {RepoModel} m */
async function needLfs(m) {
  if (await m.lfs.available()) return true;
  vscode.window.showWarningMessage(NOT_INSTALLED);
  return false;
}

/**
 * Track with LFS…: the exact path, `*.<ext>` or `<dir>/**` (or a pattern
 * typed in) is added to .gitattributes with `git lfs track`; .gitattributes
 * then shows as changed. Files added to Git afterwards go to LFS.
 * @param {RepoModel} m @param {FileChange[]} changes
 */
async function trackWithLfs(m, changes) {
  if (!(await needLfs(m))) return;
  const paths = changes.filter((c) => !c.nestedRepo).map((c) => c.path);
  if (!paths.length) return;
  const items = [
    ...trackPatternOptions(paths).map((o) => ({ label: o.pattern, description: o.description, option: o })),
    { label: '$(edit) Other Pattern…', description: 'type a .gitattributes pattern', option: null },
  ];
  const pick = /** @type {any} */ (await vscode.window.showQuickPick(items, {
    title: paths.length === 1 ? `Track ${path.basename(paths[0])} with LFS` : `Track ${paths.length} files with LFS`,
    placeHolder: 'Pattern added to .gitattributes (git lfs track)',
  }));
  if (!pick) return;
  let pattern = pick.option ? pick.option.pattern : null;
  if (!pattern) {
    pattern = await vscode.window.showInputBox({
      title: 'Track with LFS', prompt: 'Pattern, e.g. *.psd or assets/**', value: items[0].label,
      validateInput: (v) => (v.trim() ? null : 'Enter a pattern'),
    });
    if (!pattern) return;
    pattern = pattern.trim();
  }
  const literal = !!pick.option && pick.option.kind === 'path';
  await m.run(`Track ${pattern} with LFS`, () => m.lfs.track(/** @type {string} */ (pattern), { filename: literal }),
    { success: `${pattern} tracked with LFS: .gitattributes updated` });
}

/**
 * Untrack from LFS: the tracked patterns covering the files, picked, are
 * removed from their .gitattributes. Versions already committed stay LFS
 * objects.
 * @param {RepoModel} m @param {FileChange[]} changes
 */
async function untrackFromLfs(m, changes) {
  if (!(await needLfs(m))) return;
  const paths = changes.map((c) => c.path);
  const matching = patternsFor(await m.lfs.trackedPatterns(), paths);
  if (!matching.length) {
    return vscode.window.showInformationMessage(`No LFS pattern of a .gitattributes file covers ${paths.length === 1 ? paths[0] : 'these files'}.`);
  }
  const picks = await vscode.window.showQuickPick(matching.map((p) => ({
    label: p.pattern, description: `${p.source}${p.lockable ? ' · lockable' : ''}`, picked: true, pattern: p,
  })), {
    title: 'Untrack from LFS',
    placeHolder: 'Ticked patterns are removed from .gitattributes (committed versions stay in LFS)',
    canPickMany: true,
  });
  if (!picks || !picks.length) return;
  await untrackPatterns(m, picks.map((p) => p.pattern));
}

/** @param {RepoModel} m @param {LfsPattern[]} patterns */
function untrackPatterns(m, patterns) {
  const names = patterns.map((p) => p.pattern).join(', ');
  return m.run(`Untrack ${names} from LFS`, async () => {
    for (const p of patterns) await m.lfs.untrack(p);
  }, { success: `${names} no longer tracked by LFS` });
}

/** Paths of `changes` that exist in the repository (not unversioned). @param {FileChange[]} changes */
const lockable = (changes) => changes.filter((c) => c.type !== 'untracked' && !c.nestedRepo).map((c) => c.path);

/** Lock: `git lfs lock` of each file. @param {RepoModel} m @param {FileChange[]} changes */
async function lockFiles(m, changes) {
  if (!(await needLfs(m))) return;
  const paths = lockable(changes);
  if (!paths.length) return;
  if (m.lfsLocks === null) {
    vscode.window.showWarningMessage('The remote does not support Git LFS file locking (or cannot be reached).');
    return;
  }
  await m.run(paths.length === 1 ? `Lock ${paths[0]}` : `Lock ${paths.length} files`, async () => {
    for (const p of paths) await m.lfs.lock(p);
  }, { success: `${paths.length} file(s) locked`, refresh: false });
  await m.refreshLfsLocks(true);
}

/**
 * Unlock: `git lfs unlock`; a lock held by someone else is only released
 * with --force after a confirmation.
 * @param {RepoModel} m @param {FileChange[]} changes
 */
async function unlockFiles(m, changes) {
  if (!(await needLfs(m))) return;
  const paths = lockable(changes);
  if (!paths.length) return;
  const locks = m.lfsLocks || new Map();
  const theirs = paths.filter((p) => locks.has(p) && locks.get(p).mine === false);
  const force = new Set();
  if (theirs.length) {
    const owners = [...new Set(theirs.map((p) => locks.get(p).owner || 'another user'))].join(', ');
    const ok = await vscode.window.showWarningMessage(`Force unlock ${theirs.length === 1 ? theirs[0] : `${theirs.length} files`}?`,
      { modal: true, detail: `Locked by ${owners}. Their lock is removed (git lfs unlock --force).` }, 'Force Unlock');
    if (!ok) return;
    theirs.forEach((p) => force.add(p));
  }
  /** Files git-lfs refused because the lock belongs to someone else. @type {string[]} */
  const refused = [];
  const unlock = async (list) => {
    for (const p of list) {
      try {
        await m.lfs.unlock(p, force.has(p));
      } catch (e) {
        if (!force.has(p) && e instanceof GitError && /owned by|--force|another user|not the owner/i.test(e.message)) refused.push(p);
        else throw e;
      }
    }
  };
  await m.run(paths.length === 1 ? `Unlock ${paths[0]}` : `Unlock ${paths.length} files`, () => unlock(paths),
    { success: 'Unlocked', refresh: false });
  if (refused.length) {
    const ok = await vscode.window.showWarningMessage(`${refused.length === 1 ? refused[0] : `${refused.length} files`} locked by another user. Force unlock?`,
      { modal: true, detail: 'Their lock is removed (git lfs unlock --force).' }, 'Force Unlock');
    if (ok) {
      refused.forEach((p) => force.add(p));
      const again = refused.splice(0);
      await m.run('Force unlock', () => unlock(again), { success: 'Unlocked', refresh: false });
    }
  }
  await m.refreshLfsLocks(true);
}

/** LFS ▸ Prune: the objects `git lfs prune --dry-run` lists, then a confirmation. @param {RepoModel} m */
async function prune(m) {
  if (!(await needLfs(m))) return;
  /** @type {string[]} */
  let lines = [];
  const ok = await m.run('LFS prune (dry run)', async () => { lines = await m.lfs.prune(true); }, { refresh: false });
  if (!ok) return;
  const r = parsePruneDryRun(lines.join('\n'));
  if (!r.objects.length) {
    return vscode.window.showInformationMessage(`Nothing to prune${r.summary ? `: ${r.summary}` : ''}.`);
  }
  const shown = r.objects.slice(0, 12).map((o) => `${o.oid.slice(0, 16)}… (${o.size})`);
  if (r.objects.length > shown.length) shown.push(`… ${r.objects.length - shown.length} more`);
  const go = await vscode.window.showWarningMessage(`Prune ${r.objects.length} local LFS object(s)?`, {
    modal: true,
    detail: `${r.summary ? `${r.summary}\n\n` : ''}Old objects not referenced by recent commits and already pushed are deleted from the local LFS storage:\n${shown.join('\n')}`,
  }, 'Prune');
  if (go) await m.run('LFS prune', () => m.lfs.prune(false), { success: `${r.objects.length} LFS object(s) pruned`, refresh: false });
}

/**
 * LFS ▸ Show Tracked Patterns: the patterns of every .gitattributes, with
 * an Untrack button; picking one opens its .gitattributes; "Track Pattern…"
 * adds one.
 * @param {RepoModel} m
 */
async function showTrackedPatterns(m) {
  if (!(await needLfs(m))) return;
  const untrackButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Untrack from LFS' };
  const qp = vscode.window.createQuickPick();
  qp.title = `Git LFS Tracked Patterns · ${m.name}`;
  qp.placeholder = 'Patterns stored in Git LFS (git lfs track)';
  qp.matchOnDescription = true;
  const load = async () => {
    qp.busy = true;
    const patterns = await m.lfs.trackedPatterns().catch(() => []);
    qp.items = /** @type {any[]} */ ([
      { label: '$(add) Track Pattern…', id: 'add' },
      { label: patterns.length ? 'Tracked' : 'No pattern is tracked', kind: vscode.QuickPickItemKind.Separator },
      ...patterns.map((p) => ({ label: p.pattern, description: `${p.source}${p.lockable ? ' · lockable' : ''}`, buttons: [untrackButton], pattern: p })),
    ]);
    qp.busy = false;
  };
  qp.onDidTriggerItemButton(async (e) => {
    const p = /** @type {any} */ (e.item).pattern;
    if (!p) return;
    const ok = await vscode.window.showWarningMessage(`Untrack ${p.pattern} from LFS?`,
      { modal: true, detail: `It is removed from ${p.source}. Versions already committed stay in LFS.` }, 'Untrack');
    if (!ok) return;
    await untrackPatterns(m, [p]);
    await load();
    qp.show();
  });
  qp.onDidAccept(async () => {
    const it = /** @type {any} */ (qp.selectedItems[0]);
    if (!it) return;
    qp.hide();
    if (it.id === 'add') {
      const pattern = await vscode.window.showInputBox({
        title: 'Track Pattern with LFS', prompt: 'Pattern, e.g. *.psd or assets/**', validateInput: (v) => (v.trim() ? null : 'Enter a pattern'),
      });
      if (pattern) await m.run(`Track ${pattern.trim()} with LFS`, () => m.lfs.track(pattern.trim()), { success: `${pattern.trim()} tracked with LFS` });
      return;
    }
    if (it.pattern) await vscode.window.showTextDocument(vscode.Uri.file(path.join(m.root, it.pattern.source)));
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  await load();
}

/**
 * LFS commands of the palette and the Commit view menu, the LFS diff
 * content provider and the `gitTools.lfsAvailable` context key (current
 * repository: LFS UI is hidden when git-lfs is missing).
 * @param {vscode.ExtensionContext} context
 * @param {import('./model').RepoManager} manager
 */
function registerLfsCommands(context, manager) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (node) => {
    const m = (node && node.model) || manager.current;
    if (!m) {
      vscode.window.showWarningMessage('No Git repository found in this workspace.');
      return;
    }
    return fn(m);
  }));
  const updateContext = async () => {
    const m = manager.current;
    const available = m ? await m.lfs.available().catch(() => false) : false;
    vscode.commands.executeCommand('setContext', 'gitTools.lfsAvailable', available);
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(LFS_SCHEME, new LfsContentProvider(manager)),
    manager.onDidChangeCurrent(() => updateContext()),
  );
  updateContext();

  reg('gitTools.lfs.pull', async (m) => {
    if (await needLfs(m)) await m.run('LFS pull', () => m.lfs.pull(), { success: 'LFS objects pulled' });
  });
  reg('gitTools.lfs.fetch', async (m) => {
    if (await needLfs(m)) await m.run('LFS fetch', () => m.lfs.fetch(), { success: 'LFS objects fetched', refresh: false });
  });
  reg('gitTools.lfs.prune', (m) => prune(m));
  reg('gitTools.lfs.showTrackedPatterns', (m) => showTrackedPatterns(m));
}

module.exports = {
  LFS_SCHEME, LfsContentProvider, lfsUri, registerLfsCommands, openLfsDiff, showLfsContentDiff, trackWithLfs, untrackFromLfs,
  lockFiles, unlockFiles, showTrackedPatterns,
};
