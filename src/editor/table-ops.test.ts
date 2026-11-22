import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { pickTableSize } from "./table-insert-dialog";
import {
  applyTableOp,
  columnAlign,
  convertPipeRowToTable,
  deleteColumn,
  deleteRow,
  deleteTable,
  getActiveTableCell,
  insertColumn,
  insertRow,
  insertTable,
  moveColumn,
  newTableMarkdown,
  pipeRowCells,
  runTableAction,
  setColumnAlign,
  tableActionResult,
} from "./table-ops";
import {
  shortcutActionForEvent,
  tableKeymap,
  tableToolbarSpaceField,
} from "./table-toolbar";
import {
  formatParsedTable,
  getDisplayWidth,
  type ParsedTable,
  parseTableFromLines,
} from "./tables";

/** #59 B: table structure operations, insertion and `|a|b|` + Enter. */

function parse(md: string, base = 0): ParsedTable {
  let offset = base;
  const lines = md.split("\n").map((text, i) => {
    const from = offset;
    offset += text.length + 1;
    return { text, from, to: from + text.length, lineNumber: i + 1 };
  });
  const t = parseTableFromLines(lines);
  if (!t) throw new Error(`not a table: ${md}`);
  return t;
}

/** Cell texts, header first. */
function cells(md: string): string[][] {
  const t = parse(md);
  return [t.headerRow, ...t.bodyRows].map((r) => r.cells.map((c) => c.text));
}

function stateOf(doc: string, cursor: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage, addKeymap: false })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

const T = [
  "| a | b | c |",
  "| :- | :-: | -: |",
  "| 1 | 2 | 3 |",
  "| 4 | 5 | 6 |",
].join("\n");

describe("#59 round-trip: parse → format → parse", () => {
  it("keeps escaped pipes, <br>, CJK, inner spaces and alignment", () => {
    const src = [
      "| 名稱 | a \\| b | 說明 |",
      "| :--- | :---: | ---: |",
      "| 中文字 | x<br>y | two  spaces |",
      "|  | **粗** | `c|d` |",
    ].join("\n");
    const formatted = formatParsedTable(parse(src));
    expect(cells(formatted)).toEqual(cells(src));
    expect(cells(formatted)[0][1]).toBe("a \\| b");
    expect(cells(formatted)[1][1]).toBe("x<br>y");
    const t = parse(formatted);
    expect(t.alignments).toEqual(["left", "center", "right"]);
    // Formatting again is stable.
    expect(formatParsedTable(t)).toBe(formatted);
    // Columns line up by display width (CJK = 2).
    const widths = formatted.split("\n").map((l) => getDisplayWidth(l));
    expect(new Set(widths).size).toBe(1);
  });
});

