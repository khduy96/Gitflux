// @ts-check
'use strict';

const { filteredPatch } = require('../logic/lineSelection');
const { selectedLineContents } = require('./selectedLineContents');

/** @typedef {import('../ports').GitRepository} GitRepository */
/** @typedef {import('../entities').FileChange} FileChange */

const MAX_FILE_DIFF = 40000;
const MAX_TOTAL_DIFF = 150000;

/**
 * Writes a commit message for the checked changes (or the commit being
 * amended) with the configured AI model.
 */
class GenerateCommitMessage {
  /**
   * @param {GitRepository} repo
   * @param {import('../ports').CreateAi} createAi
   */
  constructor(repo, createAi) {
    this.repo = repo;
    this.createAi = createAi;
    /** @type {import('../ports').CommitMessageAi|null} */
    this.ai = null;
  }

  cancel() {
    if (this.ai) this.ai.cancel();
  }

  /**
   * `amend` includes the last commit's own changes. Throws AiError.
   * @param {{status: import('../entities').Status, changes: FileChange[], amend: boolean,
   *   lineSelections: Map<string, import('../entities').LineSelection>, config: import('../entities').AiConfig,
   *   onText: (text: string) => void, onInfo?: (text: string) => void}} o
   * @returns {Promise<{message: string, omitted: string[]}>}
   */
  async run({ status, changes, amend, lineSelections, config, onText, onInfo }) {
    const repo = this.repo;
    let base = status.head ? 'HEAD' : null;
    /** @type {FileChange[]} */
    let files = [...changes];
    let amendOf = null;
    if (amend) {
      amendOf = await repo.lastCommitMessage();
      const hasParent = await repo.refExists('HEAD~1');
      base = hasParent ? 'HEAD~1' : null;
      const known = new Set(files.map((f) => f.path));
      for (const f of await repo.changedFiles(hasParent ? 'HEAD~1' : null, 'HEAD')) {
        if (!known.has(f.path)) files.push(f);
      }
    }
    if (!base) files = files.map((f) => ({ path: f.path, type: /** @type {const} */ ('untracked') }));

    const perFile = await repo.diffPerFile(files, base);
    // Files committed line by line: describe only the selected lines.
    if (!amend && lineSelections.size) {
      try {
        for (const p of await selectedLineContents(repo, changes, lineSelections)) {
          perFile.set(p.path, filteredPatch(p.path, p.parsed, p.sel.excluded));
        }
      } catch { /* selection out of date: fall back to the full diff */ }
    }
    let diff = '';
    const omitted = [];
    for (const [file, text] of perFile) {
      if (text.length > MAX_FILE_DIFF || diff.length + text.length > MAX_TOTAL_DIFF) {
        omitted.push(file);
        diff += `diff of ${file} omitted: too large (${text.split('\n').length} lines)\n`;
      } else {
        diff += text;
      }
    }

    const ai = this.ai = this.createAi(config.provider, { apiKey: config.apiKey, model: config.model });
    if (onInfo) onInfo(`Generating commit message with ${config.model} (${files.length} files, ${diff.length} chars of diff)…`);
    try {
      const message = await ai.generate({
        files: files.map((f) => `${f.type}: ${f.path}`),
        diff,
        branch: status.branch || '',
        recentSubjects: status.head ? await repo.recentSubjects() : [],
        language: config.language || '',
        instructions: config.instructions || '',
        amendOf,
      }, onText);
      return { message, omitted };
    } finally {
      this.ai = null;
    }
  }
}

module.exports = { GenerateCommitMessage };
