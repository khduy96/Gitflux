// @ts-check
'use strict';

const { parseDiff, buildContent } = require('../logic/lineSelection');
const { StaleSelectionError } = require('../errors');

/** @typedef {import('../ports').GitRepository} GitRepository */
/** @typedef {import('../entities').FileChange} FileChange */
/** @typedef {import('../entities').LineSelection} LineSelection */

/**
 * Content to commit for every change that has a line selection.
 * Throws StaleSelectionError when a file changed since its lines were selected.
 * @param {GitRepository} repo
 * @param {FileChange[]} changes
 * @param {Map<string, LineSelection>} selections
 */
async function selectedLineContents(repo, changes, selections) {
  const result = [];
  for (const c of changes) {
    const sel = selections.get(c.path);
    if (!sel) continue;
    const parsed = parseDiff(await repo.fileDiff(c.path));
    if (parsed.signature !== sel.signature) throw new StaleSelectionError(c.path);
    const head = await repo.show('HEAD', c.path);
    result.push({ path: c.path, content: buildContent(head ? head.toString('utf8') : '', parsed, sel.excluded), parsed, sel });
  }
  return result;
}

module.exports = { selectedLineContents };
