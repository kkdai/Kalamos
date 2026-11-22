import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  clearTableColumnWidths,
  formatMarkdownTable,
  formatParsedTable,
  getDisplayWidth,
  handleTableEnter,
  handleTableShiftTab,
  handleTableTab,
  parseTableInRange,
  reorderTableBodyRow,
  splitTableCellsWithRanges,
  tableCellMatrix,
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

  it("renders GFM table as HTML <table data-testid='table-widget'> with alignments, nested Lezer inline styles, and code containing `*`, editing a cell in place on focus", async () => {
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

    // #59: focusing a cell edits it in place — the grid stays, the cell shows
    // its raw inline markdown (`\|` displayed as `|`) and CM's selection moves
    // into that cell's source.
    const content = tds[2].querySelector<HTMLElement>(".k-table-cell-content")!;
    expect(content.contentEditable).toBe("true");
    content.focus();
    expect(content.textContent).toBe("\\*跳脫\\* a | b");
    const sel = view.state.selection.main;
    const cellSrc = "\\*跳脫\\* a \\| b";
    const cellFrom = view.state.doc.toString().indexOf(cellSrc);
    expect(sel.head).toBeGreaterThanOrEqual(cellFrom);
    expect(sel.head).toBeLessThanOrEqual(cellFrom + cellSrc.length);
    expect(
      view.contentDOM.querySelector('table[data-testid="table-widget"]'),
    ).not.toBeNull();
    // Blur renders it again.
    content.blur();
    expect(content.textContent).toBe("*跳脫* a | b");
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
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe(
      "# 目標標題",
    );
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

    // Warm up (first dispatch pays for lazy parsing / JIT), then take the
    // median of several cursor moves outside tables. A single wall-clock
    // sample was flaky under load (#32).
    app.editor.setCursor(view.state.doc.line(100).from);
    const samples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const line = view.state.doc.line(200 + i * 20);
      const start = performance.now();
      app.editor.setCursor(line.from + 2);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)];

    const stateAfter = view.state.field(tablePreviewStateField);
    // When moving cursor outside tables, StateField returns the exact same cached state & DecorationSet
    expect(stateAfter).toBe(stateBefore);
    expect(medianMs).toBeLessThan(5);
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

    const rawTable = ["| 品項 | 數量 |", "| :--- | ---: |", "| 筆 | 1 |"].join(
      "\n",
    );
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
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(
      4,
    );

    // Fill row 4, then Enter -> inserts another row (line 5)
    view.dispatch(view.state.replaceSelection("鉛筆"));
    expect(handleTableEnter(view)).toBe(true);
    expect(view.state.doc.lines).toBe(5);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(
      5,
    );

    // Enter on the empty last row (5) -> leaves the table (#32): the empty row
    // is removed and the cursor sits in a new paragraph after a blank line.
    expect(handleTableEnter(view)).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[3]).toMatch(/^\| 鉛筆 +\| +\|$/);
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe("");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(
      6,
    );
  });

  it("Cmd+Opt+T opens the insert dialog (#59); 插入 inserts a 3x3 table with the cursor in the first header cell", async () => {
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

    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="table-insert-dialog"]',
    );
    expect(dialog).not.toBeNull();
    dialog!
      .querySelector<HTMLButtonElement>('[data-testid="table-dialog-ok"]')!
      .click();
    await Promise.resolve();
    await Promise.resolve();

    const doc = app.editor.getContent();
    const lines = doc.split("\n");
    expect(lines).toHaveLength(4); // 1 header + 1 delimiter + 2 body rows (3 columns x 3 navigable rows)
    expect(lines[0].split("|")).toHaveLength(5);
    const head = view.state.selection.main.head;
    expect(head).toBe(2);
    expect(
      document.querySelector('[data-testid="table-insert-dialog"]'),
    ).toBeNull();
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

