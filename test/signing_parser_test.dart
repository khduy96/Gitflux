import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/merge.dart';
import 'package:git_tools/domain/entities/rebase.dart';
import 'package:git_tools/domain/entities/signing.dart';
import 'package:git_tools/domain/logic/rebase_todo.dart';
import 'package:git_tools/domain/logic/signing_parser.dart';

/// `gpg --list-secret-keys --with-colons --fixed-list-mode`: a valid key, an
/// expired one, a revoked one and one without signing capability.
const _colons = '''
sec:u:255:22:5DAB2F4E63828210:1792571038:::u:::scSC:::+::ed25519:::0:
fpr:::::::::4725979E8C8161F2A8A0C1CD5DAB2F4E63828210:
grp:::::::::1C89EF6BD9A75B1C778DE2AA0F19AAD600706F0D:
uid:u::::1792571038::17EB5207C7587F1801843FBA610FD9169033F87D::T <t@t>::::::::::0:
uid:r::::1792571038::27EB5207C7587F1801843FBA610FD9169033F87D::Old <old@t>::::::::::0:
ssb:u:255:18:AAAA2F4E63828211:1792571038::::::e:::+::cv25519::
fpr:::::::::BBBB979E8C8161F2A8A0C1CD5DAB2F4E63828211:
sec:e:3072:1:1111222233334444:1500000000:1600000000::u:::scSC:::+:::23::0:
fpr:::::::::00000000000000000000000000001111222233334444:
uid:e::::1500000000::0000::Expired \\x3a Key <e@t>::::::::::0:
sec:r:4096:1:5555666677778888:1500000000:::u:::sc:::+:::23::0:
fpr:::::::::00000000000000000000000000005555666677778888:
uid:r::::1500000000::0000::Revoked <r@t>::::::::::0:
sec:u:255:22:9999AAAABBBBCCCC:1700000000:4102444800::u:::cC:::+::ed25519:::0:
fpr:::::::::0000000000000000000000009999AAAABBBBCCCC:
uid:u::::1700000000::0000::Certify Only <c@t>::::::::::0:
''';

RebaseCommitEntry _entry(String id, RebaseAction action, [String? newMessage]) => RebaseCommitEntry(
      commit: Commit(
        hash: id.padRight(40, '0'),
        parents: const [],
        authorName: 'T',
        authorEmail: 't@t',
        authorTime: DateTime(2024),
        committerName: 'T',
        commitTime: DateTime(2024),
        subject: 'subject $id',
        refs: const [],
      ),
      message: 'subject $id',
      action: action,
      newMessage: newMessage,
    );

