import '../entities/signing.dart';

/// Keys of the configuration read for signing, as `git config --get-regexp`
/// prints them (lower case).
const signingConfigPattern =
    r'^(commit\.gpgsign|tag\.gpgsign|gpg\.format|user\.signingkey|gpg\.program|gpg\.ssh\.program|gpg\.ssh\.allowedsignersfile)$';

/// Parses `git config -z --get-regexp` with [signingConfigPattern]: one
/// `key\nvalue` entry per NUL terminated field (just `key` for a value-less
/// boolean). A later entry wins, like git (local after global).
SigningConfig parseSigningConfig(String out) {
  final values = <String, String?>{};
  for (final field in out.split('\x00')) {
    if (field.isEmpty) continue;
    final nl = field.indexOf('\n');
    values[(nl < 0 ? field : field.substring(0, nl)).toLowerCase()] = nl < 0 ? null : field.substring(nl + 1);
  }
  String? str(String key) {
    final v = values[key]?.trim();
    return v == null || v.isEmpty ? null : v;
  }

  return SigningConfig(
    format: SigningFormat.parse(values['gpg.format']),
    signingKey: str('user.signingkey'),
    commitSign: values.containsKey('commit.gpgsign') && parseGitBool(values['commit.gpgsign']),
    tagSign: values.containsKey('tag.gpgsign') && parseGitBool(values['tag.gpgsign']),
    gpgProgram: str('gpg.program'),
    sshProgram: str('gpg.ssh.program'),
    allowedSignersFile: str('gpg.ssh.allowedsignersfile'),
  );
}

/// Git's boolean: a missing value (`[commit] gpgsign`) is true, as are
/// `true` / `yes` / `on` / non-zero numbers.
bool parseGitBool(String? value) {
  if (value == null) return true;
  final v = value.trim().toLowerCase();
  if (v == 'true' || v == 'yes' || v == 'on') return true;
  final n = int.tryParse(v);
  return n != null && n != 0;
}

// -----------------------------------------------------------------------------
// Commit signatures
// -----------------------------------------------------------------------------

const _fs = '\x1f';
const _rs = '\x1e';

/// `git log` format read by [parseCommitSignatures].
const commitSignatureFormat = '%H$_fs%G?$_fs%GS$_fs%GK$_fs%GT$_rs';

/// Parses `git log --no-walk --format=<commitSignatureFormat>`: hash →
/// signature.
Map<String, SignatureInfo> parseCommitSignatures(String out) {
  final result = <String, SignatureInfo>{};
  for (var rec in out.split(_rs)) {
    rec = rec.replaceFirst(RegExp(r'^\s+'), '');
    if (rec.isEmpty) continue;
    final f = rec.split(_fs);
    if (f.length < 2) continue;
    String? at(int i) => i < f.length && f[i].trim().isNotEmpty ? f[i].trim() : null;
    result[f[0].trim()] = SignatureInfo(
      status: SignatureStatus.fromCode(f[1]),
      signer: at(2),
      key: at(3),
      trust: at(4),
    );
  }
  return result;
}

// -----------------------------------------------------------------------------
// Tag signatures
// -----------------------------------------------------------------------------

