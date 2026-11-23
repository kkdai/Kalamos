# Web 與桌面版功能對照

依 [Web PRD](../PRD.md)、[桌面 PRD](../../docs/PRD.md)與[桌面 README](../../README.zh-TW.md)整理。桌面端對端測試多用 [IPC 記憶體替身](../../playwright.config.ts)；它們可作為行為基準，但不能證明 Web 資料已寫入 PostgreSQL，也不能代替原生平台驗收。

- **已驗證**：只指下表列明的案例在真實服務通過，不代表整個需求或平台已通過。
- **待驗證**：尚無獨立執行證據，包含每列「另測」事項。
- **Web 等效機制**：以瀏覽器、API 或資料庫操作取代不能直接移植的原生功能。

## 功能矩陣

| ID／功能 | 桌面基準 | Web 操作與差異 | 驗收與狀態 |
| --- | --- | --- | --- |
| WEB-01／新建、Markdown 匯入與下載 | [files.spec.ts](../../tests/e2e/files.spec.ts) 核對開啟、另存及 BOM、CRLF、無尾端換行的原樣保存。 | 以「新建」建立資料庫文件；使用選檔器匯入 UTF-8 Markdown，再從文件操作下載目前內容，不改寫原檔。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 在真實 DB 核對 UTF-8 BOM、CRLF、無尾端換行、繁中編輯、寫入後從全新瀏覽器環境重開與下載、原檔不變、選檔取消與無效 UTF-8。原生選檔器仍須在目標平台手動確認。 |
| WEB-01、03／資料夾及同名檔 | [資料夾側欄](../../src/sidebar/sidebar.ts)、[file-drop.spec.ts](../../tests/e2e/file-drop.spec.ts) 以實際路徑管理不同目錄的文件。 | 「匯入資料夾」保留選取根目錄及子路徑；附件和首份文件一起送出。多份 Markdown 逐份寫入，遇錯不回滾先前成功的文件。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 涵蓋子資料夾、相同檔名在不同路徑，以及選檔取消。整批部分成功與重複匯入仍需逐項操作驗收。 |
| WEB-02／單欄編輯、原始碼、GFM | [inline-marks.spec.ts](../../tests/e2e/inline-marks.spec.ts)、[block-marks.spec.ts](../../tests/e2e/block-marks.spec.ts)、[table-cell-edit.spec.ts](../../tests/e2e/table-cell-edit.spec.ts)、[table-ops.spec.ts](../../tests/e2e/table-ops.spec.ts)。 | 共用 CodeMirror；「原始碼」切換預覽，同一欄編輯；可直接勾選任務或修改表格儲存格。 | **已驗證**：[editor.spec.ts](../tests/editor.spec.ts) 核對繁中粗體、勾選、表格寫回及切換前後游標。另測表格工具列、增刪、拖移、IME 組字與真實平台鍵盤。 |
| WEB-02／連結、區塊、TOC、Emoji 與配對 | [m1a.spec.ts](../../tests/e2e/m1a.spec.ts)、[blocks.spec.ts](../../tests/e2e/blocks.spec.ts)、[emoji-autopair.spec.ts](../../tests/e2e/emoji-autopair.spec.ts) 涵蓋標題錨點、引用、註腳、YAML、TOC、Emoji 和配對。 | 共用編輯器處理區塊；Web 即時預覽將 YAML Front Matter 顯示為文件資訊。相對 `.md` 連結解析工作區路徑，外部連結由瀏覽器處理。 | **已驗證**：[shared-parity.spec.ts](../tests/shared-parity.spec.ts) 核對繁中斜體、Front Matter、註腳提示與跳轉、TOC 更新、標題錨點、相對 Markdown 連結、括號與 Markdown 符號配對及 Emoji。Emoji 測試無非同源請求；共用引用區塊行為由桌面回歸驗證。 |
| WEB-02／程式碼、公式與圖表 | [blocks.spec.ts](../../tests/e2e/blocks.spec.ts)、[code-math.test.ts](../../src/editor/code-math.test.ts)、[diagrams.test.ts](../../src/editor/diagrams.test.ts)。 | 共用語法高亮、MathJax SVG 及 Mermaid；`flow` 與 `sequence` 先轉成 Mermaid。 | **已驗證**：[editor.spec.ts](../tests/editor.spec.ts) 核對行內公式（含格內公式）、三種圖表及壞語法行號；[shared-parity.spec.ts](../tests/shared-parity.spec.ts) 核對 JavaScript 語法高亮、程式碼行號、區塊公式 SVG 即時預覽與寫回，以及 AMS 連續編號。兩者皆未觀察到非同源請求。[diagram-reader.spec.ts](../tests/diagram-reader.spec.ts) 核對 Web 點 Mermaid 圖表開啟大圖、外框貼齊圖片、點大圖或外側背景或按 Esc 關閉、窄視窗自動縮放及焦點回復；桌面版仍點圖進入原始碼編輯。 |
| WEB-02、04／大綱 | [m1a.spec.ts](../../tests/e2e/m1a.spec.ts) 的 AC12 核對標題層級、捲動、游標及目前段落標示。 | 「檢視」切換至「大綱」，按標題跳到段落，並標示目前段落。 | **已驗證**：[editor.spec.ts](../tests/editor.spec.ts) 核對順序、跳轉位置、目前段落及編輯後刷新。 |
| WEB-03／相對圖片、缺檔、插入與尺寸 | [images.spec.ts](../../tests/e2e/images.spec.ts)、[image-size-root.test.ts](../../src/editor/image-size-root.test.ts)、[file-drop.spec.ts](../../tests/e2e/file-drop.spec.ts)。 | 選取明確授權的附件，使用工作區路徑預覽。插入按鈕、圖片拖放與貼上可先保存附件，再寫入相對連結；不讀任意主機路徑。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 核對缺檔、重新開啟與 `assets/example.png` 原樣保存；[image-parity.spec.ts](../tests/image-parity.spec.ts) 核對拖放、貼上、尺寸、根目錄覆寫、檔案限制與同名衝突。混合拖放時，已開的文件收下圖片，Markdown 另開分頁；若工作區尚未開啟文件，就將圖放到新匯入的文件。 |
| WEB-03／圖床 | [image-upload.spec.ts](../../tests/e2e/image-upload.spec.ts)、[桌面上傳實作](../../src-tauri/src/upload.rs) 支援已配置命令，並在成功後替換網址。 | 管理者在服務設定 `KALAMOS_UPLOAD_COMMAND`，使用者明確點「上傳圖片到圖床」並確認；不由文件指定命令，不隨保存自動上傳。 | **已驗證**：[image-parity.spec.ts](../tests/image-parity.spec.ts) 使用本機上傳替身，核對未設定提示、成功替換、失敗保留引用，以及預覽、儲存與取消時不觸發上傳。未連線到真實圖床，Web 刻意不自動上傳。 |
| WEB-04／工作區樹、列表、搜尋、改名與垃圾桶 | [m1a.spec.ts](../../tests/e2e/m1a.spec.ts)、[folder-search.spec.ts](../../tests/e2e/folder-search.spec.ts)、[files.spec.ts](../../tests/e2e/files.spec.ts)；桌面呼叫原生垃圾桶並監聽主機檔案。 | 工作區使用 PostgreSQL 路徑；支援路徑篩選、跨文件內容搜尋、改名或移動、移入工作區垃圾桶並還原。可明確重新匯入本機變更。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 核對新建、篩選、改名和垃圾桶；[search.spec.ts](../tests/search.spec.ts) 核對大小寫、全字、正規表示式、摘要和 UTF-16 命中跳轉；[recovery-parity.spec.ts](../tests/recovery-parity.spec.ts) 核對重新匯入的確認、未儲存保護與原檔原樣保留。Web 正規表示式使用 PostgreSQL 語法；不監聽主機目錄。 |
| WEB-04／分頁、文件內搜尋與 Quick Open | [tabs.spec.ts](../../tests/e2e/tabs.spec.ts) 核對復原歷史、捲動、游標、關閉與換頁；[search.spec.ts](../../tests/e2e/search.spec.ts) 核對找尋替換；[quick-open.spec.ts](../../tests/e2e/quick-open.spec.ts) 核對模糊查詢、最近文件、鍵盤與 IME。 | 開啟文件時建立工作區分頁；共用編輯器搜尋；「快速開啟」搜尋工作區，最近紀錄在目前頁面工作階段。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 核對 Quick Open 和獨立復原歷史；[recovery-parity.spec.ts](../tests/recovery-parity.spec.ts) 核對分頁游標及可見的文件內搜尋入口；[shared-parity.spec.ts](../tests/shared-parity.spec.ts) 核對跨文件連結。最近開啟清單依本次頁面工作階段維護，瀏覽器保留的快捷鍵不會被接管。 |
| WEB-04／儲存、衝突、重試與異常救回 | [files.spec.ts](../../tests/e2e/files.spec.ts)、[app.test.ts](../../src/app.test.ts) 核對自動儲存、寫入失敗和本機草稿快照。 | 手動／自動儲存待 API 寫入才標成已儲存；過時版本收到 409；可下載當前編輯。瀏覽器草稿不等於資料庫寫入，限同瀏覽器設定檔救回。 | **已驗證**：兩分頁衝突、延遲儲存回應和故障期間可下載與重試；[recovery-parity.spec.ts](../tests/recovery-parity.spec.ts) 核對自動儲存定時、跨分頁草稿和新版衝突救回。使用獨立資料庫備份還原，再以乾淨瀏覽器重開、顯示附件及下載原樣 Markdown。 |
| WEB-05／統計、寫作模式、偏好和主題 | [word-count.spec.ts](../../tests/e2e/word-count.spec.ts)、[writing-modes.spec.ts](../../tests/e2e/writing-modes.spec.ts)、[preferences-menu.spec.ts](../../tests/e2e/preferences-menu.spec.ts)、[桌面主題說明](../../docs/themes.md)。 | 狀態列提供統計；`F8`／`F9` 或偏好開關切換模式；偏好存至工作區；自訂 CSS 由選檔器匯入，在服務內保存而不掃描系統資料夾。 | **已驗證**：[editor.spec.ts](../tests/editor.spec.ts) 核對全文／選取統計與快捷鍵；[shared-parity.spec.ts](../tests/shared-parity.spec.ts) 核對可見偏好入口、專注淡化、首末行與編輯行置中，以及自訂 CSS、主題、字體大小、內容寬度與寫作模式在全新環境留存。 |
| WEB-06／PDF | [原生 PDF 實作](../../src-tauri/src/export.rs)、[原生 smoke 驗證](../../src-tauri/examples/export_pdf_smoke.rs)、[export-diagrams.spec.ts](../../tests/e2e/export-diagrams.spec.ts)。 | 「匯出其他格式」→「PDF」，由本機 Chromium 產生下載，不依賴瀏覽器列印對話框。 | **已驗證**：[export.spec.ts](../tests/export.spec.ts) 讀取真實 PDF 的巢狀書籤、表格文字、內嵌圖片與圖表標籤；與無公式的對照檔比較向量繪圖。另測多頁排版、字型與工具缺失。 |
| WEB-06／多格式雙向轉換 | [pandoc.spec.ts](../../tests/e2e/pandoc.spec.ts)、[原生 Pandoc 實作](../../src-tauri/src/pandoc.rs)。 | 選單由本機服務執行 Pandoc。匯出：DOCX、ODT、LaTeX、MediaWiki、EPUB。匯入：DOCX、ODT、EPUB、LaTeX、HTML、MediaWiki。 | **已驗證**：[export.spec.ts](../tests/export.spec.ts) 讀取實際 DOCX 並匯回；[conversion.test.ts](../server/conversion.test.ts) 用真實 Pandoc 驗證其他支援格式、媒體提取、缺少工具、輸入錯誤與暫存檔清理。ODT 公式匯入受 Pandoc 限制；LaTeX 與 MediaWiki 不打包附件。 |
| 原生選單、Open With 與平台行為 | [app-menu.test.ts](../../src/menu/app-menu.test.ts)、[open-with.spec.ts](../../tests/e2e/open-with.spec.ts)、[windows-ux.spec.ts](../../tests/e2e/windows-ux.spec.ts)。 | 可見工具列、應用程式快捷鍵、選檔器取代原生程式整合。瀏覽器保留部分快捷鍵。 | **Web 等效機制**：原生選單、`Open With`、Touch Bar 改用工具列、選檔／拖放或可見選項。未儲存變更以每個瀏覽器分頁的草稿救回，無法重現作業系統關閉視窗的全分頁對話框。實體 IME、原生選檔器與平台保留快捷鍵待人工驗收。 |

