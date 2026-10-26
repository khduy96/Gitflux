import '../entities/git_models.dart';

/// Branches to check out before deleting the current branch [deleting]
/// ("Checkout Another Branch and Delete"): every branch except [deleting]
/// itself and the remote branches named like it, whose checkout would land
/// back on [deleting]. Branches checked out in another worktree stay listed.
List<Branch> checkoutTargets(String deleting, List<Branch> branches) => [
      for (final b in branches)
        if (b.shortName != deleting) b,
    ];

/// Preselected checkout target when deleting [deleting]: local `main`, else
/// local `master`, never [deleting] itself nor a remote branch; null when
/// there is none.
String? defaultCheckoutTarget(String deleting, List<Branch> branches) {
  for (final name in const ['main', 'master']) {
    if (name != deleting && branches.any((b) => !b.isRemote && b.name == name)) return name;
  }
  return null;
}

/// Start points of the new branch ("Create New Branch and Delete"): every
/// local and remote branch, the one being deleted included.
List<Branch> startPoints(List<Branch> branches) => [...branches];

/// Preselected start point: local `main`, else local `master` (even when it is
/// the branch being deleted); null when there is none.
String? defaultStartPoint(List<Branch> branches) {
  for (final name in const ['main', 'master']) {
    if (branches.any((b) => !b.isRemote && b.name == name)) return name;
  }
  return null;
}
