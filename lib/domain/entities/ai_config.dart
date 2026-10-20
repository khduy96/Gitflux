/// AI service used to generate commit messages.
enum AiProvider { none, claude, gemini }

/// What the user configured for AI commit messages.
class AiConfig {
  const AiConfig({
    required this.provider,
    required this.apiKey,
    required this.model,
    this.language = '',
    this.instructions = '',
  });

  final AiProvider provider;
  final String apiKey;
  final String model;

  /// Language for the message; empty lets the model follow the history.
  final String language;
  final String instructions;

  bool get isComplete =>
      provider != AiProvider.none && apiKey.isNotEmpty && model.isNotEmpty;
}
