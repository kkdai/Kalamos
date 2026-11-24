# kalamos

## 0.8.0

### Minor Changes

- **應用程式內自動更新**：支援啟動時背景檢查與透過選單手動檢查更新，有新版時先詢問並顯示更新內容與下載進度，下載完成並確認未儲存文件後再進行簽章驗證安裝與重啟，亦可於偏好設定「一般」開關自動檢查更新（#91）。

### Patch Changes

- **偏好設定介面語言錯誤提示**：修正儲存介面語言或重新啟動失敗後，錯誤訊息可能被後續的設定同步覆蓋或清除的問題。

## 0.7.0

### Minor Changes

- **YAML 文件資訊預覽**：即時預覽會將開頭的 YAML Front Matter 顯示為文件資訊，支援清單與巢狀欄位，點一下即可就地編輯原文（#123）。
- **繁體中文與英文介面**：在「偏好設定 → 一般」選擇介面語言，可立即重啟或等到下次開啟 Kalamos 時套用至 App 介面與原生選單（#125）。

## 0.6.0

### Minor Changes

- **Ctrl + 滾輪縮放**：按住 Ctrl 滾動滑鼠滾輪即可放大或縮小介面，與「檢視 > 放大 / 縮小 / 實際大小」共用縮放比例（#112）。

## 0.5.0

### Minor Changes

- **Cmd+P 快速開檔**：模糊搜尋目前資料夾的 Markdown 檔並標亮命中字元；輸入框空白時列出最近開啟的檔案，並新增「檔案 > 打開最近使用」子選單（#104）。

### Patch Changes

- **支持 Kalamos**：產品頁、README 與 GitHub 加入 Buy Me a Coffee 連結（#105）。
- **開發流程**：Workflow 權限強化、Biome 格式化與 CI 檢查、以 Changesets 管理版本與 CHANGELOG（#99、#100、#101）。

## 0.4.0

### Minor Changes

- **Windows 支援（實驗性）**：新增 Windows 10 / 11（x64）桌面版本，包含 NSIS 與 MSI 安裝程式、`.md` 檔案關聯、單一執行個體開檔、原生選單列、Windows 快捷鍵提示、關閉前未儲存變更檢查，以及透過無頭 Microsoft Edge / Google Chrome 匯出含書籤的 A4 PDF（#94、#97）。
- **自動化跨平台發佈流程**：新增 tag 觸發的 GitHub Actions 發佈流程，自動建置 macOS（Apple Silicon / Intel）與 Windows（NSIS / MSI）安裝檔、執行 macOS codesign 與 DMG 檢查、產生 `SHA256SUMS.txt` 並建立 Draft Release（#93）。

## 0.3.0

### Minor Changes

- **多文件分頁**：支援開新分頁（`Cmd+T`）、關閉與切換分頁、拖曳調整順序，各分頁獨立保留內容、復原紀錄、游標與捲動位置，並在關閉視窗或結束前提示所有未儲存變更（#81）。
