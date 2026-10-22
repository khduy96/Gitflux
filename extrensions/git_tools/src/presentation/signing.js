// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { sshKeyLiteral } = require('../domain/logic/signing');

/** @typedef {import('./model').RepoModel} RepoModel */
/** @typedef {import('../domain/entities').SigningConfig} SigningConfig */
/** @typedef {import('../domain/entities').SigningFormat} SigningFormat */
/** @typedef {import('../domain/ports').SigningKeys} SigningKeys */

const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });

const FORMAT_LABEL = { openpgp: 'OpenPGP (GPG)', ssh: 'SSH', x509: 'X.509 (gpgsm)' };

/** Scope of the settings: the repository's config or the user's global one. */
const SCOPES = [
  { id: 'local', label: 'This Repository', flag: 'git config --local' },
  { id: 'global', label: 'Global', flag: 'git config --global' },
];

/**
 * The Commit view's "Sign commit" choice: true / false, or null to follow
 * commit.gpgsign. Used by every command that creates commits.
 * @param {RepoModel} m
 * @returns {boolean|null}
 */
const signChoice = (m) => {
  const s = /** @type {any} */ (m).sign;
  return s === true || s === false ? s : null;
};

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** One-line summary of settings: "SSH · key ~/.ssh/id · commits signed". @param {SigningConfig} c */
function describeSigning(c) {
  return [
    FORMAT_LABEL[c.format],
    c.signingKey ? `key ${c.signingKey.startsWith('key::') ? `${c.signingKey.slice(5, 40)}…` : c.signingKey}` : 'no key set',
    c.commitSign ? 'commits signed' : 'commits not signed',
    c.tagSign ? 'tags signed' : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Shows that signing (not the operation) failed, with git's error and a way
 * to fix the settings. Nothing is retried unsigned.
 * @param {RepoModel} m
 * @param {string} label the operation, e.g. "Commit"
 * @param {string} details git's error output
 */
async function showSigningFailure(m, label, details) {
  const lines = String(details || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('[GNUPG:]'));
  const pick = await vscode.window.showErrorMessage(
    `${label} failed: the commit could not be signed. ${lines.slice(0, 4).join(' ')}`,
    'Signing Settings…', 'Show Console');
  if (pick === 'Signing Settings…') vscode.commands.executeCommand('gitTools.signingSettings', { model: m });
  else if (pick === 'Show Console') m.output.show(true);
}

/**
 * New Tag: whether to sign it, asked only when signing is set up (a key, or
 * commit / tag signing on). The default is tag.gpgsign. Resolves true /
 * false, null when signing is not set up (git's default), undefined when
 * cancelled.
 * @param {RepoModel} m
 * @param {string} name
 * @param {boolean} annotated a message was entered
 * @returns {Promise<boolean|null|undefined>}
 */
async function askSignTag(m, name, annotated) {
  const cfg = await m.repo.signingConfig().catch(() => null);
  if (!cfg || !(cfg.tagSign || cfg.commitSign || cfg.signingKey)) return null;
  const signed = { label: '$(lock) Sign Tag', description: `git tag -s · ${FORMAT_LABEL[cfg.format]}${annotated ? '' : ' · the tag name is its message'}`, sign: true };
  const plain = { label: `$(tag) Do Not Sign`, description: annotated ? 'annotated tag' : 'lightweight tag', sign: false };
  const pick = /** @type {any} */ (await vscode.window.showQuickPick(cfg.tagSign ? [signed, plain] : [plain, signed], {
    title: `New Tag ${name}`,
    placeHolder: `Sign the tag? (default from tag.gpgsign: ${cfg.tagSign ? 'sign' : 'do not sign'})`,
  }));
  return pick ? pick.sign : undefined;
}

/**
 * Key picker of the Signing Settings dialog. Resolves the user.signingkey
 * value, null for "not set", undefined when cancelled.
 * @param {RepoModel} m
 * @param {SigningKeys} keys
 * @param {SigningFormat} format
 * @param {string|null} current
 * @param {string|null} program gpg.program
 * @returns {Promise<string|null|undefined>}
 */
async function pickKey(m, keys, format, current, program) {
  const enter = async (prompt, placeHolder) => {
    const v = await vscode.window.showInputBox({ title: 'Signing Key', prompt, placeHolder, value: current || '', ignoreFocusOut: true });
    return v === undefined ? undefined : v.trim() || null;
  };
  if (format === 'x509') {
    return enter('X.509 key: certificate id or email gpgsm signs with (empty: the committer email)', 'e.g. 0x1234ABCD or me@example.com');
  }
  /** @type {any[]} */
  const items = [];
  if (format === 'openpgp') {
    let list = [];
    let error = null;
    try {
      list = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Listing GPG keys' },
        () => keys.gpgKeys(program));
    } catch (e) {
      error = String(e && e.message ? e.message : e).split('\n')[0];
    }
    items.push(sep(error ? `Cannot list keys: ${error}` : list.length ? 'Secret keys able to sign' : 'No secret keys able to sign'));
    for (const k of list) {
      const flags = [k.revoked && 'revoked', k.expired && 'expired', k.disabled && 'disabled', !k.secret && 'secret key not on this machine']
        .filter(Boolean);
      items.push({
        label: `${k.keyId === current || k.fingerprint === current ? '$(check)' : '$(key)'} ${k.uid || k.keyId}`,
        description: `${k.keyId}${k.expires ? ` · expires ${day(k.expires)}` : ' · no expiry'}`,
        detail: flags.length ? `$(warning) ${flags.join(', ')}: signing with it fails` : undefined,
        value: k.keyId,
        unusable: flags.length > 0,
      });
    }
    items.push(sep(''), { label: '$(edit) Enter Key ID…', id: 'enter' },
      { label: '$(circle-slash) Not Set', description: 'gpg uses the key of the committer email', value: null });
  } else {
    const [files, agent] = await Promise.all([keys.sshKeyFiles(), keys.sshAgentKeys()]);
    const inAgent = new Set(agent.map((k) => k.literal));
    items.push(sep(files.length ? 'Key files (~/.ssh)' : 'No key files in ~/.ssh'));
    for (const f of files) {
      // Through the agent the public key file is enough; without it ssh-keygen needs the private key.
      const value = inAgent.has(f.key.literal) || !f.privatePath ? f.path : f.privatePath;
      items.push({
        label: `${value === current || f.path === current ? '$(check)' : '$(file)'} ${path.basename(f.path)}`,
        description: `${f.key.type}${f.key.comment ? ` · ${f.key.comment}` : ''}${inAgent.has(f.key.literal) ? ' · in ssh-agent' : ''}`,
        detail: value,
        value,
      });
    }
    const agentOnly = agent.filter((k) => !files.some((f) => f.key.literal === k.literal));
    if (agentOnly.length) items.push(sep('ssh-agent'));
    for (const k of agentOnly) {
      const value = sshKeyLiteral(k);
      items.push({
        label: `${value === current ? '$(check)' : '$(server)'} ${k.comment || k.type}`,
        description: `${k.type} · stored as key::<public key>`,
        value,
      });
    }
    items.push(sep(''), { label: '$(folder-opened) Browse…', id: 'browse' }, { label: '$(edit) Enter Path or Public Key…', id: 'enter' },
      { label: '$(circle-slash) Not Set', description: 'git asks gpg.ssh.defaultKeyCommand', value: null });
  }
  const pick = /** @type {any} */ (await vscode.window.showQuickPick(items, {
    title: `Signing Key (${FORMAT_LABEL[format]})`, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true,
  }));
  if (!pick) return undefined;
  if (pick.id === 'enter') {
    return format === 'openpgp'
      ? enter('GPG key ID or fingerprint (empty: the key of the committer email)', 'e.g. 3AA5C34371567BD2')
      : enter('Path of the SSH key, or key::<public key>', '~/.ssh/id_ed25519');
  }
  if (pick.id === 'browse') {
    const dir = path.join(require('os').homedir(), '.ssh');
    const uri = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: 'Use Key', defaultUri: fs.existsSync(dir) ? vscode.Uri.file(dir) : undefined,
    });
    return uri ? uri[0].fsPath : undefined;
  }
  if (pick.unusable) {
    const ok = await vscode.window.showWarningMessage(`${pick.label.replace(/^\$\([^)]+\) /, '')} cannot sign (${pick.detail.replace(/^\$\(warning\) /, '').replace(/: .*$/, '')}). Use it anyway?`,
      { modal: true }, 'Use Key');
    if (!ok) return undefined;
  }
  return pick.value;
}

