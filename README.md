# Git Tools

Git client cho desktop viết bằng Flutter, mô phỏng Git tool window của Android Studio.
Ứng dụng gọi trực tiếp `git` CLI nên cần cài Git và có `git` trong PATH.

## Chạy

```bash
flutter run -d windows                 # hoặc macos / linux
flutter run -d windows -a "D:\path\repo"   # mở thẳng một repo
flutter build windows --release
```

## Tính năng

**Commit tool window (Alt+0)**
- Cây Changes / Unversioned Files / Merge Conflicts, tick checkbox để chọn file commit (không cần staging, giống AS)
- Click 1 lần mở diff dạng preview, double-click mở tab cố định; group theo thư mục
- Commit, Commit and Push…, Amend, Sign-off, đổi author (Ctrl+Enter để commit)
- Rollback (có tuỳ chọn xoá file added), Delete / Add to .gitignore cho file unversioned
- **Chọn từng dòng để commit** (chuột phải file ▸ Select Lines to Commit…):
  - Tab "Commit Lines" có checkbox cho từng dòng và từng đoạn thay đổi; dòng không chọn vẫn nằm lại trong working copy.
  - File chọn một phần có checkbox lưng chừng và nhãn `x/y lines`.
  - Commit đi qua một index tạm, nên index thật và git hooks không bị ảnh hưởng.
  - Chỉ áp dụng cho file *modified* và không dùng khi đang merge / rebase.
- Show History, Annotate (git blame), Copy Path, Show in Explorer
- Banner Merging / Rebasing / Cherry-picking với Continue / Skip / Abort; khi rebase hiện tiến độ
  (`Rebasing 2/5`) và commit đang dừng để sửa (`Stopped at … for editing — amend, then Continue`)

**AI commit message (✨ cạnh ô commit message)**
- Sinh commit message từ diff của các file đã tick (khi Amend thì gồm cả thay đổi của commit trước),
  bám theo phong cách 15 commit gần nhất; message hiện dần vào ô, bấm lại để dừng
- Hỗ trợ **Anthropic Claude** (Messages API) và **Google Gemini** (endpoint tương thích OpenAI)
- Không có cấu hình mặc định: người dùng tự chọn provider, nhập API key và model trong
  Commit Options ▸ AI Commit Message Settings… (hoặc menu Git), có nút Test Connection
- Màn hình **AI Setup Guide** (menu Git, hoặc nút "Setup guide" trong dialog cài đặt): hướng dẫn từng bước
  lấy key Gemini / Claude, chọn model, giới hạn gói free, quyền riêng tư và xử lý lỗi; song ngữ Việt / Anh
- Tuỳ chọn ngôn ngữ message và hướng dẫn thêm (ví dụ Conventional Commits)
- Diff quá lớn (>40K ký tự/file hoặc >150K tổng) chỉ được liệt kê tên file và có thông báo
- Lưu ý: API key lưu dạng không mã hoá trong `%APPDATA%\git_tools\settings.json`;
  gói free của Gemini có giới hạn request/ngày và Google có thể dùng dữ liệu gửi lên để cải thiện sản phẩm

**Diff viewer**
- Side-by-side và Unified, highlight thay đổi trong dòng (word-level)
- Thu gọn vùng không đổi, Ignore whitespace, overview ruler, F7 / Shift+F7 để nhảy giữa các thay đổi
- Nút `»` để revert từng chunk về HEAD (với diff working tree)
- Xem ảnh hai bên cho file ảnh nhị phân

**Git tool window (Alt+9)**
- Log: cây branch (HEAD, Local, Remote, Tags), đồ thị commit có màu theo nhánh, ref labels,
  lọc theo text/hash/author, theo branch, theo file (Show History)
- Chi tiết commit: danh sách file đã đổi, message, author/committer, các branch chứa commit
- Menu commit: Cherry-Pick, Checkout Revision, Compare with Local, Reset (soft/mixed/hard/keep),
  Revert, Undo Commit, Edit Commit Message, Fixup into Previous, Squash Commits, Drop Commits,
  Move Commit Up / Down, Interactively Rebase from Here, New Branch, New Tag
  (xem mục **Interactive rebase** bên dưới)
