import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSettings, resetMockState } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  ensureCodeBlockLanguagesLoaded,
  resolveCodeLanguage,
} from "./code-blocks";
import {
  ALLOWED_TEX_PACKAGES,
  clearMathRenderCache,
  collectMathFormulas,
  ensureMathJaxLoaded,
  getMathRenderCacheSize,
  hasMathRenderCacheKey,
  MAX_MATH_CACHE_ENTRIES,
  renderTeXSync,
} from "./math";

function setupDom(): HTMLElement {
  document.body.innerHTML = `
    <div id="app">
      <div id="recovery-banner" role="alert" data-visible="false">
        <span id="recovery-message">偵測到上次未儲存的內容，是否還原？</span>
        <div id="recovery-actions">
          <button type="button" id="recovery-restore-btn">還原</button>
          <button type="button" id="recovery-discard-btn">捨棄</button>
        </div>
      </div>
      <aside id="sidebar" data-testid="sidebar" data-visible="false"></aside>
      <main id="editor-container" aria-label="Markdown Editor"></main>
      <div id="status" data-testid="status" role="status" aria-live="polite"></div>
    </div>
  `;
  return document.getElementById("app")!;
}

describe("Fenced Code Blocks (BL-02) & Math Formulas (BL-03)", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    clearMathRenderCache();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  it("resolves code block info string to @codemirror/language-data and lazy-loads syntax highlighting", async () => {
    expect(resolveCodeLanguage("ts")?.name).toBe("TypeScript");
    expect(resolveCodeLanguage("python")?.name).toBe("Python");
    expect(resolveCodeLanguage("rust")?.name).toBe("Rust");

    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "# Code Test",
      "",
      "```javascript",
      "const answer = 42;",
      "// comment line",
      "```",
      "",
      "Trailing paragraph outside block.",
    ].join("\n");

    app.editor.setContent(doc);
    // Place cursor in trailing paragraph outside the fenced code block
    app.editor.setCursor(doc.length - 2);

    await ensureCodeBlockLanguagesLoaded(
      app.editor.view.state,
      app.editor.view,
    );

    // Language badge appears at top-right when cursor is outside the fenced block
    const badge = app.editor.view.contentDOM.querySelector<HTMLElement>(
      '[data-testid="code-lang-badge"]',
    );
    expect(badge).not.toBeNull();
    expect(badge!.dataset.lang).toBe("javascript");
    expect(badge!.textContent).toBe("javascript");

    // Syntax highlighting token classes are applied inside the code block
    const keywordEl =
      app.editor.view.contentDOM.querySelector(".k-tok-keyword");
    const numberEl = app.editor.view.contentDOM.querySelector(".k-tok-number");
    expect(keywordEl?.textContent).toBe("const");
    expect(numberEl?.textContent).toBe("42");
  });

  it("hides ``` fences when cursor is outside and reveals fences when cursor enters the block", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "Paragraph before",
      "",
      "```python",
      "def greet():",
      "    return 'hi'",
      "```",
      "",
      "Paragraph after",
    ].join("\n");

    app.editor.setContent(doc);
    // Cursor outside block
    app.editor.setCursor(0);

    const hiddenFences = app.editor.view.contentDOM.querySelectorAll(
      ".k-code-fence-hidden",
    );
    expect(hiddenFences.length).toBe(2);
    expect(
      app.editor.view.contentDOM.querySelector(
        '[data-testid="code-lang-badge"]',
      ),
    ).not.toBeNull();

    // Move cursor inside code block
    const insidePos = doc.indexOf("def greet");
    app.editor.setCursor(insidePos);

    expect(
      app.editor.view.contentDOM.querySelectorAll(".k-code-fence-hidden")
        .length,
    ).toBe(0);
    expect(
      app.editor.view.contentDOM.querySelectorAll(".k-code-fence-mark").length,
    ).toBe(2);
    expect(
      app.editor.view.contentDOM.querySelector(
        '[data-testid="code-lang-badge"]',
      ),
    ).toBeNull();
  });

  it("toggles code block line numbers via Cmd+Opt+L and persists settings.codeLineNumbers without altering doc", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "```",
    ].join("\n");

    app.editor.setContent(doc);
    expect(app.editor.isCodeLineNumbers()).toBe(false);
    expect(
      app.editor.view.contentDOM.querySelectorAll(".k-codeblock-line-numbered")
        .length,
    ).toBe(0);

    // Toggle line numbers ON via Cmd+Opt+L
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        code: "KeyL",
        metaKey: true,
        altKey: true,
        bubbles: true,
      }),
    );
    await Promise.resolve();

    expect(app.editor.isCodeLineNumbers()).toBe(true);
    expect((await getSettings()).codeLineNumbers).toBe(true);

    const numberedLines = Array.from(
      app.editor.view.contentDOM.querySelectorAll<HTMLElement>(
        ".k-codeblock-line-numbered",
      ),
    );
    expect(numberedLines).toHaveLength(3);
    expect(numberedLines.map((el) => el.dataset.lineNumber)).toEqual([
      "1",
      "2",
      "3",
    ]);
    // Document string is completely untouched
    expect(app.editor.getContent()).toBe(doc);

    // Toggle line numbers OFF via Cmd+Opt+L
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        code: "KeyL",
        metaKey: true,
        altKey: true,
        bubbles: true,
      }),
    );
    await Promise.resolve();

    expect(app.editor.isCodeLineNumbers()).toBe(false);
    expect((await getSettings()).codeLineNumbers).toBe(false);
    expect(
      app.editor.view.contentDOM.querySelectorAll(".k-codeblock-line-numbered")
        .length,
    ).toBe(0);
  });

  it("parses inline $...$ boundaries accurately: '價格 $5 與 $10' is NOT math, while '$a+b$' IS math", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "這是一段討論價格 $5 與 $10 的文字，不應該被當成數學公式。",
      "也沒有閉合的 $ 空白開頭或 $結尾空白 $ 不算。",
      "真正的行內公式 $a+b$ 以及化學式 $\\ce{H2O}$ 還有框線 $\\bbox[2px]{x^2}$ 才會渲染。",
      "同一行混寫價格 $5 與公式 $x+y=z$ 也能正確只解析後者。",
    ].join("\n");

    app.editor.setContent(doc);
    app.editor.setCursor(0);

    const formulas = collectMathFormulas(app.editor.view.state);
    expect(formulas.map((f) => `${f.kind}:${f.tex}`)).toEqual([
      "inline:a+b",
      "inline:\\ce{H2O}",
      "inline:\\bbox[2px]{x^2}",
      "inline:x+y=z",
    ]);

    await ensureMathJaxLoaded(app.editor.view);

    const inlineWidgets = Array.from(
      app.editor.view.contentDOM.querySelectorAll<HTMLElement>(
        '[data-testid="math-inline"]',
      ),
    );
    expect(inlineWidgets).toHaveLength(4);
    for (const w of inlineWidgets) {
      expect(w.querySelector("svg")).not.toBeNull();
    }
    expect(getMathRenderCacheSize()).toBeGreaterThanOrEqual(4);
  });

  it("renders block $$...$$ as SVG widget when cursor is outside, and shows source + live preview below when cursor enters", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "前言段落",
      "",
      "$$",
      "\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}",
      "$$",
      "",
      "結尾段落",
    ].join("\n");

    app.editor.setContent(doc);
    // Cursor at start of document (outside block math)
    app.editor.setCursor(0);
    await ensureMathJaxLoaded(app.editor.view);

    const blockWidget = app.editor.view.contentDOM.querySelector<HTMLElement>(
      '[data-testid="math-block"]',
    );
    expect(blockWidget).not.toBeNull();
    expect(blockWidget!.querySelector("svg")).not.toBeNull();
    expect(
      app.editor.view.contentDOM.querySelector(
        '[data-testid="math-block-preview"]',
      ),
    ).toBeNull();

    // Move cursor inside the block math formula
    const insideMathPos = doc.indexOf("\\int_0");
    app.editor.setCursor(insideMathPos);

    // Raw source is shown and a live preview widget appears below the block
    expect(
      app.editor.view.contentDOM.querySelector('[data-testid="math-block"]'),
    ).toBeNull();
    const previewWidget = app.editor.view.contentDOM.querySelector<HTMLElement>(
      '[data-testid="math-block-preview"]',
    );
    expect(previewWidget).not.toBeNull();
    expect(previewWidget!.querySelector("svg")).not.toBeNull();
    expect(app.editor.view.contentDOM.textContent).toContain("\\int_0^\\infty");
  });

  it("displays a red error message (.k-math-error) instead of blank output on invalid TeX syntax", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "Paragraph at top",
      "",
      "$$",
      "\\frac{1}{",
      "$$",
      "",
      "行內錯誤 $\\unknownmacroxyz$ 測試",
    ].join("\n");

    app.editor.setContent(doc);
    app.editor.setCursor(0);
    await ensureMathJaxLoaded(app.editor.view);

    const errorEls = Array.from(
      app.editor.view.contentDOM.querySelectorAll<HTMLElement>(
        '[data-testid="math-error"]',
      ),
    );
    expect(errorEls.length).toBeGreaterThanOrEqual(2);
    expect(errorEls[0].textContent?.length).toBeGreaterThan(0);
    expect(errorEls[1].textContent).toContain("unknownmacroxyz");
  });

  it("numbers block equations continuously across the document when mathAutoNumber is toggled on via Cmd+Opt+N", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "# 物理公式推導",
      "",
      "$$",
      "E = mc^2",
      "$$",
      "",
      "中間段落說明",
      "",
      "$$",
      "\\begin{align}",
      "F &= ma \\\\",
      "p &= mv",
      "\\end{align}",
      "$$",
      "",
      "$$",
      "a^2 + b^2 = c^2",
      "$$",
    ].join("\n");

    app.editor.setContent(doc);
    app.editor.setCursor(0);
    await ensureMathJaxLoaded(app.editor.view);

    // Initially mathAutoNumber is false -> no equation numbers
    expect(app.editor.isMathAutoNumber()).toBe(false);
    expect(
      app.editor.view.contentDOM.querySelectorAll(
        '[data-testid="math-eq-number"]',
      ).length,
    ).toBe(0);

    // Toggle mathAutoNumber ON via Cmd+Opt+N
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "n",
        code: "KeyN",
        metaKey: true,
        altKey: true,
        bubbles: true,
      }),
    );
    await Promise.resolve();

    expect(app.editor.isMathAutoNumber()).toBe(true);
    expect((await getSettings()).mathAutoNumber).toBe(true);

    const blocks = Array.from(
      app.editor.view.contentDOM.querySelectorAll<HTMLElement>(
        '[data-testid="math-block"]',
      ),
    );
    expect(blocks).toHaveLength(3);
    // Block 1: (1)
    // Block 2 (align with 2 lines): (2) and (3)
    // Block 3: (4)
    expect(blocks[0].dataset.equationNumber).toBe("1");
    expect(blocks[1].dataset.equationNumber).toBe("2,3");
    expect(blocks[2].dataset.equationNumber).toBe("4");

    const badges = Array.from(
      app.editor.view.contentDOM.querySelectorAll<HTMLElement>(
        '[data-testid="math-eq-number"]',
      ),
    );
    expect(badges.map((b) => b.textContent)).toEqual(["(1)", "(2) (3)", "(4)"]);
  });

  it("caps mathRenderCache at 500 entries using LRU eviction", async () => {
    await ensureMathJaxLoaded();
    clearMathRenderCache();

    // Insert 500 distinct inline formulas (x_0 .. x_499)
    for (let i = 0; i < MAX_MATH_CACHE_ENTRIES; i++) {
      renderTeXSync(`x_{${i}}`, false, false, 1);
    }
    expect(getMathRenderCacheSize()).toBe(MAX_MATH_CACHE_ENTRIES);
    expect(hasMathRenderCacheKey("inline:none:x_{0}")).toBe(true);
    expect(hasMathRenderCacheKey("inline:none:x_{1}")).toBe(true);

    // Touch x_{0} so it becomes the most recently used, making x_{1} the oldest
    renderTeXSync("x_{0}", false, false, 1);

    // Insert a 501st formula -> x_{1} is evicted while x_{0} remains cached
    renderTeXSync("x_{500}", false, false, 1);
    expect(getMathRenderCacheSize()).toBe(MAX_MATH_CACHE_ENTRIES);
    expect(hasMathRenderCacheKey("inline:none:x_{0}")).toBe(true);
    expect(hasMathRenderCacheKey("inline:none:x_{1}")).toBe(false);
    expect(hasMathRenderCacheKey("inline:none:x_{500}")).toBe(true);
  });

  it("locks TeX packages allowlist (excluding html) so \\href, \\class, and \\style cannot inject href/style attributes", async () => {
    expect(ALLOWED_TEX_PACKAGES).toEqual([
      "base",
      "ams",
      "mhchem",
      "bbox",
      "newcommand",
    ]);
    expect(ALLOWED_TEX_PACKAGES).not.toContain("html");

    await ensureMathJaxLoaded();

    const payloads = [
      "\\href{javascript:alert(1)}{x}",
      "\\class{injected-evil-class}{x}",
      "\\style{background:url(javascript:alert(1))}{x}",
    ];

    for (const payload of payloads) {
      const res = renderTeXSync(payload, false, false, 1);
      expect(res).not.toBeNull();
      expect(res!.error).toMatch(/Undefined control sequence/);
      expect(res!.svgHtml).toBe("");
    }
  });
});
