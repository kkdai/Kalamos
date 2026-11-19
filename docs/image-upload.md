# 圖床上傳（IM-05）

Kalamos 透過「自訂上傳指令」把本機圖片上傳到圖床，成功後把文件中的圖片路徑換成遠端網址。
做法與 Typora / PicGo 的「Custom Command」相同：Kalamos 執行你指定的程式，把圖片路徑當參數傳進去，
程式在 stdout 每行印出一個網址。

## 使用

- **Cmd+Opt+U**：上傳圖片。
  - 游標在（或選取範圍涵蓋）本機圖片上 —— `![alt](path)` 或 `<img src="path">` —— 只上傳那幾張。
  - 否則上傳整份文件的所有本機圖片（狀態列先顯示「將上傳 N 張圖片…」）。
  - `http(s)://` 與 `data:` 圖片不會上傳；未命名文件只會上傳絕對路徑的圖片。
- 狀態列：`上傳中… (n/N)` → `已上傳 N 張圖片`，失敗時 `上傳失敗：…`（失敗時文件完全不變）。
- 成功時只替換路徑，alt、title 與 `<img>` 其他屬性保持不變；全部替換是**一個**復原步驟（Cmd+Z 一次還原）。
- 上傳期間可以繼續編輯；若某張圖片的引用在上傳期間被改動，該處不會被替換，狀態列會說明。
- 同一張圖片在文件中出現多次只上傳一次。

## 設定（`settings.json`）

設定檔位置：`~/Library/Application Support/io.kalamos.app/settings.json`。
目前沒有設定畫面，請直接編輯此檔。

- `uploadCommand` 與 `uploadArgs` **只能從這個檔案設定**：Kalamos 會讀取並顯示它們，但從不寫入——
  app 儲存其他設定（主題、側欄、專注模式…）時一律保留檔案中這兩個鍵的現有值，所以 Kalamos 開著時編輯也不會被蓋掉。
  這也是安全措施：即使編輯器畫面中的內容被注入腳本，也無法把上傳指令改成其他程式。
- 上傳指令每次上傳時重新讀取，改完不需重新啟動。
- `uploadOnInsert` 是一般設定，app 會照常讀寫。

| 鍵 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `uploadCommand` | 字串或 `null` | `null` | 上傳程式。絕對路徑，或只寫名稱（會在 PATH、`/opt/homebrew/bin`、`/usr/local/bin` 尋找） |
| `uploadArgs` | 字串陣列 | `[]` | 放在圖片路徑前面的固定參數 |
| `uploadOnInsert` | 布林 | `false` | 貼上 / 拖放圖片並存進 `assets/` 後，立刻自動上傳並替換 |

範例（PicGo CLI，`picgo upload <檔案…>`）：

```json
{
  "uploadCommand": "/opt/homebrew/bin/picgo",
  "uploadArgs": ["upload"],
  "uploadOnInsert": false
}
```

Kalamos 逐張上傳，每張圖片執行一次 `/opt/homebrew/bin/picgo upload /path/a.png`（每次一個路徑，狀態列才能顯示進度）。

## 上傳程式的規則

- 以參數陣列執行，**不經過 shell**：路徑中的空白、中文、`$()`、`;` 都只是檔名的一部分，不會被解譯。
- 程式必須以結束碼 0 結束，並在 stdout 印出網址：Kalamos 取**最後 N 行**看起來像 `http://` 或 `https://` 網址的行（N = 圖片數）。前面可以有其他輸出。
- 結束碼非 0、60 秒內沒結束（會被強制結束）、或網址數量不足，都算失敗，錯誤訊息附上 stderr 末段，文件不會被部分替換。
- 只接受存在的本機檔案，副檔名限 png、jpg、jpeg、gif、webp、svg；資料夾會被拒絕。
- 上傳程式**只能**由使用者編輯 `settings.json` 指定；app 本身（包括編輯器畫面）與文件內容（包括 front matter）都無法指定或改變上傳程式。

自己寫上傳程式時，最簡單的形式是一個可執行的 script：

```sh
#!/bin/sh
# 每個參數是一張圖片的絕對路徑；每行輸出一個網址。
for f in "$@"; do
  my-upload-tool "$f" || exit 1
done
```

## iPic

macOS 的 iPic 尚未內建預設：目前沒有可離線驗證的 iPic 整合介面文件，因此不猜測它的協定。
若你的 iPic 版本提供命令列工具，可把它設為 `uploadCommand`，只要符合上面的輸出規則即可。
