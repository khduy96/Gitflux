import '../entities/git_models.dart';

/// Branches nested into folders split on the `/` of their names
/// (`feature/ui/login` → feature ▸ ui ▸ login).
class BranchFolder {
  const BranchFolder({
    required this.key,
    required this.label,
    required this.prefix,
    required this.folders,
    required this.branches,
  });

  /// Key of the parent folder / [label]: `Local/feature/ui`.
  final String key;
  final String label;

  /// Characters of the branch names shown by this folder and the ones above
  /// (`feature/ui/` → 11).
  final int prefix;
  final List<BranchFolder> folders;
  final List<Branch> branches;

  /// Branches here and in all the sub folders.
  int get count => branches.length + folders.fold(0, (n, f) => n + f.count);

  /// Name of [b] inside this folder: `login` for `feature/ui/login`.
  String leafName(Branch b) => b.name.substring(prefix);

  /// Whether the branch [name] is here or in a sub folder.
  bool contains(String? name) =>
      name != null && (branches.any((b) => b.name == name) || folders.any((f) => f.contains(name)));
}

/// Folder [key] holding [branches], whose first [prefix] characters are
/// already shown by the folders above. Sub folders come first, in the order
/// of their first branch.
BranchFolder buildBranchFolder(String key, String label, Iterable<Branch> branches, {int prefix = 0}) {
  final sub = <String, List<Branch>>{};
  final leaves = <Branch>[];
  for (final b in branches) {
    final i = b.name.indexOf('/', prefix);
    if (i < 0) {
      leaves.add(b);
    } else {
      sub.putIfAbsent(b.name.substring(prefix, i), () => []).add(b);
    }
  }
  return BranchFolder(
    key: key,
    label: label,
    prefix: prefix,
    folders: [
      for (final e in sub.entries)
        buildBranchFolder('$key/${e.key}', e.key, e.value, prefix: prefix + e.key.length + 1),
    ],
    branches: leaves,
  );
}

/// Keys of the folders from [root] down to the branch [name]:
/// `Local`, `Local/feature`, `Local/feature/ui` for `feature/ui/login`.
List<String> branchFolderPath(String root, String name) => [
  root,
  for (var i = name.indexOf('/'); i >= 0; i = name.indexOf('/', i + 1)) '$root/${name.substring(0, i)}',
];

/// One visible line of a folder tree.
class BranchTreeRow {
  const BranchTreeRow.folder(BranchFolder this.folder, {required this.depth, required this.open}) : branch = null;
  const BranchTreeRow.branch(Branch this.branch, {required this.depth, required BranchFolder parent})
    : folder = parent,
      open = false;

  final int depth;

  /// The folder of the line, or the parent folder of the [branch].
  final BranchFolder? folder;
  final Branch? branch;
  final bool open;

  bool get isFolder => branch == null;
  String get label => branch == null ? folder!.label : folder!.leafName(branch!);
}

/// Lines inside [folder], starting at [depth]: sub folders, then branches.
/// Open folders show their content. A non-empty [query] keeps the branches
/// whose name contains it (ignoring case) and opens every folder leading to
/// them.
List<BranchTreeRow> branchTreeRows(
  BranchFolder folder, {
  required bool Function(BranchFolder) isOpen,
  String query = '',
  int depth = 0,
}) {
  final q = query.trim().toLowerCase();
  final rows = <BranchTreeRow>[];
  for (final f in folder.folders) {
    final open = q.isNotEmpty || isOpen(f);
    final inner = open ? branchTreeRows(f, isOpen: isOpen, query: q, depth: depth + 1) : const <BranchTreeRow>[];
    if (q.isNotEmpty && inner.isEmpty) continue;
    rows
      ..add(BranchTreeRow.folder(f, depth: depth, open: open))
      ..addAll(inner);
  }
  for (final b in folder.branches) {
    if (q.isEmpty || b.name.toLowerCase().contains(q)) rows.add(BranchTreeRow.branch(b, depth: depth, parent: folder));
  }
  return rows;
}
