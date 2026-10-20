import '../entities/ai_config.dart';
import '../entities/commit_message_request.dart';

/// Writes commit messages with an AI model.
abstract interface class CommitMessageGenerator {
  /// Streams the message; [onText] receives the full text generated so far.
  Future<String> generate(
    CommitMessageRequest req, {
    required void Function(String text) onText,
  });

  /// Sends a tiny request to check the key and model.
  Future<void> testConnection();

  void cancel();
}

/// Creates the generator of [provider].
typedef CommitMessageGeneratorFactory = CommitMessageGenerator Function(
  AiProvider provider, {
  required String apiKey,
  required String model,
});
