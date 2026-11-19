# Kalamos Styles & Theme System (`src/styles/`)

依 `docs/PRD.md` §12（品牌與設計語言）與 Issue #2 實作 Kalamos 兩套內建主題 **Papyros（莎草紙，淺色）** 與 **Melan（墨，深色）**，以及 CodeMirror 6 內文排版與即時預覽（WYSIWYM）樣式。

---

## 檔案結構

| 檔案 | 說明 |
| --- | --- |
| `tokens.css` | 共用設計變數：`--k-font-body`、`--k-font-ui`、`--k-font-mono`、內文字級 `--k-font-size: 17px`、行高 `--k-line-height: 1.75`、版心寬度 `--k-max-width: 720px`、游標粗細 `2px`、圖示筆劃 `1.5px`、動效 `150–200ms ease-out` |
| `themes/papyros.css` | 淺色主題 **Papyros**（`:root[data-theme="papyros"]` / `[data-theme="papyros"]`）色票變數 |
| `themes/melan.css` | 深色主題 **Melan**（`:root[data-theme="melan"]` / `[data-theme="melan"]`，並支援 `prefers-color-scheme: dark` 系統預設跟隨） |
| `editor.css` | CodeMirror 6 編輯區（`.cm-editor`、`.cm-content`、`.cm-line`、游標、選取色）與語法裝飾 class（`.k-h1`…`.k-h6`、`.k-strong`、`.k-em`、`.k-strike`、`.k-code`、`.k-link`、`.k-blockquote`、`.k-hr`、`.k-mark`、`.k-mark-hidden`） |
| `preview.html` | 獨立靜態預覽頁，直接以瀏覽器開啟即可切換 Papyros / Melan 主題與檢視排版效果 |

---

## 待打包的 `@fontsource` 字體套件（PRD §12.4）

目前 CSS 先以系統字體作為 fallback。待 PM / 專案骨架加入依賴時，需安裝並離線打包以下開源字體套件：

- `@fontsource/source-serif-4` — 內文英文（`Source Serif 4`）
- `@fontsource/noto-serif-tc` — 內文繁體中文（`Noto Serif TC`，思源宋體）
- `@fontsource/inter` — 介面英文（`Inter`）
- `@fontsource/noto-sans-tc` — 介面繁體中文（`Noto Sans TC`）
- `@fontsource/jetbrains-mono` — 程式碼等寬字體（`JetBrains Mono`）

對應 CSS 變數（定義於 `tokens.css`）：

- 內文：`--k-font-body: "Source Serif 4", "Noto Serif TC", serif;`
- 介面：`--k-font-ui: Inter, "Noto Sans TC", sans-serif;`
- 程式碼：`--k-font-mono: "JetBrains Mono", monospace;`

---

## 語法符號隱藏與游標量測說明（`.k-mark-hidden` / `.k-mark`）

- **為何選用 `font-size: 0; letter-spacing: 0` 而非 `display: none`**：
  在 CodeMirror 6 以 `Decoration.mark({ class: "k-mark-hidden" })` 包裹行內語法符號（如 `**`、`*`、`` ` ``）時，若設為 `display: none`，該 `<span>` 與其內部 text node 會從瀏覽器 render tree 移除，`Range.getClientRects()` 回傳空矩形列表，容易導致 CodeMirror 的 `coordsAtPos` / `posAtCoords` 在隱藏邊界附近量測游標座標或行高時失準。改用 `font-size: 0; letter-spacing: 0; line-height: 0; opacity: 0`，行內 `<span>` 仍留在 render tree 且實際渲染寬度為 `0px`（字中間不留任何空白，符合 ED-01「不見星號」），同時 `getClientRects()` 仍可在基線位置回傳零寬度矩形，游標量測與移動皆正常。
- **符號淡入動效**：
  當游標進入節點、符號切換為 `.k-mark` 顯示時，透過 `@keyframes k-mark-fade-in`（`opacity: 0 → 1`，`150ms ease-out`）淡入，不使用任何 `transform`/`translate` 位移（符合 PRD §12.5）。

---

## 色票規格表（PRD §12.3）

| 變數名稱 | 用途 | Papyros（淺色） | Melan（深色） |
| --- | --- | --- | --- |
| `--k-bg` | 背景（紙面） | `#F5EFE0` | `#1C1A17` |
| `--k-surface` | 側欄 / 表面 | `#EDE4CF` | `#25221E` |
| `--k-text` | 主要文字（墨） | `#2B2622` | `#E8E0D0` |
| `--k-text-muted` | 次要文字 | `#6E6355` | `#9C9384` |
| `--k-accent` | 強調色（蘆葦綠） | `#5E7A4A` | `#93AE7C` |
| `--k-link` | 連結 / 選取（赭紅） | `#A4552F` | `#D98A63` |
| `--k-divider` | 分隔線 | `#D9CDB3` | `#3A362F` |

---

## WCAG 2.1 對比度計算表

依據 WCAG 2.1 相對亮度（Relative Luminance）與對比度公式：

