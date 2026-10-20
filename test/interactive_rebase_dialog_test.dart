import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/entities/rebase.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/dialogs/interactive_rebase_dialog.dart';

RebaseCommitEntry _c(String id) => RebaseCommitEntry(
      commit: Commit(
        hash: id.padRight(40, '0'),
        parents: const [],
        authorName: 'T',
        authorEmail: 't@t',
        authorTime: DateTime(2024),
        committerName: 'T',
        commitTime: DateTime(2024),
        subject: 'subject $id',
        refs: const [],
      ),
      message: 'subject $id\n\nbody $id',
    );

final _plan = RebasePlan(
  target: 'a'.padRight(40, '0'),
  base: '${'a'.padRight(40, '0')}^',
  head: 'c'.padRight(40, '0'),
  branch: 'main',
  entries: [_c('a'), _c('b'), _c('c')],
);

/// Opens the dialog; [onResult] receives what it returns.
Future<void> _open(WidgetTester tester, {void Function(List<RebaseEntry>?)? onResult}) async {
  tester.view.physicalSize = const Size(1400, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(),
    home: Builder(
      builder: (context) => TextButton(
        onPressed: () async {
          final r = await showInteractiveRebaseDialog(context, _plan);
          onResult?.call(r);
        },
        child: const Text('open'),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

Future<void> _altKey(WidgetTester tester, LogicalKeyboardKey key) async {
  await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
  await tester.sendKeyEvent(key);
  await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('squash shows the combined message in the editor', (tester) async {
    await _open(tester);
    expect(find.text('Rebasing 3 commits of main'), findsOneWidget);
    // The newest commit is selected: squash it into b.
    await tester.sendKeyEvent(LogicalKeyboardKey.keyS);
    await tester.pumpAndSettle();
    expect(find.text('Message of 2 combined commits'), findsOneWidget);
    final editor = tester.widget<TextField>(find.byType(TextField));
    expect(editor.controller!.text, 'subject b\n\nbody b\n\nsubject c\n\nbody c');

    // Moving it below b makes it the first commit of the run: invalid.
    await tester.tap(find.text('subject c'));
    await _altKey(tester, LogicalKeyboardKey.arrowDown);
    await _altKey(tester, LogicalKeyboardKey.arrowDown);
    expect(find.textContaining('no previous commit to meld into'), findsOneWidget);
  });

  testWidgets('invalid todo disables Start and Reset restores it', (tester) async {
    await _open(tester);
    await tester.tap(find.text('subject a'));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
    await tester.pumpAndSettle();
    expect(find.textContaining('no previous commit to meld into'), findsOneWidget);
    final start = find.widgetWithText(FilledButton, 'Start Rebasing');
    expect(tester.widget<FilledButton>(start).onPressed, isNull);

    await tester.tap(find.text('Reset'));
    await tester.pumpAndSettle();
    expect(find.textContaining('no previous commit to meld into'), findsNothing);
    expect(tester.widget<FilledButton>(start).onPressed, isNotNull);
  });

  testWidgets('returns the edited todo', (tester) async {
    List<RebaseEntry>? result;
    await _open(tester, onResult: (r) => result = r);
    // c is selected: move it below a (oldest), then drop b and reword a.
    await _altKey(tester, LogicalKeyboardKey.arrowDown);
    await _altKey(tester, LogicalKeyboardKey.arrowDown);
    await tester.tap(find.text('subject b'));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.keyD);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
    await tester.pumpAndSettle();
    expect(find.text('New message of a0000000'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'a reworded');
    await tester.tap(find.text('Start Rebasing'));
    await tester.pumpAndSettle();

    final commits = result!.cast<RebaseCommitEntry>();
    expect(commits.map((e) => e.subject), ['subject c', 'subject a', 'subject b']);
    expect(commits.map((e) => e.action), [RebaseAction.pick, RebaseAction.reword, RebaseAction.drop]);
    expect(commits[1].newMessage, 'a reworded');
  });

  testWidgets('drag and drop reorders only within a run', (tester) async {
    List<RebaseEntry>? result;
    final plan = RebasePlan(
      target: 'x'.padRight(40, '0'),
      base: null,
      head: 'c'.padRight(40, '0'),
      branch: 'main',
      entries: [_c('a'), const RebaseStructuralEntry('label side'), _c('b'), _c('c')],
    );
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(),
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () async => result = await showInteractiveRebaseDialog(context, plan),
          child: const Text('open'),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('label side'), findsOneWidget);

    // Rows: c, b, label side, a. Drag c below b.
    Future<void> drag(int handle, double dy) async {
      final g = await tester.startGesture(tester.getCenter(find.byIcon(Icons.drag_indicator).at(handle)));
      await tester.pump(const Duration(milliseconds: 50));
      for (var i = 0; i < 10; i++) {
        await g.moveBy(Offset(0, dy / 10));
        await tester.pump(const Duration(milliseconds: 16));
      }
      await g.up();
      await tester.pumpAndSettle();
    }

    await drag(0, 30);
    // Then try to drag a above the label line: refused.
    await drag(2, -60);
    expect(find.textContaining('cannot be moved across'), findsOneWidget);
    await tester.tap(find.text('Start Rebasing'));
    await tester.pumpAndSettle();
    expect(result!.map((e) => e is RebaseCommitEntry ? e.subject : (e as RebaseStructuralEntry).line),
        ['subject a', 'label side', 'subject c', 'subject b']);
  });
}