- Console: toàn bộ lệnh git đã chạy và output, có ô chạy lệnh git tuỳ ý
- Stashes: Pop / Apply / Drop / Clear / Unstash as Branch, xem file và diff trong stash

**Interactive rebase (chuột phải commit trong Log)**

| Menu | Khi nào bật | Làm gì |
|---|---|---|
| Interactively Rebase from Here… | 1 commit thuộc branch hiện tại (tổ tiên của HEAD) | Mở dialog sửa toàn bộ todo từ commit đó tới HEAD |
| Edit Commit Message… | HEAD, hoặc commit cũ hơn không phải root / merge | HEAD: amend như trước; commit cũ: reword qua rebase |
| Fixup into Previous | 1 commit có commit cha (không phải merge) trong branch | Gộp vào commit cha, giữ message của commit cha |
| Squash Commits… | ≥ 2 commit liền nhau, không có merge (commit cũ nhất được là root) | Gộp thành 1 commit, hỏi message (điền sẵn các message nối bằng dòng trống) |
| Move Commit Up / Down | 1 commit có commit liền trên / liền dưới | Đổi chỗ với commit bên cạnh (không vượt qua merge) |
| Drop Commit(s) | Chọn được nhiều commit, không phải root / merge | Xoá khỏi lịch sử branch (có hỏi xác nhận) |

Menu không áp dụng được thì bị làm mờ (không ẩn). Các lệnh trên đều chạy cùng một cơ chế:
- Yêu cầu repo ở trạng thái bình thường và HEAD đang ở trên một branch (không detached).
- Git tự sinh todo (`git rebase -i`, thêm `--rebase-merges` nếu trong khoảng có merge commit) rồi
  dừng ngay mà không đụng tới HEAD, index, working tree hay stash. App chạy bước này trên một index tạm,
  vì `--autostash` sẽ làm các thay đổi đã stage thành chưa stage.
- Todo sau khi sửa được chạy lại bằng `git rebase -i --autostash`. Reword / squash dùng
  `exec git commit --amend --allow-empty -F <file>`, nên các hook (`pre-commit`, `commit-msg`…) vẫn chạy.
  Hook từ chối thì rebase dừng lại ở trạng thái Rebasing.
- Nếu có commit trong khoảng đã nằm trên upstream (`@{u}`), app cảnh báo sẽ phải force push và hỏi trước khi chạy.
- Gặp conflict, `edit`, hook hoặc exec lỗi thì rebase dừng; banner ở Commit panel có Continue / Skip / Abort.
  Abort đưa branch về đúng HEAD cũ.
- Todo và message được lưu ở `.git/git-tools-rebase` (theo `git rev-parse --git-path`, chạy được với
  worktree / submodule) và bị xoá khi rebase kết thúc.

Dialog **Interactively Rebase from Here…**:
- Mỗi dòng: action (Pick / Reword / Edit / Squash / Fixup / Drop), hash, subject, author, ngày; commit mới nhất ở trên cùng
  như trong Log. Các dòng `label` / `reset` / `merge` / `update-ref` hiện mờ, chỉ đọc; commit chỉ được di chuyển
  trong đoạn nằm giữa các dòng này.
- Kéo thả hoặc Alt+↑ / Alt+↓ để đổi thứ tự; phím P / R / E / S / F / D đổi action của các commit đang chọn
  (Ctrl+click để chọn nhiều).
- Khung bên phải: sửa message của dòng Reword hoặc của cả nhóm Squash (mặc định là message các commit trong nhóm,
  bỏ message của Fixup). Nhóm chỉ có Fixup giữ message của commit đầu nhóm.
- Lỗi hiện ngay trong dialog (Squash / Fixup không có commit phía trước, message rỗng) và nút **Start Rebasing**
  bị khoá; drop hết mọi commit chỉ là cảnh báo. **Reset** trả về todo ban đầu.

