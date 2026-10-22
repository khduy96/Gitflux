// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { openCommitDiff } = require('./diff');
const { annotationLines, hoverMarkdown } = require('../domain/logic/blame');

/**
 * Annotate with Git Blame: per-line `short-hash  author  date` before each
 * line of an editor, colored by age (oldest → newest like the Flutter app's
 * blame view), with a hover (full message, Show in Log / Show Diff) and a
 * click on the annotation selecting the commit in the Log.
 *
 * @typedef {import('./model').RepoModel} RepoModel
 * @typedef {import('./model').RepoManager} RepoManager
 * @typedef {import('../domain/entities').Blame} Blame
 * @typedef {ReturnType<typeof annotationLines>[number]} Annotation
 * @typedef {{
 *   doc: vscode.TextDocument, model: RepoModel, rel: string, blame: Blame,
 *   items: Annotation[], byLine: Map<number, Annotation>,
 *   timer: NodeJS.Timeout|null, running: boolean, again: boolean, subs: vscode.Disposable[],
 * }} AnnotateState
 */

const BUCKETS = 10;
const AUTHOR_WIDTH = 12;
const DEBOUNCE_MS = 500;
const CONTEXT_KEY = 'gitTools.annotated';
const SHOW_IN_LOG = 'gitTools.blame.showInLog';
const SHOW_DIFF = 'gitTools.blame.showDiff';
const COPY_HASH = 'gitTools.blame.copyHash';

/** Age colors, translucent so they work on light and dark themes. */
const OLDEST = [128, 128, 128, 0.06];
const NEWEST = [56, 132, 255, 0.34];
const BG = Array.from({ length: BUCKETS }, (_, i) => {
  const t = i / (BUCKETS - 1);
  const v = OLDEST.map((a, k) => a + (NEWEST[k] - a) * t);
  return `rgba(${Math.round(v[0])}, ${Math.round(v[1])}, ${Math.round(v[2])}, ${v[3].toFixed(3)})`;
});

/** Finds the repository of a file: the longest root containing it. */
function modelOf(manager, fsPath) {
  const file = process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  const norm = (r) => (process.platform === 'win32' ? r.toLowerCase() : r);
  return manager.list().filter((m) => file.startsWith(norm(m.root) + path.sep))
    .sort((a, b) => b.root.length - a.root.length)[0] || null;
}

