import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/logic/ref_groups.dart';
import 'package:git_tools/presentation/ui/common.dart';
import 'package:git_tools/presentation/ui/log/commit_refs.dart';

const _head = RefLabel('HEAD', RefKind.head);
RefLabel _local(String n) => RefLabel(n, RefKind.localBranch);
RefLabel _remote(String n) => RefLabel(n, RefKind.remoteBranch);
RefLabel _tag(String n) => RefLabel(n, RefKind.tag);

/// Groups as `name[flags]`: H head, L local, remotes, T tag.
List<String> _show(List<RefGroup> groups) => [
      for (final g in groups)
        '${g.name}[${[if (g.isHead) 'H', if (g.local) 'L', ...g.remotes, if (g.isTag) 'T'].join(',')}]',
    ];

void main() {
  group('groupRefs', () {
    test('a local branch and its remote branches make one group; HEAD and the current branch first', () {
      final refs = [
        _local('feature/x'),
        _head,
        _local('main'),
        _remote('origin/main'),
        _remote('upstream/main'),
        _remote('origin/feature/x'),
        _remote('origin/only-remote'),
        _tag('v1.0'),
      ];
      expect(_show(groupRefs(refs)), ['main[H,L,origin,upstream]', 'feature/x[L,origin]', 'only-remote[origin]', 'v1.0[T]']);
    });

    test('a detached HEAD is its own group', () {
      final groups = groupRefs([_head, _remote('origin/main')]);
      expect(_show(groups), ['HEAD[H]', 'main[origin]']);
      expect(groups.first.isDetachedHead, isTrue);
      expect(groups.last.isDetachedHead, isFalse);
    });

    test('remote only, then tags, in the order of git', () {
      expect(_show(groupRefs([_tag('b'), _remote('origin/y'), _tag('a'), _remote('origin/x')])),
          ['y[origin]', 'x[origin]', 'b[T]', 'a[T]']);
      expect(groupRefs([]), isEmpty);
    });
  });

  group('focusedRefGroup', () {
    final groups = groupRefs([_head, _local('main'), _remote('origin/main'), _local('dev'), _tag('v1')]);

    test('a local or a remote branch finds the merged group', () {
      expect(focusedRefGroup(groups, 'main')!.name, 'main');
      expect(focusedRefGroup(groups, 'origin/main')!.name, 'main');
      expect(focusedRefGroup(groups, 'dev')!.name, 'dev');
      expect(focusedRefGroup(groups, 'origin/dev'), isNull);
    });

    test('HEAD and tags', () {
      expect(focusedRefGroup(groups, 'HEAD')!.name, 'main');
      expect(focusedRefGroup(groups, 'refs/tags/v1')!.name, 'v1');
      expect(focusedRefGroup(groups, 'v1'), isNull, reason: 'a branch filter does not match a tag');
    });
  });

  group('CommitRefs', () {
    Future<void> pump(WidgetTester tester, List<RefLabel> refs, {String? focus}) => tester.pumpWidget(MaterialApp(
          theme: buildTheme(),
          home: Scaffold(body: Row(children: [CommitRefs(refs, focus: focus), const Expanded(child: Text('subject'))])),
        ));

    final refs = [_head, _local('main'), _remote('origin/main'), _local('dev'), _remote('origin/dev'), _tag('v1')];

    testWidgets('one name, local and remote icons, +N for the others', (tester) async {
      await pump(tester, refs);
      expect(find.byType(RefGroupChip), findsOneWidget);
      expect(find.text('main'), findsOneWidget);
      expect(find.byIcon(Icons.computer), findsOneWidget);
      expect(find.byIcon(Icons.cloud_outlined), findsOneWidget);
      expect(find.text('+2'), findsOneWidget);
      expect(find.text('dev'), findsNothing);
      expect(find.byType(RefChip), findsNothing, reason: 'the full chips only on hover');
    });

    testWidgets('hover shows every ref like before', (tester) async {
      await pump(tester, refs);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(tester.getCenter(find.byType(RefGroupChip)));
      await tester.pumpAndSettle(const Duration(seconds: 1));
      expect(find.byType(RefChip), findsNWidgets(refs.length));
      expect(find.text('origin/dev'), findsOneWidget);
    });

    testWidgets('a focused branch shows only itself', (tester) async {
      await pump(tester, refs, focus: 'origin/dev');
      expect(find.text('dev'), findsOneWidget);
      expect(find.text('main'), findsNothing);
      expect(find.textContaining('+'), findsNothing);

      await pump(tester, refs, focus: 'feature/elsewhere');
      expect(find.byType(RefGroupChip), findsNothing);
    });

    testWidgets('a remote only branch has the cloud and no computer', (tester) async {
      await pump(tester, [_remote('origin/feature/x')]);
      expect(find.text('feature/x'), findsOneWidget);
      expect(find.byIcon(Icons.cloud_outlined), findsOneWidget);
      expect(find.byIcon(Icons.computer), findsNothing);
      expect(find.textContaining('+'), findsNothing);
    });

    testWidgets('many refs do not push the subject out of a narrow row', (tester) async {
      tester.view.physicalSize = const Size(320, 200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await pump(tester, [
        _head,
        for (final n in ['main', 'develop', 'feature/a-very-long-branch-name', 'release/2026.10', 'hotfix/x']) ...[
          _local(n),
          _remote('origin/$n'),
        ],
        _tag('v1.0.0'),
      ]);
      expect(tester.takeException(), isNull);
      expect(find.text('+5'), findsOneWidget); // 5 branches + 1 tag, minus the one shown
      expect(tester.getSize(find.text('subject')).width, greaterThan(100));
    });
  });
}
