# M1 驗收 harness 計畫

對應 `.herdr/PLAN.md` M1a AC 1–15，以及 #5、#7、#8 issue 的「驗收」與「規格」條目。
每條標明 **自動**（哪個測試）或 **手動**（步驟）。需要真實 Tauri 視窗 / 真實磁碟的項目寫成手動步驟。

## 怎麼跑

| 指令 | 內容 |
| --- | --- |
| `npm test` | vitest + jsdom（`src/**/*.test.ts`） |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust 後端（tempdir） |
| `npm run test:e2e` | Playwright + Chromium，`playwright.config.ts` 用 webServer 起 `npm run dev`（port 1420）。非 Tauri 環境 `src/ipc.ts` 自動用記憶體 mock |
| `npm run bench` | `tests/bench/run.mjs`：自起 Vite（port 1421）+ headless Chromium，1 萬行文件，JSON 輸出到 stdout；p95 ≥ 50 ms 時 exit 1 |
| `harness/run.sh` | 依序跑上面四個，印摘要；任一失敗 exit 1。log 與 `bench.json` 在 `$TMPDIR/kalamos-harness`（`HARNESS_OUT` 可改，`HARNESS_SKIP="cargo bench"` 可略過） |

第一次在新機器跑 e2e：`npx playwright install chromium`。

e2e 慣例：
- 用既有 `data-testid` 與 `window.__kalamos`（`getDoc` / `setCursor` / `isSourceMode`）；需要 app 物件或 ipc mock 時，在頁面內 `import("/src/main.ts")`、`import("/src/ipc.ts")`（Vite 回傳同一個 module instance）。
- IME 用 CDP `Input.imeSetComposition` + `Input.insertText`。
- 因產品 bug 失敗的測試保留，以 `test.fixme(... [BUG-n])` 標註，對應 `.herdr/reports/m1-qa.md` 的 bug 編號；修好後把 `fixme` 改回 `test`。

## M1a AC 1–15

