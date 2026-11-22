import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMockState } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  cellDisplayToRaw,
  cellRawToDisplay,
  focusTableCell,
  getActiveTableCell,
} from "./tables";

/** #59 A: WYSIWYG table cell editing. */

describe("#59 cell text ⇄ source round trip", () => {
  const cases: Array<[string, string]> = [
    ["plain", "plain"],
    ["a \\| b", "a | b"],
    ["line 1<br>line 2", "line 1\nline 2"],
    ["中文 **粗體**", "中文 **粗體**"],
    ["a  b", "a  b"],
    ["\\\\\\|", "\\|"],
  ];
  it.each(cases)(
    "source %j shows as %j and writes back unchanged",
    (raw, display) => {
      expect(cellRawToDisplay(raw)).toBe(display);
      expect(cellDisplayToRaw(display)).toBe(raw);
    },
  );

  it("reads <br/> and <br /> as line breaks; writes them back as <br>", () => {
    expect(cellRawToDisplay("a<br/>b<br />c<BR>d")).toBe("a\nb\nc\nd");
    expect(cellDisplayToRaw("a\nb")).toBe("a<br>b");
  });

  it.each([
    "a|b",
    "a\\|b",
    "x\\",
    "<br>",
    "a\nb",
    "c:\\path|",
    "<br/> and <BR />",
    "&lt;br> typed literally",
    "&amp;lt;br",
    "a & b &lt; c",
    "**粗** `code|x`",
  ])("typed text %j round-trips through the cell source", (typed) => {
    const raw = cellDisplayToRaw(typed);
    expect(cellRawToDisplay(raw)).toBe(typed);
    // The source never holds an unescaped pipe or a literal-<br> line break.
    expect(raw).not.toMatch(/(^|[^\\])\|/);
  });

  it("a literal <br> is stored as &lt;br> and is not read back as a line break", () => {
    expect(cellDisplayToRaw("<br>")).toBe("&lt;br>");
    expect(cellDisplayToRaw("a\nb")).toBe("a<br>b");
    expect(cellRawToDisplay("&lt;br>")).toBe("<br>");
    // Other entities are left alone.
    expect(cellDisplayToRaw("a &lt; b")).toBe("a &lt; b");
    expect(cellRawToDisplay("a &lt; b")).toBe("a &lt; b");
  });

  it("escapes every typed pipe", () => {
    expect(cellDisplayToRaw("| 1 | 2 |")).toBe("\\| 1 \\| 2 \\|");
  });
});

const TABLE = [
  "intro",
  "",
  "| 名稱 | 數量 |",
  "| --- | --- |",
  "| 蘋果 | 1 |",
  "| 香蕉 | 2 |",
  "",
  "end",
].join("\n");

