import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/logic/branch_folders.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/log/branch_picker.dart';

Branch _b(String name, {bool remote = false}) => Branch(name: name, isRemote: remote, hash: '0' * 40);

final _branches = [
  _b('bugfix/crash'),
  _b('feature/cart'),
  _b('feature/ui/login'),
  _b('main'),
  _b('origin/HEAD', remote: true),
  _b('origin/feature/cart', remote: true),
  _b('origin/main', remote: true),
];

/// Lines as `depth label`, folders marked with ▸ / ▾.
List<String> _show(List<BranchTreeRow> rows) => [
      for (final r in rows) '${'  ' * r.depth}${r.isFolder ? (r.open ? '▾ ' : '▸ ') : ''}${r.label}',
    ];

void main() {
  group('branch folders', () {
    final local = buildBranchFolder('Local', 'Local', _branches.where((b) => !b.isRemote));

    test('splits names on /, folders first, counts all branches inside', () {
      expect(local.count, 4);
      expect(local.folders.map((f) => f.key), ['Local/bugfix', 'Local/feature']);
      expect(local.branches.map((b) => b.name), ['main']);
      final feature = local.folders[1];
      expect(feature.count, 2);
      expect(feature.folders.single.key, 'Local/feature/ui');
      expect(feature.folders.single.leafName(feature.folders.single.branches.single), 'login');
      expect(feature.contains('feature/ui/login'), isTrue);
      expect(feature.contains('bugfix/crash'), isFalse);
      expect(feature.contains(null), isFalse);
    });

    test('rows show the content of the open folders only', () {
      expect(_show(branchTreeRows(local, isOpen: (_) => false)), ['▸ bugfix', '▸ feature', 'main']);
      expect(_show(branchTreeRows(local, isOpen: (f) => f.key == 'Local/feature', depth: 1)), [
        '  ▸ bugfix',
        '  ▾ feature',
        '    ▸ ui',
        '    cart',
        '  main',
      ]);
    });

    test('a query keeps the matching branches and opens their folders', () {
      expect(_show(branchTreeRows(local, isOpen: (_) => false, query: ' LOG ')), ['▾ feature', '  ▾ ui', '    login']);
      expect(branchTreeRows(local, isOpen: (_) => true, query: 'nothing'), isEmpty);
    });

    test('remote names are folders below the remote', () {
      final remote = buildBranchFolder('Remote', 'Remote', _branches.where((b) => b.isRemote));
      expect(_show(branchTreeRows(remote, isOpen: (_) => true)), ['▾ origin', '  ▾ feature', '    cart', '  HEAD', '  main']);
      final origin = buildBranchFolder('remote:origin', 'origin', _branches.where((b) => b.isRemote), prefix: 7);
      expect(_show(branchTreeRows(origin, isOpen: (_) => false)), ['▸ feature', 'HEAD', 'main']);
    });

    test('path of folders down to a branch', () {
      expect(branchFolderPath('Local', 'feature/ui/login'), ['Local', 'Local/feature', 'Local/feature/ui']);
      expect(branchFolderPath('Remote', 'origin/main'), ['Remote', 'Remote/origin']);
      expect(branchFolderPath('Local', 'main'), ['Local']);
    });
  });

  group('branch picker', () {
    String? picked;
    var closed = false;

    /// Opens the picker; [checkedOut] is the current branch of the repository.
    Future<void> show(WidgetTester tester, {String? current, String? checkedOut}) async {
      picked = null;
      closed = false;
      final branches = [
        for (final b in _branches)
          Branch(name: b.name, isRemote: b.isRemote, hash: b.hash, isCurrent: b.name == checkedOut),
      ];
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                picked = await showBranchPicker(context,
                    anchor: const Rect.fromLTWH(10, 10, 100, 24), branches: branches, current: current);
                closed = true;
              },
              child: const Text('Branch'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Branch'));
      await tester.pumpAndSettle();
    }

    Finder rows() => find.descendant(of: find.byType(BranchPicker), matching: find.byType(HoverRow));

    String label(HoverRow row) => (((row.child as Row).children[4] as Expanded).child as Text).data!;

    /// Labels of the picker lines, top to bottom.
    List<String> lines(WidgetTester tester) => [for (final row in tester.widgetList<HoverRow>(rows())) label(row)];

    /// Label of the highlighted line.
    String active(WidgetTester tester) => label(tester.widgetList<HoverRow>(rows()).singleWhere((r) => r.selected));

    Finder line(String label) => find.descendant(of: rows(), matching: find.text(label));

    Future<void> key(WidgetTester tester, LogicalKeyboardKey k) async {
      await tester.sendKeyEvent(k);
      await tester.pumpAndSettle();
    }

    testWidgets('opens down to the checked out branch only and selects it', (tester) async {
      await show(tester, checkedOut: 'feature/ui/login');
      expect(lines(tester), ['All', 'HEAD', 'Local', 'bugfix', 'feature', 'ui', 'login', 'cart', 'main', 'Remote']);
      expect(active(tester), 'login');
      await key(tester, LogicalKeyboardKey.enter);
      expect(picked, 'feature/ui/login');
    });

    testWidgets('the branch shown in the Log comes before the checked out one', (tester) async {
      await show(tester, current: 'origin/feature/cart', checkedOut: 'main');
      expect(lines(tester), ['All', 'HEAD', 'Local', 'Remote', 'origin', 'feature', 'cart', 'HEAD', 'main']);
      expect(active(tester), 'cart');
    });

    testWidgets('no branch checked out: everything closed, All selected', (tester) async {
      await show(tester);
      expect(lines(tester), ['All', 'HEAD', 'Local', 'Remote']);
      expect(active(tester), 'All');
    });

    testWidgets('folders open and close by hand, forgotten when reopened', (tester) async {
      await show(tester, checkedOut: 'main');
      const initial = ['All', 'HEAD', 'Local', 'bugfix', 'feature', 'main', 'Remote'];
      expect(lines(tester), initial);

      await tester.tap(line('feature'));
      await tester.pumpAndSettle();
      expect(lines(tester), ['All', 'HEAD', 'Local', 'bugfix', 'feature', 'ui', 'cart', 'main', 'Remote']);
      await tester.tap(line('Local'));
      await tester.pumpAndSettle();
      await tester.tap(line('Remote'));
      await tester.pumpAndSettle();
      expect(lines(tester), ['All', 'HEAD', 'Local', 'Remote', 'origin']);

      await key(tester, LogicalKeyboardKey.escape);
      await tester.tap(find.text('Branch'));
      await tester.pumpAndSettle();
      expect(lines(tester), initial);
      expect(active(tester), 'main');
    });

    testWidgets('a click on a branch picks it, All picks ""', (tester) async {
      await show(tester);
      await tester.tap(line('Remote'));
      await tester.pumpAndSettle();
      await tester.tap(line('origin'));
      await tester.pumpAndSettle();
      await tester.tap(line('main'));
      await tester.pumpAndSettle();
      expect(closed, isTrue);
      expect(picked, 'origin/main');
      expect(find.byType(BranchPicker), findsNothing);

      await tester.tap(find.text('Branch'));
      await tester.pumpAndSettle();
      await tester.tap(line('All'));
      await tester.pumpAndSettle();
      expect(picked, '');
    });

    testWidgets('search, then keys', (tester) async {
      await show(tester);
      await tester.enterText(find.byType(TextField), 'cart');
      await tester.pumpAndSettle();
      expect(lines(tester), ['Local', 'feature', 'cart', 'Remote', 'origin', 'feature', 'cart']);
      expect(active(tester), 'cart');
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.enter);
      expect(picked, 'origin/feature/cart');

      await tester.tap(find.text('Branch'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'zzz');
      await tester.pumpAndSettle();
      expect(find.text('No branches'), findsOneWidget);
    });

    testWidgets('← / → close and open the folder, Esc dismisses', (tester) async {
      await show(tester);
      await key(tester, LogicalKeyboardKey.arrowDown); // HEAD
      await key(tester, LogicalKeyboardKey.arrowDown); // Local
      await key(tester, LogicalKeyboardKey.arrowRight);
      expect(lines(tester), ['All', 'HEAD', 'Local', 'bugfix', 'feature', 'main', 'Remote']);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(lines(tester), ['All', 'HEAD', 'Local', 'Remote']);
      await key(tester, LogicalKeyboardKey.escape);
      expect(find.byType(BranchPicker), findsNothing);
      expect(closed, isTrue);
      expect(picked, isNull);
    });
  });
}