describe("#59 structure operations", () => {
  const t = parse(T);

  it("insert row above / below (header: above inserts the first body row)", () => {
    const below = insertRow(t, { row: 1, col: 2 }, "below");
    expect(cells(below.markdown!)).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["", "", ""],
      ["4", "5", "6"],
    ]);
    expect(below.cell).toEqual({ row: 2, col: 2 });
    const above = insertRow(t, { row: 1, col: 0 }, "above");
    expect(cells(above.markdown!)[1]).toEqual(["", "", ""]);
    expect(above.cell).toEqual({ row: 1, col: 0 });
    const onHeader = insertRow(t, { row: 0, col: 1 }, "above");
    expect(cells(onHeader.markdown!)[1]).toEqual(["", "", ""]);
    expect(onHeader.cell).toEqual({ row: 1, col: 1 });
    const headerBelow = insertRow(t, { row: 0, col: 0 }, "below");
    expect(cells(headerBelow.markdown!)[1]).toEqual(["", "", ""]);
  });

  it("delete row; the last body row leaves the header; the header can't be deleted", () => {
    const r = deleteRow(t, { row: 1, col: 1 })!;
    expect(cells(r.markdown!)).toEqual([
      ["a", "b", "c"],
      ["4", "5", "6"],
    ]);
    expect(r.cell).toEqual({ row: 1, col: 1 });
    const last = deleteRow(t, { row: 2, col: 0 })!;
    expect(last.cell).toEqual({ row: 1, col: 0 });
    const one = parse("| a |\n| - |\n| 1 |");
    const headerOnly = deleteRow(one, { row: 1, col: 0 })!;
    expect(cells(headerOnly.markdown!)).toEqual([["a"]]);
    expect(headerOnly.cell).toEqual({ row: 0, col: 0 });
    expect(deleteRow(t, { row: 0, col: 0 })).toBeNull();
  });

  it("insert column left / right keeps the other columns' alignment", () => {
    const right = insertColumn(t, { row: 2, col: 0 }, "right");
    expect(cells(right.markdown!)[0]).toEqual(["a", "", "b", "c"]);
    expect(parse(right.markdown!).alignments).toEqual([
      "left",
      "left",
      "center",
      "right",
    ]);
    expect(parse(right.markdown!).delimiterStyles[1]).toBe("default");
    expect(right.cell).toEqual({ row: 2, col: 1 });
    const left = insertColumn(t, { row: 0, col: 0 }, "left");
    expect(cells(left.markdown!)[1]).toEqual(["", "1", "2", "3"]);
    expect(left.cell).toEqual({ row: 0, col: 0 });
  });

  it("delete column; deleting the only column deletes the table", () => {
    const r = deleteColumn(t, { row: 1, col: 2 });
    expect(cells(r.markdown!)).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["4", "5"],
    ]);
    expect(parse(r.markdown!).alignments).toEqual(["left", "center"]);
    expect(r.cell).toEqual({ row: 1, col: 1 });
    expect(
      deleteColumn(parse("| a |\n| - |\n| 1 |"), { row: 0, col: 0 }).markdown,
    ).toBeNull();
  });

  it("set column alignment (null clears it); toggling via actions", () => {
    const center = setColumnAlign(t, { row: 0, col: 0 }, "center");
    expect(parse(center.markdown!).delimiterStyles[0]).toBe("center");
    const cleared = setColumnAlign(t, { row: 0, col: 2 }, null);
    expect(parse(cleared.markdown!).delimiterStyles[2]).toBe("default");
    expect(columnAlign(t, 1)).toBe("center");
    // Clicking the active alignment again clears it.
    const toggled = tableActionResult("alignCenter", {
      table: t,
      row: 1,
      col: 1,
    })!;
    expect(parse(toggled.markdown!).delimiterStyles[1]).toBe("default");
    const set = tableActionResult("alignRight", { table: t, row: 1, col: 1 })!;
    expect(parse(set.markdown!).delimiterStyles[1]).toBe("right");
  });

  it("move column left / right (null at the edges)", () => {
    const r = moveColumn(t, { row: 1, col: 0 }, 1)!;
    expect(cells(r.markdown!)).toEqual([
      ["b", "a", "c"],
      ["2", "1", "3"],
      ["5", "4", "6"],
    ]);
    expect(parse(r.markdown!).alignments).toEqual(["center", "left", "right"]);
    expect(r.cell).toEqual({ row: 1, col: 1 });
    expect(moveColumn(t, { row: 1, col: 0 }, -1)).toBeNull();
    expect(moveColumn(t, { row: 1, col: 2 }, 1)).toBeNull();
  });

  it("delete table", () => {
    expect(deleteTable(t).markdown).toBeNull();
  });

  it("operations keep CJK alignment and escaped pipes", () => {
    const src = "| 名稱 | 值 |\n| --- | --- |\n| 中文 | a \\| b |";
    const r = insertColumn(parse(src), { row: 1, col: 1 }, "right");
    expect(cells(r.markdown!)[1]).toEqual(["中文", "a \\| b", ""]);
    const widths = r.markdown!.split("\n").map((l) => getDisplayWidth(l));
    expect(new Set(widths).size).toBe(1);
  });

  it("new tables: rows include the header, sizes are clamped", () => {
    expect(cells(newTableMarkdown(3, 3))).toEqual([
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
    ]);
    expect(cells(newTableMarkdown(1, 2))).toEqual([["", ""]]);
    expect(cells(newTableMarkdown(0, 0))).toEqual([[""]]);
    expect(parse(newTableMarkdown(500, 500)).colCount).toBe(20);
    expect(parse(newTableMarkdown(2, 2)).delimiterStyles).toEqual([
      "left",
      "left",
    ]);
  });
});

describe("#59 locating the active cell", () => {
  it("getActiveTableCell: null outside tables", () => {
    const doc = `intro\n\n${T}\n\nafter`;
    expect(getActiveTableCell(stateOf(doc, 2))).toBeNull();
    expect(getActiveTableCell(stateOf(doc, doc.length))).toBeNull();
    const active = getActiveTableCell(stateOf(doc, doc.indexOf("5")));
    expect(active && { row: active.row, col: active.col }).toEqual({
      row: 2,
      col: 1,
    });
  });
});