/// Parses the output (stdout and stderr) of `git verify-tag --raw <tag>`:
/// GnuPG status lines for OpenPGP / X.509, ssh-keygen messages for SSH.
/// Mirrors how git computes `%G?` for commits.
SignatureInfo parseTagVerification(int exitCode, String output) {
  if (output.contains('cannot verify a non-tag object')) {
    return const SignatureInfo(status: SignatureStatus.none, message: 'Lightweight tag (not signed)');
  }
  if (output.contains('no signature found')) {
    return const SignatureInfo(status: SignatureStatus.none, message: 'Annotated tag, not signed');
  }
  final status = <String, String>{};
  for (final line in output.split('\n')) {
    final m = RegExp(r'^\[GNUPG:\] (\S+)\s*(.*)$').firstMatch(line.trim());
    if (m != null) status.putIfAbsent(m.group(1)!, () => m.group(2)!.trim());
  }
  if (status.isNotEmpty) return _gnupgSignature(status);

  // SSH: `Good "git" signature for <principal> with <type> key <fingerprint>`
  // (no "for <principal>" when the key is not in the allowed signers).
  final good = RegExp(r'Good "[^"]*" signature(?: for (.+?))? with (\S+) key (\S+)').firstMatch(output);
  if (good != null) {
    final principal = good.group(1);
    return SignatureInfo(
      status: principal == null ? SignatureStatus.untrusted : SignatureStatus.good,
      signer: principal,
      key: good.group(3),
    );
  }
  if (output.contains('allowedSignersFile needs to be configured')) {
    return SignatureInfo(
        status: SignatureStatus.cannotCheck, message: 'Set gpg.ssh.allowedSignersFile to verify SSH signatures');
  }
  final text = output.trim().split('\n').where((l) => l.trim().isNotEmpty).lastOrNull?.trim();
  return SignatureInfo(
    status: exitCode == 0 ? SignatureStatus.untrusted : SignatureStatus.bad,
    message: text,
  );
}

SignatureInfo _gnupgSignature(Map<String, String> status) {
  (String?, String?) keyAndUid(String v) {
    final sp = v.indexOf(' ');
    return sp < 0 ? (v, null) : (v.substring(0, sp), v.substring(sp + 1));
  }

  final trust = status.keys
      .where((k) => k.startsWith('TRUST_'))
      .map((k) => k.substring(6).toLowerCase())
      .firstOrNull;
  for (final (code, s) in [
    ('GOODSIG', SignatureStatus.good),
    ('EXPSIG', SignatureStatus.expired),
    ('EXPKEYSIG', SignatureStatus.expiredKey),
    ('REVKEYSIG', SignatureStatus.revoked),
    ('BADSIG', SignatureStatus.bad),
  ]) {
    final v = status[code];
    if (v == null) continue;
    final (key, uid) = keyAndUid(v);
    final untrusted = s == SignatureStatus.good && (trust == null || trust == 'undefined' || trust == 'never');
    return SignatureInfo(
      status: untrusted ? SignatureStatus.untrusted : s,
      signer: uid,
      key: key,
      trust: trust,
    );
  }
  final err = status['ERRSIG'];
  return SignatureInfo(
    status: SignatureStatus.cannotCheck,
    key: err == null ? null : keyAndUid(err).$1,
    message: status.containsKey('NO_PUBKEY') ? 'The public key is not available' : null,
  );
}

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

/// Parses `gpg --list-secret-keys --with-colons` (also `--list-keys`).
/// Revoked user ids are left out; [now] decides whether a key with an
/// expiration date has expired.
List<GpgKey> parseGpgSecretKeys(String out, {DateTime? now}) {
  final at = now ?? DateTime.now();
  final keys = <GpgKey>[];
  List<String>? key;
  String? fpr;
  final uids = <String>[];
  var inPrimary = false;

  void flush() {
    final k = key;
    key = null;
    if (k == null) return;
    final validity = _field(k, 2);
    final expires = _date(_field(k, 7));
    final caps = _field(k, 12);
    keys.add(GpgKey(
      keyId: _field(k, 5),
      fingerprint: fpr,
      userIds: List.of(uids),
      created: _date(_field(k, 6)),
      expires: expires,
      expired: validity == 'e' || (expires != null && !expires.isAfter(at)),
      revoked: validity == 'r',
      disabled: caps.contains('D'),
      // Upper case letters are the capabilities of the whole key.
      canSign: caps.isEmpty || caps.contains('S'),
    ));
    fpr = null;
    uids.clear();
  }

  for (final line in out.split('\n')) {
    final f = line.trimRight().split(':');
    switch (f.first) {
      case 'sec' || 'pub':
        flush();
        key = f;
        inPrimary = true;
      case 'ssb' || 'sub':
        inPrimary = false;
      case 'fpr' when inPrimary && key != null && fpr == null:
        fpr = _field(f, 10);
      case 'uid' when key != null:
        if (_field(f, 2) != 'r') uids.add(_unescape(_field(f, 10)));
    }
  }
  flush();
  return keys;
}

