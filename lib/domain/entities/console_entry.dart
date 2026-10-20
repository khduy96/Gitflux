/// One line in the Git console (like the "Console" tab of Android Studio).
class ConsoleEntry {
  ConsoleEntry(this.text, this.kind) : time = DateTime.now();

  final String text;
  final ConsoleKind kind;
  final DateTime time;
}

enum ConsoleKind { command, output, error, info }
