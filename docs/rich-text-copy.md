# 複製為富文字（Copy as Rich Text / HTML）

Kalamos 可以把寫好的 Markdown（選取範圍或整份文件）一鍵轉換為精簡、乾淨的富文字 HTML 並寫入系統剪貼簿，方便直接貼到 **Gmail、Google Docs、Medium、Notion、Facebook** 等平台，不需匯出中介檔案，也完全在本機運作。

## 使用方式

- **選單**：**編輯 > 複製為富文字**（English: **Edit > Copy as Rich Text**），macOS 與 Windows 皆提供。
- **快捷鍵**：`Cmd+Opt+Shift+C`（macOS）／`Ctrl+Alt+Shift+C`（Windows）。
  - *註：`Cmd+Shift+C`／`Ctrl+Shift+C` 已由「複製標題書籤連結（`ED-05`）」使用，`Cmd+Opt+C`／`Ctrl+Alt+C` 已由「插入程式碼區塊」使用，因此另選不衝突的組合鍵。*
- **複製範圍**：
  - **有選取文字**：只複製選取的部分。
  - **沒有選取文字**：複製整份文件。
  - **YAML Front Matter**：文件開頭的 YAML front matter 不會被複製進去（無論是 `text/html` 或 `text/plain`，也不論是否全選整份文件）；但其中的 `typora-root-url` 仍會用於解析本機圖片路徑。
- **剪貼簿內容**：同時寫入兩種格式：
  - `text/html`：適合貼上的精簡 HTML 片段（不含整份主題 CSS 與 `<style>` 標籤，只保留必要 inline style）。
  - `text/plain`：對應的純 Markdown 原文（已移除 YAML front matter），貼到純文字編輯器或 Facebook 等只吃純文字的欄位時可完整保留內容。
- **狀態列提示**：複製完成後於左下角狀態列顯示結果（含本機圖片上傳、內嵌或略過的提醒）。

## 格式保留方式

- **標題、段落、粗體／斜體／刪除線、清單、連結、引用**：輸出語意化 HTML（`<h1>`–`<h6>`、`<p>`、`<strong>`、`<em>`、`<del>`、`<ul>`／`<ol>`、`<a>`、`<blockquote>`），不強行指定內文字體或整頁背景色，讓貼上的內容自然融入目標編輯器的版型。
- **任務清單**：使用 Unicode 勾選方塊（`☑`／`☐`），避免無 CSS 時未勾選框消失。
- **程式碼區塊**：保留等寬字型（monospace）、換行與縮排（`white-space: pre-wrap`），並將語法高亮色彩轉為精簡 inline style。
- **表格**：附上 `border-collapse: collapse`、儲存格邊框、表頭背景與欄位對齊（`text-align`），確保貼到 Gmail 與 Google Docs 時表格邊框與欄寬清楚正確。

## 數學、圖表與圖片的處理方式

### 數學公式（`$...$` 與 `$$...$$`）

- **做法**：先由內建 MathJax 渲染成靜態 SVG，再透過離線 Canvas 轉成 **2× 高解析度 PNG `data:` URI**（`<img src="data:image/png;base64,...">`），並把原始 TeX 寫進 `alt` 屬性；行內公式亦保留 `vertical-align` 基準線對齊。
- **為什麼不用 inline `<svg>` 或 `data:image/svg+xml`？**
  - Gmail、Google Docs、Medium、Notion 基於安全政策會直接剝除 inline `<svg>`；Gmail 與 Google Docs 亦不支援貼上 `data:image/svg+xml`。
  - 轉成點陣 PNG `data:` URI 在 Gmail（送出時自動轉為內嵌圖檔）、Google Docs、Word、Apple Mail 等富文字目標中相容性最好；在只讀純文字的目標（例如 Facebook）則自動使用剪貼簿中的 `text/plain`（保留原始 `$...$` / `$$...$$`）。
- **降級處理**：若公式語法錯誤或無法點陣化，會自動保留原始 TeX 文字（行內 `<code>`／區塊 `<pre><code>`），不會遺失內容。

### 圖表（Mermaid / flowchart.js / sequence）

- **做法**：沿用匯出管線以淺色列印主題（`PRINT_DIAGRAM_THEME`、停用 `htmlLabels`、經 DOMPurify 與靜態安全檢查）渲染成 SVG，再轉成 **白底 2× PNG `data:` URI** 的 `<img>`（確保貼到深色或淺色目標都清晰可讀）。
- **降級處理**：若環境無法進行 Canvas 點陣化，改輸出 `<img src="data:image/svg+xml;base64,...">`；若圖表語法錯誤，保留程式碼區塊並附上錯誤說明。

### 圖片（遠端圖片與本機圖片）

- **遠端圖片（`http://`、`https://`）與既有的 `data:` 圖片**：原樣保留 `src`、`alt`、`title` 與 `<img>` 尺寸設定（`IM-03`）。
- **本機圖片（相對路徑、絕對路徑、`/` 圖片根目錄）**：
  1. **已設定圖床上傳指令（`uploadCommand`，見 [docs/image-upload.md](image-upload.md)）**：複製為富文字時會自動上傳該範圍內的本機圖片（同一張圖只上傳一次），並在剪貼簿 HTML 中填入上傳後的 `https://` 網址。此操作**不會修改**目前編輯中的 `.md` 文件。若上傳失敗，會自動降級改走本機嵌入流程並在狀態列提示。
  2. **未設定圖床（預設，完全離線）**：將本機圖片（支援 `png`、`jpg`、`jpeg`、`gif`、`webp`、`svg`）編碼成 `data:` URI 內嵌進 HTML，並設大小上限以避免剪貼簿膨脹：
     - **單張上限**：2 MB
     - **單次複製內嵌總量上限**：8 MB
     - 狀態列會主動提示已內嵌幾張本機圖片（以及部分目標網站如 Medium 可能無法顯示 `data:` URI 圖片）。
     - 若圖片超過大小限制、檔案不存在、或文件尚未儲存導致無法解析相對路徑，該處會顯示 `[alt]` 佔位文字並在狀態列提示略過張數。

## 各目標平台貼上行為參考

| 目標平台 | 標題／清單／粗斜體／連結／引用 | 程式碼區塊 | 表格 | 數學與圖表（PNG `data:` URI） | 本機圖片 |
| --- | --- | --- | --- | --- | --- |
| **Gmail** | 完整保留 | 保留等寬字、背景與換行 | 保留邊框與對齊 | 完整顯示（寄出自動內嵌） | 圖床網址或 `data:` URI 皆可顯示 |
| **Google Docs** | 完整保留 | 保留等寬字與換行 | 保留邊框與對齊 | 完整顯示 | 圖床網址或 `data:` URI 皆可顯示 |
| **Notion** | 完整保留 | 保留程式碼區塊 | 保留表格結構 | 視版本而定（部分 `data:` URI 需改用圖床） | 建議設定圖床 |
| **Medium** | 保留標題、粗斜體、引用、清單、連結 | 保留為程式碼區塊 | Medium 本身不支援原生表格 | Medium 會忽略 `data:` URI 圖片 | 建議設定圖床（Medium 只接受公開 URL） |
| **Facebook** | 僅支援純文字（自動讀取 `text/plain`） | 以 Markdown 原文貼上 | 以 Markdown 原文貼上 | 保留原始 TeX / 程式碼 | 需手動附圖 |
