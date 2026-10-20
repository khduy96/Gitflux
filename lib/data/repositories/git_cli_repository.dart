import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import '../../domain/entities/console_entry.dart';
import '../../domain/entities/git_models.dart';
import '../../domain/errors.dart';
import '../../domain/repositories/git_repository.dart';
import '../datasources/git_process.dart';

const _fs = '\x1f';
const _rs = '\x1e';

/// [GitRepository] backed by the git command line.
class GitCliRepository implements GitRepository {
  GitCliRepository(this.root, {void Function(ConsoleEntry)? onConsole})
      : git = GitProcess(root, onConsole: onConsole);

  @override
  final String root;
  final GitProcess git;
  String? _gitDir;

  @override
  String get name => p.basename(root);

  @override
  Future<String> gitDir() async {
    return _gitDir ??= p.normalize(
        (await git.run(['rev-parse', '--absolute-git-dir'])).trim());
  }

  @override
  Stream<RepoEvent> watch() =>
      Directory(root).watch(recursive: true).expand((e) => [?_eventFor(e)]);

  RepoEvent? _eventFor(FileSystemEvent e) {
    final rel = p.relative(e.path, from: root).replaceAll('\\', '/');
    if (rel == '.git' || rel.startsWith('.git/')) {
      if (rel.endsWith('.lock') ||
          rel.startsWith('.git/objects') ||
          rel.startsWith('.git/logs')) {
        return null;
      }
      if (rel.startsWith('.git/refs') ||
          rel == '.git/HEAD' ||
          rel == '.git/packed-refs' ||
          rel == '.git/FETCH_HEAD' ||
          rel == '.git/MERGE_HEAD' ||
          rel.startsWith('.git/rebase-')) {
        return RepoEvent.refs;
      }
      if (rel != '.git/index') return null;
    }
    return RepoEvent.status;
  }

  @override
  Future<String> runCommand(List<String> args) => git.run(args, log: true);

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  @override
  Future<RepoStatus> status() async {
    final out = await git.run([
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
    ]);
    String? branch;
    String? oid;
    String? upstream;
    var ahead = 0, behind = 0;
    final changes = <FileChange>[];

    final parts = out.split('\x00');
    for (var i = 0; i < parts.length; i++) {
      final e = parts[i];
      if (e.isEmpty) continue;
      if (e.startsWith('# ')) {
        final f = e.substring(2).split(' ');
        switch (f[0]) {
          case 'branch.oid':
            oid = f[1] == '(initial)' ? null : f[1];
          case 'branch.head':
            branch = f[1] == '(detached)' ? null : f.sublist(1).join(' ');
          case 'branch.upstream':
            upstream = f.sublist(1).join(' ');
          case 'branch.ab':
            ahead = int.tryParse(f[1].substring(1)) ?? 0;
            behind = int.tryParse(f[2].substring(1)) ?? 0;
        }
        continue;
      }
      switch (e[0]) {
        case '1':
          final f = _splitN(e, ' ', 9);
          changes.add(_ordinary(f[1], f[8], SubmoduleChange.parse(f[2])));
        case '2':
          final f = _splitN(e, ' ', 10);
          final orig = parts[++i];
          final xy = f[1];
          final copied = f[8].startsWith('C');
          changes.add(FileChange(
            path: f[9],
            oldPath: orig,
            type: copied ? ChangeType.copied : ChangeType.renamed,
            staged: xy[0] != '.',
            unstaged: xy[1] != '.',
            submodule: SubmoduleChange.parse(f[2]),
          ));
        case 'u':
          final f = _splitN(e, ' ', 11);
          changes.add(FileChange(
            path: f[10],
            type: ChangeType.conflicted,
            conflictCode: f[1],
            submodule: SubmoduleChange.parse(f[2]),
          ));
        case '?':
          // With --untracked-files=all a trailing slash means the folder is
          // a repository of its own (git does not descend into it).
          final path = e.substring(2);
          final nested = path.endsWith('/');
          changes.add(FileChange(
            path: nested ? path.substring(0, path.length - 1) : path,
            type: ChangeType.untracked,
            unstaged: true,
            nestedRepo: nested,
          ));
      }
    }
    changes.sort((a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()));
    return RepoStatus(
      branch: branch,
      headHash: oid,
      upstream: upstream,
      ahead: ahead,
      behind: behind,
      changes: changes,
      state: await repoState(),
    );
  }

  FileChange _ordinary(String xy, String path, SubmoduleChange? submodule) {
    final x = xy[0], y = xy[1];
    ChangeType type;
    if (x == 'A') {
      type = y == 'D' ? ChangeType.deleted : ChangeType.added;
    } else if (x == 'D' || y == 'D') {
      type = ChangeType.deleted;
    } else if (x == 'T' || y == 'T') {
      type = ChangeType.typeChanged;
    } else {
      type = ChangeType.modified;
    }
    return FileChange(
      path: path,
      type: type,
      staged: x != '.',
      unstaged: y != '.',
      submodule: submodule,
    );
  }

