// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { GitError } = require('../domain/errors');
const {
  parsePointer, parseCheckAttrLfs, parseLsFiles, parseLocksJson, parseVerifyLocksJson, parseTrackList, removeAttrPattern,
} = require('../domain/logic/lfs');

/** @typedef {import('../domain/entities').LfsPointer} LfsPointer */
/** @typedef {import('../domain/entities').LfsLock} LfsLock */
/** @typedef {import('../domain/entities').LfsPattern} LfsPattern */

/** `git lfs version` per git executable, for the session (null: git-lfs is not installed). @type {Map<string, Promise<string|null>>} */
const versions = new Map();

/** Lock queries talk to the LFS server: they give up after this long. */
const LOCKS_TIMEOUT = 15000;

/**
 * GitLfs (see domain/ports.js): git-lfs commands of one repository, run
 * through its git runner.
 * @implements {import('../domain/ports').GitLfs}
 */
class GitLfs {
  /** @param {import('./gitRepository').Repository} repo */
  constructor(repo) {
    this.repo = repo;
  }

  get git() {
    return this.repo.git;
  }

  /** `git lfs version` ("git-lfs/3.6.1 (…)"), null when git-lfs is not installed. Cached per session. */
  version() {
    const key = this.git.gitPath;
    if (!versions.has(key)) {
      versions.set(key, this.git.raw(['lfs', 'version'])
        .then((r) => (r.code === 0 && /git-lfs\//i.test(r.stdout) ? r.stdout.trim() : null))
        .catch(() => null));
    }
    return /** @type {Promise<string|null>} */ (versions.get(key));
  }

  async available() {
    return !!(await this.version());
  }

  /**
   * Which of `paths` git-lfs stores (`filter=lfs` from .gitattributes,
   * `git check-attr`): one git call, no git-lfs process.
   * @param {string[]} paths repository relative
   * @returns {Promise<Set<string>>}
   */
  async lfsPaths(paths) {
    if (!paths.length || !(await this.available())) return new Set();
    const r = await this.git.raw(['check-attr', '-z', '--stdin', 'filter'], { stdin: `${paths.join('\0')}\0` });
    return r.code === 0 ? parseCheckAttrLfs(r.stdout) : new Set();
  }

  /**
   * Files stored in LFS at `ref` (HEAD by default), `git lfs ls-files --json`.
   * @param {string} [ref]
   */
  async lsFiles(ref) {
    const r = await this.git.raw(['lfs', 'ls-files', '--json', ...(ref ? [ref] : [])]);
    if (r.code === 0) return parseLsFiles(r.stdout);
    // Before git-lfs 3.4: the text listing with full object ids.
    return parseLsFiles(await this.git.run(['lfs', 'ls-files', '-l', ...(ref ? [ref] : [])], { allowFailure: true }));
  }

  /**
   * Patterns tracked by LFS (`git lfs track`), from every .gitattributes;
   * excluded patterns are left out.
   * @returns {Promise<LfsPattern[]>}
   */
  async trackedPatterns() {
    const r = await this.git.raw(['lfs', 'track', '--json']);
    if (r.code === 0 && r.stdout.trim().startsWith('{')) return parseTrackList(r.stdout);
    return parseTrackList(await this.git.run(['lfs', 'track']));
  }

  /**
   * `git lfs track <pattern>`: adds it to the root .gitattributes.
   * filename: a file name taken literally (glob characters escaped).
   * @param {string} pattern
   * @param {{filename?: boolean}} [o]
   */
  track(pattern, o = {}) {
    return this.git.run(['lfs', 'track', ...(o.filename ? ['--filename'] : []), '--', pattern], { log: true });
  }

  /**
   * Stops tracking a pattern: `git lfs untrack` for the root .gitattributes;
   * a pattern git-lfs cannot remove (nested .gitattributes, escaped glob
   * characters) is removed from its file directly.
   * @param {LfsPattern|string} p a string is a pattern of the root .gitattributes
   */
  async untrack(p) {
    const lp = typeof p === 'string' ? { pattern: p, source: '.gitattributes', lockable: false } : p;
    const source = lp.source.replace(/\\/g, '/');
    const dir = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
    const file = path.join(this.repo.root, source);
    // As written in its own file: git-lfs lists nested patterns with their folder.
    const written = dir && lp.pattern.startsWith(`${dir}/`) ? lp.pattern.slice(dir.length + 1) : lp.pattern;
    const has = () => {
      try {
        const text = fs.readFileSync(file, 'utf8');
        return removeAttrPattern(text, written) !== text;
      } catch {
        return false;
      }
    };
    if (!dir) {
      // git-lfs takes the pattern unescaped ("my file.bin") or as written.
      await this.git.run(['lfs', 'untrack', '--', written.replace(/\[\[:space:\]\]/g, ' ')], { log: true, allowFailure: true });
    }
    if (has()) {
      this.git.log(`remove "${written}" from ${source}`, 'command');
      fs.writeFileSync(file, removeAttrPattern(fs.readFileSync(file, 'utf8'), written));
    }
  }

  pull() {
    return this.git.run(['lfs', 'pull'], { log: true });
  }

  fetch() {
    return this.git.run(['lfs', 'fetch'], { log: true });
  }

  /**
   * `git lfs prune` (`--dry-run --verbose` when dryRun): git-lfs's output
   * lines, progress redraws (carriage returns) split into lines.
   * @param {boolean} dryRun
   * @returns {Promise<string[]>}
   */
  async prune(dryRun) {
    const args = ['lfs', 'prune', ...(dryRun ? ['--dry-run', '--verbose'] : [])];
    const r = await this.git.raw(args, { log: !dryRun });
    if (r.code !== 0) throw new GitError(args, r.code, r.stderr, r.stdout);
    const lines = `${r.stdout}\n${r.stderr}`.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
    return lines.filter((l, i) => lines.indexOf(l) === i);
  }

  /**
   * Locks on the LFS server, null when locking is not available (no
   * remote, the server has no lock API, network or authentication error).
   * `mine`: from `git lfs locks --verify` ("ours"), or the owner name equal
   * to user.name when the server does not verify. Bounded: a server that
   * does not answer counts as no lock support.
   * @returns {Promise<LfsLock[]|null>}
   */
  async locks() {
    if (!(await this.available())) return null;
    const remotes = await this.git.run(['remote'], { allowFailure: true });
    if (!remotes.trim()) return null;
    const list = await this.bounded(['lfs', 'locks', '--json']);
    const locks = list.code === 0 ? parseLocksJson(list.stdout) : null;
    if (!locks) return null;
    if (!locks.length) {
      // git-lfs prints [] (exit code 0) for errors too with --json: the
      // text form tells them apart.
      const check = await this.bounded(['lfs', 'locks', '--limit', '1']);
      return check.code === 0 ? [] : null;
    }
    const verify = await this.bounded(['lfs', 'locks', '--verify', '--json']);
    const v = verify.code === 0 ? parseVerifyLocksJson(verify.stdout) : null;
    if (v && v.ours.length + v.theirs.length) {
      const ours = new Set(v.ours.map((l) => l.id));
      return locks.map((l) => ({ ...l, mine: ours.has(l.id) }));
    }
    const me = (await this.git.run(['config', '--get', 'user.name'], { allowFailure: true })).trim();
    return locks.map((l) => ({ ...l, mine: !!me && l.owner === me }));
  }

  /** @param {string} rel */
  lock(rel) {
    return this.git.run(['lfs', 'lock', '--', rel], { log: true });
  }

  /** `force`: also a lock of someone else. @param {string} rel @param {boolean} [force] */
  unlock(rel, force = false) {
    return this.git.run(['lfs', 'unlock', ...(force ? ['--force'] : []), '--', rel], { log: true });
  }

  /**
   * Pointer of `rel` at a revision ('' = index), null when that version is
   * not an LFS pointer (or does not exist).
   * @param {string} rev
   * @param {string} rel
   * @returns {Promise<LfsPointer|null>}
   */
  async pointerAt(rev, rel) {
    return parsePointer(await this.repo.show(rev, rel));
  }

  /**
   * Pointer of the working tree file (`git lfs pointer --file`): the file
   * itself when it is a pointer (object not downloaded). Null when missing.
   * @param {string} rel
   * @returns {Promise<LfsPointer|null>}
   */
  async workingPointer(rel) {
    const full = path.join(this.repo.root, rel);
    let size;
    try {
      size = fs.statSync(full).size;
    } catch {
      return null;
    }
    if (size <= 1024) {
      const own = parsePointer(fs.readFileSync(full));
      if (own) return own;
    }
    const r = await this.git.raw(['lfs', 'pointer', `--file=${rel}`]);
    return r.code === 0 ? parsePointer(r.stdout) : null;
  }

  /** LFS object folder: lfs.storage (relative to the git folder) or <git common dir>/lfs. */
  async storageDir() {
    const common = await this.repo.commonDir();
    const configured = (await this.git.run(['config', '--get', 'lfs.storage'], { allowFailure: true })).trim();
    return configured ? path.resolve(common, configured) : path.join(common, 'lfs');
  }

  /**
   * The local copy of an LFS object, null when it is not downloaded.
   * @param {string} oid sha256
   * @returns {Promise<string|null>}
   */
  async objectFile(oid) {
    if (!/^[0-9a-f]{64}$/.test(oid)) return null;
    const file = path.join(await this.storageDir(), 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
    return fs.existsSync(file) ? file : null;
  }

  /**
   * Runs git without prompting for credentials (also no credential manager
   * window), killed after `ms`: code -1 then.
   * @param {string[]} args
   * @param {number} [ms]
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  bounded(args, ms = LOCKS_TIMEOUT) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout: out, stderr: err });
      };
      const child = spawn(this.git.gitPath, ['-c', 'core.quotepath=false', ...args], {
        cwd: this.repo.root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C.UTF-8' },
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill();
        finish(-1);
      }, ms);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', () => finish(-1));
      child.on('close', (code) => finish(code ?? -1));
      child.stdin.end();
    });
  }
}

module.exports = { GitLfs };