void main() {
  group('gpg --with-colons', () {
    final keys = parseGpgSecretKeys(_colons, now: DateTime.utc(2026, 10, 21));

    test('one key per sec record with its fingerprint and user ids', () {
      expect(keys.map((k) => k.keyId), ['5DAB2F4E63828210', '1111222233334444', '5555666677778888', '9999AAAABBBBCCCC']);
      final k = keys.first;
      // The fingerprint of the subkey is not the key's.
      expect(k.fingerprint, '4725979E8C8161F2A8A0C1CD5DAB2F4E63828210');
      // Revoked user ids are left out.
      expect(k.userIds, ['T <t@t>']);
      expect(k.expires, isNull);
      expect(k.created, DateTime.fromMillisecondsSinceEpoch(1792571038 * 1000, isUtc: true));
      expect((k.expired, k.revoked, k.canSign, k.usable), (false, false, true, true));
    });

    test('expired, revoked and certify-only keys are not usable', () {
      final expired = keys[1];
      expect(expired.expired, isTrue);
      expect(expired.expires, DateTime.fromMillisecondsSinceEpoch(1600000000 * 1000, isUtc: true));
      expect(expired.userIds, ['Expired : Key <e@t>'], reason: r'\x3a is unescaped');
      expect(expired.usable, isFalse);

      final revoked = keys[2];
      expect((revoked.revoked, revoked.usable), (true, false));
      // Upper case capabilities only: "sc" means no signing for the whole key.
      expect(revoked.canSign, isFalse);

      final certify = keys[3];
      expect((certify.expired, certify.canSign, certify.usable), (false, false, false));
    });

    test('an expiration date in the past marks the key expired', () {
      const out = 'sec:u:255:22:ABCDEF0123456789:1500000000:1600000000::u:::scSC:::\n';
      expect(parseGpgSecretKeys(out, now: DateTime.utc(2026)).single.expired, isTrue);
      expect(parseGpgSecretKeys(out, now: DateTime.utc(2019)).single.expired, isFalse);
      expect(parseGpgSecretKeys('sec:u:255:22:ABCDEF0123456789:20200101T000000:20300101T000000::u:::S:::\n',
              now: DateTime.utc(2026))
          .single
          .expires, DateTime.utc(2030));
    });

    test('a key matches its id, fingerprint suffix and 0x / ! forms', () {
      final k = keys.first;
      for (final v in ['5DAB2F4E63828210', '0x5dab2f4e63828210', '5DAB2F4E63828210!', '63828210',
          '4725979E8C8161F2A8A0C1CD5DAB2F4E63828210']) {
        expect(k.matches(v), isTrue, reason: v);
      }
      expect(k.matches(''), isFalse);
      expect(k.matches('1111222233334444'), isFalse);
    });
  });

  group('%G? mapping', () {
    test('letters, labels and badge levels', () {
      const expected = {
        'G': (SignatureStatus.good, SignatureLevel.verified),
        'U': (SignatureStatus.untrusted, SignatureLevel.warning),
        'X': (SignatureStatus.expired, SignatureLevel.warning),
        'Y': (SignatureStatus.expiredKey, SignatureLevel.warning),
        'B': (SignatureStatus.bad, SignatureLevel.invalid),
        'R': (SignatureStatus.revoked, SignatureLevel.invalid),
        'E': (SignatureStatus.cannotCheck, SignatureLevel.invalid),
        'N': (SignatureStatus.none, SignatureLevel.none),
      };
      for (final e in expected.entries) {
        final s = SignatureStatus.fromCode(e.key);
        expect((s, s.level), e.value, reason: e.key);
        expect(s.code, e.key);
      }
      expect(SignatureStatus.fromCode(''), SignatureStatus.none);
      expect(SignatureStatus.fromCode('?'), SignatureStatus.none);
    });

    test('git log records', () {
      final out = [
        'aaa\x1fG\x1fT <t@t>\x1f5DAB2F4E63828210\x1fultimate\x1e',
        '\nbbb\x1fN\x1f\x1f\x1f\x1e',
        '\nccc\x1fU\x1f\x1fSHA256:qsjX\x1fundefined\x1e\n',
      ].join();
      final m = parseCommitSignatures(out);
      expect(m.keys, ['aaa', 'bbb', 'ccc']);
      expect(m['aaa']!.status, SignatureStatus.good);
      expect(m['aaa']!.signer, 'T <t@t>');
      expect(m['aaa']!.key, '5DAB2F4E63828210');
      expect(m['aaa']!.trust, 'ultimate');
      expect(m['aaa']!.description, 'Good signature · by T <t@t> · key 5DAB2F4E63828210 · trust: ultimate');
      expect(m['bbb']!.isSigned, isFalse);
      expect(m['bbb']!.signer, isNull);
      expect(m['ccc']!.status, SignatureStatus.untrusted);
      expect(m['ccc']!.key, 'SHA256:qsjX');
    });

    test('SSH signed commits in git log --pretty=raw (not verifiable without allowed signers)', () {
      const raw = 'commit aaa\ntree t\nauthor T <t@t> 1 +0000\ncommitter T <t@t> 1 +0000\n'
          'gpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n\n    signed\n\n'
          'commit bbb\ntree t\nauthor T <t@t> 1 +0000\n\n    gpgsig -----BEGIN SSH SIGNATURE----- in a message\n\n'
          'commit ccc\ntree t\ngpgsig -----BEGIN PGP SIGNATURE-----\n -----END PGP SIGNATURE-----\n\n    pgp\n';
      expect(parseSshSignedCommits(raw), {'aaa'});
      expect(SignatureStatus.unverified.level, SignatureLevel.unknown);
      expect(const SignatureInfo(status: SignatureStatus.unverified).isSigned, isTrue);
    });
  });

  group('git verify-tag --raw', () {
    test('GnuPG status lines', () {
      const good = '[GNUPG:] NEWSIG t@t\n[GNUPG:] GOODSIG 5DAB2F4E63828210 T <t@t>\n'
          '[GNUPG:] VALIDSIG 4725 2026-10-21\n[GNUPG:] TRUST_ULTIMATE 0 pgp t@t\n';
      final s = parseTagVerification(0, good);
      expect((s.status, s.signer, s.key, s.trust), (SignatureStatus.good, 'T <t@t>', '5DAB2F4E63828210', 'ultimate'));

      expect(parseTagVerification(0, '[GNUPG:] GOODSIG K T\n[GNUPG:] TRUST_UNDEFINED 0 pgp\n').status,
          SignatureStatus.untrusted);
      expect(parseTagVerification(1, '[GNUPG:] BADSIG K T\n').status, SignatureStatus.bad);
      expect(parseTagVerification(0, '[GNUPG:] EXPKEYSIG K T\n').status, SignatureStatus.expiredKey);
      expect(parseTagVerification(0, '[GNUPG:] EXPSIG K T\n').status, SignatureStatus.expired);
      expect(parseTagVerification(1, '[GNUPG:] REVKEYSIG K T\n').status, SignatureStatus.revoked);
      final missing = parseTagVerification(1, '[GNUPG:] ERRSIG 5DAB2F4E63828210 22 10 00 1792571039 9 -\n'
          '[GNUPG:] NO_PUBKEY 5DAB2F4E63828210\n');
      expect((missing.status, missing.key), (SignatureStatus.cannotCheck, '5DAB2F4E63828210'));
      expect(missing.message, 'The public key is not available');
    });

    test('ssh-keygen messages', () {
      final s = parseTagVerification(0, 'Good "git" signature for t@t with ED25519 key SHA256:qsjX\n');
      expect((s.status, s.signer, s.key), (SignatureStatus.good, 't@t', 'SHA256:qsjX'));
      final noPrincipal = parseTagVerification(0, 'Good "git" signature with ED25519 key SHA256:qsjX\n');
      expect((noPrincipal.status, noPrincipal.signer), (SignatureStatus.untrusted, null));
      expect(
          parseTagVerification(1, 'error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh '
                  'signature verification\n')
              .status,
          SignatureStatus.cannotCheck);
      expect(parseTagVerification(1, 'Signature verification failed: incorrect signature\n').status,
          SignatureStatus.bad);
    });

    test('unsigned tags', () {
      final light = parseTagVerification(1, 'error: v3: cannot verify a non-tag object of type commit.\n');
      expect((light.isSigned, light.description), (false, 'Lightweight tag (not signed)'));
      final annotated = parseTagVerification(1, 'object 1234\ntype commit\n\nerror: no signature found\n');
      expect((annotated.isSigned, annotated.description), (false, 'Annotated tag, not signed'));
    });
  });

  group('ssh keys', () {
    test('public key lines; other lines are ignored', () {
      const text = '''
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILFea/CHOn5lRoDEow5Yh2aVwFc+dOpJOFaHPMbC1Kw7 t@t
The agent has no identities.
ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=
sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t yubikey with spaces
ssh-rsa AAAAB3NzaC1yc2E=
not a key
''';
      final keys = parseSshPublicKeys(text);
      expect(keys.map((k) => k.type), ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'sk-ssh-ed25519@openssh.com', 'ssh-rsa']);
      expect(keys.first.comment, 't@t');
      expect(keys[2].comment, 'yubikey with spaces');
      expect(keys[1].comment, '');
      expect(keys.every((k) => k.fromAgent), isTrue);
      expect(keys.first.configValue,
          'key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILFea/CHOn5lRoDEow5Yh2aVwFc+dOpJOFaHPMbC1Kw7');
      expect(parseSshPublicKeys('The agent has no identities.\n'), isEmpty);
    });

    test('file keys are stored by path and match the path or the private key', () {
      final k = parseSshPublicKeys('ssh-ed25519 AAAAkey me\n', path: r'C:\Users\me\.ssh\id_ed25519.pub').single;
      expect(k.fromAgent, isFalse);
      expect(k.configValue, r'C:\Users\me\.ssh\id_ed25519.pub');
      expect(k.matches('C:/Users/me/.ssh/id_ed25519.pub'), isTrue);
      expect(k.matches(r'C:\Users\me\.ssh\id_ed25519'), isTrue);
      expect(k.matches('key::ssh-ed25519 AAAAkey'), isTrue);
      expect(k.matches('key::ssh-ed25519 AAAAother'), isFalse);
      expect(k.matches(''), isFalse);
    });
  });

  group('configuration', () {
    test('git config -z --get-regexp; later values win', () {
      const out = 'commit.gpgsign\nfalse\x00gpg.format\nssh\x00user.signingkey\n~/.ssh/id.pub\x00'
          'commit.gpgsign\x00gpg.ssh.allowedsignersfile\n/a/allowed\x00tag.gpgsign\nno\x00';
      final c = parseSigningConfig(out);
      expect(c.format, SigningFormat.ssh);
      expect(c.signingKey, '~/.ssh/id.pub');
      expect(c.commitSign, isTrue, reason: 'a value-less boolean is true');
      expect(c.tagSign, isFalse);
      expect(c.allowedSignersFile, '/a/allowed');
      expect(c.gpgProgram, isNull);

      final empty = parseSigningConfig('');
      expect((empty.format, empty.commitSign, empty.tagSign, empty.signingKey),
          (SigningFormat.openpgp, false, false, null));
      expect(SigningFormat.parse('X509'), SigningFormat.x509);
      expect(SigningFormat.parse('weird'), SigningFormat.openpgp);
    });

    test('git booleans', () {
      for (final v in [null, 'true', 'Yes', 'on', '1', '2']) {
        expect(parseGitBool(v), isTrue, reason: '$v');
      }
      for (final v in ['false', 'no', 'off', '0', '']) {
        expect(parseGitBool(v), isFalse, reason: v);
      }
    });
  });

  test('signing failures are recognized', () {
    expect(isSigningFailure('error: gpg failed to sign the data:\nfatal: failed to write commit object'), isTrue);
    expect(isSigningFailure("error: Couldn't get agent socket?\n\nfatal: failed to write commit object"), isTrue);
    expect(isSigningFailure('error: gpg failed to sign the data\nerror: unable to sign the tag'), isTrue);
    expect(isSigningFailure('CONFLICT (content): Merge conflict in a.txt'), isFalse);
    expect(isSigningFailure("error: pathspec 'x' did not match any file(s) known to git"), isFalse);
  });

  test('only commands that can sign offer the Signing Settings', () {
    expect(isSigningCommand(['commit', '-F', 'm', '-S']), isTrue);
    expect(isSigningCommand(['-c', 'user.signingkey=x', 'commit-tree', '-S', 'HEAD^{tree}']), isTrue);
    expect(isSigningCommand(['tag', '-s', 'v1']), isTrue);
    expect(isSigningCommand(['merge', '--no-ff', 'b']), isTrue);
    expect(isSigningCommand(['push', 'origin', 'main']), isFalse);
    expect(isSigningCommand(['-c', 'core.quotepath=false', 'fetch']), isFalse);
    expect(isSigningCommand(const []), isFalse);
  });

  test('rebase todo amends carry the signing choice', () {
    String amend(bool? sign) => buildTodo([_entry('a', RebaseAction.reword, 'New')], stateDir: '/s', sign: sign)
        .todo
        .split('\n')[1];
    expect(amend(true), "exec git commit --amend --allow-empty -S -F '/s/msg-1.txt'");
    expect(amend(false), "exec git commit --amend --allow-empty --no-gpg-sign -F '/s/msg-1.txt'");
    expect(amend(null), "exec git commit --amend --allow-empty -F '/s/msg-1.txt'");
  });

  test('merge options carry the signing choice', () {
    expect(const MergeOptions(noFf: true, sign: true).args, ['--no-ff', '--gpg-sign']);
    expect(const MergeOptions(sign: false).args, ['--no-gpg-sign']);
    expect(const MergeOptions().args, isEmpty);
    final o = const MergeOptions().withSign(true).withFlag(MergeFlag.squash, true).withMessage('m');
    expect(o.sign, isTrue);
    expect(o.withSign(null).sign, isNull);
  });
}
