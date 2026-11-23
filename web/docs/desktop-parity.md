# Web 與桌面版功能對照

依 [Web PRD](../PRD.md)、[實作計畫](plans/feat_web_desktop-parity.md)、[桌面 PRD](../../docs/PRD.md)與[桌面 README](../../README.zh-TW.md)整理。桌面端對端測試多用 [IPC 記憶體替身](../../playwright.config.ts)；它們可作為行為基準，但不能證明 Web 資料已寫入 PostgreSQL，也不能代替原生平台驗收。

- **已驗證**：只指下表列明的案例在真實服務通過，不代表整個需求或平台已通過。
- **待驗證**：尚無獨立執行證據，包含每列「另測」事項。
- **未對齊**：目前無相同行為，或有意改用瀏覽器、API 或資料庫工作流程。

## 功能矩陣

| ID／功能 | 桌面基準 | Web 操作與差異 | 驗收與狀態 |
| --- | --- | --- | --- |
| WEB-01／新建、Markdown 匯入與下載 | [files.spec.ts](../../tests/e2e/files.spec.ts) 核對開啟、另存及 BOM、CRLF、無尾端換行的原樣保存。 | 以「新建」建立資料庫文件；使用選檔器匯入 UTF-8 Markdown，再從文件操作下載目前內容，不改寫原檔。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 在真實 DB 核對 UTF-8 BOM、CRLF、無尾端換行、繁中編輯、寫入後從全新瀏覽器環境重開與下載、原檔不變、選檔取消與無效 UTF-8。原生選檔器仍須在目標平台手動確認。 |
| WEB-01、03／資料夾及同名檔 | [資料夾側欄](../../src/sidebar/sidebar.ts)、[file-drop.spec.ts](../../tests/e2e/file-drop.spec.ts) 以實際路徑管理不同目錄的文件。 | 「匯入資料夾」保留選取根目錄及子路徑；附件和首份文件一起送出。多份 Markdown 逐份寫入，遇錯不回滾先前成功的文件。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 涵蓋子資料夾、相同檔名在不同路徑，以及選檔取消。整批部分成功與重複匯入仍需逐項操作驗收。 |
| WEB-02／單欄編輯、原始碼、GFM | [inline-marks.spec.ts](../../tests/e2e/inline-marks.spec.ts)、[block-marks.spec.ts](../../tests/e2e/block-marks.spec.ts)、[table-cell-edit.spec.ts](../../tests/e2e/table-cell-edit.spec.ts)、[table-ops.spec.ts](../../tests/e2e/table-ops.spec.ts)。 | 共用 CodeMirror；「原始碼」切換預覽，同一欄編輯；可直接勾選任務或修改表格儲存格。 | **已驗證**：[editor.spec.ts](../tests/editor.spec.ts) 核對繁中粗體、勾選、表格寫回及切換前後游標。另測表格工具列、增刪、拖移、IME 組字與真實平台鍵盤。 |
| WEB-02／連結、區塊、TOC、Emoji 與配對 | [m1a.spec.ts](../../tests/e2e/m1a.spec.ts)、[blocks.spec.ts](../../tests/e2e/blocks.spec.ts)、[emoji-autopair.spec.ts](../../tests/e2e/emoji-autopair.spec.ts) 涵蓋標題錨點、引用、註腳、YAML、TOC、Emoji 和配對。 | 共用編輯器處理區塊；相對 `.md` 連結解析工作區路徑，外部連結由瀏覽器處理。 | **待驗證**：用相同測試文件核對桌面行為，包含文件連結、標題書籤、註腳和 Emoji 的離線載入。 |
| WEB-02／程式碼、公式與圖表 | [blocks.spec.ts](../../tests/e2e/blocks.spec.ts)、[code-math.test.ts](../../src/editor/code-math.test.ts)、[diagrams.test.ts](../../src/editor/diagrams.test.ts)。 | 共用語法高亮、MathJax SVG 及 Mermaid；`flow` 與 `sequence` 先轉成 Mermaid。 | **已驗證**：[editor.spec.ts](../tests/editor.spec.ts) 阻擋非同源 HTTP 請求，核對行內公式、三種圖表及壞語法行號。另測 AMS 編號、區塊公式編輯與程式碼行號。 |
| WEB-02、04／大綱 | [m1a.spec.ts](../../tests/e2e/m1a.spec.ts) 的 AC12 核對標題層級、捲動、游標及目前段落標示。 | 「檢視」切換至「大綱」，按標題跳到段落，並標示目前段落。 | **已驗證**：[editor.spec.ts](../tests/editor.spec.ts) 核對順序、跳轉位置、目前段落及編輯後刷新。 |
| WEB-03／相對圖片、缺檔、插入與尺寸 | [images.spec.ts](../../tests/e2e/images.spec.ts)、[image-size-root.test.ts](../../src/editor/image-size-root.test.ts)、[file-drop.spec.ts](../../tests/e2e/file-drop.spec.ts)。 | 選取明確授權的附件，使用工作區路徑預覽。插入按鈕、圖片拖放與貼上可先保存附件，再寫入相對連結；不讀任意主機路徑。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 核對 `assets/example.png` 從缺檔到載入、下載的附件位元組、全新環境重開及缺檔路徑。另測拖放、貼上、尺寸、圖片根路徑、圖片限制與同名衝突。 |
| WEB-03／圖床 | [image-upload.spec.ts](../../tests/e2e/image-upload.spec.ts)、[桌面上傳實作](../../src-tauri/src/upload.rs) 支援已配置命令，並在成功後替換網址。 | 管理者在服務設定 `KALAMOS_UPLOAD_COMMAND`，使用者明確點「上傳圖片到圖床」並確認；不由文件指定命令，不隨保存自動上傳。 | **待驗證**：在隔離環境用本機上傳替身驗證未設定、成功替換、失敗保留引用及禁止未告知的傳送。自動上傳不是等效行為。 |
| WEB-04／工作區樹、列表、搜尋、改名與垃圾桶 | [m1a.spec.ts](../../tests/e2e/m1a.spec.ts)、[folder-search.spec.ts](../../tests/e2e/folder-search.spec.ts)、[files.spec.ts](../../tests/e2e/files.spec.ts)；桌面呼叫原生垃圾桶並監聽主機檔案。 | 工作區使用 PostgreSQL 路徑；搜尋路徑及內容、改名或移動、移入工作區垃圾桶並還原。原檔變更不會自動同步。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 核對新建、內容搜尋、改名、移入垃圾桶及還原。**未對齊**：Web 搜尋列出文件，不提供桌面的正規表示式選項、命中位置或摘要；不監聽主機檔案，也無一鍵重新匯入覆蓋的流程。 |
| WEB-04／分頁、文件內搜尋與 Quick Open | [tabs.spec.ts](../../tests/e2e/tabs.spec.ts) 核對復原歷史、捲動、游標、關閉與換頁；[search.spec.ts](../../tests/e2e/search.spec.ts) 核對找尋替換；[quick-open.spec.ts](../../tests/e2e/quick-open.spec.ts) 核對模糊查詢、最近文件、鍵盤與 IME。 | 開啟文件時建立工作區分頁；共用編輯器搜尋；「快速開啟」搜尋工作區，最近紀錄在目前頁面工作階段。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 涵蓋從 Quick Open 切換分頁及各自的復原歷史；游標、相對文件連結、平台快捷鍵與 IME 尚需操作驗收。Web 不重現最近本機檔案清單、主機監聽及原生分頁快捷鍵。 |
| WEB-04／儲存、衝突、重試與異常救回 | [files.spec.ts](../../tests/e2e/files.spec.ts)、[app.test.ts](../../src/app.test.ts) 核對自動儲存、寫入失敗和本機草稿快照。 | 手動／自動儲存待 API 寫入才標成已儲存；過時版本收到 409；可下載當前編輯。瀏覽器草稿不等於資料庫寫入，限同瀏覽器設定檔救回。 | **已驗證**：[workspace.spec.ts](../tests/workspace.spec.ts) 核對兩個瀏覽器分頁的 409、獲勝版本及未儲存副本；[outage.spec.ts](../tests/outage.spec.ts) 停止測試 DB，核對 503、保留目前編輯、下載副本、重新啟動後救回草稿及重試寫入。另已驗證延遲的成功回應不會把新編輯標成已儲存，並以隔離資料庫核對容器重建及備份還原的文件、附件與偏好。仍待核對自動儲存定時和不同版本草稿救回。 |
| WEB-05／統計、寫作模式、偏好和主題 | [word-count.spec.ts](../../tests/e2e/word-count.spec.ts)、[writing-modes.spec.ts](../../tests/e2e/writing-modes.spec.ts)、[preferences-menu.spec.ts](../../tests/e2e/preferences-menu.spec.ts)、[桌面主題說明](../../docs/themes.md)。 | 狀態列提供統計；`F8`／`F9` 或偏好開關切換模式；偏好存至工作區；自訂 CSS 由選檔器匯入，在服務內保存而不掃描系統資料夾。 | **已驗證**：[editor.spec.ts](../tests/editor.spec.ts) 使用桌面同一份統計樣本，核對全文、選取與編輯後統計；以鍵盤啟用模式，從全新瀏覽器環境核對內建主題和模式。另測淡化、垂直置中、自訂 CSS 和其他偏好。 |
| WEB-06／PDF | [原生 PDF 實作](../../src-tauri/src/export.rs)、[原生 smoke 驗證](../../src-tauri/examples/export_pdf_smoke.rs)、[export-diagrams.spec.ts](../../tests/e2e/export-diagrams.spec.ts)。 | 「匯出其他格式」→「PDF」，由本機 Chromium 產生下載，不依賴瀏覽器列印對話框。 | **已驗證**：[export.spec.ts](../tests/export.spec.ts) 讀取真實 PDF 的巢狀書籤、表格文字、內嵌圖片與圖表標籤；與無公式的對照檔比較向量繪圖。另測多頁排版、字型與工具缺失。 |
| WEB-06／多格式雙向轉換 | [pandoc.spec.ts](../../tests/e2e/pandoc.spec.ts)、[原生 Pandoc 實作](../../src-tauri/src/pandoc.rs)。 | 選單由本機服務執行 Pandoc。匯出：DOCX、ODT、LaTeX、MediaWiki、EPUB。匯入：DOCX、ODT、EPUB、LaTeX、HTML、MediaWiki。 | **已驗證**：[export.spec.ts](../tests/export.spec.ts) 檢查 DOCX 實體結構，匯回後核對標題、清單、表格、數學和資料庫附件。其餘格式、缺少工具、錯誤提示及暫存檔清理仍需逐項核對。 |
| 原生選單、Open With 與平台行為 | [app-menu.test.ts](../../src/menu/app-menu.test.ts)、[open-with.spec.ts](../../tests/e2e/open-with.spec.ts)、[windows-ux.spec.ts](../../tests/e2e/windows-ux.spec.ts)。 | 可見工具列、應用程式快捷鍵、選檔器取代原生程式整合。瀏覽器保留部分快捷鍵。 | **未對齊**：沒有系統原生選單、作業系統 `Open With`、Touch Bar、關閉視窗時的桌面版全分頁流程。另須在實際 Chrome／Edge 與繁中 IME 確認可見替代入口；未承諾 Safari／Firefox。 |

## 執行真實資料庫驗收

2026-11-23：在 WSL 用以下命令執行無頭 Chromium，連至獨立 Compose Web/API 和 PostgreSQL 17。**16 個案例全數通過**，包含 390／1360 px 的文件操作選單、格內 LaTeX 渲染與原始碼切換，以及實際停止並重新啟動 PostgreSQL。PDF 使用容器內 Chromium 產生，DOCX 用 Pandoc 3.8.3 匯出並匯回。本次結果不涵蓋原生平台或表中的待驗證事項。

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
- 自動化成果（下載、失敗追蹤）存於 `test-results/web/`。測試結果只適用於實際執行的案例和環境，不代表原生選檔器、實體 IME 或全部轉換格式已驗收。
