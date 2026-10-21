// @ts-check
'use strict';

const { spawn } = require('child_process');
const { GitError } = require('../domain/errors');

const GLOBAL_ARGS = [
  '-c', 'core.quotepath=false',
  '-c', 'color.ui=false',
  '-c', 'i18n.logOutputEncoding=UTF-8',
  '-c', 'advice.detachedHead=false',
];

const ENV = {
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C.UTF-8',
  LANG: 'en_US.UTF-8',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
};

/** Marks a path as a literal pathspec (glob characters are not expanded). */
const lit = (p) => `:(literal)${p}`;

/** NUL separated literal pathspecs for `--pathspec-from-file=- --pathspec-file-nul`. */
const pathspecs = (paths) => `${paths.map(lit).join('\0')}\0`;

/**
 * Low level git runner.
 */
class GitRunner {
  /**
   * @param {string} cwd
   * @param {{gitPath?: string, log?: import('../domain/ports').GitLog}} [opts]
   */
  constructor(cwd, opts = {}) {
    this.cwd = cwd;
    this.gitPath = opts.gitPath || 'git';
    this.log = opts.log || (() => {});
  }

  /**
   * @param {string[]} args
   * stream: with log, stdout lines are logged as they arrive (long running
   * commands such as `git bisect run`) instead of once git exits.
   * @param {{log?: boolean, stdin?: string, allowFailure?: boolean, binary?: boolean, env?: Record<string,string>, stream?: boolean}} [o]
   * @returns {Promise<{code: number, stdout: string, stderr: string, bytes: Buffer}>}
   */
  raw(args, o = {}) {
    if (o.log) this.log(`git ${args.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ')}`, 'command');
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, [...GLOBAL_ARGS, ...args], {
        cwd: this.cwd,
        env: { ...process.env, ...ENV, ...(o.env || {}) },
        windowsHide: true,
      });
      /** @type {Buffer[]} */
      const out = [];
      let err = '';
      let partial = '';
      const streamed = !!(o.log && o.stream);
      child.stdout.on('data', (d) => {
        out.push(d);
        if (!streamed) return;
        const lines = (partial + d.toString('utf8')).split(/\r?\n|\r/);
        partial = lines.pop() || '';
        for (const line of lines) if (line.trim()) this.log(line, 'output');
      });
      child.stderr.on('data', (d) => {
        const s = d.toString('utf8');
        err += s;
        if (o.log) {
          for (const line of s.split(/\r?\n|\r/)) if (line.trim()) this.log(line, 'output');
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        const bytes = Buffer.concat(out);
        const stdout = bytes.toString('utf8');
        if (streamed && partial.trim()) this.log(partial, 'output');
        if (o.log && !streamed) {
          const lines = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
          for (const line of lines.slice(0, 200)) this.log(line, 'output');
          if (lines.length > 200) this.log(`… ${lines.length - 200} more lines`, 'output');
        }
        if (o.log && code !== 0) this.log(`exit code ${code}`, 'error');
        resolve({ code: code ?? -1, stdout, stderr: err, bytes });
      });
      if (o.stdin !== undefined) child.stdin.end(o.stdin);
      else child.stdin.end();
    });
  }

  /**
   * Runs git and returns stdout; throws GitError on failure.
   * @param {string[]} args
   * @param {{log?: boolean, stdin?: string, allowFailure?: boolean, env?: Record<string,string>, stream?: boolean}} [o]
   */
  async run(args, o = {}) {
    const r = await this.raw(args, o);
    if (r.code !== 0 && !o.allowFailure) throw new GitError(args, r.code, r.stderr, r.stdout);
    return r.stdout;
  }
}

module.exports = { GitRunner, lit, pathspecs };
