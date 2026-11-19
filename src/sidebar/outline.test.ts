import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import { OUTLINE_DEBOUNCE_MS } from "./outline";

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

describe("Outline panel (NV-02) — ATX/Setext syntax tree parsing, code block exclusion, click jump & active highlight", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMockState();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    vi.useRealTimers();
  });

  it("extracts ATX (H1-H6) and Setext (H1/H2) headings from syntax tree while ignoring # in code blocks", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "# 第一章：ATX 一級標題",
      "",
      "前言段落內容。",
      "",
      "Setext 一級標題",
      "===============",
      "",
      "Setext 二級標題",
      "---------------",
      "",
      "```bash",
      "# 這是在 fenced code block 內的註解，絕對不能算進大綱",
      "## 另一個假標題",
      "```",
      "",
      "    # 這是在四格縮排程式碼區塊內的 #，也不能算進大綱",
      "",
      "### 1.1 三級子標題 ###",
      "",
      "###### 六級註記標題",
    ].join("\n");

    app.editor.setContent(doc);
    await vi.advanceTimersByTimeAsync(OUTLINE_DEBOUNCE_MS);

    // Switch sidebar tab to Outline
    const outlineTabBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-tab-outline"]',
    )!;
    expect(outlineTabBtn).not.toBeNull();
    outlineTabBtn.click();

    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="outline-item"]'),
    );
    expect(items.map((el) => `${el.dataset.level}:${el.textContent}`)).toEqual([
      "1:第一章：ATX 一級標題",
      "1:Setext 一級標題",
      "2:Setext 二級標題",
      "3:1.1 三級子標題",
      "6:六級註記標題",
    ]);

    // Verify indentation scales with heading level
    expect(items[0].style.paddingLeft).toBe("12px"); // level 1
    expect(items[2].style.paddingLeft).toBe("26px"); // level 2
    expect(items[3].style.paddingLeft).toBe("40px"); // level 3
    expect(items[4].style.paddingLeft).toBe("82px"); // level 6
  });

  it("highlights current section heading on cursor move without re-parsing and jumps cursor on item click", async () => {
    app = createKalamosApp(document);
    await app.init();

    const doc = [
      "# 導論 Introduction",
      "第一段內文",
      "",
      "## 架構設計 Architecture",
      "第二段內文在此",
      "",
      "### 效能細節 Performance",
      "第三段內文在此",
    ].join("\n");

    app.editor.setContent(doc);
    await vi.advanceTimersByTimeAsync(OUTLINE_DEBOUNCE_MS);
    await app.sidebar.setTab("outline");

    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="outline-item"]'),
    );
    expect(items).toHaveLength(3);

    // Move cursor into paragraph under "## 架構設計 Architecture"
    const archBodyPos = doc.indexOf("第二段內文在此");
    app.editor.setCursor(archBodyPos);

    // Active highlight updates immediately (0ms, no debounce wait needed for selectionSet)
    expect(items[0].dataset.active).toBe("false");
    expect(items[1].dataset.active).toBe("true");
    expect(items[2].dataset.active).toBe("false");

    // Click third outline item ("效能細節 Performance") -> cursor jumps to heading data-pos
    const perfHeadingPos = doc.indexOf("### 效能細節 Performance");
    expect(Number(items[2].dataset.pos)).toBe(perfHeadingPos);

    items[2].click();
    expect(app.editor.view.state.selection.main.head).toBe(perfHeadingPos);
    expect(items[1].dataset.active).toBe("false");
    expect(items[2].dataset.active).toBe("true");
  });

  it("debounces outline rebuild by 150ms when editing document text", async () => {
    app = createKalamosApp(document);
    await app.init();
    await app.sidebar.setTab("outline");

    app.editor.setContent("# 初始標題\n");
    await vi.advanceTimersByTimeAsync(OUTLINE_DEBOUNCE_MS);

    expect(
      document.querySelectorAll('[data-testid="outline-item"]'),
    ).toHaveLength(1);

    // User types a new heading
    const { view } = app.editor;
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\n## 新增二級標題\n" },
    });

    // At 100ms (< 150ms debounce), outline has not rebuilt yet
    await vi.advanceTimersByTimeAsync(100);
    expect(
      document.querySelectorAll('[data-testid="outline-item"]'),
    ).toHaveLength(1);

    // At 150ms, outline updates with the new heading
    await vi.advanceTimersByTimeAsync(OUTLINE_DEBOUNCE_MS);
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="outline-item"]'),
    );
    expect(items).toHaveLength(2);
    expect(items[1].textContent).toBe("新增二級標題");
  });
});