## 執行真實資料庫驗收

在 WSL 用以下命令執行無頭 Chromium，連至獨立 Compose Web/API 和 PostgreSQL 17。測試包含 390／1360 px 的文件操作選單、格內 LaTeX、實際停止與重啟 PostgreSQL、由容器 Chromium 產生 PDF，以及由 Pandoc 3.8.3 匯出與匯回 DOCX。圖床替身在另一輪執行；以下也列出人工驗收界線。

由儲存庫根目錄執行。環境需有 Docker Compose、Node.js、無頭 Chromium 所需的系統函式庫，以及 `uv`（檢查實際 DOCX／PDF）。首次安裝可先連網下載依賴，測試中的檔案檢查使用快取，不連網。

```bash
npm ci
npx playwright install chromium
uv run --script web/tests/verify-export.py --help

export KALAMOS_WEB_PUBLISHED_PORT=4283 KALAMOS_DB_PUBLISHED_PORT=55483
docker compose -f web/compose.yaml -p kalamos-web-test-parity up --build -d --wait
TEST_WEB_URL=http://127.0.0.1:4283 TEST_WEB_ALLOW_WRITES=1 \
  TEST_WEB_COMPOSE_PROJECT=kalamos-web-test-parity \
  npx playwright test -c web/playwright.config.ts
```

