import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/data/repositories/git_cli_repository.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/log_query.dart';
import 'package:git_tools/domain/logic/log_filters.dart';
import 'package:git_tools/presentation/state/log_filter.dart';

Commit _c(String name, String email) => Commit(
      hash: '0' * 40,
      parents: const [],
      authorName: name,
      authorEmail: email,
      authorTime: DateTime(2024),
      committerName: name,
      commitTime: DateTime(2024),
      subject: 's',
      refs: const [],
    );

void main() {
  group('authors', () {
    test('distinct by name ignoring case, most commits first', () {
      final list = authorsByCount([
        _c('Bob', 'bob@x'),
        _c('alice', 'alice@home'),
        _c('Alice', 'alice@work'),
        _c('Alice', 'alice@work'),
        _c('Carol', 'carol@x'),
        _c('bob', 'bob@x'),
      ]);
      expect(list.map((a) => (a.name, a.count)), [('alice', 3), ('Bob', 2), ('Carol', 1)]);
      expect(list.first.email, 'alice@work');
    });

    test('an author without a name is listed by email', () {
      expect(authorsByCount([_c('', 'ci@x')]).single.name, 'ci@x');
      expect(authorsByCount(const []), isEmpty);
    });
  });

  group('date presets', () {
    final now = DateTime.utc(2026, 10, 21, 15, 30);

    test('presets are relative to now', () {
      expect(dateRange(const DateFilter(), now), (since: null, until: null));
      expect(dateRange(const DateFilter(DatePreset.last24Hours), now).since, DateTime.utc(2026, 10, 20, 15, 30));
      expect(dateRange(const DateFilter(DatePreset.last7Days), now).since, DateTime.utc(2026, 10, 14, 15, 30));
      expect(dateRange(const DateFilter(DatePreset.last30Days), now), (since: DateTime.utc(2026, 9, 21, 15, 30), until: null));
    });

    test('a custom range covers whole days, either end optional', () {
      final f = DateFilter.custom(from: DateTime(2026, 1, 2, 10), to: DateTime(2026, 1, 5, 8));
      expect(dateRange(f, now), (since: DateTime(2026, 1, 2), until: DateTime(2026, 1, 5, 23, 59, 59)));
      expect(dateRange(DateFilter.custom(to: DateTime(2026, 1, 5)), now).since, isNull);
      expect(const DateFilter.custom().isActive, isFalse);
      expect(dateFilterLabel(DateFilter.custom(from: DateTime(2026, 1, 2))), 'Since 02/01/2026');
    });

    test('--since / --until values', () {
      final since = DateTime(2026, 10, 14, 15, 30);
      final args = GitCliRepository.queryArgs(LogQuery(since: since, until: since.add(const Duration(days: 1))));
      expect(args, [
        '--since=@${since.millisecondsSinceEpoch ~/ 1000}',
        '--until=@${since.millisecondsSinceEpoch ~/ 1000 + 86400}',
      ]);
    });
  });

  group('query arguments', () {
    test('authors are literal, case-insensitive and any may match', () {
      expect(GitCliRepository.queryArgs(const LogQuery(authors: ['J.R. [x]*', 'a+b@c.io'])), [
        '-i',
        '--basic-regexp',
        r'--author=J\.R\. \[x\]\*',
        r'--author=a+b@c\.io',
      ]);
      expect(escapeBasicRegex(r'^a$\'), r'\^a\$\\');
    });

    test('content search uses -S or -G', () {
      expect(GitCliRepository.queryArgs(const LogQuery(changes: 'foo(')), ['-i', '-Sfoo(']);
      expect(GitCliRepository.queryArgs(const LogQuery(changes: 'fo+', changesRegex: true)), ['-i', '-Gfo+']);
      expect(GitCliRepository.queryArgs(const LogQuery()), isEmpty);
    });
  });

  group('log filter', () {
    test('content search needs two characters', () {
      const f = LogFilter(text: 'x', textMode: LogTextMode.changes);
      expect(f.changesText, isNull);
      expect(f.copyWith(text: 'xy').changesText, 'xy');
      expect(f.copyWith(text: 'xy').query(DateTime(2026)).changes, 'xy');
      expect(f.messageText, isEmpty);
    });

    test('only filters run by git reload the log', () {
      const f = LogFilter();
      expect(f.copyWith(text: 'abc').loadsDifferently(f), isFalse);
      expect(f.copyWith(author: () => const AuthorFilter('Me', ['me'])).loadsDifferently(f), isTrue);
      expect(f.copyWith(date: const DateFilter(DatePreset.last7Days)).loadsDifferently(f), isTrue);
      expect(f.copyWith(text: 'abc', textMode: LogTextMode.changes).loadsDifferently(f), isTrue);
      // Toggling regex matters only while searching by content.
      expect(f.copyWith(regex: true).loadsDifferently(f), isFalse);
    });

    test('the graph is hidden while the history is filtered', () {
      const f = LogFilter();
      expect(f.hidesGraph, isFalse);
      expect(f.copyWith(text: 'a').hidesGraph, isTrue);
      expect(f.copyWith(text: 'a').filtersHistory, isFalse);
      expect(f.copyWith(date: const DateFilter(DatePreset.last24Hours)).hidesGraph, isTrue);
      expect(f.copyWith(author: () => const AuthorFilter('x', ['x'])).filtersHistory, isTrue);
    });
  });
}