describe("#59 commands on a view", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.replaceChildren();
  });

  function mount(doc: string, cursor: number): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({ parent, state: stateOf(doc, cursor) });
    return view;
  }
  const text = () => view!.state.doc.toString();
  const selected = () => {
    const s = view!.state.selection.main;
    return view!.state.sliceDoc(s.from, s.to);
  };

  it("an operation is one transaction that selects the target cell", () => {
    const doc = `x\n\n${T}\n\ny`;
    mount(doc, doc.indexOf("5"));
    expect(runTableAction(view!, "rowBelow")).toBe(true);
    expect(cells(text().split("\n\n")[1])[3]).toEqual(["", "", ""]);
    expect(getActiveTableCell(view!.state)).toMatchObject({ row: 3, col: 1 });
    expect(runTableAction(view!, "deleteCol")).toBe(true);
    expect(cells(text().split("\n\n")[1])[0]).toEqual(["a", "c"]);
    expect(runTableAction(view!, "colLeft")).toBe(true);
    expect(getActiveTableCell(view!.state)).toMatchObject({ col: 1 });
    // Paragraphs around the table are untouched.
    expect(text().startsWith("x\n\n|")).toBe(true);
    expect(text().endsWith("|\n\ny")).toBe(true);
    // Moving onto a filled cell selects its text.
    view!.dispatch({ selection: { anchor: text().indexOf("4") } });
    runTableAction(view!, "moveColRight");
    expect(getActiveTableCell(view!.state)).toMatchObject({ col: 1 });
    expect(selected()).toBe("4");
    expect(runTableAction(view!, "deleteRow")).toBe(true);
    expect(text()).not.toContain("4");
  });

  it("deleting the table removes its lines and keeps the surrounding text", () => {
    const doc = `x\n\n${T}\n\ny`;
    mount(doc, doc.indexOf("2"));
    expect(runTableAction(view!, "deleteTable")).toBe(true);
    expect(text()).toBe("x\n\n\ny");
    view!.destroy();
    mount(`x\n\n${T}`, 5);
    runTableAction(view!, "deleteTable");
    expect(text()).toBe("x\n");
  });

  it("no-ops return false (header row delete, outside tables)", () => {
    mount(T, 1);
    expect(runTableAction(view!, "deleteRow")).toBe(false);
    view!.destroy();
    mount("plain", 1);
    expect(runTableAction(view!, "rowBelow")).toBe(false);
  });

  it("applyTableOp with null does nothing", () => {
    mount(T, 1);
    expect(applyTableOp(view!, parse(T), null)).toBe(false);
    expect(text()).toBe(T);
  });

  it("insertTable: on a blank line, after text (blank line between), before text", () => {
    mount("", 0);
    insertTable(view!, 3, 2);
    expect(cells(text())).toEqual([
      ["", ""],
      ["", ""],
      ["", ""],
    ]);
    expect(view!.state.selection.main.head).toBe(2);
    view!.destroy();

    mount("段落", 1);
    insertTable(view!, 2, 2);
    expect(text().startsWith("段落\n\n| ")).toBe(true);
    expect(getActiveTableCell(view!.state)).toMatchObject({ row: 0, col: 0 });
    view!.destroy();

    mount("a\n\nb", 2);
    insertTable(view!, 2, 1);
    expect(text().startsWith("a\n\n| ")).toBe(true);
    expect(text().endsWith("|\n\nb")).toBe(true);
    // The table is parsed as one table (not merged with `a` or `b`).
    const tbl = getActiveTableCell(view!.state)!.table;
    expect(tbl.bodyRows).toHaveLength(1);
  });

  it("`|a|b|` + Enter becomes header + delimiter + one empty row, cursor in the body", () => {
    mount("|a|b|", 5);
    expect(convertPipeRowToTable(view!)).toBe(true);
    expect(cells(text())).toEqual([
      ["a", "b"],
      ["", ""],
    ]);
    expect(getActiveTableCell(view!.state)).toMatchObject({ row: 1, col: 0 });
    view!.destroy();

    // After a paragraph line: separated by a blank line.
    mount("text\n| x | 中文 |", 15);
    expect(convertPipeRowToTable(view!)).toBe(true);
    expect(text().startsWith("text\n\n| x")).toBe(true);
    expect(getActiveTableCell(view!.state)).toMatchObject({ row: 1, col: 0 });
  });

  it("`|a|b|` + Enter is left alone in code, mid-line, in existing tables or non-pipe lines", () => {
    expect(pipeRowCells(stateOf("|a|b|", 2))).toBeNull(); // cursor not at end
    expect(pipeRowCells(stateOf("a|b", 3))).toBeNull();
    expect(pipeRowCells(stateOf("```\n|a|b|\n```", 9))).toBeNull();
    expect(pipeRowCells(stateOf("    |a|b|", 9))).toBeNull(); // indented code
    expect(pipeRowCells(stateOf("> |a|b|", 7))).toBeNull();
    expect(pipeRowCells(stateOf("|a|b|\n|-|-|", 5))).toBeNull(); // header of a table
    expect(pipeRowCells(stateOf("|a|b|\n|-|-|\n|1|2|", 17))).toBeNull(); // body row
    expect(pipeRowCells(stateOf("|a|b|", 5))).toEqual(["a", "b"]);
    expect(pipeRowCells(stateOf("| a | b |  ", 11))).toEqual(["a", "b"]);
  });

  it("keyboard shortcuts act only inside tables", () => {
    const binding = (key: string) => tableKeymap.find((b) => b.key === key)!;
    mount(T, T.indexOf("5"));
    expect(binding("Mod-Alt-ArrowDown").run!(view!)).toBe(true);
    expect(cells(text())).toHaveLength(4);
    expect(binding("Mod-Shift-Backspace").run!(view!)).toBe(true);
    expect(cells(text())).toHaveLength(3);
    expect(binding("Mod-Alt-ArrowRight").run!(view!)).toBe(true);
    expect(cells(text())[0]).toHaveLength(4);
    expect(binding("Mod-Alt-Backspace").run!(view!)).toBe(true);
    expect(cells(text())[0]).toHaveLength(3);
    expect(binding("Mod-Alt-Shift-ArrowUp").run!(view!)).toBe(true);
    view!.destroy();
    mount("plain", 1);
    expect(binding("Mod-Alt-ArrowDown").run!(view!)).toBe(false);
  });

  it("shortcut matching for events from focused widget cells", () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(
      shortcutActionForEvent(
        ev({ code: "ArrowUp", metaKey: true, altKey: true }),
      ),
    ).toBe("rowAbove");
    expect(
      shortcutActionForEvent(
        ev({ code: "Backspace", metaKey: true, shiftKey: true }),
      ),
    ).toBe("deleteRow");
    expect(
      shortcutActionForEvent(
        ev({ code: "ArrowRight", metaKey: true, altKey: true, shiftKey: true }),
      ),
    ).toBe("alignRight");
    // Cmd+Opt+Shift+R stays the image-root shortcut.
    expect(
      shortcutActionForEvent(
        ev({ code: "KeyR", metaKey: true, altKey: true, shiftKey: true }),
      ),
    ).toBeNull();
    expect(
      shortcutActionForEvent(ev({ code: "ArrowUp", altKey: true })),
    ).toBeNull();
    expect(
      shortcutActionForEvent(ev({ code: "Enter", metaKey: true })),
    ).toBeNull(); // #59 A
  });
});

