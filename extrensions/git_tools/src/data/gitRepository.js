// @ts-check
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitError } = require('../domain/errors');
const { GitRunner, lit, pathspecs } = require('./gitRunner');
const { shQuote } = require('../domain/logic/rebaseTodo');
const { escapeBasicRegex, splitReflogSubject } = require('../domain/logic/history');
const { shelfStatus } = require('../domain/logic/shelf');
const { parsePatchStat, appliedWithConflicts } = require('../domain/logic/patch');
const { cleanEntries, cleanFlags, batchPathspecs } = require('../domain/logic/clean');
const { mergeArgs } = require('../domain/logic/merge');
const { parseWorktrees } = require('../domain/logic/worktree');
const { parseBisectRefs, bisectMarks, parseBisectLog, parseBisectVars } = require('../domain/logic/bisect');
const { parseBlamePorcelain } = require('../domain/logic/blame');
const {
  signArgs, SIGNING_CONFIG_REGEX, parseSigningConfig, makeSignature, tagVerification, hasTagSignature,
} = require('../domain/logic/signing');

const FS = '\x1f';
const RS = '\x1e';

/**
 * @typedef {import('../domain/entities').ChangeType} ChangeType
 * @typedef {import('../domain/entities').FileChange} FileChange
 * @typedef {import('../domain/entities').Submodule} Submodule
 * @typedef {import('../domain/entities').RepoState} RepoState
 * @typedef {import('../domain/entities').Status} Status
 * @typedef {import('../domain/entities').RefLabel} RefLabel
 * @typedef {import('../domain/entities').Commit} Commit
 * @typedef {import('../domain/entities').Branch} Branch
 * @typedef {import('../domain/entities').ReflogEntry} ReflogEntry
 */

const LETTER = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typeChanged', U: 'conflicted',
};

const LOG_FORMAT = `%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%cn${FS}%ct${FS}%D${FS}%s${RS}`;
const REFLOG_FORMAT = `%gd${FS}%H${FS}%gs${RS}`;

/** Splits into at most n fields, the last keeps the remainder. */
function splitN(s, sep, n) {
  const out = [];
  let start = 0;
  while (out.length < n - 1) {
    const i = s.indexOf(sep, start);
    if (i < 0) break;
    out.push(s.slice(start, i));
    start = i + sep.length;
  }
  out.push(s.slice(start));
  return out;
}

const byPath = (a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase());

/**
 * Submodule field of porcelain v2 ("N..." for files, "S<c><m><u>" for
 * submodules).
 * @returns {{newCommits: boolean, modifiedContent: boolean, untrackedContent: boolean}|undefined}
 */
function parseSubmoduleField(field) {
  if (!field || field.length !== 4 || field[0] !== 'S') return undefined;
  return { newCommits: field[1] === 'C', modifiedContent: field[2] === 'M', untrackedContent: field[3] === 'U' };
}

/** Parses `git status --porcelain=v2 -z --branch`. */
function parseStatus(out) {
  /** @type {Status} */
  const s = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, changes: [], state: 'normal' };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('# ')) {
      const f = e.slice(2).split(' ');
      if (f[0] === 'branch.oid') s.head = f[1] === '(initial)' ? null : f[1];
      else if (f[0] === 'branch.head') s.branch = f[1] === '(detached)' ? null : f.slice(1).join(' ');
      else if (f[0] === 'branch.upstream') s.upstream = f.slice(1).join(' ');
      else if (f[0] === 'branch.ab') {
        s.ahead = parseInt(f[1].slice(1), 10) || 0;
        s.behind = parseInt(f[2].slice(1), 10) || 0;
      }
      continue;
    }
    if (e[0] === '1') {
      const f = splitN(e, ' ', 9);
      const [x, y] = f[1];
      /** @type {ChangeType} */
      let type = 'modified';
      if (x === 'A') type = y === 'D' ? 'deleted' : 'added';
      else if (x === 'D' || y === 'D') type = 'deleted';
      else if (x === 'T' || y === 'T') type = 'typeChanged';
      s.changes.push({ path: f[8], type, submodule: parseSubmoduleField(f[2]), staged: x !== '.', unstaged: y !== '.' });
    } else if (e[0] === '2') {
      const f = splitN(e, ' ', 10);
      const orig = parts[++i];
      const [x, y] = f[1];
      s.changes.push({
        path: f[9], oldPath: orig, type: f[8].startsWith('C') ? 'copied' : 'renamed', submodule: parseSubmoduleField(f[2]),
        staged: x !== '.', unstaged: y !== '.',
      });
    } else if (e[0] === 'u') {
      const f = splitN(e, ' ', 11);
      s.changes.push({ path: f[10], type: 'conflicted', conflictCode: f[1], submodule: parseSubmoduleField(f[2]) });
    } else if (e[0] === '?') {
      // With --untracked-files=all git only reports a directory (trailing
      // slash) when it is a repository of its own: a nested repository.
      const p = e.slice(2);
      if (p.endsWith('/')) s.changes.push({ path: p.slice(0, -1), type: 'untracked', nestedRepo: true });
      else s.changes.push({ path: p, type: 'untracked' });
    }
  }
  s.changes.sort(byPath);
  return s;
}

/** Parses `%D` decorations produced with --decorate=full. */
function parseRefs(d) {
  /** @type {RefLabel[]} */
  const refs = [];
  if (!d.trim()) return refs;
  for (let r of d.split(', ')) {
    r = r.trim();
    if (r.startsWith('HEAD -> ')) {
      refs.push({ name: 'HEAD', kind: 'head' });
      r = r.slice(8);
    }
    if (r === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' });
    else if (r.startsWith('tag: ')) refs.push({ name: r.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag' });
    else if (r.startsWith('refs/heads/')) refs.push({ name: r.slice(11), kind: 'local' });
    else if (r.startsWith('refs/remotes/')) {
      if (!r.endsWith('/HEAD')) refs.push({ name: r.slice(13), kind: 'remote' });
    } else if (!r.startsWith('refs/stash') && !r.startsWith('refs/bisect/')) {
      // Bisect marks get their own labels (RepoModel.bisect), not ref chips.
      refs.push({ name: r, kind: 'local' });
    }
  }
  return refs;
}

/** @returns {Commit[]} */
function parseCommits(out) {
  const commits = [];
  for (let rec of out.split(RS)) {
    rec = rec.replace(/^\s+/, '');
    if (!rec) continue;
    const f = rec.split(FS);
    if (f.length < 9) continue;
    commits.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      email: f[3],
      time: parseInt(f[4], 10) * 1000,
      committer: f[5],
      commitTime: parseInt(f[6], 10) * 1000,
      refs: parseRefs(f[7]),
      subject: f.slice(8).join(FS),
    });
  }
  return commits;
}

/**
 * Parses `git reflog show` with REFLOG_FORMAT. git skips the entries whose
 * commit no longer exists, which leaves gaps in the selector numbers: they
 * come back as `missing` entries (hash filled in by Repository.reflog).
 * @param {string} out
 * @param {Map<number, number>} [times] entry time (ms) by selector number
 * @returns {ReflogEntry[]}
 */
function parseReflog(out, times = new Map()) {
  /** @type {ReflogEntry[]} */
  const entries = [];
  for (let rec of out.split(RS)) {
    rec = rec.replace(/^\s+/, '');
    if (!rec) continue;
    const f = splitN(rec, FS, 3);
    const m = f.length === 3 ? /^(.*)@\{(\d+)\}$/.exec(f[0]) : null;
    if (!m) continue;
    const index = parseInt(m[2], 10);
    for (let i = entries.length ? entries[entries.length - 1].index + 1 : 0; i < index; i++) {
      entries.push({ selector: `${m[1]}@{${i}}`, index: i, hash: '', action: '', message: '', time: null, missing: true });
    }
    entries.push({ selector: f[0], index, hash: f[1], ...splitReflogSubject(f[2]), time: times.get(index) ?? null, missing: false });
  }
  return entries;
}

/** Parses `--name-status -z` output. */
function parseNameStatus(out) {
  const parts = out.split('\0');
  /** @type {FileChange[]} */
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    /** @type {ChangeType} */
    const type = LETTER[s[0]] || 'modified';
    if (type === 'renamed' || type === 'copied') {
      const oldPath = parts[++i];
      files.push({ path: parts[++i], oldPath, type });
    } else {
      files.push({ path: parts[++i], type });
    }
  }
  return files.filter((f) => f.path).sort(byPath);
}

/**
 * GitRepository (see domain/ports.js) backed by the git command line.
 * @implements {import('../domain/ports').GitRepository}
 */
class Repository {
  /**
   * @param {string} root
   * @param {ConstructorParameters<typeof GitRunner>[1]} [opts]
   */
  constructor(root, opts) {
    this.root = root;
    this.git = new GitRunner(root, opts);
    /** @type {string|undefined} */
    this._gitDir = undefined;
    /** @type {string|undefined} */
    this._rebaseStateDir = undefined;
    /** @type {string|undefined} */
    this._commonDir = undefined;
  }

  get name() {
    return path.basename(this.root);
  }

  async gitDir() {
    if (!this._gitDir) {
      this._gitDir = path.normalize((await this.git.run(['rev-parse', '--absolute-git-dir'])).trim());
    }
    return this._gitDir;
  }

  // ---------------------------------------------------------------- status

  /** @returns {Promise<Status>} */
  async status() {
    const out = await this.git.run([
      '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all',
    ]);
    const s = parseStatus(out);
    s.state = await this.repoState();
    return s;
  }