| AC | 內容（摘要） | 自動 | 手動 |
| --- | --- | --- | --- |
| 1 | 視窗標題 Kalamos；預設主題跟隨系統深淺色 | e2e `m1a.spec.ts`「AC1 document title」、「AC1/AC14 default theme follows system light/dark」 | M-1 |
| 2 | Cmd+O / S / Shift+S / N；未編輯存檔逐 byte 不變 | e2e `files.spec.ts`「AC2 …」（mock，字串層級含 BOM / CRLF / 無結尾換行）；cargo `files::tests::preserves_exact_bytes_crlf_no_trailing_newline_and_cjk` | M-2 |
| 3 | 原子寫入（暫存檔 + rename） | cargo `files::tests::atomic_write_and_no_leftover_temp_files`、`preserves_existing_file_permissions_on_save` | M-3 |
| 4 | 已命名 1 秒自動存檔；未命名每 5 秒救回檔；強制結束後提示還原 | e2e `files.spec.ts`「AC4 named file autosaves」、「AC4 untitled … recovery … restore」（mock，模擬重開）；cargo `recovery::tests::*` | M-4 |
| 5 | 粗體 / 斜體 / code / 刪除 / 連結 / h1–h6：游標離開隱藏符號，回來重現 | e2e `m1a.spec.ts`「AC5 …」×11（實際鍵入，量測 `.k-mark-hidden` 寬度 = 0） | — |
| 6 | 文件字串不因預覽改變 | e2e「AC6 live preview never mutates the document string」（游標走遍全文） | — |
| 7 | Cmd+/ 原始碼模式，內容與游標保留 | e2e「AC7 Cmd+/ toggles source mode …」（含表格、數學 widget 卸下） | — |
| 8 | Cmd+B / I / Shift+` / K toggle；中文粗體正確渲染 | e2e「AC8 … toggles …」×4、「AC8 bold around CJK punctuation」（**fixme BUG-1**） | — |
| 9 | IME 組字期間不重算 decoration | e2e「AC9 decorations are frozen …」、「AC9 composing on a decorated line …」、「AC9 math live preview …」（**fixme BUG-3**） | M-9（真實注音 / 拼音輸入法） |
| 10 | Cmd+Shift+O 開資料夾；側欄預設隱藏、Cmd+Shift+L；三分頁；點檔開檔 | e2e「AC10 sidebar hidden by default …」、「AC10 Cmd+Shift+O opens a folder …」、「AC10 … reveals the opened folder」（**fixme BUG-2**） | — |
| 11 | 外部新增 / 刪除 / 改名 .md，側欄 1 秒內更新 | e2e `files.spec.ts`「AC11 fs-changed event refreshes the sidebar」（mock 事件）；cargo `watch::tests::emits_debounced_fs_changed_and_replaces_previous_watch` | M-11 |
| 12 | 大綱層級、點擊捲動、目前段落高亮 | e2e「AC12 outline …」 | — |
| 13 | 主題選單列出內建 + `themes/*.css`；立即套用並記住；新 CSS 重啟後出現 | e2e「AC13 theme menu …」（mock：選單、套用、settings 寫入、新 CSS 下次開選單出現）；cargo `themes::tests::*`、`settings::tests::*` | M-13 |
| 14 | 色票 = PRD §12.3；主次文字對背景對比 ≥ 4.5:1 | e2e「AC14 papyros / melan palette …」 | — |
| 15 | 1 萬行打字不卡頓（< 50 ms） | `npm run bench`（p50 / p95 / max，按位置分組；`as-is` 與 `mathjax-shim` 兩個情境） | M-15（實機 Tauri 體感） |

## #5 清單 / 任務清單 / 連結

| 條目 | 自動 | 手動 |
| --- | --- | --- |
| 驗收：任務清單可點擊勾選並寫回 `[x]` | e2e `blocks.spec.ts`「#5 AC: clicking a task checkbox …」 | — |
| 驗收：點擊標題連結跳至對應段落 | e2e「#5 AC: Cmd+Click on a #heading link …」 | — |
| 規格：Enter 延續 / 空項目結束 | e2e「#5 spec: Enter continues a list …」 | — |
| 規格：Tab / Shift+Tab | e2e「#5 spec: Tab / Shift+Tab …」 | — |
| 規格：Cmd+Shift+[ / ] | e2e「#5 spec: Cmd+Shift+[ / ] …」 | — |
| 規格：相對 `.md` 在 app 內開、http(s) 用系統瀏覽器、Cmd+Shift+C 書籤 | vitest `lists.test.ts` | M-5 |

## #7 表格

| 條目 | 自動 | 手動 |
| --- | --- | --- |
| 驗收：拖曳一列後原始碼列順序同步 | e2e「#7 AC: dragging a row reorders the source rows」 | — |
| 規格：游標不在時 widget 渲染 | e2e「#7 spec: table renders as a widget …」 | — |
| 規格：點儲存格編輯並寫回 | e2e「#7 spec: clicking a cell enters edit …」 | — |
| 規格：寫回保持欄對齊 | e2e「#7 spec: after editing a cell and leaving …」（**fixme BUG-6**） | — |
| 規格：Cmd+Opt+T 3×3 | e2e「#7 spec: Cmd+Opt+T inserts …」 | — |
| 規格：直接輸入 `| a | b |` | e2e「#7 spec: typing `| a | b |` + delimiter row …」、「typing a literal `| 1 | 2 |` body row …」（**fixme BUG-5**） | — |
| 規格：Tab / Shift+Tab、最後一格 Tab 新增列 | e2e「#7 spec: Tab / Shift+Tab …」 | — |
| 規格：拖曳欄邊界調欄寬（只存 session） | — | M-7 |
| 原始碼模式卸下表格 | e2e「#7 spec: source mode unloads the table widget」 | — |

## #8 程式碼區塊 / 數學

| 條目 | 自動 | 手動 |
| --- | --- | --- |
| 驗收：指定語言後立即高亮 | e2e「#8 AC: highlighting appears …」 | — |
| 驗收：行號可開關（Cmd+Opt+L） | e2e「#8 AC: line numbers toggle …」 | — |
| 規格：圍欄符號游標不在時隱藏 | e2e「#8 spec: fences are hidden …」 | — |
| 驗收：區塊公式即時渲染 | e2e「#8 AC: block math renders live as SVG」（**fixme BUG-4**） | — |
| 驗收：編號開啟後自動連續（Cmd+Opt+N） | e2e「#8 AC: with auto-numbering on …」（**fixme BUG-4**） | — |
| 規格：行內 `$…$`、語法錯誤紅字 | e2e「#8 spec: inline $...$ …」（**fixme BUG-4**） | — |
| 規格：MathJax 打包離線（mhchem / bbox） | e2e「#8 spec: math works offline …」（**fixme BUG-4**） | M-8 |

## EX-01 匯出 PDF（#10）

| 條目 | 自動 | 手動 |
| --- | --- | --- |
| 驗收：PDF 書籤與大綱一致 | cargo `export::tests::outline_parents_*`（層級 / 跳級）、`duplicate_headings_map_to_successive_occurrences`、`missing_heading_points_at_previous_heading`、`folded_search_ignores_whitespace_case_and_compat_forms`；實機 `examples/export_pdf_smoke.rs`（真的產生 PDF 並用 PDFKit 讀回頁數 / 書籤） | M-EX1 |
| 規格：HTML 產生（標題 id、表格、任務清單、程式碼 span、數學 SVG、跳脫） | vitest `src/export/html.test.ts` | — |
| 規格：Cmd+Shift+E、預設檔名、status「匯出中…」→ 路徑 / 失敗訊息、未命名可匯出 | vitest `src/export/export-app.test.ts` | M-EX1 |

實機 smoke（不需開 app）：

```sh
# 1) 用前端產生 HTML 與 headings（任一 .md）
cat > /tmp/gen.ts <<'TS'
import { readFileSync, writeFileSync } from "node:fs";
import { buildExportHtml } from "/src/export/html.ts";
const [md, out] = process.argv.slice(2);
const r = await buildExportHtml(readFileSync(md, "utf8"), { title: "smoke", docPath: md });
writeFileSync(`${out}/page.html`, r.html); writeFileSync(`${out}/headings.json`, JSON.stringify(r.headings));
TS
npx vite-node /tmp/gen.ts ~/kalamos-qa/long.md /tmp
# 2) 實際列印成 PDF 兩次，印出頁數 / 書籤樹 / 殘留隱藏視窗數（應為 0）
cargo run --manifest-path src-tauri/Cargo.toml --example export_pdf_smoke -- /tmp/page.html /tmp/headings.json /tmp/out.pdf 2
```

## EX-02 / EX-03 Pandoc 匯出 / 匯入（#16）

| 條目 | 自動 | 手動 |
| --- | --- | --- |
| 驗收：各格式保留標題、清單、表格、圖片 | cargo `pandoc::tests::*`（假 pandoc script：各格式 argv、`--resource-path`、無 shell、原子 rename、逾時 kill、缺少 pandoc、stderr 對應）；`real_pandoc_roundtrip_if_installed`（有裝 pandoc 才跑）；vitest `src/export/pandoc.test.ts`（圖片絕對路徑 / 根目錄 / `<img>` 尺寸 / `[TOC]`） | M-EX2 |
| 驗收：匯入 DOCX 標題層級正確 | cargo `import_reads_stdout_and_extracts_media`；e2e `tests/e2e/pandoc.spec.ts`（mock） | M-EX3 |
| 規格：Cmd+Opt+E 格式選單 → 存檔對話框（`<doc>.<ext>`）→「匯出中…」→「已匯出 <格式>：<路徑>」；無 pandoc 顯示安裝提示、不開對話框；Cmd+Opt+I 開成未命名、dirty 文件 | vitest `src/export/pandoc.test.ts`、e2e `tests/e2e/pandoc.spec.ts` | M-EX2、M-EX3 |

已知限制（Pandoc 本身的行為，非 Kalamos bug；#48 以 pandoc 3.14 實測）：

- **ODT 行內數學匯入後變成區塊數學**：pandoc 的 ODT reader 把 ODF 公式一律讀成 display math，匯入的 `.odt` 中 `$E=mc^2$` 會變成 `$$E = mc^{2}$$`（DOCX、EPUB、LaTeX、MediaWiki 無此問題）。
- **ODT 圖片標題是獨立段落**：ODT reader 不產生 Figure，圖片匯入為 `![](…)`、標題文字是下一段；DOCX / EPUB 的有標題圖片經內建 Lua filter 轉為 `![標題](…)`。
- 匯入時圖片的寬高屬性一律移除（GFM 無法表示），`<u>`、`<sub>` 等其他 HTML 照舊保留；零寬空白 U+200B 會被移除。

## 手動步驟（需真實 Tauri 視窗 / 磁碟）

前置：`npm run tauri dev`（或 `npm run tauri build` 後開 `Kalamos.app`）。準備資料夾 `~/kalamos-qa/`。

- **M-1 視窗與系統主題**：啟動後視窗標題列為 `Kalamos`。系統設定切換淺色 / 深色，主題選單選「跟隨系統」時背景在 `#F5EFE0` / `#1C1A17` 間切換。
- **M-2 存檔逐 byte 一致**：準備 `crlf.md`（CRLF、UTF-8 BOM、無結尾換行、含中文），`shasum -a 256 crlf.md` 記下。Cmd+O 開啟、不編輯、Cmd+S，再 `shasum` 一次須相同；`xxd crlf.md | head -1` 開頭仍為 `efbbbf`。另測 Cmd+Shift+S 另存、Cmd+N 新文件。
- **M-3 原子寫入**：`fswatch -x ~/kalamos-qa` 監看時存檔，應看到暫存檔 Created → Renamed 到目標檔，資料夾內不留暫存檔。
- **M-4 自動存檔 / 救回**：(a) 開已命名檔、打字後停 1 秒，`cat` 檔案已更新。(b) Cmd+N 打字、等 6 秒，`kill -9 $(pgrep -f kalamos)` 強制結束，重開應出現還原橫幅，按「還原」後內容一致；救回檔位於 app data `recovery/`，使用者資料夾內沒有新檔。
- **M-5 連結**：Cmd+Click http(s) 連結以系統瀏覽器開啟；相對 `other.md#標題` 在 app 內開並跳到標題；標題上 Cmd+Shift+C 後剪貼簿為 `[標題](#slug)`。
- **M-7 欄寬**：拖曳表格欄邊界，欄寬改變；存檔後檔案內容不變，重開 app 欄寬恢復預設。
- **M-8 數學離線**：關閉網路，開含 `\ce{H2O}`、`\bbox`、`\tag` 的文件，公式正常渲染。
- **M-9 真實輸入法**：以注音與拼音輸入法在 `**粗體**` 後、表格儲存格內、`$$` 區塊內組字，選字前畫面不跳動、選字後內容正確。
- **M-11 外部檔案變動**：Cmd+Shift+O 開 `~/kalamos-qa/`，在 Finder / 終端 `touch a.md`、`mv a.md b.md`、`rm b.md`，側欄 1 秒內反映。
- **M-13 自訂主題**：將 `forest.css` 放入 app data `themes/`，重啟後選單出現並可套用；重啟後仍維持上次選的主題。
- **M-EX1 匯出 PDF**：開一份含 h1–h3（含跳級 h1→h3、重複標題、中英混排標題）、表格、程式碼、公式、本機圖片、超過 3 頁的文件，按 Cmd+Shift+E。存檔對話框預設檔名＝文件名 `.pdf`、預設在文件同資料夾；確認後 status 先顯示「匯出中…」，完成後顯示「已匯出 PDF：<路徑>」。用「預覽程式」開啟：A4、四邊留白、頁首頁尾無 URL / 日期；側邊欄「目錄」書籤樹與 app 大綱一致，點每個書籤跳到該標題所在頁；標題 / 表格 / 程式碼不被分頁切斷；圖片與公式正常。再連續匯出兩次（覆蓋同檔），都成功、資料夾內不留 `.*.kalamos-*.pdf` 暫存檔、Mission Control 看不到多出的視窗。Cmd+N 未命名文件也能匯出（預設檔名 `未命名.pdf`）。匯出到唯讀資料夾時 status 顯示「匯出 PDF 失敗：…」且之後可再次匯出。
- **M-EX2 Pandoc 匯出（需真實 pandoc：`brew install pandoc`）**：先在未安裝 pandoc 時按 Cmd+Opt+E，status 顯示「找不到 Pandoc：請先安裝（brew install pandoc）」且不出現對話框；安裝後（不必重開 app）再按。準備含 h1–h3、巢狀清單、任務清單、表格、相對路徑圖片、`/img/x.png`（設定圖片根目錄後）、`<img width="200">`、腳註、公式、`[TOC]` 的文件。依序匯出 DOCX / ODT / LaTeX / MediaWiki / EPUB：格式選單可用方向鍵與 Esc；存檔對話框預設為文件同資料夾的 `<文件名>.<docx|odt|tex|wiki|epub>`；status「匯出中…」→「已匯出 <格式>：<路徑>」。分別用 Word / LibreOffice、`pdflatex`（或任一 TeX 編輯器）、MediaWiki 預覽（或文字檢視）、Apple Books 開啟：標題層級、清單、表格、圖片（含根目錄與 `<img>` 寬度）都在，有 `[TOC]` 的 DOCX / ODT / EPUB 有目錄。資料夾內不留 `.*.kalamos-pandoc-*` 暫存檔。圖片路徑錯誤時 status 顯示「匯出失敗：Pandoc 執行失敗（exit …）：…」。
- **M-EX3 Pandoc 匯入**：準備一份 Word 文件，含標題 1–3、清單、表格與一張內嵌圖片，存成 `.docx`。Cmd+Opt+I 選它：status「匯入中…」→「已匯入：<檔名>」，開成未命名、未存檔（dirty）文件；`#` / `##` / `###` 層級與 Word 一致，清單與表格正確，圖片可顯示（來自暫存資料夾）。另以 `.odt`、`.html`、`.epub` 各匯入一次。匯入時目前文件若有未存變更，未命名文件會先詢問是否捨棄；取消則保留原文件。
- **M-15 實機效能**：在 Tauri 視窗開 `npm run bench` 用的 1 萬行文件（可用 `node -e` 呼叫 `buildDoc` 輸出），在頂部、中段、表格、程式碼、公式內連續打字，主觀無卡頓。

## CI

`.github/workflows/ci.yml`（macos-latest）：`npm ci` → `npx playwright install chromium` → `npm test` → `cargo test` → `npm run test:e2e`。bench 不進 CI（共享 runner 數字不穩），由 `harness/run.sh` 本機跑。