  @override
  Future<RepoState> repoState() async {
    final dir = await gitDir();
    bool exists(String name) =>
        FileSystemEntity.typeSync(p.join(dir, name)) !=
        FileSystemEntityType.notFound;
    if (exists('rebase-merge') || exists('rebase-apply')) {
      return RepoState.rebasing;
    }
    if (exists('MERGE_HEAD')) return RepoState.merging;
    if (exists('CHERRY_PICK_HEAD')) return RepoState.cherryPicking;
    if (exists('REVERT_HEAD')) return RepoState.reverting;
    return RepoState.normal;
  }

  /// Prepared commit message during merge / cherry-pick / revert.
  @override
  Future<String?> pendingMergeMessage() async {
    final f = File(p.join(await gitDir(), 'MERGE_MSG'));
    if (!await f.exists()) return null;
    final lines = (await f.readAsString())
        .split('\n')
        .where((l) => !l.startsWith('#'))
        .join('\n')
        .trim();
    return lines.isEmpty ? null : lines;
  }

  // ---------------------------------------------------------------------------
  // Log
  // ---------------------------------------------------------------------------

  static const _logFormat =
      '%H$_fs%P$_fs%an$_fs%ae$_fs%at$_fs%cn$_fs%ct$_fs%D$_fs%s$_rs';

  /// Loads commits for the log. [revisions] defaults to all refs.
  @override
  Future<List<Commit>> log({
    List<String>? revisions,
    String? path,
    int limit = 3000,
  }) async {
    final args = [
      'log',
      '--date-order',
      '--decorate=full',
      '-n',
      '$limit',
      '--format=$_logFormat',
      if (revisions != null && revisions.isNotEmpty)
        ...revisions
      else
        path != null ? 'HEAD' : '--all',
      if (path != null) ...['--follow', '--', lit(path)],
    ];
    final r = await git.runRaw(args);
    if (r.exitCode != 0) {
      // A repository without commits has nothing to log.
      if (r.stderr.contains('does not have any commits') ||
          r.stderr.contains('unknown revision')) {
        return const [];
      }
      throw GitException(args, r.exitCode, r.stderr, r.stdout);
    }
    return _parseCommits(r.stdout);
  }

  /// Commits reachable from [to] but not from [from].
  @override
  Future<List<Commit>> commitsBetween(String from, String to) async {
    final out = await git.run([
      'log',
      '--date-order',
      '--decorate=full',
      '--format=$_logFormat',
      '$from..$to',
    ]);
    return _parseCommits(out);
  }

  /// Commits of [ref] that are not on [remoteRef], or not on any branch of
  /// [remote] when [remoteRef] is null (new branch).
  @override
  Future<List<Commit>> outgoingCommits(String ref,
      {String? remoteRef, required String remote}) async {
    final r = await git.runRaw([
      'log',
      '--date-order',
      '--decorate=full',
      '--format=$_logFormat',
      ref,
      if (remoteRef != null) '^$remoteRef' else '--not',
      if (remoteRef == null) '--remotes=$remote',
    ]);
    return r.exitCode == 0 ? _parseCommits(r.stdout) : const [];
  }

  @override
  Future<bool> refExists(String ref) async {
    final r = await git.runRaw(['rev-parse', '--verify', '--quiet', ref]);
    return r.exitCode == 0;
  }

  List<Commit> _parseCommits(String out) {
    final commits = <Commit>[];
    for (var rec in out.split(_rs)) {
      rec = rec.replaceFirst(RegExp(r'^\s+'), '');
      if (rec.isEmpty) continue;
      final f = rec.split(_fs);
      if (f.length < 9) continue;
      commits.add(Commit(
        hash: f[0],
        parents: f[1].isEmpty ? const [] : f[1].split(' '),
        authorName: f[2],
        authorEmail: f[3],
        authorTime: _time(f[4]),
        committerName: f[5],
        commitTime: _time(f[6]),
        refs: _parseRefs(f[7]),
        subject: f.sublist(8).join(_fs),
      ));
    }
    return commits;
  }

  List<RefLabel> _parseRefs(String d) {
    if (d.trim().isEmpty) return const [];
    final refs = <RefLabel>[];
    for (var r in d.split(', ')) {
      r = r.trim();
      if (r.startsWith('HEAD -> ')) {
        refs.add(const RefLabel('HEAD', RefKind.head));
        r = r.substring(8);
      }
      if (r == 'HEAD') {
        refs.add(const RefLabel('HEAD', RefKind.head));
      } else if (r.startsWith('tag: ')) {
        refs.add(RefLabel(_stripRef(r.substring(5)), RefKind.tag));
      } else if (r.startsWith('refs/heads/')) {
        refs.add(RefLabel(r.substring(11), RefKind.localBranch));
      } else if (r.startsWith('refs/remotes/')) {
        if (r.endsWith('/HEAD')) continue;
        refs.add(RefLabel(r.substring(13), RefKind.remoteBranch));
      } else if (r.startsWith('refs/stash')) {
        continue;
      } else {
        refs.add(RefLabel(r, RefKind.localBranch));
      }
    }
    return refs;
  }

  static String _stripRef(String r) =>
      r.startsWith('refs/tags/') ? r.substring(10) : r;

  @override
  Future<CommitDetails> commitDetails(Commit c) async {
    final body = await git.run(['show', '-s', '--format=%B', c.hash]);
    final files = await changedFiles(
      c.parents.isEmpty ? null : c.parents.first,
      c.hash,
    );
    return CommitDetails(commit: c, body: body.trim(), files: files);
  }