  /** @returns {Promise<RepoState>} */
  async repoState() {
    const dir = await this.gitDir();
    const exists = (n) => fs.existsSync(path.join(dir, n));
    // git am and rebase share rebase-apply; "applying" marks git am.
    if (exists('rebase-apply/applying')) return 'applyingMailbox';
    if (exists('rebase-merge') || exists('rebase-apply')) return 'rebasing';
    if (exists('MERGE_HEAD')) return 'merging';
    if (exists('CHERRY_PICK_HEAD')) return 'cherryPicking';
    if (exists('REVERT_HEAD')) return 'reverting';
    return 'normal';
  }

  async pendingMergeMessage() {
    const f = path.join(await this.gitDir(), 'MERGE_MSG');
    if (!fs.existsSync(f)) return null;
    const text = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
    return text || null;
  }

  // ---------------------------------------------------------------- log

  /**
   * authors: substrings of the author name or email (case-insensitive, any
   * of them); since / until: git dates, on the committer date; search: only
   * commits whose diff adds or removes `text` (-S) or a line matching the
   * regex (-G). git applies the limit after filtering.
   * @param {import('../domain/ports').LogOptions} [o]
   * @returns {Promise<Commit[]>}
   */
  async log(o = {}) {
    const args = ['log', '--date-order', '--decorate=full', '-n', String(o.limit || 2000), `--format=${LOG_FORMAT}`];
    const authors = o.authors && o.authors.length ? o.authors : null;
    const search = o.search && o.search.text ? o.search : null;
    // Explicit --basic-regexp: the escaping holds whatever grep.patternType says.
    if (authors) args.push('--basic-regexp', ...authors.map((a) => `--author=${escapeBasicRegex(a)}`));
    if (o.since) args.push(`--since=${o.since}`);
    if (o.until) args.push(`--until=${o.until}`);
    if (search) args.push(`${search.regex ? '-G' : '-S'}${search.text}`);
    // -i applies to --author and to -S / -G alike: the content search
    // always ignores case, with or without a user filter.
    if (authors || search) args.push('--regexp-ignore-case');
    if (o.revisions && o.revisions.length) args.push(...o.revisions);
    else args.push(o.path ? 'HEAD' : '--all');
    if (o.path) args.push('--follow', '--', lit(o.path));
    const r = await this.git.raw(args);
    if (r.code !== 0) {
      if (/does not have any commits|unknown revision|bad default revision/.test(r.stderr)) return [];
      throw new GitError(args, r.code, r.stderr, r.stdout);
    }
    return parseCommits(r.stdout);
  }

  /** One commit, also one that no ref reaches; null when it does not exist. */
  async commitInfo(rev) {
    const r = await this.git.raw(['log', '-1', '--no-walk', '--decorate=full', `--format=${LOG_FORMAT}`, rev, '--']);
    return r.code === 0 ? parseCommits(r.stdout)[0] || null : null;
  }

