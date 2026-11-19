# Kalamos 開發計畫（PM）

來源：[docs/PRD.md](PRD.md)（PRD v0.2）。本文件定案 PRD 第 11 節的待決問題，並列出 issue 拆分與執行順序。

## 1. 技術決策（ADR-lite）

| 問題 | 決定 | 理由 |
| --- | --- | --- |
| 桌面框架 | **Tauri 2**（Rust 後端 + 系統 WebView） | 冷啟動 < 2 秒、安裝包小；檔案 I/O、監看、自動儲存放在 Rust |
| 編輯器核心 | **CodeMirror 6** + `@lezer/markdown`（GFM）+ Decoration 實作即時預覽 | 文件本體永遠是原始 Markdown 字串，存檔無損（PRD §7 相容性）；CM6 對 IME 組字處理成熟（PRD §7 在地化）；大檔效能好（viewport 渲染） |
| 前端 | **TypeScript + Vite，不用 UI 框架** | 介面元件少（側欄、大綱、設定），避免多一層框架 |
| 套件管理 | npm | 本機已有 |
| 數學 | MathJax 3（tex-svg，含 mhchem / ams / bbox） | PRD BL-03 指定 |
| 程式碼高亮 | `@codemirror/language-data`（約 100 種語言） | PRD BL-02 |
| 圖表 | Mermaid（M2） | PRD BL-04 |
| 匯出 | PDF 用 WebView 列印 / headless；其他格式透過 Pandoc（M2） | PRD §11 風險：先做 PDF |
| 作業系統 | **macOS 先行**（Apple Silicon） | 自己主要使用的 OS |
| 介面語言 | **繁體中文為主**，功能名稱並列希臘名（Ataraxia、Stichos…） | PRD §12.6 |
| 開源 | 暫維持 **private** repo，日後再決定 | PRD 待決 |
| 測試 | 前端 `vitest`（含 jsdom）；後端 `cargo test`；CI 用 GitHub Actions（macos-latest） | |

## 2. 目錄慣例

```
src/                 前端（TS）
  editor/            CodeMirror 擴充：live-preview、blocks、keymaps
  sidebar/           檔案樹、檔案列表、大綱
  styles/themes/     papyros.css、melan.css（CSS 變數 = PRD §12.3 色票）
  main.ts
src-tauri/           Rust：檔案 I/O、監看、自動儲存與救回、設定
docs/                PRD、PLAN
```

## 3. 協作方式

- PM（Claude Code）開 issue、寫 spec、review、commit、開 PR、merge。
- 兩個 coder（agy：`kalamos-a`、`kalamos-b`）各自在 git worktree（`../Kalamos.wt/a`、`../Kalamos.wt/b`）平行做一個 issue，不碰 git。
- 每個 issue 一個 branch、一個 PR，PR 本文 `Closes #N`。

## 4. Issue 與執行波次（M1 可用版）

每一波兩個 issue 平行進行，彼此盡量不碰同樣的檔案。

| 波次 | kalamos-a | kalamos-b |
| --- | --- | --- |
| W0 | #1 專案骨架、開檔/存檔、自動儲存與救回 | #2 Papyros / Melan 主題與排版（TH-01 基礎） |
| W1 | #3 即時預覽核心 ED-01/02/03 | #4 檔案樹與檔案列表 NV-01 |
| W2 | #5 清單、任務清單、連結 ED-04/05 | #6 大綱面板 NV-02 + 主題切換/自訂 CSS 載入 TH-01 |
| W3 | #7 表格 BL-01 | #8 程式碼區塊 BL-02 + 數學 BL-03 |
| W4 | #9 圖片顯示與拖放 IM-01/02 | （M1 驗收、修 bug） |

M2、M3 issue 已建立為 backlog，M1 驗收通過後再排。
