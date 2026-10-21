// @ts-check
'use strict';

/**
 * Commit and tag signing (GPG / SSH / X.509): git arguments, git config,
 * key listings and signature status. Pure functions, no git.
 *
 * @typedef {import('../entities').SigningFormat} SigningFormat
 * @typedef {import('../entities').SigningConfig} SigningConfig
 * @typedef {import('../entities').Signature} Signature
 * @typedef {import('../entities').SignatureLevel} SignatureLevel
 *
 * @typedef {{keyId: string, fingerprint: string, uid: string, uids: string[], created: number|null, expires: number|null,
 *   expired: boolean, revoked: boolean, disabled: boolean, secret: boolean}} GpgKey
 *   A secret key able to sign (`gpg --list-secret-keys --with-colons`); times in ms. `secret`: the secret part
 *   of a signing key is on this machine (not a stub of a key on a card that is missing).
 * @typedef {{type: string, data: string, comment: string, literal: string}} SshKey
 *   A public key line; literal = "<type> <data>" (the value of `key::` in user.signingkey).
 */

/** The `-S` / `--no-gpg-sign` arguments of commit, merge and rebase; none when the config decides. @param {boolean|null|undefined} sign */
const signArgs = (sign) => (sign === true ? ['-S'] : sign === false ? ['--no-gpg-sign'] : []);

/** Config keys read by signingConfig (as `git config --get-regexp` prints them: lower case). */
const SIGNING_KEYS = /^(commit\.gpgsign|tag\.gpgsign|user\.signingkey|gpg\.format|gpg\.program|gpg\.(openpgp|x509|ssh)\.program|gpg\.ssh\.allowedsignersfile)$/;

/** Regex for `git config --get-regexp` matching the keys above. */
const SIGNING_CONFIG_REGEX = '^(commit\\.gpgsign|tag\\.gpgsign|user\\.signingkey|gpg\\.)';

/** git's boolean config values. @param {string|undefined} v */
function configBool(v) {
  if (v === undefined) return false;
  return /^(true|yes|on|1|)$/i.test(v.trim());
}

/** @returns {SigningConfig} */
const emptySigningConfig = () => ({
  commitSign: false, tagSign: false, format: 'openpgp', signingKey: null, program: null, sshProgram: null, allowedSignersFile: null,
});

/**
 * Signing settings from `git config --get-regexp` lines ("key value", the
 * last value of a key wins).
 * @param {string} text
 * @returns {SigningConfig}
 */
function parseSigningConfig(text) {
  /** @type {Map<string, string>} */
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(' ');
    const key = (i < 0 ? line : line.slice(0, i)).toLowerCase();
    if (SIGNING_KEYS.test(key)) values.set(key, i < 0 ? '' : line.slice(i + 1));
  }
  const f = (values.get('gpg.format') || '').trim().toLowerCase();
  /** @type {SigningFormat} */
  const format = f === 'ssh' || f === 'x509' ? f : 'openpgp';
  const opt = (k) => {
    const v = values.get(k);
    return v !== undefined && v.trim() ? v.trim() : null;
  };
  const program = format === 'openpgp' ? opt('gpg.openpgp.program') || opt('gpg.program')
    : format === 'x509' ? opt('gpg.x509.program') : opt('gpg.ssh.program');
  return {
    commitSign: configBool(values.get('commit.gpgsign')),
    tagSign: configBool(values.get('tag.gpgsign')),
    format,
    signingKey: opt('user.signingkey'),
    program,
    sshProgram: opt('gpg.ssh.program'),
    allowedSignersFile: opt('gpg.ssh.allowedsignersfile'),
  };
}

/** The program git runs to sign with `format` (the configured one, or git's default). @param {SigningConfig} c */
const signingProgram = (c) => c.program || (c.format === 'ssh' ? 'ssh-keygen' : c.format === 'x509' ? 'gpgsm' : 'gpg');

/** gpg escapes ':' and control characters in --with-colons fields as \xNN. */
const unescapeColons = (s) => s.replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

/** Seconds since 1970 (or an ISO 8601 date) of a --with-colons field, in ms; null when empty. */
function colonTime(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const t = Date.parse(s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6Z'));
  return Number.isNaN(t) ? null : t;
}

/**
 * Secret keys able to sign, from `gpg --list-secret-keys --with-colons`.
 * Expired, revoked and disabled keys are kept (flagged) so the picker can
 * show why they cannot be used.
 * @param {string} text
 * @param {number} [now] ms, to flag keys past their expiry date
 * @returns {GpgKey[]}
 */
function parseGpgSecretKeys(text, now = Date.now()) {
  /** @type {GpgKey[]} */
  const keys = [];
  /** @type {(GpgKey & {canSign: boolean})|null} */
  let key = null;
  /** The record the next fpr line belongs to. */
  let last = '';
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(':');
    const type = f[0];
    if (type === 'sec') {
      const validity = f[1] || '';
      const caps = f[11] || '';
      const expires = colonTime(f[6]);
      key = {
        keyId: f[4] || '',
        fingerprint: '',
        uid: '',
        uids: [],
        created: colonTime(f[5]),
        expires,
        expired: validity === 'e' || (expires !== null && expires < now),
        revoked: validity === 'r',
        disabled: /D/.test(caps) || validity === 'd',
        // Upper case: usable capabilities of the whole key (subkeys included).
        canSign: /S/.test(caps) || /s/.test(caps),
        secret: (f[14] || '') !== '#',
      };
      keys.push(key);
      last = 'sec';
    } else if (type === 'ssb' && key) {
      if (/s/.test(f[11] || '')) {
        key.canSign = true;
        if ((f[14] || '') !== '#') key.secret = true;
      }
      last = 'ssb';
    } else if (type === 'fpr' && key) {
      if (last === 'sec' && !key.fingerprint) key.fingerprint = f[9] || '';
      last = '';
    } else if (type === 'uid' && key) {
      // Revoked user ids are skipped.
      if (f[1] !== 'r') key.uids.push(unescapeColons(f[9] || ''));
      if (!key.uid && key.uids.length) key.uid = key.uids[0];
      last = '';
    } else if (type !== 'grp') {
      last = '';
    }
  }
  return keys.filter((k) => k.canSign).map(({ canSign, ...k }) => k);
}