/**
 * Signing Settings dialog: format, key, "Sign commits by default"
 * (commit.gpgsign), "Sign tags by default" (tag.gpgsign) for this repository
 * or globally, and Test Signing. Only the settings that were changed are
 * written.
 * @param {RepoModel} m
 * @param {SigningKeys} keys
 */
async function signingSettings(m, keys) {
  const [effective, local, global] = await Promise.all(
    [m.repo.signingConfig(), m.repo.signingConfig('local'), m.repo.signingConfig('global')]);
  const byScope = { local, global };
  const scope = /** @type {any} */ (await vscode.window.showQuickPick([
    sep(`In effect: ${describeSigning(effective)}`),
    ...SCOPES.map((s) => ({ ...s, description: s.flag, detail: describeSigning(byScope[s.id]) })),
  ], { title: 'Signing Settings', placeHolder: 'Where the settings are saved' }));
  if (!scope) return;
  const initial = byScope[scope.id];
  const draft = { format: initial.format, key: initial.signingKey, commitSign: initial.commitSign, tagSign: initial.tagSign };
  const box = (on) => (on ? '$(pass-filled)' : '$(circle-large-outline)');
  for (;;) {
    const sshNote = draft.format === 'ssh' && !effective.allowedSignersFile
      ? [sep('Set gpg.ssh.allowedSignersFile to verify SSH signatures in the Log')] : [];
    const pick = /** @type {any} */ (await vscode.window.showQuickPick([
      { label: `$(symbol-namespace) Format: ${FORMAT_LABEL[draft.format]}`, description: 'gpg.format', id: 'format' },
      { label: `$(key) Signing Key: ${draft.key || 'not set'}`, description: 'user.signingkey', id: 'key' },
      { label: `${box(draft.commitSign)} Sign commits by default`, description: 'commit.gpgsign', id: 'commitSign' },
      { label: `${box(draft.tagSign)} Sign tags by default`, description: 'tag.gpgsign', id: 'tagSign' },
      ...sshNote,
      sep(''),
      { label: '$(beaker) Test Signing', description: 'signs a throwaway commit object, no ref is changed', id: 'test' },
      { label: `$(save) Save to ${scope.label}`, description: scope.flag, id: 'save' },
    ], { title: `Signing Settings · ${scope.label}`, placeHolder: 'Choose a setting to change, then Save', ignoreFocusOut: true }));
    if (!pick) return;
    if (pick.id === 'format') {
      const f = /** @type {any} */ (await vscode.window.showQuickPick(
        Object.entries(FORMAT_LABEL).map(([id, label]) => ({ label: `${id === draft.format ? '$(check) ' : ''}${label}`, id })),
        { title: 'Signature Format' }));
      if (f && f.id !== draft.format) {
        draft.format = f.id;
        // A key of one format means nothing to another.
        if (draft.key) draft.key = null;
      }
    } else if (pick.id === 'key') {
      const k = await pickKey(m, keys, draft.format, draft.key, effective.format === draft.format ? effective.program : null);
      if (k !== undefined) draft.key = k;
    } else if (pick.id === 'commitSign' || pick.id === 'tagSign') {
      draft[pick.id] = !draft[pick.id];
    } else if (pick.id === 'test') {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Test signing…' },
        () => m.repo.testSigning({ format: draft.format, key: draft.key }));
      if (r.ok) {
        vscode.window.showInformationMessage(`Signing works (${FORMAT_LABEL[draft.format]}${draft.key ? `, ${draft.key}` : ''}).`);
      } else {
        await vscode.window.showErrorMessage('Test signing failed.', { modal: true, detail: r.output });
      }
    } else if (pick.id === 'save') {
      const changes = [
        ['gpg.format', draft.format !== initial.format ? draft.format : undefined],
        ['user.signingkey', draft.key !== initial.signingKey ? draft.key : undefined],
        ['commit.gpgsign', draft.commitSign !== initial.commitSign ? String(draft.commitSign) : undefined],
        ['tag.gpgsign', draft.tagSign !== initial.tagSign ? String(draft.tagSign) : undefined],
      ].filter(([, v]) => v !== undefined);
      if (!changes.length) return vscode.window.setStatusBarMessage('Signing settings unchanged', 3000);
      await m.run('Save signing settings', async () => {
        for (const [key, value] of changes) await m.repo.setConfig(/** @type {string} */ (key), /** @type {string|null} */ (value), scope.id);
      }, { success: `Signing settings saved (${scope.label})`, refresh: false });
      await m.refreshRefs();
      return;
    }
  }
}

/**
 * Registers Signing Settings… (command palette, Commit view menu, the
 * action of a signing failure).
 * @param {vscode.ExtensionContext} context
 * @param {import('./model').RepoManager} manager
 */
function registerSigningCommands(context, manager) {
  context.subscriptions.push(vscode.commands.registerCommand('gitTools.signingSettings', (arg) => {
    const m = (arg && arg.model) || manager.current;
    if (!m) return vscode.window.showWarningMessage('No Git repository found in this workspace.');
    return signingSettings(m, manager.git.signingKeys());
  }));
}

module.exports = { registerSigningCommands, signingSettings, showSigningFailure, askSignTag, signChoice, describeSigning, FORMAT_LABEL };