/// 1-based field of a colon listing, empty when missing.
String _field(List<String> f, int n) => n <= f.length ? f[n - 1] : '';

/// Seconds since the epoch, or ISO 8601 (`20261021T101010`).
DateTime? _date(String v) {
  if (v.isEmpty) return null;
  final secs = int.tryParse(v);
  if (secs != null) return secs == 0 ? null : DateTime.fromMillisecondsSinceEpoch(secs * 1000, isUtc: true);
  final m = RegExp(r'^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$').firstMatch(v);
  if (m == null) return null;
  final n = [for (var i = 1; i <= 6; i++) int.parse(m.group(i)!)];
  return DateTime.utc(n[0], n[1], n[2], n[3], n[4], n[5]);
}

/// gpg escapes `:` and control characters in user ids as `\xNN`.
String _unescape(String s) =>
    s.replaceAllMapped(RegExp(r'\\x([0-9a-fA-F]{2})'), (m) => String.fromCharCode(int.parse(m.group(1)!, radix: 16)));

/// Parses public SSH keys, one per line (`ssh-add -L` or a `.pub` file).
/// Lines that are not keys (e.g. "The agent has no identities.") are
/// ignored. [path] is set on every key (for a `.pub` file).
List<SshKey> parseSshPublicKeys(String text, {String? path}) {
  final keys = <SshKey>[];
  for (final raw in text.split('\n')) {
    final line = raw.trim();
    final m = RegExp(r'^((?:sk-)?(?:ssh|ecdsa)-[\w.@-]+)\s+([A-Za-z0-9+/]+=*)(?:\s+(.*))?$').firstMatch(line);
    if (m == null) continue;
    keys.add(SshKey(type: m.group(1)!, data: m.group(2)!, comment: m.group(3)?.trim() ?? '', path: path));
  }
  return keys;
}

// -----------------------------------------------------------------------------
// Failures
// -----------------------------------------------------------------------------

const _signingErrors = [
  'gpg failed to sign',
  'failed to write commit object',
  'unable to sign',
  'signing failed',
  'error: gpg',
  'error: ssh',
  'ssh-keygen',
  "couldn't get agent socket",
  'no secret key',
  'gpg.ssh.',
  'user.signingkey',
];

/// Whether a git error comes from signing (no agent, wrong key, pinentry
/// cancelled, ...), so the Signing Settings can be offered.
bool isSigningFailure(String text) {
  final t = text.toLowerCase();
  return _signingErrors.any(t.contains);
}

/// Commits of `git log --pretty=raw` whose header holds an SSH signature
/// (`gpgsig -----BEGIN SSH SIGNATURE-----`).
Set<String> parseSshSignedCommits(String rawLog) {
  final result = <String>{};
  String? current;
  for (final line in rawLog.split('\n')) {
    if (line.startsWith('commit ')) {
      current = line.substring(7).trim().split(' ').first;
    } else if (current != null && line.startsWith('gpgsig -----BEGIN SSH SIGNATURE-----')) {
      result.add(current);
    }
  }
  return result;
}

/// Git commands that may sign (commits, merges, tags, rewrites).
const _signingCommands = {'commit', 'commit-tree', 'merge', 'pull', 'tag', 'rebase', 'cherry-pick', 'revert', 'am'};

/// Whether the git command [args] (without `git`) can sign, so a failure
/// may come from signing. `-c key=value` options before it are skipped.
bool isSigningCommand(List<String> args) {
  for (var i = 0; i < args.length; i++) {
    final a = args[i];
    if (a == '-c' || a == '-C') {
      i++;
    } else if (!a.startsWith('-')) {
      return _signingCommands.contains(a);
    }
  }
  return false;
}
