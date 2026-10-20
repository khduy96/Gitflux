import 'package:flutter/widgets.dart';

import '../../domain/entities/ai_config.dart';
import '../../domain/repositories/settings_store.dart';

/// Persistent app settings, kept in a [SettingsStore].
class AppSettings extends ChangeNotifier {
  AppSettings._(this._store);

  final SettingsStore _store;
  List<String> recentRepos = [];
  bool sideBySide = true;
  bool collapseUnchanged = true;
  bool ignoreWhitespace = false;
  bool pullRebase = false;
  String? lastCloneDir;

  // AI commit message generation. Nothing is preconfigured: the user picks
  // the provider, key and model.
  AiProvider aiProvider = AiProvider.none;
  String claudeApiKey = '';
  String claudeModel = '';
  String geminiApiKey = '';
  String geminiModel = '';
  String aiLanguage = '';
  String aiInstructions = '';

  String get settingsPath => _store.location;

  String get aiApiKey => switch (aiProvider) {
        AiProvider.claude => claudeApiKey.trim(),
        AiProvider.gemini => geminiApiKey.trim(),
        AiProvider.none => '',
      };

  String get aiModel => switch (aiProvider) {
        AiProvider.claude => claudeModel.trim(),
        AiProvider.gemini => geminiModel.trim(),
        AiProvider.none => '',
      };

  AiConfig get aiConfig => AiConfig(
        provider: aiProvider,
        apiKey: aiApiKey,
        model: aiModel,
        language: aiLanguage,
        instructions: aiInstructions,
      );

  bool get aiConfigured => aiConfig.isComplete;

  static Future<AppSettings> load(SettingsStore store) async {
    final s = AppSettings._(store);
    final j = await store.read();
    try {
      if (j != null) {
        s.recentRepos = (j['recentRepos'] as List? ?? []).cast<String>();
        s.sideBySide = j['sideBySide'] as bool? ?? true;
        s.collapseUnchanged = j['collapseUnchanged'] as bool? ?? true;
        s.ignoreWhitespace = j['ignoreWhitespace'] as bool? ?? false;
        s.pullRebase = j['pullRebase'] as bool? ?? false;
        s.lastCloneDir = j['lastCloneDir'] as String?;
        s.aiProvider = AiProvider.values
                .where((v) => v.name == j['aiProvider'])
                .firstOrNull ??
            AiProvider.none;
        s.claudeApiKey = j['claudeApiKey'] as String? ?? '';
        s.claudeModel = j['claudeModel'] as String? ?? '';
        s.geminiApiKey = j['geminiApiKey'] as String? ?? '';
        s.geminiModel = j['geminiModel'] as String? ?? '';
        s.aiLanguage = j['aiLanguage'] as String? ?? '';
        s.aiInstructions = j['aiInstructions'] as String? ?? '';
      }
    } catch (_) {
      // Corrupt settings are ignored.
    }
    return s;
  }

  Future<void> save() async {
    notifyListeners();
    await _store.write({
      'recentRepos': recentRepos,
      'sideBySide': sideBySide,
      'collapseUnchanged': collapseUnchanged,
      'ignoreWhitespace': ignoreWhitespace,
      'pullRebase': pullRebase,
      'lastCloneDir': lastCloneDir,
      'aiProvider': aiProvider.name,
      'claudeApiKey': claudeApiKey,
      'claudeModel': claudeModel,
      'geminiApiKey': geminiApiKey,
      'geminiModel': geminiModel,
      'aiLanguage': aiLanguage,
      'aiInstructions': aiInstructions,
    });
  }

  Future<void> addRecent(String path) async {
    recentRepos.remove(path);
    recentRepos.insert(0, path);
    if (recentRepos.length > 20) recentRepos = recentRepos.sublist(0, 20);
    await save();
  }

  Future<void> removeRecent(String path) async {
    recentRepos.remove(path);
    await save();
  }
}
