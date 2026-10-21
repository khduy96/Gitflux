import 'package:flutter/foundation.dart';

import '../../domain/entities/signing.dart';
import '../../domain/repositories/git_repository.dart';

/// Commit signing state of a repository: the configuration, the "Sign
/// commit" choice and the verified signatures shown in the log.
class SigningState {
  SigningState(this.repo, {required this.onError});

  final GitRepository repo;

  /// Reports a failed load (to the console).
  final void Function(String message) onError;

  /// Effective signing configuration.
  final config = ValueNotifier<SigningConfig>(const SigningConfig());

  /// "Sign commit" of the Commit panel, `commit.gpgsign` by default. Also
  /// used for Amend, Edit Commit Message, interactive rebase and merges.
  final signCommit = ValueNotifier<bool>(false);

  /// Verified signatures by commit hash, loaded for the visible rows only.
  final signatures = ValueNotifier<Map<String, SignatureInfo>>(const {});

  final _pending = <String>{};
  final _tags = <String, Future<SignatureInfo>>{};
  int _gen = 0;

  /// Reads the configuration and resets "Sign commit" to its default.
  Future<void> load() async {
    try {
      final c = await repo.signingConfig();
      config.value = c;
      signCommit.value = c.commitSign;
    } catch (e) {
      onError('$e');
    }
  }

  /// Verifies, in one batch, the commits of [hashes] that are not known yet.
  Future<void> loadSignatures(Iterable<String> hashes) async {
    final todo = [
      for (final h in hashes)
        if (!signatures.value.containsKey(h) && !_pending.contains(h)) h,
    ];
    if (todo.isEmpty) return;
    _pending.addAll(todo);
    final gen = _gen;
    Map<String, SignatureInfo> found;
    try {
      found = await repo.commitSignatures(todo);
    } catch (e) {
      onError('$e');
      // Not retried on every scroll: shown without a badge.
      found = const {};
    } finally {
      _pending.removeAll(todo);
    }
    if (gen != _gen) return;
    signatures.value = {
      ...signatures.value,
      for (final h in todo) h: found[h] ?? SignatureInfo.unsigned,
    };
  }

  /// Signature of the tag [name], cached until [clear].
  Future<SignatureInfo> tagSignature(String name) =>
      _tags[name] ??= repo.tagSignature(name).catchError((Object e) {
        _tags.remove(name);
        return SignatureInfo(status: SignatureStatus.cannotCheck, message: '$e');
      });

  /// Forgets the verified signatures (keys or trust may have changed).
  void clear() {
    _gen++;
    _tags.clear();
    signatures.value = const {};
  }
}
