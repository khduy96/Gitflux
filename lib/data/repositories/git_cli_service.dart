import 'dart:io';

import 'package:path/path.dart' as p;

import '../../domain/entities/console_entry.dart';
import '../../domain/repositories/git_repository.dart';
import '../../domain/repositories/git_service.dart';
import '../datasources/git_process.dart';
import 'git_cli_repository.dart';

/// [GitService] backed by the git command line.
class GitCliService implements GitService {
  const GitCliService();

  @override
  Future<String?> version() async {
    try {
      final r = await Process.run('git', ['--version']);
      if (r.exitCode == 0) return (r.stdout as String).trim();
    } catch (_) {}
    return null;
  }

  @override
  Future<String?> findRoot(String dir) async {
    try {
      final out = await GitProcess(dir).run(['rev-parse', '--show-toplevel']);
      final top = out.trim();
      return top.isEmpty ? null : p.normalize(top);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> init(String dir) => GitProcess(dir).run(['init'], log: true);

  @override
  Future<void> clone(
    String url,
    String parentDir,
    String folderName, {
    void Function(ConsoleEntry)? onConsole,
    bool recurseSubmodules = true,
  }) =>
      GitProcess(parentDir, onConsole: onConsole).run([
        'clone',
        '--progress',
        if (recurseSubmodules) '--recurse-submodules',
        url,
        folderName,
      ], log: true);

  @override
  GitRepository open(String root, {void Function(ConsoleEntry)? onConsole}) =>
      GitCliRepository(root, onConsole: onConsole);
}