describe("#59 insert dialog", () => {
  afterEach(() => document.body.replaceChildren());

  it("defaults to 3 × 3; fields, picker, Escape", async () => {
    let p = pickTableSize(document);
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="table-insert-dialog"]',
    )!;
    const rows = dialog.querySelector<HTMLInputElement>(
      '[data-testid="table-dialog-rows"]',
    )!;
    const cols = dialog.querySelector<HTMLInputElement>(
      '[data-testid="table-dialog-cols"]',
    )!;
    expect([rows.value, cols.value]).toEqual(["3", "3"]);
    expect(document.activeElement).toBe(rows);
    rows.value = "5";
    cols.value = "99";
    dialog
      .querySelector<HTMLButtonElement>('[data-testid="table-dialog-ok"]')!
      .click();
    expect(await p).toEqual({ rows: 5, cols: 20 });

    p = pickTableSize(document);
    document
      .querySelector<HTMLElement>(
        '.k-table-picker-cell[data-rows="2"][data-cols="4"]',
      )!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await p).toEqual({ rows: 2, cols: 4 });

    p = pickTableSize(document);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(await p).toBeNull();
    expect(document.querySelector(".k-table-dialog-backdrop")).toBeNull();
  });
});

describe("#59 review: space reserved above the active table", () => {
  const doc = `intro\n\n${T}\n\nafter`;
  const withField = (cursor: number) => {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        markdown({ base: markdownLanguage, addKeymap: false }),
        tableToolbarSpaceField,
      ],
    });
    ensureSyntaxTree(state, state.doc.length, 5000);
    return state;
  };

  it("a block spacer sits right before the table only while it is active", () => {
    expect(withField(2).field(tableToolbarSpaceField)).toBeNull();
    const active = withField(doc.indexOf("5")).field(tableToolbarSpaceField)!;
    expect(active.from).toBe(doc.indexOf("| a"));
    const specs: Array<{ from: number; block: boolean }> = [];
    active.decorations.between(0, doc.length, (from, _to, deco) => {
      specs.push({ from, block: Boolean(deco.spec.block) });
    });
    // At the end of the line before the table (keeps the table widget's DOM).
    expect(specs).toEqual([{ from: doc.indexOf("| a") - 1, block: true }]);
  });

  it("moving inside the same table keeps the same value (no DOM churn); leaving clears it", () => {
    let state = withField(doc.indexOf("5"));
    const v = state.field(tableToolbarSpaceField);
    state = state.update({ selection: { anchor: doc.indexOf("2") } }).state;
    expect(state.field(tableToolbarSpaceField)).toBe(v);
    state = state.update({ selection: { anchor: doc.length } }).state;
    expect(state.field(tableToolbarSpaceField)).toBeNull();
  });
});
