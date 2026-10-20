// @ts-check
'use strict';

/** How the AI is asked to write commit messages, independent of the provider. */

const SYSTEM_PROMPT = `You write git commit messages for the changes a developer is about to commit.

Write the message the way an experienced engineer on this project would:
- First line: a concise summary of what the change does, in the imperative mood ("Add", "Fix", "Refactor"), at most 72 characters, no trailing period.
- If the change is more than trivial, add a blank line and then a short body explaining what changed and why, wrapped at about 72 characters. Bullet points are fine for several independent changes. Skip the body for small, self-explanatory changes.
- Follow the conventions visible in the project's recent commit subjects (for example a "feat:"/"fix:" prefix, ticket ids, capitalization, language) when they are consistent.
- Describe the intent of the change, not a file-by-file narration. Do not invent motivations that the diff does not support.

Reply with the commit message only: no preamble, no quotes, no Markdown code fences.`;

/**
 * @typedef {{files: string[], diff: string, branch?: string, recentSubjects?: string[],
 *   language?: string, instructions?: string, amendOf?: string|null}} CommitRequest
 */

/** @param {CommitRequest} r */
function buildPrompt(r) {
  const lines = [];
  if (r.language && r.language.trim()) lines.push(`Write the commit message in ${r.language.trim()}.`, '');
  if (r.instructions && r.instructions.trim()) {
    lines.push('Additional instructions from the developer:', r.instructions.trim(), '');
  }
  if (r.branch) lines.push(`Branch: ${r.branch}`);
  if (r.recentSubjects && r.recentSubjects.length) {
    lines.push('', 'Recent commit subjects in this repository (newest first):', ...r.recentSubjects.map((s) => `- ${s}`));
  }
  if (r.amendOf) lines.push('', 'This amends the previous commit, whose current message is:', r.amendOf);
  lines.push('', 'Files in this commit:', ...r.files, '', '<diff>', r.diff, '</diff>');
  return lines.join('\n');
}

/** Removes accidental code fences and surrounding whitespace. */
function clean(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
  }
  return t.trim();
}

module.exports = { SYSTEM_PROMPT, buildPrompt, clean };