describe("#59 in-cell editing in the real editor", () => {
  let app: KalamosApp | null = null;

  beforeEach(async () => {
    resetMockState();
    document.body.innerHTML = `<main id="editor-container"></main><div id="status"></div>`;
    app = createKalamosApp(document);
    await app.init();
    app.editor.setContent(TABLE);
    app.editor.setCursor(0);
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  const view = () => app!.editor.view;
  const tableFrom = () => TABLE.indexOf("| 名稱");
  const widget = () =>
    view().contentDOM.querySelector<HTMLElement>(
      '[data-testid="table-widget"]',
    );
  const cellEl = (row: number, col: number) =>
    widget()!.querySelector<HTMLElement>(
      `[data-row="${row}"][data-col="${col}"] .k-table-cell-content`,
    )!;
  const doc = () => view().state.doc.toString();
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  /** Simulate typing: replace the cell text and fire `input`. */
  function typeInto(
    el: HTMLElement,
    text: string,
    opts: { composing?: boolean } = {},
  ) {
    el.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: Boolean(opts.composing),
      }),
    );
  }

  function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}) {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  }

  it("the table stays a grid while the cursor is inside it; the delimiter row shows source", () => {
    const pos = TABLE.indexOf("蘋果");
    app!.editor.setCursor(pos);
    expect(widget()).not.toBeNull();
    app!.editor.setCursor(TABLE.indexOf("| --- |") + 2);
    expect(widget()).toBeNull();
  });

  it("getActiveTableCell: row 0 is the header, null outside a table", () => {
    app!.editor.setCursor(TABLE.indexOf("數量"));
    expect(getActiveTableCell(view().state)).toMatchObject({ row: 0, col: 1 });
    app!.editor.setCursor(TABLE.indexOf("香蕉") + 1);
    const active = getActiveTableCell(view().state)!;
    expect(active).toMatchObject({ row: 2, col: 0 });
    expect(active.table.from).toBe(tableFrom());
    app!.editor.setCursor(0);
    expect(getActiveTableCell(view().state)).toBeNull();
  });

  it("focusTableCell selects the cell's text and focuses its contenteditable", () => {
    expect(focusTableCell(view(), tableFrom(), 1, 1)).toBe(true);
    const sel = view().state.selection.main;
    expect(view().state.sliceDoc(sel.from, sel.to)).toBe("1");
    expect(document.activeElement).toBe(cellEl(1, 1));
    expect(document.getSelection()!.toString()).toBe("1");
    expect(focusTableCell(view(), 0, 0, 0)).toBe(false);
  });

  it("typing writes only that cell, keeps the same DOM and focus, and maps the selection", () => {
    focusTableCell(view(), tableFrom(), 1, 0);
    const el = cellEl(1, 0);
    const before = doc();
    typeInto(el, "青蘋果");
    expect(doc()).toBe(before.replace("| 蘋果 |", "| 青蘋果 |"));
    // Not rebuilt: same element, still focused, still editing.
    expect(cellEl(1, 0)).toBe(el);
    expect(document.activeElement).toBe(el);
    expect(getActiveTableCell(view().state)).toMatchObject({ row: 1, col: 0 });
    typeInto(el, "a|b");
    expect(doc()).toContain("| a\\|b |");
    expect(el.textContent).toBe("a|b");
  });

  it("does not write while composing; writes once on compositionend", () => {
    focusTableCell(view(), tableFrom(), 2, 1);
    const el = cellEl(2, 1);
    const before = doc();
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    typeInto(el, "ㄧ", { composing: true });
    typeInto(el, "一百", { composing: true });
    expect(doc()).toBe(before);
    el.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "一百" }),
    );
    expect(doc()).toBe(before.replace("| 2 |", "| 一百 |"));
  });

  it("Cmd+Z / Cmd+Shift+Z in a cell undo and redo through CM history and resync the cell", () => {
    focusTableCell(view(), tableFrom(), 1, 1);
    const el = cellEl(1, 1);
    const before = doc();
    typeInto(el, "12");
    typeInto(el, "123");
    key(el, "z", { metaKey: true });
    expect(doc()).toBe(before);
    expect(el.textContent).toBe("1");
    expect(document.activeElement).toBe(el);
    key(el, "z", { metaKey: true, shiftKey: true });
    expect(doc()).toContain("| 123 |");
    expect(el.textContent).toBe("123");
  });

  it("paste inserts plain text: | becomes \\| and newlines become <br>", () => {
    focusTableCell(view(), tableFrom(), 1, 1); // "1" selected
    const el = cellEl(1, 1);
    // jsdom has no DataTransfer: a minimal stand-in.
    const data: Record<string, string> = {
      "text/plain": "a|b\r\nc",
      "text/html": "<b>ignored</b>",
    };
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (t: string) => data[t] ?? "" },
    });
    el.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(doc()).toContain("| a\\|b<br>c |");
    expect(doc()).not.toContain("ignored");
  });

  it("Cmd+B / Cmd+I wrap the selected text in ** / *", () => {
    focusTableCell(view(), tableFrom(), 1, 0); // "蘋果" selected
    const el = cellEl(1, 0);
    key(el, "b", { metaKey: true });
    expect(doc()).toContain("| **蘋果** |");
    focusTableCell(view(), tableFrom(), 2, 0);
    key(cellEl(2, 0), "i", { metaKey: true });
    expect(doc()).toContain("| *香蕉* |");
  });

  it("the focused cell shows raw markdown; blurring renders it", () => {
    focusTableCell(view(), tableFrom(), 1, 0);
    const el = cellEl(1, 0);
    typeInto(el, "**粗**");
    expect(el.textContent).toBe("**粗**");
    el.blur();
    expect(el.querySelector(".k-strong")?.textContent).toBe("粗");
  });

  it("Tab / Shift+Tab move between cells; Tab in the last cell adds a row", async () => {
    focusTableCell(view(), tableFrom(), 1, 0);
    key(cellEl(1, 0), "Tab");
    await flush();
    expect(getActiveTableCell(view().state)).toMatchObject({ row: 1, col: 1 });
    expect(document.activeElement).toBe(cellEl(1, 1));
    key(cellEl(1, 1), "Tab", { shiftKey: true });
    await flush();
    expect(document.activeElement).toBe(cellEl(1, 0));

    focusTableCell(view(), tableFrom(), 2, 1);
    key(cellEl(2, 1), "Tab");
    await flush();
    expect(widget()!.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(document.activeElement).toBe(cellEl(3, 0));
  });

  it("Enter moves down the column; on the last row it adds a row; on an empty last row it leaves", async () => {
    focusTableCell(view(), tableFrom(), 1, 1);
    key(cellEl(1, 1), "Enter");
    expect(document.activeElement).toBe(cellEl(2, 1));
    key(cellEl(2, 1), "Enter");
    await flush();
    expect(widget()!.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(document.activeElement).toBe(cellEl(3, 1));
    key(cellEl(3, 1), "Enter");
    await flush();
    expect(widget()!.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(
      view().hasFocus || document.activeElement === view().contentDOM,
    ).toBe(true);
    expect(getActiveTableCell(view().state)).toBeNull();
  });

  it("Shift+Enter writes <br>; Cmd+Enter leaves the table into a new paragraph", () => {
    focusTableCell(view(), tableFrom(), 1, 0);
    const el = cellEl(1, 0);
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    key(el, "Enter", { shiftKey: true });
    typeInto(el, `${el.textContent}x`);
    expect(doc()).toContain("| 蘋果<br>x |");
    key(el, "Enter", { metaKey: true });
    expect(getActiveTableCell(view().state)).toBeNull();
    const head = view().state.selection.main.head;
    expect(view().state.doc.lineAt(head).text).toBe("");
    expect(view().state.doc.lineAt(head - 1).text).toBe("");
  });

  it("ArrowUp in the header leaves above; ArrowDown in the last row leaves below", () => {
    focusTableCell(view(), tableFrom(), 0, 0);
    key(cellEl(0, 0), "ArrowUp");
    expect(
      view().state.doc.lineAt(view().state.selection.main.head).number,
    ).toBe(2);
    focusTableCell(view(), tableFrom(), 2, 1);
    key(cellEl(2, 1), "ArrowDown");
    expect(
      view().state.doc.lineAt(view().state.selection.main.head).number,
    ).toBe(7);
  });

  it("a literal <br>, a trailing backslash and pipes typed into cells keep the table intact", () => {
    app!.editor.setContent("|a|b|\n|---|---|\n|1|2|\n\nend");
    focusTableCell(view(), 0, 1, 0);
    typeInto(cellEl(1, 0), "<br>");
    focusTableCell(view(), 0, 1, 1);
    typeInto(cellEl(1, 1), "c:\\path\\");
    expect(doc().split("\n")[2]).toBe("|&lt;br>|c:\\path\\ |");
    const active = getActiveTableCell(view().state)!;
    expect(active.table.colCount).toBe(2);
    expect(
      active.table.bodyRows[0].cells.map((c) => cellRawToDisplay(c.text)),
    ).toEqual(["<br>", "c:\\path\\"]);
    cellEl(1, 1).blur();
    cellEl(1, 0).blur();
    // Rendered as literal text, not a line break.
    expect(cellEl(1, 0).textContent).toBe("<br>");
    expect(cellEl(1, 0).querySelector("br")).toBeNull();
  });

  it("a cell in a short row is appended when typed into", () => {
    app!.editor.setContent("| a | b |\n| --- | --- |\n| 1 |\n\nend");
    const from = 0;
    focusTableCell(view(), from, 1, 1);
    typeInto(cellEl(1, 1), "2");
    expect(doc().split("\n")[2]).toBe("| 1 | 2 |");
  });

  it("replacing the document while a cell is focused is safe", async () => {
    focusTableCell(view(), tableFrom(), 1, 0);
    expect(() => {
      app!.editor.setContent("| x | y |\n| --- | --- |\n| 1 | 2 | 3 |\n\nnew");
      app!.editor.setCursor(0);
      view().focus();
    }).not.toThrow();
    await flush();
    expect(doc()).toContain("new");
  });

  it("marks the cell holding the selection (e.g. a search hit) without stealing focus", async () => {
    app!.editor.setCursor(TABLE.indexOf("香蕉") + 1);
    await flush();
    const td = cellEl(2, 0).closest("td")!;
    expect(td.classList.contains("k-table-cell-active")).toBe(true);
  });
});
