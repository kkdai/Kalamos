import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  clearTableColumnWidths,
  formatMarkdownTable,
  getDisplayWidth,
  handleTableEnter,
  handleTableShiftTab,
  handleTableTab,
  reorderTableBodyRow,
  splitTableCellsWithRanges,
  tableColumnWidthsMap,
  tablePreviewStateField,
} from "./tables";

function setupDom(): void {
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = `
    <div id="app">
      <div id="recovery-banner" role="alert" data-visible="false">
        <span id="recovery-message">偵測到上次未儲存的內容，是否還原？</span>
        <div id="recovery-actions">
          <button type="button" id="recovery-restore-btn">還原</button>
          <button type="button" id="recovery-discard-btn">捨棄</button>
        </div>
      </div>
      <main id="editor-container" aria-label="Markdown Editor"></main>
      <div id="status" data-testid="status" role="status" aria-live="polite"></div>
    </div>
  `;
}

describe("Tables (BL-01) — block widget, alignment, CJK width, Tab navigation, Cmd+Opt+T & row reorder", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    clearTableColumnWidths();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
    vi.restoreAllMocks();
  });

  it("renders GFM table as HTML <table data-testid='table-widget'> with alignments, nested Lezer inline styles, and code containing `*`, switching to source on cell click", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    const doc = [
      "段落文字",
      "",
      "| 左對齊 | 置中 | 右對齊 |",
      "| :--- | :---: | ---: |",
      "| **粗體 *巢狀斜體*** | `a * b * c` [連結](https://example.com) | \\*跳脫\\* a \\| b |",
    ].join("\n");

    app.editor.setContent(doc);
    // Cursor at pos 0 ("段落文字") -> outside the table
    app.editor.setCursor(0);

    const tableEl = view.contentDOM.querySelector<HTMLTableElement>(
      'table[data-testid="table-widget"]',
    );
    expect(tableEl).not.toBeNull();

    const ths = tableEl!.querySelectorAll<HTMLTableCellElement>("thead th");
    expect(ths).toHaveLength(3);
    expect(ths[0].style.textAlign).toBe("left");
    expect(ths[1].style.textAlign).toBe("center");
    expect(ths[2].style.textAlign).toBe("right");

    const tds = tableEl!.querySelectorAll<HTMLTableCellElement>("tbody td");
    expect(tds).toHaveLength(3);
    // Nested **粗體 *巢狀斜體*** parsed via @lezer/markdown
    const strongEl = tds[0].querySelector(".k-strong");
    expect(strongEl).not.toBeNull();
    expect(strongEl?.textContent).toBe("粗體 巢狀斜體");
    expect(strongEl?.querySelector(".k-em")?.textContent).toBe("巢狀斜體");

    // Inline code containing `*` is not broken into emphasis
    expect(tds[1].querySelector(".k-code")?.textContent).toBe("a * b * c");
    expect(tds[1].querySelector(".k-em")).toBeNull();
    expect(tds[1].querySelector(".k-link")?.textContent).toBe("連結");

    // Escaped `\*` and `\|`
    expect(tds[2].querySelector(".k-em")).toBeNull();
    expect(tds[2].textContent).toBe("*跳脫* a | b");

    // Click cell (row 1, col 2 -> "\*跳脫\* a \| b") -> moves cursor into that cell in source and hides widget
    tds[2].click();

    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("\\*跳脫\\* a \\| b");
    expect(
      view.contentDOM.querySelector('table[data-testid="table-widget"]'),
    ).toBeNull();
  });

  it("renders table links as <span class='k-link' data-href> without <a href>, blocks javascript: on Cmd+Click, and allows https: / #slug on Cmd+Click", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const doc = [
      "# 目標標題",
      "",
      "| 安全連結 | 危險連結 | 錨點連結 |",
      "| :--- | :--- | :--- |",
      "| [官網](https://example.com) | [惡意](javascript:alert(1)) | [跳轉](#目標標題) |",
    ].join("\n");

    app.editor.setContent(doc);
    app.editor.setCursor(0);

    const tableEl = view.contentDOM.querySelector<HTMLTableElement>(
      'table[data-testid="table-widget"]',
    )!;
    expect(tableEl).not.toBeNull();

    // Never renders <a href> inside table widget
    expect(tableEl.querySelectorAll("a")).toHaveLength(0);
    expect(tableEl.querySelectorAll("[href]")).toHaveLength(0);

    const linkSpans = tableEl.querySelectorAll<HTMLElement>(
      "span.k-link[data-href]",
    );
    expect(linkSpans).toHaveLength(3);
    expect(linkSpans[0].getAttribute("href")).toBeNull();
    expect(linkSpans[0].dataset.href).toBe("https://example.com");
    expect(linkSpans[1].getAttribute("href")).toBeNull();
    expect(linkSpans[1].dataset.href).toBe("javascript:alert(1)");
    expect(linkSpans[2].dataset.href).toBe("#目標標題");

    // Cmd+Click on javascript: link -> ignored, does not call window.open
    linkSpans[1].dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    expect(openSpy).not.toHaveBeenCalled();

    // Cmd+Click on https: link -> opens via window.open
    linkSpans[0].dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenLastCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );

    // Cmd+Click on #目標標題 link -> jumps cursor to `# 目標標題`
    linkSpans[2].dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    expect(
      view.state.doc.lineAt(view.state.selection.main.head).text,
    ).toBe("# 目標標題");
  });

  it("caches table ranges in StateField and updates cursor moves in < 5ms on a 10,000-line document with 20 tables", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      if (i > 0 && i % 500 === 0) {
        lines.push(`| T${i} A | T${i} B |`);
        lines.push("| :--- | ---: |");
        lines.push(`| val ${i} | ${i} |`);
      } else {
        lines.push(`Paragraph line ${i} with some text.`);
      }
    }
    app.editor.setContent(lines.join("\n"));
    app.editor.setCursor(0);

    const stateBefore = view.state.field(tablePreviewStateField);

    const midLine = view.state.doc.line(250);
    const start = performance.now();
    app.editor.setCursor(midLine.from + 2);
    const elapsedMs = performance.now() - start;

    const stateAfter = view.state.field(tablePreviewStateField);
    // When moving cursor outside tables, StateField returns the exact same cached state & DecorationSet
    expect(stateAfter).toBe(stateBefore);
    // Target < 5ms (< 25ms allowed in jsdom if GC/DOM layout intervenes)
    expect(elapsedMs).toBeLessThan(5);
  });

  it("calculates CJK East Asian Width = 2 and formats tables with aligned columns while preserving escaped pipes \\|", () => {
    expect(getDisplayWidth("ABC")).toBe(3);
    expect(getDisplayWidth("蘆葦筆")).toBe(6);
    expect(getDisplayWidth("中英Mixed")).toBe(9);

    const cells = splitTableCellsWithRanges("| normal | x \\| y | `p|q` |", 0);
    expect(cells.map((c) => c.text)).toEqual(["normal", "x \\| y", "`p|q`"]);

    const formatted = formatMarkdownTable(
      ["名稱", "語法", "數值"],
      ["left", "center", "right"],
      [
        ["蘆葦筆", "a \\| b", "42"],
        ["墨", "ok", "1000"],
      ],
    );

    const lines = formatted.split("\n");
    expect(lines).toEqual([
      "| 名稱   | 語法   | 數值 |",
      "| :----- | :----: | ---: |",
      "| 蘆葦筆 | a \\| b | 42   |",
      "| 墨     | ok     | 1000 |",
    ]);

    // Every line in the formatted table has the exact same display width!
    const displayWidths = lines.map((l) => getDisplayWidth(l));
    expect(new Set(displayWidths).size).toBe(1);
  });

  it("navigates cells with Tab / Shift+Tab, adds a new row on last-cell Tab or Enter, and formats the table", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    const rawTable = [
      "| 品項 | 數量 |",
      "| :--- | ---: |",
      "| 筆 | 1 |",
    ].join("\n");
    app.editor.setContent(rawTable);

    // Put cursor in first header cell ("品項")
    app.editor.setCursor(3);

    // Tab -> selects "數量" (header col 1) and formats table
    expect(handleTableTab(view)).toBe(true);
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe("數量");

    // Tab -> selects "筆" (body row 0, col 0)
    expect(handleTableTab(view)).toBe(true);
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe("筆");

    // Shift+Tab -> moves back to "數量" (header col 1)
    expect(handleTableShiftTab(view)).toBe(true);
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe("數量");

    // Tab twice to reach the last cell ("1" at body row 0, col 1)
    expect(handleTableTab(view)).toBe(true);
    expect(handleTableTab(view)).toBe(true);
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe("1");

    // Tab on the last cell -> appends a new row and places cursor in its first cell
    expect(handleTableTab(view)).toBe(true);
    expect(view.state.doc.lines).toBe(4);
    expect(
      view.state.doc.lineAt(view.state.selection.main.head).number,
    ).toBe(4);

    // Enter on row 4 -> inserts another row (line 5)
    expect(handleTableEnter(view)).toBe(true);
    expect(view.state.doc.lines).toBe(5);
    expect(
      view.state.doc.lineAt(view.state.selection.main.head).number,
    ).toBe(5);
  });

  it("inserts a 3x3 default table via Cmd+Opt+T with cursor in the first header cell", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "t",
        code: "KeyT",
        metaKey: true,
        altKey: true,
        bubbles: true,
      }),
    );

    const doc = app.editor.getContent();
    const lines = doc.split("\n");
    expect(lines).toHaveLength(4); // 1 header + 1 delimiter + 2 body rows (3 columns x 3 navigable rows)
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("Header 1");
  });

  it("reorders body rows via drag & drop in a single undoable transaction and stores column widths in memory only", async () => {
    app = createKalamosApp(document);
    await app.init();
    const { view } = app.editor;

    const initialDoc = [
      "Intro",
      "",
      "| ID   | Name  |",
      "| :--- | :---- |",
      "| 1    | Alpha |",
      "| 2    | Beta  |",
      "| 3    | Gamma |",
    ].join("\n");

    app.editor.setContent(initialDoc);
    app.editor.setCursor(0);

    const tableEl = view.contentDOM.querySelector<HTMLTableElement>(
      'table[data-testid="table-widget"]',
    )!;
    expect(tableEl).not.toBeNull();

    // Drag column resizer on col 0 -> updates memory Map without altering document source
    const resizer0 = tableEl.querySelector<HTMLElement>(
      '.k-table-col-resizer[data-resize-col="0"]',
    )!;
    resizer0.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 100, bubbles: true }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 180, bubbles: true }),
    );
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(tableColumnWidthsMap.get("| ID   | Name  |")?.[0]).toBe(200);
    expect(app.editor.getContent()).toBe(initialDoc);

    // Drag row 0 ("Alpha") and drop onto row 2 ("Gamma")
    const handle0 = tableEl.querySelector<HTMLElement>(
      '.k-table-row-handle[data-drag-row="0"]',
    )!;
    const targetTr2 = tableEl.querySelector<HTMLElement>(
      'tr.k-table-body-row[data-body-row="2"]',
    )!;

    handle0.dispatchEvent(new Event("dragstart", { bubbles: true }));
    targetTr2.dispatchEvent(new Event("dragover", { bubbles: true }));
    targetTr2.dispatchEvent(new Event("drop", { bubbles: true }));

    const expectedAfterReorder = [
      "Intro",
      "",
      "| ID   | Name  |",
      "| :--- | :---- |",
      "| 2    | Beta  |",
      "| 3    | Gamma |",
      "| 1    | Alpha |",
    ].join("\n");
    expect(app.editor.getContent()).toBe(expectedAfterReorder);

    // Single undo restores the original row order
    expect(undo(view)).toBe(true);
    expect(app.editor.getContent()).toBe(initialDoc);

    // Also verify direct reorderTableBodyRow helper
    const tableFrom = initialDoc.indexOf("| ID");
    expect(reorderTableBodyRow(view, tableFrom, 2, 0)).toBe(true);
    expect(app.editor.getContent()).toContain(
      "| 3    | Gamma |\n| 1    | Alpha |\n| 2    | Beta  |",
    );
    expect(undo(view)).toBe(true);
    expect(app.editor.getContent()).toBe(initialDoc);
  });
});
