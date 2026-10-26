import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/git_models.dart';
import 'package:git_tools/domain/logic/leave_branch.dart';

Branch _local(String n, {String? worktree}) => Branch(name: n, isRemote: false, hash: 'h', worktree: worktree);
Branch _remote(String n) => Branch(name: n, isRemote: true, hash: 'h');

List<String> _names(List<Branch> bs) => [for (final b in bs) b.name];

void main() {
  group('checkoutTargets', () {
    test('drops the branch being deleted and its remote branches, keeps the rest', () {
      final all = [
        _local('main'),
        _local('feature/x'),
        _local('other', worktree: '/wt/other'),
        _remote('origin/main'),
        _remote('origin/feature/x'),
        _remote('fork/feature/x'),
        _remote('origin/other'),
      ];
      expect(_names(checkoutTargets('feature/x', all)),
          ['main', 'other', 'origin/main', 'origin/other']);
    });
  });

  group('defaultCheckoutTarget', () {
    test('main, else master, else null', () {
      expect(defaultCheckoutTarget('x', [_local('x'), _local('master'), _local('main')]), 'main');
      expect(defaultCheckoutTarget('x', [_local('x'), _local('master')]), 'master');
      expect(defaultCheckoutTarget('x', [_local('x'), _local('develop')]), isNull);
    });

    test('never the branch being deleted', () {
      expect(defaultCheckoutTarget('main', [_local('main'), _local('master')]), 'master');
      expect(defaultCheckoutTarget('main', [_local('main')]), isNull);
      expect(defaultCheckoutTarget('master', [_local('master')]), isNull);
    });

    test('never a remote branch', () {
      expect(defaultCheckoutTarget('x', [_local('x'), _remote('origin/main'), _remote('origin/master')]), isNull);
      expect(defaultCheckoutTarget('main', [_local('main'), _remote('origin/master')]), isNull);
    });
  });

  group('startPoints', () {
    test('every local and remote branch, the one being deleted included', () {
      final all = [_local('main'), _local('feature/x'), _remote('origin/main'), _remote('origin/feature/x')];
      expect(_names(startPoints(all)), ['main', 'feature/x', 'origin/main', 'origin/feature/x']);
    });
  });

  group('defaultStartPoint', () {
    test('main, else master, else null; local only', () {
      expect(defaultStartPoint([_local('master'), _local('main')]), 'main');
      expect(defaultStartPoint([_local('x'), _local('master')]), 'master');
      expect(defaultStartPoint([_local('x'), _remote('origin/main')]), isNull);
    });

    test('deleting main: checkout target is master, start point stays main', () {
      final all = [_local('main'), _local('master'), _remote('origin/main')];
      expect(defaultCheckoutTarget('main', all), 'master');
      expect(defaultStartPoint(all), 'main');
      expect(_names(startPoints(all)), contains('main'));
      expect(_names(checkoutTargets('main', all)), ['master']);
    });
  });
}