describe("Tables — #32 extra cells, exit on empty row, re-align on leave", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    clearTableColumnWidths();
    setupDom();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  async function boot(content: string, cursor: number) {
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent(content);
    app.editor.setCursor(cursor);
    return app.editor.view;
  }

  const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));

  it("keeps extra non-empty cells by widening the header; trailing empty extras are dropped", async () => {
    const src = "| a | b |\n| :-- | --: |\n| 1 | 2 | 3 |  |\n| x | y |";
    const view = await boot(src, 0);
    const table = parseTableInRange(view.state, 0, src.length)!;
    expect(table.colCount).toBe(2);
    expect(table.bodyRows[0].overflowCellTexts).toEqual(["3", ""]);

    const m = tableCellMatrix(table);
    expect(m.colCount).toBe(3);
    expect(m.headerCells).toEqual(["a", "b", ""]);
    expect(m.delimiterStyles).toEqual(["left", "right", "default"]);
    expect(m.bodyRows).toEqual([
      ["1", "2", "3"],
      ["x", "y", ""],
    ]);
    expect(formatParsedTable(table)).toBe(
      [
        "| a    | b    |     |",
        "| :--- | ---: | --- |",
        "| 1    | 2    | 3   |",
        "| x    | y    |     |",
      ].join("\n"),
    );
  });

  it("Enter after typing a literal `| 1 | 2 |` row keeps both values (BUG-5)", async () => {
    const src = "| a | b |\n| --- | --- |\n|     |     |";
    const view = await boot(src, src.indexOf("|     |") + 2);
    view.dispatch(view.state.replaceSelection("| 1 | 2 |"));
    expect(handleTableEnter(view)).toBe(true);
    const doc = view.state.doc.toString();
    expect(doc).toMatch(/\| 1 +\| 2 +\|/);
    const rows = doc.split("\n");
    expect(new Set(rows.map((r) => r.split("|").length)).size).toBe(1);
  });

  it("Enter on an empty last row exits; a following paragraph stays separated", async () => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n|   |   |\n\nend";
    const view = await boot(src, src.indexOf("|   |") + 2);
    expect(handleTableEnter(view)).toBe(true);
    view.dispatch(view.state.replaceSelection("mid"));
    expect(view.state.doc.toString()).toBe(
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nmid\n\nend",
    );
  });

  it("Enter on a non-empty last row or on the delimiter row still inserts a row", async () => {
    const src = "| a | b |\n| --- | --- |";
    const view = await boot(src, src.length);
    expect(handleTableEnter(view)).toBe(true);
    expect(view.state.doc.lines).toBe(3);
    view.dispatch(view.state.replaceSelection("v"));
    expect(handleTableEnter(view)).toBe(true);
    expect(view.state.doc.lines).toBe(4);
  });

  it("re-aligns an edited table once when the cursor leaves it, as one undo step (BUG-6)", async () => {
    const aligned = "| name  | qty |\n| ----- | --- |\n| apple | 1   |";
    const src = `${aligned}\n\nend`;
    const view = await boot(src, aligned.indexOf("1   |") + 1);
    view.dispatch(view.state.replaceSelection("2345"));
    const edited = view.state.doc.toString();
    expect(edited).toContain("| apple | 12345   |");

    app!.editor.setCursor(view.state.doc.length);
    await flush();
    const formatted = view.state.doc.toString();
    expect(formatted).toBe(
      "| name  | qty   |\n| ----- | ----- |\n| apple | 12345 |\n\nend",
    );
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(edited);
  });

  it("does not touch a table that was only visited (no edits)", async () => {
    const src = "| a | bbbbbb |\n|---|---|\n| 1 | 2 |\n\nend";
    const view = await boot(src, src.length);
    app!.editor.setCursor(3);
    app!.editor.setCursor(src.length);
    await flush();
    expect(view.state.doc.toString()).toBe(src);
    expect(app!.editor.isDirty()).toBe(false);
  });

  it("postpones the re-align while an IME composition is active", async () => {
    const aligned = "| name  | qty |\n| ----- | --- |\n| apple | 1   |";
    const src = `${aligned}\n\nend`;
    const view = await boot(src, aligned.indexOf("1   |") + 1);
    view.dispatch(view.state.replaceSelection("2345"));
    const edited = view.state.doc.toString();

    let composing = true;
    Object.defineProperty(view, "composing", {
      configurable: true,
      get: () => composing,
    });
    app!.editor.setCursor(view.state.doc.length);
    await flush();
    expect(view.state.doc.toString()).toBe(edited);

    composing = false;
    view.dispatch({}); // the update CodeMirror issues when composition ends
    await flush();
    expect(view.state.doc.toString()).toContain("| apple | 12345 |");
    delete (view as unknown as Record<string, unknown>).composing;
  });

  it("source mode unloads the re-align plugin with the table preview", async () => {
    const aligned = "| name  | qty |\n| ----- | --- |\n| apple | 1   |";
    const src = `${aligned}\n\nend`;
    const view = await boot(src, aligned.indexOf("1   |") + 1);
    app!.editor.setSourceMode(true);
    view.dispatch(view.state.replaceSelection("2345"));
    const edited = view.state.doc.toString();
    app!.editor.setCursor(view.state.doc.length);
    await flush();
    expect(view.state.doc.toString()).toBe(edited);
  });
});