$$\text{Contrast Ratio} = \frac{L_{\text{lighter}} + 0.05}{L_{\text{darker}} + 0.05}$$

一般文字合格門檻為 **WCAG AA ≥ 4.5:1**（大字 / 非文字 UI 元件門檻為 **3.0:1**，AAA 為 **7.0:1**）。

### 1. Papyros（淺色主題）

| 前景色（文字 / 元素） | 背景色 | 對比度 | WCAG AA（≥ 4.5:1） | 備註 |
| --- | --- | --- | --- | --- |
| `--k-text` (`#2B2622`) 主要文字 | `--k-bg` (`#F5EFE0`) 紙面背景 | **13.05 : 1** | ✅ 通過（AAA） | 內文主要文字 |
| `--k-text-muted` (`#6E6355`) 次要文字 | `--k-bg` (`#F5EFE0`) 紙面背景 | **5.11 : 1** | ✅ 通過（AA） | 引用、次要資訊、語法符號 |
| `--k-link` (`#A4552F`) 連結文字 | `--k-bg` (`#F5EFE0`) 紙面背景 | **4.67 : 1** | ✅ 通過（AA） | 內文超連結 |
| `--k-accent` (`#5E7A4A`) 強調色 | `--k-bg` (`#F5EFE0`) 紙面背景 | **4.20 : 1** | ⚠️ 非文字 UI 通過（≥ 3.0:1） | 只用於非文字 UI（邊框、指示條、狀態圖示） |
| `--k-text` (`#2B2622`) 主要文字 | `--k-surface` (`#EDE4CF`) 側欄/表面 | **11.83 : 1** | ✅ 通過（AAA） | 側欄主要文字、行內程式碼文字 |
| `--k-text-muted` (`#6E6355`) 次要文字 | `--k-surface` (`#EDE4CF`) 側欄/表面 | **4.64 : 1** | ✅ 通過（AA） | 側欄次要文字 |
| `--k-link` (`#A4552F`) 連結文字 | `--k-surface` (`#EDE4CF`) 側欄/表面 | **4.24 : 1** | ⚠️ 達 AA 大字/UI 3.0:1 | 連結主要用於紙面背景（4.67:1） |
| `--k-accent` (`#5E7A4A`) 強調色 | `--k-surface` (`#EDE4CF`) 側欄/表面 | **3.81 : 1** | ⚠️ 非文字 UI 通過（≥ 3.0:1） | 只用於非文字 UI（邊框、指示條、狀態圖示） |

### 2. Melan（深色主題）

| 前景色（文字 / 元素） | 背景色 | 對比度 | WCAG AA（≥ 4.5:1） | 備註 |
| --- | --- | --- | --- | --- |
| `--k-text` (`#E8E0D0`) 主要文字 | `--k-bg` (`#1C1A17`) 紙面背景 | **13.23 : 1** | ✅ 通過（AAA） | 內文主要文字 |
| `--k-text-muted` (`#9C9384`) 次要文字 | `--k-bg` (`#1C1A17`) 紙面背景 | **5.72 : 1** | ✅ 通過（AA） | 引用、次要資訊、語法符號 |
| `--k-link` (`#D98A63`) 連結文字 | `--k-bg` (`#1C1A17`) 紙面背景 | **6.42 : 1** | ✅ 通過（AA） | 內文超連結 |
| `--k-accent` (`#93AE7C`) 強調色 | `--k-bg` (`#1C1A17`) 紙面背景 | **7.10 : 1** | ✅ 通過（AAA） | 只用於非文字 UI（邊框、指示條、狀態圖示） |
| `--k-text` (`#E8E0D0`) 主要文字 | `--k-surface` (`#25221E`) 側欄/表面 | **12.07 : 1** | ✅ 通過（AAA） | 側欄主要文字、行內程式碼文字 |
| `--k-text-muted` (`#9C9384`) 次要文字 | `--k-surface` (`#25221E`) 側欄/表面 | **5.22 : 1** | ✅ 通過（AA） | 側欄次要文字 |
| `--k-link` (`#D98A63`) 連結文字 | `--k-surface` (`#25221E`) 側欄/表面 | **5.86 : 1** | ✅ 通過（AA） | 表面區塊內連結 |
| `--k-accent` (`#93AE7C`) 強調色 | `--k-surface` (`#25221E`) 側欄/表面 | **6.47 : 1** | ✅ 通過（AA） | 只用於非文字 UI（邊框、指示條、狀態圖示） |

### 對比度驗證結論

- **主要文字（`--k-text`）與次要文字（`--k-text-muted`）**：在 Papyros 與 Melan 兩套主題中，無論對紙面背景（`--k-bg`）或對側欄/表面（`--k-surface`），對比度皆 **≥ 4.64:1**，全數通過 **WCAG AA（≥ 4.5:1）** 驗收標準。
- **強調色使用規範**：`--k-accent` 只用於非文字 UI（邊框、指示條、狀態圖示），在兩套主題中對 `--k-bg` 與 `--k-surface` 皆符合 WCAG 2.1 非文字 UI 對比度（≥ 3.0:1）標準。
