# ADR 0002：透過本機 API 存入自管資料庫

**狀態：** 自管資料庫與本機開發範圍已確認。實作使用 TypeScript API 與 PostgreSQL 17，Compose 從本機啟動；桌面功能與平台驗收進度見[對照表](../desktop-parity.md)。

## 背景

[Web 版 PRD](../../PRD.md) 要求 Web 版以桌面版功能為基準、可從本機匯入 Markdown，並將工作區文件儲存在使用者自管的資料庫。暫不發布到公開網域。[ADR 0001](./0001-client-only-web-editor.md) 建議的瀏覽器草稿無法作為自管資料庫，因此不採用純前端儲存方案。

## 決策考量

- 匯入與儲存要有明確的成功狀態；重新載入不能依賴瀏覽器原有草稿。
- 優先重用桌面版的 TypeScript、Vite 與 CodeMirror 編輯行為。瀏覽器不應直接取得資料庫帳密。
- 本機開發應可重複啟動，而且停止容器不應清掉資料。

## 考慮過的方案

1. **瀏覽器加 IndexedDB。** 不需服務端，但資料只留在瀏覽器，不能滿足自管資料庫的要求。
2. **本機 API 加 SQLite。** 依賴較少，適合單一服務與檔案備份；資料庫檔案需由 API 管理，和獨立的 PostgreSQL 服務運作模式不同。
3. **本機 API 加 PostgreSQL。** 多一個服務需管理，但可用 Compose 獨立啟動與驗證資料庫，讓瀏覽器與資料庫各自只接觸需要的介面。

## 決策

先以 [Compose 的 PostgreSQL 17](../../compose.yaml) 作為開發資料庫。使用具名磁碟區讓資料跨容器重建保留；主機連接埠只綁定 `127.0.0.1`。不設定公開網域或部署管線。

Web 前端沿用 TypeScript、Vite 與 CodeMirror，不先加 UI 框架。同樣用 TypeScript 建立本機 API，由 API 匯入、儲存和讀取 Markdown。PostgreSQL 是文件的權威來源；瀏覽器可以保留編輯中的內容，但 API 確認寫入成功前，不顯示為已儲存。本機服務使用 Node HTTP；Markdown、附件與設定存入 PostgreSQL，文件以版本防止覆蓋。轉檔在本機執行 Chromium 與 Pandoc。介面、資料大小與服務限制見[本機 API 說明](../../server/api.md)。

## 驗證

- 目前：按[開發說明](../../README.md)啟動資料庫並執行查詢，確認停止後重新啟動仍可讀回資料。
- Web 功能完成後：匯入 Markdown、儲存，再用乾淨的瀏覽器設定檔重開並讀回同一份內容。模擬資料庫不可用時，確認介面不誤報儲存成功，也不丟棄目前編輯內容。
