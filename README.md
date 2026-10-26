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
- Cây changelist (mặc định "Changes") / Unversioned Files / Merge Conflicts, tick checkbox để chọn file commit
  (không cần staging, giống AS) — xem mục **Changelists** bên dưới
- Click 1 lần mở diff dạng preview, double-click mở tab cố định; group theo thư mục
- Commit, Commit and Push…, Amend, Sign-off, **Sign commit** (GPG / SSH, xem mục **Ký commit**), đổi author
  (Ctrl+Enter để commit)
- Rollback (có tuỳ chọn xoá file added), Delete / Add to .gitignore cho file unversioned
- Chuột phải nhóm "Unversioned Files" ▸ **Clean Unversioned Files…** (xem mục **Clean** bên dưới)
- Kéo thả file / thư mục / **cả nhóm** sang changelist khác: kéo dòng tiêu đề "Unversioned Files" thả vào một changelist
  để thêm toàn bộ file mới vào Git trong changelist đó; kéo tiêu đề một changelist để chuyển hết file của nó
- **Chọn từng dòng để commit** (chuột phải file ▸ Select Lines to Commit…):
  - Tab "Commit Lines" có checkbox cho từng dòng và từng đoạn thay đổi; dòng không chọn vẫn nằm lại trong working copy.
  - File chọn một phần có checkbox lưng chừng và nhãn `x/y lines`.
  - Commit đi qua một index tạm, nên index thật và git hooks không bị ảnh hưởng.
  - Chỉ áp dụng cho file *modified* và không dùng khi đang merge / rebase.
- Show History, Annotate (git blame), Copy Path, Show in Explorer
- **Shelve Changes…** và **Create Patch…** (chuột phải file, thư mục hoặc nhóm; nút Shelve trên thanh công cụ
  lấy các file đang tick) — xem mục **Shelve** và **Patch** bên dưới
- Banner Merging / Rebasing / Cherry-picking / Applying patch với Continue / Skip / Abort; khi rebase hiện tiến độ
  (`Rebasing 2/5`) và commit đang dừng để sửa (`Stopped at … for editing — amend, then Continue`);
  khi `git am` dừng hiện `Applying patch 1/3` và tiêu đề patch
- Banner **Bisecting** (xem mục **Bisect** bên dưới)

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
- Log: cây branch (HEAD, Local, Remote, Tags, Submodules, Worktrees, Reflog; branch gom thành thư mục theo `/` trong tên,
  thư mục chứa branch hiện tại hoặc branch đang lọc tự mở), đồ thị commit có màu theo nhánh, ref labels
  (thu gọn: một tên + `+N`, branch local và remote cùng tên gộp lại với icon máy tính / đám mây, rê chuột để xem
  đầy đủ; khi lọc theo branch chỉ hiện branch đó; rê chuột lên tên branch / tag ở bất kỳ đâu rồi `Ctrl+C`
  (`⌘C` trên macOS) để copy tên),
  lọc theo text/hash/author, branch, user, ngày, nội dung thay đổi, theo file (Show History)
  (xem mục **Lọc Log** bên dưới)
- Chi tiết commit: danh sách file đã đổi, message, author/committer, các branch chứa commit
- Menu commit: Cherry-Pick, Checkout Revision, Compare with Local, Compare Commits, Reset (soft/mixed/hard/keep),
  Revert, Undo Commit, Edit Commit Message, Fixup into Previous, Squash Commits, Drop Commits,
  Move Commit Up / Down, Interactively Rebase from Here, Merge into Current…, Bisect ▸, New Branch, New Tag
  (xem mục **Interactive rebase**, **So sánh hai commit**, **Merge** và **Bisect** bên dưới)
- Console: toàn bộ lệnh git đã chạy và output, có ô chạy lệnh git tuỳ ý
- Stashes: Pop / Apply / Drop / Clear / Unstash as Branch, xem file và diff trong stash
- Reflog: lịch sử HEAD đã trỏ tới đâu, để lấy lại commit bị mất (xem mục **Reflog** bên dưới)
- Shelf: các shelf đã cất (xem mục **Shelve** bên dưới)
- Menu commit có thêm **Create Patch…** (chọn 1..n commit, xem mục **Patch**)