  /**
   * Reflog of `ref` (HEAD or refs/heads/<branch>), newest first. Entries
   * whose commit no longer exists come back with `missing` set.
   * @returns {Promise<ReflogEntry[]>}
   */
  async reflog(ref = 'HEAD', limit = 500) {
    const base = ['reflog', 'show', '-n', String(limit)];
    // %gd is the selector number, or the entry time with --date: two passes.
    const [r, t] = await Promise.all([
      this.git.raw([...base, `--format=${REFLOG_FORMAT}`, ref, '--']),
      this.git.raw([...base, '--date=unix', `--format=%gd${RS}`, ref, '--']),
    ]);
    if (r.code !== 0) {
      if (/unknown revision|ambiguous argument|bad revision|does not have any commits|no reflog/i.test(r.stderr)) return [];
      throw new GitError([...base, ref], r.code, r.stderr, r.stdout);
    }
    const number = (s) => {
      const m = /@\{(\d+)\}$/.exec(s.trim());
      return m ? parseInt(m[1], 10) : null;
    };
    const selectors = r.stdout.split(RS).map((s) => s.replace(/^\s+/, '')).filter(Boolean).map((s) => number(s.split(FS)[0]));
    const stamps = t.code === 0 ? t.stdout.split(RS).filter((s) => s.trim()).map(number) : [];
    /** @type {Map<number, number>} */
    const times = new Map();
    if (stamps.length === selectors.length) {
      selectors.forEach((n, i) => { if (n !== null && stamps[i] !== null) times.set(n, stamps[i] * 1000); });
    }
    const entries = parseReflog(r.stdout, times);
    // git skips the entries whose commit no longer exists (gaps, or the
    // oldest ones): the reflog file still has their hash, subject and time.
    const raw = await this.reflogFile(ref);
    if (raw) {
      const prefix = entries.length ? entries[0].selector.replace(/@\{\d+\}$/, '') : ref.replace(/^refs\/heads\//, '');
      for (let i = entries.length ? entries[entries.length - 1].index + 1 : 0; i < raw.length && entries.length < limit; i++) {
        entries.push({ selector: `${prefix}@{${i}}`, index: i, hash: '', action: '', message: '', time: null, missing: true });
      }
      for (const e of entries) {
        const line = e.missing ? raw[e.index] : null;
        if (line) Object.assign(e, { hash: line.hash, ...splitReflogSubject(line.subject), time: line.time });
      }
    }
    const missing = entries.filter((e) => e.missing && !e.hash);
    if (missing.length) {
      // The reflog still records their hash.
      const out = await this.git.run(['rev-parse', ...missing.map((e) => e.selector)], { allowFailure: true });
      const hashes = out.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l));
      if (hashes.length === missing.length) missing.forEach((e, i) => { e.hash = hashes[i]; });
    }
    return entries;
  }

  /**
   * Lines of the reflog file of `ref`, newest first (index = selector
   * number), or null when there is none (e.g. the reftable backend).
   * @returns {Promise<{hash: string, time: number|null, subject: string}[]|null>}
   */
  async reflogFile(ref) {
    let text;
    try {
      text = fs.readFileSync(await this.gitPath(`logs/${ref}`), 'utf8');
    } catch {
      return null;
    }
    // <old> <new> <name> <<email>> <time> <tz>\t<subject>
    return text.split('\n').filter((l) => l.trim()).reverse().map((l) => {
      const m = /^\S+ (\S+) [^\t]*> (\d+) [+-]\d{4}(?:\t(.*))?$/.exec(l.replace(/\r$/, ''));
      return m ? { hash: m[1], time: parseInt(m[2], 10) * 1000, subject: m[3] || '' } : { hash: '', time: null, subject: '' };
    });
  }

  /** user.name / user.email ('' when not configured). */
  async currentUser() {
    const get = async (key) => (await this.git.run(['config', '--get', key], { allowFailure: true })).trim();
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    return { name, email };
  }

  /** Commits reachable from `to` but not from `from`. */
  async commitsBetween(from, to) {
    const r = await this.git.raw(['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, `${from}..${to}`]);
    return r.code === 0 ? parseCommits(r.stdout) : [];
  }

  /** Commits of `ref` not on `remoteRef` (or on no branch of `remote`). */
  async outgoing(ref, remote, remoteRef) {
    const args = ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, ref];
    if (remoteRef) args.push(`^${remoteRef}`);
    else args.push('--not', `--remotes=${remote}`);
    const r = await this.git.raw(args);
    return r.code === 0 ? parseCommits(r.stdout) : [];
  }

  async commitBody(hash) {
    return (await this.git.run(['show', '-s', '--format=%B', hash])).trim();
  }

  /** Files changed between two revisions; null `from` = empty tree. */
  async changedFiles(from, to) {
    const args = ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id'];
    if (from) args.push(from);
    else args.push('--root');
    args.push(to);
    return parseNameStatus(await this.git.run(args));
  }

  async branchesContaining(hash) {
    const out = await this.git.run(['branch', '-a', '--format=%(refname:short)', '--contains', hash], { allowFailure: true });
    return out.split('\n').map((l) => l.trim()).filter((l) => l && !l.endsWith('/HEAD'));
  }

  async refExists(ref) {
    return (await this.git.raw(['rev-parse', '--verify', '--quiet', ref])).code === 0;
  }

  // ---------------------------------------------------------------- refs

  /** @returns {Promise<Branch[]>} */
  async branches() {
    const out = await this.git.run([
      'for-each-ref',
      `--format=%(refname)${FS}%(objectname)${FS}%(upstream:short)${FS}%(upstream:track)${FS}%(HEAD)`,
      'refs/heads', 'refs/remotes',
    ]);
    const count = (t, w) => {
      const m = new RegExp(`${w} (\\d+)`).exec(t);
      return m ? parseInt(m[1], 10) : 0;
    };
    return out.split('\n').filter((l) => l.trim()).map((l) => l.split(FS))
      .filter((f) => !(f[0].startsWith('refs/remotes/') && f[0].endsWith('/HEAD')))
      .map((f) => {
        const remote = f[0].startsWith('refs/remotes/');
        return {
          name: f[0].slice(remote ? 13 : 11),
          remote,
          hash: f[1],
          upstream: f[2] || null,
          ahead: count(f[3], 'ahead'),
          behind: count(f[3], 'behind'),
          gone: f[3].includes('gone'),
          current: f[4] === '*',
        };
      });
  }

  async tags() {
    const out = await this.git.run([
      'for-each-ref', '--sort=-creatordate', `--format=%(refname:short)${FS}%(objectname)${FS}%(*objectname)`, 'refs/tags',
    ]);
    return out.split('\n').filter((l) => l.trim()).map((l) => {
      const f = l.split(FS);
      return { name: f[0], hash: f[2] || f[1] };
    });
  }

  async remotes() {
    const out = await this.git.run(['remote', '-v']);
    const seen = new Map();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line);
      if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
    }
    return [...seen].map(([name, url]) => ({ name, url }));
  }

  async stashes() {
    const out = await this.git.run(['stash', 'list', `--format=%gd${FS}%H${FS}%ct${FS}%gs`], { allowFailure: true });
    return out.split('\n').filter((l) => l.trim()).map((l, i) => {
      const f = l.split(FS);
      const m = /\{(\d+)\}/.exec(f[0]);
      return { index: m ? parseInt(m[1], 10) : i, ref: f[0], hash: f[1], time: parseInt(f[2], 10) * 1000, message: f.slice(3).join(FS) };
    });
  }

  async stashFiles(stash) {
    const files = await this.changedFiles(`${stash.hash}^1`, stash.hash);
    const u = await this.git.raw(['diff-tree', '-r', '-z', '--name-status', '--no-commit-id', '--root', `${stash.hash}^3`]);
    if (u.code === 0) files.push(...parseNameStatus(u.stdout).map((f) => ({ path: f.path, type: /** @type {ChangeType} */ ('untracked') })));
    return files;
  }

  // ---------------------------------------------------------------- content

  /**
   * Content of `filePath` at `rev` ('' = index, 'HEAD', hash...). Null if missing.
   * @returns {Promise<Buffer|null>}
   */
  async show(rev, filePath) {
    const r = await this.git.raw(['show', `${rev}:${filePath}`]);
    return r.code === 0 ? r.bytes : null;
  }

  /** Working tree text of `rel` ('' when the file does not exist). */
  workingText(rel) {
    const full = path.join(this.root, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  }

  // ---------------------------------------------------------------- submodules

  hasGitmodules() {
    return fs.existsSync(path.join(this.root, '.gitmodules'));
  }

  isSubmoduleDir(rel) {
    return fs.existsSync(path.join(this.root, rel, '.git'));
  }

  /** Commit recorded for submodule `rel` at `rev` ('' = index), or null. */
  async gitlinkSha(rev, rel) {
    const r = rev === ''
      ? await this.git.raw(['ls-files', '-s', '--', lit(rel)])
      : await this.git.raw(['ls-tree', rev, '--', lit(rel)]);
    const line = r.stdout.trim();
    if (r.code !== 0 || !line.startsWith('160000 ')) return null;
    const parts = line.split(/\s+/);
    return /^[0-9a-f]{40}$/.test(parts[1]) ? parts[1] : parts[2] || null;
  }

  /** Readable description of a submodule at a commit, for the diff editor. */
  async submoduleText(rel, sha, extra = '') {
    let info = '(commit not available locally: run "Update Submodules")';
    if (this.isSubmoduleDir(rel)) {
      const r = await new GitRunner(path.join(this.root, rel), { gitPath: this.git.gitPath })
        .raw(['log', '-1', '--format=%s%n%an, %ad', '--date=short', sha]);
      if (r.code === 0) info = r.stdout.trim();
    }
    return `Submodule ${rel}\nCommit ${sha}\n${info}\n${extra}`;
  }

  async submoduleWorkTreeText(rel) {
    const sub = new GitRunner(path.join(this.root, rel), { gitPath: this.git.gitPath });
    const head = (await sub.run(['rev-parse', 'HEAD'], { allowFailure: true })).trim();
    const dirty = (await sub.run(['status', '--porcelain'], { allowFailure: true })).trim();
    return this.submoduleText(rel, head || '(no commit)', dirty ? `\nLocal changes inside the submodule:\n${dirty}\n` : '');
  }

  /**
   * Text of `rel` at a revision for the diff editor: file content, or a
   * description when the path is a submodule. rev: 'WORKTREE', '' (index), commit.
   * @returns {Promise<string|null>}
   */
  async contentAt(rev, rel) {
    if (rev === 'WORKTREE') return this.isSubmoduleDir(rel) ? this.submoduleWorkTreeText(rel) : null;
    const bytes = await this.show(rev, rel);
    if (bytes) {
      if (bytes.subarray(0, 8000).includes(0)) return `(binary file, ${bytes.length} bytes)`;
      return bytes.toString('utf8');
    }
    const sha = await this.gitlinkSha(rev, rel);
    return sha ? this.submoduleText(rel, sha) : null;
  }

  /** @returns {Promise<Submodule[]>} */
  async submodules() {
    if (!this.hasGitmodules()) return [];
    const cfg = await this.git.run(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'], { allowFailure: true });
    const pathOf = new Map();
    const urlOf = new Map();
    for (const line of cfg.split('\n')) {
      const m = /^submodule\.(.+)\.(path|url) (.*)$/.exec(line.trim());
      if (m) (m[2] === 'path' ? pathOf : urlOf).set(m[1], m[3]);
    }
    const urlByPath = new Map([...pathOf].map(([name, p]) => [p, urlOf.get(name) || '']));
    const out = await this.git.run(['submodule', 'status', '--recursive'], { allowFailure: true });
    const result = [];
    for (const line of out.split('\n')) {
      const m = /^([ +\-U])([0-9a-f]{40}) (.+?)(?: \((.*)\))?$/.exec(line);
      if (!m) continue;
      result.push({
        path: m[3],
        sha: m[2],
        status: /** @type {any} */ ({ '-': 'uninitialized', '+': 'outOfDate', U: 'conflict' }[m[1]] || 'upToDate'),
        url: urlByPath.get(m[3]) || '',
        describe: m[4] || '',
        declared: true,
      });
    }
    // Declared in .gitmodules but not recorded in the parent repository
    // (no gitlink in the index): `git submodule status` skips these.
    const listed = new Set(result.map((s) => s.path));
    for (const [p, url] of urlByPath) {
      if (listed.has(p)) continue;
      let sha = '';
      if (this.isSubmoduleDir(p)) {
        sha = (await new GitRunner(path.join(this.root, p), { gitPath: this.git.gitPath })
          .run(['rev-parse', 'HEAD'], { allowFailure: true })).trim();
      }
      result.push({ path: p, sha, status: 'notRegistered', url, describe: '', declared: true });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Repositories nested in this one that git does not track (reported as
   * untracked directories), e.g. a clone inside the working tree.
   */
  async nestedRepositories() {
    // `status -uall` descends into untracked folders and stops only at
    // repositories, which it reports with a trailing slash.
    const out = await this.git.run(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'], { allowFailure: true });
    return parseStatus(out).changes.filter((c) => c.nestedRepo && this.isSubmoduleDir(c.path)).map((c) => c.path);
  }

  /** URL of `origin` in the repository nested at `rel`, or ''. */
  async nestedOriginUrl(rel) {
    const sub = new GitRunner(path.join(this.root, rel), { gitPath: this.git.gitPath });
    return (await sub.run(['remote', 'get-url', 'origin'], { allowFailure: true })).trim();
  }

  /** Registers an existing nested repository as a submodule of this one. */
  registerSubmodule(rel, url) {
    return this.git.run(['submodule', 'add', '--', url, rel], { log: true });
  }

  /** Checks out the recorded commits (all submodules when `paths` is empty). */
  updateSubmodules(paths = [], recursive = true) {
    return this.git.run(['submodule', 'update', '--init', ...(recursive ? ['--recursive'] : []), ...(paths.length ? ['--', ...paths] : [])], { log: true });
  }

  syncSubmodules(paths = []) {
    return this.git.run(['submodule', 'sync', '--recursive', ...(paths.length ? ['--', ...paths] : [])], { log: true });
  }

  addSubmodule(url, rel) {
    return this.git.run(['submodule', 'add', '--', url, rel], { log: true });
  }

  /** Per file unified diff against `base`; untracked / new files as additions. */
  async diffPerFile(changes, base) {
    /** @type {Map<string,string>} */
    const result = new Map();
    const tracked = base ? changes.filter((c) => c.type !== 'untracked') : [];
    if (tracked.length) {
      const paths = tracked.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])).map(lit);
      const out = await this.git.run(['diff', '--no-color', '--no-ext-diff', '-M', base, '--', ...paths]);
      for (const chunk of out.split(/^(?=diff --git )/m)) {
        if (!chunk.trim()) continue;
        const m = /^diff --git a\/.* b\/(.*)$/m.exec(chunk);
        result.set(m ? m[1] : chunk.split('\n')[0], chunk);
      }
    }
    for (const c of changes) {
      if (base && c.type !== 'untracked') continue;
      const full = path.join(this.root, c.path);
      if (!fs.existsSync(full)) continue;
      const bytes = fs.readFileSync(full);
      if (bytes.subarray(0, 8000).includes(0)) {
        result.set(c.path, `new binary file: ${c.path} (${bytes.length} bytes)\n`);
        continue;
      }
      const text = bytes.toString('utf8');
      result.set(c.path, `new file: ${c.path}\n${text.split('\n').map((l) => `+${l}`).join('\n')}\n`);
    }
    return result;
  }

  async recentSubjects(count = 15) {
    const r = await this.git.raw(['log', `-${count}`, '--format=%s']);
    return r.code === 0 ? r.stdout.split('\n').filter((l) => l.trim()) : [];
  }

  async lastCommitMessage() {
    return (await this.git.run(['log', '-1', '--format=%B'])).trim();
  }

  // ---------------------------------------------------------------- commit

  /**
   * Commits only `paths` (Android Studio style, no staging area exposed).
   * sign: -S / --no-gpg-sign, null or omitted = commit.gpgsign decides.
   * @param {{message: string, paths: string[], amend?: boolean, signOff?: boolean, partial?: boolean, sign?: boolean|null}} o
   */
  async commit(o) {
    const msgFile = path.join(os.tmpdir(), `git_tools_msg_${Date.now()}_${process.pid}.txt`);
    fs.writeFileSync(msgFile, o.message, 'utf8');
    const spec = o.paths.map(lit).join('\0') + '\0';
    const partial = o.partial !== false;
    try {
      if (o.paths.length) {
        await this.git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: spec, log: true });
      }
      const args = ['commit', '-F', msgFile];
      if (o.amend) args.push('--amend');
      if (o.signOff) args.push('--signoff');
      args.push(...signArgs(o.sign));
      if (partial && (o.paths.length || o.amend)) args.push('--only');
      if (partial && o.paths.length) args.push('--pathspec-from-file=-', '--pathspec-file-nul');
      await this.git.run(args, { stdin: partial && o.paths.length ? spec : undefined, log: true });
    } finally {
      try { fs.unlinkSync(msgFile); } catch { /* ignore */ }
    }
  }

  /** Diff of one tracked file: HEAD → working tree. */
  async fileDiff(filePath) {
    return this.git.run(['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', lit(filePath)]);
  }

  /**
   * Commits through a temporary index, so only the given content is
   * committed and the user's real index is left alone (hooks still run).
   *   fullPaths: committed as they are in the working tree
   *   partial:   [{path, content}] committed with exactly this content
   * @param {{message: string, fullPaths: string[], partial: {path: string, content: string}[], amend?: boolean, signOff?: boolean,
   *   sign?: boolean|null}} o
   */
  async commitSelected(o) {
    const dir = await this.gitDir();
    const tmpIndex = path.join(dir, `gittools-index-${process.pid}-${Date.now()}`);
    const msgFile = path.join(os.tmpdir(), `git_tools_msg_${Date.now()}_${process.pid}.txt`);
    fs.writeFileSync(msgFile, o.message, 'utf8');
    const env = { GIT_INDEX_FILE: tmpIndex };
    const hasHead = await this.refExists('HEAD');
    const allPaths = [...o.fullPaths, ...o.partial.map((p) => p.path)];
    try {
      await this.git.run(hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env, log: true });
      if (o.fullPaths.length) {
        await this.git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { env, stdin: `${o.fullPaths.map(lit).join('\0')}\0`, log: true });
      }
      for (const p of o.partial) {
        // --path applies the clean filters (e.g. CRLF → LF) like `git add`.
        const sha = (await this.git.run(['hash-object', '-w', '--stdin', `--path=${p.path}`], { stdin: p.content })).trim();
        const ls = hasHead ? (await this.git.run(['ls-tree', 'HEAD', '--', lit(p.path)])).trim() : '';
        const mode = ls ? ls.split(/\s/)[0] : '100644';
        await this.git.run(['update-index', '--add', '--cacheinfo', `${mode},${sha},${p.path}`], { env, log: true });
      }
      const args = ['commit', '-F', msgFile];
      if (o.amend) args.push('--amend');
      if (o.signOff) args.push('--signoff');
      args.push(...signArgs(o.sign));
      await this.git.run(args, { env, log: true });
      // Sync the real index for the committed paths with the new HEAD; the
      // unselected lines stay as unstaged changes in the working tree.
      if (allPaths.length) {
        await this.git.run(['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { stdin: `${allPaths.map(lit).join('\0')}\0`, log: true });
      }
    } finally {
      for (const f of [tmpIndex, `${tmpIndex}.lock`, msgFile]) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    }
  }

  /** Reverts tracked changes to HEAD. */
  async rollback(changes, hasHead, deleteAdded) {
    const all = (list) => list.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])).map(lit);
    // A modified submodule is rolled back by checking out the commit that the
    // parent repository records for it.
    const subs = changes.filter((c) => c.submodule && c.type === 'modified');
    if (subs.length && hasHead) {
      await this.git.run(['restore', '--source=HEAD', '--staged', '--', ...subs.map((c) => lit(c.path))], { log: true });
      await this.updateSubmodules(subs.map((c) => c.path), false);
    }
    changes = changes.filter((c) => !subs.includes(c));
    if (!changes.length) return;
    if (!hasHead) {
      await this.git.run(['rm', '-r', '--cached', '-q', '--', ...all(changes)], { log: true });
      return;
    }
    const added = changes.filter((c) => c.type === 'added');
    const others = changes.filter((c) => c.type !== 'added');
    if (others.length) {
      await this.git.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...all(others)], { log: true });
    }
    if (added.length) {
      await this.git.run(['rm', '--cached', '-q', '-f', '--', ...added.map((c) => lit(c.path))], { log: true });
      if (deleteAdded) for (const c of added) fs.rmSync(path.join(this.root, c.path), { force: true });
    }
  }

  async acceptSide(change, ours) {
    const code = change.conflictCode || 'UU';
    const deleted = ours ? code === 'DU' || code === 'DD' : code === 'UD' || code === 'DD';
    if (deleted) {
      await this.git.run(['rm', '-q', '--', lit(change.path)], { log: true });
      return;
    }
    await this.git.run(['checkout', ours ? '--ours' : '--theirs', '--', lit(change.path)], { log: true });
    await this.git.run(['add', '--', lit(change.path)], { log: true });
  }

  /** Stages a resolved file, writing `content` first when given. */
  async markResolved(filePath, content) {
    if (content !== undefined) fs.writeFileSync(path.join(this.root, filePath), content, 'utf8');
    await this.git.run(['add', '--', lit(filePath)], { log: true });
  }

  /** Re-creates conflicted content from the index stages. */
  async mergeFromStages(filePath) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git_tools_merge'));
    try {
      const stage = async (n) => (await this.show(`:${n}`, filePath)) || Buffer.alloc(0);
      const files = { ours: await stage(2), base: await stage(1), theirs: await stage(3) };
      for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(tmp, k), v);
      const r = await this.git.raw(['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs',
        path.join(tmp, 'ours'), path.join(tmp, 'base'), path.join(tmp, 'theirs')]);
      return r.stdout;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Starts tracking files (paths go through stdin: there can be thousands). */
  add(paths) {
    return this.git.run(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: pathspecs(paths), log: true });
  }

  /** Stops tracking files without deleting them. */
  untrack(paths) {
    return this.git.run(['rm', '--cached', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: pathspecs(paths), log: true });
  }

  deleteFiles(paths) {
    for (const p of paths) fs.rmSync(path.join(this.root, p), { force: true });
  }

  addToGitignore(patterns) {
    const file = path.join(this.root, '.gitignore');
    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (content && !content.endsWith('\n')) content += '\n';
    content += patterns.join('\n') + '\n';
    fs.writeFileSync(file, content);
  }

  /** Restores `rel` as it is in commit `hash`. */
  checkoutFile(hash, rel) {
    return this.git.run(['checkout', hash, '--', lit(rel)], { log: true });
  }

  // ---------------------------------------------------------------- branches

  checkout(ref) {
    return this.git.run(['checkout', ref], { log: true });
  }

  checkoutTracking(localName, remoteBranch) {
    return this.git.run(['checkout', '-b', localName, '--track', remoteBranch], { log: true });
  }

  /**
   * Creates `name` without an upstream: branching off origin/<base> would
   * otherwise make <base> the upstream, so a plain push would update <base>
   * instead of publishing the new branch. The start point is kept in
   * `branch.<name>.vscode-merge-base`.
   * @param {string} name
   * @param {{startPoint?: string, checkout?: boolean, fromRemote?: boolean}} [o]
   */
  async createBranch(name, o = {}) {
    const args = o.checkout ? ['checkout', '--no-track', '-b', name] : ['branch', '--no-track', name];
    if (o.startPoint) args.push(o.startPoint);
    await this.git.run(args, { log: true });
    if (o.fromRemote && o.startPoint) {
      await this.git.run(['config', `branch.${name}.vscode-merge-base`, o.startPoint], { allowFailure: true });
    }
  }

  renameBranch(oldName, newName) {
    return this.git.run(['branch', '-m', oldName, newName], { log: true });
  }

  deleteBranch(name, force = false) {
    return this.git.run(['branch', force ? '-D' : '-d', name], { log: true });
  }

  deleteRemoteBranch(remote, branch) {
    return this.git.run(['push', '--progress', remote, '--delete', branch], { log: true });
  }

  /**
   * Merges `ref` into the current branch; without options git's defaults
   * (fast-forward when possible, message not edited).
   * @param {string} ref
   * @param {import('../domain/entities').MergeOptions} [o]
   */
  merge(ref, o) {
    return this.git.run(o ? mergeArgs(ref, o) : ['merge', '--no-edit', ref], { log: true });
  }

  /**
   * Commits `ref` would bring (HEAD..ref) and whether HEAD can fast-forward to it.
   * @returns {Promise<import('../domain/entities').MergePreview>}
   */
  async mergePreview(ref) {
    const [count, fastForward] = await Promise.all([
      this.git.run(['rev-list', '--count', `HEAD..${ref}`, '--'], { allowFailure: true }),
      this.isAncestor('HEAD', ref),
    ]);
    const commits = parseInt(count.trim(), 10) || 0;
    return { commits, fastForward: fastForward && commits > 0 };
  }

  /** Message `git merge --squash` prepared (SQUASH_MSG), or null. */
  async squashMessage() {
    try {
      return fs.readFileSync(await this.gitPath('SQUASH_MSG'), 'utf8');
    } catch {
      return null;
    }
  }

  /** Rebases `branch` (the current one when omitted) onto `onto`. */
  rebase(onto, branch) {
    return this.git.run(['rebase', '--autostash', onto, ...(branch ? [branch] : [])], { log: true });
  }

  // ---------------------------------------------------------------- remotes

  fetchAll() {
    return this.git.run(['fetch', '--progress', '--prune', '--all'], { log: true });
  }

  /** Fetches a remote branch directly into a local branch (fast-forward only). */
  fetchInto(remote, remoteBranch, localBranch) {
    return this.git.run(['fetch', remote, `${remoteBranch}:${localBranch}`], { log: true });
  }

  /** @param {string} remote @param {string} branch @param {import('../domain/entities').PullMode} mode */
  pull(remote, branch, mode) {
    const args = ['pull', '--progress', '--no-edit'];
    if (mode === 'ff') args.push('--ff-only');
    else if (mode === 'rebase') args.push('--rebase', '--autostash');
    else args.push('--no-rebase');
    args.push(remote, branch);
    return this.git.run(args, { log: true });
  }

  /**
   * Pushes local `branch` to `target` on `remote`.
   * @param {{remote: string, branch: string, target: string, force?: boolean, tags?: boolean, setUpstream?: boolean}} o
   */
  push(o) {
    const args = ['push', '--progress'];
    if (o.force) args.push('--force-with-lease');
    if (o.tags) args.push('--follow-tags');
    if (o.setUpstream) args.push('--set-upstream');
    args.push(o.remote, `refs/heads/${o.branch}:refs/heads/${o.target}`);
    return this.git.run(args, { log: true });
  }

  pushTag(remote, tag) {
    return this.git.run(['push', '--progress', remote, `refs/tags/${tag}`], { log: true });
  }

  addRemote(name, url) {
    return this.git.run(['remote', 'add', name, url], { log: true });
  }

  setRemoteUrl(name, url) {
    return this.git.run(['remote', 'set-url', name, url], { log: true });
  }

  removeRemote(name) {
    return this.git.run(['remote', 'remove', name], { log: true });
  }

  // ---------------------------------------------------------------- commits

  cherryPick(c) {
    return this.git.run(['cherry-pick', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.hash], { log: true });
  }

  revert(c) {
    return this.git.run(['revert', '--no-edit', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.hash], { log: true });
  }

  /** @param {string} hash @param {import('../domain/entities').ResetMode} mode */
  reset(hash, mode) {
    return this.git.run(['reset', `--${mode}`, hash], { log: true });
  }

  undoLastCommit() {
    return this.git.run(['reset', '--soft', 'HEAD~1'], { log: true });
  }

  /**
   * Creates a tag, annotated when `message` is not empty. sign: true = signed
   * annotated tag (-s, the tag name as message when there is none), false =
   * --no-sign (tag.gpgsign would otherwise turn a lightweight tag into a
   * signed one), null = git's config decides.
   * @param {string} name @param {string} hash @param {string} [message] @param {boolean|null} [sign]
   */
  createTag(name, hash, message = '', sign = null) {
    const args = ['tag'];
    if (sign === true) args.push('-s', '-m', message || name);
    else if (message) args.push('-a', '-m', message);
    if (sign === false) args.push('--no-sign');
    return this.git.run([...args, name, hash], { log: true });
  }

  deleteTag(name) {
    return this.git.run(['tag', '-d', name], { log: true });
  }

  // ---------------------------------------------------------------- stash

  /** @param {{message?: string, includeUntracked?: boolean, keepIndex?: boolean}} [o] */
  stash(o = {}) {
    const args = ['stash', 'push'];
    if (o.includeUntracked) args.push('--include-untracked');
    if (o.keepIndex) args.push('--keep-index');
    if (o.message) args.push('-m', o.message);
    return this.git.run(args, { log: true });
  }

  stashApply(ref, pop = false) {
    return this.git.run(['stash', pop ? 'pop' : 'apply', ref], { log: true });
  }

  stashPop() {
    return this.git.run(['stash', 'pop'], { log: true });
  }

  stashDrop(ref) {
    return this.git.run(['stash', 'drop', ref], { log: true });
  }

  stashBranch(ref, branch) {
    return this.git.run(['stash', 'branch', branch, ref], { log: true });
  }

  // ---------------------------------------------------------------- patches (shelf, create / apply patch)

  /** Folder shared by all worktrees (git rev-parse --git-common-dir). */
  async commonDir() {
    if (!this._commonDir) {
      this._commonDir = path.resolve(this.root, (await this.git.run(['rev-parse', '--git-common-dir'])).trim());
    }
    return this._commonDir;
  }

  /** A new temporary file name in the git folder; the caller removes the file. */
  async tempFile(kind) {
    return path.join(await this.gitDir(), `gittools-${kind}-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  }

  /**
   * Runs `fn` with a temporary index (GIT_INDEX_FILE) read from `base` (empty
   * when null): the real index is never touched. Removed afterwards.
   * @template T
   * @param {string|null} base
   * @param {(env: Record<string, string>) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withTempIndex(base, fn) {
    const file = await this.tempFile('index');
    const env = { GIT_INDEX_FILE: file };
    try {
      await this.git.run(base ? ['read-tree', base] : ['read-tree', '--empty'], { env });
      return await fn(env);
    } finally {
      for (const f of [file, `${file}.lock`]) fs.rmSync(f, { force: true });
    }
  }

  /**
   * Writes `patch` to a temporary file for `fn` (git apply / am read files).
   * @template T
   * @param {Buffer} patch
   * @param {(file: string) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withPatchFile(patch, fn) {
    const file = `${await this.tempFile('patch')}.patch`;
    fs.writeFileSync(file, patch);
    try {
      return await fn(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /** The empty tree in this repository's hash format. */
  async emptyTree() {
    return (await this.git.run(['mktree'], { stdin: '' })).trim();
  }

  /**
   * Which of `paths` exist in the working tree or at `rev` ('' = index):
   * `git add` fails on a path that is in neither.
   * @param {string[]} paths
   * @param {string|null} rev
   * @param {Record<string, string>} [env]
   */
  async presentPaths(paths, rev, env) {
    const onDisk = (p) => {
      try {
        fs.lstatSync(path.join(this.root, p));
        return true;
      } catch {
        return false;
      }
    };
    const missing = paths.filter((p) => !onDisk(p));
    if (!missing.length || rev === null) {
      const gone = new Set(missing);
      return paths.filter((p) => !gone.has(p));
    }
    const out = await this.git.run(['cat-file', '--batch-check'], { env, stdin: missing.map((p) => `${rev}:${p}\n`).join('') });
    const lines = out.split('\n');
    const gone = new Set(missing.filter((p, i) => !lines[i] || lines[i].endsWith(' missing')));
    return paths.filter((p) => !gone.has(p));
  }

  /**
   * Patch of a temporary index against `base` (empty tree when null) with
   * the files it touches. Explicit options so that diff settings (external
   * diff, no prefix, textconv, relative) cannot change the output.
   * @param {Record<string, string>} env
   * @param {string|null} base
   * @returns {Promise<{patch: Buffer, files: import('../domain/entities').ShelfFile[]}>}
   */
  async indexPatch(env, base) {
    const tree = base || await this.emptyTree();
    const args = ['diff', '--cached', '--binary', '--full-index', '-M', '--no-ext-diff', '--no-textconv', '--no-color',
      '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', tree, '--'];
    const r = await this.git.raw(args, { env });
    if (r.code !== 0) throw new GitError(args, r.code, r.stderr, r.stdout);
    const names = await this.git.run(['diff', '--cached', '--name-status', '-z', '-M', '--no-relative', tree, '--'], { env });
    const files = parseNameStatus(names).map((f) => ({ path: f.path, oldPath: f.oldPath || null, status: shelfStatus(f.type) }));
    return { patch: r.bytes, files };
  }

  /**
   * Patch of the working tree content of `paths` (new and deleted files
   * included) against `base`, built in a temporary index: the real index
   * and the working tree are left alone.
   * @param {string[]} paths
   * @param {string|null} base commit, null for a repository without commits
   */
  async buildPatch(paths, base) {
    return this.withTempIndex(base, async (env) => {
      const present = await this.presentPaths(paths, base);
      if (present.length) {
        await this.git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, stdin: pathspecs(present) });
      }
      return this.indexPatch(env, base);
    });
  }

  /**
   * Reverts shelved files to `base` (HEAD) in the index and the working
   * tree: modified and deleted files are restored, new files are removed
   * from the index and deleted (both sides of a rename). Other paths are
   * not touched.
   * @param {import('../domain/entities').ShelfFile[]} files
   * @param {string} base
   */
  async discardChanges(files, base) {
    const restore = [];
    const remove = [];
    for (const f of files) {
      if (f.status === 'A' || f.status === 'R') remove.push(f.path);
      else restore.push(f.path);
      if (f.status === 'R' && f.oldPath) restore.push(f.oldPath);
    }
    if (restore.length) {
      await this.git.run(['restore', `--source=${base}`, '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { stdin: pathspecs(restore), log: true });
    }
    if (remove.length) {
      await this.git.run(['rm', '--cached', '-q', '-f', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { stdin: pathspecs(remove), log: true });
      for (const p of remove) {
        fs.rmSync(path.join(this.root, p), { force: true });
        this.removeEmptyFolders(p);
      }
    }
  }

  /** Removes the folders of `rel` left empty, up to the repository root. */
  removeEmptyFolders(rel) {
    let dir = path.dirname(path.join(this.root, rel));
    while (dir.length > this.root.length && dir.startsWith(this.root)) {
      try {
        if (fs.readdirSync(dir).length) return;
        fs.rmdirSync(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
    }
  }

  /**
   * Index entries ("mode sha stage\tpath", ls-files -s) of `paths`.
   * @param {string[]} paths
   * @returns {Promise<Map<string, string[]>>}
   */
  async indexEntries(paths) {
    const wanted = new Set(paths);
    /** @type {Map<string, string[]>} */
    const entries = new Map();
    const out = await this.git.run(['ls-files', '-s', '-z']);
    for (const rec of out.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const p = rec.slice(tab + 1);
      if (!wanted.has(p)) continue;
      if (!entries.has(p)) entries.set(p, []);
      entries.get(p).push(rec);
    }
    return entries;
  }

  /** Paths with unmerged index entries (conflicts). */
  async unmergedPaths() {
    const out = await this.git.run(['ls-files', '-u', '-z']);
    return [...new Set(out.split('\0').filter((r) => r.includes('\t')).map((r) => r.slice(r.indexOf('\t') + 1)))];
  }

  /**
   * Puts back the index entries recorded by indexEntries(): paths that were
   * not in the index are removed from it again.
   * @param {string[]} paths
   * @param {Map<string, string[]>} before
   */
  async restoreIndexEntries(paths, before) {
    const absent = paths.filter((p) => !before.has(p));
    const present = paths.filter((p) => before.has(p));
    if (absent.length) {
      await this.git.run(['rm', '--cached', '-q', '-f', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { stdin: pathspecs(absent) });
    }
    if (present.length) {
      await this.git.run(['update-index', '-z', '--index-info'], { stdin: present.flatMap((p) => before.get(p)).map((r) => `${r}\0`).join('') });
    }
  }

  /**
   * Stages the working tree content of `targets` (they must match the index
   * for git apply --3way) in the index of `env` (the real one by default).
   * @param {string[]} targets
   * @param {Record<string, string>} [env]
   */
  async stageForApply(targets, env) {
    const present = await this.presentPaths(targets, '', env);
    if (present.length) {
      await this.git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, stdin: pathspecs(present) });
    }
  }

  /**
   * Files of a patch (git apply --numstat --summary).
   * @param {Buffer} patch
   * @returns {Promise<import('../domain/entities').PatchFile[]>}
   */
  async patchFiles(patch) {
    return this.withPatchFile(patch, async (file) => parsePatchStat(
      await this.git.run(['apply', '--numstat', '--summary', '-z', file])));
  }

  /**
   * `git apply --check --3way` on a copy of the index where `targets` are
   * staged as they are in the working tree, like applyPatch() does.
   * @param {Buffer} patch
   * @param {string[]} targets paths the patch touches
   * @returns {Promise<import('../domain/entities').PatchCheck>}
   */
  async checkPatch(patch, targets) {
    const index = await this.gitPath('index');
    const copy = await this.tempFile('index');
    const env = { GIT_INDEX_FILE: copy };
    try {
      if (fs.existsSync(index)) fs.copyFileSync(index, copy);
      await this.stageForApply(targets, env);
      return await this.withPatchFile(patch, async (file) => {
        const r = await this.git.raw(['apply', '--check', '--3way', '--binary', file], { env });
        if (r.code !== 0) return { conflicts: [], error: r.stderr.trim() || `git apply exited with code ${r.code}` };
        return { conflicts: appliedWithConflicts(r.stderr), error: null };
      });
    } finally {
      for (const f of [copy, `${copy}.lock`]) fs.rmSync(f, { force: true });
    }
  }

  /**
   * Applies a patch to the working tree with `git apply --3way`. Files that
   * merge with conflicts get conflict markers and unmerged index entries;
   * for every other target the index is put back as it was, so the user's
   * staging does not change. Throws (changing nothing) when git refuses the
   * patch.
   * @param {Buffer} patch
   * @param {string[]} targets paths the patch touches (both sides of renames)
   * @returns {Promise<{conflicted: string[], output: string}>}
   */
  async applyPatch(patch, targets) {
    return this.withPatchFile(patch, async (file) => {
      const before = await this.indexEntries(targets);
      // --3way implies --index: a target with unstaged changes would be refused.
      await this.stageForApply(targets);
      const args = ['apply', '--3way', '--binary', file];
      let r;
      let unmerged = new Set();
      try {
        r = await this.git.raw(args, { log: true });
      } finally {
        unmerged = new Set(await this.unmergedPaths());
        await this.restoreIndexEntries(targets.filter((p) => !unmerged.has(p)), before);
      }
      const conflicted = targets.filter((p) => unmerged.has(p));
      if (r.code !== 0 && !conflicted.length) throw new GitError(args, r.code, r.stderr, r.stdout);
      return { conflicted, output: r.stderr.trim() };
    });
  }

  /**
   * Applies a mailbox (git format-patch output) as commits with
   * `git am --3way`. stopped = git am stopped at a patch (conflict) and the
   * repository is left applying it.
   * @param {Buffer} patch
   */
  async applyMailbox(patch) {
    return this.withPatchFile(patch, async (file) => {
      const args = ['am', '--3way', file];
      const r = await this.git.raw(args, { log: true });
      if ((await this.repoState()) === 'applyingMailbox') return { stopped: true, output: (r.stderr || r.stdout).trim() };
      if (r.code !== 0) throw new GitError(args, r.code, r.stderr, r.stdout);
      return { stopped: false, output: '' };
    });
  }

  /**
   * One mailbox with the given commits, in the given order
   * (git format-patch --stdout). Merge commits produce nothing.
   * @param {string[]} hashes
   */
  async formatPatch(hashes) {
    const parts = [];
    for (const h of hashes) {
      const args = ['format-patch', '--stdout', '--binary', '-1', h];
      const r = await this.git.raw(args);
      if (r.code !== 0) throw new GitError(args, r.code, r.stderr, r.stdout);
      parts.push(r.bytes);
    }
    return Buffer.concat(parts);
  }

  /**
   * Index entries ({mode, sha}) of `paths` once `patch` is applied to
   * `base`, without touching the working tree or the real index.
   * @param {string} base
   * @param {Buffer} patch
   * @param {string[]} paths
   * @returns {Promise<Map<string, {mode: string, sha: string}>>}
   */
  async patchedEntries(base, patch, paths) {
    return this.withTempIndex(base, (env) => this.withPatchFile(patch, async (file) => {
      await this.git.run(['apply', '--cached', '--binary', file], { env });
      const wanted = new Set(paths);
      /** @type {Map<string, {mode: string, sha: string}>} */
      const result = new Map();
      for (const rec of (await this.git.run(['ls-files', '-s', '-z'], { env })).split('\0')) {
        const m = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(rec);
        if (m && wanted.has(m[3])) result.set(m[3], { mode: m[1], sha: m[2] });
      }
      return result;
    }));
  }

  /** Content of a blob. @param {string} sha */
  async blob(sha) {
    return (await this.git.raw(['cat-file', 'blob', sha])).bytes;
  }

  /**
   * The patch without the files at `removePaths`: applied to `base` in a
   * temporary index, those paths reset to `base`, and diffed again.
   * @param {string} base
   * @param {Buffer} patch
   * @param {string[]} removePaths both sides of renames
   */
  async removeFromPatch(base, patch, removePaths) {
    return this.withTempIndex(base, (env) => this.withPatchFile(patch, async (file) => {
      await this.git.run(['apply', '--cached', '--binary', file], { env });
      if (removePaths.length) {
        await this.git.run(['reset', '-q', base, '--pathspec-from-file=-', '--pathspec-file-nul'], { env, stdin: pathspecs(removePaths) });
      }
      return this.indexPatch(env, base);
    }));
  }

  /** Creates or moves a ref (e.g. refs/git-tools/shelf/<id>). */
  setRef(ref, hash) {
    return this.git.run(['update-ref', ref, hash]);
  }

  deleteRef(ref) {
    return this.git.run(['update-ref', '-d', ref], { allowFailure: true });
  }

  // ---------------------------------------------------------------- operations

  /** sign: -S / --no-gpg-sign for the merge commit (merging only: the other operations take no signing option). */
  continueOperation(state, sign = null) {
    const args = {
      merging: ['commit', '--no-edit', ...signArgs(sign)],
      rebasing: ['rebase', '--continue'],
      cherryPicking: ['cherry-pick', '--continue'],
      reverting: ['revert', '--continue'],
      applyingMailbox: ['am', '--continue'],
    }[state];
    return this.git.run(args, { log: true });
  }

  abortOperation(state) {
    const op = { merging: 'merge', rebasing: 'rebase', cherryPicking: 'cherry-pick', reverting: 'revert', applyingMailbox: 'am' }[state];
    return this.git.run([op, '--abort'], { log: true });
  }

  /** Skips the commit a rebase stopped at. */
  skipRebaseCommit() {
    return this.git.run(['rebase', '--skip'], { log: true });
  }

  /** Skips the patch git am stopped at. */
  skipMailboxPatch() {
    return this.git.run(['am', '--skip'], { log: true });
  }

  // ---------------------------------------------------------------- interactive rebase

  /** Absolute path of `git rev-parse --git-path <name>` (per worktree). */
  async gitPath(name) {
    const p = (await this.git.run(['rev-parse', '--git-path', name])).trim();
    return path.resolve(this.root, p);
  }

  /** Folder holding the todo and message files of an interactive rebase. */
  async rebaseStateDir() {
    if (!this._rebaseStateDir) this._rebaseStateDir = await this.gitPath('git-tools-rebase');
    return this._rebaseStateDir;
  }

  async cleanupRebaseState() {
    fs.rmSync(await this.rebaseStateDir(), { recursive: true, force: true });
  }

  /** core.commentChar / core.commentString ('#' when unset or "auto"). */
  async commentChar() {
    const out = await this.git.run(['config', '--get-regexp', '^core\\.comment(char|string)$'], { allowFailure: true });
    const lines = out.split('\n').filter((l) => l.trim());
    const value = lines.length ? lines[lines.length - 1].replace(/^\S+ ?/, '') : '';
    return !value || value === 'auto' ? '#' : value;
  }

  async isAncestor(ancestor, descendant) {
    return (await this.git.raw(['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
  }

  /** First parent of `hash`, or null for a root commit. */
  async parentOf(hash) {
    const r = await this.git.raw(['rev-parse', '--verify', '--quiet', `${hash}^`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /**
   * Commits of `base..HEAD` (all of HEAD when `base` is null) with their full message.
   * @returns {Promise<import('../domain/entities').RangeCommit[]>}
   */
  async rangeCommits(base) {
    const out = await this.git.run(['log', '--topo-order', `--format=%H${FS}%P${FS}%an${FS}%at${FS}%s${FS}%B${RS}`, base ? `${base}..HEAD` : 'HEAD']);
    return out.split(RS).map((r) => r.replace(/^\s+/, '')).filter(Boolean).map((r) => {
      const f = r.split(FS);
      return {
        hash: f[0],
        parents: f[1] ? f[1].split(' ') : [],
        author: f[2],
        time: parseInt(f[3], 10) * 1000,
        subject: f[4],
        message: f.slice(5).join(FS).replace(/\s+$/, ''),
      };
    });
  }

  /** Number of commits of `base..HEAD` that are already on the upstream branch (0 without one). */
  async commitsOnUpstream(base) {
    if ((await this.git.raw(['rev-parse', '--verify', '--quiet', '@{u}'])).code !== 0) return 0;
    const count = async (...args) => parseInt((await this.git.run(['rev-list', '--count', ...args])).trim(), 10) || 0;
    const range = base ? [`${base}..HEAD`] : ['HEAD'];
    return (await count(...range)) - (await count(...range, '--not', '@{u}'));
  }

  /**
   * The todo git generates for `rebase -i <base>`, without rewriting
   * anything: the sequence editor copies the todo, then empties it, and git
   * stops with "nothing to do" before touching HEAD.
   *
   * git runs on a temporary index made from HEAD's tree with every entry
   * assume-unchanged: the tree looks clean, so --autostash stashes nothing
   * and the real index, the working tree files (and their mtimes) and the
   * stash list stay exactly as they are.
   * @param {{base: string|null, rebaseMerges: boolean}} o
   */
  async rebaseTodoPreview(o) {
    const dir = await this.rebaseStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'original-todo');
    const env = { GIT_INDEX_FILE: path.join(dir, 'preview-index') };
    const editor = `f(){ cp "$1" ${shQuote(out.replace(/\\/g, '/'))}; : > "$1"; }; f`;
    const args = ['rebase', '-i', '--autostash', '--no-autosquash', ...(o.rebaseMerges ? ['--rebase-merges'] : []), o.base || '--root'];
    try {
      await this.git.run(['read-tree', 'HEAD'], { env });
      const files = await this.git.run(['ls-files', '-z'], { env });
      if (files) await this.git.run(['update-index', '--assume-unchanged', '-z', '--stdin'], { env, stdin: files });
      const r = await this.git.raw(args, { env: { ...env, GIT_SEQUENCE_EDITOR: editor } });
      if (!fs.existsSync(out)) throw new GitError(args, r.code, r.stderr, r.stdout);
      return fs.readFileSync(out, 'utf8');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Runs `rebase -i` with the given todo. Message files are written next to
   * it and kept until the rebase ends. Returns stopped = true when git
   * stopped (conflict, edit, failing hook or exec) and the repository is
   * left rebasing.
   * sign: --gpg-sign / --no-gpg-sign for the rewritten commits (null: commit.gpgsign).
   * @param {{base: string|null, rebaseMerges: boolean, todo: string, messages: Map<string, string>, sign?: boolean|null}} o
   */
  async runRebaseTodo(o) {
    const dir = await this.rebaseStateDir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const todo = path.join(dir, 'todo');
    fs.writeFileSync(todo, o.todo, 'utf8');
    for (const [name, text] of o.messages) fs.writeFileSync(path.join(dir, name), text, 'utf8');
    const sign = o.sign === true ? ['--gpg-sign'] : o.sign === false ? ['--no-gpg-sign'] : [];
    const args = ['rebase', '-i', '--autostash', ...sign, ...(o.rebaseMerges ? ['--rebase-merges'] : []), o.base || '--root'];
    // git appends the path of its todo file to the sequence editor command.
    const r = await this.git.raw(args, { log: true, env: { GIT_SEQUENCE_EDITOR: `cp ${shQuote(todo.replace(/\\/g, '/'))}` } });
    if ((await this.repoState()) === 'rebasing') {
      return { stopped: true, output: (r.stderr || r.stdout).trim() };
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.code !== 0) throw new GitError(args, r.code, r.stderr, r.stdout);
    return { stopped: false, output: '' };
  }

  /**
   * Progress of the rebase in progress, or null.
   * @returns {Promise<import('../domain/entities').RebaseProgress|null>}
   */
  async rebaseProgress() {
    const read = (dir, name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8').trim();
      } catch {
        return null;
      }
    };
    const merge = await this.gitPath('rebase-merge');
    if (fs.existsSync(merge)) {
      const sha = read(merge, 'stopped-sha');
      const forEdit = fs.existsSync(path.join(merge, 'amend'));
      let subject = '';
      if (sha && forEdit) subject = (await this.git.run(['log', '-1', '--format=%s', sha], { allowFailure: true })).trim();
      return {
        current: parseInt(read(merge, 'msgnum') || '0', 10) || 0,
        total: parseInt(read(merge, 'end') || '0', 10) || 0,
        stoppedForEdit: forEdit,
        stoppedSha: sha ? sha.slice(0, 8) : null,
        stoppedSubject: subject,
      };
    }
    const apply = await this.gitPath('rebase-apply');
    if (fs.existsSync(apply)) {
      return {
        current: parseInt(read(apply, 'next') || '0', 10) || 0,
        total: parseInt(read(apply, 'last') || '0', 10) || 0,
        stoppedForEdit: false,
        stoppedSha: null,
        stoppedSubject: '',
      };
    }
    return null;
  }

  // ---------------------------------------------------------------- clean

  /**
   * What `git clean -n` removes with these options. Nested repositories are
   * only removed with a doubled force: they are listed too (from
   * `-n -f -f`), flagged nestedRepo.
   * @param {import('../domain/entities').CleanOptions} o
   * @returns {Promise<import('../domain/entities').CleanEntry[]>}
   */
  async cleanPreview(o) {
    const flags = cleanFlags(o);
    const [plain, forced] = await Promise.all([
      this.git.run(['clean', '-n', ...flags]),
      // Without -d git does not descend into untracked folders, repositories included.
      o.directories ? this.git.run(['clean', '-n', '-f', '-f', ...flags]) : Promise.resolve(''),
    ]);
    return cleanEntries(plain, forced);
  }

  /**
   * `git clean -f` of exactly `entries` (literal pathspecs, in batches:
   * git clean reads no pathspec file). Nested repositories go through their
   * own `-f -f` run so the doubled force applies to nothing else. Tracked
   * files are never touched: git clean only removes untracked paths.
   * @param {import('../domain/entities').CleanOptions} o
   * @param {import('../domain/entities').CleanEntry[]} entries
   */
  async clean(o, entries) {
    const flags = cleanFlags(o);
    const spec = (e) => lit(e.directory ? `${e.path}/` : e.path);
    const runs = [
      { force: ['-f'], list: entries.filter((e) => !e.nestedRepo) },
      { force: ['-f', '-f'], list: entries.filter((e) => e.nestedRepo) },
    ];
    for (const r of runs) {
      for (const batch of batchPathspecs(r.list.map(spec))) {
        await this.git.run(['clean', ...r.force, ...flags, '--', ...batch], { log: true });
      }
    }
  }

  // ---------------------------------------------------------------- worktrees

  /**
   * Worktrees of the repository (`git worktree list --porcelain -z`), the
   * main one first, the one at this.root marked current.
   * @returns {Promise<import('../domain/entities').Worktree[]>}
   */
  async worktrees() {
    let r = await this.git.raw(['worktree', 'list', '--porcelain', '-z']);
    let out = r.stdout;
    if (r.code !== 0) {
      // git before 2.36 has no -z: one attribute per line instead.
      r = await this.git.raw(['worktree', 'list', '--porcelain']);
      if (r.code !== 0) return [];
      out = r.stdout.replace(/\r?\n/g, '\0');
    }
    // git's spelling of this folder (long names, forward slashes) to find the current one.
    const top = (await this.git.run(['rev-parse', '--show-toplevel'], { allowFailure: true })).trim();
    return parseWorktrees(out, top || this.root).map((w) => ({ ...w, path: path.normalize(w.path) }));
  }

  /**
   * Adds a worktree at `o.path`: with an existing branch, a new branch
   * (`-b`) from `o.startPoint`, or detached at `o.startPoint`.
   * @param {{path: string, branch?: string, newBranch?: string, startPoint?: string, detach?: boolean}} o
   */
  addWorktree(o) {
    const args = ['worktree', 'add'];
    if (o.newBranch) args.push('-b', o.newBranch);
    else if (o.detach) args.push('--detach');
    args.push('--', o.path);
    const rev = o.newBranch || o.detach ? o.startPoint : o.branch;
    if (rev) args.push(rev);
    return this.git.run(args, { log: true });
  }

  lockWorktree(p, reason = '') {
    return this.git.run(['worktree', 'lock', ...(reason.trim() ? ['--reason', reason.trim()] : []), '--', p], { log: true });
  }

  unlockWorktree(p) {
    return this.git.run(['worktree', 'unlock', '--', p], { log: true });
  }

  /** Removes a worktree; `force` also discards its local changes. */
  removeWorktree(p, force = false) {
    return this.git.run(['worktree', 'remove', ...(force ? ['--force'] : []), '--', p], { log: true });
  }

  /**
   * Prunes the administrative files of worktrees whose folder is gone;
   * `dryRun` only lists them. Returns git's lines ("Removing worktrees/x: …").
   */
  async pruneWorktrees(dryRun) {
    const r = await this.git.raw(['worktree', 'prune', '-v', ...(dryRun ? ['-n'] : [])], { log: !dryRun });
    if (r.code !== 0) throw new GitError(['worktree', 'prune'], r.code, r.stderr, r.stdout);
    return `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  /** Whether the worktree at `p` has modified or untracked files. */
  async worktreeHasChanges(p) {
    const r = await new GitRunner(p, { gitPath: this.git.gitPath }).raw(['--no-optional-locks', 'status', '--porcelain']);
    return r.code !== 0 || !!r.stdout.trim();
  }

  // ---------------------------------------------------------------- bisect

  /** Text of a file of the git folder (`git rev-parse --git-path`), or null. */
  async readGitFile(name) {
    try {
      return fs.readFileSync(await this.gitPath(name), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * The bisect session of this worktree (BISECT_START), or null: marks from
   * refs/bisect/*, progress from `git rev-list --bisect-vars`, and the
   * first bad commit once git found it (BISECT_LOG).
   * @returns {Promise<import('../domain/entities').BisectState|null>}
   */
  async bisectState() {
    const start = await this.readGitFile('BISECT_START');
    if (start === null) return null;
    const refs = parseBisectRefs(await this.git.run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/bisect/'], { allowFailure: true }));
    const log = parseBisectLog((await this.readGitFile('BISECT_LOG')) || '');
    // The result line stays in the log: it holds while the bad mark is that commit.
    const firstBad = log.firstBad && refs.bad === log.firstBad ? log.firstBad : null;
    let progress = null;
    if (refs.bad && refs.good.length && !firstBad) {
      const vars = await this.git.raw(['rev-list', '--bisect-vars', refs.bad, '--not', ...refs.good]);
      if (vars.code === 0) progress = parseBisectVars(vars.stdout);
    }
    const head = await this.git.raw(['log', '-1', '--format=%H%x1f%s', 'HEAD']);
    const [hash, subject] = head.code === 0 ? head.stdout.trim().split(FS) : [null, ''];
    return {
      start: start.trim(),
      bad: refs.bad,
      good: refs.good,
      skipped: refs.skipped,
      marks: bisectMarks(refs),
      remaining: progress ? progress.remaining : null,
      steps: progress ? progress.steps : null,
      head: hash || null,
      headSubject: subject || '',
      firstBad,
      firstBadSubject: firstBad ? log.firstBadSubject : '',
    };
  }

  /**
   * Marks `rev` (HEAD when omitted) good, bad or skipped, starting a session
   * first when none is in progress. git checks out the next commit to test
   * once a good and a bad commit are known. Returns git's output.
   * @param {'good'|'bad'|'skip'} mark
   * @param {string} [rev]
   */
  async bisectMark(mark, rev) {
    if ((await this.readGitFile('BISECT_START')) === null) await this.git.run(['bisect', 'start'], { log: true });
    const args = ['bisect', mark, ...(rev ? [rev] : [])];
    const r = await this.git.raw(args, { log: true });
    if (r.code !== 0) throw new GitError(args, r.code, r.stderr, r.stdout);
    return `${r.stdout}\n${r.stderr}`.trim();
  }

  /** Ends the session and checks out the branch it started from. */
  bisectReset() {
    return this.git.run(['bisect', 'reset'], { log: true });
  }

  /**
   * `git bisect run <command>`: git runs the command on each commit to
   * test, exit code 0 = good, 125 = skip, other = bad. The output is
   * streamed to the log.
   * @param {string} command a shell command line
   */
  async bisectRun(command) {
    // git quotes each argument of `bisect run` as one word: a command line
    // with spaces would be taken as a program name. `sh -c` (git's own shell
    // on Windows) runs it as a command line and passes the exit code on.
    const r = await this.git.raw(['bisect', 'run', 'sh', '-c', command], { log: true, stream: true });
    return { code: r.code, output: `${r.stdout}\n${r.stderr}`.trim() };
  }

  // ---------------------------------------------------------------- signing

  /**
   * Signing settings: effective ones, or those of one config file (scope).
   * @param {'local'|'global'} [scope]
   * @returns {Promise<import('../domain/entities').SigningConfig>}
   */
  async signingConfig(scope) {
    const out = await this.git.run(['config', ...(scope ? [`--${scope}`] : []), '--get-regexp', SIGNING_CONFIG_REGEX], { allowFailure: true });
    return parseSigningConfig(out);
  }

  /**
   * Sets (or, with null, removes) a config value in the repository's config
   * or the user's global one.
   * @param {string} key @param {string|null} value @param {'local'|'global'} scope
   */
  async setConfig(key, value, scope) {
    if (value === null) {
      const args = ['config', `--${scope}`, '--unset-all', key];
      const r = await this.git.raw(args, { log: true });
      // 5: the key was not set.
      if (r.code !== 0 && r.code !== 5) throw new GitError(args, r.code, r.stderr, r.stdout);
      return;
    }
    await this.git.run(['config', `--${scope}`, key, value], { log: true });
  }

  /**
   * Signs a throwaway commit object (`git commit-tree -S` of HEAD's tree, no
   * ref points to it) with the current settings, or with `o` instead of the
   * configured format / key. ok = git signed it; output: git's error otherwise.
   * @param {{format?: import('../domain/entities').SigningFormat, key?: string|null}} [o]
   * @returns {Promise<{ok: boolean, output: string}>}
   */
  async testSigning(o = {}) {
    const cfg = [];
    if (o.format) cfg.push('-c', `gpg.format=${o.format}`);
    if (o.key) cfg.push('-c', `user.signingkey=${o.key}`);
    const tree = (await this.refExists('HEAD')) ? 'HEAD^{tree}' : await this.emptyTree();
    const r = await this.git.raw([...cfg, 'commit-tree', '-S', tree], { stdin: 'Git Tools signing test\n', log: true });
    if (r.code === 0) return { ok: true, output: r.stdout.trim() };
    return { ok: false, output: (r.stderr || r.stdout).trim() || `git commit-tree exited with code ${r.code}` };
  }

  /**
   * Signatures of the given commits (`%G?` `%GS` `%GK` `%GT`), in one git
   * call: verifying runs gpg / ssh-keygen per signed commit, so callers ask
   * only for the commits they show. Commits git cannot read are left out.
   * @param {string[]} hashes
   * @returns {Promise<Map<string, import('../domain/entities').Signature>>}
   */
  async signatures(hashes) {
    /** @type {Map<string, import('../domain/entities').Signature>} */
    const result = new Map();
    const list = [...new Set(hashes)].filter((h) => /^[0-9a-f]{7,64}$/.test(h));
    if (!list.length) return result;
    const r = await this.git.raw(['log', '--no-walk=unsorted', '--stdin', `--format=%H${FS}%G?${FS}%GS${FS}%GK${FS}%GT${RS}`],
      { stdin: `${list.join('\n')}\n` });
    if (r.code !== 0) return result;
    for (let rec of r.stdout.split(RS)) {
      rec = rec.replace(/^\s+/, '');
      if (!rec) continue;
      const f = rec.split(FS);
      result.set(f[0], makeSignature(f[1] || 'N', f[2] || '', f[3] || '', (f[4] || '').trim()));
    }
    return result;
  }

  /**
   * `git tag -v` of an annotated tag: null for a lightweight tag, signed
   * false for an annotated tag without signature.
   * @param {string} name
   * @returns {Promise<{name: string, signed: boolean, signature: import('../domain/entities').Signature|null, output: string}|null>}
   */
  async verifyTag(name) {
    const ref = `refs/tags/${name}`;
    const type = await this.git.raw(['cat-file', '-t', ref]);
    if (type.code !== 0 || type.stdout.trim() !== 'tag') return null;
    const raw = await this.git.run(['cat-file', 'tag', ref], { allowFailure: true });
    if (!hasTagSignature(raw)) return { name, signed: false, signature: null, output: '' };
    const r = await this.git.raw(['tag', '-v', name]);
    const output = r.stderr.trim();
    return { name, signed: true, signature: tagVerification(r.code, output), output };
  }

  // ---------------------------------------------------------------- blame

  /**
   * `git blame --porcelain` of `rel`: the committed file, or `contents` (an
   * editor with unsaved changes) read from stdin with `--contents -`.
   * @param {string} rel
   * @param {string} [contents]
   * @returns {Promise<import('../domain/entities').Blame>}
   */
  async blame(rel, contents) {
    const args = ['blame', '--porcelain', ...(contents !== undefined ? ['--contents', '-'] : []), '--', rel];
    return parseBlamePorcelain(await this.git.run(args, { stdin: contents }));
  }
}

module.exports = {
  Repository, parseStatus, parseCommits, parseRefs, parseNameStatus, parseReflog, splitN, parseSubmoduleField,
};
