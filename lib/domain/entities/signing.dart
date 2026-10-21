/// Signature format of commits and tags (`gpg.format`).
enum SigningFormat {
  openpgp('openpgp', 'OpenPGP (GPG)'),
  ssh('ssh', 'SSH'),
  x509('x509', 'X.509 (gpgsm)');

  const SigningFormat(this.configValue, this.label);

  /// Value of `gpg.format`.
  final String configValue;
  final String label;

  /// Unknown or missing values mean OpenPGP (git's default).
  static SigningFormat parse(String? value) => switch (value?.trim().toLowerCase()) {
        'ssh' => ssh,
        'x509' => x509,
        _ => openpgp,
      };
}

/// Where the Signing Settings are written (`git config --local/--global`).
enum ConfigScope { local, global }

/// Signing related configuration of a repository (effective values).
class SigningConfig {
  const SigningConfig({
    this.format = SigningFormat.openpgp,
    this.signingKey,
    this.commitSign = false,
    this.tagSign = false,
    this.gpgProgram,
    this.sshProgram,
    this.allowedSignersFile,
  });

  /// `gpg.format`.
  final SigningFormat format;

  /// `user.signingkey`: a key id (OpenPGP / X.509), or a public key path or
  /// `key::<literal>` (SSH). Null lets git pick from the committer identity.
  final String? signingKey;

  /// `commit.gpgsign`: default of the "Sign commit" option.
  final bool commitSign;

  /// `tag.gpgsign`: default of the "Sign tag" option.
  final bool tagSign;

  /// `gpg.program` (also used for listing the OpenPGP keys).
  final String? gpgProgram;

  /// `gpg.ssh.program`.
  final String? sshProgram;

  /// `gpg.ssh.allowedSignersFile`: needed to verify SSH signatures.
  final String? allowedSignersFile;
}

/// What the Signing Settings dialog writes.
class SigningSettings {
  const SigningSettings({
    required this.format,
    required this.signingKey,
    required this.commitSign,
    required this.tagSign,
  });

  final SigningFormat format;

  /// Null or blank removes `user.signingkey` from the scope.
  final String? signingKey;
  final bool commitSign;
  final bool tagSign;
}

/// How a signature was verified: the `%G?` letter of `git log`.
enum SignatureStatus {
  /// G: good signature.
  good('G', 'Good signature'),

  /// U: good signature, unknown validity (untrusted key or no principal).
  untrusted('U', 'Good signature, untrusted key'),

  /// X: good signature that has expired.
  expired('X', 'Good signature, expired'),

  /// Y: good signature made by an expired key.
  expiredKey('Y', 'Good signature, expired key'),

  /// B: bad signature.
  bad('B', 'Bad signature'),

  /// R: good signature made by a revoked key.
  revoked('R', 'Signed with a revoked key'),

  /// E: the signature cannot be checked (e.g. missing key).
  cannotCheck('E', 'Cannot check the signature'),

  /// An SSH signature git could not check because `gpg.ssh.allowedSignersFile`
  /// is not set (git reports it as N). Not a letter of `%G?`.
  unverified('', 'Signed with SSH, not verified (gpg.ssh.allowedSignersFile is not set)'),

  /// N: no signature.
  none('N', 'Not signed');

  const SignatureStatus(this.code, this.label);

  final String code;
  final String label;

  /// Maps a `%G?` letter; anything unknown is treated as unsigned.
  static SignatureStatus fromCode(String code) =>
      values.where((s) => s.code.isNotEmpty && s.code == code.trim()).firstOrNull ?? none;

  /// Color class of the badge in the log.
  SignatureLevel get level => switch (this) {
        good => SignatureLevel.verified,
        untrusted || expired || expiredKey => SignatureLevel.warning,
        bad || revoked || cannotCheck => SignatureLevel.invalid,
        unverified => SignatureLevel.unknown,
        none => SignatureLevel.none,
      };
}

/// Badge of a signature: ✓ green, ✓ yellow, ✗ red, ? grey (not verifiable)
/// or nothing.
enum SignatureLevel { verified, warning, invalid, unknown, none }

