import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/log/commit_refs.dart';

void main() {
  late List<String> copied;

  setUp(() {
    copied = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform,
        (call) async {
      if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
      return null;
    });
  });

  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(SystemChannels.platform, null));

  Future<void> pump(WidgetTester tester, Widget child) => tester.pumpWidget(MaterialApp(
        theme: buildTheme(),
        home: Scaffold(body: Center(child: child)),
      ));

  Future<TestGesture> hover(WidgetTester tester, Finder f) async {
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(f));
    await tester.pump();
    return mouse;
  }

  Future<void> press(WidgetTester tester, LogicalKeyboardKey modifier) async {
    await tester.sendKeyDownEvent(modifier);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
    await tester.sendKeyUpEvent(modifier);
    await tester.pump();
  }

  testWidgets('Ctrl+C copies the hovered name, and only while hovered', (tester) async {
    await pump(tester, const Column(mainAxisSize: MainAxisSize.min, children: [
      HoverCopy(text: 'feature/login', child: Text('login')),
      SizedBox(height: 40),
      Text('elsewhere'),
    ]));
    await press(tester, LogicalKeyboardKey.controlLeft);
    expect(copied, isEmpty, reason: 'nothing hovered');

    final mouse = await hover(tester, find.text('login'));
    await press(tester, LogicalKeyboardKey.controlLeft);
    expect(copied, ['feature/login']);
    expect(find.text('Copied branch name: feature/login'), findsOneWidget);

    await mouse.moveTo(tester.getCenter(find.text('elsewhere')));
    await tester.pump();
    await press(tester, LogicalKeyboardKey.controlLeft);
    expect(copied, ['feature/login']);
  });

  testWidgets('the innermost region wins; no text, nothing copied', (tester) async {
    await pump(tester, const HoverCopy(
      text: 'outer',
      child: Padding(
        padding: EdgeInsets.all(30),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          HoverCopy(text: 'inner', child: Text('in')),
          SizedBox(width: 30),
          HoverCopy(text: null, child: Text('detached')),
        ]),
      ),
    ));
    final mouse = await hover(tester, find.text('in'));
    await press(tester, LogicalKeyboardKey.controlLeft);
    expect(copied, ['inner']);
    await mouse.moveTo(tester.getCenter(find.text('detached')));
    await tester.pump();
    await press(tester, LogicalKeyboardKey.controlLeft);
    expect(copied, ['inner'], reason: 'a null text does not fall back to the outer region');
  });

  testWidgets('a selection in a focused text field keeps its Ctrl+C', (tester) async {
    final field = TextEditingController(text: 'typed');
    addTearDown(field.dispose);
    await pump(tester, Column(mainAxisSize: MainAxisSize.min, children: [
      SizedBox(width: 200, child: TextField(controller: field, autofocus: true)),
      const HoverCopy(text: 'main', child: Text('main')),
    ]));
    await tester.pump();
    field.selection = const TextSelection(baseOffset: 0, extentOffset: 5);
    await hover(tester, find.text('main'));
    await press(tester, LogicalKeyboardKey.controlLeft);
    expect(copied, ['typed'], reason: 'the field copies its selection');

    field.selection = const TextSelection.collapsed(offset: 5);
    await tester.pump();
    await press(tester, LogicalKeyboardKey.controlLeft);
    expect(copied, ['typed', 'main'], reason: 'a caret alone does not block it');
    // Desktop: the touch selection handles of the default (Android) test platform would cover the mouse.
  }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

  testWidgets('macOS: ⌘C copies, Ctrl+C does not', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    try {
      await pump(tester, const HoverCopy(text: 'main', child: Text('main')));
      await hover(tester, find.text('main'));
      await press(tester, LogicalKeyboardKey.controlLeft);
      expect(copied, isEmpty);
      await press(tester, LogicalKeyboardKey.metaLeft);
      expect(copied, ['main']);
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  });

  testWidgets('commit refs: the chip copies the local name, a remote only one its remote name, a tag its name',
      (tester) async {
    await pump(tester, const Column(mainAxisSize: MainAxisSize.min, children: [
      CommitRefs([RefLabel('HEAD', RefKind.head), RefLabel('main', RefKind.localBranch), RefLabel('origin/main', RefKind.remoteBranch)]),
      SizedBox(height: 20),
      CommitRefs([RefLabel('origin/feature/x', RefKind.remoteBranch)]),
      SizedBox(height: 20),
      CommitRefs([RefLabel('v1.0', RefKind.tag)]),
    ]));
    final mouse = await hover(tester, find.text('main'));
    await press(tester, LogicalKeyboardKey.controlLeft);
    for (final label in ['feature/x', 'v1.0']) {
      await mouse.moveTo(tester.getCenter(find.text(label)));
      await tester.pump();
      await press(tester, LogicalKeyboardKey.controlLeft);
    }
    expect(copied, ['main', 'origin/feature/x', 'v1.0']);
    expect(find.text('Copied branch name: main'), findsOneWidget, reason: 'the next messages wait in the queue');
    await tester.pumpAndSettle(const Duration(seconds: 3));
  });
}
