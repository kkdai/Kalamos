# 發佈流程（Release）

Kalamos 使用 [Changesets](https://github.com/changesets/changesets) 管理版本號與 `CHANGELOG.md`，並透過 `.github/workflows/release.yml` 在推送 `v*` tag 時自動打包 macOS 與 Windows 安裝檔、產生 `SHA256SUMS.txt`，以及建立 GitHub Draft Release，由維護者確認後手動公開。

## 產物一覽

| 平台 | 架構 | 檔案 | 說明 |
| --- | --- | --- | --- |
| macOS | Apple Silicon (arm64) | `Kalamos_<version>_aarch64.dmg` | ad-hoc 簽章，內含 `Applications` 捷徑 |
| macOS | Intel (x86_64) | `Kalamos_<version>_x64.dmg` | ad-hoc 簽章，內含 `Applications` 捷徑 |
| Windows | x64 | `Kalamos_<version>_x64-setup.exe` | NSIS 安裝程式（`currentUser`，免管理員權限，含繁體中文與英文） |
| Windows | x64 | `Kalamos_<version>_x64_en-US.msi` | WiX MSI 安裝程式 |
| 全部 | — | `SHA256SUMS.txt` | 所有安裝檔的 SHA-256 校驗碼 |

> **目前限制**：macOS 產物使用 ad-hoc 簽章（尚未經過 Apple 公證），Windows 產物尚未經過程式碼簽章。首次安裝或開啟時需依 Release Notes 中的說明通過 Gatekeeper / SmartScreen 提示。

## 一次性 Repo 設定

若要讓 `.github/workflows/changesets.yml` 自動建立／更新版本 PR，請確認 GitHub repo 已啟用：

**Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**

## 正式發版步驟

### 1. 為變更加入 Changeset

凡是有需要列入發行紀錄的 App 改動，在開發分支上執行：

```bash
npm run changeset
```

依提示選擇版本層級（`patch`、`minor` 或 `major`）並撰寫簡短的使用者向變更摘要，將產生的 `.changeset/*.md` 一併提交到 PR。

> **外部貢獻者 PR 處理方式**：外部 PR 若未附帶 changeset，不需要因此擋下審查或合併；需要列入發行紀錄時，由維護者直接補上 `.changeset/*.md`（可補在原 PR 分支上，或在合併後另開小 PR 補上）。

### 2. 合併版本 PR（或本機執行 `npm run version-packages`）

#### 方式一：透過 Changesets 自動版本 PR（建議）

含 `.changeset/*.md` 的 PR 合併到 `main` 後，`.github/workflows/changesets.yml` 會自動執行 `npm run version-packages`（等同 `changeset version && node scripts/sync-version.mjs`），更新 `CHANGELOG.md` 並一次同步以下五個檔案的版本號，建立或更新標題為 `chore(release): bump version` 的版本 PR：

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

該 workflow **不會**自動建立 Git tag 或發佈 Release，也不會發佈到 npm。

> **注意：版本 PR 不會自動觸發 CI**
> 由於 `.github/workflows/changesets.yml` 使用預設的 `GITHUB_TOKEN` 建立／更新 PR，依 GitHub Actions 防遞迴機制，這類 PR **不會自動觸發** `pull_request` 類型的 CI（`.github/workflows/ci.yml`）。準備合併版本 PR 前，請用以下任一方式手動觸發 CI，待版本檢查與所有測試綠燈後再合併：
> - 在 GitHub PR 頁面點擊 **Close pull request**，再立即點擊 **Reopen pull request**；或
> - 切到版本 PR 分支推送一個空 commit：`git commit --allow-empty -m "chore: trigger CI" && git push`。

#### 方式二：在本機執行 `npm run version-packages`

如果不使用自動版本 PR，維護者也可從最新 `main` 切分支在本機執行：

```bash
npm run version-packages
node scripts/check-release-version.mjs
```

檢查 `CHANGELOG.md` 與五個版本檔的 diff 無誤後開 PR，待 CI 綠燈並合併至 `main`。

合併完成後，在本機拉取最新 `main`：

```bash
git checkout main
git pull origin main
```

### 3. 建立並推送 `v*` tag

可先確認版本檔與即將推送的 tag 一致，再建立並推送 tag（例如 `v0.5.0`）：

```bash
node scripts/check-release-version.mjs --tag v0.5.0
git tag v0.5.0
git push origin v0.5.0
```

推送 `v*` tag 會自動觸發 `.github/workflows/release.yml`：

1. `check-version`：比對 tag 與 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本號，若有任何不一致會立即失敗。
2. `build`：平行建置 macOS（`aarch64`、`x86_64`）與 Windows（`x86_64`）安裝檔，並在 macOS 上自動執行 `codesign --verify --deep --strict` 與 `.dmg` 內的 `Applications` 捷徑檢查。
3. `checksums`：彙整所有安裝檔並產生 `SHA256SUMS.txt`。
4. `release`：執行 `scripts/generate-release-notes.mjs` 產生 Release Notes——若 `CHANGELOG.md` 中存在對應的 `## <version>` 段落，會自動填入「更新摘要」位置，否則保留 placeholder 供手動填寫——並建立標題為 `Kalamos v<version>` 的 **Draft Release**，附上所有安裝檔與 `SHA256SUMS.txt`。

### 4. 檢查 Draft Release 並實機確認

前往 GitHub 的 **Releases** 頁面找到新建的 Draft（`Kalamos v0.5.0`）：

1. 確認所有預期產物與 `SHA256SUMS.txt` 皆已附上。
2. 下載 macOS `.dmg` 到本機驗證校驗碼與簽章：
   ```bash
   shasum -a 256 -c SHA256SUMS.txt --ignore-missing
   ```
   開啟 `.dmg` 確認有 `Applications` 捷徑，拖進「應用程式」後右鍵「打開」確認可正常啟動；也可以對 `.app` 執行：
   ```bash
   codesign --verify --deep --strict --verbose=2 /Applications/Kalamos.app
   ```
3. 若有 Windows 實機，下載 `-setup.exe` / `.msi` 確認安裝、開啟 `.md` 檔案關聯與啟動正常。
4. 本版新增的輸入行為請在 macOS 與 Windows 實機確認。
5. 檢查 Draft Release 內文的更新摘要（若已從 `CHANGELOG.md` 自動帶入，確認措辭即可；若該版尚未寫入 `CHANGELOG.md`，請將 `<!-- 發布前請在此補充... -->` 替換為本版本的更新摘要）。

### 5. Publish Release

確認無誤後，在 GitHub Releases 頁面點擊 **Publish release** 正式公開。

### 實機驗證介面語言

變更介面語言時，發佈前用 macOS 和 Windows 的 Tauri 正式建置各做一次。瀏覽器測試無法驗證原生選單。

1. 用乾淨的測試設定開啟 Kalamos，確認偏好設定與原生選單預設顯示繁體中文。
2. 輸入尚未儲存的內容，再到「偏好設定 → 一般 → 介面語言」改選 English。選「稍後」，確認語言尚未改變，而且內容未被清除。
3. 先切回繁體中文，再改選 English 並按「立即重啟」。在未儲存對話框取消，確認 App 不會重啟或清除內容。再次改選語言後選「立即重啟」，這次儲存文件並確認 App 自動重新開啟。
4. 重啟後確認選單和 Preferences 都顯示英文、開檔快捷鍵可用，並可從最近開啟的檔案找回剛儲存的文件。改回繁體中文並選擇「Later」，正常結束後重開，確認介面與選單都切回繁體中文。OS 自行顯示的控制項不在此驗證範圍。

---

## 使用 `workflow_dispatch` 手動試跑

在不推 tag、不建立 GitHub Release 的情況下，可以手動觸發一次完整打包驗證（只產生 workflow artifacts，不會建立 Draft Release）：

### 方式一：透過 GitHub 網頁

1. 前往 GitHub 專案的 **Actions** 分頁。
2. 左側選擇 **Release** workflow。
3. 點擊右上角 **Run workflow**，選擇要試跑的 branch，按 **Run workflow**。

### 方式二：透過 GitHub CLI

```bash
gh workflow run release.yml --ref main
```

（若要測試尚未合併的功能分支，將 `main` 換成該分支名稱即可。）

執行完成後，在該次 workflow run 頁面的 **Artifacts** 區塊即可下載：

- `installer-macos-aarch64`
- `installer-macos-x64`
- `installer-windows-x64`
- `sha256sums`

> 注意：試跑時 `check-version` 仍會檢查 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三者版本是否一致（只是不比對 Git tag）。
