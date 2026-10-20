// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const { webviewHtml } = require('./webview');
const { hasConflictMarkers, parseConflicts, joinSegments } = require('../domain/logic/conflicts');

/**
 * Opens the three-way merge tool for a conflicted file.
 * @param {vscode.ExtensionContext} context
 * @param {import('./model').RepoModel} m
 * @param {import('../domain/entities').FileChange} change
 */
async function openMergeTool(context, m, change) {
  let text = m.repo.workingText(change.path);
  if (!hasConflictMarkers(text)) text = await m.repo.mergeFromStages(change.path);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const segments = parseConflicts(text);
  if (!segments.some((s) => s.kind === 'conflict')) {
    const ok = await vscode.window.showInformationMessage(`${change.path} has no conflict markers. Mark it as resolved?`, 'Mark Resolved');
    if (ok) await m.run('Mark resolved', () => m.repo.markResolved(change.path));
    return;
  }

  const rebasing = m.status.state === 'rebasing';
  const panel = vscode.window.createWebviewPanel('gitTools.merge', `Merge: ${path.basename(change.path)}`,
    vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
  panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
    title: 'Merge',
    styles: ['merge.css'],
    scripts: ['common.js', 'merge.js'],
  });
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'ready') {
      panel.webview.postMessage({
        type: 'init',
        path: change.path,
        segments,
        left: rebasing ? 'Upstream (rebasing onto)' : `Yours (${m.status.branch || 'HEAD'})`,
        right: rebasing ? 'Your commit' : 'Theirs (incoming)',
      });
    } else if (msg.type === 'apply') {
      const content = joinSegments(segments, msg.resolutions, eol);
      panel.dispose();
      await m.run(`Resolve ${path.basename(change.path)}`, () => m.repo.markResolved(change.path, content), { success: `${change.path} resolved` });
      if (!m.status.changes.some((c) => c.type === 'conflicted')) {
        vscode.window.showInformationMessage('All conflicts resolved.', 'Continue').then((r) => {
          if (r) vscode.commands.executeCommand('gitTools.continueOperation');
        });
      }
    } else if (msg.type === 'cancel') {
      panel.dispose();
    }
  });
}

module.exports = { openMergeTool };
