# 發佈流程（Release）

Kalamos 使用 [Changesets](https://github.com/changesets/changesets) 管理版本號與 `CHANGELOG.md`，並透過 `.github/workflows/release.yml` 在推送 `v*` tag 時自動打包 macOS 與 Windows 安裝檔、產生 `SHA256SUMS.txt`，以及建立 GitHub Draft Release，由維護者確認後手動公開。

## 產物一覽

| 平台 | 架構 | 檔案 | 說明 |
| --- | --- | --- | --- |
| macOS | Apple Silicon (arm64) | `Kalamos_<version>_aarch64.dmg` | ad-hoc 簽章，內含 `Applications` 捷徑 |
| macOS | Apple Silicon (arm64) | `Kalamos_<version>_aarch64.app.tar.gz` + `.sig` | 自動更新用壓縮包與 minisign 簽章 |
| macOS | Intel (x86_64) | `Kalamos_<version>_x64.dmg` | ad-hoc 簽章，內含 `Applications` 捷徑 |
| macOS | Intel (x86_64) | `Kalamos_<version>_x64.app.tar.gz` + `.sig` | 自動更新用壓縮包與 minisign 簽章 |
| Windows | x64 | `Kalamos_<version>_x64-setup.exe` + `.sig` | NSIS 安裝程式（`currentUser`，免管理員權限，含繁體中文與英文）與自動更新 minisign 簽章 |
| Windows | x64 | `Kalamos_<version>_x64_en-US.msi` | WiX MSI 安裝程式 |
| 全部 | — | `latest.json` | Tauri 自動更新清單（HTTPS 端點：`https://github.com/kkdai/Kalamos/releases/latest/download/latest.json`） |
| 全部 | — | `SHA256SUMS.txt` | 所有安裝檔、自動更新套件、`.sig` 與 `latest.json` 的 SHA-256 校驗碼 |

> **目前限制**：macOS 產物使用 ad-hoc 簽章（尚未經過 Apple 公證），Windows 產物尚未經過程式碼簽章。首次安裝、開啟，或透過應用程式內自動更新替換 `Kalamos.app` 後，若系統要求重新授權，需依 Release Notes 中的說明通過 Gatekeeper / SmartScreen 提示（macOS 可對 **Kalamos.app** 按右鍵選「打開」，或執行 `xattr -cr /Applications/Kalamos.app`）。

## 自動更新簽章金鑰保管原則

Kalamos 的自動更新使用 `tauri-plugin-updater` 內建的 minisign 簽章驗證：公鑰寫入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，私鑰僅存於維護者本機密碼管理器與 GitHub Actions Secrets。

- **存放位置與權限隔離（Build 與簽章分離）**：
  - GitHub Secrets：`TAURI_SIGNING_PRIVATE_KEY`（私鑰內容）與 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（私鑰密碼），僅供 `.github/workflows/release.yml` 中 tag 觸發的 `build` job 內**獨立的簽章 step**使用，並綁定 `environment: release`（維護者可在 GitHub 為 `release` environment 設定 required reviewers）。
  - **Build step 不帶私鑰**：`npx tauri build`（含 `vite build` 與所有 npm / Cargo 建置期依賴）完全不注入任何簽章私鑰，並關閉 `createUpdaterArtifacts`，避免任何建置依賴讀取私鑰。
  - **獨立簽章與即時驗章**：打包完成後，先由一般 step 整理 `.app.tar.gz`（macOS，以 `COPYFILE_DISABLE=1 tar -czf ... -C .../macos Kalamos.app` 打包成 `tauri-plugin-updater` 2.x 預期的頂層 `Kalamos.app/` 結構）與 NSIS `-setup.exe`（Windows）；接著才在**僅執行 `node node_modules/@tauri-apps/cli/tauri.js signer sign --app-version <version>`** 的獨立 step 注入私鑰產生 `.sig`（不執行任何 npm script 或建置流程）；簽章完成後立即在不含私鑰的 step 透過 `scripts/verify-updater-signature.mjs` 以 `src-tauri/tauri.conf.json` 中的公鑰進行 Ed25519 + BLAKE2b-512 密碼學驗章。
  - `workflow_dispatch` 試跑走獨立的 `build-dry-run` job，完全不進入 `environment: release` 也不接觸私鑰。
  - PR 與 CI（`.github/workflows/ci.yml`）均無法存取私鑰，且專案不使用 `pull_request_target`。
- **備份原則**：
  - 私鑰檔案與密碼僅保存在維護者本人的密碼管理器與離線加密備份中，**絕不**提交進 Git、貼入 Issue / PR，或交給任何自動化 agent。
- **私鑰遺失處理**：
  - 若私鑰遺失，需由維護者在本機重新產生新的金鑰組，更新 GitHub Secrets 與 `src-tauri/tauri.conf.json` 中的 `plugins.updater.pubkey` 後發佈新版。
  - 既有舊版 App 仍驗證舊公鑰，無法透過自動更新跨越金鑰輪替，需在 Release Notes 與 README 提醒使用者手動下載安裝一次新版。
- **私鑰外洩處理**：
  - 立即輪替金鑰：本機產生新金鑰組、立刻覆蓋 GitHub Secrets 並更新 `plugins.updater.pubkey`。
  - 檢查既有 GitHub Releases、tag 與 `latest.json` 是否遭竄改；若有疑慮應立即下架受影響的 Release 資產。
  - 發佈安全公告與新版 Release，提醒使用者從 GitHub Releases 手動下載並以 `SHA256SUMS.txt` 校驗後重新安裝。

> **本機建置方式**：`src-tauri/tauri.conf.json` 預設已將 `bundle.createUpdaterArtifacts` 設為 `false`（正式發佈改由獨立簽章 step 產生 `.app.tar.gz` 與 `.sig`），因此本機不需設定私鑰即可直接執行 `npm run tauri build`。

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
2. `build`（僅 tag 觸發，宣告 `environment: release`）：平行建置 macOS（`aarch64`、`x86_64`）與 Windows（`x86_64`）未簽章安裝檔（build step 不帶任何私鑰），macOS 自動驗證 `codesign --verify --deep --strict`、`.dmg` 內 `Applications` 捷徑與 `.app.tar.gz` 頂層結構；隨後僅在獨立簽章 step 以 `tauri signer sign --app-version` 對 macOS `.app.tar.gz` 與 Windows NSIS `-setup.exe` 簽章，並立即以 `scripts/verify-updater-signature.mjs` 使用 `tauri.conf.json` 的公鑰進行密碼學驗章。
3. `checksums`：彙整所有產物，在 tag 觸發時執行 `scripts/generate-updater-manifest.mjs` 產生並以公鑰密碼學驗證 `latest.json` 與所有平台 `.sig`（檢查三個平台與架構的檔案、Ed25519 + BLAKE2b-512 簽章、簽章版本號與 HTTPS URL，缺一或驗章失敗即中止），最後產生包含所有產物與 `latest.json` 的 `SHA256SUMS.txt`。
4. `release`：再次驗證 `latest.json` 與所有 `.sig`，執行 `scripts/generate-release-notes.mjs` 產生 Release Notes——若 `CHANGELOG.md` 中存在對應的 `## <version>` 段落，會自動填入「更新摘要」位置，否則保留 placeholder 供手動填寫——並建立標題為 `Kalamos v<version>` 的 **Draft Release**，附上所有安裝檔、updater 壓縮包、`.sig`、`latest.json` 與 `SHA256SUMS.txt`。GitHub 的 `/releases/latest/download/latest.json` 不會指向 Draft Release，因此唯有維護者按下 **Publish release** 後，使用者才會收到更新通知。

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

### 實機驗證自動更新（首次發佈 `0.8.0` → `0.8.1`）

1. 先正式發佈內含自動更新功能的 `v0.8.0`（Publish Release），確認 Draft 內已附上 `latest.json`、macOS 雙架構 `.app.tar.gz` + `.sig` 與 Windows NSIS `-setup.exe.sig`。
2. 在 macOS 實機從 `v0.8.0` `.dmg` 手動安裝並開啟 Kalamos，執行「**Kalamos → 檢查更新…**」，確認顯示「目前已是最新版本」。
3. 接著發佈一個小版本（例如 `v0.8.1`），先保留在 **Draft** 狀態：再次於 `0.8.0` 執行「檢查更新…」，確認仍顯示已是最新版（不會抓到 draft）。
4. 將 `v0.8.1` 按下 **Publish release** 公開後：
   - 重新啟動 `0.8.0`，確認幾秒後背景檢查自動跳出新版本對話框，顯示 `0.8.1` 版號與 `CHANGELOG.md` 更新摘要，且未經同意不會開始下載。
   - 在編輯器留下一份未儲存草稿，點選「**立即更新**」，確認下載進度條顯示正常；下載完成後會跳出未儲存變更確認對話框（全部儲存／不儲存／取消）。先試點「取消」確認不會安裝；再次更新並儲存或捨棄後，確認安裝完成並自動重啟為 `0.8.1`。
   - 若因 ad-hoc 簽章造成更新重啟後系統要求重新授權，依畫面或 Finder 右鍵「打開」授權後確認可正常開啟，且「關於 Kalamos」顯示 `0.8.1`。
5. 若發佈前尚未在 Windows 實機驗證 NSIS 自動更新，請在 Release Notes 明確標註「Windows 自動更新尚未經過實機驗證」。

### 實機驗證介面語言

變更介面語言時，發佈前用 macOS 和 Windows 的 Tauri 正式建置各做一次。瀏覽器測試無法驗證原生選單。

1. 用乾淨的測試設定開啟 Kalamos，確認偏好設定與原生選單預設跟隨系統語言（系統語言為 `zh` 開頭時顯示繁體中文，其餘顯示英文）。
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