  /// Branches (local and remote) that contain the commit.
  @override
  Future<List<String>> branchesContaining(String hash) async {
    final out = await git.run(
      ['branch', '-a', '--format=%(refname:short)', '--contains', hash],
      allowFailure: true,
    );
    return out
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.isNotEmpty && !l.endsWith('/HEAD'))
        .toList();
  }

  /// Files changed between two revisions. A null [from] means the empty tree.
  @override
  Future<List<FileChange>> changedFiles(String? from, String to) async {
    final out = await git.run([
      'diff-tree',
      '-r',
      '-z',
      '-M',
      '--name-status',
      '--no-commit-id',
      if (from == null) '--root',
      ?from,
      to,
    ]);
    return _parseNameStatusZ(out);
  }

  /// Files that differ between two refs using merge base (`a...b`).
  @override
  Future<List<FileChange>> diffFilesSymmetric(String a, String b) async {
    final out = await git.run(
        ['diff', '-z', '-M', '--name-status', '$a...$b']);
    return _parseNameStatusZ(out);
  }

  List<FileChange> _parseNameStatusZ(String out) {
    final parts = out.split('\x00');
    final files = <FileChange>[];
    for (var i = 0; i < parts.length; i++) {
      final s = parts[i];
      if (s.isEmpty) continue;
      final type = ChangeTypeLabel.fromLetter(s[0]);
      if (type == ChangeType.renamed || type == ChangeType.copied) {
        final oldPath = parts[++i];
        final newPath = parts[++i];
        files.add(FileChange(path: newPath, oldPath: oldPath, type: type));
      } else {
        files.add(FileChange(path: parts[++i], type: type));
      }
    }
    files.sort((a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()));
    return files;
  }

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------

  @override
  Future<List<Branch>> branches() async {
    final out = await git.run([
      'for-each-ref',
      '--format=%(refname)$_fs%(objectname)$_fs%(upstream:short)$_fs%(upstream:track)$_fs%(HEAD)',
      'refs/heads',
      'refs/remotes',
    ]);
    final result = <Branch>[];
    for (final line in out.split('\n')) {
      if (line.trim().isEmpty) continue;
      final f = line.split(_fs);
      final ref = f[0];
      if (ref.endsWith('/HEAD') && ref.startsWith('refs/remotes/')) continue;
      final isRemote = ref.startsWith('refs/remotes/');
      final name = isRemote ? ref.substring(13) : ref.substring(11);
      final track = f[3];
      result.add(Branch(
        name: name,
        isRemote: isRemote,
        hash: f[1],
        upstream: f[2].isEmpty ? null : f[2],
        ahead: _trackCount(track, 'ahead'),
        behind: _trackCount(track, 'behind'),
        gone: track.contains('gone'),
        isCurrent: f[4] == '*',
      ));
    }
    return result;
  }

  static int _trackCount(String track, String word) {
    final m = RegExp('$word (\\d+)').firstMatch(track);
    return m == null ? 0 : int.parse(m.group(1)!);
  }

  @override
  Future<List<Tag>> tags() async {
    final out = await git.run([
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname:short)$_fs%(objectname)$_fs%(*objectname)',
      'refs/tags',
    ]);
    return [
      for (final line in out.split('\n'))
        if (line.trim().isNotEmpty)
          () {
            final f = line.split(_fs);
            return Tag(f[0], f[2].isNotEmpty ? f[2] : f[1]);
          }(),
    ];
  }

  @override
  Future<List<Remote>> remotes() async {
    final out = await git.run(['remote', '-v']);
    final seen = <String>{};
    final result = <Remote>[];
    for (final line in out.split('\n')) {
      final m = RegExp(r'^(\S+)\s+(\S+)\s+\((fetch|push)\)').firstMatch(line);
      if (m != null && seen.add(m.group(1)!)) {
        result.add(Remote(m.group(1)!, m.group(2)!));
      }
    }
    return result;
  }

  @override
  Future<List<Stash>> stashes() async {
    final out = await git.run(
      ['stash', 'list', '--format=%gd$_fs%H$_fs%ct$_fs%gs'],
      allowFailure: true,
    );
    final result = <Stash>[];
    for (final line in out.split('\n')) {
      if (line.trim().isEmpty) continue;
      final f = line.split(_fs);
      if (f.length < 4) continue;
      final idx = int.tryParse(
              RegExp(r'\{(\d+)\}').firstMatch(f[0])?.group(1) ?? '') ??
          result.length;
      result.add(Stash(
        index: idx,
        ref: f[0],
        hash: f[1],
        time: _time(f[2]),
        message: f.sublist(3).join(_fs),
      ));
    }
    return result;
  }

  @override
  Future<List<FileChange>> stashFiles(Stash s) async {
    final files = await changedFiles('${s.hash}^1', s.hash);
    // Untracked files are stored in the third parent, if any.
    final untracked = await git.runRaw(
        ['diff-tree', '-r', '-z', '--name-status', '--no-commit-id', '--root', '${s.hash}^3']);
    if (untracked.exitCode == 0) {
      files.addAll(_parseNameStatusZ(untracked.stdout).map((f) =>
          FileChange(path: f.path, type: ChangeType.untracked)));
    }
    return files;
  }

  // ---------------------------------------------------------------------------
  // File content
  // ---------------------------------------------------------------------------

  /// Raw bytes of [path] at [rev]. Returns null if the file does not exist.
  @override
  Future<List<int>?> fileBytes(Revision rev, String path) async {
    switch (rev) {
      case EmptyRev():
        return null;
      case WorkingTreeRev():
        final f = File(p.join(root, path));
        if (await f.exists()) return f.readAsBytes();
        if (_isSubmoduleDir(path)) return utf8.encode(await _submoduleWorkTreeText(path));
        return null;
      case IndexRev():
        final staged = await _gitlinkSha(':$path', path, index: true);
        if (staged != null) return utf8.encode(await _submoduleText(path, staged));
        final r = await git.runRaw(['show', ':$path']);
        return r.exitCode == 0 ? r.stdoutBytes : null;
      case CommitRev(:final hash):
        final r = await git.runRaw(['show', '$hash:$path']);
        if (r.exitCode == 0) return r.stdoutBytes;
        // A submodule is stored as a commit id (gitlink), not as a file.
        final sha = await _gitlinkSha(hash, path);
        return sha == null ? null : utf8.encode(await _submoduleText(path, sha));
    }
  }

  // ---------------------------------------------------------------------------
  // Submodules
  // ---------------------------------------------------------------------------

  @override
  bool get hasGitmodules => File(p.join(root, '.gitmodules')).existsSync();

  bool _isSubmoduleDir(String path) =>
      FileSystemEntity.typeSync(p.join(root, path, '.git')) != FileSystemEntityType.notFound;

  /// Commit recorded for submodule [path] at [rev] (or in the index).
  Future<String?> _gitlinkSha(String rev, String path, {bool index = false}) async {
    final r = index
        ? await git.runRaw(['ls-files', '-s', '--', lit(path)])
        : await git.runRaw(['ls-tree', rev, '--', lit(path)]);
    final line = r.stdout.trim();
    if (r.exitCode != 0 || !line.startsWith('160000 ')) return null;
    final parts = line.split(RegExp(r'\s+'));
    return parts.length > 1 && parts[1].length == 40 ? parts[1] : (parts.length > 2 ? parts[2] : null);
  }

  /// Readable description of a submodule at a commit, used by the diff view.
  Future<String> _submoduleText(String path, String sha, {String extra = ''}) async {
    var info = '(commit not available locally: run "Update Submodules")';
    if (_isSubmoduleDir(path)) {
      final r = await GitProcess(p.join(root, path))
          .runRaw(['log', '-1', '--format=%s%n%an, %ad', '--date=short', sha]);
      if (r.exitCode == 0) info = r.stdout.trim();
    }
    return 'Submodule $path\nCommit $sha\n$info\n$extra';
  }

  Future<String> _submoduleWorkTreeText(String path) async {
    final sub = GitProcess(p.join(root, path));
    final head = (await sub.run(['rev-parse', 'HEAD'], allowFailure: true)).trim();
    final dirty = (await sub.run(['status', '--porcelain'], allowFailure: true)).trim();
    return _submoduleText(path, head.isEmpty ? '(no commit)' : head,
        extra: dirty.isEmpty ? '' : '\nLocal changes inside the submodule:\n$dirty\n');
  }

  /// Submodules declared in `.gitmodules` with their state.
  @override
  Future<List<Submodule>> submodules() async {
    if (!hasGitmodules) return const [];
    final urls = <String, String>{};
    final cfg = await git.run(
        ['config', '-f', '.gitmodules', '--get-regexp', r'^submodule\..*\.(path|url)$'],
        allowFailure: true);
    final names = <String, String>{}; // name -> path
    for (final line in cfg.split('\n')) {
      final m = RegExp(r'^submodule\.(.+)\.(path|url) (.*)$').firstMatch(line.trim());
      if (m == null) continue;
      if (m.group(2) == 'path') {
        names[m.group(1)!] = m.group(3)!;
      } else {
        urls[m.group(1)!] = m.group(3)!;
      }
    }
    final urlByPath = {for (final e in names.entries) e.value: urls[e.key] ?? ''};
    final out = await git.run(['submodule', 'status', '--recursive'], allowFailure: true);
    final result = <Submodule>[];
    for (final line in out.split('\n')) {
      final m = RegExp(r'^([ +\-U])([0-9a-f]{40}) (.+?)(?: \((.*)\))?$').firstMatch(line);
      if (m == null) continue;
      final path = m.group(3)!;
      result.add(Submodule(
        path: path,
        sha: m.group(2)!,
        status: switch (m.group(1)) {
          '-' => SubmoduleStatus.uninitialized,
          '+' => SubmoduleStatus.outOfDate,
          'U' => SubmoduleStatus.conflict,
          _ => SubmoduleStatus.upToDate,
        },
        url: urlByPath[path] ?? '',
        describe: m.group(4) ?? '',
      ));
    }
    // Declared in .gitmodules but not recorded in the parent repository
    // (no gitlink in the index): `git submodule status` skips these.
    final listed = {for (final s in result) s.path};
    for (final e in urlByPath.entries) {
      if (listed.contains(e.key)) continue;
      var sha = '';
      if (_isSubmoduleDir(e.key)) {
        sha = (await GitProcess(p.join(root, e.key)).run(['rev-parse', 'HEAD'], allowFailure: true)).trim();
      }
      result.add(Submodule(path: e.key, sha: sha, status: SubmoduleStatus.notRegistered, url: e.value));
    }
    result.sort((a, b) => a.path.compareTo(b.path));
    return result;
  }

  @override
  Future<String> nestedOriginUrl(String path) async =>
      (await GitProcess(p.join(root, path)).run(['remote', 'get-url', 'origin'], allowFailure: true)).trim();

  /// Registers an existing nested repository as a submodule.
  @override
  Future<void> registerSubmodule(String path, String url) =>
      git.run(['submodule', 'add', '--', url, path], log: true);

  /// Checks out the recorded commit of the submodules (all when [paths] is
  /// empty), initializing them first.
  @override
  Future<void> updateSubmodules({List<String> paths = const [], bool recursive = true}) => git.run([
        'submodule', 'update', '--init',
        if (recursive) '--recursive',
        if (paths.isNotEmpty) ...['--', ...paths],
      ], log: true);

  @override
  Future<void> syncSubmodules({List<String> paths = const []}) => git.run([
        'submodule', 'sync', '--recursive',
        if (paths.isNotEmpty) ...['--', ...paths],
      ], log: true);

  @override
  Future<void> addSubmodule(String url, String path) =>
      git.run(['submodule', 'add', '--', url, path], log: true);

  /// Content of one conflict stage (1 = base, 2 = ours, 3 = theirs).
  @override
  Future<String?> conflictStage(String path, int stage) async {
    final r = await git.runRaw(['show', ':$stage:$path']);
    return r.exitCode == 0 ? r.stdout : null;
  }

  @override
  Future<List<BlameLine>> blame(String path) async {
    final out = await git.run(['blame', '--porcelain', '--', path]);
    final info = <String, Map<String, String>>{};
    final result = <BlameLine>[];
    String? current;
    for (final line in const LineSplitter().convert(out)) {
      if (line.startsWith('\t')) {
        final i = info[current]!;
        result.add(BlameLine(
          hash: current!,
          author: i['author'] ?? '',
          time: _time(i['author-time'] ?? '0'),
          summary: i['summary'] ?? '',
          text: line.substring(1),
        ));
        continue;
      }
      final header = RegExp(r'^([0-9a-f]{40}) \d+ \d+').firstMatch(line);
      if (header != null) {
        current = header.group(1);
        info.putIfAbsent(current!, () => {});
        continue;
      }
      final sp = line.indexOf(' ');
      if (current != null && sp > 0) {
        info[current]![line.substring(0, sp)] = line.substring(sp + 1);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Commit / changes
  // ---------------------------------------------------------------------------

  @override
  Future<void> commit({
    required String message,
    required List<String> paths,
    bool amend = false,
    bool signOff = false,
    String? author,
    bool partial = true,
  }) async {
    final msgFile = File(p.join(
        Directory.systemTemp.path, 'git_tools_msg_${DateTime.now().microsecondsSinceEpoch}.txt'));
    await msgFile.writeAsString(message);
    try {
      if (paths.isNotEmpty) {
        await git.run(
          ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
          stdin: _pathspecs(paths),
          log: true,
        );
      }
      final useOnly = partial && (paths.isNotEmpty || amend);
      await git.run(
        [
          'commit',
          '-F',
          msgFile.path,
          if (amend) '--amend',
          if (signOff) '--signoff',
          if (author != null && author.trim().isNotEmpty) '--author=$author',
          if (useOnly) '--only',
          if (partial && paths.isNotEmpty) ...[
            '--pathspec-from-file=-',
            '--pathspec-file-nul',
          ],
        ],
        stdin: partial && paths.isNotEmpty ? _pathspecs(paths) : null,
        log: true,
      );
    } finally {
      if (await msgFile.exists()) await msgFile.delete();
    }
  }

  /// Unified diff of [changes] against [base] (working tree side), one entry
  /// per file. Untracked / newly added files without a base are rendered as
  /// whole-file additions. Binary files are reported but not included.
  @override
  Future<Map<String, String>> diffPerFile(
      List<FileChange> changes, {String? base}) async {
    final result = <String, String>{};
    final tracked = base == null
        ? const <FileChange>[]
        : changes.where((c) => c.type != ChangeType.untracked).toList();
    if (tracked.isNotEmpty) {
      final out = await git.run([
        'diff', '--no-color', '--no-ext-diff', '-M', base!, '--',
        ...tracked.expand((c) => c.allPaths).map(lit),
      ]);
      for (final chunk in out.split(RegExp(r'^(?=diff --git )', multiLine: true))) {
        if (chunk.trim().isEmpty) continue;
        final m = RegExp(r'^diff --git a/.* b/(.*)$', multiLine: true).firstMatch(chunk);
        result[m?.group(1) ?? chunk.split('\n').first] = chunk;
      }
    }
    for (final c in changes) {
      if (base != null && c.type != ChangeType.untracked) continue;
      final f = File(p.join(root, c.path));
      if (!await f.exists()) continue;
      final bytes = await f.readAsBytes();
      if (bytes.take(8000).contains(0)) {
        result[c.path] = 'new binary file: ${c.path} (${bytes.length} bytes)\n';
        continue;
      }
      final text = utf8.decode(bytes, allowMalformed: true);
      result[c.path] =
          'new file: ${c.path}\n${text.split('\n').map((l) => '+$l').join('\n')}\n';
    }
    return result;
  }

  @override
  Future<List<String>> recentSubjects({int count = 15}) async {
    final r = await git.runRaw(['log', '-$count', '--format=%s']);
    if (r.exitCode != 0) return const [];
    return r.stdout.split('\n').where((l) => l.trim().isNotEmpty).toList();
  }

  /// Diff of one tracked file: HEAD → working tree.
  @override
  Future<String> fileDiff(String path) => git.run(
      ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', lit(path)]);

  /// Commits through a temporary index, so only the given content is
  /// committed and the real index is left alone (hooks still run).
  /// [fullPaths] are committed as in the working tree, [partial] maps a path
  /// to the exact content to commit.
  @override
  Future<void> commitSelected({
    required String message,
    required List<String> fullPaths,
    required Map<String, String> partial,
    bool amend = false,
    bool signOff = false,
    String? author,
  }) async {
    final dir = await gitDir();
    final stamp = DateTime.now().microsecondsSinceEpoch;
    final tmpIndex = p.join(dir, 'gittools-index-$pid-$stamp');
    final msgFile = File(p.join(Directory.systemTemp.path, 'git_tools_msg_$stamp.txt'));
    await msgFile.writeAsString(message);
    final env = {'GIT_INDEX_FILE': tmpIndex};
    final hasHead = await refExists('HEAD');
    final allPaths = [...fullPaths, ...partial.keys];
    try {
      await git.run(hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], env: env, log: true);
      if (fullPaths.isNotEmpty) {
        await git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
            env: env, stdin: _pathspecs(fullPaths), log: true);
      }
      for (final e in partial.entries) {
        // --path applies the clean filters (e.g. CRLF → LF) like `git add`.
        final sha = (await git.run(['hash-object', '-w', '--stdin', '--path=${e.key}'], stdin: e.value)).trim();
        final ls = hasHead ? (await git.run(['ls-tree', 'HEAD', '--', lit(e.key)])).trim() : '';
        final mode = ls.isEmpty ? '100644' : ls.split(RegExp(r'\s')).first;
        await git.run(['update-index', '--add', '--cacheinfo', '$mode,$sha,${e.key}'], env: env, log: true);
      }
      await git.run([
        'commit',
        '-F',
        msgFile.path,
        if (amend) '--amend',
        if (signOff) '--signoff',
        if (author != null && author.trim().isNotEmpty) '--author=$author',
      ], env: env, log: true);
      // Sync the real index for the committed paths with the new HEAD; the
      // unselected lines stay as unstaged changes in the working tree.
      if (allPaths.isNotEmpty) {
        await git.run(['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'],
            stdin: _pathspecs(allPaths), log: true);
      }
    } finally {
      for (final f in [tmpIndex, '$tmpIndex.lock', msgFile.path]) {
        try {
          final file = File(f);
          if (await file.exists()) await file.delete();
        } catch (_) {}
      }
    }
  }

  @override
  Future<String> lastCommitMessage() async =>
      (await git.run(['log', '-1', '--format=%B'])).trim();

  @override
  Future<void> stage(List<String> paths) => git.run(
        ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
        stdin: _pathspecs(paths),
        log: true,
      );

  /// Reverts tracked changes to HEAD (Android Studio "Rollback").
  @override
  Future<void> rollback(List<FileChange> changes,
      {bool deleteAdded = false, required bool hasHead}) async {
    // A modified submodule is rolled back by checking out the commit that the
    // parent repository records for it.
    final submodules = changes.where((c) => c.isSubmodule && c.type == ChangeType.modified).toList();
    changes = changes.where((c) => !submodules.contains(c)).toList();
    if (submodules.isNotEmpty && hasHead) {
      final paths = submodules.map((c) => c.path).toList();
      await git.run(['restore', '--source=HEAD', '--staged', '--', ...paths.map(lit)], log: true);
      await updateSubmodules(paths: paths, recursive: false);
    }
    final added = changes.where((c) => c.type == ChangeType.added).toList();
    final others = changes.where((c) => c.type != ChangeType.added).toList();
    if (changes.isEmpty) return;
    if (!hasHead) {
      await git.run(['rm', '-r', '--cached', '-q', '--', ...changes.expand((c) => c.allPaths).map(lit)], log: true);
      return;
    }
    if (others.isNotEmpty) {
      await git.run([
        'restore',
        '--source=HEAD',
        '--staged',
        '--worktree',
        '--',
        ...others.expand((c) => c.allPaths).map(lit),
      ], log: true);
    }
    if (added.isNotEmpty) {
      await git.run([
        'rm',
        '--cached',
        '-q',
        '-f',
        '--',
        ...added.map((c) => lit(c.path)),
      ], log: true);
      if (deleteAdded) {
        for (final c in added) {
          final f = File(p.join(root, c.path));
          if (await f.exists()) await f.delete();
        }
      }
    }
  }

  @override
  Future<void> deleteFiles(List<String> paths) async {
    for (final path in paths) {
      final f = File(p.join(root, path));
      if (await f.exists()) await f.delete();
    }
    git.info('Deleted ${paths.length} file(s)');
  }

  @override
  Future<void> addToGitignore(List<String> patterns) async {
    final f = File(p.join(root, '.gitignore'));
    var content = await f.exists() ? await f.readAsString() : '';
    if (content.isNotEmpty && !content.endsWith('\n')) content += '\n';
    content += '${patterns.join('\n')}\n';
    await f.writeAsString(content);
    git.info('Added to .gitignore: ${patterns.join(', ')}');
  }

  @override
  Future<void> checkoutFile(String hash, String path) =>
      git.run(['checkout', hash, '--', path], log: true);

  // ---------------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------------

  @override
  Future<void> checkout(String ref) =>
      git.run(['checkout', ref], log: true);

  @override
  Future<void> checkoutRemote(Branch remote, {String? localName}) => git.run(
        ['checkout', '-b', localName ?? remote.shortName, '--track', remote.name],
        log: true,
      );

  /// Creates [name] at [startPoint] without an upstream. Branching off a
  /// remote branch (e.g. `origin/develop`) would otherwise make it the
  /// upstream, so a plain push would update `develop` instead of publishing
  /// [name]. The start point is kept in `branch.<name>.vscode-merge-base`.
  @override
  Future<void> createBranch(String name,
      {String? startPoint,
      bool checkout = true,
      bool force = false,
      bool fromRemote = false}) async {
    await git.run(
      checkout
          ? ['checkout', '--no-track', force ? '-B' : '-b', name, ?startPoint]
          : ['branch', '--no-track', if (force) '-f', name, ?startPoint],
      log: true,
    );
    if (fromRemote && startPoint != null) {
      await git.run(['config', 'branch.$name.vscode-merge-base', startPoint],
          allowFailure: true);
    }
  }

  @override
  Future<void> renameBranch(String oldName, String newName) =>
      git.run(['branch', '-m', oldName, newName], log: true);

  @override
  Future<void> deleteBranch(String name, {bool force = false}) =>
      git.run(['branch', force ? '-D' : '-d', name], log: true);

  @override
  Future<void> deleteRemoteBranch(Branch b) => git.run(
      ['push', '--progress', b.remoteName, '--delete', b.shortName],
      log: true);

  @override
  Future<void> merge(String ref, {bool noFf = false, bool squash = false}) =>
      git.run([
        'merge',
        '--no-edit',
        if (noFf) '--no-ff',
        if (squash) '--squash',
        ref,
      ], log: true);

  @override
  Future<void> rebase(String onto, {String? branch}) =>
      git.run(['rebase', '--autostash', onto, ?branch], log: true);

  @override
  Future<void> abortOperation(RepoState state) => git.run(switch (state) {
        RepoState.merging => ['merge', '--abort'],
        RepoState.rebasing => ['rebase', '--abort'],
        RepoState.cherryPicking => ['cherry-pick', '--abort'],
        RepoState.reverting => ['revert', '--abort'],
        RepoState.normal => throw StateError('No operation in progress'),
      }, log: true);

  @override
  Future<void> continueOperation(RepoState state) => git.run(switch (state) {
        RepoState.merging => ['commit', '--no-edit'],
        RepoState.rebasing => ['rebase', '--continue'],
        RepoState.cherryPicking => ['cherry-pick', '--continue'],
        RepoState.reverting => ['revert', '--continue'],
        RepoState.normal => throw StateError('No operation in progress'),
      }, log: true);

  @override
  Future<void> skipRebaseCommit() =>
      git.run(['rebase', '--skip'], log: true);

  // ---------------------------------------------------------------------------
  // Remote operations
  // ---------------------------------------------------------------------------

  @override
  Future<void> fetch({String? remote, bool prune = true}) => git.run([
        'fetch',
        '--progress',
        if (prune) '--prune',
        if (remote == null) '--all' else remote,
      ], log: true);

  @override
  Future<void> fetchInto(String remote, String remoteBranch, String localBranch) =>
      git.run(['fetch', remote, '$remoteBranch:$localBranch'], log: true);

  @override
  Future<void> pull({
    required String remote,
    required String branch,
    bool rebase = false,
    bool ffOnly = false,
  }) =>
      git.run([
        'pull',
        '--progress',
        '--no-edit',
        if (ffOnly) '--ff-only' else if (rebase) '--rebase' else '--no-rebase',
        if (rebase) '--autostash',
        remote,
        branch,
      ], log: true);

  @override
  Future<void> push({
    required String remote,
    required String localRef,
    required String remoteBranch,
    bool force = false,
    bool setUpstream = false,
    bool tags = false,
  }) =>
      git.run([
        'push',
        '--progress',
        if (force) '--force-with-lease',
        if (setUpstream) '--set-upstream',
        if (tags) '--follow-tags',
        remote,
        '$localRef:refs/heads/$remoteBranch',
      ], log: true);

  @override
  Future<void> pushTag(String remote, String tag) =>
      git.run(['push', '--progress', remote, 'refs/tags/$tag'], log: true);

  @override
  Future<void> addRemote(String name, String url) =>
      git.run(['remote', 'add', name, url], log: true);

  @override
  Future<void> removeRemote(String name) =>
      git.run(['remote', 'remove', name], log: true);

  @override
  Future<void> setRemoteUrl(String name, String url) =>
      git.run(['remote', 'set-url', name, url], log: true);

  // ---------------------------------------------------------------------------
  // Commit operations
  // ---------------------------------------------------------------------------

  @override
  Future<void> cherryPick(Commit c) => git.run(
      ['cherry-pick', if (c.isMerge) ...['-m', '1'], c.hash],
      log: true);

  @override
  Future<void> revert(Commit c) => git.run(
      ['revert', '--no-edit', if (c.isMerge) ...['-m', '1'], c.hash],
      log: true);

  @override
  Future<void> reset(String hash, ResetMode mode) =>
      git.run(['reset', '--${mode.name}', hash], log: true);

  @override
  Future<void> undoLastCommit() =>
      git.run(['reset', '--soft', 'HEAD~1'], log: true);

  @override
  Future<void> rewordHead(String message) async {
    await commit(message: message, paths: const [], amend: true);
  }

  /// Removes [c] from the current branch history.
  @override
  Future<void> dropCommit(Commit c) => git.run(
      ['rebase', '--autostash', '--onto', '${c.hash}^', c.hash],
      log: true);

  @override
  Future<void> createTag(String name, String hash, {String? message}) =>
      git.run([
        'tag',
        if (message != null && message.trim().isNotEmpty) ...['-a', '-m', message],
        name,
        hash,
      ], log: true);

  @override
  Future<void> deleteTag(String name) =>
      git.run(['tag', '-d', name], log: true);

  // ---------------------------------------------------------------------------
  // Stash
  // ---------------------------------------------------------------------------

  @override
  Future<void> stash({
    String? message,
    bool includeUntracked = false,
    bool keepIndex = false,
  }) =>
      git.run([
        'stash',
        'push',
        if (includeUntracked) '--include-untracked',
        if (keepIndex) '--keep-index',
        if (message != null && message.trim().isNotEmpty) ...['-m', message],
      ], log: true);

  @override
  Future<void> stashApply(Stash s, {bool pop = false, bool index = false}) =>
      git.run(['stash', pop ? 'pop' : 'apply', if (index) '--index', s.ref],
          log: true);

  @override
  Future<void> stashPop() => git.run(['stash', 'pop'], log: true);

  @override
  Future<void> stashDrop(Stash s) =>
      git.run(['stash', 'drop', s.ref], log: true);

  @override
  Future<void> stashClear() => git.run(['stash', 'clear'], log: true);

  @override
  Future<void> stashBranch(Stash s, String branch) =>
      git.run(['stash', 'branch', branch, s.ref], log: true);

  // ---------------------------------------------------------------------------
  // Conflicts
  // ---------------------------------------------------------------------------

  @override
  Future<void> acceptSide(FileChange c, {required bool ours}) async {
    final code = c.conflictCode ?? 'UU';
    // Is the chosen side a deletion?
    final deleted = ours
        ? (code == 'DU' || code == 'DD')
        : (code == 'UD' || code == 'DD');
    if (deleted) {
      await git.run(['rm', '-q', '--', lit(c.path)], log: true);
      return;
    }
    await git.run(['checkout', ours ? '--ours' : '--theirs', '--', lit(c.path)],
        log: true);
    await git.run(['add', '--', lit(c.path)], log: true);
  }

  /// Re-creates the conflicted content of [path] from the index stages
  /// (used when the working file no longer has conflict markers).
  @override
  Future<String> mergeFromStages(String path) async {
    final tmp = await Directory.systemTemp.createTemp('git_tools_merge');
    try {
      final names = ['ours', 'base', 'theirs'];
      final stages = [2, 1, 3];
      for (var i = 0; i < 3; i++) {
        await File(p.join(tmp.path, names[i]))
            .writeAsString(await conflictStage(path, stages[i]) ?? '');
      }
      final r = await git.runRaw([
        'merge-file', '-p', '--diff3',
        '-L', 'ours', '-L', 'base', '-L', 'theirs',
        p.join(tmp.path, 'ours'),
        p.join(tmp.path, 'base'),
        p.join(tmp.path, 'theirs'),
      ]);
      return r.stdout;
    } finally {
      await tmp.delete(recursive: true);
    }
  }

  @override
  Future<void> markResolved(String path, String content) async {
    await File(p.join(root, path)).writeAsString(content);
    await git.run(['add', '--', lit(path)], log: true);
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  @override
  Future<String?> config(String key) async {
    final out = await git.run(['config', '--get', key], allowFailure: true);
    final v = out.trim();
    return v.isEmpty ? null : v;
  }

  @override
  Future<void> setConfig(String key, String value, {bool global = false}) =>
      git.run(['config', if (global) '--global', key, value], log: true);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /// Marks a path as a literal pathspec so glob characters such as `[id]`
  /// in file names are not interpreted.
  static String lit(String path) => ':(literal)$path';

  static String _pathspecs(List<String> paths) =>
      '${paths.map(lit).join('\x00')}\x00';

  static DateTime _time(String secs) => DateTime.fromMillisecondsSinceEpoch(
      (int.tryParse(secs.trim()) ?? 0) * 1000);

  /// Splits [s] into at most [n] fields; the last field keeps the remainder.
  static List<String> _splitN(String s, String sep, int n) {
    final result = <String>[];
    var start = 0;
    while (result.length < n - 1) {
      final i = s.indexOf(sep, start);
      if (i < 0) break;
      result.add(s.substring(start, i));
      start = i + sep.length;
    }
    result.add(s.substring(start));
    return result;
  }
}
