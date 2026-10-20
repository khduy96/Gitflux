/// Persistent storage for the app settings.
abstract interface class SettingsStore {
  /// Where the settings are kept, shown to the user.
  String get location;

  /// The saved values, or null when nothing is saved or the data is unreadable.
  Future<Map<String, dynamic>?> read();

  Future<void> write(Map<String, dynamic> values);
}
