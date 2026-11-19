# Kalamos — Typora 風格的 WYSIWYM Markdown 桌面編輯器

產品規格：`docs/PRD.md`（PRD v0.2）。本檔是 PM 的開發計畫，所有角色以此為準。

## Goal / users / non-goals

- **Goal**：單一視窗、輸入即渲染的 Markdown 編輯器，存檔為標準 Markdown（GFM）且無損。免費、離線、無帳號、無遙測。
- **User**：作者本人（中英混寫的技術部落格作者），macOS。
- **Non-goals**（PRD §4）：收費 / 授權、多人協作、自建同步、行動版 / 網頁版、外掛市集、AI 輔助。

## Milestones / epics

| Epic | 範圍（功能 issue） | 狀態 |
| --- | --- | --- |
| M1a | #1 骨架+存檔+救回、#2 主題、#3 即時預覽 ED-01/02/03、#4 檔案樹 NV-01、#6 大綱 NV-02 + 主題切換 TH-01 | 進行中 |
| M1b | #5 清單/連結、#7 表格、#8 程式碼+數學、#9 圖片 | 待排 |
| M2 | #10–#16 | backlog |
| M3 | #17–#19 | backlog |

功能 issue #1–#19 是「需求規格」；每個 epic 再開 [BE]/[FE]/[QA] 角色 issue 實作。

## Acceptance criteria — M1a