- `TEST_WEB_URL` 預設 `http://127.0.0.1:4173`，只允許回送位址。測試不啟動服務、不載入桌面替身。**不要將測試指向開發資料庫**：測試會修改偏好（每個案例還原）並新增有隨機名稱的文件、附件。使用獨立的 Compose 專案、連接埠、資料庫和磁碟區。
- 資料庫中斷測試只接受名稱以 `kalamos-web-test-` 開頭的指定 Compose 專案，且確認 `TEST_WEB_URL` 與該專案的應用程式連接埠相符，才停止該專案的 `db` 並在測試後重新啟動。不設 `TEST_WEB_COMPOSE_PROJECT` 會略過此項。
- 只在上例專為驗收建立的專案清除磁碟區：`docker compose -f web/compose.yaml -p kalamos-web-test-parity down --volumes`。若要驗證重新啟動後仍可讀回，先執行不帶 `--volumes` 的 `down`，再啟動並從全新的瀏覽器環境開啟原有文件。
- 自動化成果（下載、失敗追蹤）存於 `test-results/web/`。無頭 Chromium 透過 DevTools 協定模擬繁中組字；這不等同實體 IME 或其他瀏覽器驗收。

### 圖床整合測試（不連外）

在上述專用測試專案中，以本機執行檔取代真實圖床。先在不套用下列覆寫的情況下執行一般測試，驗證未設定提示；再執行：

