import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import '../../domain/entities/bisect.dart';
import '../../domain/entities/clean.dart';
import '../../domain/entities/console_entry.dart';
import '../../domain/entities/git_models.dart';
import '../../domain/entities/lfs.dart';
import '../../domain/entities/log_query.dart';
import '../../domain/entities/merge.dart';
import '../../domain/entities/patch.dart';
import '../../domain/entities/rebase.dart';
import '../../domain/entities/reflog.dart';
import '../../domain/entities/signing.dart';
import '../../domain/entities/worktree.dart';
import '../../domain/errors.dart';
import '../../domain/logic/bisect_parser.dart';
import '../../domain/logic/clean_parser.dart';
import '../../domain/logic/lfs_parser.dart';
import '../../domain/logic/log_filters.dart';
import '../../domain/logic/patch_parser.dart';
import '../../domain/logic/rebase_todo.dart';
import '../../domain/logic/reflog_parser.dart';
import '../../domain/logic/signing_parser.dart';
import '../../domain/logic/worktree_parser.dart';
import '../../domain/repositories/git_repository.dart';
import '../datasources/git_process.dart';

const _fs = '\x1f';
const _rs = '\x1e';

/// [GitRepository] backed by the git command line.
class GitCliRepository implements GitRepository {
  /// [environment] is added to the environment of every git process (tests
  /// use it for a temporary `GNUPGHOME` / `HOME`).
  GitCliRepository(this.root, {void Function(ConsoleEntry)? onConsole, Map<String, String> environment = const {}})
      : git = GitProcess(root, onConsole: onConsole, environment: environment);

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
          rel.startsWith('.git/BISECT_') ||
          rel.startsWith('.git/worktrees/') ||
          rel.startsWith('.git/rebase-') ||
          rel.startsWith('.git/git-tools/shelf')) {
        return RepoEvent.refs;
      }
      // Changelists changed by the VS Code extension.
      if (rel == '.git/git-tools/changelists.json') return RepoEvent.status;
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
    // `git am` keeps its state in rebase-apply too, marked by `applying`.
    if (exists('rebase-apply/applying')) return RepoState.applyingMailbox;
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
    LogQuery query = const LogQuery(),
  }) async {
    final args = [
      'log',
      '--date-order',
      '--decorate=full',
      '-n',
      '$limit',
      '--format=$_logFormat',
      ...queryArgs(query),
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

  /// `git log` options of [q]. `-i` makes the author match ignore case; it
  /// applies to `-S` / `-G` as well, so the content search always ignores
  /// case too.
  static List<String> queryArgs(LogQuery q) => [
        if (q.authors.isNotEmpty || q.changes != null) '-i',
        if (q.authors.isNotEmpty) '--basic-regexp',
        for (final a in q.authors) '--author=${escapeBasicRegex(a)}',
        if (q.since != null) '--since=${dateArg(q.since!)}',
        if (q.until != null) '--until=${dateArg(q.until!)}',
        if (q.changes != null) q.changesRegex ? '-G${q.changes}' : '-S${q.changes}',
      ];

  /// Absolute date for `--since` / `--until`.
  static String dateArg(DateTime t) => '@${t.millisecondsSinceEpoch ~/ 1000}';

  @override
  Future<Commit?> findCommit(String rev) async {
    final r = await git.runRaw(
        ['log', '-1', '--no-walk', '--decorate=full', '--format=$_logFormat', '$rev^{commit}', '--']);
    return r.exitCode == 0 ? _parseCommits(r.stdout).firstOrNull : null;
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

  @override
  Future<List<FileChange>> diffFiles(String a, String b) async {
    final out = await git.run(['diff', '-z', '-M', '--name-status', a, b, '--']);
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
      '--format=%(refname)$_fs%(objectname)$_fs%(upstream:short)$_fs%(upstream:track)$_fs%(HEAD)$_fs%(worktreepath)',
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
        // Checked out in another worktree (this one is marked by %(HEAD)).
        worktree: f.length > 5 && f[5].isNotEmpty && f[4] != '*' ? f[5] : null,
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

  /// Two walks of the same reflog: one for selector, commit and subject, one
  /// for the time of each entry (`--date=unix` turns the selector into it).
  /// Entries git skips because their commit is gone come from the raw log.
  @override
  Future<List<ReflogEntry>> reflog({String ref = 'HEAD', int limit = 500}) async {
    final args = ['reflog', 'show', '-z', '-n', '$limit'];
    final r = await Future.wait([
      git.runRaw([...args, '--format=$reflogFormat', ref, '--']),
      git.runRaw([...args, '--date=unix', '--format=$reflogTimeFormat', ref, '--']),
    ]);
    // No reflog yet (new repository, unborn branch).
    if (r[0].exitCode != 0) return const [];
    final entries = parseReflog(r[0].stdout, r[1].exitCode == 0 ? r[1].stdout : '');
    if (entries.isEmpty || entries.last.index + 1 == entries.length) return entries;
    try {
      final path = (await git.run(['rev-parse', '--git-path', 'logs/$ref'])).trim();
      final file = File(p.isAbsolute(path) ? path : p.join(root, path));
      if (!await file.exists()) return entries;
      final raw = parseRawReflog(await file.readAsString(), ref);
      return addMissingReflogEntries(entries, raw);
    } on Object {
      return entries;
    }
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
      case PatchedRev(:final base, :final patch):
        return _withTempIndex(base, (env) async {
          final args = ['apply', '--cached', '--binary', patch];
          final r = await git.runRaw(args, env: env);
          if (r.exitCode != 0) throw GitException(args, r.exitCode, r.stderr, r.stdout);
          final show = await git.runRaw(['show', ':$path'], env: env);
          return show.exitCode == 0 ? show.stdoutBytes : null;
        });
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
    bool? sign,
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
          ..._signArgs(sign),
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
    bool? sign,
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
        ..._signArgs(sign),
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
  Future<void> merge(String ref, {MergeOptions options = const MergeOptions()}) =>
      git.run(['merge', '--no-edit', ...options.args, ref], log: true);

  @override
  Future<int> countCommits(String from, String to) async =>
      int.tryParse((await git.run(['rev-list', '--count', '$from..$to'])).trim()) ?? 0;

  @override
  Future<String?> squashMessage({int maxLines = 30}) async {
    final f = File(await gitPath('SQUASH_MSG'));
    if (!await f.exists()) return null;
    final lines = (await f.readAsString()).split('\n').where((l) => !l.startsWith('#')).take(maxLines);
    final text = lines.join('\n').trim();
    return text.isEmpty ? null : text;
  }

  final _gitPaths = <String, String>{};

  @override
  Future<String> gitPath(String name) async {
    if (_gitPaths[name] case final path?) return path;
    final out = (await git.run(['rev-parse', '--git-path', name])).trim();
    return _gitPaths[name] = p.normalize(p.isAbsolute(out) ? out : p.join(root, out));
  }

  @override
  Future<void> rebase(String onto, {String? branch, bool? sign}) =>
      git.run(['rebase', '--autostash', ..._rebaseSignArgs(sign), onto, ?branch], log: true);

  @override
  Future<void> abortOperation(RepoState state) async {
    try {
      await git.run(switch (state) {
        RepoState.merging => ['merge', '--abort'],
        RepoState.rebasing => ['rebase', '--abort'],
        RepoState.cherryPicking => ['cherry-pick', '--abort'],
        RepoState.reverting => ['revert', '--abort'],
        RepoState.applyingMailbox => ['am', '--abort'],
        RepoState.normal => throw StateError('No operation in progress'),
      }, log: true);
    } finally {
      if (state == RepoState.rebasing) await cleanupRebaseState();
    }
  }

  @override
  Future<void> continueOperation(RepoState state, {bool? sign}) async {
    try {
      await git.run(switch (state) {
        RepoState.merging => ['commit', '--no-edit', ..._signArgs(sign)],
        RepoState.rebasing => ['rebase', '--continue'],
        RepoState.cherryPicking => ['cherry-pick', '--continue'],
        RepoState.reverting => ['revert', '--continue'],
        RepoState.applyingMailbox => ['am', '--continue'],
        RepoState.normal => throw StateError('No operation in progress'),
      }, log: true);
    } finally {
      if (state == RepoState.rebasing) await cleanupRebaseState();
    }
  }

  @override
  Future<void> skipRebaseCommit() async {
    try {
      await git.run(['rebase', '--skip'], log: true);
    } finally {
      await cleanupRebaseState();
    }
  }

  @override
  Future<void> skipMailboxPatch() => git.run(['am', '--skip'], log: true);

  // ---------------------------------------------------------------------------
  // Clean
  // ---------------------------------------------------------------------------

  @override
  Future<List<String>> cleanDryRun(CleanOptions options, {bool nested = false}) async => parseCleanDryRun(
      await git.run(['clean', '-n', if (nested) '-ff', ...options.args]));

  /// Paths go on the command line in chunks: `git clean` has no
  /// `--pathspec-from-file`.
  @override
  Future<void> clean(List<String> pathspecs, CleanOptions options, {bool nested = false}) async {
    for (final chunk in chunkArgs(pathspecs.map(lit).toList())) {
      await git.run(['clean', nested ? '-ff' : '-f', ...options.args, '--', ...chunk], log: true);
    }
  }

  // ---------------------------------------------------------------------------
  // Worktrees
  // ---------------------------------------------------------------------------

  String? _topLevel;

  @override
  Future<List<Worktree>> worktrees() async {
    final out = await git.run(['worktree', 'list', '--porcelain', '-z']);
    _topLevel ??= (await git.run(['rev-parse', '--show-toplevel'], allowFailure: true)).trim();
    return parseWorktrees(out, currentPath: _topLevel!.isEmpty ? root : _topLevel);
  }

  @override
  Future<void> addWorktree(String path, WorktreeCheckout checkout) => git.run([
        'worktree', 'add',
        ...switch (checkout) {
          ExistingBranchCheckout(:final branch) => ['--', path, branch],
          NewBranchCheckout(:final branch, :final startPoint) => ['-b', branch, '--', path, ?startPoint],
          DetachedCheckout(:final revision) => ['--detach', '--', path, ?revision],
        },
      ], log: true);

  @override
  Future<void> lockWorktree(String path, {String? reason}) => git.run([
        'worktree', 'lock',
        if (reason != null && reason.trim().isNotEmpty) ...['--reason', reason.trim()],
        path,
      ], log: true);

  @override
  Future<void> unlockWorktree(String path) => git.run(['worktree', 'unlock', path], log: true);

  @override
  Future<void> removeWorktree(String path, {bool force = false}) =>
      git.run(['worktree', 'remove', if (force) '--force', path], log: true);

  /// Git reports what it prunes on stderr.
  @override
  Future<String> pruneWorktrees({bool dryRun = false}) async {
    final args = ['worktree', 'prune', '-v', if (dryRun) '-n'];
    final r = await git.runRaw(args, log: !dryRun);
    if (r.exitCode != 0) throw GitException(args, r.exitCode, r.stderr, r.stdout);
    return [r.stdout.trim(), r.stderr.trim()].where((s) => s.isNotEmpty).join('\n');
  }

  // ---------------------------------------------------------------------------
  // Bisect
  // ---------------------------------------------------------------------------

  @override
  Future<BisectState?> bisectState() async {
    final start = File(await gitPath('BISECT_START'));
    if (!await start.exists()) return null;
    final logFile = File(await gitPath('BISECT_LOG'));
    final log = parseBisectLog(await logFile.exists() ? await logFile.readAsString() : '');
    final marks = parseBisectRefs(
        await git.run(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/bisect'], allowFailure: true));
    int? left, steps;
    final good = [
      for (final e in marks.entries)
        if (e.value == BisectMark.good) e.key,
    ];
    if (log.firstBad == null && good.isNotEmpty && await refExists('refs/bisect/bad')) {
      final vars = await git.runRaw(['rev-list', '--bisect-vars', 'refs/bisect/bad', '--not', ...good]);
      if (vars.exitCode == 0) (:left, :steps) = parseBisectVars(vars.stdout);
    }
    final head = (await git.run(['log', '-1', '--format=%H$_fs%s'], allowFailure: true)).trim().split(_fs);
    final expectedFile = File(await gitPath('BISECT_EXPECTED_REV'));
    final expected = await expectedFile.exists() ? (await expectedFile.readAsString()).trim() : '';
    return BisectState(
      startRef: (await start.readAsString()).trim(),
      marks: marks,
      log: log,
      revisionsLeft: left,
      steps: steps,
      currentHash: head.first.isEmpty ? null : head.first,
      currentSubject: head.length > 1 ? head.sublist(1).join(_fs) : null,
      expectedHash: expected.isEmpty ? null : expected,
    );
  }

  /// Exit code 2 with this text: only skipped commits are left; git lists
  /// the possible first bad commits and the session goes on.
  static bool _bisectOnlySkipped(GitResult r) =>
      r.exitCode == 2 && '${r.stdout}${r.stderr}'.contains("only 'skip'ped commits left");

  @override
  Future<void> bisectStart() => git.run(['bisect', 'start'], log: true);

  @override
  Future<String> bisectMark(BisectMark mark, {String? rev}) async {
    final args = ['bisect', mark.name, ?rev];
    final r = await git.runRaw(args, log: true);
    if (r.exitCode != 0 && !_bisectOnlySkipped(r)) throw GitException(args, r.exitCode, r.stderr, r.stdout);
    return [r.stdout.trim(), r.stderr.trim()].where((s) => s.isNotEmpty).join('\n');
  }

  @override
  Future<void> bisectReset() => git.run(['bisect', 'reset'], log: true);

  /// [command] runs through `sh -c` (git quotes each argument it is given),
  /// so it may contain arguments, pipes and redirections.
  @override
  Future<String> bisectRun(String command) async {
    final args = ['bisect', 'run', 'sh', '-c', command];
    final r = await git.runRaw(args, log: true);
    final output = [r.stdout.trim(), r.stderr.trim()].where((s) => s.isNotEmpty).join('\n');
    if (r.exitCode != 0 && firstBadCommitIn(output) == null && !_bisectOnlySkipped(r)) {
      throw GitException(args, r.exitCode, r.stderr, r.stdout);
    }
    return output;
  }

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
  Future<void> fetchBranch(String remote, String branch) =>
      git.run(['fetch', '--progress', remote, '+refs/heads/$branch:refs/remotes/$remote/$branch'], log: true);

  @override
  Future<void> checkoutFrom(String name, String ref) async {
    await git.run(['checkout', '-B', name, ref], log: true);
    await git.run(['branch', '--set-upstream-to=$ref', name], log: true);
  }

  @override
  Future<({String branch, String upstream})?> pullInProgress() async {
    Future<String> rev(String ref) async {
      final r = await git.runRaw(['rev-parse', '--verify', '--quiet', ref]);
      return r.exitCode == 0 ? r.stdout.trim() : '';
    }

    var branch = '';
    var target = await rev('MERGE_HEAD');
    if (target.isNotEmpty) {
      final r = await git.runRaw(['symbolic-ref', '--short', '--quiet', 'HEAD']);
      branch = r.exitCode == 0 ? r.stdout.trim() : '';
    } else {
      for (final name in ['rebase-merge', 'rebase-apply']) {
        final dir = p.normalize(p.join(await gitDir(), name));
        final head = File(p.join(dir, 'head-name'));
        final onto = File(p.join(dir, 'onto'));
        if (!head.existsSync() || !onto.existsSync()) continue;
        branch = head.readAsStringSync().trim().replaceFirst('refs/heads/', '');
        target = onto.readAsStringSync().trim();
        break;
      }
    }
    if (branch.isEmpty || target.isEmpty) return null;
    final up = await git.runRaw(['rev-parse', '--abbrev-ref', '$branch@{upstream}']);
    final upstream = up.exitCode == 0 ? up.stdout.trim() : '';
    if (upstream.isEmpty || await rev(upstream) != target) return null;
    return (branch: branch, upstream: upstream);
  }

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
  Future<void> rewordHead(String message, {bool? sign}) async {
    await commit(message: message, paths: const [], amend: true, sign: sign);
  }

  @override
  Future<void> createTag(String name, String hash, {String? message, bool? sign}) {
    final hasMessage = message != null && message.trim().isNotEmpty;
    return git.run([
      'tag',
      if (sign == true) ...['-s', '-m', hasMessage ? message : name]
      else ...[
        // Without --no-sign, tag.gpgsign would sign (and need a message).
        if (sign == false) '--no-sign',
        if (hasMessage) ...['-a', '-m', message],
      ],
      name,
      hash,
    ], log: true);
  }

  @override
  Future<void> deleteTag(String name) =>
      git.run(['tag', '-d', name], log: true);

  // ---------------------------------------------------------------------------
  // Interactive rebase
  // ---------------------------------------------------------------------------

  String? _stateDir;

  /// Set while a preview or a rebase of this tool runs, so the state
  /// directory is not cleaned up under it.
  bool _rebaseBusy = false;

  static List<String> _range(String? base) => [base == null ? 'HEAD' : '$base..HEAD'];

  /// The preview passes `--no-autosquash` so the todo shows the real history
  /// even with `rebase.autoSquash=true`.
  static List<String> _rebaseArgs(String? base, bool rebaseMerges, {bool preview = false}) => [
        'rebase', '-i', '--autostash',
        if (preview) '--no-autosquash',
        if (rebaseMerges) '--rebase-merges',
        base ?? '--root',
      ];

  @override
  Future<bool> isAncestor(String ancestor, String descendant) async =>
      (await git.runRaw(['merge-base', '--is-ancestor', ancestor, descendant])).exitCode == 0;

  @override
  Future<List<({Commit commit, String message})>> rebaseRange(String? base) async {
    final commits = _parseCommits(await git.run(
        ['log', '--topo-order', '--decorate=full', '--format=$_logFormat', ..._range(base)]));
    final messages = <String, String>{};
    for (var rec in (await git.run(['log', '--format=%H$_fs%B$_rs', ..._range(base)])).split(_rs)) {
      rec = rec.replaceFirst(RegExp(r'^\s+'), '');
      final i = rec.indexOf(_fs);
      if (i > 0) messages[rec.substring(0, i)] = rec.substring(i + 1).trim();
    }
    return [for (final c in commits) (commit: c, message: messages[c.hash] ?? c.subject)];
  }

  @override
  Future<bool> rangeHasMerges(String? base) async =>
      (await git.run(['rev-list', '--merges', '-n', '1', ..._range(base)])).trim().isNotEmpty;

  @override
  Future<int> pushedCount(String? base) async {
    final up = await git.runRaw(['rev-parse', '--verify', '--quiet', '@{upstream}']);
    if (up.exitCode != 0) return 0;
    Future<int> count(List<String> args) async =>
        int.tryParse((await git.run(['rev-list', '--count', ...args])).trim()) ?? 0;
    return await count(_range(base)) - await count([..._range(base), '^${up.stdout.trim()}']);
  }

  @override
  Future<String> rebaseStateDir() async {
    if (_stateDir != null) return _stateDir!;
    final out = (await git.run(['rev-parse', '--git-path', 'git-tools-rebase'])).trim();
    return _stateDir = p.normalize(p.isAbsolute(out) ? out : p.join(root, out)).replaceAll('\\', '/');
  }

  /// Runs `git rebase -i` with an editor that copies the todo and then empties
  /// it: git answers "nothing to do", removes its state and exits without
  /// touching HEAD.
  ///
  /// `--autostash` would turn staged changes into unstaged ones on the way
  /// (the stash is re-applied without `--index`), so git runs on a temporary
  /// index made of HEAD with every entry marked assume-unchanged instead: the
  /// clean work tree check passes and the real index, work tree and stash
  /// list are never touched.
  @override
  Future<String> generateRebaseTodo(String? base, {bool rebaseMerges = false}) async {
    final dir = await rebaseStateDir();
    final copy = '$dir/original-todo';
    final env = {'GIT_INDEX_FILE': '$dir/preview-index'};
    _rebaseBusy = true;
    try {
      await Directory(dir).create(recursive: true);
      await git.run(['read-tree', 'HEAD'], env: env);
      final files = await git.run(['ls-files', '-z'], env: env);
      if (files.isNotEmpty) {
        await git.run(['update-index', '-z', '--assume-unchanged', '--stdin'], env: env, stdin: files);
      }
      final args = _rebaseArgs(base, rebaseMerges, preview: true);
      final r = await git.runRaw(args, env: {
        ...env,
        'GIT_SEQUENCE_EDITOR': 'f(){ cp "\$1" ${shellQuote(copy)}; : > "\$1"; }; f',
      });
      final todo = File(copy);
      if (!await todo.exists()) throw GitException(args, r.exitCode, r.stderr, r.stdout);
      return await todo.readAsString();
    } finally {
      _rebaseBusy = false;
      await cleanupRebaseState();
    }
  }

  @override
  Future<RebaseOutcome> runRebaseTodo(
    String? base, {
    required String todo,
    required Map<String, String> messages,
    bool rebaseMerges = false,
    bool? sign,
  }) async {
    final dir = await rebaseStateDir();
    _rebaseBusy = true;
    try {
      await Directory(dir).create(recursive: true);
      await File('$dir/todo').writeAsString(todo);
      for (final e in messages.entries) {
        await File('$dir/${e.key}').writeAsString(e.value);
      }
      final args = _rebaseArgs(base, rebaseMerges)..insertAll(1, _rebaseSignArgs(sign));
      // Git appends the todo path: `cp <ours> <todo>`.
      final r = await git.runRaw(args, env: {'GIT_SEQUENCE_EDITOR': 'cp ${shellQuote('$dir/todo')} '}, log: true);
      final output = [r.stdout.trim(), r.stderr.trim()].where((s) => s.isNotEmpty).join('\n');
      // Stopped for a conflict, an `edit`, a failing hook or exec: the
      // message files must survive until the rebase ends.
      if (await repoState() == RepoState.rebasing) return RebaseOutcome(stopped: true, output: output);
      if (r.exitCode != 0) throw GitException(args, r.exitCode, r.stderr, r.stdout);
      return RebaseOutcome(stopped: false, output: output);
    } finally {
      _rebaseBusy = false;
      await cleanupRebaseState();
    }
  }

  @override
  Future<RebaseProgress?> rebaseProgress() async {
    final dir = p.join(await gitDir(), 'rebase-merge');
    Future<String?> read(String name) async {
      final f = File(p.join(dir, name));
      return await f.exists() ? (await f.readAsString()).trim() : null;
    }

    final end = int.tryParse(await read('end') ?? '');
    if (end == null) return _mailboxProgress();
    final stopped = await read('stopped-sha');
    String? subject;
    if (stopped != null && stopped.isNotEmpty) {
      subject = (await git.run(['log', '-1', '--format=%s', stopped], allowFailure: true)).trim();
    }
    return RebaseProgress(
      done: int.tryParse(await read('msgnum') ?? '') ?? 0,
      total: end,
      stoppedForEdit: await File(p.join(dir, 'amend')).exists(),
      stoppedHash: stopped == null || stopped.isEmpty ? null : stopped,
      stoppedSubject: subject,
    );
  }

  /// Patch `git am` stopped on: `rebase-apply/next` of `rebase-apply/last`,
  /// with the subject of that patch.
  Future<RebaseProgress?> _mailboxProgress() async {
    final dir = p.join(await gitDir(), 'rebase-apply');
    if (!await File(p.join(dir, 'applying')).exists()) return null;
    Future<String?> read(String name) async {
      final f = File(p.join(dir, name));
      return await f.exists() ? (await f.readAsString()).trim() : null;
    }

    final last = int.tryParse(await read('last') ?? '');
    final next = int.tryParse(await read('next') ?? '');
    if (last == null || next == null) return null;
    final subject = (await read('final-commit'))?.split('\n').first;
    return RebaseProgress(done: next, total: last, stoppedSubject: subject);
  }

  @override
  Future<void> cleanupRebaseState() async {
    if (_rebaseBusy || await repoState() != RepoState.normal) return;
    final dir = Directory(await rebaseStateDir());
    try {
      if (await dir.exists()) await dir.delete(recursive: true);
    } on FileSystemException catch (_) {
      // Retried on the next refresh.
    }
  }

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
  // Patches
  // ---------------------------------------------------------------------------

  /// Diff options giving a patch git can apply whatever the diff settings of
  /// the user (prefixes, external diff, textconv, relative paths).
  static const _patchArgs = [
    '--binary', '--full-index', '-M', '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-relative', '--src-prefix=a/', '--dst-prefix=b/',
  ];

  String? _commonDir;

  @override
  Future<String> commonDir() async {
    if (_commonDir != null) return _commonDir!;
    final out = (await git.run(['rev-parse', '--git-common-dir'])).trim();
    return _commonDir = p.normalize(p.isAbsolute(out) ? out : p.join(root, out));
  }

  /// Runs [action] with `GIT_INDEX_FILE` set to a temporary index made from
  /// [base], or copied from the real index when [base] is null.
  Future<T> _withTempIndex<T>(String? base, Future<T> Function(Map<String, String> env) action) async {
    final tmp = p.join(await gitDir(), 'gittools-index-$pid-${DateTime.now().microsecondsSinceEpoch}');
    final env = {'GIT_INDEX_FILE': tmp};
    try {
      if (base != null) {
        await git.run(['read-tree', base], env: env);
      } else {
        final out = (await git.run(['rev-parse', '--git-path', 'index'])).trim();
        final real = File(p.isAbsolute(out) ? out : p.join(root, out));
        if (await real.exists()) {
          await real.copy(tmp);
        } else {
          await git.run(['read-tree', '--empty'], env: env);
        }
      }
      return await action(env);
    } finally {
      for (final f in [tmp, '$tmp.lock']) {
        try {
          final file = File(f);
          if (await file.exists()) await file.delete();
        } catch (_) {}
      }
    }
  }

  /// Writes [patch] to a temporary file for the duration of [action].
  Future<T> _withPatchFile<T>(List<int> patch, Future<T> Function(String path) action) async {
    final f = File(p.join(Directory.systemTemp.path,
        'git_tools_patch_${pid}_${DateTime.now().microsecondsSinceEpoch}.patch'));
    await f.writeAsBytes(patch);
    try {
      return await action(f.path);
    } finally {
      try {
        if (await f.exists()) await f.delete();
      } catch (_) {}
    }
  }

  /// `git add -A` of [paths] into a temporary index made from [base] takes
  /// modified, deleted and untracked files alike; the diff of that index
  /// against [base] is the patch.
  @override
  Future<WorkingTreePatch> diffWorkingTree(String base, List<String> paths) => _withTempIndex(base, (env) async {
        // `git add` fails on a path that is neither on disk nor in the index
        // (e.g. a staged new file deleted since).
        final missing = [
          for (final path in paths)
            if (FileSystemEntity.typeSync(p.join(root, path), followLinks: false) == FileSystemEntityType.notFound) path,
        ];
        final inBase = missing.isEmpty
            ? const <String>{}
            : (await git.run(['ls-files', '-z', '--', ...missing.map(lit)], env: env)).split('\x00').toSet();
        final add = paths.where((path) => !missing.contains(path) || inBase.contains(path)).toList();
        if (add.isNotEmpty) {
          await git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
              env: env, stdin: _pathspecs(add), log: true);
        }
        final args = ['diff', '--cached', ..._patchArgs, base, '--'];
        final r = await git.runRaw(args, env: env);
        if (r.exitCode != 0) throw GitException(args, r.exitCode, r.stderr, r.stdout);
        final names = await git.run(['diff', '--cached', '-z', '-M', '--name-status', '--no-relative', base, '--'], env: env);
        return (patch: r.stdoutBytes, files: _parseNameStatusZ(names));
      });

  /// One `git format-patch -1` per commit, concatenated in topological order.
  @override
  Future<List<int>> formatPatch(List<String> hashes) async {
    final wanted = hashes.toSet();
    final order = (await git.run(['rev-list', '--topo-order', '--reverse', '--no-merges', ...hashes]))
        .split('\n')
        .map((l) => l.trim())
        .where(wanted.contains)
        .toList();
    final out = <int>[];
    for (final hash in order) {
      final args = [
        'format-patch', '-1', '--stdout', '--binary', '--no-attach', '--no-thread',
        '--src-prefix=a/', '--dst-prefix=b/', hash,
      ];
      final r = await git.runRaw(args);
      if (r.exitCode != 0) throw GitException(args, r.exitCode, r.stderr, r.stdout);
      out.addAll(r.stdoutBytes);
    }
    return out;
  }

  @override
  Future<String> patchStats(List<int> patch) =>
      _withPatchFile(patch, (file) => git.run(['apply', '--numstat', '--summary', file]));

  static final _conflictLine = RegExp(r"^Applied patch to '(.*)' with conflicts\.$", multiLine: true);

  /// Runs on a copy of the index that takes the working tree content of the
  /// tracked files: local changes of a patched file are merged as "ours"
  /// instead of making git refuse it ("does not match index"), and the real
  /// index keeps the user's staging. A file the patch creates that already
  /// exists untracked goes to the copy too, so git merges both versions
  /// (add/add conflict) instead of refusing the patch. Only the unmerged
  /// entries of conflicts are copied to the real index.
  @override
  Future<PatchApplyResult> applyPatch(List<int> patch, {bool check = false}) =>
      _withPatchFile(patch, (file) => _withTempIndex(null, (env) async {
            await git.run(['add', '-u'], env: env);
            final created = [
              for (final f in parsePatchStats(await git.run(['apply', '--numstat', '--summary', file])))
                if (f.type == ChangeType.added &&
                    FileSystemEntity.typeSync(p.join(root, f.path), followLinks: false) == FileSystemEntityType.file)
                  f.path,
            ];
            if (created.isNotEmpty) {
              await git.run(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
                  env: env, stdin: _pathspecs(created));
            }
            final args = ['apply', '--3way', '--binary', if (check) '--check', file];
            final r = await git.runRaw(args, env: env, log: !check);
            final output = [r.stdout.trim(), r.stderr.trim()].where((s) => s.isNotEmpty).join('\n');
            if (check) {
              if (r.exitCode != 0) throw GitException(args, r.exitCode, r.stderr, r.stdout);
              return PatchApplyResult(
                  conflicts: [for (final m in _conflictLine.allMatches(output)) m.group(1)!], output: output);
            }
            final entries = (await git.run(['ls-files', '-u', '-z'], env: env))
                .split('\x00')
                .where((e) => e.isNotEmpty)
                .toList();
            if (r.exitCode != 0 && entries.isEmpty) throw GitException(args, r.exitCode, r.stderr, r.stdout);
            final conflicts = {for (final e in entries) e.substring(e.indexOf('\t') + 1)}.toList()..sort();
            if (conflicts.isNotEmpty) {
              // A mode 0 line removes the stage 0 entry before the stages.
              final zero = '0' * entries.first.split(' ')[1].length;
              await git.run(
                ['update-index', '-z', '--index-info'],
                stdin: [for (final c in conflicts) '0 $zero\t$c', ...entries].map((e) => '$e\x00').join(),
                log: true,
              );
            }
            return PatchApplyResult(conflicts: conflicts, output: output);
          }));

  @override
  Future<bool> applyMailbox(List<int> patch) => _withPatchFile(patch, (file) async {
        final args = ['am', '--3way', file];
        final r = await git.runRaw(args, log: true);
        if (r.exitCode == 0) return true;
        if (await repoState() == RepoState.applyingMailbox) return false;
        throw GitException(args, r.exitCode, r.stderr, r.stdout);
      });

  @override
  Future<void> updateRef(String ref, String hash) => git.run(['update-ref', ref, hash]);

  @override
  Future<void> deleteRef(String ref) => git.run(['update-ref', '-d', ref]);

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
  // LFS
  // ---------------------------------------------------------------------------

  /// Result of `git lfs version`, shared by every repository of the process.
  static Future<bool>? _lfsAvailable;

  @override
  Future<bool> lfsAvailable() => _lfsAvailable ??= git
      .runRaw(['lfs', 'version'])
      .then((r) => r.exitCode == 0 && r.stdout.contains('git-lfs'), onError: (Object _) => false);

  @override
  Future<Set<String>> lfsFilteredPaths(List<String> paths) async {
    if (paths.isEmpty) return const {};
    return parseCheckAttrLfs(await git.run(['check-attr', '--stdin', '-z', 'filter'],
        stdin: '${paths.join('\x00')}\x00'));
  }

  /// `--json` needs git-lfs 3.0; older versions only print the list.
  @override
  Future<List<LfsTrackPattern>> lfsTrackPatterns() async {
    final r = await git.runRaw(['lfs', 'track', '--json']);
    if (r.exitCode == 0 && r.stdout.trimLeft().startsWith('{')) return parseLfsTrackJson(r.stdout);
    return parseLfsTrackList(await git.run(['lfs', 'track']));
  }

  @override
  Future<void> lfsTrack(List<String> patterns, {bool literal = false}) async {
    // Without the filters git would commit the content itself.
    if (await config('filter.lfs.clean') == null) {
      await git.run(['lfs', 'install', '--local'], log: true);
    }
    await git.run(['lfs', 'track', if (literal) '--filename', '--', ...patterns], log: true);
  }

  @override
  Future<void> lfsUntrack(List<String> patterns) async {
    await git.run(['lfs', 'untrack', '--', ...patterns], log: true);
    // git-lfs for Windows reads `\` as a path separator, so a pattern with
    // escaped glob characters (`a\[1\].psd`) is left: remove its line here.
    final f = File(p.join(root, '.gitattributes'));
    if (!await f.exists()) return;
    final text = await f.readAsString();
    final eol = text.contains('\r\n') ? '\r\n' : '\n';
    final lines = text.split(eol);
    final kept = lines.where((l) {
      final t = l.trim();
      return !(t.contains('filter=lfs') && patterns.contains(t.split(RegExp(r'\s+')).first));
    }).toList();
    if (kept.length == lines.length) return;
    await f.writeAsString(kept.join(eol));
    git.info('Removed ${lines.length - kept.length} pattern(s) from .gitattributes');
  }

  @override
  Future<List<LfsFile>> lfsFiles() async {
    final r = await git.runRaw(['lfs', 'ls-files', '--json']);
    if (r.exitCode == 0 && r.stdout.trimLeft().startsWith('{')) return parseLfsLsFilesJson(r.stdout);
    return parseLfsLsFiles(await git.run(['lfs', 'ls-files', '--long']));
  }

  /// With `--json` git-lfs prints `[]` even when the server cannot be
  /// reached, so the plain listing first tells whether locking works.
  @override
  Future<List<LfsLock>> lfsLocks() async {
    const args = ['lfs', 'locks'];
    final plain = await git.runRaw(args);
    if (plain.exitCode != 0) throw GitException(args, plain.exitCode, plain.stderr, plain.stdout);
    if (plain.stdout.trim().isEmpty) return const [];
    final verified = await git.runRaw(['lfs', 'locks', '--verify', '--json']);
    if (verified.exitCode == 0) {
      final locks = parseLfsLocksJson(verified.stdout);
      if (locks.isNotEmpty) return locks;
    }
    return parseLfsLocksJson(await git.run(['lfs', 'locks', '--json']));
  }

  @override
  Future<void> lfsLock(String path) => git.run(['lfs', 'lock', '--', path], log: true);

  @override
  Future<void> lfsUnlock(String path, {bool force = false}) =>
      git.run(['lfs', 'unlock', if (force) '--force', '--', path], log: true);

  @override
  Future<void> lfsPull() => git.run(['lfs', 'pull'], log: true);

  @override
  Future<void> lfsFetch() => git.run(['lfs', 'fetch'], log: true);

  @override
  Future<LfsPrunePreview> lfsPruneDryRun() async {
    const args = ['lfs', 'prune', '--dry-run', '--verbose'];
    final r = await git.runRaw(args);
    if (r.exitCode != 0) throw GitException(args, r.exitCode, r.stderr, r.stdout);
    return parseLfsPruneDryRun(r.stdout);
  }

  @override
  Future<void> lfsPrune() => git.run(['lfs', 'prune', '--verbose'], log: true);

  @override
  Future<LfsPointer?> lfsPointerOfFile(String path) async {
    if (!await File(p.join(root, path)).exists()) return null;
    final r = await git.runRaw(['lfs', 'pointer', '--file=$path']);
    return r.exitCode == 0 ? parseLfsPointer(r.stdoutBytes) : null;
  }

  /// Objects are kept in `<lfs.storage or <common dir>/lfs>/objects/ab/cd/abcd…`.
  @override
  Future<List<int>?> lfsObject(LfsPointer pointer) async {
    if (pointer.oid.length < 5) return null;
    final storage = await config('lfs.storage');
    final common = await commonDir();
    final base = storage == null ? p.join(common, 'lfs') : p.normalize(p.join(common, storage));
    final f = File(p.join(base, 'objects', pointer.oid.substring(0, 2), pointer.oid.substring(2, 4), pointer.oid));
    if (!await f.exists() || await f.length() != pointer.size) return null;
    return f.readAsBytes();
  }

  // ---------------------------------------------------------------------------
  // Signing
  // ---------------------------------------------------------------------------

  /// `-S` / `--no-gpg-sign` of `git commit`; nothing for null (config).
  static List<String> _signArgs(bool? sign) => switch (sign) {
        true => const ['-S'],
        false => const ['--no-gpg-sign'],
        null => const [],
      };

  static List<String> _rebaseSignArgs(bool? sign) => switch (sign) {
        true => const ['--gpg-sign'],
        false => const ['--no-gpg-sign'],
        null => const [],
      };

  /// Runs [program] through git's shell (a `!` alias), so it is looked up on
  /// the PATH git itself uses: Git for Windows finds its bundled gpg and ssh
  /// tools there even when they are not on the PATH of this app.
  Future<GitResult> _runTool(String program, List<String> args) => git.runRaw(
        ['-c', 'alias.git-tools-tool=!f() { "\$GIT_TOOLS_PROGRAM" "\$@"; }; f', 'git-tools-tool', ...args],
        env: {'GIT_TOOLS_PROGRAM': program},
      );

  /// Home folder as git sees it (`HOME`, else the Windows profile).
  String get _home =>
      git.environment['HOME'] ?? Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'] ?? '';

  @override
  Future<SigningConfig> signingConfig() async => parseSigningConfig(
      await git.run(['config', '-z', '--get-regexp', signingConfigPattern], allowFailure: true));

  @override
  Future<void> saveSigningSettings(SigningSettings settings, ConfigScope scope) async {
    final where = scope == ConfigScope.global ? '--global' : '--local';
    Future<void> set(String key, String value) => git.run(['config', where, key, value], log: true);
    await set('gpg.format', settings.format.configValue);
    final key = settings.signingKey?.trim() ?? '';
    if (key.isEmpty) {
      // Exit code 5 when the key was not set.
      await git.run(['config', where, '--unset-all', 'user.signingkey'], log: true, allowFailure: true);
    } else {
      await set('user.signingkey', key);
    }
    await set('commit.gpgsign', '${settings.commitSign}');
    await set('tag.gpgsign', '${settings.tagSign}');
  }

  @override
  Future<List<GpgKey>> gpgSecretKeys() async {
    final args = ['--batch', '--list-secret-keys', '--with-colons', '--fixed-list-mode'];
    final r = await _runTool(await config('gpg.program') ?? 'gpg', args);
    if (r.exitCode != 0) throw GitException(['gpg', ...args], r.exitCode, r.stderr, r.stdout);
    return parseGpgSecretKeys(r.stdout);
  }

  @override
  Future<List<SshKey>> sshKeys() async {
    final keys = <SshKey>[];
    final dir = Directory(p.join(_home, '.ssh'));
    if (_home.isNotEmpty && await dir.exists()) {
      final files = [
        await for (final e in dir.list())
          if (e is File && e.path.toLowerCase().endsWith('.pub')) e,
      ]..sort((a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()));
      for (final f in files) {
        try {
          final private = f.path.substring(0, f.path.length - 4);
          final hasPrivate = await File(private).exists();
          keys.addAll(parseSshPublicKeys(await f.readAsString(), path: p.normalize(f.path)).take(1).map((k) => SshKey(
              type: k.type,
              data: k.data,
              comment: k.comment,
              path: k.path,
              privatePath: hasPrivate ? p.normalize(private) : null)));
        } on FileSystemException catch (_) {
          // Unreadable file: skipped.
        }
      }
    }
    // The agent next to the configured ssh-keygen, else the one on git's PATH.
    final keygen = await config('gpg.ssh.program');
    final add = keygen != null && p.isAbsolute(keygen)
        ? p.join(p.dirname(keygen), Platform.isWindows ? 'ssh-add.exe' : 'ssh-add')
        : 'ssh-add';
    final r = await _runTool(add, ['-L']);
    if (r.exitCode == 0) {
      for (final k in parseSshPublicKeys(r.stdout)) {
        if (!keys.any(k.sameKey)) keys.add(k);
      }
    }
    return keys;
  }

  @override
  Future<SigningTestResult> testSigning({SigningFormat? format, String? key}) async {
    final overrides = [
      if (format != null) ...['-c', 'gpg.format=${format.configValue}'],
      if (key != null && key.trim().isNotEmpty) ...['-c', 'user.signingkey=${key.trim()}'],
    ];
    // A repository without commits signs the empty tree (mktree writes it).
    final tree = await refExists('HEAD^{tree}') ? 'HEAD^{tree}' : (await git.run(['mktree'], stdin: '')).trim();
    final r = await git.runRaw(
        [...overrides, 'commit-tree', '-S', tree, '-m', 'git-tools signing test'], log: true);
    if (r.exitCode != 0) {
      final err = r.stderr.trim();
      return SigningTestResult(ok: false, output: err.isEmpty ? 'git commit-tree failed with exit code ${r.exitCode}' : err);
    }
    final sha = r.stdout.trim();
    final v = await git.runRaw([...overrides, 'log', '-1', '--format=$commitSignatureFormat', sha]);
    return SigningTestResult(ok: true, output: sha, verification: parseCommitSignatures(v.stdout)[sha]);
  }

  @override
  Future<Map<String, SignatureInfo>> commitSignatures(List<String> hashes) async {
    if (hashes.isEmpty) return const {};
    final args = ['log', '--no-walk=unsorted', '--format=$commitSignatureFormat', '--stdin'];
    final r = await git.runRaw(args, stdin: '${hashes.join('\n')}\n');
    if (r.exitCode != 0) throw GitException(args, r.exitCode, r.stderr, r.stdout);
    final result = parseCommitSignatures(r.stdout);
    // Without gpg.ssh.allowedSignersFile git reports SSH signed commits as
    // unsigned: they are shown as signed but not verifiable.
    final unsigned = [
      for (final h in hashes)
        if ((result[h]?.status ?? SignatureStatus.none) == SignatureStatus.none) h,
    ];
    if (unsigned.isNotEmpty && r.stderr.contains('allowedSignersFile')) {
      final raw = await git.run(['log', '--no-walk=unsorted', '--pretty=raw', '--stdin'],
          stdin: '${unsigned.join('\n')}\n');
      for (final h in parseSshSignedCommits(raw)) {
        result[h] = const SignatureInfo(status: SignatureStatus.unverified);
      }
    }
    return result;
  }

  @override
  Future<SignatureInfo> tagSignature(String name) async {
    final r = await git.runRaw(['verify-tag', '--raw', 'refs/tags/$name']);
    return parseTagVerification(r.exitCode, '${r.stdout}\n${r.stderr}');
  }

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
