import 'package:flutter/material.dart';

import '../../../domain/entities/signing.dart';
import '../common.dart';

Color signatureColor(SignatureLevel level) => switch (level) {
      SignatureLevel.verified => AppColors.success,
      SignatureLevel.warning => AppColors.warning,
      SignatureLevel.invalid => AppColors.error,
      SignatureLevel.unknown => AppColors.textDim,
      SignatureLevel.none => AppColors.textMuted,
    };

/// ✓ green (good), ✓ yellow (untrusted / expired) or ✗ red (bad, revoked,
/// cannot check), a grey shield (SSH signature without allowed signers file)
/// for a signed commit or tag; nothing when unsigned or not verified yet.
class SignatureBadge extends StatelessWidget {
  const SignatureBadge(this.signature, {super.key, this.size = 14});

  final SignatureInfo? signature;
  final double size;

  @override
  Widget build(BuildContext context) {
    final s = signature;
    if (s == null || !s.isSigned) return SizedBox(width: size);
    final level = s.status.level;
    return Tooltip(
      message: s.description,
      child: Icon(
        switch (level) {
          SignatureLevel.invalid => Icons.gpp_bad_outlined,
          SignatureLevel.unknown => Icons.shield_outlined,
          _ => Icons.verified_user_outlined,
        },
        size: size,
        color: signatureColor(level),
      ),
    );
  }
}
