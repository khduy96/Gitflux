import 'package:flutter/widgets.dart';

import 'data/datasources/commit_message_ai.dart';
import 'data/repositories/git_cli_service.dart';
import 'data/repositories/json_file_settings_store.dart';
import 'presentation/app.dart';
import 'presentation/state/app_settings.dart';

/// Composition root: the only place that knows the data layer
/// implementations and hands them to the presentation layer.
Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  final settings = await AppSettings.load(JsonFileSettingsStore.inAppData());
  const git = GitCliService();
  runApp(GitToolsApp(
    settings: settings,
    git: git,
    commitMessageAi: createCommitMessageAi,
    gitVersion: await git.version(),
    initialPath: args.isNotEmpty ? args.first : null,
  ));
}