1. `npm run tauri dev` 開啟視窗，標題 `Kalamos`；預設主題跟隨系統深淺色（Papyros / Melan）。
2. Cmd+O 開檔、Cmd+S 存檔、Cmd+Shift+S 另存、Cmd+N 新文件；未編輯就存檔，檔案逐 byte 不變（不改行尾、不加 BOM）。
3. 存檔為原子寫入（暫存檔 + rename）。
4. 已命名檔案停止輸入 1 秒後自動存檔；未命名文件每 5 秒寫入救回檔；強制結束後重開會提示還原，還原後內容一致。
5. 輸入 `**粗體**` 後游標移開，顯示為粗體且不見星號；游標回到該處星號重新出現。同樣適用 `*斜體*`、`` `code` ``、`~~刪除~~`、`[文字](url)`、`#`～`######` 標題。
6. 編輯器文件字串不因即時預覽而改變（decoration only）。
7. Cmd+/ 切換原始碼模式，切換前後內容一致、游標位置保留。
8. Cmd+B / Cmd+I / Cmd+Shift+` / Cmd+K 對選取範圍 toggle 粗體 / 斜體 / 行內程式碼 / 連結；中文字串套用粗體後正確渲染。
9. IME 組字期間不重算 decoration（不跳動）。
10. Cmd+Shift+O 開資料夾；側欄（Cmd+Shift+L 切換，預設隱藏）有「檔案樹 / 檔案列表 / 大綱」三個分頁；點檔案開檔。
11. 外部在資料夾新增 / 刪除 / 改名 .md 檔，側欄 1 秒內自動更新。
12. 大綱顯示標題層級，點擊捲動至對應標題；目前段落高亮。
13. 主題選單列出 Papyros、Melan 及 app data `themes/*.css` 自訂主題，選擇後立即套用並記住；放入新 CSS 重啟後出現在選單。
14. Papyros / Melan 色票與 PRD §12.3 完全一致；主要與次要文字對背景對比 ≥ 4.5:1。
15. 1 萬行文件打字不卡頓（輸入到渲染 < 50 ms，QA 以基準測試量測）。

## Architecture

```
┌───────────── Tauri 2 app (macOS) ─────────────┐
│  WebView: src/ (TypeScript + Vite)             │
│   editor/  CodeMirror 6 + lezer-markdown(GFM)  │
│            live-preview (Decorations)          │
│   sidebar/ file-tree, file-list, outline       │
│   styles/  tokens, themes/papyros|melan, editor│
│        │ invoke(cmd) / listen(event)           │
│  Rust: src-tauri/                              │
│   commands: files, folder tree, watcher,       │
│             autosave/recovery, settings, themes│
└────────────────────────────────────────────────┘
```

前後端唯一介面是 Tauri IPC，定義於 `.herdr/contracts/api.yaml`（每個 command 以 `POST /invoke/<command>` 表示，event 列在 `x-events`）。

## Backend（BE：Rust，`src-tauri/`）

- Tauri 2，app identifier `io.kalamos.app`，`tauri.conf.json`：`build.devUrl = http://localhost:1420`、`build.frontendDist = ../dist`、`beforeDevCommand = npm run dev`、`beforeBuildCommand = npm run build`。
- plugins：`tauri-plugin-dialog`、`tauri-plugin-opener`。crates：`notify`（+ debouncer）、`trash`、`serde`、`thiserror`。
- 模組：`files.rs`（open/save 原子寫入）、`tree.rs`（資料夾樹、過濾 `.md`/`.markdown`、略過隱藏檔 / `.git` / `node_modules`）、`watch.rs`（notify，debounce 200 ms，emit `fs-changed`）、`recovery.rs`（app data `recovery/`）、`settings.rs`（app data `settings.json`）、`themes.rs`（app data `themes/*.css`）。
- 錯誤：command 回傳 `Result<T, AppError>`，AppError 序列化為 `{ kind, message }`。
- 不在使用者資料夾內寫任何檔（Dropbox / iCloud 相容）。
- 測試：`cargo test`（tempdir），涵蓋原子寫入、byte 一致、過濾、監看事件、救回檔、設定讀寫、主題列舉。

## Frontend stack（FE：`src/`、根目錄 `package.json` / `vite.config.ts` / `index.html` / `tsconfig.json`）

**TypeScript + Vite，不用 UI 框架 + CodeMirror 6。** 理由：編輯器本體就是 CM6，周邊 UI（側欄、選單）元件少，多一層框架只增加和 CM6 生命週期打架的成本；CM6 文件即原始字串，天然保證存檔無損；CM6 處理 IME 組字成熟、viewport 渲染撐得住 1 萬行。

- 依賴：`@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-opener`、`codemirror`、`@codemirror/lang-markdown`、`@lezer/markdown`、`@codemirror/language-data`；字體 `@fontsource/source-serif-4`、`@fontsource/noto-serif-tc`、`@fontsource/inter`、`@fontsource/noto-sans-tc`、`@fontsource/jetbrains-mono`（全部離線打包）。
- 目錄：`src/main.ts`、`src/ipc.ts`（唯一呼叫 invoke 的地方，型別對應 api.yaml）、`src/editor/`（`live-preview.ts`、`keymaps.ts`、`source-mode.ts`）、`src/sidebar/`、`src/styles/`。
- Vite dev server port 1420（strictPort）。
- `ipc.ts` 在非 Tauri 環境（`window.__TAURI_INTERNALS__` 不存在）時改用記憶體 mock，讓 QA 能在一般瀏覽器跑 e2e。
- 設計語言照 PRD §12（色票、字體、17px / 1.75 / 720px、動效 150–200 ms ease-out、符號淡出不位移、側欄滑入紙面不動）。
- 測試：`vitest` + jsdom（`npm test`）：decoration 範圍與 class、原始碼模式切換、快捷鍵 toggle、大綱解析。

## Deploy / build

桌面 app，不上 GCP。「部署」= PM 在 main 上跑 `npm run tauri build`，產出 `Kalamos.app`（未簽章，自用）。CI（GitHub Actions，macos-latest）：`npm ci && npm test && cargo test --manifest-path src-tauri/Cargo.toml`。

## 協作方式（/herdr-coder）

- Reviewer（Claude Code）：寫 spec、review diff、跑測試、把修改意見丟回 coder，最後 commit、push、開 PR、merge。
- 兩個 coder（agy）：`kalamos-a`、`kalamos-b`，各在自己的 git worktree（`../Kalamos.wt/a`、`../Kalamos.wt/b`）平行做一個功能 issue。coder 不碰 git。
- 每個功能 issue 一個 branch、一個 PR（`Closes #N`）。

## 執行波次（M1）

兩個 coder 同一波做的 issue 盡量不碰同樣的檔案。

| 波次 | kalamos-a | kalamos-b |
| --- | --- | --- |
| W0 | #1 專案骨架（Tauri + Vite + CM6）、開檔存檔、自動儲存與救回 | #2 Papyros / Melan 主題與排版（只動 `src/styles/`） |
| W1 | #3 即時預覽核心 ED-01/02/03 | #4 檔案樹與檔案列表 NV-01 |
| W2 | #5 清單、任務清單、連結 ED-04/05 | #6 大綱 NV-02 + 主題切換 / 自訂 CSS TH-01 |
| W3 | #7 表格 BL-01 | #8 程式碼區塊 BL-02 + 數學 BL-03 |
| W4 | #9 圖片 IM-01/02 | M1 驗收與修 bug |

## Out of scope / risks

- M1a 不做清單、表格、程式碼高亮、數學、圖片（M1b）。
- 風險：CJK 粗斜體在 CommonMark 規則下不渲染（`**中文**中文`）→ FE 先以標準 Markdown 處理，做不到則回報 PM 決定。
- 風險：Tauri 打包需 Xcode CLT；QA e2e 不依賴 Tauri 視窗。
- GitHub token 缺 `workflow` scope 時 CI 檔推不上去 → PR 檢查改由 PM 本機跑。
