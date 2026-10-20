import 'package:flutter/widgets.dart';

import '../domain/repositories/commit_message_generator.dart';
import '../domain/repositories/git_service.dart';

/// Services created by the composition root (main.dart) for the widgets.
class AppScope extends InheritedWidget {
  const AppScope({
    super.key,
    required this.git,
    required this.commitMessageAi,
    required super.child,
  });

  final GitService git;
  final CommitMessageGeneratorFactory commitMessageAi;

  static AppScope of(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'No AppScope above this context');
    return scope!;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) =>
      git != oldWidget.git || commitMessageAi != oldWidget.commitMessageAi;
}
