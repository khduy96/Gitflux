// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { inlineBlameText, hoverMarkdown } = require('../domain/logic/blame');
const { modelOf, SHOW_IN_LOG, SHOW_DIFF, COPY_HASH } = require('./blame');

/**
 * Inline blame: "author, 3 days ago • summary" faded after the line with
 * the cursor (one git blame -L per line, cached per document version), with
 * the Annotate hover (full message, Show in Log / Show Diff / Copy Hash) over
 * it. Off on documents that show the Annotate column.
 *
 * @typedef {import('../domain/entities').BlameCommit} BlameCommit
 */

const SETTING = 'inlineBlame.enabled';
const DELAY_MS = 250;
/** Lines kept per document version. */
const CACHE_LINES = 500;

/**
 * @param {vscode.ExtensionContext} context
 * @param {import('./model').RepoManager} manager
 * @param {{isAnnotated: (doc: vscode.TextDocument) => boolean}} annotate
 */
function registerInlineBlame(context, manager, annotate) {
  const type = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 3em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const enabled = () => vscode.workspace.getConfiguration('gitTools').get(SETTING, true);

  /** Blamed lines of the current version of each document. @type {Map<string, {version: number, lines: Map<number, BlameCommit|null>}>} */
  const cache = new Map();
  /** Line shown, for the hover. @type {{doc: vscode.TextDocument, line: number, commit: BlameCommit, root: string}|null} */
  let shown = null;
  /** @type {vscode.TextEditor|null} */
  let decorated = null;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  let gen = 0;

  const clear = () => {
    shown = null;
    if (decorated) decorated.setDecorations(type, []);
    decorated = null;
  };

  const cached = (/** @type {vscode.TextDocument} */ doc) => {
    const key = doc.uri.toString();
    let c = cache.get(key);
    if (!c || c.version !== doc.version || c.lines.size > CACHE_LINES) {
      c = { version: doc.version, lines: new Map() };
      cache.set(key, c);
    }
    return c;
  };

  const show = async (/** @type {vscode.TextEditor} */ editor, /** @type {number} */ g) => {
    const doc = editor.document;
    const line = editor.selection.active.line;
    const m = modelOf(manager, doc.uri.fsPath);
    if (!m) return;
    const c = cached(doc);
    let commit = c.lines.get(line);
    if (commit === undefined) {
      const rel = path.relative(m.root, doc.uri.fsPath).replace(/\\/g, '/');
      try {
        const blame = await m.repo.blame(rel, doc.isDirty ? doc.getText() : undefined, { start: line + 1, end: line + 1 });
        const l = blame.lines[0];
        commit = (l && blame.commits.get(l.hash)) || null;
      } catch {
        // Not committed yet, outside the repository, line past the end…: nothing to show.
        commit = null;
      }
      c.lines.set(line, commit);
    }
    if (g !== gen || !commit || vscode.window.activeTextEditor !== editor || editor.selection.active.line !== line) return;
    const end = doc.lineAt(line).range.end;
    clear();
    editor.setDecorations(type, [{
      range: new vscode.Range(end, end),
      renderOptions: { after: { contentText: inlineBlameText(commit) } },
    }]);
    decorated = editor;
    shown = { doc, line, commit, root: m.root };
  };

  const update = () => {
    const g = ++gen;
    if (timer) clearTimeout(timer);
    const editor = vscode.window.activeTextEditor;
    if (!enabled() || !editor || editor.document.uri.scheme !== 'file' || editor.selections.length !== 1 ||
        annotate.isAnnotated(editor.document)) {
      clear();
      return;
    }
    // The old text would sit on the wrong line while typing or moving.
    if (shown && (shown.doc !== editor.document || shown.line !== editor.selection.active.line)) clear();
    timer = setTimeout(() => { show(editor, g); }, DELAY_MS);
  };

  const hoverProvider = {
    async provideHover(/** @type {vscode.TextDocument} */ doc, /** @type {vscode.Position} */ pos) {
      const s = shown;
      if (!s || s.doc !== doc || s.line !== pos.line || pos.character < doc.lineAt(pos.line).range.end.character) return undefined;
      const m = manager.get(s.root);
      const message = s.commit.uncommitted || !m ? '' : await m.repo.commitBody(s.commit.hash).catch(() => '');
      const md = new vscode.MarkdownString(hoverMarkdown(s.commit, message, s.root));
      md.isTrusted = { enabledCommands: [SHOW_IN_LOG, SHOW_DIFF, COPY_HASH] };
      return new vscode.Hover(md);
    },
  };

  context.subscriptions.push(
    type,
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
    vscode.window.onDidChangeTextEditorSelection(() => update()),
    vscode.window.onDidChangeActiveTextEditor(() => update()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (shown && e.document === shown.doc && e.contentChanges.length) update();
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => cache.delete(doc.uri.toString())),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`gitTools.${SETTING}`)) update(); }),
    // HEAD moved (commit, checkout…): every blame may have changed.
    manager.onDidChange((what) => {
      if (what !== 'refs' && what !== 'log') return;
      cache.clear();
      update();
    }),
    vscode.commands.registerCommand('gitTools.toggleInlineBlame', async () => {
      const on = !enabled();
      await vscode.workspace.getConfiguration('gitTools').update(SETTING, on, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Inline blame ${on ? 'on' : 'off'}`, 3000);
    }),
    { dispose: () => { if (timer) clearTimeout(timer); } },
  );
  update();
}

module.exports = { registerInlineBlame };
