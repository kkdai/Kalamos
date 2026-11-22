# 發佈流程（Release）

Kalamos 透過 `.github/workflows/release.yml` 自動打包 macOS 與 Windows 安裝檔、產生 `SHA256SUMS.txt`，並建立 GitHub Draft Release，由維護者確認後手動公開。

## 產物一覽

| 平台 | 架構 | 檔案 | 說明 |
| --- | --- | --- | --- |
| macOS | Apple Silicon (arm64) | `Kalamos_<version>_aarch64.dmg` | ad-hoc 簽章，內含 `Applications` 捷徑 |
| macOS | Intel (x86_64) | `Kalamos_<version>_x64.dmg` | ad-hoc 簽章，內含 `Applications` 捷徑 |
| Windows | x64 | `Kalamos_<version>_x64-setup.exe` | NSIS 安裝程式（`currentUser`，免管理員權限，含繁體中文與英文） |
| Windows | x64 | `Kalamos_<version>_x64_en-US.msi` | WiX MSI 安裝程式 |
| 全部 | — | `SHA256SUMS.txt` | 所有安裝檔的 SHA-256 校驗碼 |

> **目前限制**：macOS 產物使用 ad-hoc 簽章（尚未經過 Apple 公證），Windows 產物尚未經過程式碼簽章。首次安裝或開啟時需依 Release Notes 中的說明通過 Gatekeeper / SmartScreen 提示。

## 正式發版步驟

### 1. 更新版本號並開 PR

同時更新以下三個檔案的版本號（格式為 SemVer，例如 `0.4.0`）：

- `package.json`（`version`）
- `src-tauri/tauri.conf.json`（`version`）
- `src-tauri/Cargo.toml`（`[package]` 底下的 `version`）

若 `src-tauri/Cargo.toml` 版本有變動，順手執行一次 `cargo test --manifest-path src-tauri/Cargo.toml` 或 `cargo check --manifest-path src-tauri/Cargo.toml`，讓 `src-tauri/Cargo.lock` 同步更新。

本機可用版本檢查腳本確認三個檔案一致（以及預計推送的 tag）：

```bash
node scripts/check-release-version.mjs --tag v0.4.0
```

確認測試通過後開 PR（例如 `chore: bump version to 0.4.0`），待 CI 綠燈並 review 通過。

### 2. 合併 PR 到 `main`

將版本更新 PR 合併至 `main`，並在本機拉取最新 `main`：

```bash
git checkout main
git pull origin main
```

### 3. 建立並推送 `v*` tag

```bash
git tag v0.4.0
git push origin v0.4.0
```

推送 `v*` tag 會自動觸發 `.github/workflows/release.yml`：

1. `check-version`：比對 tag 與 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本號，若有任何不一致會立即失敗。
2. `build`：平行建置 macOS（`aarch64`、`x86_64`）與 Windows（`x86_64`）安裝檔，並在 macOS 上自動執行 `codesign --verify --deep --strict` 與 `.dmg` 內的 `Applications` 捷徑檢查。
3. `checksums`：彙整所有安裝檔並產生 `SHA256SUMS.txt`。
4. `release`：建立標題為 `Kalamos v0.4.0` 的 **Draft Release**，附上所有安裝檔、`SHA256SUMS.txt` 以及包含安裝說明、未公證/未簽章提示與 SHA-256 的範本內文。

### 4. 檢查 Draft Release 並實機確認

前往 GitHub 的 **Releases** 頁面找到新建的 Draft（`Kalamos v0.4.0`）：

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
4. 編輯 Draft Release 內文，將 `<!-- 發布前請在此補充... -->` 替換為本版本的更新摘要。

### 5. Publish Release

確認無誤後，在 GitHub Releases 頁面點擊 **Publish release** 正式公開。

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
