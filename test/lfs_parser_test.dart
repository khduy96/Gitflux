import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:git_tools/domain/entities/lfs.dart';
import 'package:git_tools/domain/logic/lfs_parser.dart';

const _oid = '59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138';
const _oid2 = '98ea6e4f216f2fb4b69fff9b3a44842c38686ca685f3f55dc48c5d3fb1107be4';

void main() {
  group('parseLfsPointer', () {
    test('reads oid and size', () {
      final p = parseLfsPointer(utf8.encode('version https://git-lfs.github.com/spec/v1\noid sha256:$_oid\nsize 1234\n'))!;
      expect(p.oid, _oid);
      expect(p.size, 1234);
      expect(p.shortOid, '59b271ae1b');
      expect(parseLfsPointer(utf8.encode(p.text)), p);
    });

    test('accepts CRLF, extension lines and the legacy version url', () {
      final p = parseLfsPointer(utf8.encode('version https://hawser.github.com/spec/v1\r\n'
          'ext-0-foo sha256:$_oid2\r\noid sha256:$_oid\r\nsize 7\r\n'));
      expect(p?.oid, _oid);
      expect(p?.size, 7);
    });

    test('rejects other content', () {
      expect(parseLfsPointer(null), isNull);
      expect(parseLfsPointer(const []), isNull);
      expect(parseLfsPointer(utf8.encode('hello\n')), isNull);
      expect(parseLfsPointer(utf8.encode('version https://example.com/spec\noid sha256:$_oid\nsize 1\n')), isNull);
      expect(parseLfsPointer(utf8.encode('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n')), isNull);
      expect(parseLfsPointer(utf8.encode('version https://git-lfs.github.com/spec/v1\noid sha256:$_oid\n')), isNull);
      // Too large to be a pointer.
      expect(
          parseLfsPointer(utf8.encode('version https://git-lfs.github.com/spec/v1\noid sha256:$_oid\nsize 1\n${'x' * 1100}')),
          isNull);
      expect(parseLfsPointer([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), isNull);
    });
  });

  test('parseCheckAttrLfs keeps paths whose filter is lfs', () {
    const out = 'x.bin\x00filter\x00lfs\x00t.txt\x00filter\x00unspecified\x00'
        'my dir/s/f.txt\x00filter\x00lfs\x00new.png\x00filter\x00unset\x00';
    expect(parseCheckAttrLfs(out), {'x.bin', 'my dir/s/f.txt'});
    expect(parseCheckAttrLfs(''), isEmpty);
  });

  test('parseLfsLsFilesJson', () {
    final files = parseLfsLsFilesJson('''
{
 "files": [
  {"name": "my dir/s/f.txt", "size": 3, "checkout": true, "downloaded": true, "oid_type": "sha256",
   "oid": "$_oid2", "version": "https://git-lfs.github.com/spec/v1"},
  {"name": "x.bin", "size": 3000, "checkout": false, "downloaded": false, "oid_type": "sha256", "oid": "$_oid"}
 ]
}''');
    expect(files.map((f) => f.path), ['my dir/s/f.txt', 'x.bin']);
    expect(files[0].downloaded, isTrue);
    expect(files[1].downloaded, isFalse);
    expect(files[1].size, 3000);
    expect(files[1].oid, _oid);
    expect(parseLfsLsFilesJson(''), isEmpty);
  });

  test('parseLfsLsFiles reads the * / - marker', () {
    final files = parseLfsLsFiles('98ea6e4f21 * my dir/s/f.txt\n59b271ae1b - x.bin\n');
    expect(files.map((f) => f.path), ['my dir/s/f.txt', 'x.bin']);
    expect(files.map((f) => f.downloaded), [true, false]);
    expect(files[1].oid, '59b271ae1b');
  });

  group('parseLfsLocksJson', () {
    test('plain list', () {
      final locks = parseLfsLocksJson('''
[{"id":"2","path":"b.psd","owner":{"name":"bob"},"locked_at":"2024-05-01T10:00:00Z"},
 {"id":"1","path":"a.psd","owner":{"name":"alice"},"locked_at":"2024-05-02T09:30:00Z"}]''');
      expect(locks.map((l) => l.path), ['a.psd', 'b.psd']);
      expect(locks.first.id, '1');
      expect(locks.first.owner, 'alice');
      expect(locks.first.ours, isNull);
      expect(locks.first.lockedAt!.toUtc(), DateTime.utc(2024, 5, 2, 9, 30));
    });

    test('verified locks tell ours from theirs', () {
      final locks = parseLfsLocksJson('{"ours":[{"id":"1","path":"a.psd","owner":{"name":"me"}}],'
          '"theirs":[{"id":"2","path":"b.psd","owner":{"name":"bob"}}]}');
      expect({for (final l in locks) l.path: l.ours}, {'a.psd': true, 'b.psd': false});
      expect(locks[0].lockedAt, isNull);
    });

    test('empty', () {
      expect(parseLfsLocksJson('[]'), isEmpty);
      expect(parseLfsLocksJson('{"ours":[],"theirs":[]}'), isEmpty);
      expect(parseLfsLocksJson(''), isEmpty);
    });
  });

  test('parseLfsTrackJson', () {
    final patterns = parseLfsTrackJson('''
{"patterns": [
  {"pattern": "*.bin", "source": ".gitattributes", "lockable": false, "tracked": true},
  {"pattern": "my[[:space:]]dir/**", "source": "assets/.gitattributes", "lockable": true, "tracked": true},
  {"pattern": "*.txt", "source": ".gitattributes", "tracked": false}
]}''');
    expect(patterns.map((p) => p.pattern), ['*.bin', 'my[[:space:]]dir/**', '*.txt']);
    expect(patterns[1].display, 'my dir/**');
    expect(patterns[1].sourceDir, 'assets');
    expect(patterns[1].inRootAttributes, isFalse);
    expect(patterns[1].lockable, isTrue);
    expect(patterns[0].inRootAttributes, isTrue);
    expect(patterns[2].tracked, isFalse);
  });

  test('parseLfsTrackList', () {
    final patterns = parseLfsTrackList('Listing tracked patterns\n'
        '    *.bin (.gitattributes)\n'
        '    my[[:space:]]dir/** (sub/.gitattributes)\n'
        '    *.psd [lockable] (.gitattributes)\n'
        'Listing excluded patterns\n'
        '    *.txt (.gitattributes)\n');
    expect(patterns.map((p) => p.pattern), ['*.bin', 'my[[:space:]]dir/**', '*.psd', '*.txt']);
    expect(patterns.map((p) => p.source), ['.gitattributes', 'sub/.gitattributes', '.gitattributes', '.gitattributes']);
    expect(patterns.map((p) => p.tracked), [true, true, true, false]);
    expect(patterns[2].lockable, isTrue);
  });

  test('parseLfsPruneDryRun', () {
    final preview = parseLfsPruneDryRun('prune: 4 local objects, 2 retained, done.\n'
        'prune: 2 files would be pruned (6 B), done.\n\n'
        ' * $_oid (3 B)\n * $_oid2 (3 B), done.\n');
    expect(preview.objects.map((o) => o.oid), [_oid, _oid2]);
    expect(preview.objects.first.size, '3 B');
    expect(preview.summary, hasLength(2));
    expect(parseLfsPruneDryRun('prune: 2 local objects, 2 retained, done.\n').objects, isEmpty);
  });

  group('lfsPatternMatches', () {
    bool m(String pattern, String path, {String source = '.gitattributes'}) =>
        lfsPatternMatches(LfsTrackPattern(pattern: pattern, source: source), path);

    test('a pattern without slash matches the file name at any depth', () {
      expect(m('*.bin', 'x.bin'), isTrue);
      expect(m('*.bin', 'a/b/x.bin'), isTrue);
      expect(m('*.bin', 'x.bin.txt'), isFalse);
      expect(m('x.bin', 'a/x.bin'), isTrue);
      expect(m('?.bin', 'xy.bin'), isFalse);
    });

    test('a pattern with slash matches from the attributes file', () {
      expect(m('assets/*.png', 'assets/a.png'), isTrue);
      expect(m('assets/*.png', 'assets/sub/a.png'), isFalse);
      expect(m('/assets/*.png', 'assets/a.png'), isTrue);
      expect(m('assets/**', 'assets/sub/a.png'), isTrue);
      expect(m('assets/**', 'other/assets/a.png'), isFalse);
      expect(m('**/big/*.dat', 'a/b/big/x.dat'), isTrue);
      expect(m('**/big/*.dat', 'big/x.dat'), isTrue);
      expect(m('a/**/z.bin', 'a/z.bin'), isTrue);
      expect(m('a/**/z.bin', 'a/b/c/z.bin'), isTrue);
    });

    test('escaped spaces, classes and nested attributes files', () {
      expect(m('my[[:space:]]dir/**', 'my dir/s/f.txt'), isTrue);
      expect(m(r'a[[:space:]]\[1\].psd', 'a [1].psd'), isTrue);
      expect(m('*.[pP][sS][dD]', 'x.PSD'), isTrue);
      expect(m('*.bin', 'sub/x.bin', source: 'sub/.gitattributes'), isTrue);
      expect(m('*.bin', 'x.bin', source: 'sub/.gitattributes'), isFalse);
      expect(m('d/*.bin', 'sub/d/x.bin', source: 'sub/.gitattributes'), isTrue);
      expect(m('assets/', 'assets/x'), isFalse);
    });
  });

  group('lfsTrackOptions', () {
    test('one file in a folder', () {
      final o = lfsTrackOptions(['assets/ui/logo.psd']);
      expect(o.map((e) => e.label), ['Exact path', 'By extension', 'By folder']);
      expect(o[0].patterns, ['assets/ui/logo.psd']);
      expect(o[0].literal, isTrue);
      expect(o[1].patterns, ['*.psd']);
      expect(o[2].patterns, ['assets/ui/**']);
    });

    test('several files; no extension or folder options when one lacks it', () {
      final o = lfsTrackOptions(['a/x.psd', 'b/y.png', 'a/z.psd']);
      expect(o[1].patterns, ['*.png', '*.psd']);
      expect(o[2].patterns, ['a/**', 'b/**']);
      expect(lfsTrackOptions(['Makefile', 'a/b.bin']).map((e) => e.label), ['Exact paths']);
      expect(lfsTrackOptions(['.env']).map((e) => e.label), ['Exact path']);
      expect(lfsTrackOptions(const []), isEmpty);
    });
  });
}
