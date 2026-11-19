# Kalamos 自訂主題指南（TH-01）

Kalamos 內建兩套主題：**Papyros（莎草紙，淺色）** 與 **Melan（墨，深色）**，並支援以標準 CSS 檔案完全自訂編輯器色彩、字級、排版對齊與標題自動編號。

---

## 1. 自訂主題放置路徑

將 `.css` 檔案放入 Kalamos 應用程式資料目錄下的 `themes/` 資料夾（啟動時若不存在會自動建立）：

- **macOS**：
  ```text
  ~/Library/Application Support/io.kalamos.app/themes/*.css
  ```

### 命名、選擇器規範與基底主題機制

1. **命名規則**：
   - 檔名（不含 `.css` 副檔名）即為選單顯示的主題名稱（內部 ID 為 `custom:<檔名>`）。
   - 例如：`~/Library/Application Support/io.kalamos.app/themes/night.css` 會在右上角主題選單中顯示為 **`night`**。
   - 隱藏檔（以 `.` 開頭，如 `.DS_Store`）或非 `.css` 檔案會自動略過。
   - 放入新 CSS 檔案後，重啟應用程式或開啟右上角主題選單即可選取套用；也可以使用快捷鍵 **`Cmd+Shift+T`** 循環切換主題。

2. **必須使用 `:root[data-custom-theme]` 選擇器**：
   - 內建主題色票定義在 `:root[data-theme="papyros"]` 與 `:root[data-theme="melan"]`（CSS 選擇器權重為 `0,2,0`）。
   - 自訂主題套用時，Kalamos 會在 `<html>` 加上 `data-custom-theme="custom:<檔名>"`，並將自訂 CSS 放進 `<style id="k-custom-theme">` 且固定插入於 `<head>` 的**最後一個子節點**。
   - 因此，**自訂主題的 CSS 變數請一律寫在 `:root[data-custom-theme] { ... }`**（同樣具備 `0,2,0` 權重，且因位於 `<head>` 最後方而必然覆蓋內建主題色票）。

3. **基底主題（Papyros / Melan）判斷與繼承規則**：
   - 自訂主題以 **Papyros（淺色）** 或 **Melan（深色）** 為基底，**未覆寫的 `--k-*` 變數會自動沿用基底主題的預設值**。
   - 基底主題的判斷順序如下：
     1. 若自訂 CSS 含有 `color-scheme: dark`（或 `data-base-theme: melan`）→ 以 **Melan** 為基底（`data-theme="melan"`）。
     2. 若自訂 CSS 含有 `color-scheme: light`（或 `data-base-theme: papyros`）→ 以 **Papyros** 為基底（`data-theme="papyros"`）。
     3. 若均未指定 → 跟隨目前系統外觀（`prefers-color-scheme: dark` 時為 **Melan**，否則為 **Papyros**）。

---

## 2. 可覆寫的 `--k-*` CSS 變數清單

所有變數皆於 `:root[data-custom-theme] { ... }` 內覆寫：

### 色彩變數（PRD §12.3）

| 變數名稱 | 用途 | Papyros 基底預設值 | Melan 基底預設值 |
| --- | --- | --- | --- |
| `--k-bg` | 背景（紙面） | `#F5EFE0` | `#1C1A17` |
| `--k-surface` | 側欄 / 表面 / 程式碼底色 | `#EDE4CF` | `#25221E` |
| `--k-text` | 主要文字（墨）與筆尖游標 | `#2B2622` | `#E8E0D0` |
| `--k-text-muted` | 次要文字 / 引用 / 語法符號 | `#6E6355` | `#9C9384` |
| `--k-accent` | 強調色（非文字 UI：引用邊框、分頁指示條、狀態圖示） | `#5E7A4A` | `#93AE7C` |
| `--k-link` | 連結文字與選取背景基底色 | `#A4552F` | `#D98A63` |
| `--k-divider` | 分隔線與邊框 | `#D9CDB3` | `#3A362F` |
| `--k-selection-bg` | 文字選取反白背景（半透明 fallback） | `rgba(164, 85, 47, 0.22)` | `rgba(217, 138, 99, 0.25)` |

### 字體、版面與動效變數（PRD §12.4–12.5）

