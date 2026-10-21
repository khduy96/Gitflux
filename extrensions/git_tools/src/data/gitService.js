// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { GitRunner } = require('./gitRunner');
const { Repository } = require('./gitRepository');
const { ShelfStore } = require('./shelfStore');

/** Folders never scanned for repositories. */
const SCAN_SKIP = new Set(['node_modules', '.dart_tool', 'build', '.gradle', '.idea', '.vscode', 'Pods', 'dist', 'out', '.git']);

/**
 * GitService (see domain/ports.js) backed by the git command line.
 * @implements {import('../domain/ports').GitService}
 */
class GitCliService {
  /** @param {() => string} gitPath read on every call, so a settings change applies at once */
  constructor(gitPath) {
    this.gitPath = gitPath;
  }

  /** @returns {Promise<string|null>} top level of the repository containing dir */
  async findRoot(dir) {
    try {
      const r = await new GitRunner(dir, { gitPath: this.gitPath() }).raw(['rev-parse', '--show-toplevel']);
      return r.code === 0 && r.stdout.trim() ? path.normalize(r.stdout.trim()) : null;
    } catch {
      return null;
    }
  }

  /** @param {string} root @param {{log?: import('../domain/ports').GitLog}} [o] */
  open(root, o = {}) {
    return new Repository(root, { gitPath: this.gitPath(), log: o.log });
  }

  /** @param {import('../domain/ports').GitRepository} repo a Repository from open() */
  shelfStore(repo) {
    return new ShelfStore(/** @type {Repository} */ (repo));
  }

  isRepository(dir) {
    return fs.existsSync(path.join(dir, '.git'));
  }

  scan(dir, depth) {
    /** @type {string[]} */
    const found = [];
    const walk = (d, level) => {
      if (level > depth) return;
      let entries = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory() || SCAN_SKIP.has(e.name)) continue;
        const child = path.join(d, e.name);
        if (this.isRepository(child)) found.push(child);
        walk(child, level + 1);
      }
    };
    walk(dir, 1);
    return found;
  }
}

module.exports = { GitCliService };