**Branches (Ctrl+Shift+`)**
- Popup giống AS: Update Project, Commit, Push, New Branch, Checkout Tag or Revision, danh sách Local/Remote
- Checkout (Smart Checkout tự stash/unstash khi có thay đổi cục bộ), New Branch from, Checkout and Rebase,
  Compare with current (commit hai phía + file khác nhau), Rebase onto, Merge into, Rename, Delete (local/remote)

**Submodules (`.gitmodules`)**
- Commit panel: submodule hiện kèm mô tả (`submodule · new commits, modified content…`).
  - Diff hiện commit cũ / mới của submodule và tiêu đề commit.
  - Chuột phải có Open Submodule (mở như repo riêng) và Update Submodule.
  - Rollback đưa submodule về commit đã ghi nhận.
- Log ▸ cây branch ▸ **Submodules**: trạng thái từng submodule (not initialized / out of date / conflict).
  - Trên từng submodule: Open, Update, Sync URL, Copy Path.
  - Chuột phải nhóm: Update All, Sync All URLs, Add Submodule…
- Pull dialog có tuỳ chọn **Update submodules**; Clone có tuỳ chọn **Clone submodules too** (`--recurse-submodules`).
- Khi HEAD đổi (checkout / pull / merge / reset) mà submodule bị lệch, app hiện thông báo kèm nút **Update Submodules**.

**Remote**
- Update Project / Pull (Ctrl+T): Merge, Rebase hoặc Fast-forward only
- Push (Ctrl+Shift+K): xem trước commit sẽ push, force-with-lease, push tags, tự set upstream cho branch mới
- Fetch, Manage Remotes

**Conflicts**
- Dialog Conflicts: Accept Yours / Accept Theirs / Merge…
- Merge tool 3 cột (Ours | Result | Theirs): chọn từng conflict, Left+Right, Right+Left, Base, sửa tay

Ngoài ra: màn hình Welcome (Open / Clone / New Repository, repo gần đây), tự refresh khi file
hoặc `.git` thay đổi (kể cả thao tác git từ terminal bên ngoài), thông báo dạng toast.

## Cấu trúc

Clean Architecture, 3 tầng. Phụ thuộc chỉ hướng vào trong: `presentation → domain ← data`.

```
lib/
  main.dart       # composition root: tạo các implementation của data rồi đưa cho presentation
  domain/         # thuần Dart: không import Flutter, dart:io hay data/
    entities/     # FileChange, Commit, Branch, RepoStatus, RebasePlan, AiConfig, ConsoleEntry, ...
    logic/        # thuật toán thuần: diff engine, graph layout, conflict parser, line selection, rebase todo
    repositories/ # interface: GitRepository, GitService, CommitMessageGenerator, SettingsStore
    usecases/     # CommitChanges, GenerateCommitMessage, GetSelectedLineContents, InteractiveRebase
    errors.dart   # GitException, AiException, StaleSelectionException, CommitRejected, RebaseRejected
  data/           # implementation các interface của domain
    datasources/  # GitProcess (chạy git), client Claude / Gemini
    repositories/ # GitCliRepository, GitCliService, JsonFileSettingsStore (%APPDATA%/git_tools)
  presentation/
    app.dart, app_scope.dart  # widget gốc + InheritedWidget cấp GitService / AI cho UI
    state/        # RepoController (state + gọi use case), AppSettings
    ui/           # commit/, diff/, log/, branches/, conflicts/, dialogs/, console/, workspace_page.dart
test/             # unit test domain/use case (repo giả) + test tích hợp chạy git thật trên repo tạm
```

Quy tắc:
- UI và `RepoController` chỉ làm việc với interface trong `domain/repositories`, không gọi
  `GitProcess` hay lệnh git thô. Cần lệnh git mới thì thêm method vào `GitRepository` rồi
  implement trong `GitCliRepository`.
- Logic nghiệp vụ có nhiều bước (kiểm tra điều kiện commit, gom diff cho AI, ...) đặt trong
  `domain/usecases`; thao tác git một bước thì `RepoController` gọi thẳng `GitRepository`.
- Chỉ `main.dart` được import `data/`.
