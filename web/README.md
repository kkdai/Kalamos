# Kalamos Web｜本機驗收

在瀏覽器匯入及編輯 Markdown，再將文件、圖片附件和偏好保存在自己的 PostgreSQL。此環境只供本機使用；沒有帳號或公開網域，不要將連接埠開放給其他電腦。

## 啟動

安裝並啟動 Docker（含 Compose）。從儲存庫根目錄執行：

```sh
docker compose -f web/compose.yaml up --build -d --wait
```

開啟 **http://127.0.0.1:4173**。首次建置需要下載鏡像、依賴、Chromium 與 Pandoc；啟動後編輯、資料庫保存與轉檔可用本機資源完成。Compose 內建 Pandoc 3.8.3 與沙箱化 Chromium。應用程式啟動時自動套用未執行的 SQL 遷移；健康檢查確認應用程式可查詢資料庫。

執行 `docker compose -f web/compose.yaml down` 停止服務。一般停止或重建容器不會刪除資料；**不要對開發資料執行 `down --volumes`**。

## 驗收流程

1. 從左側欄選「開啟」匯入一份 UTF-8 `.md`；也可從右上角「文件操作」匯入 Markdown 或整個資料夾。匯入資料夾會保留子路徑和支援的圖片附件。無效檔案會顯示原因；重複路徑不會自動覆寫。若要同步本機對原檔的編輯，先儲存工作區文件，再從「文件操作 → 從本機重新匯入」選檔並確認。本機原檔不會變更。
2. 編輯標題、表格、公式 `$x^2$` 或 Mermaid 區塊；可用右上角「原始碼」切換檢查內容。若相對圖片缺檔，到「文件操作 → 匯入圖片附件」並使用文件引用的工作區路徑。
3. 選「儲存」並等待「已儲存」，再以全新的瀏覽器設定檔開啟同一網址，確認文件與附件仍在。遇到版本衝突或資料庫中斷，介面不會顯示已儲存；可下載目前內容。
4. 從側欄「搜尋」依內容找跨文件命中；可切換大小寫、全字與正規表示式。點命中可跳到已儲存版本，不會改動尚未儲存的編輯。從「文件操作 → 在文件中尋找」可搜尋目前文件。
5. 從「文件操作」下載 Markdown 或匯出 PDF／DOCX。PDF 渲染不擷取遠端圖片；如需在 PDF 中顯示圖片，請先匯入為工作區附件。

工作區功能、平台差異和測試證據見[功能對照](./docs/desktop-parity.md)。目前自動化以 Chromium 為準，不代表已手動驗證各系統的 Chrome／Edge 選檔器、輸入法和快捷鍵。附件支援 PNG、JPEG、GIF、WebP、AVIF、BMP、ICO，不接受 SVG。ODT 的公式匯入受 Pandoc 限制；LaTeX 與 MediaWiki 匯出保留圖片參照，不打包圖片。

## 開發與備份

- 本機開發預設 Web 連接埠 `4173`、PostgreSQL `5432`；有衝突時用 `KALAMOS_WEB_PUBLISHED_PORT` 或 `KALAMOS_DB_PUBLISHED_PORT` 改主機連接埠。主機連線預設 `postgresql://kalamos:kalamos_dev@127.0.0.1:5432/kalamos`，帳密僅供本機開發使用。
- 若要分開執行 Vite 與 API，先 `npm ci`，用 `docker compose -f web/compose.yaml up -d --wait db` 啟動資料庫，再於不同終端執行 `npm run start:web` 和 `npm run dev:web`，開啟 `http://127.0.0.1:5173`。使用 Node.js 22.18 以上；主機執行時轉檔需有 Pandoc 和可用沙箱的 Chromium。執行 `npm run build:web` 檢查型別與產物。
- 圖床功能預設不啟用；Compose 不包含圖床工具。以主機執行 API 時，操作者可在 API 端以 `KALAMOS_UPLOAD_COMMAND` 指定可執行檔；瀏覽器確認後才向該工具提供本機暫存副本。詳細限制見[本機 API 說明](./server/api.md)。
- PostgreSQL 的具名磁碟區不是備份。若要備份文件、附件與偏好，先停止寫入，執行：
  ```sh
  docker compose -f web/compose.yaml exec -T db pg_dump -U kalamos -Fc kalamos > kalamos-backup.dump
  ```
  在獨立資料庫驗證還原，不覆寫使用中的資料庫：
  ```sh
  docker compose -f web/compose.yaml exec -T db createdb -U kalamos kalamos_restore_check
  docker compose -f web/compose.yaml exec -T db pg_restore --exit-on-error -U kalamos -d kalamos_restore_check < kalamos-backup.dump
  ```
- 自動化測試必須指向獨立的資料庫與 Compose 專案，見[驗收指令](./docs/desktop-parity.md#執行真實資料庫驗收)。Compose 使用 Playwright 的 [Chromium seccomp 設定](https://github.com/microsoft/playwright/blob/v1.65.1/utils/docker/seccomp_profile.json)，保留 Chromium 沙箱；[Apache-2.0 授權](./licenses/playwright-Apache-2.0.txt)。

## 相關文件

- [Web 版 PRD](./PRD.md)
- [ADR 0002：透過本機 API 存入自管資料庫](./docs/decisions/0002-self-managed-database.md)
- [實作計畫](./docs/plans/feat_web_desktop-parity.md)
