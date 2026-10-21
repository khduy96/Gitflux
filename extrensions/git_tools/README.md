# Git Tools (Android Studio style) — Hướng dẫn sử dụng

Extension cho VS Code mang Git tool window kiểu Android Studio vào VS Code:

- Panel **Commit**: tick chọn file để commit, không cần thao tác staging.
- **Log** có đồ thị nhánh, lọc theo tác giả / ngày, tìm commit theo nội dung thay đổi, so sánh hai commit bất kỳ.
- **Reflog**: tìm lại commit bị mất sau reset, rebase, drop, amend.
- Popup **Branches**.
- Push / Update Project.
- Stash.
- Merge tool 3 cột.
- **Interactive rebase**: sửa message commit cũ, squash, fixup, đổi thứ tự, drop nhiều commit.
- **AI tự viết commit message** bằng Claude hoặc Google Gemini.

Phiên bản: 0.4.2 · Yêu cầu: VS Code **1.90 trở lên** và **Git** đã cài (lệnh `git` chạy được trong terminal).

---

## Mục lục

1. [Cài đặt](#1-cài-đặt)
2. [Giao diện tổng quan](#2-giao-diện-tổng-quan)
3. [Commit](#3-commit)
4. [Xem diff](#4-xem-diff)
5. [Log và lịch sử commit](#5-log-và-lịch-sử-commit)
6. [Branches](#6-branches)
7. [Push, Update Project, Fetch](#7-push-update-project-fetch)
8. [Stash](#8-stash) · [Submodules](#8b-submodules-gitmodules)
9. [Merge, rebase và giải quyết conflict](#9-merge-rebase-và-giải-quyết-conflict) · [Interactive rebase](#9b-interactive-rebase-sửa-lịch-sử-commit)
10. [AI commit message](#10-ai-commit-message)
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
| Activity bar ▸ **Git Tools** ▸ **Branches** | HEAD, Local, Remote, Tags, Stashes, Reflog | Cây branch trong Git tool window |
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
| Menu chuột phải | Select Repository, Branches…, Fetch, Update Project / Pull…, Push…, Refresh, Open in Integrated Terminal, Reveal in File Explorer, Close Repository |
| Thêm repo ngoài workspace | Nút **+ Open Repository…** trên thanh tiêu đề view |
| Ẩn repo khỏi danh sách | **Close Repository**. Lựa chọn được nhớ theo workspace |
| Hiện lại repo đã ẩn | `…` trên thanh tiêu đề ▸ **Reopen Closed Repositories** |

Khi mở một file trong editor, extension tự chuyển sang repo chứa file đó.

Dữ liệu tự làm mới khi file hoặc thư mục `.git` thay đổi (kể cả khi bạn chạy git từ terminal) và khi cửa sổ VS Code được focus lại. Làm mới thủ công bằng nút ⟳ trên view.

---

## 3. Commit

View **Commit** có các nhóm:

- **Merge Conflicts** — chỉ xuất hiện khi có conflict. Link **Resolve** mở công cụ giải quyết conflict.
- **Changes** — file đã được git theo dõi và có thay đổi. **Mặc định được tick.**
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
| Commit | Nút **Commit** hoặc `Ctrl+Enter` trong ô message |
| Commit rồi push | **Commit and Push…** |
| Sửa commit trước | Tick **Amend**. Nếu ô message đang trống, message cũ được điền sẵn |

### Menu chuột phải trên file

- Show Diff
- Open File
- Resolve Conflicts…
- Include in Commit / Exclude from Commit
- Rollback… — đưa file về trạng thái HEAD. Với file mới thêm, bạn được chọn giữ hay xoá bản trên đĩa.
- Delete… và Add to .gitignore — chỉ có với file chưa được theo dõi.
- Show History — mở Log lọc theo file.
- Copy Path
- Reveal in Explorer View

### Thanh tiêu đề view Commit

- **✨** — sinh commit message bằng AI (xem [mục 10](#10-ai-commit-message)).
- **Stash Changes…**
- **⟳ Refresh**
- **Group by Directory / Group by: None** — xem mục Group by ở trên.
- Trong menu `…`:
  - Update Project
  - Push
  - Fetch
  - Select Repository
  - AI Commit Message: Configure / Setup Guide

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

## 4. Xem diff

Diff dùng trình so sánh có sẵn của VS Code, nên có đủ side-by-side / inline, điều hướng thay đổi và các tính năng khác của VS Code.

- **Diff working tree** có tiêu đề `file (HEAD ↔ Working Tree)`. Bên phải là file thật, sửa trực tiếp được; bạn cũng có thể dùng nút revert từng đoạn của VS Code.
- **Diff trong commit** có tiêu đề `file (parent ↔ commit)`.
- File mới hiện bên trái rỗng; file bị xoá hiện bên phải rỗng.

---

## 5. Log và lịch sử commit

View **Log** gồm 3 phần:

1. **Thanh lọc:**
   - Ô tìm kiếm, với dropdown chọn kiểu tìm ở bên trái:
     - **Message / hash / author** (mặc định) — lọc ngay trong các commit đã tải theo message, hash, tác giả, email hoặc tên ref.
     - **Changes containing text** — tìm commit có **thay đổi** thêm hoặc bớt đoạn text đó (`git log -S`), trên toàn bộ lịch sử chứ không chỉ các commit đã tải. Tick **Regex (-G)** để tìm commit có dòng thay đổi khớp biểu thức chính quy (`git log -G`). Cần gõ ít nhất 2 ký tự; lệnh chạy sau khi ngừng gõ chưa tới nửa giây, hoặc khi bấm `Enter`. **Không** phân biệt hoa thường (git chạy với `-i`).
   - Dropdown **Branch** — All, HEAD hoặc một branch cụ thể.
   - Dropdown **User** — All, **Me** (`user.name` / `user.email` trong config git), các tác giả của những commit đã tải (nhiều commit nhất ở trên), hoặc **Select…** để gõ một phần tên hay email. Khớp tên **hoặc** email, không phân biệt hoa thường.
   - Dropdown **Date** — All, Last 24 hours, Last 7 days, Last 30 days, hoặc **Select…** để nhập ngày bắt đầu / kết thúc dạng `YYYY-MM-DD` (bỏ trống một trong hai được; cả hai ngày đều được tính). Lọc theo ngày commit (committer date).
   - Lọc User, Date và Changes chạy **trong git** (`--author`, `--since`, `--until`, `-S` / `-G`), nên tìm được cả commit nằm ngoài số commit đã tải (`gitTools.log.maxCommits`). Các bộ lọc kết hợp với nhau và với Branch / Path.
   - Mỗi bộ lọc đang bật hiện thành chip (`User: Me ×`, `Date: Last 7 days ×`, `Changes containing: foo ×`); bấm `×` để bỏ. **Reset filters** bỏ hết mọi bộ lọc.
   - Bộ lọc được nhớ riêng cho từng repo đến khi đóng VS Code.
   - Chip **Path** khi đang xem lịch sử một file. Bấm `×` để bỏ lọc.
2. **Bảng commit:**
   - Đồ thị nhánh có màu.
   - Nhãn ref màu: HEAD vàng, branch local xanh lá, remote tím, tag xanh dương.
   - Các cột message, tác giả, thời gian, hash.
   - Commit HEAD được in đậm.
   - Khi đang lọc bằng ô tìm kiếm, User, Date hoặc Changes, đồ thị được ẩn đi.
3. **Chi tiết commit** (bên phải, kéo thanh chia để đổi độ rộng):
   - Danh sách file thay đổi. Click để xem diff; với merge commit thì so với parent đầu tiên.
   - Message đầy đủ, tác giả, committer, parent.
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
| New Branch… / New Tag… | Tạo branch hoặc tag tại commit đó |

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
  - Mỗi branch hiện số ↑ / ↓ và upstream.
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
| Rebase Current onto This / Merge into Current | Có thể phát sinh conflict, xem [mục 9](#9-merge-rebase-và-giải-quyết-conflict) |
| Update (fast-forward) | Cập nhật branch local từ upstream mà không cần checkout |
| Push… | Chỉ với branch hiện tại |
| Rename… / Copy Branch Name | |
| Delete | Branch chưa merge sẽ hỏi lại trước khi xoá hẳn. Branch remote sẽ đẩy lệnh xoá lên remote |

**Smart Checkout:** nếu checkout bị chặn vì thay đổi chưa commit sẽ bị ghi đè, extension đề nghị **Smart Checkout**: stash thay đổi, checkout, rồi trả lại thay đổi.

Trong cây Branches còn có:
- Branch Local / Remote được gom thành thư mục theo tiền tố trước dấu `/`: `feature/login`, `feature/cart` → **feature** ▸ `login`, `cart`. Thư mục chứa branch hiện tại tự mở sẵn.
- Mục **Tags**: Checkout, New Branch, Merge, Push Tag, Delete Tag.
- Mục **Stashes**: xem [mục 8](#8-stash).
- Mục **Reflog**: mở panel Reflog, xem [mục 5](#reflog).

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

## 9. Merge, rebase và giải quyết conflict

Khi đang merge / rebase / cherry-pick / revert, view Commit hiện banner kiểu **"Merging in progress · 1 conflict"** kèm nút:

- **Resolve…** khi còn conflict.
- **Continue** khi đã giải quyết hết. Với merge, Continue tạo merge commit bằng message mặc định của git.
- **Skip** (chỉ khi rebase) — bỏ qua commit đang dừng (`git rebase --skip`), có hỏi xác nhận.
- **Abort**.

Khi rebase, banner hiện tiến độ, ví dụ **"Rebasing 2/5"**. Nếu rebase dừng ở commit đánh dấu `edit`, banner ghi thêm *"Stopped at 1a2b3c4d Thêm API for editing — amend, then Continue"*: sửa file, tick **Amend** rồi Commit, sau đó bấm **Continue**.

Trong lúc merge, ô message được điền sẵn message mặc định của git (`Merge branch '…'`). Bạn sửa message rồi bấm **Commit** cũng được.

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

---

## 12. Danh sách lệnh

Mở Command Palette (`Ctrl+Shift+P`) và gõ `Git Tools`:

| Lệnh | Chức năng |
|---|---|
| Commit… | Mở view Commit và focus vào ô message |
| Push… / Update Project / Pull… / Fetch | Đồng bộ với remote |
| Branches… / New Branch… / Checkout Tag or Revision… | Quản lý branch |
| Stash Changes… | Tạo stash |
| Resolve Conflicts… / Continue Merge / Rebase / Abort Merge / Rebase / Skip Commit (Rebase) | Xử lý merge, rebase |
| Interactive Rebase… | Chọn commit cũ nhất rồi mở panel Interactive Rebase |
| Show Git Log / Show History for Current File | Xem lịch sử |
| Show Reflog | Mở panel Reflog (tìm lại commit bị mất) |
| Manage Remotes… | Thêm, sửa URL, xoá remote |
| Select Repository… / Open Repository… / Reopen Closed Repositories | Chọn, thêm hoặc hiện lại repository |
| Group by Directory / Group by: None (Flat List) | Đổi cách hiển thị trong view Commit |
| Select Lines to Commit… | Chọn từng dòng của file đang mở để commit |
| Show Git Console | Xem các lệnh git đã chạy |
| Refresh | Làm mới |
| AI Commit Message: Configure… / Set API Key… / Remove API Key… / Test Connection / Setup Guide | Cấu hình AI |
| Generate Commit Message | Sinh message (giống nút ✨) |

Extension không gán phím tắt mặc định để tránh trùng phím của VS Code. Muốn gán phím tắt kiểu Android Studio thì vào **File ▸ Preferences ▸ Keyboard Shortcuts** và tìm `gitTools`. Ví dụ: `gitTools.focusCommit`, `gitTools.push`, `gitTools.update`, `gitTools.branches`.

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

---

## 14. Giới hạn hiện tại

- Chưa có shelve.
- Reflog chỉ tải 500 mục mới nhất, chưa có "load more".
- Danh sách tác giả trong dropdown User lấy từ các commit đã tải (tối đa 100 người). Tìm theo **Me** dùng `user.name` / `user.email` hiện tại, nên commit cũ với tên / email khác không được tính.
- Interactive rebase giữ nguyên merge commit (không reword / drop / đổi chỗ merge commit được).
- `--autostash` của git trả lại thay đổi chưa commit nhưng không giữ phân biệt đã stage / chưa stage: sau khi rebase, mọi thay đổi đều ở trạng thái chưa stage (bước xem trước todo không đụng tới index).
- Diff khi click file trong view Commit luôn so với `HEAD`, không tách riêng phần đã stage và chưa stage.
- Nút ✨ trên Source Control của VS Code dùng danh sách file đang tick của Git Tools, không dùng danh sách *Staged Changes* của VS Code.
- API key lưu riêng trên từng máy, không đồng bộ.

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
│  │  ├─ ports.js          hợp đồng tầng data phải đáp ứng: GitRepository, GitService, CommitMessageAi
│  │  ├─ errors.js         GitError, AiError, StaleSelectionError, CommitRejected
│  │  ├─ prompt.js         system prompt + dựng prompt sinh commit message
│  │  ├─ logic/            graph.js (xếp làn đồ thị), conflicts.js (conflict marker), lineSelection.js (chọn từng dòng),
│  │  │                    rebaseTodo.js (đọc / kiểm tra / dựng todo của interactive rebase),
│  │  │                    history.js (bộ lọc Log user / date / nội dung, tách subject reflog, thứ tự Compare Commits)
│  │  └─ usecases/         commitChanges.js, generateCommitMessage.js, selectedLineContents.js, interactiveRebase.js
│  ├─ data/                implementation của ports
│  │  ├─ gitRunner.js      chạy lệnh git
│  │  ├─ gitRepository.js  Repository: thao tác git + phân tích output (status, log, branch…)
│  │  ├─ gitService.js     tìm / mở repository, quét thư mục workspace
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
- Chạy test (cần Node 18 trở lên và git):

  ```bash
  node --test test/core.test.js test/lineSelection.test.js test/submodule.test.js test/branchUpstream.test.js test/usecases.test.js test/rebaseTodo.test.js test/interactiveRebase.test.js test/historyTools.test.js
  ```

- Đóng gói lại file `.vsix` (cần Node và Internet ở lần chạy đầu):

  ```bash
  npx @vscode/vsce package --allow-missing-repository --skip-license
  ```
