// Commit signing (GPG / SSH): parsing, git arguments and temporary repositories with throwaway keys.
// Run: node --test test/signing.test.js
// The user's keyring, SSH keys, agent and global git config are never touched: GNUPGHOME, the global
// config (GIT_CONFIG_GLOBAL) and the SSH home are temporary folders.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Repository } = require('../src/data/gitRepository');
const { SigningKeys } = require('../src/data/signingKeys');
const { CommitChanges } = require('../src/domain/usecases/commitChanges');
const { InteractiveRebase } = require('../src/domain/usecases/interactiveRebase');
const { defaultMergeOptions, mergeArgs } = require('../src/domain/logic/merge');
const { buildTodo, parseTodo } = require('../src/domain/logic/rebaseTodo');
const {
  signArgs, parseSigningConfig, signingProgram, parseGpgSecretKeys, parseSshPublicKeys, sshKeyLiteral, signatureStatus, makeSignature,
  isSigningFailure, tagVerification, hasTagSignature,
} = require('../src/domain/logic/signing');

// ---------------------------------------------------------------- isolation

const tmpRoot = fs.realpathSync.native(os.tmpdir());
const globalDir = fs.mkdtempSync(path.join(tmpRoot, 'gt_sign_global_'));
const globalConfig = path.join(globalDir, 'gitconfig');
fs.writeFileSync(globalConfig, '');
const savedEnv = { ...process.env };
// git (and the Repository instances, which inherit process.env) read this
// global config only; system config is ignored.
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const has = (cmd, args = ['--version']) => {
  const r = spawnSync(cmd, args, { stdio: 'pipe', timeout: 20000 });
  return !r.error && r.status === 0;
};

/**
 * A temporary GNUPGHOME with one ed25519 signing key (no passphrase). Git for
 * Windows' gpg wants a POSIX path (its agent socket name cannot hold ':'):
 * both spellings are tried. Null when gpg is missing or fails.
 */
