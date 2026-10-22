import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../domain/entities/console_entry.dart';
import '../../domain/errors.dart';

class GitResult {
  GitResult(this.exitCode, this.stdoutBytes, this.stderr);

  final int exitCode;
  final List<int> stdoutBytes;
  final String stderr;

  String get stdout => utf8.decode(stdoutBytes, allowMalformed: true);
}

/// Thin wrapper around the git executable.
class GitProcess {
  GitProcess(this.workingDirectory, {this.onConsole, this.environment = const {}});

  final String workingDirectory;
  final void Function(ConsoleEntry entry)? onConsole;

  /// Variables added to every git process (e.g. `GNUPGHOME` in tests).
  final Map<String, String> environment;

  static const _utf8 = Utf8Codec(allowMalformed: true);

  static final Map<String, String> _env = {
    'GIT_TERMINAL_PROMPT': '0',
    'LANG': 'en_US.UTF-8',
    'LC_ALL': 'C.UTF-8',
    // Never open an interactive editor from this tool.
    'GIT_EDITOR': 'true',
    'GIT_SEQUENCE_EDITOR': 'true',
    'GIT_MERGE_AUTOEDIT': 'no',
  };

  static const List<String> _globalArgs = [
    '-c', 'core.quotepath=false',
    '-c', 'color.ui=false',
    '-c', 'i18n.logOutputEncoding=UTF-8',
    '-c', 'advice.detachedHead=false',
  ];

  /// Runs git and returns stdout. Throws [GitException] on non-zero exit
  /// unless [allowFailure] is set.
  Future<String> run(
    List<String> args, {
    bool log = false,
    bool allowFailure = false,
    String? stdin,
    Map<String, String>? env,
  }) async {
    final r = await runRaw(args, log: log, stdin: stdin, env: env);
    if (r.exitCode != 0 && !allowFailure) {
      throw GitException(args, r.exitCode, r.stderr, r.stdout);
    }
    return r.stdout;
  }

  Future<GitResult> runRaw(
    List<String> args, {
    bool log = false,
    String? stdin,
    Map<String, String>? env,
  }) async {
    if (log) _emit('git ${args.map(_quote).join(' ')}', ConsoleKind.command);
    final process = await Process.start(
      'git',
      [..._globalArgs, ...args],
      workingDirectory: workingDirectory,
      environment: env == null && environment.isEmpty ? _env : {..._env, ...environment, ...?env},
      runInShell: false,
    );
    if (stdin != null) {
      process.stdin.add(utf8.encode(stdin));
    }
    await process.stdin.close();

    final outBytes = <int>[];
    final errBuf = StringBuffer();
    final outDone = process.stdout.listen(outBytes.addAll).asFuture<void>();
    final errDone = process.stderr
        .transform(_utf8.decoder)
        .listen((chunk) {
          errBuf.write(chunk);
          if (log) {
            for (final line in const LineSplitter().convert(chunk)) {
              if (line.trim().isNotEmpty) _emit(line, ConsoleKind.output);
            }
          }
        })
        .asFuture<void>();
    final code = await process.exitCode;
    await Future.wait([outDone, errDone]);
    final result = GitResult(code, outBytes, errBuf.toString());
    if (log) {
      final out = result.stdout.trim();
      if (out.isNotEmpty) {
        final lines = const LineSplitter().convert(out);
        for (final line in lines.take(200)) {
          _emit(line, ConsoleKind.output);
        }
        if (lines.length > 200) {
          _emit('… ${lines.length - 200} more lines', ConsoleKind.output);
        }
      }
      if (code != 0) _emit('exit code $code', ConsoleKind.error);
    }
    return result;
  }

  void info(String text) => _emit(text, ConsoleKind.info);

  void _emit(String text, ConsoleKind kind) =>
      onConsole?.call(ConsoleEntry(text, kind));

  static String _quote(String a) =>
      a.isEmpty || a.contains(' ') ? '"$a"' : a;
}