**Shelve (cất thay đổi theo từng file, như "Shelve Changes" của Android Studio)**
- Khác stash: chỉ cất đúng các file được chọn, có tên, danh sách riêng không đụng tới stash của git,
  và unshelve được từng phần (chỉ một số file).
- Mở bằng chuột phải file / thư mục / nhóm trong Commit panel ▸ **Shelve Changes…**, nút Shelve trên thanh công cụ
  của Commit panel (các file đang tick), hoặc menu Git ▸ **Shelve Changes…**.
- Dialog: tên (mặc định là dòng đầu của commit message, hoặc `Changes from yyyy-MM-dd HH:mm`), danh sách file
  (file đã chọn được tick sẵn), tuỳ chọn **Keep changes in working tree** (mặc định tắt).
- Sau khi cất (trừ khi Keep), đúng các file đó được trả về HEAD: file sửa / xoá được khôi phục, file mới bị xoá
  (file đã `git add` thì cũng bỏ khỏi index). File khác và index của chúng không bị đụng tới.
- Không cho shelve khi đang merge / rebase / cherry-pick / revert / `git am`. File chỉ chọn một số dòng
  (Select Lines to Commit) được shelve **nguyên file**. Submodule và repo lồng nhau bị bỏ qua (có thông báo).
  Phần đã stage của file được shelve không được giữ riêng: khi unshelve, thay đổi nằm ở working tree.
- Tab **Shelf** của Git tool window (menu Git ▸ **Show Shelf**): shelf mới nhất ở trên, mỗi shelf có tên, thời gian
  tương đối (rê chuột để xem giờ chính xác), số file, branch lúc cất. Bấm shelf để mở danh sách file; bấm file để
  xem diff `base` ↔ nội dung đã cất (chỉ đọc), double-click mở tab cố định.
- Chuột phải shelf: **Unshelve…**, **Apply (keep in shelf)**, **Rename…**, **Delete…** (có xác nhận),
  **Create Patch…** (lưu patch của shelf ra file), **Copy as Patch**. Chuột phải file: **Unshelve This File**, **Show Diff**.
- **Unshelve…**: chọn file (mặc định tất cả), tuỳ chọn **Remove successfully applied files from shelf** (mặc định bật).
  Patch được áp bằng `git apply --3way`, nên vẫn chạy khi HEAD đã đổi hoặc file đang có thay đổi chưa commit
  (đã stage hay chưa): thay đổi được trộn 3-way. File bị conflict có conflict marker và vào nhóm Merge Conflicts
  để giải quyết như bình thường, đồng thời **vẫn nằm trong shelf**; file áp sạch thì bị bỏ khỏi shelf (nếu bật tuỳ chọn).
  File mới trong shelf trùng tên với một file chưa track đang có thì thành conflict add/add (cả hai nội dung nằm trong file).
  Index giữ nguyên cho các file áp sạch (những gì bạn đã stage vẫn còn). Nếu git từ chối hẳn patch thì không có gì
  thay đổi và thông báo hiện stderr của git. Shelf hết file thì tự bị xoá.
- Lưu trữ (chung định dạng với extension VS Code, nên shelf tạo bên này mở được bên kia):
  `$(git rev-parse --git-common-dir)/git-tools/shelf/<id>/` với `id` = `yyyyMMdd-HHmmss-<6 hex>` (giờ UTC), gồm
  `shelf.json` (`version`, `name`, `created` ISO-8601 UTC, `base` = HEAD lúc cất, `branch`, `files` [`path`, `oldPath`,
  `status` M/A/D/R]) và `changes.patch` (`git diff --binary --full-index -M` so với `base`, kể cả file mới; ghi đúng
  từng byte git xuất ra). Commit `base` được giữ bằng ref `refs/git-tools/shelf/<id>` (xoá cùng shelf), nên shelf vẫn
  dùng được sau khi rebase / amend / `git gc`. Thư mục này nằm trong `.git` nên dùng chung cho các worktree và không bị track.
