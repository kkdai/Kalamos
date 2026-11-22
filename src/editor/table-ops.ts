/**
 * #59 B: table structure operations.
 *
 * Every operation is a pure function from a `ParsedTable` (plus the cell it
 * acts on) to a `TableOpResult`: the new Markdown for the whole table (column
 * widths re-aligned by `formatMarkdownTable`, CJK-aware) and the cell to
 * select afterwards, or `markdown: null` when the table should be removed.
 * `applyTableOp` turns a result into one transaction (one undo step).
 *
 * Cell coordinates: `row` 0 is the header, 1..n the body rows; `col` from 0.
 */

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  type ActiveTableCell,
  type DelimiterStyle,
  focusTableCell,
  formatMarkdownTable,
  getActiveTableCell,
  type ParsedTable,
  parseTableFromLines,
  splitTableCellsWithRanges,
  tableCellMatrix,
} from "./tables";

export interface TableCellRef {
  row: number;
  col: number;
}

export type { ActiveTableCell };
export { getActiveTableCell };

export interface TableOpResult {
  /** New Markdown for the table (from..to), or null to delete the table. */
  markdown: string | null;
  /** Cell to select afterwards (ignored when the table is deleted). */
  cell: TableCellRef;
}

export type ColumnAlign = "left" | "center" | "right";

interface TableModel {
  header: string[];
  styles: DelimiterStyle[];
  body: string[][];
}

function modelOf(table: ParsedTable): TableModel {
  const m = tableCellMatrix(table);
  return { header: m.headerCells, styles: m.delimiterStyles, body: m.bodyRows };
}

function result(model: TableModel, cell: TableCellRef): TableOpResult {
  const colCount = model.header.length;
  const rowCount = model.body.length + 1;
  return {
    markdown: formatMarkdownTable(model.header, model.styles, model.body),
    cell: {
      row: Math.max(0, Math.min(cell.row, rowCount - 1)),
      col: Math.max(0, Math.min(cell.col, colCount - 1)),
    },
  };
}

const emptyRow = (n: number): string[] => Array.from({ length: n }, () => "");

/**
 * Insert an empty body row above / below `cell.row`. The header cannot have a
 * row above it, so "above" on the header inserts the first body row.
 */
export function insertRow(
  table: ParsedTable,
  cell: TableCellRef,
  where: "above" | "below",
): TableOpResult {
  const m = modelOf(table);
  const bodyIdx = where === "below" || cell.row === 0 ? cell.row : cell.row - 1;
  m.body.splice(bodyIdx, 0, emptyRow(m.header.length));
  return result(m, { row: bodyIdx + 1, col: cell.col });
}

/**
 * Delete the body row at `cell.row`. Deleting the last body row keeps the
 * header (a header-only table is valid). The header row itself cannot be
 * deleted: returns null.
 */
export function deleteRow(
  table: ParsedTable,
  cell: TableCellRef,
): TableOpResult | null {
  if (cell.row < 1 || cell.row > table.bodyRows.length) return null;
  const m = modelOf(table);
  m.body.splice(cell.row - 1, 1);
  return result(m, { row: Math.min(cell.row, m.body.length), col: cell.col });
}

/** Insert an empty column left / right of `cell.col` (default alignment). */
export function insertColumn(
  table: ParsedTable,
  cell: TableCellRef,
  where: "left" | "right",
): TableOpResult {
  const m = modelOf(table);
  const at = where === "left" ? cell.col : cell.col + 1;
  m.header.splice(at, 0, "");
  m.styles.splice(at, 0, "default");
  for (const row of m.body) row.splice(at, 0, "");
  return result(m, { row: cell.row, col: at });
}

/** Delete the column at `cell.col`; deleting the only column deletes the table. */
export function deleteColumn(
  table: ParsedTable,
  cell: TableCellRef,
): TableOpResult {
  const m = modelOf(table);
  if (m.header.length <= 1) return deleteTable(table);
  m.header.splice(cell.col, 1);
  m.styles.splice(cell.col, 1);
  for (const row of m.body) row.splice(cell.col, 1);
  return result(m, {
    row: cell.row,
    col: Math.min(cell.col, m.header.length - 1),
  });
}

/**
 * Set the alignment of `cell.col`. `null` clears it (`---`). Callers that
 * want a toggle pass null when the column already has that alignment.
 */
export function setColumnAlign(
  table: ParsedTable,
  cell: TableCellRef,
  align: ColumnAlign | null,
): TableOpResult {
  const m = modelOf(table);
  m.styles[cell.col] = align ?? "default";
  return result(m, cell);
}

