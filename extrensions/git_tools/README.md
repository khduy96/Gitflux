# Git Tools (Android Studio style) — Hướng dẫn sử dụng

Extension cho VS Code mang Git tool window kiểu Android Studio vào VS Code:

- Panel **Commit**: tick chọn file để commit, không cần thao tác staging.
- **Changelists** kiểu Android Studio: chia file thay đổi thành nhiều nhóm, mỗi nhóm một commit message nháp.
- **Git LFS**: nhãn LFS trên file, Track / Untrack, Pull / Fetch / Prune, khoá file (lock).
- **Ký commit** bằng GPG, SSH hoặc X.509, huy hiệu chữ ký trong Log.
- **Log** có đồ thị nhánh, lọc theo tác giả / ngày, tìm commit theo nội dung thay đổi, so sánh hai commit bất kỳ.
- **Reflog**: tìm lại commit bị mất sau reset, rebase, drop, amend.
- Popup **Branches**.
- Push / Update Project.
- Stash.
- **Shelve** (cất thay đổi theo từng file, kiểu Android Studio) và mục **Shelf**.
- **Create Patch / Apply Patch**: xuất thay đổi hoặc commit ra file patch, áp dụng patch (kể cả `git am`).
- Merge tool 3 cột.
- **Interactive rebase**: sửa message commit cũ, squash, fixup, đổi thứ tự, drop nhiều commit.
- Hộp thoại **Merge…** với tuỳ chọn fast-forward only, no fast-forward, squash, no commit, commit message.
- **Clean Working Tree**: xoá file chưa theo dõi, có danh sách xem trước và chọn từng mục.
- **Worktrees**: nhiều thư mục làm việc cho một repo (`git worktree`).
- **Bisect**: tìm commit gây lỗi bằng cách đánh dấu good / bad ngay trong Log.
- **Annotate with Git Blame**: xem từng dòng do commit nào, ai, khi nào viết.
- **AI tự viết commit message** bằng Claude hoặc Google Gemini.

Phiên bản: 0.4.2 · Yêu cầu: VS Code **1.90 trở lên** và **Git** đã cài (lệnh `git` chạy được trong terminal).

---

## Mục lục

