#!/usr/bin/env node
/**
 * Capture real Kalamos screenshots via the Vite dev server + Playwright IPC mock.
 *
 * Usage:
 *   until ! lsof -i :1420 -t; do sleep 2; done
 *   node scripts/capture-screenshots.mjs                     # all 4 heroes + 5 shared
 *   node scripts/capture-screenshots.mjs --hero-only         # all 4 localized heroes
 *   node scripts/capture-screenshots.mjs --lang zh-TW        # zh-TW hero + 5 shared
 *   node scripts/capture-screenshots.mjs --lang ja --hero-only
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "site", "assets", "screenshots");
const PORT = 1420;
const BASE_URL = `http://localhost:${PORT}`;

const HERO_DOCS = {
  en: {
    file: "hero-live-preview.png",
    content: [
      "# Kalamos — Write, and it appears.",
      "",
      "Kalamos renders **Markdown** cleanly as you type, hiding syntax markers the moment your cursor moves on — with *quiet paper typography* and zero split-pane clutter.",
      "",
      "> The page stays quiet until you need a tool. Only paper, ink, and your words.",
      "",
      "## Instant Live Preview",
      "",
      "- Single-pane **WYSIWYM** editing with `Cmd+/` instant Source Mode",
      "- Native CJK emphasis around full-width punctuation and smooth IME input",
      "- Atomic 1-second autosave with crash recovery for untitled drafts",
      "",
      "## Publishing Checklist",
      "",
      "- [x] Draft technical article in **Papyros** warm paper theme",
      "- [x] Verify tables, `MathJax` equations, and Mermaid flowcharts",
      "- [ ] Export to PDF with nested outline bookmarks (`Cmd+Shift+E`)",
      "",
    ].join("\n"),
  },
  "zh-TW": {
    file: "hero-live-preview-zh-TW.png",
    content: [
      "# Kalamos — 落筆即成文",
      "",
      "在單一視窗中以「**即時預覽**」撰寫 **Markdown**，游標離開段落後自動隱去語法符號，支援全形標點旁的粗斜體與流暢的 *CJK 輸入法組字*。",
      "",
      "> 介面是一張安靜的紙，工具是一支筆，只在需要時出現。",
      "",
      "## 單一視窗所見即所得",
      "",
      "- 無須雙欄預覽，按 `Cmd+/` 隨時切換純 Markdown 原始碼模式",
      "- 內建視覺化表格、離線 `MathJax` 數學公式與 Mermaid 圖表",
      "- 1 秒自動存檔與異常救回，所有筆記皆為本機標準 GFM 檔案",
      "",
      "## 發布前檢查清單",
      "",
      "- [x] 以 **Papyros** 莎草紙淺色主題完成技術文章草稿",
      "- [x] 檢查表格對齊、數學公式與程式碼區塊語法高亮",
      "- [ ] 匯出含巢狀書籤的 A4 PDF 文件（`Cmd+Shift+E`）",
      "",
    ].join("\n"),
  },
  ja: {
    file: "hero-live-preview-ja.png",
    content: [
      "# Kalamos — 書いた瞬間に、そのままの姿へ",
      "",
      "単一ペインの「**ライブプレビュー**」で **Markdown** を軽快に執筆。カーソルが離れると記号が静かに消え、日本語の *IME 変換* も途切れず滑らかに動作します。",
      "",
      "> 紙面は静かに保たれ、道具は必要なときだけ現れる。",
      "",
      "## 単一ペインの WYSIWYM 編集",
      "",
      "- 分割プレビュー不要。`Cmd+/` でいつでもソースモードへ切り替え",
      "- 視覚的なテーブル編集、オフライン `MathJax` 数式、Mermaid 図表を内蔵",
      "- 1 秒自動保存とクラッシュリカバリでローカルの標準 GFM ファイルを保護",
      "",
      "## 公開前チェックリスト",
      "",
      "- [x] **Papyros** ライトテーマで技術記事の下書きを仕上げる",
      "- [x] テーブル整形、数式、コードブロックのハイライトを確認",
      "- [ ] しおり付き A4 PDF を書き出す（`Cmd+Shift+E`）",
      "",
    ].join("\n"),
  },
  ko: {
    file: "hero-live-preview-ko.png",
    content: [
      "# Kalamos — 쓰는 순간, 문서가 됩니다",
      "",
      "단일 창 **실시간 미리보기**로 **Markdown**을 차분하게 작성하세요. 커서가 벗어나면 문법 기호가 숨겨지며, *한글 IME 조합* 중에도 화면이 흔들리지 않습니다.",
      "",
      "> 화면은 종이처럼 고요하게 남고, 도구는 필요할 때만 나타납니다.",
      "",
      "## 단일 창 WYSIWYM 편집",
      "",
      "- 분할 미리보기 없이 바로 렌더링하며 `Cmd+/`로 언제든 소스 모드 전환",
      "- 시각적 표 편집, 오프라인 `MathJax` 수식, Mermaid 다이어그램 기본 내장",
      "- 1초 자동 저장과 충돌 복구로 표준 GFM 문서를 로컬에 안전하게 보관",
      "",
      "## 발행 전 체크리스트",
      "",
      "- [x] **Papyros** 라이트 테마로 기술 문서 초안 작성 완료",
      "- [x] 표 정렬, 수식 렌더링, 코드 블록 구문 강조 확인",
      "- [ ] 북마크가 포함된 A4 PDF로 내보내기 (`Cmd+Shift+E`)",
      "",
    ].join("\n"),
  },
};

function parseArgs(argv) {
  let lang = "all";
  let heroOnly = false;
  let sharedOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hero-only") heroOnly = true;
    else if (arg === "--shared-only") sharedOnly = true;
    else if (arg === "--lang" && argv[i + 1]) lang = argv[++i];
    else if (arg.startsWith("--lang=")) lang = arg.slice("--lang=".length);
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/capture-screenshots.mjs [--lang en|zh-TW|ja|ko|all] [--hero-only|--shared-only]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const validLangs = Object.keys(HERO_DOCS);
  if (lang !== "all" && !validLangs.includes(lang)) {
    throw new Error(
      `Invalid --lang "${lang}". Expected one of: all, ${validLangs.join(", ")}`,
    );
  }
  if (heroOnly && sharedOnly) {
    throw new Error("Cannot combine --hero-only and --shared-only");
  }
  return {
    langs: lang === "all" ? validLangs : [lang],
    captureHeroes: !sharedOnly,
    captureShared: !heroOnly,
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startVite() {
  const proc = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (chunk) => {
    const s = chunk.toString();
    if (s.includes("Error")) process.stderr.write(s);
  });
  return proc;
}

async function nextFrames(page, n = 4) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const tick = () =>
          --left <= 0 ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
      }),
    n,
  );
}

async function bootApp(page) {
  await page.goto(BASE_URL);
  await page.waitForFunction(() => Boolean(window.__kalamos));
  await page.waitForFunction(async () => {
    const main = await import("/src/main.ts");
    return Boolean(main.getActiveApp());
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

async function resetApp(
  page,
  { theme = "papyros", sidebar = false, tab = "tree" } = {},
) {
  await page.evaluate(
    async ({ theme, sidebar, tab }) => {
      const main = await import("/src/main.ts");
      const app = main.getActiveApp();
      app.editor.setSourceMode(false);
      app.editor.setFocusMode(false);
      app.editor.setTypewriterMode(false);
      app.editor.setCodeLineNumbers(false);
      app.editor.setMathAutoNumber(false);
      main.applyTheme(theme);
      await app.sidebar.setTab(tab, false);
      await app.sidebar.setVisible(sidebar, false);
      const status = document.querySelector("#status");
      if (status) {
        status.textContent = "";
        status.dataset.error = "false";
      }
    },
    { theme, sidebar, tab },
  );
  await nextFrames(page, 4);
}

async function setDoc(page, content, cursor = 0) {
  await page.evaluate(
    async ({ content, cursor }) => {
      const main = await import("/src/main.ts");
      const app = main.getActiveApp();
      app.editor.setContent(content, { dirty: false });
      app.editor.setCursor(cursor);
      app.editor.view.focus();
      app.editor.view.scrollDOM.scrollTop = 0;
    },
    { content, cursor },
  );
  await nextFrames(page, 4);
}

async function captureAll() {
  const opts = parseArgs(process.argv.slice(2));
  const vite = startVite();
  let browser;
  try {
    await waitForServer(BASE_URL);
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 960, height: 700 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await bootApp(page);

    if (opts.captureHeroes) {
      for (const lang of opts.langs) {
        const spec = HERO_DOCS[lang];
        await resetApp(page, { theme: "papyros", sidebar: false });
        await setDoc(page, spec.content, spec.content.length);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(OUT_DIR, spec.file) });
        console.log(`Captured ${spec.file}`);
      }
    }

    if (opts.captureShared) {
      // 2. Table Editing with Floating Toolbar
      await resetApp(page, { theme: "papyros", sidebar: false });
      const tableDoc = [
        "## WYSIWYG Tables ／ 視覺化表格編輯",
        "",
        "Press `Cmd+Opt+T` to insert a table, or type `|col1|col2|` and press Enter. Edit cells in place, drag borders to resize columns, and use the floating toolbar.",
        "",
        "| Feature | Shortcut | Output |",
        "| :--- | :---: | ---: |",
        "| Live Preview | `Cmd+/` | PDF · DOCX · EPUB |",
        "| Table Toolbar | `Cmd+Opt+T` | GFM Aligned |",
        "| MathJax 3 | `Cmd+Opt+N` | SVG Vector |",
        "| Mermaid Diagrams | `mermaid` | Inline SVG |",
        "| Ataraxia Focus | `F8` | Distraction-Free |",
        "",
        "Every edit keeps the underlying Markdown pipes neatly aligned — including double-width CJK characters — and reverts in a single Undo step.",
      ].join("\n");
      await setDoc(page, tableDoc, 0);
      const targetCell = page
        .locator(
          '.k-table-wrapper td[data-row="2"][data-col="0"] .k-table-cell-content',
        )
        .first();
      await targetCell.click();
      await page.waitForSelector('[data-testid="table-toolbar"]', {
        state: "visible",
        timeout: 5000,
      });
      await page.evaluate(async () => {
        const main = await import("/src/main.ts");
        main.getActiveApp().editor.view.scrollDOM.scrollTop = 0;
      });
      await nextFrames(page, 6);
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT_DIR, "table-editor.png") });
      console.log("Captured table-editor.png");

      // 3. Math & Diagrams (MathJax 3 + Mermaid)
      await resetApp(page, { theme: "papyros", sidebar: false });
      const mathDiagDoc = [
        "## Math & Diagrams ／ 數學公式與圖表",
        "",
        "Inline math like $E = mc^2$ and chemistry $\\ce{2H2 + O2 -> 2H2O}$ render offline via MathJax 3, with optional AMS auto-numbering (`Cmd+Opt+N`):",
        "",
        "$$",
        "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}",
        "$$",
        "",
        "```mermaid",
        "flowchart LR",
        "  A([Write Markdown]) --> B[Live Preview]",
        "  B --> C{Deliver}",
        "  C -->|PDFKit| D[PDF + Bookmarks]",
        "  C -->|Pandoc| E[DOCX / LaTeX / EPUB]",
        "```",
        "",
      ].join("\n");
      await setDoc(page, mathDiagDoc, mathDiagDoc.length);
      await page.waitForFunction(
        () => {
          const mathSvg = document.querySelector(
            '[data-testid="math-block"] svg',
          );
          const diagSvg = document.querySelector(
            '[data-testid="diagram"][data-state="rendered"] svg',
          );
          return Boolean(mathSvg && diagSvg);
        },
        { timeout: 15_000 },
      );
      await nextFrames(page, 6);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT_DIR, "math-diagrams.png") });
      console.log("Captured math-diagrams.png");

      // 4. Code Blocks with Syntax Highlighting & Line Numbers
      await resetApp(page, { theme: "papyros", sidebar: false });
      await page.evaluate(async () => {
        const main = await import("/src/main.ts");
        main.getActiveApp().editor.setCodeLineNumbers(true);
      });
      const codeDoc = [
        "## Code Blocks ／ 程式碼語法高亮",
        "",
        "Syntax highlighting for over 100 languages with a calm, low-saturation palette and toggleable line numbers (`Cmd+Opt+L`).",
        "",
        "```rust",
        "/// Atomic file save: write to a temp file, then rename into place.",
        "pub fn save_atomic(path: &std::path::Path, text: &str) -> std::io::Result<()> {",
        '    let temp = path.with_extension("md.tmp");',
        "    std::fs::write(&temp, text)?;",
        "    std::fs::rename(&temp, path)",
        "}",
        "```",
        "",
        "```typescript",
        "export function readingMinutes(cjk: number, latin: number): number {",
        "  const total = cjk / 400 + latin / 200;",
        "  return total > 0 ? Math.max(1, Math.ceil(total)) : 0;",
        "}",
        "```",
        "",
      ].join("\n");
      await setDoc(page, codeDoc, codeDoc.length);
      await nextFrames(page, 6);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT_DIR, "code-blocks.png") });
      console.log("Captured code-blocks.png");

      // 5. Dark Theme (Melan)
      await resetApp(page, { theme: "melan", sidebar: false });
      const darkDoc = [
        "# Melan — 墨色深色主題",
        "",
        "Crafted for late-night writing with warm ink tones (`#1C1A17`) and soft parchment text (`#E8E0D0`) tuned for WCAG AA readability.",
        "",
        "## Custom CSS Themes",
        "",
        "Drop any `.css` file into `themes/` to override `--k-*` tokens, font scale, justified paragraphs, or automatic heading numbers. Cycle themes anytime with `Cmd+Shift+T`.",
        "",
        "> Quiet tools stay out of the way. Standard GFM Markdown files live right on your Mac — offline, private, and free.",
        "",
        "```css",
        ":root[data-custom-theme] {",
        "  color-scheme: dark;",
        "  --k-accent: #93AE7C;",
        "  --k-max-width: 760px;",
        "}",
        "```",
        "",
      ].join("\n");
      await setDoc(page, darkDoc, darkDoc.length);
      await nextFrames(page, 6);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(OUT_DIR, "dark-theme-melan.png"),
      });
      console.log("Captured dark-theme-melan.png");

      // 6. Writing Modes: Ataraxia Focus Mode + Stichos Typewriter Mode
      await resetApp(page, { theme: "papyros", sidebar: false });
      const focusDoc = [
        "# Writing Without Distraction",
        "",
        "Long-form writing benefits from quiet momentum. When you are drafting a technical specification or an essay, the rest of the page does not need to compete for your attention.",
        "",
        "In **Ataraxia Focus Mode** (`F8`), every block outside the paragraph you are currently writing fades gently into the background, leaving only your active thought in crisp ink.",
        "",
        "Pair it with **Stichos Typewriter Mode** (`F9`) to keep your active line vertically centered on screen, just like paper advancing steadily through a carriage.",
        "",
        "Press `F8` or `F9` again at any moment to return to the full page view — your preferences persist automatically between sessions.",
      ].join("\n");
      const focusPos =
        focusDoc.indexOf("in crisp ink.") + "in crisp ink.".length;
      await setDoc(page, focusDoc, focusPos);
      await page.evaluate(async () => {
        const main = await import("/src/main.ts");
        const app = main.getActiveApp();
        app.editor.setFocusMode(true);
        app.editor.setTypewriterMode(true);
      });
      await nextFrames(page, 6);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(OUT_DIR, "writing-modes.png") });
      console.log("Captured writing-modes.png");
    }
  } finally {
    if (browser) await browser.close();
    vite.kill("SIGTERM");
  }
}

captureAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
