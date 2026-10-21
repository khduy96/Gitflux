// @ts-check
'use strict';

/**
 * Annotate (git blame): `git blame --porcelain` and the text of the
 * annotation shown before each line. Pure functions, no git.
 *
 * @typedef {import('../entities').BlameCommit} BlameCommit
 * @typedef {import('../entities').Blame} Blame
 */

/** Hash git uses for lines that are not committed yet. */
const UNCOMMITTED = /^0+$/;

/**
 * Parses `git blame --porcelain`: a header "<hash> <orig> <final> [<count>]"
 * per line, the commit fields the first time a commit appears, then the
 * line content after a tab.
 * @param {string} out
 * @returns {Blame}
 */
function parseBlamePorcelain(out) {
  /** @type {Map<string, BlameCommit>} */
  const commits = new Map();
  /** @type {{hash: string, line: number, origLine: number}[]} */
  const lines = [];
  /** @type {BlameCommit|null} */
  let current = null;
  let finalLine = 0;
  let origLine = 0;
  for (const raw of out.split('\n')) {
    if (raw.startsWith('\t')) {
      if (current) lines.push({ hash: current.hash, line: finalLine, origLine });
      continue;
    }
    const line = raw.replace(/\r$/, '');
    const header = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      const hash = header[1];
      origLine = parseInt(header[2], 10);
      finalLine = parseInt(header[3], 10);
      current = commits.get(hash) || null;
      if (!current) {
        current = {
          hash, author: '', email: '', time: 0, summary: '', previous: null, filename: '', uncommitted: UNCOMMITTED.test(hash),
        };
        commits.set(hash, current);
      }
      continue;
    }
    if (!current) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    switch (key) {
      case 'author': current.author = value; break;
      case 'author-mail': current.email = value.replace(/^<|>$/g, ''); break;
      case 'author-time': current.time = (parseInt(value, 10) || 0) * 1000; break;
      case 'summary': current.summary = value; break;
      case 'previous': current.previous = value.split(' ')[0] || null; break;
      case 'filename': current.filename = value; break;
      default: break;
    }
  }
  lines.sort((a, b) => a.line - b.line);
  return { commits, lines };
}

/** Cuts `s` to `width` characters with an ellipsis, padded to `width`. */
function fit(s, width) {
  const t = s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
  return t.padEnd(width, ' ');
}

/** YYYY-MM-DD in local time. */
function shortDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Annotation of one line: "1a2b3c4d  Jane Doe    2024-05-01", the author
 * cut to `authorWidth`. Lines not committed yet: "Not Committed Yet".
 * @param {BlameCommit} c
 * @param {number} [authorWidth]
 */
function annotationText(c, authorWidth = 12) {
  const width = 8 + 2 + authorWidth + 2 + 10;
  if (c.uncommitted) return fit('Not Committed Yet', width);
  return `${c.hash.slice(0, 8)}  ${fit(c.author, authorWidth)}  ${shortDate(c.time)}`;
}

/**
 * Age of each commit between the oldest (0) and the newest (1) commit of
 * the file, like the Flutter app's blame view; uncommitted lines are 1.
 * @param {Iterable<BlameCommit>} commits
 * @returns {Map<string, number>}
 */
function commitAges(commits) {
  const list = [...commits];
  const times = list.filter((c) => !c.uncommitted).map((c) => c.time);
  const min = times.length ? Math.min(...times) : 0;
  const max = times.length ? Math.max(...times) : 0;
  return new Map(list.map((c) => [c.hash, c.uncommitted ? 1 : max === min ? 1 : (c.time - min) / (max - min)]));
}

/**
 * Index (0 … buckets-1) of the age color of a commit.
 * @param {number} age 0 oldest … 1 newest
 * @param {number} buckets
 */
function ageBucket(age, buckets) {
  return Math.max(0, Math.min(buckets - 1, Math.round(age * (buckets - 1))));
}

/** YYYY-MM-DD HH:mm in local time. */
function fullDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shortDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * One annotation per blamed line, 0-based `line`: the text is shown only on
 * the first line of a run of consecutive lines of the same commit (like
 * IntelliJ), the others get blanks of the same width; `bucket` is the age
 * color (0 oldest … buckets-1 newest).
 * @param {Blame} blame
 * @param {{buckets?: number, authorWidth?: number}} [o]
 * @returns {{line: number, hash: string, text: string, bucket: number, first: boolean, uncommitted: boolean}[]}
 */
function annotationLines(blame, o = {}) {
  const buckets = o.buckets || 10;
  const ages = commitAges(blame.commits.values());
  /** @type {Map<string, string>} */
  const texts = new Map();
  const out = [];
  let prevHash = '';
  let prevLine = -2;
  for (const l of blame.lines) {
    const c = blame.commits.get(l.hash);
    if (!c) continue;
    let text = texts.get(c.hash);
    if (text === undefined) {
      text = annotationText(c, o.authorWidth);
      texts.set(c.hash, text);
    }
    const first = prevHash !== c.hash || prevLine !== l.line - 1;
    const age = ages.get(c.hash);
    out.push({
      line: l.line - 1,
      hash: c.hash,
      text: first ? text : ' '.repeat(text.length),
      bucket: ageBucket(age === undefined ? 1 : age, buckets),
      first,
      uncommitted: c.uncommitted,
    });
    prevHash = c.hash;
    prevLine = l.line;
  }
  return out;
}

/** Escapes text for Markdown (no links, emphasis, headings or HTML). */
function escapeMarkdown(s) {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, '\\$&');
}

/** `command:` link target for a Markdown hover (parentheses encoded too). */
function commandUri(command, arg) {
  const q = encodeURIComponent(JSON.stringify([arg])).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `command:${command}?${q}`;
}

/**
 * Markdown of the hover of an annotated line: short hash, author <email>,
 * date, the full message and the "Show in Log" / "Show Diff" links.
 * Lines not committed yet: "Not Committed Yet" without links.
 * @param {BlameCommit} c
 * @param {string} message full commit message ('' → the summary)
 * @param {string} root repository root, passed to the commands
 */
function hoverMarkdown(c, message, root) {
  if (c.uncommitted) return '**Not Committed Yet**';
  const author = escapeMarkdown(c.email ? `${c.author} <${c.email}>` : c.author);
  const body = escapeMarkdown((message || c.summary).trim()).replace(/\r?\n/g, '  \n');
  const links = [
    `[Show in Log](${commandUri('gitTools.blame.showInLog', { root, hash: c.hash })} "Select the commit in the Log")`,
    `[Show Diff](${commandUri('gitTools.blame.showDiff', {
      root, hash: c.hash, path: c.filename, previous: c.previous,
    })} "Changes of this file in the commit")`,
  ].join(' &nbsp;·&nbsp; ');
  return `\`${c.hash.slice(0, 8)}\` &nbsp; **${author}** &nbsp; ${fullDate(c.time)}\n\n${body}\n\n---\n\n${links}`;
}

module.exports = {
  parseBlamePorcelain, annotationText, commitAges, ageBucket, shortDate, UNCOMMITTED,
  fullDate, annotationLines, escapeMarkdown, commandUri, hoverMarkdown,
};
