import 'package:flutter/material.dart';

import '../../../domain/entities/signing.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import '../log/signature_badge.dart';
import 'basic_dialogs.dart';

/// Git ▸ Signing Settings…: format, key and defaults of commit / tag
/// signing, written to the repository or the global configuration.
Future<void> showSigningSettingsDialog(BuildContext context, RepoController ctrl) =>
    showDialog<void>(context: context, builder: (_) => _SigningSettingsDialog(ctrl: ctrl));

class _SigningSettingsDialog extends StatefulWidget {
  const _SigningSettingsDialog({required this.ctrl});

  final RepoController ctrl;

  @override
  State<_SigningSettingsDialog> createState() => _SigningSettingsDialogState();
}

class _SigningSettingsDialogState extends State<_SigningSettingsDialog> {
  RepoController get ctrl => widget.ctrl;

  SigningConfig? _config;
  SigningFormat _format = SigningFormat.openpgp;
  final _key = TextEditingController();
  bool _commitSign = false;
  bool _tagSign = false;
  ConfigScope _scope = ConfigScope.local;

  List<GpgKey>? _gpgKeys;
  List<SshKey>? _sshKeys;
  String? _keysError;
  bool _keysLoading = false;

  bool _testing = false;
  SigningTestResult? _test;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _key.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    SigningConfig c;
    try {
      c = await ctrl.repo.signingConfig();
    } catch (e) {
      c = ctrl.signing.config.value;
    }
    if (!mounted) return;
    setState(() {
      _config = c;
      _format = c.format;
      _key.text = c.signingKey ?? '';
      _commitSign = c.commitSign;
      _tagSign = c.tagSign;
    });
    await _loadKeys();
  }

  /// Lists the keys of the chosen format (X.509 has no list).
  Future<void> _loadKeys() async {
    final format = _format;
    if (format == SigningFormat.x509) return;
    setState(() {
      _keysLoading = true;
      _keysError = null;
    });
    try {
      if (format == SigningFormat.openpgp) {
        final keys = await ctrl.repo.gpgSecretKeys();
        if (mounted) setState(() => _gpgKeys = keys);
      } else {
        final keys = await ctrl.repo.sshKeys();
        if (mounted) setState(() => _sshKeys = keys);
      }
    } catch (e) {
      if (mounted && _format == format) setState(() => _keysError = '$e');
    } finally {
      if (mounted) setState(() => _keysLoading = false);
    }
  }

  void _setFormat(SigningFormat f) {
    if (f == _format) return;
    setState(() {
      _format = f;
      _test = null;
      _error = null;
      _keysError = null;
      // A key of another format means nothing here.
      if (f != _config?.format) {
        _key.clear();
      } else {
        _key.text = _config?.signingKey ?? '';
      }
    });
    if ((f == SigningFormat.openpgp && _gpgKeys == null) || (f == SigningFormat.ssh && _sshKeys == null)) {
      _loadKeys();
    }
  }

  String? _validate() {
    if (_format == SigningFormat.ssh && _key.text.trim().isEmpty) {
      return 'SSH signing needs a key: pick one or enter the path of a public key';
    }
    return null;
  }

  Future<void> _runTest() async {
    final err = _validate();
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    setState(() {
      _testing = true;
      _test = null;
      _error = null;
    });
    SigningTestResult r;
    try {
      r = await ctrl.repo.testSigning(format: _format, key: _key.text.trim());
    } catch (e) {
      r = SigningTestResult(ok: false, output: '$e');
    }
    if (mounted) {
      setState(() {
        _testing = false;
        _test = r;
      });
    }
  }

  Future<void> _save() async {
    final err = _validate();
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    setState(() => _saving = true);
    final ok = await ctrl.saveSigningSettings(
      SigningSettings(format: _format, signingKey: _key.text.trim(), commitSign: _commitSign, tagSign: _tagSign),
      _scope,
    );
    if (!mounted) return;
    if (ok) {
      Navigator.pop(context);
    } else {
      setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    const label = TextStyle(fontSize: 13, color: AppColors.textDim);
    const hint = TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.4);
    final config = _config;
    return AppDialog(
      title: 'Signing Settings',
      width: 600,
      onSubmit: _save,
      leftActions: [
        OutlinedButton(
          onPressed: _testing || config == null ? null : _runTest,
          child: _testing
              ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.5))
              : const Text('Test Signing'),
        ),
      ],
      actions: [
        OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _saving || config == null ? null : _save, child: const Text('Save')),
      ],
      child: config == null
          ? const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            )
          : SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Format (gpg.format)', style: label),
                  _radios<SigningFormat>(
                    _format,
                    [for (final f in SigningFormat.values) (f, f.label)],
                    _setFormat,
                  ),
                  const SizedBox(height: 8),
                  if (_format != SigningFormat.x509) ...[
                    Row(children: [
                      Text(_format == SigningFormat.openpgp ? 'Secret keys (gpg)' : 'SSH keys (~/.ssh and agent)',
                          style: label),
                      const Spacer(),
                      ToolButton(icon: Icons.refresh, tooltip: 'Reload keys', onPressed: _keysLoading ? null : _loadKeys),
                    ]),
                    const SizedBox(height: 4),
                    _keyList(),
                    const SizedBox(height: 10),
                  ],
                  TextField(
                    controller: _key,
                    style: monoStyle(size: 12.5),
                    decoration: InputDecoration(
                      labelText: 'Signing key (user.signingkey)',
                      floatingLabelBehavior: FloatingLabelBehavior.always,
                      hintText: switch (_format) {
                        SigningFormat.openpgp => 'Key id or fingerprint. Empty: chosen from the committer email',
                        SigningFormat.ssh => 'Path of a public key, or key::ssh-ed25519 AAAA…',
                        SigningFormat.x509 => 'Certificate id. Empty: chosen from the committer email',
                      },
                    ),
                    onChanged: (_) => setState(() {
                      _test = null;
                      _error = null;
                    }),
                  ),
                  if (_format == SigningFormat.ssh && config.allowedSignersFile == null)
                    const Padding(
                      padding: EdgeInsets.only(top: 6),
                      child: Text(
                        'gpg.ssh.allowedSignersFile is not set: SSH signatures are created, but the log cannot '
                        'verify them (shown as not signed / unknown).',
                        style: hint,
                      ),
                    ),
                  const SizedBox(height: 8),
                  _check('Sign commits by default', 'commit.gpgsign · default of "Sign commit" in the Commit panel',
                      _commitSign, (v) => setState(() => _commitSign = v)),
                  _check('Sign tags by default', 'tag.gpgsign · default of "Sign tag" in New Tag', _tagSign,
                      (v) => setState(() => _tagSign = v)),
                  const SizedBox(height: 6),
                  const Text('Save to', style: label),
                  _radios<ConfigScope>(
                    _scope,
                    const [
                      (ConfigScope.local, 'This repository (--local)'),
                      (ConfigScope.global, 'Global (--global, all repositories)'),
                    ],
                    (v) => setState(() => _scope = v),
                  ),
                  if (config.gpgProgram != null && _format == SigningFormat.openpgp)
                    Text('gpg.program: ${config.gpgProgram}', style: hint),
                  if (config.sshProgram != null && _format == SigningFormat.ssh)
                    Text('gpg.ssh.program: ${config.sshProgram}', style: hint),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(_error!, style: const TextStyle(fontSize: 12.5, color: AppColors.error)),
                    ),
                  if (_test != null) _testResult(_test!),
                ],
              ),
            ),
    );
  }

  Widget _radios<T>(T value, List<(T, String)> options, void Function(T) onChanged) => RadioGroup<T>(
        groupValue: value,
        onChanged: (v) => onChanged(v as T),
        child: Wrap(
          spacing: 16,
          children: [
            for (final (v, text) in options)
              InkWell(
                onTap: () => onChanged(v),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Radio<T>(value: v),
                  Text(text, style: const TextStyle(fontSize: 13)),
                ]),
              ),
          ],
        ),
      );

  Widget _check(String title, String subtitle, bool value, void Function(bool) onChanged) => CheckboxListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        controlAffinity: ListTileControlAffinity.leading,
        value: value,
        title: Text(title, style: const TextStyle(fontSize: 13)),
        subtitle: Text(subtitle, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
        onChanged: (v) => onChanged(v ?? false),
      );

  Widget _keyList() {
    Widget box(Widget child) => Container(
          height: 150,
          decoration: BoxDecoration(
            border: Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(4),
          ),
          child: child,
        );
    if (_keysLoading) return box(const Center(child: CircularProgressIndicator(strokeWidth: 2)));
    if (_keysError != null) {
      return box(SingleChildScrollView(
        padding: const EdgeInsets.all(8),
        child: SelectableText('Cannot list the keys:\n$_keysError',
            style: const TextStyle(fontSize: 12, color: AppColors.error)),
      ));
    }
    final rows = _format == SigningFormat.openpgp
        ? [for (final k in _gpgKeys ?? const <GpgKey>[]) _gpgRow(k)]
        : [for (final k in _sshKeys ?? const <SshKey>[]) _sshRow(k)];
    if (rows.isEmpty) {
      return box(EmptyHint(_format == SigningFormat.openpgp
          ? 'No secret keys. Create one with: gpg --quick-gen-key "Name <email>"'
          : 'No keys in ~/.ssh or the agent. Create one with: ssh-keygen -t ed25519'));
    }
    return box(ListView(children: rows));
  }

  Widget _gpgRow(GpgKey k) {
    final selected = k.matches(_key.text);
    final flags = [
      if (k.revoked) 'revoked',
      if (k.expired) 'expired',
      if (k.disabled) 'disabled',
      if (!k.canSign) 'cannot sign',
    ];
    final expires = k.expires;
    return HoverRow(
      height: 40,
      selected: selected,
      onTap: k.usable ? () => _pick(k.keyId) : null,
      child: Opacity(
        opacity: k.usable ? 1 : 0.55,
        child: Row(children: [
          const Icon(Icons.key, size: 15, color: AppColors.textDim),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(k.primaryUid, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                Text(
                  '${k.keyId} · ${expires == null ? 'no expiry' : '${k.expired ? 'expired' : 'expires'} ${_day(expires)}'}',
                  style: monoStyle(size: 11.5, color: AppColors.textMuted),
                ),
              ],
            ),
          ),
          for (final f in flags) _flag(f),
        ]),
      ),
    );
  }

  Widget _sshRow(SshKey k) {
    final selected = k.matches(_key.text);
    return HoverRow(
      height: 40,
      selected: selected,
      onTap: () => _pick(k.configValue),
      child: Row(children: [
        Icon(k.fromAgent ? Icons.memory : Icons.vpn_key_outlined, size: 15, color: AppColors.textDim),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${k.type}${k.comment.isEmpty ? '' : '  ${k.comment}'}',
                  overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
              Text(k.path ?? 'ssh-agent (stored as key::…)',
                  overflow: TextOverflow.ellipsis, style: monoStyle(size: 11.5, color: AppColors.textMuted)),
            ],
          ),
        ),
      ]),
    );
  }

  void _pick(String value) => setState(() {
        _key.text = value;
        _test = null;
        _error = null;
      });

  static String _day(DateTime t) {
    final l = t.toLocal();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${l.year}-${two(l.month)}-${two(l.day)}';
  }

  Widget _flag(String text) => Container(
        margin: const EdgeInsets.only(left: 4),
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
        decoration: BoxDecoration(
          color: AppColors.error.withValues(alpha: 0.14),
          border: Border.all(color: AppColors.error.withValues(alpha: 0.55)),
          borderRadius: BorderRadius.circular(3),
        ),
        child: Text(text, style: const TextStyle(fontSize: 11, color: AppColors.error, height: 1.1)),
      );

  Widget _testResult(SigningTestResult r) {
    final v = r.verification;
    final text = r.ok
        ? 'Signing works (test object ${r.output.substring(0, r.output.length.clamp(0, 10))}, not referenced).'
            '${v == null ? '' : '\nVerification: ${v.description}'}'
        : r.output;
    final color = r.ok ? AppColors.success : AppColors.error;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (r.ok && v != null && v.isSigned)
          SignatureBadge(v, size: 15)
        else
          Icon(r.ok ? Icons.check_circle_outline : Icons.error_outline, size: 15, color: color),
        const SizedBox(width: 6),
        Expanded(child: SelectableText(text, style: TextStyle(fontSize: 12.5, color: color))),
      ]),
    );
  }
}