- Patch được tạo qua một index tạm (`GIT_INDEX_FILE`, `read-tree base` rồi `git add -A -- <file>`), không đụng index thật.

**Patch**
- **Create Patch…** trong Commit panel (file đang chọn / tick, thư mục, nhóm): patch so với HEAD gồm cả file mới và file
  nhị phân (`git diff --binary`, qua index tạm); **Save Patch…** (tên mặc định `<branch>.patch`) hoặc
  **Copy Patch to Clipboard**.
- **Create Patch…** trong Log (chọn 1..n commit): `git format-patch --stdout` của từng commit, nối theo thứ tự topo
  (cũ trước) thành một file mailbox. Merge commit bị bỏ qua.
- Menu Git ▸ **Apply Patch…** (chọn file) và **Apply Patch from Clipboard**:
  - Tự nhận dạng mailbox của `git format-patch` (dòng đầu `From <hash> ` / header `Subject:`).
  - Xem trước: danh sách file với trạng thái và số dòng +/− (`git apply --numstat --summary`), kết quả
    `git apply --check --3way` (áp sạch / có conflict ở file nào / không áp được kèm lỗi của git).
  - Mailbox: **Apply as commits (git am --3way)** (mặc định) hoặc **Apply changes only**; diff thường: áp vào
    working tree bằng `git apply --3way` (giống Unshelve: trộn với thay đổi cục bộ, index giữ nguyên).
  - Conflict: giải quyết như bình thường. Với `git am`, repo ở trạng thái "Applying patch": banner ở Commit panel có
    **Continue** (`am --continue`), **Skip Patch** (`am --skip`), **Abort** (`am --abort`).

**Changelists (như Android Studio)**
- Các thay đổi đã track được chia thành nhiều changelist có tên; luôn có list mặc định "Changes" (đổi tên được,
  không xoá được). Commit panel hiện mỗi changelist một nhóm (tên, số file; list đang active in đậm và có
  "(active)" khi có nhiều hơn một list). Changelist rỗng không active bị ẩn, trừ khi bật nút **Show Empty Changelists**
  trên thanh công cụ. Group theo thư mục vẫn dùng được bên trong từng list.
- File thay đổi mới (chưa thuộc list nào) vào **list đang active lúc nó xuất hiện lần đầu** và ở lại đó khi đổi list
  active. File không còn thay đổi tự rời list; file bị rename giữ chỗ của tên cũ. File unversioned không thuộc list nào.
- Đổi list active (chuột phải nhóm ▸ **Set Active Changelist**): checkbox được tick đúng các file của list mới; ô commit
  message là của từng list — message đang gõ được lưu vào `comment` của list cũ và message của list mới được nạp lại.
  Nhờ vậy commit chỉ gồm list active, các list khác không bị đụng tới.
- Chuột phải nhóm: **Set Active Changelist**, **New Changelist…**, **Edit Changelist…** (tên, comment, "Set active"),
  **Delete Changelist…** (có xác nhận; file chuyển sang list active, hoặc sang "Changes" — list này thành active — khi
  xoá chính list active), **Shelve Changes…** (cả list, tên shelf mặc định là tên list), **Create Patch…**.
- Chuột phải file / thư mục ▸ **Move to Another Changelist…** (F6): chọn list có sẵn hoặc **New Changelist…**; dùng được
  cho nhiều file. Hoặc kéo thả file / thư mục / cả nhóm vào một changelist; thả file unversioned vào list thì file được
  `git add` và nằm trong list đó.