/** git's error line (the "fatal:" one rather than a warning), without its prefix. */
function firstLine(e) {
  const lines = String((e && e.message) || e).split('\n').map((l) => l.trim()).filter(Boolean);
  const s = lines.find((l) => /^(fatal|error):/.test(l)) || lines[0] || 'git blame failed';
  return s.replace(/^(fatal|error):\s*/, '');
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {RepoManager} manager
 * @param {import('./logView').LogViewProvider} logView
 */
function registerBlame(context, manager, logView) {
  /** @type {Map<string, AnnotateState>} key: document uri */
  const states = new Map();
  /** Full commit messages for the hover. @type {Map<string, Promise<string>>} */
  const bodies = new Map();
  // Every style is on the decoration instances: VS Code does not merge a
  // type's `before` options with per-instance `before` options.
  const type = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  const keyOf = (/** @type {vscode.TextDocument} */ doc) => doc.uri.toString();

  const updateContext = () => {
    const ed = vscode.window.activeTextEditor;
    vscode.commands.executeCommand('setContext', CONTEXT_KEY, !!ed && states.has(keyOf(ed.document)));
  };

  /** Decorations of one editor from the annotations of its document. */
  const decorate = (/** @type {vscode.TextEditor} */ editor, /** @type {AnnotateState|undefined} */ st) => {
    if (!st) return editor.setDecorations(type, []);
    const width = st.items.length ? st.items[0].text.length : AUTHOR_WIDTH + 22;
    const style = (text, bg, italic) => ({
      contentText: text.replace(/ /g, ' '),
      backgroundColor: bg,
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: italic ? 'italic' : 'normal',
      width: `${width + 2}ch`,
      height: '100%',
      margin: '0 1.5ch 0 0',
      // The usual way to add CSS the API does not expose.
      textDecoration: 'none; white-space: pre; box-sizing: border-box; padding: 0 1ch',
    });
    /** @type {vscode.DecorationOptions[]} */
    const list = [];
    const n = editor.document.lineCount;
    for (let line = 0; line < n; line++) {
      const a = st.byLine.get(line);
      // Lines git does not know (e.g. typed since the last run) keep the code column aligned.
      const before = a ? style(a.text, BG[a.bucket], a.uncommitted) : style(' '.repeat(width), undefined, false);
      list.push({ range: new vscode.Range(line, 0, line, 0), renderOptions: { before } });
    }
    editor.setDecorations(type, list);
  };

  const decorateAll = (/** @type {vscode.TextDocument} */ doc) => {
    const st = states.get(keyOf(doc));
    for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) decorate(ed, st);
  };

  /** Runs git blame of the document (its buffer when dirty). */
  const blameOf = async (/** @type {AnnotateState|{doc: vscode.TextDocument, model: RepoModel, rel: string}} */ st) => (
    st.doc.isDirty ? st.model.repo.blame(st.rel, st.doc.getText()) : st.model.repo.blame(st.rel));

  const setBlame = (/** @type {AnnotateState} */ st, /** @type {Blame} */ blame) => {
    st.blame = blame;
    st.items = annotationLines(blame, { buckets: BUCKETS, authorWidth: AUTHOR_WIDTH });
    st.byLine = new Map(st.items.map((a) => [a.line, a]));
  };

  const stop = (/** @type {vscode.TextDocument} */ doc) => {
    const st = states.get(keyOf(doc));
    if (!st) return;
    states.delete(keyOf(doc));
    if (st.timer) clearTimeout(st.timer);
    st.subs.forEach((d) => d.dispose());
    decorateAll(doc);
    updateContext();
  };

  /** Re-runs blame after edits / saves / HEAD moves, one run at a time. */
  const refresh = async (/** @type {AnnotateState} */ st) => {
    st.timer = null;
    if (st.running) {
      st.again = true;
      return;
    }
    st.running = true;
    try {
      const version = st.doc.version;
      const blame = await blameOf(st);
      if (states.get(keyOf(st.doc)) !== st) return;
      // Edited meanwhile: the change event scheduled another run.
      if (st.doc.version !== version) return;
      setBlame(st, blame);
      decorateAll(st.doc);
    } catch (e) {
      if (states.get(keyOf(st.doc)) !== st) return;
      stop(st.doc);
      vscode.window.showWarningMessage(`Annotations of ${path.basename(st.rel)} closed: ${firstLine(e)}`);
    } finally {
      st.running = false;
      if (st.again && states.get(keyOf(st.doc)) === st) {
        st.again = false;
        schedule(st);
      }
    }
  };

  const schedule = (/** @type {AnnotateState} */ st, delay = DEBOUNCE_MS) => {
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => { refresh(st); }, delay);
  };

  /** The editor to annotate from the command argument (opened when needed). */
  const targetEditor = async (arg) => {
    /** @type {vscode.Uri|undefined} */
    let uri;
    if (arg instanceof vscode.Uri) uri = arg;
    else if (arg && arg.model && typeof arg.path === 'string') uri = vscode.Uri.file(path.join(arg.model.root, arg.path));
    else return vscode.window.activeTextEditor;
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.toString() === uri.toString()) return active;
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (visible) return vscode.window.showTextDocument(visible.document, visible.viewColumn);
    if (uri.scheme === 'file') {
      try {
        if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
          vscode.window.showInformationMessage('Annotate with Git Blame works on files, not folders.');
          return undefined;
        }
      } catch {
        vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} does not exist in the working tree.`);
        return undefined;
      }
    }
    return vscode.window.showTextDocument(uri);
  };

  /** gitTools.annotate: toggles the annotations of an editor's document. */
  const annotate = async (arg) => {
    const editor = await targetEditor(arg);
    if (!editor) {
      if (!arg) vscode.window.showInformationMessage('Open a file to annotate it with Git Blame.');
      return;
    }
    const doc = editor.document;
    if (states.has(keyOf(doc))) return stop(doc);
    if (doc.uri.scheme !== 'file') {
      vscode.window.showInformationMessage('Only files of a Git working tree can be annotated.');
      return;
    }
    const model = (arg && arg.model && typeof arg.path === 'string' ? arg.model : null) || modelOf(manager, doc.uri.fsPath);
    if (!model) {
      vscode.window.showInformationMessage(`${path.basename(doc.uri.fsPath)} is not in a Git repository.`);
      return;
    }
    const rel = path.relative(model.root, doc.uri.fsPath).replace(/\\/g, '/');
    let blame;
    try {
      blame = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Git Blame ${path.basename(rel)}` },
        () => blameOf({ doc, model, rel }),
      );
    } catch (e) {
      const msg = firstLine(e);
      if (/no such path|not tracked|outside repository/i.test(msg)) {
        vscode.window.showInformationMessage(`${path.basename(rel)} is not committed yet: nothing to annotate.`);
      } else if (/no such ref: HEAD|no commits|bad revision 'HEAD'|ambiguous argument 'HEAD'/i.test(msg)) {
        vscode.window.showInformationMessage('The repository has no commits yet: nothing to annotate.');
      } else {
        vscode.window.showWarningMessage(`Cannot annotate ${path.basename(rel)}: ${msg}`);
      }
      return;
    }
    // Toggled twice while git was running, or closed meanwhile.
    if (states.has(keyOf(doc)) || doc.isClosed) return;
    /** @type {AnnotateState} */
    const st = {
      doc, model, rel, blame, items: [], byLine: new Map(), timer: null, running: false, again: false, subs: [],
    };
    setBlame(st, blame);
    // The edit made since the run started is caught by the change listener.
    st.subs.push(model.onDidChange((w) => { if (w === 'refs' || w === 'log') schedule(st); }));
    states.set(keyOf(doc), st);
    decorateAll(doc);
    updateContext();
  };

  const showInLog = async (arg) => {
    const a = Array.isArray(arg) ? arg[0] : arg;
    const m = a && manager.get(a.root);
    if (!m || !a.hash) return;
    if (m !== manager.current) await manager.setCurrent(m);
    await logView.showCommit(a.hash);
  };

  const showDiff = async (arg) => {
    const a = Array.isArray(arg) ? arg[0] : arg;
    const m = a && manager.get(a.root);
    if (!m || !a.hash || !a.path) return;
    try {
      let parent = a.previous || null;
      if (!parent) {
        const c = await m.repo.commitInfo(a.hash);
        if (!c) return vscode.window.showWarningMessage(`Commit ${a.hash.slice(0, 8)} no longer exists.`);
        parent = c.parents[0] || null;
      }
      /** @type {import('../domain/entities').FileChange} */
      let f = /** @type {any} */ ({ path: a.path, type: parent ? 'modified' : 'added' });
      if (parent) {
        // The file may have been renamed in that commit: its old path is on the left.
        const changed = await m.repo.changedFiles(parent, a.hash).catch(() => []);
        f = changed.find((x) => x.path === a.path) || f;
      }
      await openCommitDiff(m, f, a.hash, parent, false);
    } catch (e) {
      vscode.window.showWarningMessage(`Cannot show the diff: ${firstLine(e)}`);
    }
  };

  const copyHash = async (arg) => {
    const a = Array.isArray(arg) ? arg[0] : arg;
    if (!a || !a.hash) return;
    await vscode.env.clipboard.writeText(a.hash);
    vscode.window.setStatusBarMessage(`$(check) Copied ${a.hash.slice(0, 8)}`, 3000);
  };

  /** Full message of a commit (cached), the summary when git fails. */
  const bodyOf = (st, c) => {
    const key = `${st.model.root}\n${c.hash}`;
    let p = bodies.get(key);
    if (!p) {
      p = st.model.repo.commitBody(c.hash).catch(() => c.summary);
      bodies.set(key, p);
    }
    return p;
  };

  /** Hover of the annotation: VS Code reports column 0 over the `before` text. */
  const hoverProvider = {
    async provideHover(/** @type {vscode.TextDocument} */ doc, /** @type {vscode.Position} */ pos) {
      const st = states.get(keyOf(doc));
      if (!st || pos.character !== 0) return undefined;
      const a = st.byLine.get(pos.line);
      const c = a && st.blame.commits.get(a.hash);
      if (!c) return undefined;
      const message = c.uncommitted ? '' : await bodyOf(st, c);
      if (states.get(keyOf(doc)) !== st) return undefined;
      const md = new vscode.MarkdownString(hoverMarkdown(c, message, st.model.root));
      md.isTrusted = { enabledCommands: [SHOW_IN_LOG, SHOW_DIFF, COPY_HASH] };
      return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, 0));
    },
  };

  context.subscriptions.push(
    type,
    vscode.commands.registerCommand('gitTools.annotate', annotate),
    vscode.commands.registerCommand(SHOW_IN_LOG, showInLog),
    vscode.commands.registerCommand(SHOW_DIFF, showDiff),
    vscode.commands.registerCommand(COPY_HASH, copyHash),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const st = states.get(keyOf(e.document));
      if (st && e.contentChanges.length) schedule(st);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const st = states.get(keyOf(doc));
      if (st) schedule(st, 50);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => stop(doc)),
    // Decorations belong to editors: re-apply when an annotated document shows again.
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const ed of editors) {
        const st = states.get(keyOf(ed.document));
        if (st) decorate(ed, st);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateContext()),
    // A click on the annotation puts the cursor at column 0 of its line.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse || e.selections.length !== 1) return;
      const sel = e.selections[0];
      if (!sel.isEmpty || sel.active.character !== 0) return;
      const st = states.get(keyOf(e.textEditor.document));
      const a = st && st.byLine.get(sel.active.line);
      if (!st || !a || a.uncommitted || st.model !== manager.current) return;
      logView.revealIfVisible(a.hash);
    }),
    {
      dispose: () => {
        for (const st of states.values()) {
          if (st.timer) clearTimeout(st.timer);
          st.subs.forEach((d) => d.dispose());
        }
        states.clear();
      },
    },
  );
  updateContext();
  return {
    /** The document shows the Annotate column (the inline blame stays off there). */
    isAnnotated: (/** @type {vscode.TextDocument} */ doc) => states.has(keyOf(doc)),
  };
}

module.exports = { registerBlame, modelOf, firstLine, SHOW_IN_LOG, SHOW_DIFF, COPY_HASH };