/** Alignment written in the delimiter row of `col`, or null for `---`. */
export function columnAlign(
  table: ParsedTable,
  col: number,
): ColumnAlign | null {
  const style = table.delimiterStyles[col] ?? "default";
  return style === "default" ? null : style;
}

/** Swap column `cell.col` with its left / right neighbour (null at the edge). */
export function moveColumn(
  table: ParsedTable,
  cell: TableCellRef,
  direction: -1 | 1,
): TableOpResult | null {
  const m = modelOf(table);
  const to = cell.col + direction;
  if (to < 0 || to >= m.header.length) return null;
  const swap = <T>(arr: T[]) => {
    [arr[cell.col], arr[to]] = [arr[to], arr[cell.col]];
  };
  swap(m.header);
  swap(m.styles);
  m.body.forEach(swap);
  return result(m, { row: cell.row, col: to });
}

/** Remove the whole table. */
export function deleteTable(_table: ParsedTable): TableOpResult {
  return { markdown: null, cell: { row: 0, col: 0 } };
}

/**
 * Markdown for a new rows × cols table (rows includes the header row).
 * Columns are left-aligned (`:---`), like the #7 default table.
 */
export function newTableMarkdown(rows: number, cols: number): string {
  const c = clampInt(cols, 1, MAX_TABLE_COLS);
  const r = clampInt(rows, 1, MAX_TABLE_ROWS);
  return formatMarkdownTable(
    emptyRow(c),
    Array.from({ length: c }, (): DelimiterStyle => "left"),
    Array.from({ length: r - 1 }, () => emptyRow(c)),
  );
}

export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 20;

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Locating cells
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Applying results
// ---------------------------------------------------------------------------

/** Content range of `cell` in `markdown` placed at document offset `base`. */
export function cellRangeInMarkdown(
  markdown: string,
  base: number,
  cell: TableCellRef,
): { from: number; to: number } | null {
  let offset = base;
  const lines = markdown.split("\n").map((text, idx) => {
    const from = offset;
    offset += text.length + 1;
    return { text, from, to: from + text.length, lineNumber: idx + 1 };
  });
  const parsed = parseTableFromLines(lines);
  if (!parsed) return null;
  const row = [parsed.headerRow, ...parsed.bodyRows][cell.row];
  const c = row?.cells[cell.col];
  return c ? { from: c.contentFrom, to: c.contentTo } : null;
}

/** Dispatch a structure operation as one transaction (one undo step). */
export function applyTableOp(
  view: EditorView,
  table: ParsedTable,
  op: TableOpResult | null,
  userEvent = "input.table.structure",
): boolean {
  if (!op) return false;
  const { state } = view;
  if (op.markdown === null) {
    // Drop the table and the line break after it (or before it at the end).
    let from = table.from;
    let to = table.to;
    if (to < state.doc.length) to += 1;
    else if (from > 0) from -= 1;
    view.dispatch({
      changes: { from, to },
      selection: EditorSelection.cursor(from),
      scrollIntoView: true,
      userEvent: "delete.table",
    });
    return true;
  }
  const range = cellRangeInMarkdown(op.markdown, table.from, op.cell);
  view.dispatch({
    changes: { from: table.from, to: table.to, insert: op.markdown },
    selection: range
      ? EditorSelection.range(range.from, range.to)
      : EditorSelection.cursor(table.from),
    scrollIntoView: true,
    userEvent,
  });
  // Keyboard focus into the target cell (contenteditable in live preview).
  focusTableCell(view, table.from, op.cell.row, op.cell.col);
  return true;
}

/**
 * Insert a rows × cols empty table at the cursor (rows includes the header)
 * and select its first header cell. A non-empty line gets the table on the
 * next lines, separated by a blank line so it doesn't join the paragraph.
 */
export function insertTable(
  view: EditorView,
  rows: number,
  cols: number,
): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const markdown = newTableMarkdown(rows, cols);
  const isBlank = (n: number) =>
    n < 1 || n > state.doc.lines || state.doc.line(n).text.trim() === "";
  const blank = isBlank(line.number);
  // On a blank line the table replaces it; otherwise it goes after the line.
  // A blank line separates it from text before and after.
  const from = blank ? line.from : line.to;
  const to = line.to;
  const prefix = blank ? (isBlank(line.number - 1) ? "" : "\n") : "\n\n";
  const suffix = isBlank(line.number + 1) ? "" : "\n";
  const tableFrom = from + prefix.length;
  const range = cellRangeInMarkdown(markdown, tableFrom, { row: 0, col: 0 });
  view.dispatch({
    changes: { from, to, insert: prefix + markdown + suffix },
    selection: EditorSelection.cursor(range?.from ?? tableFrom),
    scrollIntoView: true,
    userEvent: "input.table",
  });
  focusTableCell(view, tableFrom, 0, 0);
  return true;
}

