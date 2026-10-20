import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import '../../domain/repositories/settings_store.dart';

/// [SettingsStore] writing a JSON file.
class JsonFileSettingsStore implements SettingsStore {
  JsonFileSettingsStore(this._file);

  /// `git_tools/settings.json` in the user's app data folder.
  factory JsonFileSettingsStore.inAppData() {
    final base = Platform.environment['APPDATA'] ??
        Platform.environment['XDG_CONFIG_HOME'] ??
        p.join(Platform.environment['HOME'] ?? '.', '.config');
    return JsonFileSettingsStore(File(p.join(base, 'git_tools', 'settings.json')));
  }

  final File _file;

  @override
  String get location => _file.path;

  @override
  Future<Map<String, dynamic>?> read() async {
    try {
      if (!await _file.exists()) return null;
      return jsonDecode(await _file.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      // Corrupt settings are ignored.
      return null;
    }
  }

  @override
  Future<void> write(Map<String, dynamic> values) async {
    try {
      await _file.parent.create(recursive: true);
      await _file.writeAsString(const JsonEncoder.withIndent('  ').convert(values));
    } catch (_) {}
  }
}
