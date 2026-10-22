import 'package:flutter/material.dart';

import '../../../domain/entities/git_models.dart';
import '../../../domain/logic/ref_groups.dart';
import '../common.dart';

/// Refs of a commit row, kept short: the most relevant name (local and
/// remote branches of that name merged, 💻 / ☁ telling which exist) and
/// "+N" for the others. With a [focus] (the branch the Log shows) only
/// that branch. Hovering shows every ref.
class CommitRefs extends StatelessWidget {
  const CommitRefs(this.refs, {super.key, this.focus});

  final List<RefLabel> refs;
  final String? focus;

  @override
  Widget build(BuildContext context) {
    if (refs.isEmpty) return const SizedBox.shrink();
    final groups = groupRefs(refs);
    final focused = focus == null ? null : focusedRefGroup(groups, focus!);
    final shown = focus == null ? groups.first : focused;
    final more = focus == null ? groups.length - 1 : 0;
    if (shown == null) return const SizedBox.shrink();
    return Tooltip(
      waitDuration: const Duration(milliseconds: 300),
      richMessage: WidgetSpan(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Wrap(runSpacing: 4, children: [for (final r in refs) RefChip(r)]),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.only(right: 4),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          RefGroupChip(shown),
          if (more > 0) _MoreChip(more),
        ]),
      ),
    );
  }
}

/// One name of [CommitRefs]: icon, name, then 💻 for a local branch and ☁
/// for remote branches of that name.
class RefGroupChip extends StatelessWidget {
  const RefGroupChip(this.group, {super.key});

  final RefGroup group;

  @override
  Widget build(BuildContext context) {
    final g = group;
    final color = g.isHead
        ? AppColors.headRef
        : g.isTag
            ? AppColors.tagRef
            : g.local
                ? AppColors.localRef
                : AppColors.remoteRef;
    final icon = g.isHead ? Icons.my_location : (g.isTag ? Icons.sell_outlined : Icons.call_split);
    return HoverCopy(
      text: g.refName,
      what: g.isTag ? 'tag name' : 'branch name',
      child: _chip(g, color, icon),
    );
  }

  Widget _chip(RefGroup g, Color color, IconData icon) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        border: Border.all(color: color.withValues(alpha: 0.55)),
        borderRadius: BorderRadius.circular(3),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 11, color: color),
        const SizedBox(width: 3),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 140),
          child: Text(g.name,
              overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: color, height: 1.1)),
        ),
        if (g.local) ...[
          const SizedBox(width: 4),
          Icon(Icons.computer, size: 10, color: color.withValues(alpha: 0.8), semanticLabel: 'local'),
        ],
        if (g.remotes.isNotEmpty) ...[
          const SizedBox(width: 3),
          Icon(Icons.cloud_outlined, size: 10, color: AppColors.remoteRef, semanticLabel: g.remotes.join(', ')),
        ],
      ]),
    );
  }
}

class _MoreChip extends StatelessWidget {
  const _MoreChip(this.count);

  final int count;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(left: 3),
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
        decoration: BoxDecoration(
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(3),
        ),
        child: Text('+$count', style: const TextStyle(fontSize: 11, color: AppColors.textDim, height: 1.1)),
      );
}
