// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const {
  newShelfId, isShelfDir, shelfRef, serializeShelf, updateShelfJson, parseShelf, newestFirst,
} = require('../domain/logic/shelf');

/** @typedef {import('../domain/entities').Shelf} Shelf */
/** @typedef {import('../domain/entities').ShelfFile} ShelfFile */

const JSON_FILE = 'shelf.json';
const PATCH_FILE = 'changes.patch';

/**
 * ShelfStore (see domain/ports.js): one folder per shelf below
 * `<git-common-dir>/git-tools/shelf/` (shared by worktrees, never tracked),
 * holding shelf.json and changes.patch, plus refs/git-tools/shelf/<id> so
 * that git gc keeps the base commit. Same format as the Flutter app.
 * @implements {import('../domain/ports').ShelfStore}
 */
class ShelfStore {
  /** @param {import('./gitRepository').Repository} repo */
  constructor(repo) {
    this.repo = repo;
  }

  async root() {
    return path.join(await this.repo.commonDir(), 'git-tools', 'shelf');
  }

  /** Folder of shelf `id` (ids come from folder names: never a path). */
  async dir(id) {
    if (!isShelfDir(id)) throw new Error(`Invalid shelf id: ${id}`);
    return path.join(await this.root(), id);
  }

  /**
   * Shelves, newest first. Folders without a readable shelf.json and patch
   * (e.g. one being written) are skipped.
   * @returns {Promise<Shelf[]>}
   */
  async list() {
    const root = await this.root();
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && isShelfDir(d.name)).map((d) => d.name);
    } catch {
      return [];
    }
    /** @type {Shelf[]} */
    const shelves = [];
    for (const id of names) {
      try {
        if (!fs.existsSync(path.join(root, id, PATCH_FILE))) continue;
        const s = parseShelf(fs.readFileSync(path.join(root, id, JSON_FILE), 'utf8'), id);
        if (s) shelves.push(s);
      } catch {
        // not a shelf (yet)
      }
    }
    return newestFirst(shelves);
  }

  /** @returns {Promise<Shelf|null>} */
  async get(id) {
    try {
      return parseShelf(fs.readFileSync(path.join(await this.dir(id), JSON_FILE), 'utf8'), id);
    } catch {
      return null;
    }
  }

  /**
   * Writes a new shelf: patch and ref first, shelf.json last, so a shelf is
   * listed only once complete.
   * @param {{name: string, created: Date, base: string, branch: string|null, files: ShelfFile[], patch: Buffer}} o
   * @returns {Promise<Shelf>}
   */
  async create(o) {
    const root = await this.root();
    let id = newShelfId(o.created);
    while (fs.existsSync(path.join(root, id))) id = newShelfId(o.created);
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      writeAtomic(path.join(dir, PATCH_FILE), o.patch);
      await this.repo.setRef(shelfRef(id), o.base);
      writeAtomic(path.join(dir, JSON_FILE), serializeShelf(o));
    } catch (e) {
      await this.repo.deleteRef(shelfRef(id));
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return /** @type {Shelf} */ (await this.get(id));
  }

  /** @returns {Promise<Buffer>} */
  async readPatch(id) {
    return fs.readFileSync(path.join(await this.dir(id), PATCH_FILE));
  }

  async rename(id, name) {
    const file = path.join(await this.dir(id), JSON_FILE);
    writeAtomic(file, updateShelfJson(fs.readFileSync(file, 'utf8'), { name }));
  }

  /**
   * Replaces the files and the patch (after some files were unshelved).
   * @param {string} id
   * @param {{files: ShelfFile[], patch: Buffer}} o
   */
  async update(id, o) {
    const dir = await this.dir(id);
    const file = path.join(dir, JSON_FILE);
    const json = updateShelfJson(fs.readFileSync(file, 'utf8'), { files: o.files });
    writeAtomic(path.join(dir, PATCH_FILE), o.patch);
    writeAtomic(file, json);
  }

  /** Deletes the shelf folder and its ref. */
  async remove(id) {
    const dir = await this.dir(id);
    await this.repo.deleteRef(shelfRef(id));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes through a temporary file, so a reader never sees half a file. */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { ShelfStore, JSON_FILE, PATCH_FILE };