| 變數名稱 | 用途 | 預設值 |
| --- | --- | --- |
| `--k-font-body` | 內文字體（英文 + 中文宋體） | `"Source Serif 4", "Noto Serif TC", serif` |
| `--k-font-ui` | 介面字體（側欄、選單） | `Inter, "Noto Sans TC", sans-serif` |
| `--k-font-mono` | 程式碼等寬字體 | `"JetBrains Mono", monospace` |
| `--k-font-size` | 內文字級 | `17px` |
| `--k-line-height` | 內文行高 | `1.75` |
| `--k-max-width` | 紙面版心最大寬度 | `720px` |
| `--k-sidebar-width` | 側欄寬度 | `260px` |
| `--k-cursor-width` | 編輯區游標粗細 | `2px` |
| `--k-icon-stroke-width` | 線條圖示筆劃粗細 | `1.5px` |
| `--k-transition-fast` | 快速過渡動效（符號淡入、hover） | `150ms ease-out` |
| `--k-transition` | 標準過渡動效（主題切換、側欄滑入） | `180ms ease-out` |
| `--k-transition-slow` | 較慢過渡動效 | `200ms ease-out` |

---

## 3. 自訂主題範例

### 範例一：自訂色彩 —— 綠色護眼紙面（`sage-paper.css`）

以 Papyros（`color-scheme: light`）為基底，覆寫紙面背景、側欄表面與文字墨色，其餘未寫的變數自動沿用 Papyros：

```css
:root[data-custom-theme] {
  color-scheme: light;
  --k-bg: #e8f0e4;
  --k-surface: #dce7d6;
  --k-text: #1f2921;
  --k-text-muted: #526354;
  --k-accent: #3d6b48;
  --k-link: #8f4926;
  --k-divider: #c2d1bc;
}
```

### 範例二：調整字級、行高與版心寬度（`reading-large.css`）

適合大螢幕長文閱讀與寫作：

```css
:root[data-custom-theme] {
  color-scheme: light;
  --k-font-size: 19px;
  --k-line-height: 1.85;
  --k-max-width: 800px;
}
```

### 範例三：內文兩端對齊（`justified.css`）

讓段落文字左右兩端齊行（排除標題與程式碼區塊）：

```css
:root[data-custom-theme] {
  color-scheme: light;
}

:root[data-custom-theme] .cm-content .cm-line {
  text-align: justify;
  text-justify: inter-ideograph;
}

:root[data-custom-theme] .cm-content .k-h1,
:root[data-custom-theme] .cm-content .k-h2,
:root[data-custom-theme] .cm-content .k-h3,
:root[data-custom-theme] .cm-content .k-h4,
:root[data-custom-theme] .cm-content .k-h5,
:root[data-custom-theme] .cm-content .k-h6,
:root[data-custom-theme] .cm-content .k-code-block {
  text-align: left;
}
```

### 範例四：標題自動編號（CSS Counter，`numbered-headings.css`）

為 H1～H3 標題加上 `1.`、`1.1`、`1.1.1` 自動層級編號（不修改 Markdown 原始檔案內容）：

```css
:root[data-custom-theme] .cm-content {
  counter-reset: k-h1 0 k-h2 0 k-h3 0;
}

:root[data-custom-theme] .cm-content .k-h1 {
  counter-increment: k-h1;
  counter-reset: k-h2 0 k-h3 0;
}

:root[data-custom-theme] .cm-content .k-h1::before {
  content: counter(k-h1) ". ";
  color: var(--k-text-muted);
  font-weight: 600;
}

:root[data-custom-theme] .cm-content .k-h2 {
  counter-increment: k-h2;
  counter-reset: k-h3 0;
}

:root[data-custom-theme] .cm-content .k-h2::before {
  content: counter(k-h1) "." counter(k-h2) " ";
  color: var(--k-text-muted);
  font-weight: 600;
}

:root[data-custom-theme] .cm-content .k-h3 {
  counter-increment: k-h3;
}

:root[data-custom-theme] .cm-content .k-h3::before {
  content: counter(k-h1) "." counter(k-h2) "." counter(k-h3) " ";
  color: var(--k-text-muted);
  font-weight: 600;
}
```