const SSH_KEY_LINE = /^((?:sk-)?(?:ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+)(?:@openssh\.com)?)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(.*))?$/;

/**
 * SSH public keys from `*.pub` files or `ssh-add -L` (one per line; other
 * lines, such as "The agent has no identities.", are skipped).
 * @param {string} text
 * @returns {SshKey[]}
 */
function parseSshPublicKeys(text) {
  /** @type {SshKey[]} */
  const keys = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = SSH_KEY_LINE.exec(raw.trim());
    if (m) keys.push({ type: m[1], data: m[2], comment: (m[3] || '').trim(), literal: `${m[1]} ${m[2]}` });
  }
  return keys;
}

/** user.signingkey for an SSH key given by its public key text rather than a file. @param {SshKey} k */
const sshKeyLiteral = (k) => `key::${k.literal}`;

/** Signature status of a `%G?` letter. */
const SIGNATURE_STATUS = {
  G: { level: 'good', text: 'Good signature' },
  U: { level: 'warning', text: 'Good signature, unknown validity (key not trusted)' },
  X: { level: 'warning', text: 'Good signature that has expired' },
  Y: { level: 'warning', text: 'Good signature made by an expired key' },
  R: { level: 'bad', text: 'Good signature made by a revoked key' },
  B: { level: 'bad', text: 'Bad signature' },
  E: { level: 'bad', text: 'Signature cannot be checked (missing key or allowed signers)' },
  N: { level: 'none', text: 'Not signed' },
};

/**
 * Level ('good' green, 'warning' yellow, 'bad' red, 'none' no badge) and
 * text of a `%G?` letter.
 * @param {string} code
 * @returns {{level: SignatureLevel, text: string}}
 */
function signatureStatus(code) {
  const s = SIGNATURE_STATUS[code] || SIGNATURE_STATUS.N;
  return { level: /** @type {SignatureLevel} */ (s.level), text: s.text };
}

/**
 * One signature from the `%G?` `%GS` `%GK` `%GT` fields.
 * @param {string} code @param {string} signer @param {string} key @param {string} trust
 * @returns {Signature}
 */
function makeSignature(code, signer = '', key = '', trust = '') {
  const c = /^[GBUXYREN]$/.test(code) ? code : 'N';
  return { code: c, signer, key, trust, ...signatureStatus(c) };
}

/**
 * Whether git's output says that signing (not the operation itself) failed:
 * no agent, wrong or missing key, pinentry cancelled, no allowed signers…
 * @param {string} text
 */
function isSigningFailure(text) {
  return /gpg failed to sign|unable to sign|signing failed|failed to sign|No secret key|secret key not available|unusable secret key|INV_SGNR|pinentry|Operation cancelled|No agent running|can't connect to the gpg-agent|agent refused|cannot run (gpg|gpgsm|ssh-keygen)|ssh-keygen|Couldn't (load|find|sign)|Load key .*:|user\.signingkey|gpg\.ssh\.defaultKeyCommand|Bad passphrase|gpgsm:/i.test(text || '');
}

/**
 * Verification of `git tag -v` (exit code and gpg / ssh-keygen output on
 * stderr) as a signature.
 * @param {number} code exit code
 * @param {string} output stderr
 * @returns {Signature}
 */
function tagVerification(code, output) {
  const text = output || '';
  const signer = (/Good (?:"git" )?signature (?:from|for) "?([^"\n]+?)"?(?: with |\s*\[|\n|$)/i.exec(text) || [])[1] || '';
  const key = (/using \S+ key ([0-9A-F]{8,})/i.exec(text) || /with \S+ key (\S+)/i.exec(text) || [])[1] || '';
  let letter = 'G';
  if (code !== 0) {
    letter = /BAD signature|Bad signature/.test(text) ? 'B'
      : /revoked/i.test(text) ? 'R' : 'E';
  } else if (/expired/i.test(text) && /key/i.test(text)) {
    letter = 'Y';
  } else if (/not certified with a trusted signature|no indication that the signature belongs|untrusted/i.test(text)) {
    letter = 'U';
  }
  return makeSignature(letter, signer, key, '');
}

/** Whether the raw text of a tag object carries a signature (OpenPGP, SSH or X.509). @param {string} raw */
const hasTagSignature = (raw) => /-----BEGIN (PGP SIGNATURE|SSH SIGNATURE|SIGNED MESSAGE)-----/.test(raw);

module.exports = {
  signArgs, SIGNING_CONFIG_REGEX, configBool, emptySigningConfig, parseSigningConfig, signingProgram, parseGpgSecretKeys,
  parseSshPublicKeys, sshKeyLiteral, signatureStatus, makeSignature, isSigningFailure, tagVerification, hasTagSignature,
  unescapeColons,
};
