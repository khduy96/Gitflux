// @ts-check
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseGpgSecretKeys, parseSshPublicKeys } = require('../domain/logic/signing');

/**
 * SigningKeys (see domain/ports.js): the keys of this machine the Signing
 * Settings dialog offers. Read only: lists keys, never creates or changes one.
 * @implements {import('../domain/ports').SigningKeys}
 */
class SigningKeys {
  /**
   * @param {{gitPath?: string, home?: string, env?: Record<string, string|undefined>}} [o]
   *   home: folder holding .ssh (the user's home by default); env: environment of gpg / ssh-add (GNUPGHOME…).
   */
  constructor(o = {}) {
    this.gitPath = o.gitPath || 'git';
    this.home = o.home || os.homedir();
    this.env = o.env || process.env;
  }

  /**
   * Runs a program; missing: it could not be started (not installed).
   * @param {string} file @param {string[]} args
   * @returns {Promise<{code: number, stdout: string, stderr: string, missing: boolean}>}
   */
  exec(file, args, timeout = 15000) {
    return new Promise((resolve) => {
      execFile(file, args, { env: /** @type {any} */ (this.env), timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const e = /** @type {any} */ (err);
          resolve({
            code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            missing: !!e && e.code === 'ENOENT',
          });
        });
    });
  }

  /**
   * The gpg that Git for Windows ships (<git>/usr/bin/gpg.exe): git signs with
   * it when gpg.program is not set, even though it is not on the PATH of
   * other programs. Null when there is none.
   */
  async bundledGpg() {
    if (process.platform !== 'win32') return null;
    const r = await this.exec(this.gitPath, ['--exec-path']);
    if (r.code !== 0) return null;
    const exec = r.stdout.trim();
    for (const up of ['../../..', '../..', '..']) {
      const candidate = path.resolve(exec, up, 'usr', 'bin', 'gpg.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Secret keys able to sign (`gpg --list-secret-keys --with-colons`).
   * Throws when gpg cannot be run.
   * @param {string|null} [program] gpg.program
   */
  async gpgKeys(program) {
    const args = ['--batch', '--list-secret-keys', '--with-colons', '--fixed-list-mode'];
    const prog = program || 'gpg';
    let r = await this.exec(prog, args);
    if (r.missing && !program) {
      const bundled = await this.bundledGpg();
      if (bundled) r = await this.exec(bundled, args);
    }
    if (r.missing) throw new Error(`${prog} was not found. Install GnuPG or set gpg.program.`);
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.trim() || `${prog} exited with code ${r.code}`);
    return parseGpgSecretKeys(r.stdout);
  }

  /**
   * Public keys in ~/.ssh (*.pub), with the private key next to them when
   * there is one.
   * @returns {Promise<{path: string, privatePath: string|null, key: import('../domain/logic/signing').SshKey}[]>}
   */
  async sshKeyFiles() {
    const dir = path.join(this.home, '.ssh');
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.pub')).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        const [key] = parseSshPublicKeys(fs.readFileSync(file, 'utf8'));
        const priv = file.slice(0, -4);
        if (key) out.push({ path: file, privatePath: fs.existsSync(priv) ? priv : null, key });
      } catch {
        // unreadable: skipped
      }
    }
    return out;
  }

  /** Keys the running ssh-agent holds (`ssh-add -L`); [] without an agent. */
  async sshAgentKeys() {
    const r = await this.exec('ssh-add', ['-L'], 5000);
    return r.code === 0 ? parseSshPublicKeys(r.stdout) : [];
  }
}

module.exports = { SigningKeys };