/// Signature of a commit (`%G?`, `%GS`, `%GK`, `%GT`) or of a tag.
class SignatureInfo {
  const SignatureInfo({
    required this.status,
    this.signer,
    this.key,
    this.trust,
    this.message,
  });

  static const unsigned = SignatureInfo(status: SignatureStatus.none);

  final SignatureStatus status;

  /// Name (OpenPGP user id or SSH principal) of the signer, when known.
  final String? signer;

  /// Key id or SSH key fingerprint.
  final String? key;

  /// Trust level of the key (`%GT`, e.g. `ultimate`, `undefined`).
  final String? trust;

  /// Extra text, e.g. why a tag has no signature.
  final String? message;

  bool get isSigned => status != SignatureStatus.none;

  /// One line for the details panel.
  String get description {
    if (!isSigned) return message ?? status.label;
    final parts = [
      status.label,
      if (signer != null) 'by $signer',
      if (key != null) 'key $key',
      if (trust != null && trust!.isNotEmpty) 'trust: $trust',
    ];
    return parts.join(' · ');
  }
}

/// A secret OpenPGP key (`gpg --list-secret-keys --with-colons`).
class GpgKey {
  const GpgKey({
    required this.keyId,
    this.fingerprint,
    this.userIds = const [],
    this.created,
    this.expires,
    this.expired = false,
    this.revoked = false,
    this.disabled = false,
    this.canSign = true,
  });

  /// Long key id (16 hex characters) of the primary key.
  final String keyId;
  final String? fingerprint;
  final List<String> userIds;
  final DateTime? created;

  /// Null when the key never expires.
  final DateTime? expires;
  final bool expired;
  final bool revoked;
  final bool disabled;

  /// The key (or one of its subkeys) has the signing capability.
  final bool canSign;

  /// Usable for signing right now.
  bool get usable => canSign && !expired && !revoked && !disabled;

  String get primaryUid => userIds.isEmpty ? keyId : userIds.first;

  /// Whether `user.signingkey` [value] (key id, fingerprint, `0x…`, `…!`)
  /// names this key.
  bool matches(String value) {
    final v = value.trim().toUpperCase().replaceFirst(RegExp('^0X'), '').replaceAll('!', '');
    if (v.length < 8) return false;
    return keyId.toUpperCase().endsWith(v) || (fingerprint?.toUpperCase().endsWith(v) ?? false);
  }
}

/// A public SSH key from `~/.ssh/*.pub` or the agent (`ssh-add -L`).
class SshKey {
  const SshKey({required this.type, required this.data, this.comment = '', this.path, this.privatePath});

  /// e.g. `ssh-ed25519`.
  final String type;

  /// Base64 key blob.
  final String data;
  final String comment;

  /// The `.pub` file, null for a key that only lives in the agent.
  final String? path;

  bool get fromAgent => path == null;

  /// The public key line.
  String get publicKey => comment.isEmpty ? '$type $data' : '$type $data $comment';

  /// The private key next to [path], when it exists.
  final String? privatePath;

  /// Value of `user.signingkey`: the private key file (signing does not
  /// need the agent), else the `.pub` file (the agent holds the private
  /// key), or the literal key for agent keys.
  String get configValue => privatePath ?? path ?? 'key::$type $data';

  bool sameKey(SshKey other) => other.type == type && other.data == data;

  /// Whether `user.signingkey` [value] names this key: the literal key, the
  /// `.pub` file or the private key next to it.
  bool matches(String value) {
    final v = value.trim();
    if (v.startsWith('key::')) return v.contains(data);
    if (path == null || v.isEmpty) return false;
    String norm(String s) => s.replaceAll('\\', '/').toLowerCase();
    return norm(path!) == norm(v) || norm(path!) == norm('$v.pub');
  }
}

/// Result of "Test signing".
class SigningTestResult {
  const SigningTestResult({required this.ok, required this.output, this.verification});

  final bool ok;

  /// Git's stderr on failure, the created object id on success.
  final String output;

  /// How git verifies the test signature (success only).
  final SignatureInfo? verification;
}
