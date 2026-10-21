import '../entities/shelf.dart';

/// Shelves of one repository, kept in `<git-common-dir>/git-tools/shelf/`
/// (one folder per shelf with `shelf.json` and `changes.patch`, the format
/// shared with the VS Code extension). Implemented by the data layer.
abstract interface class ShelfRepository {
  /// Every readable shelf, newest first.
  Future<List<Shelf>> list();

  /// Saves a new shelf and keeps [base] alive with the ref of the shelf.
  Future<Shelf> create({
    required String name,
    required String base,
    String? branch,
    required List<ShelvedFile> files,
    required List<int> patch,
  });

  /// Content of `changes.patch`.
  Future<List<int>> patch(Shelf shelf);

  /// Absolute path of `changes.patch`.
  Future<String> patchPath(Shelf shelf);

  /// Rewrites `shelf.json` with [name] / [files], and the patch when given.
  Future<Shelf> update(Shelf shelf, {String? name, List<ShelvedFile>? files, List<int>? patch});

  /// Deletes the folder of the shelf and its ref.
  Future<void> delete(Shelf shelf);
}
