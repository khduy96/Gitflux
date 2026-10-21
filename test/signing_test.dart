import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/data/repositories/git_cli_service.dart';
import 'package:git_tools/domain/entities/ai_config.dart';
import 'package:git_tools/domain/entities/console_entry.dart';
import 'package:git_tools/domain/entities/merge.dart';
import 'package:git_tools/domain/entities/signing.dart';
import 'package:git_tools/domain/logic/rebase_todo.dart';
import 'package:git_tools/domain/logic/signing_parser.dart';
import 'package:git_tools/domain/repositories/commit_message_generator.dart';
import 'package:git_tools/domain/repositories/git_repository.dart';
import 'package:git_tools/domain/usecases/interactive_rebase.dart';
import 'package:git_tools/domain/usecases/merge_branch.dart';
import 'package:git_tools/presentation/state/repo_controller.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/dialogs/signing_settings_dialog.dart';
import 'package:git_tools/presentation/ui/log/log_panel.dart';
import 'package:path/path.dart' as p;

/// Path for the gpg bundled with Git for Windows (MSYS): its agent socket
/// cannot be a `C:\…` path, so `/c/…` is used.
String _gpgPath(String path) => Platform.isWindows
    ? path.replaceAll('\\', '/').replaceFirstMapped(RegExp(r'^([A-Za-z]):'), (m) => '/${m[1]!.toLowerCase()}')
    : path;