```bash
fixture=$(mktemp -d)
node --experimental-strip-types --input-type=module -e 'import { prepareUploadFixture } from "./web/tests/fixtures-image-uploader.ts"; await prepareUploadFixture(process.argv[1]);' "$fixture"
docker compose -f web/compose.yaml -f "$fixture/compose.json" -p kalamos-web-test-parity up -d --wait --force-recreate app
TEST_WEB_URL=http://127.0.0.1:4283 TEST_WEB_ALLOW_WRITES=1 TEST_WEB_IMAGE_UPLOAD_LOG="$fixture/upload.log" \
  npx playwright test -c web/playwright.config.ts web/tests/image-parity.spec.ts -g 'configured image upload runs'
docker compose -f web/compose.yaml -f "$fixture/compose.json" -p kalamos-web-test-parity down --volumes
rm -f -- "$fixture/compose.json" "$fixture/upload" "$fixture/upload.log"
rmdir -- "$fixture"
```

### 平台人工驗收

1. 在目標 macOS 或 Windows 的 Chrome／Edge 啟動本機版，用系統選檔器選取 `試寫.md` 和一張相鄰圖片，並驗證取消選檔時工作區不變。
2. 在文件和跨文件搜尋輸入繁體中文；用 Enter 選候選字，確認沒有重複輸入、提前送出或跳轉。
3. 試用該平台的儲存、開啟、搜尋快捷鍵。對於瀏覽器保留的快捷鍵，以工具列或側欄完成同一工作。

未完成上述人工檢查的平台組合不得列為已驗收；不承諾 Safari／Firefox 或公開部署。
