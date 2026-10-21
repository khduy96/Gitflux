import 'package:flutter/material.dart';

import '../../../domain/entities/bisect.dart';
import '../../state/repo_controller.dart';
import '../common.dart';
import '../dialogs/bisect_dialogs.dart';

/// Bisect session in progress, under the merge / rebase banner of the Commit
/// panel: what is left to test, Good / Bad / Skip for the checked-out commit,
/// the result once git found it, and Reset. Nothing without a session.
class BisectBanner extends StatelessWidget {
  const BisectBanner({super.key, required this.controller});

  final RepoController controller;

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<BisectState?>(
        valueListenable: controller.bisect,
        builder: (context, state, _) => state == null
            ? const SizedBox.shrink()
            // Buttons are disabled while an operation (e.g. a mark) runs.
            : ValueListenableBuilder<String?>(
                valueListenable: controller.busy,
                builder: (context, busy, _) => _build(context, state, enabled: busy == null),
              ),
      );

  Widget _build(BuildContext context, BisectState state, {required bool enabled}) {
    VoidCallback? on(VoidCallback f) => enabled ? f : null;
    void mark(BisectMark m) => controller.bisectMark(m);

    final reset = _BannerButton(
      'Reset',
      on(controller.bisectReset),
      tooltip: 'Reset (back to ${RepoController.shortRef(state.startRef)})',
    );
    final String title;
    String? detail;
    List<Widget> buttons;

    if (state.finished) {
      final bad = state.firstBad!;
      title = '${RepoController.shortRef(bad)} is the first bad commit';
      detail = state.log.firstBadSubject;
      buttons = [_BannerButton('Show in Log', () => controller.showInLog(bad)), reset];
    } else if (state.log.candidates.isNotEmpty) {
      final candidates = state.log.candidates;
      title = 'Only skipped commits left: the first bad commit is one of '
          '${candidates.map(RepoController.shortRef).join(', ')}';
      buttons = [_BannerButton('Show in Log', () => controller.showInLog(candidates.first)), reset];
    } else if (state.checkoutPending) {
      title = 'Bisecting: the commit to test (${RepoController.shortRef(state.expectedHash!)}) is not checked out';
      detail = 'Local changes may be in the way: commit, stash or shelve them, then Retry Checkout.';
      buttons = [
        _BannerButton('Retry Checkout', on(() => controller.run('Bisect checkout',
            () => controller.repo.checkout(state.expectedHash!)))),
        reset,
      ];
    } else if (!state.hasGood || !state.hasBad) {
      title = 'Bisecting: ${state.hasBad ? 'mark a good commit' : state.hasGood ? 'mark a bad commit' : 'mark good and bad commits'}';
      detail = 'Use Bisect in the Log context menu';
      buttons = [reset];
    } else {
      final left = state.revisionsLeft, steps = state.steps;
      title = left == null
          ? 'Bisecting'
          : 'Bisecting: ~$left revision${left == 1 ? '' : 's'} left'
              '${steps == null ? '' : ' (~$steps step${steps == 1 ? '' : 's'})'}';
      detail = state.currentHash == null ? null : '${state.currentShort} ${state.currentSubject ?? ''}'.trim();
      buttons = [
        _BannerButton('Good', on(() => mark(BisectMark.good)), tooltip: 'Mark the current commit good'),
        _BannerButton('Bad', on(() => mark(BisectMark.bad)), tooltip: 'Mark the current commit bad'),
        _BannerButton('Skip', on(() => mark(BisectMark.skip)), tooltip: 'Skip the current commit (cannot be tested)'),
        _BannerButton('Run Script…', on(() => showBisectRunDialog(context, controller))),
        reset,
      ];
    }

    return Container(
      margin: const EdgeInsets.fromLTRB(8, 0, 8, 6),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppColors.accent.withValues(alpha: 0.12),
        border: Border.all(color: AppColors.accent.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(state.finished ? Icons.flag_outlined : Icons.info_outline, size: 15, color: AppColors.accent),
            const SizedBox(width: 6),
            Expanded(child: Text(title, style: const TextStyle(fontSize: 12.5))),
          ]),
          if (detail != null && detail.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(detail, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.textDim)),
          ],
          const SizedBox(height: 6),
          Wrap(spacing: 6, runSpacing: 4, children: buttons),
        ],
      ),
    );
  }
}

class _BannerButton extends StatelessWidget {
  const _BannerButton(this.label, this.onTap, {this.tooltip});

  final String label;
  final VoidCallback? onTap;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final button = SizedBox(
      height: 26,
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 26),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          textStyle: const TextStyle(fontSize: 12),
        ),
        onPressed: onTap,
        child: Text(label),
      ),
    );
    return tooltip == null ? button : Tooltip(message: tooltip, child: button);
  }
}