function makeGnupgHome() {
  if (!has('gpg')) return null;
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'gt_gnupg_'));
  const forms = process.platform === 'win32'
    ? [dir.replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`).split(path.sep).join('/'), dir]
    : [dir];
  for (const home of forms) {
    const env = { ...process.env, GNUPGHOME: home };
    const r = spawnSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key',
      'Test Signer <t@example.com>', 'default', 'default', 'never'], { env, stdio: 'pipe', timeout: 60000 });
    if (r.status !== 0) {
      spawnSync('gpgconf', ['--kill', 'gpg-agent'], { env, stdio: 'pipe', timeout: 20000 });
      continue;
    }
    const list = spawnSync('gpg', ['--batch', '--list-secret-keys', '--with-colons', '--fixed-list-mode'], { env, stdio: 'pipe' });
    const [key] = parseGpgSecretKeys(String(list.stdout));
    if (key) return { dir, home, env, key, colons: String(list.stdout) };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return null;
}

const gpg = makeGnupgHome();
const noGpg = gpg ? false : 'gpg is not available';
if (gpg) process.env.GNUPGHOME = gpg.home;

test.after(() => {
  if (gpg) {
    spawnSync('gpgconf', ['--kill', 'gpg-agent'], { env: gpg.env, stdio: 'pipe', timeout: 20000 });
    try { fs.rmSync(gpg.dir, { recursive: true, force: true }); } catch { /* agent files may linger */ }
  }
  fs.rmSync(globalDir, { recursive: true, force: true });
  for (const k of ['GNUPGHOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'gt_sign_'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  if (gpg) git('config', 'user.signingkey', gpg.key.keyId);
  const write = (p, c) => fs.writeFileSync(path.join(dir, p), c);
  const commit = (msg, file = `${msg.replace(/\W+/g, '_')}.txt`) => {
    write(file, `${msg}\n`);
    git('add', '-A');
    git('commit', '-q', '--no-gpg-sign', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const sig = (rev = 'HEAD') => git('log', '-1', '--format=%G?', rev);
  const repo = new Repository(dir);
  return { dir, git, write, commit, sig, repo, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- pure logic

test('signArgs: -S, --no-gpg-sign, or nothing (config decides)', () => {
  assert.deepEqual(signArgs(true), ['-S']);
  assert.deepEqual(signArgs(false), ['--no-gpg-sign']);
  assert.deepEqual(signArgs(null), []);
  assert.deepEqual(signArgs(undefined), []);
});

test('parseSigningConfig: last value wins, booleans, format programs', () => {
  const c = parseSigningConfig([
    'commit.gpgsign false', 'commit.gpgsign true', 'tag.gpgsign', 'gpg.format SSH', 'user.signingkey ~/.ssh/id_ed25519.pub',
    'gpg.program /usr/bin/gpg', 'gpg.ssh.program C:/ssh/ssh-keygen.exe', 'gpg.ssh.allowedsignersfile ~/.ssh/allowed', 'core.editor vim',
  ].join('\n'));
  assert.deepEqual(c, {
    commitSign: true, tagSign: true, format: 'ssh', signingKey: '~/.ssh/id_ed25519.pub', program: 'C:/ssh/ssh-keygen.exe',
    sshProgram: 'C:/ssh/ssh-keygen.exe', allowedSignersFile: '~/.ssh/allowed',
  });
  const d = parseSigningConfig('gpg.program gpg2\ntag.gpgsign no\n');
  assert.equal(d.format, 'openpgp');
  assert.equal(d.program, 'gpg2');
  assert.equal(d.tagSign, false);
  assert.equal(d.signingKey, null);
  assert.equal(signingProgram(parseSigningConfig('')), 'gpg');
  assert.equal(signingProgram(parseSigningConfig('gpg.format x509')), 'gpgsm');
  assert.equal(signingProgram(parseSigningConfig('gpg.format ssh')), 'ssh-keygen');
  assert.equal(parseSigningConfig('gpg.format x509\ngpg.x509.program smime').program, 'smime');
});

test('parseGpgSecretKeys: signing keys with uid, expiry and flags', () => {
  const now = Date.UTC(2026, 0, 1);
  const text = [
    'sec:u:255:22:D29D9C4CF0D1F847:1792569728:::u:::scESC:::+::ed25519:::0:',
    'fpr:::::::::8AF4AEC7ECA63DB9F7D8EE07D29D9C4CF0D1F847:',
    'grp:::::::::02156F98B86FE70925C399D375891C128873D3D7:',
    'uid:r::::1792569728::AA::Old Name <old@example.com>::::::::::0:',
    'uid:u::::1792569728::69CD::Test Signer \\x3a Work <t@example.com>::::::::::0:',
    'ssb:u:255:18:A18C09E0E253BD42:1792569728::::::e:::+::cv25519::',
    'fpr:::::::::6E87D17423732B3150618447A18C09E0E253BD42:',
    // Expired by date, signing through a subkey only.
    'sec:-:3072:1:1111222233334444:1600000000:1700000000::-:::cC:::+:::::0:',
    'fpr:::::::::00001111222233334444555566667777AAAABBBB:',
    'uid:-::::1600000000::BB::Expired <e@example.com>::::::::::0:',
    'ssb:-:3072:1:5555666677778888:1600000000:1700000000:::::s:::+:::::',
    // Revoked.
    'sec:r:255:22:9999AAAABBBBCCCC:1600000000:::-:::scSC:::+:::::0:',
    'uid:r::::::CC::Revoked <r@example.com>::::::::::0:',
    // Encryption only: not offered.
    'sec:u:255:22:EEEEFFFF00001111:1600000000:::u:::eE:::+:::::0:',
    'uid:u::::::DD::Encrypt <x@example.com>::::::::::0:',
    // Secret key on a card that is not here (stub).
    'sec:u:255:22:ABCDABCDABCDABCD:1600000000:::u:::scSC:::#:::::0:',
    'uid:u::::::EE::Card <c@example.com>::::::::::0:',
  ].join('\n');
  const keys = parseGpgSecretKeys(text, now);
  assert.deepEqual(keys.map((k) => k.keyId), ['D29D9C4CF0D1F847', '1111222233334444', '9999AAAABBBBCCCC', 'ABCDABCDABCDABCD']);
  assert.deepEqual(keys[0], {
    keyId: 'D29D9C4CF0D1F847', fingerprint: '8AF4AEC7ECA63DB9F7D8EE07D29D9C4CF0D1F847', uid: 'Test Signer : Work <t@example.com>',
    uids: ['Test Signer : Work <t@example.com>'], created: 1792569728000, expires: null, expired: false, revoked: false, disabled: false,
    secret: true,
  });
  assert.equal(keys[1].expired, true);
  assert.equal(keys[1].expires, 1700000000000);
  assert.equal(keys[1].fingerprint, '00001111222233334444555566667777AAAABBBB');
  assert.equal(keys[2].revoked, true);
  assert.equal(keys[2].uid, '');
  assert.equal(keys[3].secret, false);
});

test('parseSshPublicKeys: key files and ssh-add -L', () => {
  const keys = parseSshPublicKeys([
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv me@laptop',
    'ecdsa-sha2-nistp256 AAAAE2VjZHNh= ',
    'sk-ssh-ed25519@openssh.com AAAAGnNr work key',
    'ssh-rsa AAAAB3NzaC1yc2E=',
    'The agent has no identities.',
    '',
  ].join('\r\n'));
  assert.deepEqual(keys.map((k) => [k.type, k.comment]), [
    ['ssh-ed25519', 'me@laptop'], ['ecdsa-sha2-nistp256', ''], ['sk-ssh-ed25519@openssh.com', 'work key'], ['ssh-rsa', '']]);
  assert.equal(keys[0].literal, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv');
  assert.equal(sshKeyLiteral(keys[0]), 'key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv');
  assert.deepEqual(parseSshPublicKeys('The agent has no identities.\n'), []);
});

test('%G? mapping: green, yellow, red, none', () => {
  const level = (c) => signatureStatus(c).level;
  assert.equal(level('G'), 'good');
  for (const c of ['U', 'X', 'Y']) assert.equal(level(c), 'warning');
  for (const c of ['B', 'R', 'E']) assert.equal(level(c), 'bad');
  assert.equal(level('N'), 'none');
  assert.equal(level('?'), 'none');
  assert.equal(signatureStatus('B').text, 'Bad signature');
  assert.deepEqual(makeSignature('G', 'Me <m@x>', 'ABCD', 'ultimate'),
    { code: 'G', signer: 'Me <m@x>', key: 'ABCD', trust: 'ultimate', level: 'good', text: 'Good signature' });
  assert.equal(makeSignature('Z').code, 'N');
});

test('isSigningFailure recognizes gpg, ssh-keygen and agent errors only', () => {
  for (const t of [
    'error: gpg failed to sign the data:\ngpg: signing failed: No secret key\nfatal: failed to write commit object',
    'gpg: signing failed: Operation cancelled',
    'error: Load key "/home/x/.ssh/id": invalid format?\nfatal: failed to write commit object',
    'fatal: either user.signingkey or gpg.ssh.defaultKeyCommand needs to be configured',
    'error: cannot run gpg: No such file or directory',
    'gpg: can\'t connect to the gpg-agent: IPC connect call failed',
    'error: unable to sign the tag',
  ]) assert.equal(isSigningFailure(t), true, t);
  for (const t of ['CONFLICT (content): Merge conflict in a.txt', 'error: pathspec \'x\' did not match any file(s) known to git', '']) {
    assert.equal(isSigningFailure(t), false, t);
  }
});

test('tagVerification and hasTagSignature', () => {
  const gpgOut = 'gpg: Signature made Tue Oct 21\ngpg:                using EDDSA key 8AF4AEC7ECA63DB9F7D8EE07D29D9C4CF0D1F847\ngpg: Good signature from "Test Signer <t@example.com>" [ultimate]';
  const good = tagVerification(0, gpgOut);
  assert.equal(good.code, 'G');
  assert.equal(good.signer, 'Test Signer <t@example.com>');
  assert.equal(good.key, '8AF4AEC7ECA63DB9F7D8EE07D29D9C4CF0D1F847');
  assert.equal(tagVerification(0, `${gpgOut}\ngpg: WARNING: This key is not certified with a trusted signature!`).level, 'warning');
  assert.equal(tagVerification(1, 'gpg: BAD signature from "X"').code, 'B');
  assert.equal(tagVerification(1, 'gpg: Can\'t check signature: No public key').code, 'E');
  const ssh = tagVerification(0, 'Good "git" signature for t@example.com with ED25519 key SHA256:abc');
  assert.equal(ssh.signer, 't@example.com');
  assert.equal(ssh.key, 'SHA256:abc');
  assert.equal(hasTagSignature('object x\ntype commit\ntag v1\n\nmsg\n-----BEGIN SSH SIGNATURE-----\nU1NI\n'), true);
  assert.equal(hasTagSignature('object x\ntype commit\ntag v1\n\nmsg\n'), false);
});

test('buildTodo signs (or not) the amend lines; mergeArgs passes the choice', () => {
  const items = parseTodo(`pick ${'a'.repeat(40)} A\n`).map((it) => ({ ...it, action: /** @type {any} */ ('reword'), message: 'A', newMessage: 'B' }));
  const line = (sign) => buildTodo(items, { stateDir: '/s', sign }).todo.split('\n')[1];
  assert.equal(line(true), 'exec git commit --amend --allow-empty -S -F \'/s/msg-1.txt\'');
  assert.equal(line(false), 'exec git commit --amend --allow-empty --no-gpg-sign -F \'/s/msg-1.txt\'');
  assert.equal(line(null), 'exec git commit --amend --allow-empty -F \'/s/msg-1.txt\'');
  const o = (x) => ({ ...defaultMergeOptions(), ...x });
  assert.deepEqual(mergeArgs('feat', o({ fastForward: 'never', sign: true })), ['merge', '--no-ff', '-S', '--no-edit', 'feat']);
  assert.deepEqual(mergeArgs('feat', o({ sign: false })), ['merge', '--no-gpg-sign', '--no-edit', 'feat']);
  assert.deepEqual(mergeArgs('feat', o({ sign: null })), ['merge', '--no-edit', 'feat']);
});

test('CommitChanges hands the sign choice to the repository', async () => {
  const calls = {};
  const repo = { commit: async (x) => { calls.commit = x; } };
  const uc = new CommitChanges(/** @type {any} */ (repo));
  const status = { branch: 'main', head: 'h', upstream: null, ahead: 0, behind: 0, changes: [], state: /** @type {const} */ ('normal') };
  const changes = [{ path: 'a.txt', type: /** @type {const} */ ('modified') }];
  await uc.run(await uc.prepare({ status, message: 'm', changes, lineSelections: new Map(), sign: true }));
  assert.equal(calls.commit.sign, true);
  await uc.run(await uc.prepare({ status, message: 'm', changes, lineSelections: new Map() }));
  assert.equal(calls.commit.sign, null);
});

// ---------------------------------------------------------------- config (no keys needed)

test('signingConfig / setConfig: repository and (temporary) global config', async () => {
  const t = setup();
  try {
    await t.repo.setConfig('commit.gpgsign', 'true', 'local');
    await t.repo.setConfig('gpg.format', 'ssh', 'global');
    await t.repo.setConfig('tag.gpgsign', 'true', 'global');
    assert.equal(t.git('config', '--local', 'commit.gpgsign'), 'true');
    assert.match(fs.readFileSync(globalConfig, 'utf8'), /format = ssh/);
    const local = await t.repo.signingConfig('local');
    const global = await t.repo.signingConfig('global');
    const effective = await t.repo.signingConfig();
    assert.equal(local.commitSign, true);
    assert.equal(local.format, 'openpgp');
    assert.equal(global.format, 'ssh');
    assert.equal(effective.format, 'ssh');
    assert.equal(effective.commitSign, true);
    assert.equal(effective.tagSign, true);
    await t.repo.setConfig('gpg.format', null, 'global');
    await t.repo.setConfig('tag.gpgsign', null, 'global');
    await t.repo.setConfig('tag.gpgsign', null, 'global'); // not set: no error
    assert.equal((await t.repo.signingConfig()).format, 'openpgp');
  } finally {
    fs.writeFileSync(globalConfig, '');
    t.cleanup();
  }
});

// ---------------------------------------------------------------- GPG

test('GPG: signed commit verifies G; signatures() of the asked commits only', { skip: noGpg }, async () => {
  const t = setup();
  try {
    const unsigned = t.commit('one');
    t.write('a.txt', 'a\n');
    await t.repo.commit({ message: 'signed', paths: ['a.txt'], sign: true });
    const signed = t.git('rev-parse', 'HEAD');
    assert.equal(t.sig(), 'G');
    const map = await t.repo.signatures([signed, unsigned, signed, 'not-a-hash']);
    assert.deepEqual([...map.keys()].sort(), [signed, unsigned].sort());
    const s = map.get(signed);
    assert.equal(s.code, 'G');
    assert.equal(s.level, 'good');
    assert.match(s.signer, /Test Signer <t@example.com>/);
    assert.ok(gpg.key.fingerprint.endsWith(s.key) || s.key === gpg.key.keyId, s.key);
    assert.equal(map.get(unsigned).code, 'N');
    assert.equal((await t.repo.signatures([])).size, 0);
  } finally {
    t.cleanup();
  }
});

test('GPG: --no-gpg-sign overrides commit.gpgsign; null follows it; commitSelected too', { skip: noGpg }, async () => {
  const t = setup();
  try {
    t.commit('base');
    t.git('config', 'commit.gpgsign', 'true');
    t.write('a.txt', '1\n');
    await t.repo.commit({ message: 'not signed', paths: ['a.txt'], sign: false });
    assert.equal(t.sig(), 'N');
    t.write('a.txt', '2\n');
    await t.repo.commit({ message: 'config', paths: ['a.txt'], sign: null });
    assert.equal(t.sig(), 'G');
    t.write('a.txt', '3\n');
    await t.repo.commitSelected({ message: 'partial', fullPaths: [], partial: [{ path: 'a.txt', content: '3\n' }], sign: false });
    assert.equal(t.sig(), 'N');
    t.git('config', 'commit.gpgsign', 'false');
    t.write('a.txt', '4\n');
    await t.repo.commitSelected({ message: 'partial signed', fullPaths: ['a.txt'], partial: [], sign: true });
    assert.equal(t.sig(), 'G');
  } finally {
    t.cleanup();
  }
});

test('GPG: amend and reword (interactive rebase exec path) stay signed', { skip: noGpg }, async () => {
  const t = setup();
  try {
    t.commit('one');
    const two = t.commit('two');
    t.commit('three');
    // Amend HEAD (Edit Commit Message of HEAD).
    await t.repo.commit({ message: 'three, edited', paths: [], amend: true, sign: true });
    assert.equal(t.sig(), 'G');
    // Reword an older commit: the reworded one and the rewritten ones after it are signed.
    const uc = new InteractiveRebase(t.repo);
    const p = await uc.prepareReword(two);
    p.items[p.index] = { ...p.items[p.index], newMessage: 'two, reworded' };
    const r = await uc.run(p.plan, p.items, { sign: true });
    assert.equal(r.stopped, false);
    assert.deepEqual(t.git('log', '--format=%s|%G?', '-3').split('\n'), ['three, edited|G', 'two, reworded|G', 'one|N']);
    // And --no-gpg-sign wins over commit.gpgsign.
    t.git('config', 'commit.gpgsign', 'true');
    const q = await uc.prepareReword(t.git('rev-parse', 'HEAD~1'));
    q.items[q.index] = { ...q.items[q.index], newMessage: 'two again' };
    await uc.run(q.plan, q.items, { sign: false });
    assert.deepEqual(t.git('log', '--format=%s|%G?', '-2').split('\n'), ['three, edited|N', 'two again|N']);
  } finally {
    t.cleanup();
  }
});

test('GPG: merge commit of the Merge dialog options is signed', { skip: noGpg }, async () => {
  const t = setup();
  try {
    t.commit('base');
    t.git('checkout', '-q', '-b', 'feat');
    t.commit('feature');
    t.git('checkout', '-q', 'main');
    t.commit('main work');
    await t.repo.merge('feat', { ...defaultMergeOptions(), fastForward: 'never', sign: true });
    assert.equal(t.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    assert.equal(t.sig(), 'G');
  } finally {
    t.cleanup();
  }
});

test('GPG: signed annotated tag verifies; unsigned and lightweight tags', { skip: noGpg }, async () => {
  const t = setup();
  try {
    const head = t.commit('one');
    await t.repo.createTag('v1', head, 'Release 1', true);
    await t.repo.createTag('v2', head, '', true); // signing implies annotated: the name is the message
    await t.repo.createTag('v3', head, 'annotated', false);
    t.git('config', 'tag.gpgsign', 'true');
    await t.repo.createTag('v4', head, '', false); // lightweight despite tag.gpgsign
    const v1 = await t.repo.verifyTag('v1');
    assert.equal(v1.signed, true);
    assert.equal(v1.signature.level, 'good');
    assert.match(v1.signature.signer, /Test Signer/);
    assert.equal((await t.repo.verifyTag('v2')).signature.code, 'G');
    assert.equal(t.git('tag', '-l', '--format=%(contents:subject)', 'v2'), 'v2');
    assert.deepEqual(await t.repo.verifyTag('v3'), { name: 'v3', signed: false, signature: null, output: '' });
    assert.equal(await t.repo.verifyTag('v4'), null);
    assert.equal(await t.repo.verifyTag('missing'), null);
  } finally {
    t.cleanup();
  }
});

test('GPG: testSigning reports success, or git\'s error for a wrong key', { skip: noGpg }, async () => {
  const t = setup();
  try {
    const ok = await t.repo.testSigning();
    assert.equal(ok.ok, true, ok.output);
    assert.match(ok.output, /^[0-9a-f]{40}$/);
    // Nothing points to the throwaway commit (a repository without commits works too).
    assert.equal(t.git('for-each-ref'), '');
    t.commit('one');
    const bad = await t.repo.testSigning({ format: 'openpgp', key: 'DEADBEEFDEADBEEF' });
    assert.equal(bad.ok, false);
    assert.equal(isSigningFailure(bad.output), true, bad.output);
    assert.equal(t.git('config', '--get', 'user.signingkey'), gpg.key.keyId); // overrides are not saved
  } finally {
    t.cleanup();
  }
});

test('GPG: SigningKeys lists the temporary keyring', { skip: noGpg }, async () => {
  const keys = await new SigningKeys({ env: gpg.env }).gpgKeys();
  assert.deepEqual(keys.map((k) => k.keyId), [gpg.key.keyId]);
  assert.equal(keys[0].uid, 'Test Signer <t@example.com>');
  await assert.rejects(new SigningKeys({ env: gpg.env }).gpgKeys('no-such-gpg-program'), /not found/);
});

// ---------------------------------------------------------------- SSH

// ssh-keygen prints its usage (exit code 1) when it runs at all.
const noSsh = spawnSync('ssh-keygen', ['-?'], { stdio: 'pipe', timeout: 20000 }).error ? 'ssh-keygen is not available' : false;

test('SSH: signed commit and tag verify with an allowed signers file', { skip: noSsh }, async () => {
  const t = setup();
  const home = fs.mkdtempSync(path.join(tmpRoot, 'gt_sshhome_'));
  try {
    fs.mkdirSync(path.join(home, '.ssh'));
    const keyFile = path.join(home, '.ssh', 'id_test').split(path.sep).join('/');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test key', '-f', keyFile], { stdio: 'pipe' });
    const pub = fs.readFileSync(`${keyFile}.pub`, 'utf8').trim();
    const allowed = path.join(home, 'allowed_signers').split(path.sep).join('/');
    fs.writeFileSync(allowed, `t@example.com ${pub}\n`);
    t.git('config', 'gpg.format', 'ssh');
    t.git('config', 'user.signingkey', keyFile);
    t.git('config', 'gpg.ssh.allowedSignersFile', allowed);
    t.commit('one');
    t.write('a.txt', 'a\n');
    await t.repo.commit({ message: 'ssh signed', paths: ['a.txt'], sign: true });
    assert.equal(t.sig(), 'G');
    const s = (await t.repo.signatures([t.git('rev-parse', 'HEAD')])).values().next().value;
    assert.equal(s.code, 'G');
    assert.equal(s.signer, 't@example.com');
    assert.match(s.key, /^SHA256:/);
    assert.equal((await t.repo.testSigning()).ok, true);
    await t.repo.createTag('s1', 'HEAD', 'ssh tag', true);
    const tag = await t.repo.verifyTag('s1');
    assert.equal(tag.signature.level, 'good', tag.output);
    assert.equal(tag.signature.signer, 't@example.com');
    // The key files of the (temporary) home, with the private key next to them.
    const files = await new SigningKeys({ home }).sshKeyFiles();
    assert.equal(files.length, 1);
    assert.equal(files[0].key.literal, pub.split(' ').slice(0, 2).join(' '));
    assert.equal(files[0].key.comment, 'test key');
    assert.equal(path.normalize(/** @type {string} */ (files[0].privatePath)), path.normalize(keyFile));
    assert.deepEqual(await new SigningKeys({ home: path.join(home, 'none') }).sshKeyFiles(), []);
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