- Sau commit, nếu một list (không phải "Changes") hết file thì hỏi **Delete changelist '<tên>'?** (có ô "Don't ask again
  for this session").
- Unshelve: file về lại changelist trùng tên với shelf nếu có, nếu không thì vào list active.
- Chọn từng dòng để commit vẫn hoạt động như cũ trong mỗi list.
- Lưu trữ (chung định dạng với extension VS Code, hai bên cùng làm việc trên một file):
  `$(git rev-parse --git-path git-tools/changelists.json)` — riêng cho từng worktree, không bị track:
  `{ "version": 1, "active": "<id>", "lists": [ { "id": "default" | "yyyyMMdd-HHmmss-<6 hex>", "name", "comment",
  "files": [đường dẫn tương đối, dấu /] } ] }`. File được đọc lại trước mỗi lần sửa (bên kia có thể vừa đổi), ghi
  nguyên tử (file tạm rồi rename), thụt lề 2 dấu cách và giữ nguyên các field lạ. File hỏng (không phải JSON) không bị
  ghi đè; lỗi hiện trong Console.

**Git LFS**
- Tự nhận diện `git lfs` (kiểm tra một lần mỗi phiên); nếu chưa cài git-lfs thì mọi chức năng LFS được ẩn — cài tại
  https://git-lfs.com rồi mở lại ứng dụng.
- Commit panel: file được lưu bằng LFS (`git check-attr filter` = `lfs`) có nhãn **LFS** nhỏ; file đang bị khoá (lock)
  có biểu tượng ổ khoá, tooltip hiện người giữ khoá và thời điểm khoá.
- Chuột phải file: **Track with LFS…** (file unversioned — chọn mẫu: đúng đường dẫn, `*.<ext>` hoặc `<thư mục>/**`;
  `.gitattributes` sẽ hiện là đã thay đổi, cần commit cùng), **Untrack from LFS…**, **Lock** / **Unlock** (chỉ khi
  remote hỗ trợ khoá; mở khoá của người khác cần xác nhận và dùng `--force`).
- Menu Git ▸ **Git LFS**: **Pull**, **Fetch**, **Prune…** (xem trước bằng dry-run rồi xác nhận), **Show Tracked
  Patterns…** (danh sách mẫu đang track, có nút Untrack).
- Diff của file LFS: hiển thị `oid` / kích thước của pointer hai phía; nếu object đã có trong máy thì xem được diff nội
  dung thật (ảnh / nhị phân / văn bản) bằng nút **Show Content** / **Show Pointers**.
- Push / Pull không đổi (do hook của git-lfs); lỗi LFS khi push (ví dụ không upload được object) hiện nguyên văn stderr.

**Ký commit (GPG / SSH / X.509)**
- Commit Options có ô **Sign commit** (mặc định theo `commit.gpgsign`). Ứng dụng luôn truyền rõ `-S` / `--no-gpg-sign`
  cho commit, amend, Edit Commit Message (kể cả reword qua interactive rebase, dòng `exec git commit --amend`), các
  commit được rebase, merge commit tạo từ hộp thoại Merge (ô **Sign merge commit**) và khi Continue một merge.
  Merge nhanh không qua hộp thoại thì theo `commit.gpgsign`.
- Hộp thoại New Tag có ô **Sign tag** (mặc định theo `tag.gpgsign`), tạo tag annotated có chữ ký (`git tag -s`).
- Menu Git ▸ **Signing Settings…** (hoặc link trong Commit Options): chọn định dạng OpenPGP / SSH / X.509, chọn khoá
  (khoá GPG từ `gpg --list-secret-keys`, đánh dấu khoá hết hạn hoặc bị thu hồi; khoá SSH từ `~/.ssh/*.pub` — lưu đường
  dẫn private key — và từ ssh-agent — lưu `key::<public key>`), bật "Sign commits / tags by default", lưu cho
  **This repository** hoặc **Global** (`git config --local / --global`). Nút **Test Signing** ký thử một object tạm
  (`git commit-tree -S`, không tạo ref) và báo kết quả hoặc lỗi của git.
- Log: biểu tượng chữ ký cho mỗi commit (xanh = hợp lệ `G`, vàng = khoá chưa tin cậy hoặc hết hạn `U/X/Y`, đỏ = sai,
  bị thu hồi hoặc không kiểm tra được `B/R/E`, không có = chưa ký), chỉ kiểm tra các dòng đang hiển thị (kiểm tra chữ
  ký chậm). Commit ký bằng SSH khi chưa cấu hình `gpg.ssh.allowedSignersFile` hiện khiên xám "not verified" thay vì
  "chưa ký". Chi tiết commit hiện người ký, khoá, trạng thái; tag có chữ ký hiện kết quả `git verify-tag`.
- Khi ký thất bại (không có agent, sai khoá, huỷ pinentry): thông báo lỗi kèm stderr của git và nút
  **Signing Settings…**; ứng dụng không bao giờ tự commit mà không ký.

**Lọc Log (thanh filter phía trên danh sách commit)**
- Ô tìm kiếm có 2 chế độ (bấm icon kính lúp để chọn):
  - **Message / hash / author** (mặc định): lọc ngay trên các commit đã tải, như trước.
  - **Changes containing text**: tìm commit làm thay đổi số lần xuất hiện của đoạn text (`git log -S`);
    **Changes matching regex (-G)**: commit có dòng thêm / xoá khớp regex (`git log -G`).
    Chạy trong git sau khi ngừng gõ ~0,5 giây, cần ít nhất 2 ký tự, không phân biệt hoa thường.
- **Branch**: All, HEAD hoặc một branch, chọn trong cây thư mục theo tên branch (`Local ▸ feature ▸ login`,
  `Remote ▸ origin ▸ main`). Bấm thư mục để mở / đóng; ô tìm kiếm lọc branch và mở sẵn các thư mục có kết quả.
  Phím: ↑ / ↓ chọn, ← / → đóng / mở thư mục, Enter áp dụng, Esc đóng.
- **User**: All, Me (`user.name` / `user.email` của repo), các author của các commit đã tải (nhiều commit nhất
  đứng trước), hoặc Select… để gõ tên / email. Khớp một phần tên hoặc email, không phân biệt hoa thường.
- **Date**: All, Last 24 hours, Last 7 days, Last 30 days, hoặc Select… chọn từ ngày / đến ngày (có thể bỏ trống một đầu).
- User / Date / nội dung được lọc ngay trong git (`--author`, `--since`, `--until`, `-S` / `-G`), nên tìm được
  cả commit nằm ngoài 3000 commit đang tải; kết hợp được với filter branch và file.
- Mỗi filter đang bật hiện dạng chip có dấu × để bỏ; nút **Reset filters** bỏ tất cả. Khi lọc theo text, user,
  ngày hoặc nội dung thì đồ thị commit bị ẩn.
- Filter User / Date được nhớ theo từng repo trong phiên làm việc (mở lại app thì về All).

**So sánh hai commit**
- Trong Log, Ctrl+click chọn đúng 2 commit ▸ chuột phải ▸ **Compare Commits** (không cần commit này là tổ tiên commit kia).
- Mở tab mới: tiêu đề `<commit cũ> ↔ <commit mới>` (cũ / mới theo committer date), danh sách file khác nhau
  (`git diff --name-status -M`, có phát hiện rename) với chữ trạng thái M / A / D / R, click file để xem diff ngay
  trong tab, double-click để mở diff ở tab riêng.
- Nút **Swap sides** đổi hai bên của diff.

**Reflog (lưới an toàn khi reset, rebase, drop, amend…)**
- Mở bằng node **Reflog** trong cây branch của Log, tab **Reflog** của Git tool window, hoặc menu Git ▸ **Show Reflog**.
- Liệt kê tối đa 500 entry mới nhất của reflog `HEAD` (hoặc của branch hiện tại, chọn ở nút `Reflog: HEAD ▾`):
  selector (`HEAD@{n}`), hash, thao tác (`commit`, `commit (amend)`, `reset`, `rebase (finish)`, `checkout`…),
  message, thời gian tương đối (rê chuột để xem giờ chính xác). Tự refresh cùng repo.
- Chuột phải một entry: **Show in Log** (chọn commit trong Log; commit không còn trên branch nào vẫn xem được
  file và diff), **Checkout Revision**, **New Branch Here…** (cách lấy lại commit bị mất),
  **Reset Current Branch to Here…**, **Copy Revision Number**. Double-click = Show in Log.
- Entry có commit đã bị xoá khỏi repo (gc) hiện mờ và không có thao tác.

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
- Checkout (Smart Checkout tự stash/unstash khi có thay đổi cục bộ), New Branch from, Checkout in New Worktree…,
  Checkout and Rebase, Compare with current (commit hai phía + file khác nhau), Rebase onto,
  Merge into… (dialog, xem mục **Merge**), Quick Merge (không mở dialog, tuỳ chọn mặc định của git), Rename,
  Delete (local/remote)
- **Delete trên current branch** (cây branch của Log và popup Branches): không xoá ngay mà mở dialog
  **Delete Current Branch 'x'** với 2 lựa chọn để rời branch trước:
  - **Checkout Another Branch and Delete**: chọn branch để checkout (local và remote, không có branch đang xoá và
    remote cùng tên với nó, ví dụ `origin/x`). Chọn sẵn local `main`, không có (hoặc đang xoá chính `main`) thì
    local `master`; nhấn Enter ngay là checkout branch đó. Không có mục nào hợp lệ thì không chọn sẵn, phải tự chọn.
  - **Create New Branch and Delete**: nhập tên branch mới (không được trùng branch local nào, kể cả branch đang xoá)
    và chọn **From:** (local và remote, có cả branch đang xoá). Chọn sẵn local `main` (kể cả khi đang xoá `main`),
    không có thì local `master`; Enter dùng mục chọn sẵn. Branch mới luôn được checkout; tạo từ remote thì không lấy
    remote đó làm upstream.
  - Checkout chạy như Checkout thường (Smart Checkout, dialog worktree). Branch cũ chỉ bị xoá sau khi đã rời nó
    thành công; huỷ (Esc / Cancel) hoặc checkout không được thì branch cũ còn nguyên và vẫn là current branch.
    Bước rời branch báo lỗi dù HEAD đã đổi (ví dụ Smart Checkout không khôi phục được thay đổi cục bộ) thì branch
    cũ cũng không bị xoá, thông báo lỗi vẫn hiện.
    Chỉ xoá branch local, branch trên remote giữ nguyên (không push gì). Xoá như `git branch -d`: branch phải đã
    merge vào upstream của nó (nếu có), không thì vào HEAD mới; chưa merge thì hiện dialog
    **Branch Is Not Fully Merged** hỏi xoá hẳn (nút **Delete**); từ chối thì branch cũ còn nguyên và bạn ở lại
    branch mới. Repo đang merge / rebase / cherry-pick / revert / `git am` thì chỉ hiện thông báo, không chạy lệnh
    git nào
- Rebase / Merge **từ origin**: chuột phải một branch local B (đang ở A) có thêm **Rebase 'A' onto 'origin/B'**,
  **Merge 'origin/B' into 'A'…** và **Quick Merge 'origin/B' into 'A'** (khi B có branch trên remote: upstream, hoặc
  cùng tên trên origin). `origin/B` được fetch trước, nên không cần checkout B và pull; B local không bị đổi
- **Drop Local and Take origin/x…**: khi branch local và upstream đều có commit mới (↑ và ↓, pull sẽ phải merge /
  rebase và có thể conflict), menu branch có thêm lựa chọn bỏ bản local, lấy đúng bản origin: fetch, hỏi xác nhận
  (liệt kê các commit chưa push sẽ bị bỏ), xoá branch local và checkout lại từ origin (vẫn tracking origin). Thay đổi
  chưa commit được stash rồi trả lại; không áp dụng lại được thì giữ trong stash. Khi Update / Pull đã dừng vì
  conflict, thông báo và hộp **Conflicts** có nút **Abort and Take origin/x…** (huỷ merge / rebase của pull rồi làm
  như trên)
- Branch đang được checkout ở worktree khác có nhãn `in <tên worktree>` (rê chuột để xem đường dẫn) trong cây branch
  và popup. Checkout branch đó không hiện lỗi thô của git mà hiện dialog giải thích, có nút **Open that worktree**.

**Merge (dialog giống Android Studio)**
- Mở từ menu branch (**Merge 'x' into 'y'…**), menu tag (**Merge into Current…**) và menu commit trong Log
  (**Merge into Current…**). Bản nhanh **Quick Merge** (không dialog, tuỳ chọn mặc định) vẫn còn trong menu branch / tag.
- Tuỳ chọn: **Fast-forward only** (`--ff-only`), **No fast-forward** (`--no-ff`), **Squash** (`--squash`),
  **No commit** (`--no-commit`), **Commit message** (`-m`, chỉ bật khi merge sẽ tạo merge commit).
- Ba tuỳ chọn Fast-forward only / No fast-forward / Squash loại trừ nhau. Squash luôn kèm No commit (git không
  commit khi squash): sau khi squash, ô commit message được điền sẵn phần đầu của `SQUASH_MSG` và app nhắc bạn commit.
- Dòng xem trước: "N commits will be merged", thêm "Fast-forward possible" khi HEAD là tổ tiên của nhánh được merge.
- Tuỳ chọn lần cuối được nhớ trong phiên làm việc (message thì không).
- Fast-forward only mà không fast-forward được thì git từ chối và không có gì thay đổi. No commit (không squash)
  để repo ở trạng thái Merging: kiểm tra rồi commit, hoặc Abort ở banner.

**Clean (xoá file chưa track, `git clean`)**
- Mở bằng chuột phải nhóm **Unversioned Files** ▸ **Clean Unversioned Files…** hoặc menu Git ▸ **Clean Working Tree…**.
- Dialog xem trước danh sách `git clean -n` theo tuỳ chọn: **Remove untracked directories** (`-d`, mặc định bật),
  **Include ignored files** (`-x`, mặc định tắt; file bị ignore có nhãn `ignored`). Đổi tuỳ chọn thì danh sách được tính lại.
- Mỗi mục có checkbox (mặc định tick hết); bỏ tick thì mục đó được giữ lại. Repo lồng nhau (thư mục có `.git` riêng)
  vẫn được liệt kê nhưng mặc định **không** tick; tick vào thì có cảnh báo và chỉ mục đó được xoá bằng `git clean -ff`.
- Bấm **Clean…** có hộp xác nhận nêu số mục và "không thể hoàn tác". File đã track không bao giờ bị đụng tới.
- Đường dẫn được truyền tường minh (`:(literal)<path>`); `git clean` không có `--pathspec-from-file` nên app chia
  thành nhiều lệnh khi danh sách dài để không vượt giới hạn độ dài dòng lệnh.

**Worktrees (`git worktree`)**
- Log ▸ cây branch ▸ **Worktrees**: mọi worktree (`git worktree list --porcelain -z`) với branch / `detached at <hash>` /
  `bare`, nhãn `locked` (lý do ở tooltip) và `missing` (thư mục đã mất, prune được); worktree đang mở được đánh dấu.
- Chuột phải nhóm: **New Worktree…**, **Prune…** (hiện trước những gì `git worktree prune -n -v` sẽ xoá rồi mới chạy).
- **New Worktree…** (cũng có trong menu Git và menu branch ▸ **Checkout in New Worktree…**): đường dẫn mặc định
  `../<tên-repo>-<tên-branch>` (tự đổi theo branch cho tới khi bạn sửa), checkout branch có sẵn, tạo branch mới (`-b`)
  từ một start point, hoặc detached HEAD.
- Chuột phải một worktree: **Open** (mở như một repo trong app, giống Open Submodule; double-click cũng mở),
  **Copy Path**, **Show in Explorer**, **Lock… / Unlock** (có lý do), **Remove…** (có xác nhận; nếu worktree còn thay đổi
  chưa commit thì hỏi lần hai rồi mới `--force`). Worktree chính và worktree đang mở không xoá được.

**Bisect (tìm commit gây lỗi, `git bisect`)**
- Log ▸ chuột phải commit ▸ **Bisect ▸**: chưa có phiên thì **Start: Mark Bad** / **Start: Mark Good**
  (`git bisect start` rồi `bad` / `good <hash>`); đang bisect thì **Mark Bad / Mark Good / Skip** cho commit được chọn,
  **Run Script…**, **Reset Bisect**.
- Banner ở Commit panel (cùng chỗ với banner merge / rebase): "Bisecting: ~N revisions left (~S steps)", hash và tiêu đề
  commit đang được kiểm tra, các nút **Good / Bad / Skip / Run Script… / Reset** (Reset đưa về branch lúc bắt đầu).
  Trạng thái đọc từ `BISECT_START` / `BISECT_LOG` (`git rev-parse --git-path`, chạy được với worktree).
- Khi git báo `<hash> is the first bad commit`: thông báo kèm nút **Show in Log**, banner giữ kết quả cho tới khi bạn Reset.
- Trong Log, commit đã đánh dấu có nhãn `good` (xanh) / `bad` (đỏ) / `skip` (xám), lấy từ `refs/bisect/*`.
- **Run Script…**: `git bisect run sh -c "<lệnh>"` (exit 0 = good, 125 = skip, 1–127 khác = bad); output vào Console.
- Thay đổi cục bộ chặn checkout thì app báo rõ ("Local changes block the bisect checkout") thay vì lỗi thô của git;
  banner hiện commit cần kiểm tra chưa được checkout và nút **Retry Checkout**.

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
    entities/     # FileChange, Commit, Branch, RepoStatus, RebasePlan, ReflogEntry, LogQuery, AiConfig, Shelf, PatchFile,
                  # MergeOptions, CleanEntry, Worktree, BisectState, ...
    logic/        # thuật toán thuần: diff engine, graph layout, conflict parser, line selection, rebase todo,
                  # parse reflog, filter log (author, ngày), định dạng shelf.json, parse / lọc patch,
                  # parse git clean -n / worktree list / BISECT_LOG
    repositories/ # interface: GitRepository, GitService, ShelfRepository, CommitMessageGenerator, SettingsStore
    usecases/     # CommitChanges, GenerateCommitMessage, GetSelectedLineContents, InteractiveRebase, CompareCommits,
                  # ShelveChanges, UnshelveChanges, CreatePatch, ApplyPatch, MergeBranch, CleanWorkingTree,
                  # BisectCommits
    errors.dart   # GitException, AiException, StaleSelectionException, CommitRejected, RebaseRejected,
                  # ShelfRejected, PatchRejected, MergeRejected, CleanRejected, BisectRejected
  data/           # implementation các interface của domain
    datasources/  # GitProcess (chạy git), client Claude / Gemini
    repositories/ # GitCliRepository, GitCliService, FileShelfRepository, JsonFileSettingsStore (%APPDATA%/git_tools)
  presentation/
    app.dart, app_scope.dart  # widget gốc + InheritedWidget cấp GitService / AI cho UI
    state/        # RepoController (state + gọi use case), LogFilter, AppSettings
    ui/           # commit/, diff/, log/, shelf/, branches/, conflicts/, dialogs/, console/, workspace_page.dart
test/             # unit test domain/use case (repo giả) + test tích hợp chạy git thật trên repo tạm
```

Quy tắc:
- UI và `RepoController` chỉ làm việc với interface trong `domain/repositories`, không gọi
  `GitProcess` hay lệnh git thô. Cần lệnh git mới thì thêm method vào `GitRepository` rồi
  implement trong `GitCliRepository`.
- Logic nghiệp vụ có nhiều bước (kiểm tra điều kiện commit, gom diff cho AI, ...) đặt trong
  `domain/usecases`; thao tác git một bước thì `RepoController` gọi thẳng `GitRepository`.
- Chỉ `main.dart` được import `data/`.