1. [Cài đặt](#1-cài-đặt)
2. [Giao diện tổng quan](#2-giao-diện-tổng-quan)
3. [Commit](#3-commit) · [Changelists](#3b-changelists)
4. [Xem diff](#4-xem-diff)
5. [Log và lịch sử commit](#5-log-và-lịch-sử-commit)
6. [Branches](#6-branches) · [Worktrees](#6b-worktrees)
7. [Push, Update Project, Fetch](#7-push-update-project-fetch)
8. [Stash](#8-stash) · [Submodules](#8b-submodules-gitmodules) · [Shelve và Shelf](#8c-shelve-và-shelf) · [Patch](#8d-create-patch--apply-patch) · [Git LFS](#8e-git-lfs)
9. [Merge, rebase và giải quyết conflict](#9-merge-rebase-và-giải-quyết-conflict) · [Interactive rebase](#9b-interactive-rebase-sửa-lịch-sử-commit) · [Bisect](#9c-bisect-tìm-commit-gây-lỗi) · [Thao tác nhanh](#9d-thao-tác-nhanh)
10. [AI commit message](#10-ai-commit-message) · [Ký commit](#10b-ký-commit-gpg--ssh--x509)
11. [Cài đặt (Settings)](#11-cài-đặt-settings)
12. [Danh sách lệnh](#12-danh-sách-lệnh)
13. [Xử lý sự cố](#13-xử-lý-sự-cố)
14. [Giới hạn hiện tại](#14-giới-hạn-hiện-tại)
15. [Dành cho người phát triển](#15-dành-cho-người-phát-triển)

---

## 1. Cài đặt

### Cách 1 — Cài từ file `.vsix` (khuyên dùng)

File `git-tools-as-0.4.2.vsix` nằm trong thư mục extension.

**Trong VS Code:**
1. Mở view Extensions (`Ctrl+Shift+X`).
2. Bấm `…` ở góc trên view.
3. Chọn **Install from VSIX…** và chọn file `.vsix`.

**Hoặc bằng terminal:**

```bash
code --install-extension git-tools-as-0.4.2.vsix
```

Sau khi cài, nếu VS Code yêu cầu thì bấm **Reload**. Biểu tượng **Git Tools** sẽ xuất hiện trên thanh activity bar bên trái.

### Cách 2 — Chạy trực tiếp từ thư mục mã nguồn (không cần cài)

Extension viết bằng JavaScript thuần, không cần `npm install` hay build:

```bash
code --extensionDevelopmentPath="<đường-dẫn>/extrensions/git_tools" "<thư-mục-repo-của-bạn>"
```

Lệnh trên mở một cửa sổ VS Code có tiêu đề `[Extension Development Host]` với extension đã được nạp.

### Gỡ cài đặt

Vào view Extensions, chọn **Git Tools (Android Studio style)** rồi bấm **Uninstall**. Hoặc dùng terminal:

```bash
code --uninstall-extension local.git-tools-as
```

> Workspace phải được **tin cậy** (Workspace Trust). Ở Restricted Mode, VS Code tắt extension này, cũng như tắt Git tích hợp.

---

## 2. Giao diện tổng quan

| Vị trí | Thành phần | Tương ứng Android Studio |
|---|---|---|
| Activity bar ▸ **Git Tools** ▸ **Source Control Repositories** | Danh sách mọi repository trong workspace, kể cả repo con. Repo đang chọn có dấu ✓ | Danh sách repository / VCS roots |
| Activity bar ▸ **Git Tools** ▸ **Commit** | Danh sách thay đổi, ô commit message, nút Commit | Commit tool window (Alt+0) |
| Activity bar ▸ **Git Tools** ▸ **Branches** | HEAD, Local, Remote, Tags, Stashes, Shelf, Reflog | Cây branch trong Git tool window |
| Panel dưới ▸ **Git Tools** ▸ **Log** | Lịch sử commit có đồ thị nhánh | Git ▸ Log (Alt+9) |
| Thanh trạng thái, góc trái: `⑂ main 2↑ 1↓` | Branch hiện tại, số commit chưa push ↑ và chưa pull ↓. Bấm vào để mở popup Branches | Branch widget |
| Output ▸ **Git Tools** | Mọi lệnh git đã chạy kèm kết quả | Tab Console |

**Mở Log:**
- Command Palette (`Ctrl+Shift+P`) ▸ **Git Tools: Show Git Log**; hoặc
- Menu **View ▸ Open View… ▸ Log**; hoặc
- Bấm một branch trong cây Branches.

### Source Control Repositories

View đầu tiên trong Git Tools liệt kê mọi repository tìm thấy:
- Thư mục gốc của workspace, cộng các repo con nằm sâu tới số cấp đặt trong setting `gitTools.repositoryScanMaxDepth` (mặc định 1 cấp).
- Các repo bạn tự mở thêm.

Mỗi repo chiếm một dòng, gồm:
- **✓** nếu đây là repo đang chọn;
- tên repo (repo con có kèm đường dẫn mờ bên cạnh);
- **branch widget** giống thanh trên cùng của app Git Tools: `⑂ main ↑2 ↓1 ▾`:
  - ↑ (màu xanh lá) là số commit chưa push;
  - ↓ (màu xanh dương) là số commit chưa pull;
  - rê chuột lên widget để xem branch đang tracking (`Tracking origin/main`), hoặc dòng `No upstream branch` nếu chưa có upstream;
- bên cạnh widget: nhãn MERGING / REBASING nếu đang dở, số conflict, số file thay đổi, hoặc thao tác đang chạy.

| Thao tác | Cách làm |
|---|---|
| Chọn repo làm việc | Click vào dòng. View Commit, Branches, Log và thanh trạng thái chuyển sang repo đó |
| Mở popup Branches của repo | Click vào branch widget `⑂ main ▾` |
| Fetch / Pull / Push nhanh | Các nút ⟳ ↙ ↗ hiện ở cuối dòng khi rê chuột. Thao tác chạy trên đúng repo đó, kể cả khi repo không được chọn |
| Menu chuột phải | Select Repository, Branches…, Fetch, Update Project / Pull…, **Drop Local and Take origin/x…** (khi branch hiện tại ↑ và ↓ so với upstream; **Abort and Take origin/x…** khi pull đang dừng vì conflict), Push…, Refresh, Open in Integrated Terminal, Reveal in File Explorer, Close Repository |
| Thêm repo ngoài workspace | Nút **+ Open Repository…** trên thanh tiêu đề view |
| Ẩn repo khỏi danh sách | **Close Repository**. Lựa chọn được nhớ theo workspace |
| Hiện lại repo đã ẩn | `…` trên thanh tiêu đề ▸ **Reopen Closed Repositories** |

Khi mở một file trong editor, extension tự chuyển sang repo chứa file đó.

Dữ liệu tự làm mới khi file hoặc thư mục `.git` thay đổi (kể cả khi bạn chạy git từ terminal) và khi cửa sổ VS Code được focus lại. Làm mới thủ công bằng nút ⟳ trên view.

---

## 3. Commit

View **Commit** có các nhóm:

- **Merge Conflicts** — chỉ xuất hiện khi có conflict. Link **Resolve** mở công cụ giải quyết conflict.
- **Changelists** (mặc định chỉ có **Changes**) — file đã được git theo dõi và có thay đổi, chia theo changelist (xem [mục 3b](#3b-changelists)). File của **changelist đang active** được tick sẵn, file của changelist khác thì không.
- **Unversioned Files** — file mới chưa được theo dõi. **Mặc định không tick.**

Chỉ các file **được tick** mới được commit. Bạn không cần stage: extension tự `git add` và commit đúng các file đã chọn, giống Android Studio.

### Group by

Nút trên thanh tiêu đề view Commit dùng để chuyển cách hiển thị. Lựa chọn được nhớ lại cho lần sau.

- **Danh sách phẳng** (biểu tượng ☰, mặc định): mỗi file một dòng, thư mục hiện mờ bên cạnh tên file.
- **Group by Directory** (biểu tượng cây):
  - File được xếp theo cây thư mục. Thư mục chỉ có một nhánh con được gộp thành một dòng, ví dụ `android/app/src/main`.
  - Checkbox của thư mục tick / bỏ tick mọi file bên trong. Ô hiện trạng thái lưng chừng khi chỉ một phần file được tick.
  - Click vào dòng thư mục để thu gọn hoặc mở ra.

### Thao tác

| Thao tác | Cách làm |
|---|---|
| Xem diff một file | Click file (mở dạng preview tab). Double-click hoặc `Enter` để mở tab cố định |
| Chọn nhiều file | `Ctrl+Click`, `Shift+Click`, `Ctrl+A` |
| Tick / bỏ tick | Checkbox, hoặc `Space` cho các file đang chọn. Checkbox ở dòng nhóm áp dụng cho cả nhóm |
| Di chuyển | `↑` / `↓` |
| Rollback file đang chọn | `Delete`, hoặc chuột phải ▸ **Rollback…** |
| Đưa file mới vào Git (Add to VCS) | **Kéo file từ Unversioned Files thả vào Changes**, hoặc chuột phải ▸ **Add to VCS**, hoặc `Ctrl+Alt+A`. File chuyển sang nhóm Changes (trạng thái *added*) và được tick sẵn |
| Bỏ theo dõi file vừa thêm | **Kéo file *added* từ Changes thả về Unversioned Files** (`git rm --cached`, file trên đĩa vẫn giữ nguyên) |
| Đưa cả thư mục vào Git | Khi **Group by Directory**: kéo **dòng thư mục** trong Unversioned Files thả vào Changes. Mọi file trong thư mục đó, kể cả thư mục con, được thêm vào Git. Thư mục ở Changes chỉ chứa file *added* cũng kéo ngược về được |
| Đưa toàn bộ file mới vào Git | Kéo **dòng tiêu đề Unversioned Files** thả vào một changelist: mọi file trong nhóm được thêm vào Git, vào đúng changelist đó (trừ repo con lồng bên trong). Kéo dòng tiêu đề của một changelist sang changelist khác để chuyển toàn bộ file của nó (file conflict ở lại) |
| Commit | Nút **Commit** hoặc `Ctrl+Enter` trong ô message |
| Commit rồi push | **Commit and Push…** |
| Sửa commit trước | Tick **Amend**. Nếu ô message đang trống, message cũ được điền sẵn |
| Thêm dòng `Signed-off-by` | Tick **Sign-off** (`git commit --signoff`) |
| Ký commit | Tick **Sign commit** (`-S`); bỏ tick thì commit không ký (`--no-gpg-sign`) kể cả khi `commit.gpgsign = true`. Mặc định theo `commit.gpgsign`. Xem [mục 10b](#10b-ký-commit-gpg--ssh--x509) |
| Chuyển file sang changelist khác | `F6`, chuột phải ▸ **Move to Another Changelist…**, hoặc kéo thả giữa các nhóm changelist |

### Menu chuột phải trên file

- Show Diff
- Show Staged Diff / Show Unstaged Diff — chỉ có khi file vừa có phần đã stage vừa có phần chưa stage (ví dụ stage bằng công cụ khác rồi sửa tiếp). Xem [mục 4](#4-xem-diff).
- Open File
- Resolve Conflicts…
- Include in Commit / Exclude from Commit
- Rollback… — đưa file về trạng thái HEAD. Với file mới thêm, bạn được chọn giữ hay xoá bản trên đĩa.
- Shelve Changes… / Create Patch… / Copy as Patch to Clipboard — xem [mục 8c](#8c-shelve-và-shelf) và [mục 8d](#8d-create-patch--apply-patch).
- Delete… và Add to .gitignore — chỉ có với file chưa được theo dõi.
- Show History — mở Log lọc theo file.
- Annotate with Git Blame — xem [mục 4](#annotate-git-blame).
- Move to Another Changelist…  `F6` — xem [mục 3b](#3b-changelists).
- Track with LFS… / Untrack from LFS… / Lock / Unlock — chỉ có khi máy cài Git LFS, xem [mục 8e](#8e-git-lfs).
- Copy Path
- Reveal in Explorer View

Chuột phải **dòng thư mục** (khi Group by Directory) hoặc **dòng nhóm** (Changes, Unversioned Files) cũng có menu: Include / Exclude, Shelve Changes…, Create Patch…, Copy as Patch to Clipboard, Rollback…, áp dụng cho mọi file bên dưới. Nhóm **Unversioned Files** có thêm **Clean Unversioned Files…** (xem mục Clean bên dưới).

### Thanh tiêu đề view Commit

- **✨** — sinh commit message bằng AI (xem [mục 10](#10-ai-commit-message)).
- **Stash Changes…**
- **Shelve Changes…** — shelve các file đang tick.
- **⟳ Refresh**
- **Group by Directory / Group by: None** — xem mục Group by ở trên.
- **Collapse All / Expand All** — một nút đổi qua lại: thu gọn hoặc mở hết các nhóm, và mọi thư mục khi Group by Directory.
- Trong menu `…`:
  - New Changelist… / Set Active Changelist… / Show Empty Changelists (Hide Empty Changelists)
  - Update Project
  - Push
  - Fetch
  - Create Patch from Ticked Files… / Copy Patch of Ticked Files to Clipboard
  - Apply Patch… / Apply Patch from Clipboard
  - Show Shelf
  - Clean Working Tree…
  - Select Repository
  - AI Commit Message: Configure / Setup Guide
  - Signing Settings… — xem [mục 10b](#10b-ký-commit-gpg--ssh--x509)
  - **LFS ▸** Pull / Fetch / Prune… / Show Tracked Patterns… — chỉ hiện khi máy cài Git LFS

### Clean Working Tree (xoá file chưa theo dõi)

Mở bằng: chuột phải nhóm **Unversioned Files** ▸ **Clean Unversioned Files…**, menu `…` của view Commit ▸ **Clean Working Tree…**, hoặc lệnh **Git Tools: Clean Working Tree…**.

1. Hộp chọn liệt kê đúng những gì `git clean -n` sẽ xoá. Mỗi mục có checkbox, mặc định tick hết; bỏ tick mục nào thì mục đó được giữ lại.
2. Hai nút trên thanh tiêu đề hộp chọn đổi tuỳ chọn, danh sách được tính lại ngay:
   - Biểu tượng con mắt — **Include ignored files** (`-x`, mặc định tắt): xoá cả file bị `.gitignore` bỏ qua (thư mục build, file log…).
   - Biểu tượng thư mục — **Remove untracked directories** (`-d`, mặc định bật): xoá cả thư mục chưa theo dõi. Tắt thì chỉ xoá file.
3. **Repo lồng nhau** (thư mục có `.git` riêng) được liệt kê nhưng **không tick sẵn**. Nếu bạn tick, extension cảnh báo riêng vì cả lịch sử của repo đó sẽ mất (`git clean -ff`).
4. Bấm Enter, xác nhận số mục sẽ xoá. **Không hoàn tác được.**

File đã được git theo dõi không bao giờ bị đụng tới. Tuỳ chọn được nhớ trong phiên làm việc.

### Chọn từng dòng để commit (partial commit)

Giống Android Studio, bạn có thể commit **chỉ một số dòng** của một file. Các dòng còn lại vẫn nằm trong working copy để commit sau.

1. Chuột phải file trong view Commit ▸ **Select Lines to Commit…**. Hoặc mở file trong editor rồi chuột phải tab ▸ **Select Lines to Commit…**, hay Command Palette ▸ **Git Tools: Select Lines to Commit…**.
2. Panel **Commit Lines** hiện diff của file:
   - Mỗi dòng thêm (+) hoặc xoá (−) có một checkbox. Click vào dòng để bật/tắt; `Shift+Click` để bật/tắt cả một khoảng.
   - Mỗi đoạn thay đổi (hunk) có checkbox ở đầu đoạn để chọn cả đoạn. Ô hiện lưng chừng khi chỉ chọn một phần.
   - Dòng **không chọn** hiện mờ và gạch ngang, nghĩa là sẽ không được commit.
   - Có các nút **Select All / Select None**, **Open Diff**, **Open File**, **Go to Commit**.
3. Trong view Commit, file chỉ chọn một phần có checkbox lưng chừng và nhãn `3/7 lines`. Bấm vào nhãn để mở lại panel.
4. Bấm **Commit** như bình thường. Chỉ những dòng đã chọn được commit.

Lưu ý:
- Chỉ áp dụng cho file **đã có trong git và bị sửa** (*modified*). File mới, file bị xoá, file đổi tên, file nhị phân thì commit cả file.
- Tick hoặc bỏ tick checkbox của cả file trong view Commit sẽ bỏ lựa chọn theo dòng (quay về cả file hoặc không gì).
- Nếu bạn sửa file sau khi đã chọn dòng, lựa chọn được giữ cho những dòng vẫn còn nguyên. Khi commit, nếu file đã thay đổi so với lúc chọn, extension báo và mở lại panel để bạn xem lại.
- Không dùng được khi đang merge / rebase (lúc đó git phải commit cả file).
- Extension commit qua một index tạm, nên **index thật của bạn không bị thay đổi**: những gì bạn đã stage bằng công cụ khác vẫn giữ nguyên, và git hooks (pre-commit, commit-msg) vẫn chạy.
- Nút ✨ AI chỉ đưa các dòng đã chọn vào nội dung gửi cho AI.

---

## 3b. Changelists

Giống Android Studio, file thay đổi (đã được git theo dõi) được chia thành nhiều **changelist**. Mỗi changelist là một nhóm trong view Commit, hiện tên và số file; changelist **đang active** in đậm kèm chữ *(active)*. Changelist mặc định tên **Changes**, đổi tên được nhưng không xoá được.

- **File mới thay đổi** tự vào changelist đang active **tại lúc nó xuất hiện**. Đổi changelist active sau đó không kéo file cũ theo.
- **Đổi tên file** (`git mv`): tên mới thay chỗ tên cũ trong changelist của nó. File hết thay đổi (đã commit, rollback…) tự rời changelist.
- **File chưa theo dõi** (Unversioned Files) không thuộc changelist nào.
- **Changelist trống** (trừ cái đang active) được ẩn; bật **Show Empty Changelists** trong menu `…` để hiện.
- **Group by Directory** vẫn dùng được bên trong từng changelist.

**Chuột phải dòng tên changelist:**

| Lệnh | Ý nghĩa |
|---|---|
| Set Active Changelist | Changelist này thành active. **Ô tick đổi thành đúng các file của changelist này.** Message đang gõ được lưu làm nháp của changelist cũ, ô message nạp nháp của changelist mới |
| New Changelist… | Tạo changelist mới: tên, message nháp, có thể đặt active luôn |
| Edit Changelist… | Đổi tên, message nháp, hoặc đặt active |
| Delete Changelist… | Hỏi xác nhận. File của nó chuyển sang changelist đang active (xoá changelist đang active thì file về **Changes**, và **Changes** thành active) |
| Shelve Changes… | Shelve cả changelist; tên shelf mặc định là tên changelist. Khi unshelve, file quay về changelist cùng tên với shelf nếu còn, nếu không thì vào changelist đang active |
| Create Patch… / Copy as Patch to Clipboard | Patch của cả changelist |
| Include / Exclude, Rollback… | Như với nhóm Changes |

**Chuyển file giữa các changelist:** chọn file (nhiều file, hoặc dòng thư mục khi Group by Directory) ▸ `F6` hoặc chuột phải ▸ **Move to Another Changelist…** ▸ chọn changelist có sẵn hoặc **New Changelist…**. Cũng có thể **kéo thả** file / thư mục từ nhóm changelist này sang nhóm khác. Kéo file từ **Unversioned Files** thả vào một changelist = thêm vào Git và đưa vào đúng changelist đó.

**Commit:** chỉ file được tick mới được commit, nên commit changelist active không đụng tới file của changelist khác. Sau khi commit, nếu một changelist (không phải **Changes**) trở nên trống, extension hỏi **Delete changelist '…'?** — chọn **Delete**, **Keep**, hoặc **Keep, Don't Ask Again This Session** (không hỏi lại tới khi đóng VS Code). Chọn từng dòng để commit vẫn hoạt động như cũ.

**Lưu ở đâu:** `.git/git-tools/changelists.json` (đường dẫn của `git rev-parse --git-path git-tools/changelists.json`, nên mỗi worktree có danh sách riêng), không bao giờ bị commit. Định dạng dùng chung với app Git Tools (Flutter): hai bên đọc / ghi cùng file, thay đổi ở bên này hiện ở bên kia sau lần làm mới. Các trường lạ (do phiên bản khác ghi) được giữ nguyên. File hỏng (không phải JSON) **không bị ghi đè**: lỗi được ghi ra Git Console và thao tác changelist bị từ chối tới khi sửa file.

---

## 4. Xem diff

Diff dùng trình so sánh có sẵn của VS Code, nên có đủ side-by-side / inline, điều hướng thay đổi và các tính năng khác của VS Code.

- **Diff working tree** có tiêu đề `file (HEAD ↔ Working Tree)`. Bên phải là file thật, sửa trực tiếp được; bạn cũng có thể dùng nút revert từng đoạn của VS Code.
- **Diff trong commit** có tiêu đề `file (parent ↔ commit)`.
- File mới hiện bên trái rỗng; file bị xoá hiện bên phải rỗng.
- File vừa có phần **đã stage** vừa có phần **chưa stage** (trạng thái `MM`): click vẫn mở `HEAD ↔ Working Tree` (toàn bộ thay đổi). Chuột phải ▸ **Show Staged Diff** mở `HEAD ↔ Index` (phần đã stage, nội dung lấy bằng `git show :<file>`), **Show Unstaged Diff** mở `Index ↔ Working Tree` (phần chưa stage).

### Annotate (Git Blame)

Mở bằng lệnh **Annotate with Git Blame**: chuột phải tab editor, chuột phải trong editor, chuột phải file trong Explorer hoặc trong view Commit, hay Command Palette. Chạy lại lệnh để tắt.

- Trước mỗi dòng hiện `hash-ngắn  tác-giả  ngày` (tên tác giả dài bị cắt). Các dòng liền nhau cùng một commit chỉ ghi ở dòng đầu.
- Màu nền theo tuổi commit: commit cũ nhất của file nhạt nhất, mới nhất đậm nhất. Dòng chưa commit ghi *Not Committed Yet*.
- File đang sửa chưa lưu vẫn annotate đúng (gửi nội dung editor cho `git blame --contents -`). Annotation tự cập nhật khi bạn gõ, lưu hoặc commit.
- Rê chuột vào phần annotation (đầu dòng) để xem hash, tác giả, ngày, toàn bộ message, kèm link **Show in Log** và **Show Diff** (diff của file trong commit đó).
- Click vào annotation của một dòng sẽ chọn commit đó trong Log (khi Log đang hiện).

---

## 5. Log và lịch sử commit

View **Log** gồm 3 phần:

1. **Thanh lọc:**
   - Ô tìm kiếm, với dropdown chọn kiểu tìm ở bên trái:
     - **Message / hash / author** (mặc định) — lọc ngay trong các commit đã tải theo message, hash, tác giả, email hoặc tên ref.
     - **Changes containing text** — tìm commit có **thay đổi** thêm hoặc bớt đoạn text đó (`git log -S`), trên toàn bộ lịch sử chứ không chỉ các commit đã tải. Tick **Regex (-G)** để tìm commit có dòng thay đổi khớp biểu thức chính quy (`git log -G`). Cần gõ ít nhất 2 ký tự; lệnh chạy sau khi ngừng gõ chưa tới nửa giây, hoặc khi bấm `Enter`. **Không** phân biệt hoa thường (git chạy với `-i`).
   - Dropdown **Branch** — All, HEAD hoặc một branch cụ thể. Branch hiện dạng cây thư mục theo tên (`Local ▸ feature ▸ login`, `Remote ▸ origin ▸ main`). Bấm thư mục để mở / đóng, trạng thái được nhớ lại. Gõ vào ô tìm để lọc branch. Phím: ↑ / ↓ chọn, ← / → đóng / mở thư mục, Enter áp dụng, Esc đóng.
   - Dropdown **User** — All, **Me** (`user.name` / `user.email` trong config git), các tác giả của những commit đã tải (nhiều commit nhất ở trên), hoặc **Select…** để gõ một phần tên hay email. Khớp tên **hoặc** email, không phân biệt hoa thường.
   - Dropdown **Date** — All, Last 24 hours, Last 7 days, Last 30 days, hoặc **Select…** để nhập ngày bắt đầu / kết thúc dạng `YYYY-MM-DD` (bỏ trống một trong hai được; cả hai ngày đều được tính). Lọc theo ngày commit (committer date).
   - Lọc User, Date và Changes chạy **trong git** (`--author`, `--since`, `--until`, `-S` / `-G`), nên tìm được cả commit nằm ngoài số commit đã tải (`gitTools.log.maxCommits`). Các bộ lọc kết hợp với nhau và với Branch / Path.
   - Mỗi bộ lọc đang bật hiện thành chip (`User: Me ×`, `Date: Last 7 days ×`, `Changes containing: foo ×`); bấm `×` để bỏ. **Reset filters** bỏ hết mọi bộ lọc.
   - Bộ lọc được nhớ riêng cho từng repo đến khi đóng VS Code.
   - Chip **Path** khi đang xem lịch sử một file. Bấm `×` để bỏ lọc.
2. **Bảng commit:**
   - Đồ thị nhánh có màu.
   - Nhãn ref màu: HEAD vàng, branch local xanh lá, remote tím, tag xanh dương.
   - Nhãn ref được thu gọn để không che subject: chỉ hiện **một** tên (ưu tiên branch hiện tại, rồi branch local, branch chỉ có trên remote, tag) và `+N` cho phần còn lại. Branch local và branch remote cùng tên gộp thành một nhãn, icon **màn hình** = có branch local, icon **mây** = có trên remote (`origin/main`). Rê chuột vào nhãn để xem đầy đủ mọi ref.
   - Khi đang lọc theo một branch (dropdown **Branch**), mỗi dòng chỉ hiện nhãn của branch đó.
   - Các cột message, tác giả, thời gian, hash.
   - Commit HEAD được in đậm.
   - **Huy hiệu chữ ký** cạnh hash: ✓ xanh lá = chữ ký tốt (`G`), ✓ vàng = chữ ký đúng nhưng khoá chưa được tin cậy / đã hết hạn (`U` / `X` / `Y`), ✗ đỏ = chữ ký sai, khoá bị thu hồi hoặc không kiểm tra được (`B` / `R` / `E`), không có gì = commit không ký. Chỉ các dòng đang hiện trên màn hình mới được kiểm tra (kiểm chữ ký chậm), sau khi ngừng cuộn một chút.
   - Khi đang lọc bằng ô tìm kiếm, User, Date hoặc Changes, đồ thị được ẩn đi.
3. **Chi tiết commit** (bên phải, kéo thanh chia để đổi độ rộng):
   - Danh sách file thay đổi. Click để xem diff; với merge commit thì so với parent đầu tiên.
   - Message đầy đủ, tác giả, committer, parent.
   - Chữ ký: trạng thái, người ký, khoá, mức tin cậy. Tag có chữ ký trên commit được kiểm tra bằng `git tag -v`.
   - Các branch chứa commit.

**Phím tắt trong bảng:**
- `↑` / `↓`, `PageUp` / `PageDown` — di chuyển.
- `Ctrl+Click` / `Shift+Click` — chọn nhiều commit.
- `Ctrl+Alt+Shift+C` — copy hash.

### Menu chuột phải trên commit

| Lệnh | Ý nghĩa |
|---|---|
| Copy Revision Number | Copy hash (nhiều commit thì cách nhau bằng dấu cách) |
| Cherry-Pick | Áp dụng commit đã chọn vào branch hiện tại, theo thứ tự cũ đến mới |
| Create Patch… | Xuất 1 hoặc nhiều commit đã chọn thành **một** file patch dạng mailbox (`git format-patch --stdout`), cũ trước mới sau. Merge commit bị bỏ qua. Xem [mục 8d](#8d-create-patch--apply-patch) |
| Checkout Revision | Checkout commit (detached HEAD) |
| Compare with Local | Liệt kê commit hai phía và các file khác nhau giữa commit đó và HEAD |
| Compare Commits | Chọn đúng **2 commit** (`Ctrl+Click`), không cần commit này là tổ tiên của commit kia. Mở danh sách file khác nhau (`git diff --name-status -M`, có nhận biết đổi tên) với chữ trạng thái **M / A / D / R**; tiêu đề là `<commit cũ hơn> ↔ <commit mới hơn>` (theo ngày commit). Chọn file để mở diff trong trình so sánh của VS Code; danh sách vẫn mở để xem tiếp file khác. Nút ⇄ **Swap Sides** đổi hai bên |
| Reset Current Branch to Here… | Chọn chế độ **Soft / Mixed / Hard / Keep**. Hard hỏi xác nhận lại |
| Revert Commit | Tạo commit đảo ngược |
| Undo Commit… | Chỉ với commit HEAD. Huỷ commit nhưng giữ thay đổi trong working tree |
| Edit Commit Message… | Commit HEAD: sửa nhanh bằng amend. Commit cũ hơn trong lịch sử của branch hiện tại (trừ commit gốc và merge commit): mở ô soạn message nhiều dòng rồi chạy interactive rebase |
| Fixup into Previous | Gộp commit vào commit ngay trước nó, giữ message của commit trước |
| Squash Commits… | Chọn từ 2 commit **liền nhau** trở lên. Gộp thành một commit; ô soạn message được điền sẵn message của các commit, nối bằng một dòng trống |
| Drop Commits | Xoá một hoặc nhiều commit (chọn nhiều bằng `Ctrl+Click`) khỏi lịch sử branch hiện tại. Hỏi xác nhận trước |
| Move Commit Up / Move Commit Down | Đổi chỗ commit với commit mới hơn / cũ hơn ngay cạnh nó |
| Interactively Rebase from Here… | Mở panel **Interactive Rebase** cho commit đó và mọi commit mới hơn, xem [mục 9b](#9b-interactive-rebase-sửa-lịch-sử-commit) |
| Merge into Current… | Mở hộp thoại **Merge…** để merge commit đó vào branch hiện tại, xem [mục 9](#hộp-thoại-merge). Mờ khi commit đã nằm trong branch hiện tại |
| Bisect ▸ … | Bắt đầu hoặc tiếp tục bisect, xem [mục 9c](#9c-bisect-tìm-commit-gây-lỗi) |
| New Branch… / New Tag… | Tạo branch hoặc tag tại commit đó. Khi đã cấu hình ký, New Tag hỏi thêm **Sign Tag / Do Not Sign** (mặc định theo `tag.gpgsign`); tag có ký luôn là annotated tag (`git tag -s`) |

Các lệnh sửa lịch sử (từ Edit Commit Message… tới Interactively Rebase from Here…) bị **làm mờ** khi không áp dụng được: commit không nằm trong lịch sử của HEAD, HEAD đang detached, hoặc đang có merge / rebase dở.

### Menu chuột phải trên file trong chi tiết commit

- Show Diff
- Compare with Local
- Show History for File
- Get from Revision — lấy nội dung file ở commit đó ghi đè vào working tree.
- Copy Path

**Xem lịch sử một file:** chuột phải tab editor ▸ **Show History for Current File**, hoặc lệnh **Git Tools: Show History for Current File**.

### Reflog

Reflog ghi lại mọi lần HEAD di chuyển (commit, amend, reset, rebase, checkout…), nên là "lưới an toàn" sau khi sửa lịch sử: commit đã bị reset / drop / amend vẫn còn trong reflog.

Mở bằng: cây **Branches** ▸ **Reflog**, hoặc lệnh **Git Tools: Show Reflog**. Panel **Reflog** liệt kê tối đa 500 mục mới nhất, mỗi dòng gồm:
- selector `HEAD@{n}`, hash rút gọn;
- hành động (`commit`, `commit (amend)`, `reset`, `rebase (finish)`, `checkout`…) và message;
- thời gian tương đối; rê chuột để xem thời gian đầy đủ.

Dropdown **Reflog of** chọn giữa reflog của **HEAD** (mặc định) và của branch hiện tại. Panel tự làm mới cùng repo.

Menu chuột phải trên một mục (double-click = Show in Log):

| Lệnh | Ý nghĩa |
|---|---|
| Show in Log | Chọn commit đó trong Log nếu đã tải. Nếu không (commit không còn branch nào chứa), Log vẫn hiện chi tiết commit: file thay đổi và diff |
| Checkout Revision | Checkout commit (detached HEAD), có Smart Checkout |
| New Branch Here… | Tạo branch tại commit đó: cách **lấy lại commit bị mất** |
| Reset Current Branch to Here… | Chọn chế độ Soft / Mixed / Hard / Keep như trong Log |
| Copy Revision Number | Copy hash |

Mục có commit không còn tồn tại (đã bị `git gc` dọn) hiện mờ, ghi *(commit no longer exists)* và không có thao tác nào.

**Ví dụ lấy lại commit sau khi lỡ `reset --hard`:** Show Reflog ▸ tìm dòng `commit: <message>` của commit bị mất ▸ chuột phải ▸ **New Branch Here…**.

---

## 6. Branches

### Popup Branches

Bấm branch trên thanh trạng thái hoặc chạy lệnh **Git Tools: Branches…**. Popup gồm:

- Hành động nhanh: Update Project, Commit, Push, New Branch, Checkout Tag or Revision.
- Danh sách **Local** và **Remote**:
  - Branch hiện tại xếp đầu.
  - `main` / `master` / `develop` được đánh dấu ★.
  - Mỗi branch hiện số ↑ / ↓ và upstream. Branch đang được checkout ở worktree khác ghi thêm `checked out in <thư mục>`.
- Gõ để tìm branch. Chọn một branch sẽ mở danh sách thao tác.

### Thao tác trên branch

Dùng trong popup hoặc khi chuột phải trong cây Branches:

| Lệnh | Ghi chú |
|---|---|
| Checkout | Branch remote: tự checkout branch local cùng tên nếu đã có, nếu chưa thì tạo branch local tracking |
| New Branch from '…' | Tạo branch mới từ branch hoặc tag đó, có thể checkout luôn |
| Checkout and Rebase onto Current | Checkout branch đó và rebase nó lên branch hiện tại |
| Compare with Current | Commit hai phía và các file khác nhau. Chọn file để xem diff |
| Show in Log | Lọc Log theo branch |
| Rebase Current onto This | Có thể phát sinh conflict, xem [mục 9](#9-merge-rebase-và-giải-quyết-conflict) |
| Merge into Current… | Mở hộp thoại **Merge…** để chọn tuỳ chọn, xem [mục 9](#hộp-thoại-merge) |
| Quick Merge into Current | Merge ngay với tuỳ chọn mặc định của git, không mở hộp thoại (như trước đây) |
| Checkout in New Worktree… | Mở branch trong một thư mục làm việc mới, xem [mục 6b](#6b-worktrees) |
| Update (fast-forward) | Cập nhật branch local từ upstream mà không cần checkout |
| Drop Local and Take origin/x… | Chỉ hiện khi branch local và upstream **đều** có commit mới (↑ và ↓): thay vì pull rồi xử lý conflict, bỏ bản local và lấy đúng bản origin. Fetch, hỏi xác nhận (liệt kê commit chưa push sẽ bị bỏ), xoá branch local và checkout lại từ origin (vẫn tracking origin). Thay đổi chưa commit được stash rồi trả lại; không áp dụng lại được thì giữ trong stash. Khi Update Project / Pull đã dừng vì conflict, thông báo conflict và **Resolve Conflicts** có thêm **Abort and Take origin/x…**. Cho branch hiện tại còn có ở menu chuột phải của **Source Control Repositories** và menu `…` của view **Source Control** của VS Code (**Drop Local and Take Upstream…**, chỉ hiện khi áp dụng được) |
| Push… | Chỉ với branch hiện tại |
| Rename… / Copy Branch Name | |
| Delete | Branch chưa merge sẽ hỏi lại trước khi xoá hẳn. Branch remote sẽ đẩy lệnh xoá lên remote |
| Xoá nhiều branch local | Trong cây Branches, chọn nhiều branch (`Ctrl+Click` / `Shift+Click`) ▸ chuột phải ▸ **Delete**, hoặc phím `Delete` (`⌘⌫` trên macOS). Hỏi xác nhận một lần cho cả danh sách; các branch chưa merge được liệt kê và hỏi **Force Delete** một lần. Branch hiện tại, branch remote và tag trong vùng chọn được bỏ qua |

**Copy tên branch nhanh:** rê chuột lên một tên branch / tag bất kỳ trong các view của extension (nhãn ref trong Log và popup của nó, dropdown **Branch** và danh sách trong đó, "In N branches" ở chi tiết commit, widget branch ở Source Control Repositories, panel Interactive Rebase) rồi nhấn `Ctrl+C` (`⌘C` trên macOS). Có thông báo nhỏ ở cuối view. Nếu đang bôi đen chữ thì `Ctrl+C` vẫn copy chữ như thường. Bấm vào view trước để nó nhận phím. Riêng cây **Branches** (view gốc của VS Code, không biết dòng nào đang được rê chuột): chọn một hoặc nhiều dòng rồi nhấn `Ctrl+C` (nhiều tên thì mỗi tên một dòng).

**Smart Checkout:** nếu checkout bị chặn vì thay đổi chưa commit sẽ bị ghi đè, extension đề nghị **Smart Checkout**: stash thay đổi, checkout, rồi trả lại thay đổi.

Trong cây Branches còn có:
- Nút **Collapse All / Expand All** trên thanh tiêu đề (một nút đổi qua lại): thu gọn hoặc mở hết mọi nhóm và thư mục (Local, Remote, Tags, Stashes, Shelf, Worktrees…).
- Branch Local / Remote được gom thành thư mục theo tiền tố trước dấu `/`: `feature/login`, `feature/cart` → **feature** ▸ `login`, `cart`. Thư mục chứa branch hiện tại tự mở sẵn.
- Mục **Tags**: Checkout, New Branch, Merge into Current… / Quick Merge, Push Tag, Delete Tag.
- Mục **Stashes**: xem [mục 8](#8-stash).
- Mục **Shelf**: xem [mục 8c](#8c-shelve-và-shelf).
- Mục **Worktrees**: xem [mục 6b](#6b-worktrees).
- Mục **Reflog**: mở panel Reflog, xem [mục 5](#reflog).

## 6b. Worktrees

Worktree là một thư mục làm việc thứ hai (thứ ba…) của cùng một repo, mỗi thư mục checkout một branch riêng. Ví dụ đang làm dở `feature/x` mà cần sửa gấp trên `main`: mở `main` ở worktree khác, không phải stash hay commit tạm.

Mục **Worktrees** trong cây Branches liệt kê mọi worktree (`git worktree list --porcelain`): tên thư mục, branch hoặc `detached at <hash>`, và các nhãn **current** (worktree của cửa sổ này), **main worktree**, **locked**, **prunable** (thư mục đã bị xoá). Rê chuột để xem đường dẫn đầy đủ và lý do lock.

| Thao tác | Cách làm |
|---|---|
| Tạo worktree | Nút **+** trên mục Worktrees ▸ **New Worktree…**: chọn branch có sẵn, branch mới (`-b`) từ một điểm bắt đầu, hoặc detached tại một revision; sau đó nhập thư mục (mặc định `../<tên-repo>-<branch>`). Hoặc chuột phải branch ▸ **Checkout in New Worktree…**. Branch remote tạo branch local cùng tên có tracking |
| Mở worktree | **Open in New Window**: mở thư mục đó trong cửa sổ VS Code mới |
| Copy Path | Copy đường dẫn |
| Lock… / Unlock | Khoá để `git worktree prune` không xoá (ví dụ worktree trên ổ USB), có thể ghi lý do |
| Remove… | Hỏi xác nhận. Nếu worktree còn thay đổi chưa commit, hỏi thêm lần nữa rồi mới xoá bằng `--force`. Không xoá được worktree chính và worktree hiện tại |
| Prune Worktrees… | Chuột phải mục Worktrees: hiện trước danh sách sẽ dọn (`git worktree prune -n -v`), xác nhận rồi mới dọn |

Một branch chỉ được checkout ở một worktree tại một thời điểm. Checkout branch đang mở ở worktree khác sẽ hiện thông báo rõ ràng kèm nút **Open that Worktree** thay vì lỗi thô của git.

---

## 7. Push, Update Project, Fetch

**Push…** (lệnh **Git Tools: Push…**):
- Hiện danh sách commit sẽ được push và đích đến `remote/branch`. Đích là branch mới thì có ghi `(new)`.
- Các lựa chọn:
  - **Push**.
  - **Force Push** — dùng `--force-with-lease` và hỏi xác nhận.
  - **Push with tags**.
  - **Change remote or target branch…**
- Branch chưa có upstream sẽ được tự đặt upstream (`--set-upstream`).

**Update Project / Pull…** (lệnh **Git Tools: Update Project / Pull…**):
- Chọn **Merge**, **Rebase** hoặc **Fast-forward only**. Lựa chọn lần trước được ghi nhớ.
- Lấy từ upstream của branch. Nếu branch chưa có upstream, extension hỏi bạn chọn branch remote.

**Fetch:** chạy `git fetch --all --prune`.

Khi Git cần đăng nhập, Git Credential Manager tự hiện cửa sổ đăng nhập. Extension không hỏi mật khẩu trong terminal.

---

## 8. Stash

- **Tạo stash:** nút Stash trên view Commit, hoặc lệnh **Git Tools: Stash Changes…**. Nhập message, rồi chọn có kèm file chưa theo dõi (*Include unversioned files*) và/hoặc *Keep index* hay không.
- **Dùng stash:** cây Branches ▸ **Stashes**, chuột phải một stash:
  - **Pop** — áp dụng rồi xoá stash.
  - **Apply** — áp dụng, giữ lại stash.
  - **Show Changes** — xem danh sách file và diff.
  - **Unstash as Branch…**
  - **Drop**

---

## 8b. Submodules (`.gitmodules`)

Extension nhận biết submodule ở mọi nơi:

- **View Commit:** submodule có thay đổi hiện kèm mô tả, ví dụ `submodule · new commits, modified content, untracked content`.
  - Click để xem diff: hai bên hiện commit cũ / mới của submodule cùng tiêu đề commit, và các file đang sửa bên trong submodule.
  - Chuột phải có thêm **Open Submodule** (mở như một repo riêng) và **Update Submodule** (checkout lại commit mà repo cha đang ghi nhận).
  - **Rollback** một submodule cũng đưa nó về commit đã ghi nhận.
  - Không dùng được "Select Lines to Commit…" cho submodule.
- **Commit submodule mới:** muốn repo cha ghi nhận commit mới của submodule thì tick dòng submodule trong view Commit rồi Commit, như một file bình thường.
- **Cây Branches ▸ Submodules:** liệt kê submodule với trạng thái:
  - `not initialized` — chưa init;
  - `out of date` — commit đang checkout khác commit đã ghi nhận;
  - `conflict`;
  - hoặc mã commit nếu mọi thứ khớp.

  Thao tác:
  - Trên từng submodule: **Open**, **Update**, Sync URL from .gitmodules, Copy Path.
  - Trên nhóm: **Update All Submodules**, Sync All Submodule URLs, **Add Submodule…**.
- **Source Control Repositories:** các repo sau tự hiện như repo riêng, ở mọi độ sâu (tắt bằng `gitTools.detectSubmodules`):
  - submodule đã init;
  - submodule có khai báo trong `.gitmodules` nhưng **chưa được đăng ký vào repo cha**: thư mục có `.git` riêng nhưng index của repo cha không ghi nhận. `git submodule status` bỏ qua loại này. Extension đánh dấu chúng là **not registered**, và có mục **Register as Submodule…** (`git submodule add` với repo đã có sẵn).
  - **repo con chưa được theo dõi** (thư mục có `.git` riêng nằm trong repo cha). Trong view Commit, chúng hiện là `nested repository`, không có checkbox và không kéo sang Changes được, vì `git add` một repo con sẽ tạo gitlink mà không có `.gitmodules`. Thay vào đó, dùng chuột phải ▸ **Open Repository** / **Register as Submodule…**.
- **Update Project / Pull:** sau khi pull, extension tự chạy `git submodule update --init --recursive` (tắt bằng `gitTools.submodules.updateOnPull`).
- **Sau checkout / merge / reset:** nếu HEAD của repo cha đổi mà có submodule bị lệch hoặc chưa init, extension hiện thông báo kèm nút **Update Submodules**. Extension không tự cập nhật, để không làm mất trạng thái bạn đang làm dở trong submodule.

> Submodule dùng URL dạng đường dẫn cục bộ (`../lib`, `file://`) có thể bị Git chặn khi update (`protocol.file.allow`). Với URL https/ssh thông thường thì không ảnh hưởng.

---

## 8c. Shelve và Shelf

**Shelve khác stash ở chỗ nào?** Shelve làm việc **theo file**: chỉ cất những file bạn chọn, mỗi lần cất là một mục có tên riêng trong danh sách **Shelf** (không dính tới stack `git stash`), và lấy lại được **từng file một**.

### Shelve Changes

- Chuột phải file (hoặc dòng thư mục / dòng nhóm) trong view Commit ▸ **Shelve Changes…**; hoặc nút **Shelve Changes…** trên thanh tiêu đề view Commit (áp dụng cho các file đang tick); hoặc Command Palette ▸ **Git Tools: Shelve Changes…**.
- Hộp thoại gồm 2 bước:
  1. **Tên shelf** — mặc định là dòng đầu của commit message đang gõ, nếu trống thì `Changes from <yyyy-MM-dd HH:mm>`.
  2. **Danh sách file** — các file bạn đã chọn được tick sẵn, các file thay đổi khác cũng có trong danh sách để tick thêm. Ô **Keep changes in working tree** (mặc định tắt): bật nếu chỉ muốn lưu một bản sao vào shelf mà không đụng tới file.
- Sau khi lưu shelf, nếu không chọn *Keep*, các file đã shelve được **đưa về HEAD**: file sửa / xoá được khôi phục từ HEAD, file mới (kể cả file chưa theo dõi) bị xoá và gỡ khỏi index. File khác và phần index của chúng giữ nguyên.
- Không shelve được khi đang merge / rebase / cherry-pick / revert / `git am` (có thông báo), hoặc khi repo chưa có commit nào.
- File đang chọn từng dòng (`3/7 lines`) được shelve **cả file**, không chỉ các dòng đã chọn.
- Submodule, repo con và file đang conflict bị bỏ qua (có thông báo).

### Shelf

- Cây **Branches** ▸ mục **Shelf** (ngay sau Stashes), hoặc Command Palette ▸ **Git Tools: Show Shelf**.
- Mỗi shelf hiện tên, thời gian tương đối (rê chuột để xem ngày giờ chính xác), số file và branch lúc shelve. Shelf mới nhất ở trên. Mở shelf để xem danh sách file.
- Click một file: mở diff **chỉ đọc** giữa file ở commit gốc của shelf và nội dung đã shelve.
- Chuột phải shelf:
  - **Unshelve…** — chọn file (mặc định tick hết) và ô **Remove successfully applied files from shelf** (mặc định bật).
  - **Apply (Keep in Shelf)** — áp dụng mọi file, shelf giữ nguyên.
  - **Rename…**, **Delete…** (hỏi xác nhận).
  - **Create Patch…** — lưu patch của shelf ra file; **Copy as Patch** — copy vào clipboard.
- Chuột phải file trong shelf: **Unshelve This File**, **Show Diff**.

Unshelve dùng `git apply --3way` với commit gốc của shelf, nên vẫn áp dụng được khi HEAD đã đi tiếp hoặc file đang có thay đổi chưa commit:
- File áp dụng sạch: được bỏ khỏi shelf (nếu bật ô *Remove…*). Phần stage của bạn không đổi: các file này không bị stage.
- File bị conflict: có conflict marker và hiện trong nhóm **Merge Conflicts** của view Commit để giải quyết như merge bình thường; file đó **vẫn ở lại** trong shelf. File mới trong shelf trùng tên với một file chưa theo dõi đang có cũng thành conflict (cả hai nội dung nằm trong file, không mất gì).
- Nếu git từ chối hẳn patch (ví dụ file cần sửa đã bị xoá), extension hiện lỗi của git và **không thay đổi gì**.
- Shelf hết file thì tự bị xoá.

**Lưu ở đâu:** `.git/git-tools/shelf/<id>/` (`shelf.json` + `changes.patch`), dùng chung cho mọi worktree và không bao giờ bị commit. Ref `refs/git-tools/shelf/<id>` giữ commit gốc để `git gc` không xoá mất, kể cả khi commit đó đã bị rebase / reset. Định dạng này dùng chung với app Git Tools (Flutter): shelf tạo ở bên này mở được ở bên kia.

---

## 8d. Create Patch / Apply Patch

### Create Patch

- **Từ file đang thay đổi:** chuột phải file / thư mục / nhóm trong view Commit ▸ **Create Patch…** (lưu ra file, tên mặc định `<branch>.patch`) hoặc **Copy as Patch to Clipboard**. Trên thanh tiêu đề view Commit, menu `…` có **Create Patch from Ticked Files…** / **Copy Patch of Ticked Files to Clipboard** cho các file đang tick. Patch so với HEAD, có cả file mới chưa theo dõi, file xoá và file nhị phân (`git diff --binary`); index và working tree không bị đụng tới.
- **Từ commit:** Log ▸ chọn 1 hoặc nhiều commit ▸ chuột phải ▸ **Create Patch…**. Các commit được xuất bằng `git format-patch --stdout` vào **một** file, commit cũ trước, commit mới sau.

### Apply Patch

- Command Palette ▸ **Git Tools: Apply Patch…** (chọn file) hoặc **Apply Patch from Clipboard**; cũng có trong menu `…` của view Commit và cây Branches.
- Bảng xem trước hiện danh sách file (M / A / D / R, số dòng thêm / bớt) và kết quả chạy thử `git apply --check --3way`: *Applies cleanly*, *Applies with conflicts in …*, hoặc lỗi của git.
- Patch dạng mailbox (tạo bởi `git format-patch`, bắt đầu bằng `From <hash> ` hoặc có header `Subject:`):
  - **Apply as Commits** (mặc định) — `git am --3way`, tạo lại các commit với tác giả và message gốc.
  - **Apply Changes Only** — chỉ áp dụng thay đổi vào working tree, không tạo commit.
- Patch thường (diff): **Apply to Working Tree** — `git apply --3way`; phần stage của bạn không đổi.
- Conflict được đưa sang nhóm **Merge Conflicts** như khi merge. Với `git am`, view Commit hiện banner **"Applying patch 1/3"** kèm nút **Continue** (`git am --continue`), **Skip** (`git am --skip`) và **Abort** (`git am --abort`).

---

## 8e. Git LFS

Các tính năng LFS chỉ hiện khi máy đã cài [Git LFS](https://git-lfs.com) (`git lfs version` chạy được). Không cài thì mọi menu LFS bị ẩn.

- **Nhãn LFS:** trong view Commit, file khớp một pattern LFS (`git check-attr filter` = `lfs`) có nhãn nhỏ **LFS**.
- **Diff file LFS:** mở diff hiện **pointer** của hai phía (`oid`, kích thước). Nếu object của phía HEAD có sẵn trên máy, extension đề nghị **Show Content Diff** để so sánh nội dung thật (ảnh dùng trình so sánh ảnh của VS Code).
- **Track with LFS…** (chuột phải file chưa theo dõi): chọn pattern — đúng đường dẫn file, `*.<đuôi>`, hoặc `<thư mục>/**` — rồi chạy `git lfs track`. File `.gitattributes` đổi và hiện trong danh sách thay đổi để bạn commit.
- **Untrack from LFS…** (chuột phải file có nhãn LFS): chọn pattern khớp với file để gỡ khỏi `.gitattributes`.
- **Menu `…` ▸ LFS ▸** (hoặc Command Palette ▸ **Git Tools: LFS: …**):
  - **Pull** (`git lfs pull`), **Fetch** (`git lfs fetch`).
  - **Prune…** — chạy `git lfs prune --dry-run` trước, liệt kê object sẽ xoá, hỏi xác nhận rồi mới xoá.
  - **Show Tracked Patterns…** — danh sách pattern (`git lfs track`), nút Untrack trên từng dòng, mục *Track Pattern…* để thêm pattern.
- **Khoá file (lock):** chỉ có khi remote hỗ trợ (`git lfs locks` chạy được). Chuột phải file LFS ▸ **Lock** / **Unlock**. File đang bị khoá có dấu 🔒, rê chuột để xem ai khoá. Mở khoá file người khác khoá cần xác nhận rồi mới dùng `--force`. Danh sách khoá cần hỏi server nên chỉ được tải lại tối đa mỗi phút một lần (và ngay sau Lock / Unlock), và chỉ với repo có pattern LFS.
- **Push / Pull:** git tự chạy hook của LFS. Nếu push lỗi vì LFS, thông báo hiện các dòng lỗi của LFS, nút **Show Details** mở toàn bộ stderr.

---

## 9. Merge, rebase và giải quyết conflict

Khi đang merge / rebase / cherry-pick / revert / áp dụng patch bằng `git am`, view Commit hiện banner kiểu **"Merging in progress · 1 conflict"** kèm nút:

- **Resolve…** khi còn conflict.
- **Continue** khi đã giải quyết hết. Với merge, Continue tạo merge commit bằng message mặc định của git (có ký hay không theo ô **Sign commit**).
- **Skip** (chỉ khi rebase hoặc `git am`) — bỏ qua commit / patch đang dừng (`git rebase --skip` / `git am --skip`), có hỏi xác nhận.
- **Abort**.

Khi rebase, banner hiện tiến độ, ví dụ **"Rebasing 2/5"**. Nếu rebase dừng ở commit đánh dấu `edit`, banner ghi thêm *"Stopped at 1a2b3c4d Thêm API for editing — amend, then Continue"*: sửa file, tick **Amend** rồi Commit, sau đó bấm **Continue**.

Trong lúc merge, ô message được điền sẵn message mặc định của git (`Merge branch '…'`). Bạn sửa message rồi bấm **Commit** cũng được.

### Hộp thoại Merge…

Mở bằng **Merge '…' into '…'…** trong popup Branches, **Merge into Current…** khi chuột phải branch / tag trong cây Branches, hoặc **Merge into Current…** khi chuột phải commit trong Log.

- Dòng xem trước: `N commits will be merged`, kèm `Fast-forward possible` khi HEAD là tổ tiên của bên được merge. Không có gì để merge thì extension báo ngay.
- Tuỳ chọn (tick nhiều cái được):
  - **Fast-forward only** (`--ff-only`): chỉ merge khi fast-forward được, nếu không thì báo lỗi và không thay đổi gì.
  - **No fast-forward** (`--no-ff`): luôn tạo merge commit.
  - **Squash** (`--squash`): gom mọi thay đổi thành thay đổi đã stage, **không commit**. Sau đó ô message được điền sẵn nội dung `SQUASH_MSG` của git và extension nhắc bạn bấm Commit.
  - **No commit** (`--no-commit`): dừng trước khi commit để bạn xem lại (banner Merging hiện ra). Tự kèm `--no-ff`, vì fast-forward không dừng được.
  - **Commit message…** (`-m`): chỉ dùng được khi merge sẽ tạo merge commit; sau khi bấm Enter sẽ hỏi message.
- Squash, No fast-forward và Fast-forward only loại trừ nhau: tick cái này thì cái kia tự bỏ. Squash luôn kèm No commit.
- Tuỳ chọn lần trước được nhớ trong phiên làm việc.
- **Quick Merge** vẫn có sẵn để merge ngay với tuỳ chọn mặc định.

### Giải quyết conflict

Mở bằng link **Resolve** ở nhóm Merge Conflicts, hoặc lệnh **Git Tools: Resolve Conflicts…**. Chọn file, sau đó chọn:

- **Merge…** — mở **merge tool 3 cột**:
  - Bên trái: **Yours** (branch hiện tại). Ở giữa: **Result**. Bên phải: **Theirs** (bên được merge vào).
  - Với mỗi đoạn conflict:
    - Bấm **»** để lấy bên trái, **«** để lấy bên phải.
    - Hoặc chọn **Left + Right**, **Right + Left**, **Base** (nếu có), hay **Edit…** để tự sửa.
    - Bấm **Undo** để chọn lại.
  - **Accept Left / Accept Right** áp dụng cho mọi đoạn chưa xử lý. **Next Conflict** nhảy tới đoạn tiếp theo.
  - **Apply** chỉ bấm được khi đã xử lý hết. Bấm Apply sẽ ghi file và đánh dấu đã giải quyết (`git add`).
- **Accept Yours / Accept Theirs** — lấy nguyên một phía cho cả file. Dùng được cả khi một phía đã xoá file.
- **Open in Editor** — sửa marker trực tiếp trong editor, sau đó chọn **Mark as Resolved**.

> Khi **rebase**, git đảo vai trò hai phía: bên trái là *Upstream* (branch bạn đang rebase lên), bên phải là *Your commit*. Merge tool ghi rõ nhãn này.

---

## 9b. Interactive rebase (sửa lịch sử commit)

Giống dialog *Interactively Rebase from Here* của Android Studio. Mở bằng: Log ▸ chuột phải commit cũ nhất muốn sửa ▸ **Interactively Rebase from Here…**, hoặc lệnh **Git Tools: Interactive Rebase…** rồi chọn commit.

Panel **Interactive Rebase** liệt kê commit đó và mọi commit mới hơn trên branch hiện tại, **commit mới nhất ở trên cùng** (giống Log):

- Mỗi dòng gồm: hành động (dropdown), hash, message, tác giả, thời gian.
- Hành động:

  | Hành động | Phím | Ý nghĩa |
  |---|---|---|
  | pick | `P` | Giữ nguyên commit |
  | reword | `R` | Giữ commit, sửa message |
  | edit | `E` | Dừng sau commit này để bạn sửa (amend) |
  | squash | `S` | Gộp vào commit cũ hơn ngay phía dưới, nối message |
  | fixup | `F` | Gộp vào commit cũ hơn ngay phía dưới, giữ message của commit đó |
  | drop | `D` | Bỏ commit |

- Đổi thứ tự: **kéo thả** dòng, hoặc `Alt+↑` (lên = mới hơn) / `Alt+↓` (xuống = cũ hơn), cùng nghĩa với Move Commit Up / Down trong Log. Dòng *squash* / *fixup* có dấu ↓ để chỉ commit phía dưới mà nó được gộp vào. Chọn nhiều dòng (`Ctrl+Click`, `Shift+Click`) rồi bấm phím để đặt cùng một hành động.
- Bên phải là **ô soạn message**: của commit đang *reword*, hoặc của cả nhóm *squash* (mặc định là message các commit trong nhóm nối bằng dòng trống, bỏ message của commit *fixup*). Nút ↺ trả về message mặc định. Với commit khác, ô này chỉ hiện message để tham khảo.
- Lỗi hiện ngay dưới danh sách và nút **Start Rebasing** bị khoá cho tới khi sửa xong. Ví dụ: squash / fixup ở commit cũ nhất (không có commit nào phía dưới để gộp vào), message rỗng. Drop tất cả commit thì được, nhưng có cảnh báo.
- Nút **Reset** trả về thứ tự và hành động ban đầu; **Cancel** đóng panel mà không làm gì.

Cách hoạt động:

- Danh sách lấy từ chính todo mà `git rebase -i` tạo ra: extension chạy rebase "thử" trên một index tạm rồi dừng lại ngay, **không đổi gì** trong repo (HEAD, index, file trong working tree kể cả thời gian sửa, stash). Thứ tự gửi cho git vẫn là cũ trước, mới sau; panel chỉ hiển thị đảo ngược. Sau đó extension chạy `git rebase -i --autostash` với todo bạn đã sửa. Thay đổi chưa commit được tự stash rồi trả lại sau khi rebase.
- Message mới được ghi bằng `git commit --amend`, nên **git hooks** (`pre-commit`, `commit-msg`…) vẫn chạy. Hook từ chối thì rebase dừng lại ở trạng thái đang rebase.
- **Merge commit:** nếu trong khoảng có merge commit, extension dùng `--rebase-merges` để giữ nguyên cấu trúc nhánh. Các dòng `label`, `reset`, `merge`, `update-ref` hiện mờ và chỉ đọc. Bạn chỉ đổi được thứ tự commit **giữa hai dòng như vậy**, không kéo commit qua chúng. Merge commit giữ nguyên (không reword / drop được).
- **Commit đã push:** nếu một trong các commit bị sửa đã có trên upstream (`@{u}`), panel và hộp thoại xác nhận báo rằng sau đó bạn sẽ phải **force push** (Push… ▸ Force Push). Bạn vẫn có thể tiếp tục.
- **Khi rebase dừng** (conflict, commit `edit`, hook hoặc lệnh lỗi): repo ở trạng thái đang rebase, banner trong view Commit hiện tiến độ và các nút Continue / Skip / Abort (xem [mục 9](#9-merge-rebase-và-giải-quyết-conflict)). **Abort** đưa branch về đúng trạng thái trước khi rebase.
- Điều kiện: phải đang ở trên một branch (không detached HEAD) và không có merge / rebase / cherry-pick dở.

Các lệnh nhanh trong menu Log (**Edit Commit Message…**, **Fixup into Previous**, **Squash Commits…**, **Move Commit Up / Down**, **Drop Commits**) dùng cùng cơ chế này, chỉ là không mở panel.

---

## 9c. Bisect (tìm commit gây lỗi)

Bisect tìm commit đầu tiên gây lỗi bằng tìm kiếm nhị phân: bạn cho biết một commit **bad** (có lỗi) và một commit **good** (chưa lỗi); git checkout commit ở giữa để bạn thử, cứ thế cho tới khi tìm ra.

1. Trong Log, chuột phải commit có lỗi (thường là HEAD) ▸ **Bisect ▸ Start: Mark Bad**. Chuột phải một commit cũ chưa có lỗi ▸ **Bisect ▸ Mark Good**. (Bắt đầu bằng Mark Good trước cũng được.)
2. Git checkout commit cần thử. View Commit hiện banner **"Bisecting: ~N revisions left (~S steps)"** cùng commit đang thử, với các nút:
   - **Good** / **Bad**: commit đang thử chạy đúng / có lỗi.
   - **Skip**: commit này không thử được (ví dụ không build được).
   - **Run…**: chạy một lệnh shell trên từng commit để tự đánh dấu (`git bisect run`: exit code 0 = good, 125 = skip, khác = bad). Output hiện trong Git Console.
   - **Reset**: kết thúc bisect, quay về branch ban đầu.

   Trong Log cũng có **Bisect ▸ Mark Bad / Mark Good / Skip** cho commit bất kỳ, **Run Script…** và **Reset Bisect**.
3. Khi git tìm ra, extension báo *"<hash> is the first bad commit"* kèm **Show in Log**. Phiên bisect vẫn giữ (để bạn xem lại) tới khi bấm **Reset**.

Trong Log, các commit đã đánh dấu có nhãn **good** (xanh lá), **bad** (đỏ), **skip**; commit tìm được ghi **first bad**.

Nếu có thay đổi chưa commit cản trở việc checkout commit cần thử, extension báo rõ: hãy commit, stash hoặc shelve rồi đánh dấu lại.

---

## 9d. Thao tác nhanh

Các phím tắt dạng chord: bấm `Ctrl+Alt+G` (macOS `Cmd+Alt+G`), thả ra, rồi bấm phím thứ hai.

| Thao tác | Phím | Ở đâu khác | Làm gì |
|---|---|---|---|
| **Switch to Recent Branch…** | `Ctrl+Alt+G` `B` | Popup Branches, menu `…` của Branches | Các branch vừa checkout gần đây (đọc từ reflog), mới nhất trước. Chọn là checkout luôn (có Smart Checkout nếu đang có thay đổi). |
| **Checkout Previous Branch** | `Ctrl+Alt+G` `P` | menu `…` của Branches | Như `git checkout -`: nhảy qua lại giữa 2 branch. |
| **Amend Last Commit (Keep Message)** | `Ctrl+Alt+G` `A` | menu `…` của Commit | Gộp các file đang tick (kể cả dòng đã chọn) vào commit cuối, giữ nguyên message, không mở dialog. Ô message giữ nguyên bản nháp. |
| **WIP Commit** | `Ctrl+Alt+G` `W` | menu `…` của Commit | Lưu **mọi** thay đổi (cả file chưa theo dõi) vào commit `WIP on <branch> (…) [skip ci]`, không chạy hook, không ký. Dùng khi cần đổi branch gấp. |
| **Unwip** | `Ctrl+Alt+G` `Shift+W` | menu `…` của Commit | Gỡ commit WIP ở HEAD, thay đổi quay lại working tree. Khi checkout sang branch có HEAD là commit WIP, extension hỏi có Unwip không. |
| **Undo Last Git Action…** | `Ctrl+Alt+G` `Z` | menu `…` của Commit | Hoàn tác thao tác gần nhất theo reflog (xem bên dưới). Luôn hỏi xác nhận, liệt kê các commit sẽ rời khỏi branch. |
| **Show History for Selected Lines** | `Ctrl+Alt+G` `L` | chuột phải trong editor | Lịch sử của riêng các dòng đang chọn (`git log -L`, theo cả khi đổi tên file). Chọn commit để mở diff; nút trên mỗi dòng: **Show in Log**, **Copy Hash**. |
| **Compare File with Branch…** | `Ctrl+Alt+G` `C` | chuột phải editor / tab / Explorer | So sánh file với cùng file ở một branch, tag hoặc revision bất kỳ. |
| **Clean Merged Branches…** | | menu `…` của Branches | Liệt kê branch local đã merge vào `main` / `master` / `develop` (đổi được) hoặc có upstream đã bị xoá trên remote (*upstream gone*). Branch đang checkout ở worktree khác không bị liệt kê. Nút ☁ chạy Fetch (prune) rồi tải lại. Branch chưa merge cần xác nhận lần hai. |

**Undo Last Git Action** xử lý theo loại thao tác:

- *commit*, *commit (amend)*: đưa branch về trước commit đó, thay đổi vẫn nằm trong working tree (`reset --soft`). Với amend thì commit cũ (trước amend) quay lại.
- *merge*, *pull*, *rebase* (cả `pull --rebase`), *reset*, *cherry-pick*, *revert*: đưa branch về trạng thái trước thao tác, giữ thay đổi chưa commit (`reset --keep`). Nếu thay đổi chưa commit đụng vào file liên quan, git từ chối và extension đề nghị **Move Branch Only** (`reset --mixed`).
- *checkout*: checkout lại branch trước đó.
- Commit đầu tiên, clone, hoặc khi đang có merge / rebase dở thì không hoàn tác được (rebase dở thì dùng **Abort**).
- Chạy Undo hai lần liên tiếp sẽ làm lại thao tác vừa hoàn tác (lần hai hoàn tác chính lần *reset* của lần một).

**Inline blame:** cuối dòng có con trỏ hiện mờ `tác giả, 3 days ago • tiêu đề commit`. Rê chuột vào đó để xem toàn bộ message, kèm **Show in Log**, **Show Diff**, **Copy Hash**. Tắt / bật bằng **Toggle Inline Blame** hoặc setting `gitTools.inlineBlame.enabled`. Khi file đang bật Annotate thì inline blame tự ẩn.

**Copy commit** (menu chuột phải commit trong Log): Copy Revision Number, Copy Short Hash, Copy Subject, Copy Short Hash and Subject, Copy Full Message. Chọn nhiều commit thì mỗi commit một dòng.

**Tạo branch với tiền tố:** khi tạo branch, gõ tên (ví dụ `login`) rồi chọn `feature/login`, `bugfix/login`… Tiền tố dùng lần trước được xếp đầu. Gõ sẵn tên có `/` thì giữ nguyên. Danh sách tiền tố nằm trong `gitTools.branchPrefixes`; để trống thì quay về ô nhập tên như cũ.

---

## 10. AI commit message

Nút **✨** viết commit message từ diff của các file đang tick. Message hiện dần vào ô commit; bấm **■** để dừng. Message cũ được giữ lại nếu bạn dừng hoặc có lỗi.

**Mặc định tính năng này chưa được cấu hình.** Mỗi người phải tự chọn dịch vụ và dùng API key của chính mình.

### Cấu hình nhanh

1. Chạy lệnh **Git Tools: AI Commit Message: Configure…**
2. Chọn dịch vụ:
   - **Google Gemini** — có gói miễn phí.
   - **Anthropic Claude** — trả phí theo token.
3. Chọn model gợi ý hoặc gõ tên model:
   - Gemini: `gemini-3.5-flash-lite` (nhanh, quota miễn phí thường cao hơn), `gemini-3.8-flash`.
   - Claude: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.
4. Dán API key:
   - Gemini: lấy tại https://aistudio.google.com/apikey
   - Claude: lấy tại https://platform.claude.com/settings/keys (tài khoản cần có credit).
5. Extension tự chạy **Test Connection**. Thấy thông báo "AI commit message is ready" là xong.

Hướng dẫn chi tiết từng bước (tiếng Việt / English) có trong lệnh **Git Tools: AI Commit Message: Setup Guide**.

### Cách hoạt động

- Gửi diff của các file **đang tick**. Nếu đang tick **Amend** thì gửi thêm thay đổi của commit trước.
- Gửi kèm 15 commit gần nhất để AI viết theo đúng phong cách của repo (prefix `feat:` / `fix:`, cách viết hoa, ngôn ngữ).
- File có diff quá lớn (hơn 40.000 ký tự mỗi file, hoặc tổng hơn 150.000 ký tự) chỉ được gửi tên file, và bạn sẽ nhận được thông báo.
- Nút ✨ cũng có trên thanh tiêu đề **Source Control** có sẵn của VS Code. Khi bấm từ đó, message được ghi vào ô commit của VS Code, nhưng vẫn dựa trên các file đang tick trong view Commit của Git Tools.

### Tuỳ chỉnh

Vào Settings, tìm `gitTools.ai`:
- `Ai: Language` — ngôn ngữ của message, ví dụ `English`, `Vietnamese`. Để trống thì AI theo lịch sử commit của repo.
- `Ai: Instructions` — quy ước riêng, ví dụ `Use Conventional Commits`, hoặc `Ghi mã Jira lấy từ tên branch`.

### API key và quyền riêng tư

- API key được lưu trong **Secret Storage** của VS Code: được mã hoá bằng kho mật khẩu của hệ điều hành, không nằm trong `settings.json` và không đồng bộ qua Settings Sync.
- Đổi key: **AI Commit Message: Set API Key…**. Xoá key: **AI Commit Message: Remove API Key…**. Tắt tính năng: Configure ▸ **Not configured**.
- **Gói miễn phí của Gemini:**
  - Có giới hạn số request mỗi phút và mỗi ngày, tính theo project. Mỗi lần bấm ✨ tốn 1 request. Xem giới hạn thực tế của bạn trong Google AI Studio.
  - Google **có thể dùng dữ liệu gửi lên (diff code) để cải thiện sản phẩm**. Gói trả phí thì không.
  - Hãy kiểm tra quy định của công ty trước khi dùng với code nội bộ.

---

## 10b. Ký commit (GPG / SSH / X.509)

**Sign commit** (dưới ô message, cạnh Amend / Sign-off): tick thì commit được ký (`git commit -S`), bỏ tick thì **không** ký (`--no-gpg-sign`) kể cả khi config bật ký. Giá trị mặc định lấy từ `commit.gpgsign`. Lựa chọn này áp dụng cho:

- Commit và Amend, kể cả commit chọn từng dòng.
- Edit Commit Message (HEAD và commit cũ qua interactive rebase): các dòng `exec git commit --amend` của rebase cũng nhận `-S` / `--no-gpg-sign`, và rebase chạy với `--gpg-sign` / `--no-gpg-sign`.
- Merge commit tạo từ hộp thoại **Merge…** và khi bấm **Continue** để kết thúc merge.
- Tag: New Tag hỏi riêng **Sign Tag** (mặc định theo `tag.gpgsign`).

**Signing Settings…** (menu `…` của view Commit, hoặc Command Palette ▸ **Git Tools: Signing Settings…**):

1. **Định dạng:** OpenPGP (GPG), SSH, hoặc X.509 (gpgsm) — `gpg.format`.
2. **Khoá ký** (`user.signingkey`):
   - OpenPGP: danh sách secret key từ `gpg --list-secret-keys` (uid, key id, ngày hết hạn; khoá hết hạn / bị thu hồi được đánh dấu).
   - SSH: các file `~/.ssh/*.pub` và khoá đang nạp trong ssh-agent (`ssh-add -L`). Khoá trong agent lưu dạng `key::<khoá>`; khoá file lưu đường dẫn.
   - X.509: gõ id khoá.
3. **Sign commits by default** (`commit.gpgsign`), **Sign tags by default** (`tag.gpgsign`).
4. **Phạm vi lưu:** *This repository* (`git config --local`) hoặc *Global* (`git config --global`). Chỉ những mục bạn đổi mới được ghi.
5. **Test signing:** ký thử một object tạm (`git commit-tree -S`, không tạo ref nào) và báo thành công hoặc lỗi của git.

**Khi ký lỗi** (không có agent, sai khoá, huỷ nhập passphrase…): extension hiện lỗi của git kèm nút **Signing Settings…**. Commit **không** bao giờ được tạo lại mà không ký.

Để Log kiểm tra được chữ ký SSH (✓ thay vì ✗ "cannot be checked"), cần đặt `gpg.ssh.allowedSignersFile` trỏ tới file allowed signers.

---

## 11. Cài đặt (Settings)

| Setting | Mặc định | Mô tả |
|---|---|---|
| `gitTools.gitPath` | `git` | Đường dẫn tới git |
| `gitTools.repositoryScanMaxDepth` | `1` | Số cấp thư mục con được quét để tìm repo con (0 = chỉ thư mục gốc của workspace) |
| `gitTools.detectSubmodules` | `true` | Hiện submodule đã init như repo riêng trong Source Control Repositories |
| `gitTools.submodules.updateOnPull` | `true` | Sau Update Project / Pull, chạy `git submodule update --init --recursive` |
| `gitTools.log.maxCommits` | `2000` | Số commit tối đa tải vào Log |
| `gitTools.autoRefresh` | `true` | Tự làm mới khi file hoặc `.git` thay đổi (cần reload window sau khi đổi) |
| `gitTools.ai.provider` | `none` | `none` / `claude` / `gemini` |
| `gitTools.ai.claudeModel` | *(trống)* | Model Claude |
| `gitTools.ai.geminiModel` | *(trống)* | Model Gemini |
| `gitTools.ai.language` | *(trống)* | Ngôn ngữ của commit message |
| `gitTools.ai.instructions` | *(trống)* | Hướng dẫn thêm cho AI |
| `gitTools.inlineBlame.enabled` | `true` | Hiện blame của dòng có con trỏ ở cuối dòng |
| `gitTools.branchPrefixes` | `feature/`, `bugfix/`, `hotfix/`, `release/`, `chore/` | Tiền tố gợi ý khi tạo branch (trống = ô nhập tên thường) |

---

## 12. Danh sách lệnh

Mở Command Palette (`Ctrl+Shift+P`) và gõ `Git Tools`:

| Lệnh | Chức năng |
|---|---|
| Commit… | Mở view Commit và focus vào ô message |
| Push… / Update Project / Pull… / Fetch | Đồng bộ với remote |
| Branches… / New Branch… / Checkout Tag or Revision… | Quản lý branch |
| Stash Changes… | Tạo stash |
| Shelve Changes… / Show Shelf | Shelve các file đang tick, mở mục Shelf trong cây Branches |
| Create Patch from Ticked Files… / Copy Patch of Ticked Files to Clipboard | Tạo patch từ các file đang tick |
| Apply Patch… / Apply Patch from Clipboard | Áp dụng patch (`git apply --3way` hoặc `git am --3way`) |
| Resolve Conflicts… / Continue Merge / Rebase / Abort Merge / Rebase / Skip Commit (Rebase) | Xử lý merge, rebase, `git am` |
| Interactive Rebase… | Chọn commit cũ nhất rồi mở panel Interactive Rebase |
| Clean Working Tree… | Xoá file chưa theo dõi, có xem trước (xem [mục 3](#clean-working-tree-xoá-file-chưa-theo-dõi)) |
| New Worktree… / Prune Worktrees… | Quản lý worktree (xem [mục 6b](#6b-worktrees)) |
| Bisect: Mark Current Good / Mark Current Bad / Skip Current / Run Script… / Reset | Bisect trên commit đang checkout (xem [mục 9c](#9c-bisect-tìm-commit-gây-lỗi)) |
| Annotate with Git Blame | Bật / tắt annotation git blame cho file đang mở |
| Show Git Log / Show History for Current File | Xem lịch sử |
| Show Reflog | Mở panel Reflog (tìm lại commit bị mất) |
| Manage Remotes… | Thêm, sửa URL, xoá remote |
| Select Repository… / Open Repository… / Reopen Closed Repositories | Chọn, thêm hoặc hiện lại repository |
| Group by Directory / Group by: None (Flat List) | Đổi cách hiển thị trong view Commit |
| New Changelist… / Set Active Changelist… / Show Empty Changelists / Hide Empty Changelists | Changelists (xem [mục 3b](#3b-changelists)) |
| LFS: Pull / LFS: Fetch / LFS: Prune… / LFS: Show Tracked Patterns… | Git LFS (chỉ hiện khi máy cài Git LFS, xem [mục 8e](#8e-git-lfs)) |
| Signing Settings… | Định dạng, khoá ký, ký mặc định, thử ký (xem [mục 10b](#10b-ký-commit-gpg--ssh--x509)) |
| Select Lines to Commit… | Chọn từng dòng của file đang mở để commit |
| Show Git Console | Xem các lệnh git đã chạy |
| Refresh | Làm mới |
| AI Commit Message: Configure… / Set API Key… / Remove API Key… / Test Connection / Setup Guide | Cấu hình AI |
| Generate Commit Message | Sinh message (giống nút ✨) |
| Switch to Recent Branch… / Checkout Previous Branch | Đổi branch nhanh (xem [mục 9d](#9d-thao-tác-nhanh)) |
| Amend Last Commit (Keep Message) / WIP Commit / Unwip / Undo Last Git Action… | Sửa nhanh (xem [mục 9d](#9d-thao-tác-nhanh)) |
| Show History for Selected Lines / Compare File with Branch… | Lịch sử dòng, so sánh file với branch |
| Clean Merged Branches… | Xoá hàng loạt branch đã merge / upstream đã xoá |
| Toggle Inline Blame | Bật / tắt inline blame |

Extension chỉ gán sẵn phím tắt cho các thao tác nhanh, dưới prefix `Ctrl+Alt+G` (xem [mục 9d](#9d-thao-tác-nhanh)), một prefix VS Code mặc định không dùng. Các lệnh khác không có phím tắt mặc định để tránh trùng phím của VS Code. Muốn gán thêm hoặc đổi phím thì vào **File ▸ Preferences ▸ Keyboard Shortcuts** và tìm `gitTools`. Ví dụ: `gitTools.focusCommit`, `gitTools.push`, `gitTools.update`, `gitTools.branches`.

---

## 13. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| View Commit báo "No Git repository found" | Mở đúng thư mục repo, hoặc dùng **Select Repository…** ▸ *Open Repository Folder…*. Kiểm tra `git` chạy được trong terminal, hoặc đặt `gitTools.gitPath` |
| Không thấy biểu tượng Git Tools | Kiểm tra extension đã bật trong view Extensions và workspace đã được tin cậy (Workspace Trust) |
| Thao tác git báo lỗi | Bấm **Show Console** trên thông báo lỗi, hoặc chạy **Show Git Console**, để xem lệnh và output đầy đủ |
| Push / Fetch bị treo hoặc lỗi xác thực | Đăng nhập lại qua Git Credential Manager, hoặc kiểm tra SSH key. Extension tắt việc hỏi mật khẩu trong terminal |
| AI: *Invalid API key / 401 / 403* | Chạy **Set API Key…** và dán lại key. Với Claude, kiểm tra tài khoản còn credit |
| AI: *Unknown model / 404* | Chạy lại **Configure…** và chọn model gợi ý |
| AI: *Quota exceeded / 429* | Hết giới hạn (thường là gói free của Gemini). Chờ reset hoặc đổi model |
| AI: *Network error* | Kiểm tra proxy / firewall có chặn `api.anthropic.com` hoặc `generativelanguage.googleapis.com` không |
| Dữ liệu không tự cập nhật | Bấm ⟳. Kiểm tra `gitTools.autoRefresh` |
| Commit báo *the commit could not be signed* | Mở **Signing Settings…** ▸ **Test signing** để xem lỗi. Thường do chưa chạy gpg-agent / ssh-agent, `user.signingkey` sai, hoặc huỷ nhập passphrase. Muốn commit không ký thì bỏ tick **Sign commit** |
| Log hiện ✗ đỏ cho commit ký bằng SSH | Đặt `gpg.ssh.allowedSignersFile` (git cần file này để kiểm tra chữ ký SSH) |
| Không thấy menu LFS | Cài Git LFS và kiểm tra `git lfs version` chạy được trong terminal, rồi reload cửa sổ |
| Changelist không đổi theo app Flutter | Bấm ⟳. Nếu Git Console báo `changelists.json` hỏng, sửa hoặc xoá file `.git/git-tools/changelists.json` |

---

## 14. Giới hạn hiện tại

- File chọn từng dòng được shelve cả file. Submodule không shelve được.
- Shelf chỉ hiện trong cây Branches (chưa có tab riêng như Android Studio); diff của file đã shelve chỉ đọc.
- Reflog chỉ tải 500 mục mới nhất, chưa có "load more".
- Danh sách tác giả trong dropdown User lấy từ các commit đã tải (tối đa 100 người). Tìm theo **Me** dùng `user.name` / `user.email` hiện tại, nên commit cũ với tên / email khác không được tính.
- Interactive rebase giữ nguyên merge commit (không reword / drop / đổi chỗ merge commit được).
- `--autostash` của git trả lại thay đổi chưa commit nhưng không giữ phân biệt đã stage / chưa stage: sau khi rebase, mọi thay đổi đều ở trạng thái chưa stage (bước xem trước todo không đụng tới index).
- `git clean` không nhận danh sách đường dẫn qua stdin: các mục đã chọn được truyền trên dòng lệnh, chia thành nhiều lần chạy khi danh sách dài.
- Số "~N revisions left" của bisect lấy từ `git rev-list --bisect-vars`, không trừ các commit đã skip nên chỉ là ước lượng. Bisect dùng từ khoá mặc định good / bad (chưa hỗ trợ `--term-old` / `--term-new`).
- Annotate: VS Code không cho click trực tiếp vào phần annotation, nên click ở **đầu dòng** (cột 0) được coi là click annotation. Rê chuột ở ký tự đầu của dòng code cũng hiện hover blame.
- Danh sách worktree tự làm mới khi `.git/worktrees` thay đổi; thay đổi file bên trong worktree khác không hiện ở cửa sổ này (mở worktree đó trong cửa sổ riêng).
- Nút ✨ trên Source Control của VS Code dùng danh sách file đang tick của Git Tools, không dùng danh sách *Staged Changes* của VS Code.
- API key lưu riêng trên từng máy, không đồng bộ.
- Changelists: hộp thoại New / Edit chỉ sửa message nháp một dòng (nháp nhiều dòng được giữ nguyên nếu không đổi). File đang conflict chỉ hiện trong nhóm Merge Conflicts nhưng vẫn giữ changelist của nó.
- Git LFS: Lock / Unlock / Pull / Fetch không có giới hạn thời gian chờ; bản sao nội dung LFS cho Show Content Diff nằm trong thư mục tạm của hệ thống. Diff trong chi tiết commit của Log hiện pointer chứ không hiện nội dung LFS.
- Ký commit: khoá X.509 phải gõ tay (chưa liệt kê khoá của gpgsm). **Test signing** không thử được trường hợp "không có khoá" khi config vẫn còn một khoá (khoá đó được dùng). Quick Merge (không qua hộp thoại) theo `commit.gpgsign`.

---

## 15. Dành cho người phát triển

Mã nguồn theo Clean Architecture, 3 tầng. Phụ thuộc chỉ hướng vào trong: `presentation → domain ← data`.

```
git_tools/
├─ package.json            khai báo view, lệnh, menu, settings
├─ src/
│  ├─ extension.js         kích hoạt + composition root: tạo GitCliService, createAi rồi đưa cho presentation
│  ├─ domain/              JS thuần: không require vscode, fs, child_process hay data/
│  │  ├─ entities.js       kiểu dữ liệu (FileChange, Status, Commit, Branch…), describeSubmodule
│  │  ├─ ports.js          hợp đồng tầng data phải đáp ứng: GitRepository, GitService, ShelfStore, CommitMessageAi
│  │  ├─ errors.js         GitError, AiError, StaleSelectionError, CommitRejected, RebaseRejected, ShelfRejected, PatchRejected
│  │  ├─ prompt.js         system prompt + dựng prompt sinh commit message
│  │  ├─ logic/            graph.js (xếp làn đồ thị), conflicts.js (conflict marker), lineSelection.js (chọn từng dòng),
│  │  │                    rebaseTodo.js (đọc / kiểm tra / dựng todo của interactive rebase),
│  │  │                    history.js (bộ lọc Log user / date / nội dung, tách subject reflog, thứ tự Compare Commits),
│  │  │                    shelf.js (định dạng shelf.json, id shelf), patch.js (nhận dạng mailbox, numstat / summary),
│  │  │                    changelists.js (định dạng changelists.json, gán / dọn / đổi tên file trong changelist),
│  │  │                    lfs.js (đọc output git lfs / check-attr, pattern), signing.js (cấu hình ký, khoá gpg / ssh, %G?)
│  │  └─ usecases/         commitChanges.js, generateCommitMessage.js, selectedLineContents.js, interactiveRebase.js,
│  │                       shelveChanges.js (shelve / unshelve), patches.js (create / apply patch),
│  │                       changelists.js (đọc - sửa - ghi changelists.json lần lượt)
│  ├─ data/                implementation của ports
│  │  ├─ gitRunner.js      chạy lệnh git
│  │  ├─ gitRepository.js  Repository: thao tác git + phân tích output (status, log, branch…)
│  │  ├─ gitService.js     tìm / mở repository, quét thư mục workspace
│  │  ├─ shelfStore.js     đọc / ghi shelf trong .git/git-tools/shelf + ref giữ commit gốc
│  │  ├─ changelistStore.js đọc / ghi .git/git-tools/changelists.json (ghi qua file tạm)
│  │  ├─ gitLfs.js         lệnh git lfs (track, locks, pull, pointer, object trên máy)
│  │  ├─ signingKeys.js    liệt kê khoá gpg / ssh để chọn khoá ký
│  │  └─ aiClients.js      gọi Claude / Gemini (streaming)
│  └─ presentation/        mọi thứ dùng API của VS Code
│     ├─ model.js          trạng thái repo, tự làm mới, nhiều repo
│     ├─ commands.js       branch / push / pull / stash / reset / conflict…
│     ├─ aiCommands.js     cấu hình AI, Secret Storage, sinh message
│     ├─ commitView.js     view Commit        (media/commit.*)
│     ├─ logView.js        view Log           (media/log.*)
│     ├─ branchesTree.js   cây Branches + thanh trạng thái
│     ├─ repositoriesView.js view Source Control Repositories (media/repos.*)
│     ├─ mergeTool.js      merge tool 3 cột   (media/merge.*)
│     ├─ selectLines.js    panel Commit Lines  (media/lines.*)
│     ├─ rebaseView.js     panel Interactive Rebase, ô soạn message, lệnh sửa lịch sử trong Log (media/rebase.*)
│     ├─ reflogView.js     panel Reflog       (media/reflog.*)
│     ├─ shelf.js          hộp thoại Shelve / Unshelve, lệnh của Shelf, nội dung đã shelve cho diff editor
│     ├─ patches.js        Create Patch / Apply Patch
│     ├─ changelists.js    hộp thoại New / Edit / Delete / Move to Another Changelist, lệnh changelist
│     ├─ lfs.js            lệnh LFS, Track / Untrack / Lock / Unlock, diff pointer của file LFS
│     ├─ signing.js        hộp thoại Signing Settings, thông báo khi ký lỗi
│     ├─ diff.js           nội dung file theo revision cho diff editor
│     ├─ guide.js          trang Setup Guide  (media/guide.*)
│     └─ webview.js        khung HTML chung cho webview
└─ test/                   test không cần VS Code (core, lineSelection, submodule, usecases…)
```

Quy tắc:
- Code trong `presentation/` không gọi `m.repo.git.run([...])` hay đọc/ghi file trực tiếp. Cần lệnh git mới thì
  thêm method vào `Repository` (data/gitRepository.js) và khai báo trong `GitRepository` (domain/ports.js).
- Logic nhiều bước (kiểm tra điều kiện commit, gom diff cho AI…) nằm trong `domain/usecases`; test bằng repo giả
  như `test/usecases.test.js`.
- Chỉ `extension.js` được require `data/`.

- Không có dependency và không có bước build. Sửa file JS rồi reload cửa sổ Extension Development Host là thấy thay đổi.
- Chạy test (cần Node 18 trở lên và git; test LFS / ký commit tự bỏ qua khi thiếu git-lfs, gpg hoặc ssh-keygen, và chỉ dùng
  GNUPGHOME / HOME / config global tạm, không đụng tới khoá hay config thật của bạn):

  ```bash
  node --test test/*.test.js
  ```

- Đóng gói lại file `.vsix` (cần Node và Internet ở lần chạy đầu):

  ```bash
  npx @vscode/vsce package --allow-missing-repository --skip-license
  ```