// ---------------------------------------------------------------------------
// `|a|b|` + Enter → table
// ---------------------------------------------------------------------------

const NO_AUTO_TABLE_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "Table",
  "HTMLBlock",
  "BlockMath",
  "FrontMatter",
  "Blockquote",
  "ListItem",
]);

/**
 * The cells of a `|a|b|` line the cursor is at the end of, when Enter should
 * turn it into a table; null otherwise. Exported for tests.
 */
export function pipeRowCells(state: EditorState): string[] | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const line = state.doc.lineAt(sel.main.head);
  const text = line.text;
  if (sel.main.head < line.from + text.trimEnd().length) return null;
  if (!/^\s{0,3}\|.*\|\s*$/.test(text)) return null;
  // Already a table (header of an existing one, or a row of one above).
  if (
    line.number < state.doc.lines &&
    state.doc.line(line.number + 1).text.includes("|")
  )
    return null;
  if (line.number > 1 && state.doc.line(line.number - 1).text.includes("|"))
    return null;
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null =
      syntaxTree(state).resolveInner(line.from, 1);
    node;
    node = node.parent
  ) {
    if (NO_AUTO_TABLE_NODES.has(node.name)) return null;
  }
  const cells = splitTableCellsWithRanges(text, line.from).map((c) => c.text);
  if (cells.length === 0) return null;
  return cells;
}

/** Enter at the end of `|a|b|`: header + delimiter + one empty row. */
export function convertPipeRowToTable(view: EditorView): boolean {
  const { state } = view;
  const cells = pipeRowCells(state);
  if (!cells) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  const markdown = formatMarkdownTable(
    cells,
    cells.map((): DelimiterStyle => "default"),
    [emptyRow(cells.length)],
  );
  // A table can't continue a paragraph line: separate it with a blank line.
  const prevBlank =
    line.number === 1 || state.doc.line(line.number - 1).text.trim() === "";
  const prefix = prevBlank ? "" : "\n";
  const tableFrom = line.from + prefix.length;
  const range = cellRangeInMarkdown(markdown, tableFrom, { row: 1, col: 0 });
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: prefix + markdown },
    selection: EditorSelection.cursor(range?.from ?? tableFrom),
    scrollIntoView: true,
    userEvent: "input.table",
  });
  focusTableCell(view, tableFrom, 1, 0);
  return true;
}

// ---------------------------------------------------------------------------
// Commands (keyboard / toolbar / context menu)
// ---------------------------------------------------------------------------

export type TableAction =
  | "rowAbove"
  | "rowBelow"
  | "deleteRow"
  | "colLeft"
  | "colRight"
  | "deleteCol"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "moveColLeft"
  | "moveColRight"
  | "deleteTable";

/** The result of `action` on `cell` (alignment buttons toggle). */
export function tableActionResult(
  action: TableAction,
  active: ActiveTableCell,
): TableOpResult | null {
  const { table } = active;
  const cell = { row: active.row, col: active.col };
  const toggle = (a: ColumnAlign) =>
    setColumnAlign(table, cell, columnAlign(table, cell.col) === a ? null : a);
  switch (action) {
    case "rowAbove":
      return insertRow(table, cell, "above");
    case "rowBelow":
      return insertRow(table, cell, "below");
    case "deleteRow":
      return deleteRow(table, cell);
    case "colLeft":
      return insertColumn(table, cell, "left");
    case "colRight":
      return insertColumn(table, cell, "right");
    case "deleteCol":
      return deleteColumn(table, cell);
    case "alignLeft":
      return toggle("left");
    case "alignCenter":
      return toggle("center");
    case "alignRight":
      return toggle("right");
    case "moveColLeft":
      return moveColumn(table, cell, -1);
    case "moveColRight":
      return moveColumn(table, cell, 1);
    case "deleteTable":
      return deleteTable(table);
  }
}

/** Run `action` on the given cell, or the cell at the cursor. */
export function runTableAction(
  view: EditorView,
  action: TableAction,
  target: ActiveTableCell | null = getActiveTableCell(view.state),
): boolean {
  if (!target) return false;
  return applyTableOp(view, target.table, tableActionResult(action, target));
}