/// Commit signing on real temporary repositories with a throwaway GPG key
/// (temporary GNUPGHOME) and SSH key. The user's keyring, ~/.ssh, ssh-agent
/// and global git configuration are never used: HOME, GNUPGHOME,
/// GIT_CONFIG_GLOBAL and SSH_AUTH_SOCK point into the temporary folder.
void main() {
  late Directory tmp;
  late Map<String, String> env;
  String? gpgSkip;
  String? sshSkip;
  late String sshKey;

  /// Runs [program] through git's shell, which finds the gpg / ssh tools
  /// bundled with Git for Windows.
  ProcessResult tool(String program, List<String> args, {String? cwd}) => Process.runSync(
        'git',
        ['-c', 'alias.t=!f() { "$program" "\$@"; }; f', 't', ...args],
        workingDirectory: cwd ?? tmp.path,
        environment: env,
      );

  // Keys are made while the tests are declared, so unavailable tools can
  // skip them.
  {
    tmp = Directory.systemTemp.createTempSync('gt_sign_');
    final home = Directory(p.join(tmp.path, 'home'))..createSync();
    final gnupg = Directory(p.join(tmp.path, 'gnupg'))..createSync();
    File(p.join(tmp.path, 'gitconfig')).writeAsStringSync('');
    env = {
      'HOME': home.path,
      'GNUPGHOME': _gpgPath(gnupg.path),
      'GIT_CONFIG_GLOBAL': p.join(tmp.path, 'gitconfig'),
      'GIT_CONFIG_NOSYSTEM': '1',
      'SSH_AUTH_SOCK': p.join(tmp.path, 'no-agent'),
    };
    final gen = tool('gpg', [
      '--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
      '--quick-gen-key', 'T <t@t>', 'ed25519', 'sign', 'never',
    ]);
    if (gen.exitCode != 0) gpgSkip = 'gpg not available: ${gen.stderr}';

    sshKey = p.join(tmp.path, 'sshkey');
    final ssh = tool('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 't@t', '-f', sshKey]);
    if (ssh.exitCode != 0) sshSkip = 'ssh-keygen not available: ${ssh.stderr}';
  }

  tearDownAll(() {
    if (gpgSkip == null) tool('gpgconf', ['--kill', 'gpg-agent']);
    try {
      tmp.deleteSync(recursive: true);
    } on FileSystemException catch (_) {
      // The agent may still hold its sockets for a moment.
    }
  });

  late String dir;
  late GitCliRepository repo;
  var n = 0;

  String git(List<String> args) {
    final r = Process.runSync('git', args, workingDirectory: dir, environment: env);
    if (r.exitCode != 0) fail('git ${args.join(' ')}: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  String status(String rev) => git(['log', '-1', '--format=%G?', rev]);

  Future<String> commitFile(String name, {bool? sign, bool amend = false}) async {
    File(p.join(dir, name)).writeAsStringSync('$name ${n++}\n');
    await repo.commit(message: name, paths: [name], sign: sign, amend: amend);
    return git(['rev-parse', 'HEAD']);
  }

  setUp(() {
    dir = p.join(tmp.path, 'repo${n++}');
    Directory(dir).createSync();
    git(['init', '-q', '-b', 'main']);
    for (final kv in {'user.name': 'T', 'user.email': 't@t', 'core.autocrlf': 'false'}.entries) {
      git(['config', kv.key, kv.value]);
    }
    repo = GitCliRepository(dir, environment: env);
  });

  group('OpenPGP', () {
    test('a signed commit verifies G, --no-gpg-sign overrides commit.gpgsign', () async {
      final signed = await commitFile('a.txt', sign: true);
      expect(status(signed), 'G');
      final sig = (await repo.commitSignatures([signed]))[signed]!;
      expect((sig.status, sig.signer, sig.trust), (SignatureStatus.good, 'T <t@t>', 'ultimate'));

      git(['config', 'commit.gpgsign', 'true']);
      expect((await repo.signingConfig()).commitSign, isTrue);
      final unsigned = await commitFile('b.txt', sign: false);
      expect(status(unsigned), 'N');
      // Null leaves it to the configuration.
      expect(status(await commitFile('c.txt')), 'G');

      final all = await repo.commitSignatures([unsigned, signed]);
      expect(all[unsigned]!.isSigned, isFalse);
      expect(all[signed]!.status, SignatureStatus.good);
    }, skip: gpgSkip);

    test('partial commits, amend and Edit Commit Message stay signed', () async {
      await commitFile('a.txt', sign: true);
      File(p.join(dir, 'a.txt')).writeAsStringSync('one\ntwo\n');
      await repo.commitSelected(message: 'partial', fullPaths: const [], partial: {'a.txt': 'one\n'}, sign: true);
      expect(status('HEAD'), 'G');
      await commitFile('a.txt', sign: true, amend: true);
      expect(status('HEAD'), 'G');
      await repo.rewordHead('reworded', sign: true);
      expect((git(['log', '-1', '--format=%s']), status('HEAD')), ('reworded', 'G'));
      await repo.rewordHead('unsigned', sign: false);
      expect(status('HEAD'), 'N');
    }, skip: gpgSkip);

    test('reword via interactive rebase keeps the rewritten commits signed', () async {
      await commitFile('a.txt', sign: true);
      final b = await commitFile('b.txt', sign: true);
      await commitFile('c.txt', sign: true);
      final rebase = InteractiveRebase(repo);
      var plan = await rebase.prepare(b);
      await rebase.start(plan, rewordCommit(plan.entries, b, 'b reworded'), sign: true);
      expect(git(['log', '--format=%s', '-3']).split('\n'), ['c.txt', 'b reworded', 'a.txt']);
      expect(git(['log', '--format=%G?', '-3']).split('\n'), ['G', 'G', 'G']);
      expect(git(['rev-parse', 'HEAD~1']), isNot(b));

      // Unsigned on request: both the amended and the picked commit.
      final b2 = git(['rev-parse', 'HEAD~1']);
      plan = await rebase.prepare(b2);
      await rebase.start(plan, rewordCommit(plan.entries, b2, 'b again'), sign: false);
      expect(git(['log', '--format=%G?', '-3']).split('\n'), ['N', 'N', 'G']);
    }, skip: gpgSkip);

    test('merge commits of the Merge dialog are signed', () async {
      await commitFile('a.txt', sign: false);
      git(['checkout', '-q', '-b', 'feature']);
      await commitFile('f.txt', sign: false);
      git(['checkout', '-q', 'main']);
      await MergeBranch(repo)('feature', const MergeOptions(noFf: true, sign: true));
      expect((git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, status('HEAD')), (3, 'G'));
    }, skip: gpgSkip);

    test('signed, annotated and lightweight tags', () async {
      final c = await commitFile('a.txt', sign: false);
      git(['config', 'tag.gpgsign', 'true']);
      await repo.createTag('v1', c, sign: true);
      await repo.createTag('v2', c, message: 'annotated', sign: false);
      await repo.createTag('v3', c, sign: false);
      final v1 = await repo.tagSignature('v1');
      expect((v1.status, v1.signer), (SignatureStatus.good, 'T <t@t>'));
      expect(git(['cat-file', '-p', 'v1']), contains('\nv1\n'), reason: 'the tag name is the message');
      expect((await repo.tagSignature('v2')).description, 'Annotated tag, not signed');
      expect((await repo.tagSignature('v3')).description, 'Lightweight tag (not signed)');
    }, skip: gpgSkip);

    test('keys, settings and Test Signing', () async {
      final keys = await repo.gpgSecretKeys();
      expect(keys.single.userIds, ['T <t@t>']);
      expect(keys.single.usable, isTrue);

      await repo.saveSigningSettings(
          SigningSettings(format: SigningFormat.openpgp, signingKey: keys.single.keyId, commitSign: true, tagSign: true),
          ConfigScope.local);
      final c = await repo.signingConfig();
      expect((c.format, c.signingKey, c.commitSign, c.tagSign),
          (SigningFormat.openpgp, keys.single.keyId, true, true));
      expect(git(['config', '--local', 'commit.gpgsign']), 'true');
      expect(File(env['GIT_CONFIG_GLOBAL']!).readAsStringSync(), isEmpty);

      // Without commits: the empty tree is signed. No ref is created.
      final ok = await repo.testSigning();
      expect(ok.ok, isTrue, reason: ok.output);
      expect(ok.verification?.status, SignatureStatus.good);
      expect(git(['for-each-ref']), isEmpty);

      final bad = await repo.testSigning(key: 'DEADBEEFDEADBEEF');
      expect(bad.ok, isFalse);
      expect(isSigningFailure(bad.output), isTrue, reason: bad.output);

      // A signing failure is reported, never committed unsigned.
      git(['config', 'user.signingkey', 'DEADBEEFDEADBEEF']);
      File(p.join(dir, 'x.txt')).writeAsStringSync('x\n');
      await expectLater(repo.commit(message: 'x', paths: ['x.txt'], sign: true), throwsA(isA<Exception>()));
      expect(git(['rev-list', '--all']), isEmpty);

      await repo.saveSigningSettings(
          const SigningSettings(format: SigningFormat.openpgp, signingKey: '', commitSign: false, tagSign: false),
          ConfigScope.local);
      expect((await repo.signingConfig()).signingKey, isNull);
    }, skip: gpgSkip);
  });

  group('SSH', () {
    test('signing with a throwaway key and an allowed signers file verifies G', () async {
      final pub = File('$sshKey.pub').readAsStringSync().trim();
      final allowed = File(p.join(tmp.path, 'allowed_signers'))..writeAsStringSync('t@t $pub\n');
      await repo.saveSigningSettings(
          SigningSettings(format: SigningFormat.ssh, signingKey: '$sshKey.pub', commitSign: true, tagSign: true),
          ConfigScope.local);
      git(['config', 'gpg.ssh.allowedSignersFile', allowed.path]);
      final c = await repo.signingConfig();
      expect((c.format, c.allowedSignersFile), (SigningFormat.ssh, allowed.path));

      final h = await commitFile('a.txt', sign: true);
      final sig = (await repo.commitSignatures([h]))[h]!;
      expect((sig.status, sig.signer), (SignatureStatus.good, 't@t'));
      expect(sig.key, startsWith('SHA256:'));

      await repo.createTag('v1', h, sign: true);
      expect((await repo.tagSignature('v1')).status, SignatureStatus.good);

      final test = await repo.testSigning(format: SigningFormat.ssh, key: '$sshKey.pub');
      expect(test.ok, isTrue, reason: test.output);
      expect(test.verification?.status, SignatureStatus.good);
    }, skip: sshSkip);

    test('keys of ~/.ssh are listed by path', () async {
      final ssh = Directory(p.join(env['HOME']!, '.ssh'))..createSync(recursive: true);
      File('$sshKey.pub').copySync(p.join(ssh.path, 'id_test.pub'));
      final keys = await repo.sshKeys();
      final k = keys.where((k) => !k.fromAgent).single;
      expect((k.type, k.comment, k.path), ('ssh-ed25519', 't@t', p.join(ssh.path, 'id_test.pub')));
      expect(k.configValue, k.path);
      // With the private key next to it, the private key is stored (signing
      // then works without the agent).
      File(sshKey).copySync(p.join(ssh.path, 'id_test'));
      final withPrivate = (await repo.sshKeys()).where((k) => !k.fromAgent).single;
      expect(withPrivate.configValue, p.join(ssh.path, 'id_test'));
      expect(withPrivate.matches(withPrivate.configValue), isTrue);
    }, skip: sshSkip);

    test('without gpg.ssh.allowedSignersFile an SSH signed commit is "not verified", not unsigned or bad',
        () async {
      git(['config', 'gpg.format', 'ssh']);
      git(['config', 'user.signingkey', sshKey]);
      final signed = await commitFile('a.txt', sign: true);
      final unsigned = await commitFile('b.txt', sign: false);
      expect(status(signed), 'N');
      final all = await repo.commitSignatures([signed, unsigned]);
      expect(all[signed]!.status, SignatureStatus.unverified);
      expect(all[signed]!.status.level, SignatureLevel.unknown);
      expect(all[unsigned]!.isSigned, isFalse);
    }, skip: sshSkip);
  });

  group('UI', () {
    /// Lets the git processes started by the widgets run (they need real
    /// time, their callbacks fake time) until [found] shows up.
    Future<void> settleUntil(WidgetTester tester, bool Function() done) async {
      for (var i = 0; i < 150 && !done(); i++) {
        await tester.pump(const Duration(milliseconds: 10));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }
      await tester.pump();
    }

    Future<void> settle(WidgetTester tester, Finder found) => settleUntil(tester, () => found.evaluate().isNotEmpty);

    Future<RepoController> open(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1400, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final ctrl = RepoController(dir, git: _EnvService(env), commitMessageAi: _noAi);
      await tester.runAsync(ctrl.refreshAll);
      addTearDown(ctrl.dispose);
      return ctrl;
    }

    Widget host(Widget child) => MaterialApp(theme: buildTheme(), home: Scaffold(body: child));

    testWidgets('Signing Settings: pick the key, test and save locally', (tester) async {
      final ctrl = await open(tester);
      await tester.pumpWidget(host(Builder(
        builder: (context) => TextButton(
          onPressed: () => showSigningSettingsDialog(context, ctrl),
          child: const Text('open'),
        ),
      )));
      await tester.tap(find.text('open'));
      await settle(tester, find.text('T <t@t>'));
      expect(find.text('OpenPGP (GPG)'), findsOneWidget);

      await tester.tap(find.text('T <t@t>'));
      await tester.pump();
      final keyId = (await tester.runAsync(() => GitCliRepository(dir, environment: env).gpgSecretKeys()))!.single.keyId;
      expect(find.widgetWithText(TextField, keyId), findsOneWidget);

      await tester.tap(find.text('Sign commits by default'));
      await tester.tap(find.text('Test Signing'));
      await settle(tester, find.textContaining('Signing works'));
      expect(find.textContaining('Verification: Good signature'), findsOneWidget);

      await tester.tap(find.text('Save'));
      await settleUntil(tester, () => find.text('Signing Settings').evaluate().isEmpty && ctrl.signCommit.value);
      expect(find.text('Signing Settings'), findsNothing);
      expect(git(['config', '--local', 'user.signingkey']), keyId);
      expect(git(['config', '--local', 'commit.gpgsign']), 'true');
      expect(ctrl.signCommit.value, isTrue);
    }, skip: gpgSkip != null);

    testWidgets('the log shows a badge for signed commits, the details the signer', (tester) async {
      File(p.join(dir, 'a.txt')).writeAsStringSync('a\n');
      git(['add', '-A']);
      git(['commit', '-q', '-S', '-m', 'signed one']);
      File(p.join(dir, 'b.txt')).writeAsStringSync('b\n');
      git(['add', '-A']);
      git(['commit', '-q', '--no-gpg-sign', '-m', 'plain one']);
      git(['tag', '-s', 'v1', '-m', 'v1', 'HEAD~1']);

      final ctrl = await open(tester);
      await tester.pumpWidget(host(LogPanel(controller: ctrl)));
      await settle(tester, find.byIcon(Icons.verified_user_outlined));
      expect(find.byIcon(Icons.verified_user_outlined), findsOneWidget, reason: 'only the signed commit');

      await tester.tap(find.text('signed one'));
      await settle(tester, find.textContaining('by T <t@t>'));
      await settle(tester, find.textContaining('Tag v1: Good signature'));
      expect(find.textContaining('Signature: Good signature · by T <t@t>'), findsOneWidget);
      expect(find.textContaining('Tag v1: Good signature'), findsOneWidget);

      await tester.tap(find.text('plain one'));
      await settle(tester, find.text('Signature: Not signed'));
      expect(find.text('Signature: Not signed'), findsOneWidget);
    }, skip: gpgSkip != null);
  });
}

/// [GitCliService] whose repositories run git with [env].
class _EnvService extends GitCliService {
  const _EnvService(this.env);

  final Map<String, String> env;

  @override
  GitRepository open(String root, {void Function(ConsoleEntry)? onConsole}) =>
      GitCliRepository(root, onConsole: onConsole, environment: env);
}

CommitMessageGenerator _noAi(AiProvider provider, {required String apiKey, required String model}) =>
    throw UnimplementedError();
