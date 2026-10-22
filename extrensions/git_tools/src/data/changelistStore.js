// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { emptyChangelists, parseChangelists, serializeChangelists } = require('../domain/logic/changelists');

/** @typedef {import('../domain/entities').ChangelistsData} ChangelistsData */

/**
 * ChangelistStore (see domain/ports.js): `git-tools/changelists.json` in the
 * git folder of this worktree (git rev-parse --git-path), never tracked.
 * Same format as the Flutter app, which may change the file at any time:
 * callers read it again before every change.
 * @implements {import('../domain/ports').ChangelistStore}
 */
class ChangelistStore {
  /** @param {import('./gitRepository').Repository} repo */
  constructor(repo) {
    this.repo = repo;
    /** @type {string|undefined} */
    this._file = undefined;
  }

  async file() {
    if (!this._file) this._file = await this.repo.gitPath('git-tools/changelists.json');
    return this._file;
  }

  /**
   * The lists; only the default one when the file does not exist yet.
   * Throws when the file exists but is not a changelists file, so that it
   * is not overwritten.
   * @returns {Promise<ChangelistsData>}
   */
  async read() {
    const file = await this.file();
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return emptyChangelists();
      throw e;
    }
    const data = parseChangelists(text);
    if (!data) throw new Error(`${file} is not a valid changelists file.`);
    return data;
  }

  /** @param {ChangelistsData} data */
  async write(data) {
    const file = await this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Temporary file of this process, then rename: a reader (this window,
    // another one or the Flutter app) never sees half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serializeChangelists(data));
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}

module.exports = { ChangelistStore };
