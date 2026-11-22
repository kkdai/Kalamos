import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { redo, undo } from "@codemirror/commands";
import {
  Annotation,
  EditorSelection,
  type EditorState,
  type Range,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  runScopeHandlers,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { MarkdownParser } from "@lezer/markdown";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import {
  isSelectionTouchingRange,
  navigateMarkdownLink,
} from "./live-preview";
import { clampPos, mapPosClamped } from "./positions";

export type TableAlign = "left" | "center" | "right";
export type DelimiterStyle = "default" | "left" | "center" | "right";

export interface ParsedTableCell {
  text: string;
  rawFrom: number;
  rawTo: number;
  contentFrom: number;
  contentTo: number;
}

export interface ParsedTableRow {
  lineNumber: number;
  from: number;
  to: number;
  rawLineText: string;
  cells: ParsedTableCell[];
  /**
   * Text of cells beyond the header's column count (body rows only). The
   * widget renders `cells`, but formatting must never drop these (BUG-5).
   */
  overflowCellTexts: string[];
  isDelimiter: boolean;
}

export interface ParsedTable {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  firstLineKey: string;
  colCount: number;
  alignments: TableAlign[];
  delimiterStyles: DelimiterStyle[];
  headerRow: ParsedTableRow;
  delimiterRow: ParsedTableRow;
  bodyRows: ParsedTableRow[];
  allRows: ParsedTableRow[];
}

export const tableColumnWidthsMap = new Map<string, number[]>();

export function setTableColumnWidth(
  firstLineKey: string,
  colIndex: number,
  widthPx: number,
): void {
  const key = firstLineKey.trim();
  const existing = tableColumnWidthsMap.get(key) ?? [];
  existing[colIndex] = Math.max(40, Math.round(widthPx));
  tableColumnWidthsMap.set(key, existing);
}

export function clearTableColumnWidths(): void {
  tableColumnWidthsMap.clear();
}

export function isEastAsianWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

export function getDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (/\p{M}/u.test(ch)) continue;
    width += isEastAsianWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

export function splitTableCellsWithRanges(
  lineText: string,
  lineFrom: number,
): ParsedTableCell[] {
  const pipeOffsets: number[] = [];
  let escaped = false;
  let inCode = false;

  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (ch === "|" && !inCode) {
      pipeOffsets.push(i);
    }
  }

  if (pipeOffsets.length === 0) {
    return [];
  }

  const rawIntervals: Array<{ start: number; end: number }> = [];
  const beforeFirst = lineText.slice(0, pipeOffsets[0]);
  if (beforeFirst.trim().length > 0) {
    rawIntervals.push({ start: 0, end: pipeOffsets[0] });
  }

  for (let i = 0; i < pipeOffsets.length - 1; i++) {
    rawIntervals.push({
      start: pipeOffsets[i] + 1,
      end: pipeOffsets[i + 1],
    });
  }

  const afterLast = lineText.slice(pipeOffsets[pipeOffsets.length - 1] + 1);
  if (afterLast.trim().length > 0) {
    rawIntervals.push({
      start: pipeOffsets[pipeOffsets.length - 1] + 1,
      end: lineText.length,
    });
  }

  return rawIntervals.map(({ start, end }) => {
    const rawSlice = lineText.slice(start, end);
    const leadingSpaces = /^[\t ]*/.exec(rawSlice)?.[0].length ?? 0;
    const trailingSpaces = /[\t ]*$/.exec(rawSlice)?.[0].length ?? 0;
    const text = rawSlice.trim();

    const rawFrom = lineFrom + start;
    const rawTo = lineFrom + end;
    let contentFrom: number;
    let contentTo: number;
    if (text.length === 0) {
      const anchor = Math.min(rawTo, rawFrom + Math.min(1, rawTo - rawFrom));
      contentFrom = anchor;
      contentTo = anchor;
    } else {
      contentFrom = rawFrom + leadingSpaces;
      contentTo = rawTo - trailingSpaces;
    }

    return {
      text,
      rawFrom,
      rawTo,
      contentFrom,
      contentTo,
    };
  });
}

function parseDelimiterCell(cellText: string): {
  valid: boolean;
  align: TableAlign;
  style: DelimiterStyle;
} {
  const trimmed = cellText.trim();
  if (!/^:?-+:?$/.test(trimmed)) {
    return { valid: false, align: "left", style: "default" };
  }
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");
  if (left && right) {
    return { valid: true, align: "center", style: "center" };
  }
  if (right) {
    return { valid: true, align: "right", style: "right" };
  }
  if (left) {
    return { valid: true, align: "left", style: "left" };
  }
  return { valid: true, align: "left", style: "default" };
}

export function isDelimiterRowText(lineText: string): boolean {
  const cells = splitTableCellsWithRanges(lineText, 0);
  if (cells.length === 0) return false;
  return cells.every((c) => parseDelimiterCell(c.text).valid);
}

export function parseTableFromLines(
  lines: Array<{
    text: string;
    from: number;
    to: number;
    lineNumber: number;
  }>,
): ParsedTable | null {
  if (lines.length < 2) return null;
  const headerCells = splitTableCellsWithRanges(lines[0].text, lines[0].from);
  const delimCells = splitTableCellsWithRanges(lines[1].text, lines[1].from);
  if (
    headerCells.length === 0 ||
    delimCells.length !== headerCells.length ||
    !delimCells.every((c) => parseDelimiterCell(c.text).valid)
  ) {
    return null;
  }

  const colCount = headerCells.length;
  const alignments: TableAlign[] = [];
  const delimiterStyles: DelimiterStyle[] = [];
  for (const dc of delimCells) {
    const parsed = parseDelimiterCell(dc.text);
    alignments.push(parsed.align);
    delimiterStyles.push(parsed.style);
  }

  const headerRow: ParsedTableRow = {
    lineNumber: lines[0].lineNumber,
    from: lines[0].from,
    to: lines[0].to,
    rawLineText: lines[0].text,
    cells: headerCells,
    overflowCellTexts: [],
    isDelimiter: false,
  };

  const delimiterRow: ParsedTableRow = {
    lineNumber: lines[1].lineNumber,
    from: lines[1].from,
    to: lines[1].to,
    rawLineText: lines[1].text,
    cells: delimCells,
    overflowCellTexts: [],
    isDelimiter: true,
  };

  const bodyRows: ParsedTableRow[] = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    const cells = splitTableCellsWithRanges(line.text, line.from);
    if (cells.length === 0) break;
    while (cells.length < colCount) {
      cells.push({
        text: "",
        rawFrom: line.to,
        rawTo: line.to,
        contentFrom: line.to,
        contentTo: line.to,
      });
    }
    bodyRows.push({
      lineNumber: line.lineNumber,
      from: line.from,
      to: line.to,
      rawLineText: line.text,
      cells: cells.slice(0, colCount),
      overflowCellTexts: cells.slice(colCount).map((c) => c.text),
      isDelimiter: false,
    });
  }

  const allRows = [headerRow, delimiterRow, ...bodyRows];
  const lastRow = allRows[allRows.length - 1];

  return {
    from: headerRow.from,
    to: lastRow.to,
    startLine: headerRow.lineNumber,
    endLine: lastRow.lineNumber,
    firstLineKey: headerRow.rawLineText.trim(),
    colCount,
    alignments,
    delimiterStyles,
    headerRow,
    delimiterRow,
    bodyRows,
    allRows,
  };
}

export function parseTableInRange(
  state: EditorState,
  from: number,
  to: number,
): ParsedTable | null {
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(Math.max(from, to));
  const lines: Array<{
    text: string;
    from: number;
    to: number;
    lineNumber: number;
  }> = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const l = state.doc.line(n);
    lines.push({
      text: l.text,
      from: l.from,
      to: l.to,
      lineNumber: l.number,
    });
  }
  return parseTableFromLines(lines);
}

export function findTableAtPos(
  state: EditorState,
  pos: number,
): ParsedTable | null {
  const tree = syntaxTree(state);
  let cur: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(
    pos,
    0,
  );
  while (cur) {
    if (cur.name === "Table") {
      return parseTableInRange(state, cur.from, cur.to);
    }
    cur = cur.parent;
  }

  const line = state.doc.lineAt(pos);
  if (!line.text.includes("|")) return null;

  let topLine = line.number;
  while (topLine > 1 && state.doc.line(topLine - 1).text.includes("|")) {
    topLine--;
  }
  let bottomLine = line.number;
  while (
    bottomLine < state.doc.lines &&
    state.doc.line(bottomLine + 1).text.includes("|")
  ) {
    bottomLine++;
  }

  return parseTableInRange(
    state,
    state.doc.line(topLine).from,
    state.doc.line(bottomLine).to,
  );
}

function formatDelimiterForWidth(
  style: DelimiterStyle,
  width: number,
): string {
  const w = Math.max(3, width);
  if (style === "center") {
    return `:${"-".repeat(Math.max(1, w - 2))}:`;
  }
  if (style === "left") {
    return `:${"-".repeat(Math.max(2, w - 1))}`;
  }
  if (style === "right") {
    return `${"-".repeat(Math.max(2, w - 1))}:`;
  }
  return "-".repeat(w);
}

export function formatMarkdownTable(
  headerCells: string[],
  delimiterStyles: DelimiterStyle[],
  bodyRows: string[][],
): string {
  const colCount = headerCells.length;
  const colWidths: number[] = Array.from({ length: colCount }, (_, colIdx) => {
    const style = delimiterStyles[colIdx] ?? "default";
    const minForDelim = style === "default" ? 3 : 4;
    let maxW = Math.max(minForDelim, getDisplayWidth(headerCells[colIdx] ?? ""));
    for (const row of bodyRows) {
      maxW = Math.max(maxW, getDisplayWidth(row[colIdx] ?? ""));
    }
    return maxW;
  });

  const formatRow = (cells: string[]): string => {
    const parts = Array.from({ length: colCount }, (_, colIdx) => {
      const cell = (cells[colIdx] ?? "").trim();
      const padCount = Math.max(0, colWidths[colIdx] - getDisplayWidth(cell));
      return ` ${cell}${" ".repeat(padCount)} `;
    });
    return `|${parts.join("|")}|`;
  };

  const delimParts = Array.from({ length: colCount }, (_, colIdx) => {
    const style = delimiterStyles[colIdx] ?? "default";
    return ` ${formatDelimiterForWidth(style, colWidths[colIdx])} `;
  });
  const delimLine = `|${delimParts.join("|")}|`;

  return [
    formatRow(headerCells),
    delimLine,
    ...bodyRows.map((row) => formatRow(row)),
  ].join("\n");
}

export interface TableCellMatrix {
  colCount: number;
  headerCells: string[];
  delimiterStyles: DelimiterStyle[];
  bodyRows: string[][];
}

/**
 * Cell texts of a parsed table, ready for `formatMarkdownTable`. Body rows
 * that carry more non-empty cells than the header widen the table (new empty
 * header cells, default delimiters) instead of losing text. Trailing empty
 * overflow cells are whitespace only and are dropped.
 */
export function tableCellMatrix(table: ParsedTable): TableCellMatrix {
  let colCount = table.colCount;
  for (const row of table.bodyRows) {
    const overflow = row.overflowCellTexts;
    for (let i = overflow.length - 1; i >= 0; i--) {
      if (overflow[i].length > 0) {
        colCount = Math.max(colCount, table.colCount + i + 1);
        break;
      }
    }
  }
  const pad = (cells: string[]) =>
    Array.from({ length: colCount }, (_, i) => cells[i] ?? "");
  return {
    colCount,
    headerCells: pad(table.headerRow.cells.map((c) => c.text)),
    delimiterStyles: Array.from(
      { length: colCount },
      (_, i) => table.delimiterStyles[i] ?? "default",
    ),
    bodyRows: table.bodyRows.map((r) =>
      pad([...r.cells.map((c) => c.text), ...r.overflowCellTexts]),
    ),
  };
}

export function formatParsedTable(table: ParsedTable): string {
  const m = tableCellMatrix(table);
  return formatMarkdownTable(m.headerCells, m.delimiterStyles, m.bodyRows);
}

function locateCursorCellInTable(
  table: ParsedTable,
  pos: number,
): { navRowIdx: number; colIdx: number } {
  const navigableRows = [table.headerRow, ...table.bodyRows];
  if (pos >= table.delimiterRow.from && pos <= table.delimiterRow.to) {
    return { navRowIdx: 0, colIdx: table.colCount - 1 };
  }

  let navRowIdx = 0;
  for (let i = 0; i < navigableRows.length; i++) {
    if (pos >= navigableRows[i].from && pos <= navigableRows[i].to) {
      navRowIdx = i;
      break;
    }
  }

  const row = navigableRows[navRowIdx];
  let colIdx = 0;
  for (let c = 0; c < row.cells.length; c++) {
    const cell = row.cells[c];
    if (pos >= cell.rawFrom && pos <= cell.rawTo) {
      colIdx = c;
      break;
    }
    if (pos > cell.rawTo) {
      colIdx = c;
    }
  }

  return { navRowIdx, colIdx };
}

function dispatchFormattedTableAndSelectCell(
  view: EditorView,
  table: ParsedTable,
  headerCells: string[],
  delimiterStyles: DelimiterStyle[],
  bodyRows: string[][],
  targetNavRowIdx: number,
  targetColIdx: number,
  userEvent = "input.table",
): boolean {
  const formatted = formatMarkdownTable(headerCells, delimiterStyles, bodyRows);
  const rawLines = formatted.split("\n");
  let offset = table.from;
  const lineObjs = rawLines.map((text, idx) => {
    const from = offset;
    const to = from + text.length;
    offset = to + 1;
    return { text, from, to, lineNumber: table.startLine + idx };
  });

  const reparsed = parseTableFromLines(lineObjs);
  let anchor = table.from;
  let head = table.from;
  if (reparsed) {
    const navRows = [reparsed.headerRow, ...reparsed.bodyRows];
    const clampedRow = Math.max(0, Math.min(targetNavRowIdx, navRows.length - 1));
    const clampedCol = Math.max(0, Math.min(targetColIdx, reparsed.colCount - 1));
    const targetCell = navRows[clampedRow]?.cells[clampedCol];
    if (targetCell) {
      anchor = targetCell.contentFrom;
      head = targetCell.contentTo;
    }
  }

  view.dispatch({
    changes: { from: table.from, to: table.to, insert: formatted },
    selection: EditorSelection.range(anchor, head),
    scrollIntoView: true,
    userEvent,
  });
  return true;
}

export function handleTableTab(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const table = findTableAtPos(state, pos);
  if (!table) return false;

  const { navRowIdx, colIdx } = locateCursorCellInTable(table, pos);
  const { colCount, headerCells, delimiterStyles, bodyRows } =
    tableCellMatrix(table);
  const totalNavRows = 1 + bodyRows.length;

  let nextNavRowIdx = navRowIdx;
  let nextColIdx = colIdx + 1;
  if (nextColIdx >= colCount) {
    nextColIdx = 0;
    nextNavRowIdx = navRowIdx + 1;
    if (nextNavRowIdx >= totalNavRows) {
      bodyRows.push(Array.from({ length: colCount }, () => ""));
    }
  }

  return dispatchFormattedTableAndSelectCell(
    view,
    table,
    headerCells,
    delimiterStyles,
    bodyRows,
    nextNavRowIdx,
    nextColIdx,
  );
}

export function handleTableShiftTab(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const table = findTableAtPos(state, pos);
  if (!table) return false;

  const { navRowIdx, colIdx } = locateCursorCellInTable(table, pos);
  const { colCount, headerCells, delimiterStyles, bodyRows } =
    tableCellMatrix(table);

  let prevNavRowIdx = navRowIdx;
  let prevColIdx = colIdx - 1;
  if (prevColIdx < 0) {
    if (navRowIdx > 0) {
      prevNavRowIdx = navRowIdx - 1;
      prevColIdx = colCount - 1;
    } else {
      prevNavRowIdx = 0;
      prevColIdx = 0;
    }
  }

  return dispatchFormattedTableAndSelectCell(
    view,
    table,
    headerCells,
    delimiterStyles,
    bodyRows,
    prevNavRowIdx,
    prevColIdx,
  );
}

function isTableRowEmpty(row: ParsedTableRow): boolean {
  return (
    row.cells.every((c) => c.text.length === 0) &&
    row.overflowCellTexts.every((t) => t.length === 0)
  );
}

function exitTableFromEmptyLastRow(
  view: EditorView,
  row: ParsedTableRow,
): boolean {
  const { state } = view;
  // Remove the empty row (and the newline before it), then leave
  // "<last row>\n\n<cursor>". The blank line is required: a plain line right
  // after a table row would be parsed as another row. If a single-newline
  // paragraph followed, keep it separated from the new cursor line too.
  const from = row.from - 1;
  const rest = state.sliceDoc(row.to, Math.min(state.doc.length, row.to + 2));
  const insert =
    rest.startsWith("\n") && !rest.startsWith("\n\n") ? "\n\n\n" : "\n\n";
  view.dispatch({
    changes: { from, to: row.to, insert },
    selection: EditorSelection.cursor(from + 2),
    scrollIntoView: true,
    userEvent: "input.table.exit",
  });
  return true;
}

export function handleTableEnter(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const table = findTableAtPos(state, pos);
  if (!table) return false;

  const { navRowIdx } = locateCursorCellInTable(table, pos);

  // Enter on an empty last body row leaves the table: drop that row and put
  // the cursor in a new paragraph after the table (blank line in between).
  const lastBodyRow = table.bodyRows[table.bodyRows.length - 1];
  const onDelimiterRow =
    pos >= table.delimiterRow.from && pos <= table.delimiterRow.to;
  if (
    lastBodyRow &&
    !onDelimiterRow &&
    navRowIdx === table.bodyRows.length &&
    isTableRowEmpty(lastBodyRow)
  ) {
    return exitTableFromEmptyLastRow(view, lastBodyRow);
  }

  const { colCount, headerCells, delimiterStyles, bodyRows } =
    tableCellMatrix(table);

  const insertBodyIndex = Math.max(0, navRowIdx);
  bodyRows.splice(
    insertBodyIndex,
    0,
    Array.from({ length: colCount }, () => ""),
  );

  return dispatchFormattedTableAndSelectCell(
    view,
    table,
    headerCells,
    delimiterStyles,
    bodyRows,
    insertBodyIndex + 1,
    0,
  );
}

export function insertDefaultTable(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const needsLeadingNewline = line.text.trim().length > 0;
  const insertPos = needsLeadingNewline ? line.to : line.from;
  const prefix = needsLeadingNewline ? "\n" : "";

  const headerCells = ["Header 1", "Header 2", "Header 3"];
  const delimiterStyles: DelimiterStyle[] = ["left", "left", "left"];
  const bodyRows = [
    ["", "", ""],
    ["", "", ""],
  ];
  const formatted = formatMarkdownTable(headerCells, delimiterStyles, bodyRows);
  const fullInsert = `${prefix}${formatted}`;

  const tableStart = insertPos + prefix.length;
  const firstRowCells = splitTableCellsWithRanges(
    formatted.split("\n")[0],
    tableStart,
  );
  const firstCell = firstRowCells[0];

  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: fullInsert },
    selection: firstCell
      ? EditorSelection.range(firstCell.contentFrom, firstCell.contentTo)
      : EditorSelection.cursor(tableStart + 2),
    scrollIntoView: true,
    userEvent: "input.table",
  });
  return true;
}

export function reorderTableBodyRow(
  view: EditorView,
  tableFrom: number,
  fromBodyRowIndex: number,
  toBodyRowIndex: number,
): boolean {
  const table = findTableAtPos(view.state, tableFrom);
  if (!table) return false;
  if (
    fromBodyRowIndex < 0 ||
    fromBodyRowIndex >= table.bodyRows.length ||
    toBodyRowIndex < 0 ||
    toBodyRowIndex >= table.bodyRows.length ||
    fromBodyRowIndex === toBodyRowIndex
  ) {
    return false;
  }

  const { headerCells, delimiterStyles, bodyRows } = tableCellMatrix(table);
  const [moved] = bodyRows.splice(fromBodyRowIndex, 1);
  bodyRows.splice(toBodyRowIndex, 0, moved);

  const formatted = formatMarkdownTable(headerCells, delimiterStyles, bodyRows);

  view.dispatch({
    changes: { from: table.from, to: table.to, insert: formatted },
    userEvent: "move.tableRow",
  });
  return true;
}

export function unescapeTableCellText(text: string): string {
  return text.replace(/\\\|/g, "|");
}

const SKIPPED_INLINE_MARK_NAMES = new Set([
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "HeaderMark",
]);

function renderLezerChildrenToDom(
  parentNode: SyntaxNode,
  source: string,
  fromBound: number,
  toBound: number,
  targetDom: Node,
): void {
  let cursor = fromBound;

  for (let child = parentNode.firstChild; child; child = child.nextSibling) {
    if (child.to <= fromBound || child.from >= toBound) continue;
    const childFrom = Math.max(fromBound, child.from);
    const childTo = Math.min(toBound, child.to);

    if (childFrom > cursor) {
      targetDom.appendChild(
        document.createTextNode(source.slice(cursor, childFrom)),
      );
    }

    if (SKIPPED_INLINE_MARK_NAMES.has(child.name)) {
      // Omit syntax marker characters
    } else if (child.name === "HTMLTag" && /^<br\s*\/?>$/i.test(source.slice(childFrom, childTo))) {
      targetDom.appendChild(document.createElement("br"));
    } else if (child.name === "Entity") {
      targetDom.appendChild(document.createTextNode(decodeEntity(source.slice(childFrom, childTo))));
    } else if (child.name === "Escape") {
      const escapedChar =
        child.to - child.from >= 2
          ? source.slice(child.from + 1, child.to)
          : source.slice(childFrom, childTo);
      targetDom.appendChild(document.createTextNode(escapedChar));
    } else if (child.name === "InlineCode") {
      const codeEl = document.createElement("code");
      codeEl.className = "k-code";
      const marks = child.getChildren("CodeMark");
      if (marks.length >= 2) {
        codeEl.textContent = source.slice(
          marks[0].to,
          marks[marks.length - 1].from,
        );
      } else {
        codeEl.textContent = source.slice(childFrom, childTo);
      }
      targetDom.appendChild(codeEl);
    } else if (child.name === "StrongEmphasis") {
      const strongEl = document.createElement("strong");
      strongEl.className = "k-strong";
      renderLezerChildrenToDom(child, source, childFrom, childTo, strongEl);
      targetDom.appendChild(strongEl);
    } else if (child.name === "Emphasis") {
      const emEl = document.createElement("em");
      emEl.className = "k-em";
      renderLezerChildrenToDom(child, source, childFrom, childTo, emEl);
      targetDom.appendChild(emEl);
    } else if (child.name === "Strikethrough") {
      const delEl = document.createElement("del");
      delEl.className = "k-strike";
      renderLezerChildrenToDom(child, source, childFrom, childTo, delEl);
      targetDom.appendChild(delEl);
    } else if (child.name === "Link") {
      const linkMarks = child.getChildren("LinkMark");
      const urlNode = child.getChild("URL");
      if (linkMarks.length >= 2) {
        const openBracket = linkMarks[0];
        const closeBracket = linkMarks[1];
        let rawHref = urlNode
          ? source.slice(urlNode.from, urlNode.to).trim()
          : "";
        if (rawHref.startsWith("<") && rawHref.endsWith(">")) {
          rawHref = rawHref.slice(1, -1).trim();
        }
        const linkSpan = document.createElement("span");
        linkSpan.className = "k-link";
        linkSpan.setAttribute("data-href", rawHref);
        renderLezerChildrenToDom(
          child,
          source,
          openBracket.to,
          closeBracket.from,
          linkSpan,
        );
        targetDom.appendChild(linkSpan);
      } else {
        targetDom.appendChild(
          document.createTextNode(source.slice(childFrom, childTo)),
        );
      }
    } else {
      renderLezerChildrenToDom(child, source, childFrom, childTo, targetDom);
    }

    cursor = Math.max(cursor, childTo);
  }

  if (cursor < toBound) {
    targetDom.appendChild(
      document.createTextNode(source.slice(cursor, toBound)),
    );
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeEntity(entity: string): string {
  const m = /^&(#x[0-9a-f]+|#[0-9]+|[a-z]+);$/i.exec(entity);
  if (!m) return entity;
  const body = m[1];
  if (body[0] === "#") {
    const cp = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : entity;
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
}

let cellParser: MarkdownParser | null = null;

/** Parser for table cell contents; shares the editor's CJK emphasis rule. */
function cellInlineParser(): MarkdownParser {
  cellParser ??= (markdownLanguage.parser as MarkdownParser).configure([cjkEmphasisExtension]);
  return cellParser;
}

export function renderCellInlineMarkdownToFragment(
  rawCellText: string,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const text = unescapeTableCellText(rawCellText);
  if (!text) return fragment;

  const tree = cellInlineParser().parse(text);
  renderLezerChildrenToDom(tree.topNode, text, 0, text.length, fragment);
  return fragment;
}

// ---------------------------------------------------------------------------
// #59 A: WYSIWYG cell editing
//
// Every cell's `span.k-table-cell-content` is its own contenteditable. The
// widget DOM is contenteditable=false and `ignoreEvent()` is true, so CM
// ignores events, DOM mutations and DOM selection inside it; the cell owns
// its input and writes each change back to the document (only that cell's
// contentFrom..contentTo, minimal diff, userEvent "input.type") so undo/redo
// is the main editor's CM history. `updateDOM` keeps the DOM (and focus) when
// the table's shape is unchanged; only non-focused cells are re-rendered.
// ---------------------------------------------------------------------------

/** Marks transactions dispatched by a cell's own contenteditable. */
export const tableCellSync = Annotation.define<boolean>();

const BR_RE = /^<br\s*\/?>/i;

// A literal `<br>` typed into a cell is stored as `&lt;br>` so it is not read
// back as a line break; a literal `&lt;br` is stored as `&amp;lt;br` (and so
// on), so every typed text round-trips.
const LT_BR_RE = /^&lt;br/i;
const AMP_BEFORE_LT_BR_RE = /^&(?=(?:amp;)*lt;br)/i;
const RAW_AMP_BEFORE_LT_BR_RE = /^&amp;(?=(?:amp;)*lt;br)/i;

function rawToken(raw: string, i: number): { display: string; rawLen: number } {
  if (raw.startsWith("\\\\\\|", i)) return { display: "\\|", rawLen: 4 };
  if (raw.startsWith("\\|", i)) return { display: "|", rawLen: 2 };
  if (raw[i] === "<") {
    const m = BR_RE.exec(raw.slice(i, i + 12));
    if (m) return { display: "\n", rawLen: m[0].length };
  }
  if (raw[i] === "&") {
    const rest = raw.slice(i, i + 64);
    if (LT_BR_RE.test(rest)) return { display: "<", rawLen: 4 };
    if (RAW_AMP_BEFORE_LT_BR_RE.test(rest)) return { display: "&", rawLen: 5 };
  }
  return { display: raw[i], rawLen: 1 };
}

function displayToken(text: string, i: number): string {
  const ch = text[i];
  if (ch === "|") return "\\|";
  if (ch === "\n") return "<br>";
  if (ch === "\r") return "";
  if (ch === "<" && BR_RE.test(text.slice(i, i + 12))) return "&lt;";
  if (ch === "&" && AMP_BEFORE_LT_BR_RE.test(text.slice(i, i + 64))) return "&amp;";
  // `\` right before `|` must not escape the `\|` it is turned into.
  if (ch === "\\" && text[i + 1] === "|") return "\\\\";
  return ch;
}

/** Cell source between the pipes → the text shown while the cell is edited. */
export function cellRawToDisplay(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; ) {
    const t = rawToken(raw, i);
    out += t.display;
    i += t.rawLen;
  }
  return out;
}

/** Text typed into a cell → cell source (`|` → `\|`, newline → `<br>`). */
export function cellDisplayToRaw(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += displayToken(text, i);
  return out;
}

function rawOffsetToDisplay(raw: string, rawOff: number): number {
  let d = 0;
  for (let i = 0; i < raw.length && i < rawOff; ) {
    const t = rawToken(raw, i);
    if (i + t.rawLen > rawOff) break;
    d += t.display.length;
    i += t.rawLen;
  }
  return d;
}

function displayOffsetToRaw(text: string, dOff: number): number {
  let r = 0;
  for (let i = 0; i < text.length && i < dOff; i++) r += displayToken(text, i).length;
  return r;
}

function readCellText(node: Node): string {
  let out = "";
  node.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? "";
    else if (n.nodeName === "BR") out += "\n";
    else if (n.nodeType === Node.ELEMENT_NODE) {
      if ((n.nodeName === "DIV" || n.nodeName === "P") && out.length > 0 && !out.endsWith("\n")) {
        out += "\n";
      }
      out += readCellText(n);
    }
  });
  return out;
}

/** Text length of the cell without the placeholder `<br>` a trailing newline needs. */
function cellTextLength(el: HTMLElement): number {
  return readCellText(el).replace(/\n$/, "").length;
}

function setCellText(el: HTMLElement, text: string): void {
  el.textContent = text;
  // A trailing newline is invisible without something after it.
  if (text.endsWith("\n")) el.appendChild(document.createElement("br"));
}

function textOffsetIn(el: HTMLElement, node: Node, offset: number): number {
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(node, offset);
  return readCellText(pre.cloneContents()).length;
}

function cellSelectionOffsets(el: HTMLElement): { start: number; end: number } | null {
  const sel = el.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  return {
    start: textOffsetIn(el, r.startContainer, r.startOffset),
    end: textOffsetIn(el, r.endContainer, r.endOffset),
  };
}

function domPointAt(el: HTMLElement, off: number): [Node, number] {
  let rem = off;
  const walk = (node: Node): [Node, number] | null => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i];
      if (n.nodeType === Node.TEXT_NODE) {
        const len = n.nodeValue?.length ?? 0;
        if (rem <= len) return [n, rem];
        rem -= len;
      } else if (n.nodeName === "BR") {
        if (rem === 0) return [node, i];
        rem -= 1;
      } else {
        const r = walk(n);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(el) ?? [el, el.childNodes.length];
}

function setCellSelection(el: HTMLElement, start: number, end: number): void {
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  const len = cellTextLength(el);
  const [sn, so] = domPointAt(el, Math.max(0, Math.min(start, len)));
  const [en, eo] = domPointAt(el, Math.max(0, Math.min(end, len)));
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Replace the cell's DOM selection with plain text (paste, drop, Shift+Enter, Cmd+B). */
function insertTextInCell(el: HTMLElement, text: string, caretBack = 0): void {
  const offsets = cellSelectionOffsets(el) ?? { start: cellTextLength(el), end: cellTextLength(el) };
  const current = readCellText(el).replace(/\n$/, "");
  const next = current.slice(0, offsets.start) + text + current.slice(offsets.end);
  setCellText(el, next);
  const caret = offsets.start + text.length - caretBack;
  setCellSelection(el, caret, caret);
}

function navRowsOf(table: ParsedTable): ParsedTableRow[] {
  return [table.headerRow, ...table.bodyRows];
}

interface CellLocation {
  table: ParsedTable;
  row: ParsedTableRow;
  cell: ParsedTableCell;
  rowIdx: number;
  col: number;
}

function locateCellElement(view: EditorView, el: HTMLElement): CellLocation | null {
  const wrapper = el.closest<HTMLElement>(".k-table-wrapper");
  const td = el.closest<HTMLElement>("th, td");
  if (!wrapper || !td || !wrapper.isConnected) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(wrapper);
  } catch {
    return null;
  }
  const table = findTableAtPos(view.state, pos);
  if (!table) return null;
  const rowIdx = Number(td.dataset.row);
  const col = Number(td.dataset.col);
  const row = navRowsOf(table)[rowIdx];
  const cell = row?.cells[col];
  if (!row || !cell) return null;
  return { table, row, cell, rowIdx, col };
}

function findCellElement(
  view: EditorView,
  tableFrom: number,
  row: number,
  col: number,
): HTMLElement | null {
  for (const wrapper of view.contentDOM.querySelectorAll<HTMLElement>(".k-table-wrapper")) {
    let pos: number;
    try {
      pos = view.posAtDOM(wrapper);
    } catch {
      continue;
    }
    if (pos !== tableFrom) continue;
    return wrapper.querySelector<HTMLElement>(
      `[data-row="${row}"][data-col="${col}"] .k-table-cell-content`,
    );
  }
  return null;
}

/** Write the cell's text back to its source range (one CM transaction). */
function writeCellFromElement(view: EditorView, el: HTMLElement): void {
  if (el.dataset.composing === "1") return;
  const loc = locateCellElement(view, el);
  if (!loc) return;
  const full = readCellText(el);
  const lead = full.length - full.replace(/^\s+/, "").length;
  const display = full.trim();
  let raw = cellDisplayToRaw(display);
  // A trailing odd backslash would escape the closing pipe (`|x\|`): pad it.
  if (/(^|[^\\])(\\\\)*\\$/.test(raw)) raw += " ";
  const offsets = cellSelectionOffsets(el);
  const { state } = view;
  const { cell, row } = loc;

  let from: number;
  let to: number;
  let insert: string;
  let contentFrom: number;
  if (cell.rawFrom === cell.rawTo && cell.rawFrom === row.to) {
    // A cell missing from a short row: append it (and any missing before it).
    if (!raw) return;
    const missingBefore = row.cells
      .slice(0, loc.col)
      .filter((c) => c.rawFrom === c.rawTo && c.rawFrom === row.to).length;
    const endsWithPipe = state.sliceDoc(row.from, row.to).trimEnd().endsWith("|");
    const head = endsWithPipe ? "" : " |";
    insert = `${head}${"   |".repeat(missingBefore)} ${raw} |`;
    from = to = row.to;
    contentFrom = row.to + insert.length - raw.length - 2;
  } else {
    const old = state.sliceDoc(cell.contentFrom, cell.contentTo);
    if (old === raw) return;
    let p = 0;
    while (p < old.length && p < raw.length && old[p] === raw[p]) p++;
    let q = 0;
    while (
      q < old.length - p &&
      q < raw.length - p &&
      old[old.length - 1 - q] === raw[raw.length - 1 - q]
    ) {
      q++;
    }
    from = cell.contentFrom + p;
    to = cell.contentTo - q;
    insert = raw.slice(p, raw.length - q);
    contentFrom = cell.contentFrom;
  }
  const caretDisplay = offsets
    ? Math.max(0, Math.min(offsets.end - lead, display.length))
    : display.length;
  const head = contentFrom + displayOffsetToRaw(display, caretDisplay);
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(head),
    userEvent: "input.type",
    annotations: tableCellSync.of(true),
  });
}

/** Keep CM's main selection inside the focused cell (for getActiveTableCell). */
function syncSelectionToCell(view: EditorView, el: HTMLElement): void {
  const loc = locateCellElement(view, el);
  if (!loc) return;
  const sel = view.state.selection.main;
  const { cell } = loc;
  if (sel.from >= cell.rawFrom && sel.to <= cell.rawTo && sel.from >= loc.row.from) {
    const again = locateCursorCellInTable(loc.table, sel.head);
    if (again.navRowIdx === loc.rowIdx && again.colIdx === loc.col) return;
  }
  view.dispatch({
    selection: EditorSelection.cursor(cell.contentTo),
    annotations: tableCellSync.of(true),
  });
}

function renderCellContent(el: HTMLElement, raw: string): void {
  el.dataset.raw = raw;
  el.replaceChildren(renderCellInlineMarkdownToFragment(raw));
}

function focusCellElement(el: HTMLElement, start: number, end: number): void {
  if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true });
  setCellSelection(el, start, end);
}

/** Focus the cell holding CM's main selection, or CM itself if there is none. */
function focusFromSelection(view: EditorView): boolean {
  const active = getActiveTableCell(view.state);
  const el = active ? findCellElement(view, active.table.from, active.row, active.col) : null;
  if (!active || !el) return false;
  const cell = navRowsOf(active.table)[active.row].cells[active.col];
  const sel = view.state.selection.main;
  const raw = cell.text;
  const toDisplay = (pos: number) =>
    rawOffsetToDisplay(raw, Math.max(0, Math.min(pos - cell.contentFrom, raw.length)));
  const start = toDisplay(sel.from);
  const end = toDisplay(sel.to);
  focusCellElement(el, start, end);
  return true;
}

function focusCellWithMode(
  view: EditorView,
  tableFrom: number,
  row: number,
  col: number,
  mode: "all" | "start" | "end",
): boolean {
  const table = findTableAtPos(view.state, clampPos(tableFrom, view.state.doc.length));
  if (!table) return false;
  const rows = navRowsOf(table);
  const r = Math.max(0, Math.min(row, rows.length - 1));
  const c = Math.max(0, Math.min(col, table.colCount - 1));
  const cell = rows[r].cells[c];
  const anchor = mode === "end" ? cell.contentTo : cell.contentFrom;
  const head = mode === "start" ? cell.contentFrom : cell.contentTo;
  view.dispatch({
    selection: EditorSelection.range(anchor, head),
    scrollIntoView: true,
    annotations: tableCellSync.of(true),
  });
  const el = findCellElement(view, table.from, r, c);
  if (!el) {
    view.focus();
    return true;
  }
  el.focus({ preventScroll: true });
  const len = cellTextLength(el);
  if (mode === "all") setCellSelection(el, 0, len);
  else if (mode === "start") setCellSelection(el, 0, 0);
  else setCellSelection(el, len, len);
  return true;
}

export interface ActiveTableCell {
  table: ParsedTable;
  /** 0 = header row, 1.. = body rows. */
  row: number;
  col: number;
}

/** The table cell holding the main selection's head, or null. */
export function getActiveTableCell(state: EditorState): ActiveTableCell | null {
  const head = state.selection.main.head;
  const table = findTableAtPos(state, head);
  if (!table || head < table.from || head > table.to) return null;
  const { navRowIdx, colIdx } = locateCursorCellInTable(table, head);
  return { table, row: navRowIdx, col: colIdx };
}

/**
 * Put the selection (and, in live preview, keyboard focus) on a cell; the
 * cell's whole text is selected. `row` 0 is the header. Out-of-range rows and
 * columns are clamped. Returns false if there is no table at `tableFrom`.
 *
 * With `range` (document positions, clamped to the cell's content), only that
 * part of the cell is selected — used by find & replace (#73) to select a hit.
 */
export function focusTableCell(
  view: EditorView,
  tableFrom: number,
  row: number,
  col: number,
  range?: { from: number; to: number },
): boolean {
  if (!range) return focusCellWithMode(view, tableFrom, row, col, "all");
  const table = findTableAtPos(view.state, clampPos(tableFrom, view.state.doc.length));
  if (!table) return false;
  const rows = navRowsOf(table);
  const r = Math.max(0, Math.min(row, rows.length - 1));
  const c = Math.max(0, Math.min(col, table.colCount - 1));
  const cell = rows[r].cells[c];
  const clampToCell = (pos: number) => Math.max(cell.contentFrom, Math.min(pos, cell.contentTo));
  const from = clampToCell(Math.min(range.from, range.to));
  const to = clampToCell(Math.max(range.from, range.to));
  view.dispatch({
    selection: EditorSelection.range(from, to),
    scrollIntoView: true,
    annotations: tableCellSync.of(true),
  });
  const el = findCellElement(view, table.from, r, c);
  if (!el) {
    view.focus();
    return true;
  }
  const raw = cell.text;
  const toDisplay = (pos: number) =>
    rawOffsetToDisplay(raw, Math.max(0, Math.min(pos - cell.contentFrom, raw.length)));
  focusCellElement(el, toDisplay(from), toDisplay(to));
  return true;
}

function exitTableAbove(view: EditorView, table: ParsedTable): void {
  if (table.startLine > 1) {
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.line(table.startLine - 1).to),
      scrollIntoView: true,
    });
  } else {
    view.dispatch({
      changes: { from: 0, insert: "\n" },
      selection: EditorSelection.cursor(0),
      scrollIntoView: true,
      userEvent: "input.table.exit",
    });
  }
  view.focus();
}

function exitTableBelow(view: EditorView, table: ParsedTable, newParagraph: boolean): void {
  const { state } = view;
  if (!newParagraph && table.endLine < state.doc.lines) {
    view.dispatch({
      selection: EditorSelection.cursor(state.doc.line(table.endLine + 1).from),
      scrollIntoView: true,
    });
  } else {
    // A plain line right after a row would join the table: keep a blank line.
    const rest = state.sliceDoc(table.to, Math.min(state.doc.length, table.to + 2));
    const insert = rest.startsWith("\n") && !rest.startsWith("\n\n") ? "\n\n\n" : "\n\n";
    view.dispatch({
      changes: { from: table.to, insert },
      selection: EditorSelection.cursor(table.to + 2),
      scrollIntoView: true,
      userEvent: "input.table.exit",
    });
  }
  view.focus();
}

function moveToAdjacentCell(view: EditorView, loc: CellLocation, dir: -1 | 1): void {
  const { table } = loc;
  const lastRow = navRowsOf(table).length - 1;
  let r = loc.rowIdx;
  let c = loc.col + dir;
  if (c < 0) {
    r -= 1;
    c = table.colCount - 1;
  } else if (c >= table.colCount) {
    r += 1;
    c = 0;
  }
  if (r < 0) exitTableAbove(view, table);
  else if (r > lastRow) exitTableBelow(view, table, false);
  else focusCellWithMode(view, table.from, r, c, dir < 0 ? "end" : "start");
}

function handleCellEnter(view: EditorView, loc: CellLocation): void {
  const { table } = loc;
  const lastRow = navRowsOf(table).length - 1;
  if (loc.rowIdx < lastRow) {
    focusCellWithMode(view, table.from, loc.rowIdx + 1, loc.col, "end");
    return;
  }
  if (loc.rowIdx > 0 && isTableRowEmpty(loc.row)) {
    exitTableFromEmptyLastRow(view, loc.row);
    view.focus();
    return;
  }
  const { colCount, headerCells, delimiterStyles, bodyRows } = tableCellMatrix(table);
  bodyRows.push(Array.from({ length: colCount }, () => ""));
  dispatchFormattedTableAndSelectCell(
    view,
    table,
    headerCells,
    delimiterStyles,
    bodyRows,
    loc.rowIdx + 1,
    loc.col,
  );
}

function wrapCellSelection(view: EditorView, el: HTMLElement, mark: string): void {
  const offsets = cellSelectionOffsets(el);
  const text = readCellText(el).replace(/\n$/, "");
  const start = offsets?.start ?? text.length;
  const end = offsets?.end ?? text.length;
  const selected = text.slice(start, end);
  insertTextInCell(el, `${mark}${selected}${mark}`, selected ? 0 : mark.length);
  writeCellFromElement(view, el);
}

const NATIVE_MOD_KEYS = new Set(["c", "x", "v"]);

function handleCellKey(view: EditorView, el: HTMLElement, e: KeyboardEvent): boolean {
  const loc = locateCellElement(view, el);
  if (!loc) return false;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "Meta" || k === "Control" || k === "Shift" || k === "Alt") return false;

  if (mod) {
    if (k === "a" && !e.shiftKey && !e.altKey) {
      // Native select-all would escape to the whole editor (outer editing host).
      setCellSelection(el, 0, cellTextLength(el));
      return true;
    }
    if (k === "z" && !e.altKey) {
      if (e.shiftKey) redo(view);
      else undo(view);
      return true;
    }
    if (k === "y" && !e.shiftKey && !e.altKey) {
      redo(view);
      return true;
    }
    if (k === "b" && !e.shiftKey && !e.altKey) {
      wrapCellSelection(view, el, "**");
      return true;
    }
    if (k === "i" && !e.shiftKey && !e.altKey) {
      wrapCellSelection(view, el, "*");
      return true;
    }
    if (k === "Enter") {
      exitTableBelow(view, loc.table, true);
      return true;
    }
    if (NATIVE_MOD_KEYS.has(k) && !e.altKey && !e.shiftKey) return false;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Backspace" || e.key === "Delete") {
      return false; // native line / word movement and deletion inside the cell
    }
    // App shortcuts (save, source mode, find…) keep working inside a cell.
    syncSelectionToCell(view, el);
    return runScopeHandlers(view, e, "editor");
  }

  switch (e.key) {
    case "Tab":
      syncSelectionToCell(view, el);
      if (e.shiftKey) handleTableShiftTab(view);
      else handleTableTab(view);
      return true;
    case "Enter":
      if (e.altKey) return false;
      if (e.shiftKey) {
        insertTextInCell(el, "\n");
        writeCellFromElement(view, el);
        return true;
      }
      handleCellEnter(view, loc);
      return true;
    case "ArrowUp":
      if (e.shiftKey || e.altKey) return false;
      if (loc.rowIdx === 0) exitTableAbove(view, loc.table);
      else focusCellWithMode(view, loc.table.from, loc.rowIdx - 1, loc.col, "end");
      return true;
    case "ArrowDown":
      if (e.shiftKey || e.altKey) return false;
      if (loc.rowIdx === navRowsOf(loc.table).length - 1) exitTableBelow(view, loc.table, false);
      else focusCellWithMode(view, loc.table.from, loc.rowIdx + 1, loc.col, "end");
      return true;
    case "ArrowLeft":
    case "ArrowRight": {
      if (e.shiftKey || e.altKey) return false;
      const offsets = cellSelectionOffsets(el);
      if (!offsets || offsets.start !== offsets.end) return false;
      const atEdge = e.key === "ArrowLeft" ? offsets.start === 0 : offsets.end >= cellTextLength(el);
      if (!atEdge) return false;
      moveToAdjacentCell(view, loc, e.key === "ArrowLeft" ? -1 : 1);
      return true;
    }
    case "Escape":
      exitTableBelow(view, loc.table, false);
      return true;
    default:
      return false;
  }
}

/** Views whose widgets were destroyed while one of their cells had focus. */
/** The cell span that has keyboard focus (cleared on blur unless it was removed). */
let focusedCellEl: HTMLElement | null = null;

function refocusAfterDestroy(view: EditorView): void {
  queueMicrotask(() => {
    if (!view.dom.isConnected) return;
    const active = view.dom.ownerDocument.activeElement;
    if (active && active !== view.dom.ownerDocument.body && view.dom.contains(active)) return;
    if (active && active !== view.dom.ownerDocument.body) return; // focus went elsewhere on purpose
    if (!focusFromSelection(view)) view.focus();
  });
}

const ROW_DRAG_TYPE = "application/x-kalamos-table-row";

function setupCellContent(view: EditorView, el: HTMLElement, raw: string): void {
  el.className = "k-table-cell-content";
  if (view.state.facet(EditorView.editable)) {
    el.contentEditable = "true";
    el.spellcheck = false;
    // Focusable by script/click, but not a stop in the page's Tab order
    // (Tab moves between cells instead).
    el.tabIndex = -1;
  }
  renderCellContent(el, raw);

  el.addEventListener("focus", () => {
    focusedCellEl = el;
    el.dataset.editing = "1";
    const display = cellRawToDisplay(el.dataset.raw ?? "");
    if (readCellText(el).replace(/\n$/, "") !== display) {
      setCellText(el, display);
      setCellSelection(el, display.length, display.length);
    }
    try {
      syncSelectionToCell(view, el);
    } catch {
      // The view is mid-update (e.g. the document was replaced); nothing to sync.
    }
  });
  el.addEventListener("blur", () => {
    // Removed while focused (widget rebuilt): keep it so destroy() can refocus.
    if (el.isConnected && focusedCellEl === el) focusedCellEl = null;
    delete el.dataset.editing;
    delete el.dataset.composing;
    if (el.isConnected) renderCellContent(el, el.dataset.raw ?? "");
  });
  el.addEventListener("compositionstart", () => {
    el.dataset.composing = "1";
  });
  el.addEventListener("compositionend", () => {
    delete el.dataset.composing;
    writeCellFromElement(view, el);
  });
  el.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing || el.dataset.composing === "1") return;
    writeCellFromElement(view, el);
  });
  el.addEventListener("beforeinput", (e) => {
    const type = e.inputType;
    if (type === "historyUndo" || type === "historyRedo") {
      e.preventDefault();
      if (type === "historyUndo") undo(view);
      else redo(view);
    } else if (type.startsWith("format") || type === "insertParagraph") {
      e.preventDefault();
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229 || el.dataset.composing === "1") return;
    if (handleCellKey(view, el, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  el.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
    if (!text) return;
    insertTextInCell(el, text);
    writeCellFromElement(view, el);
  });
  el.addEventListener("drop", (e) => {
    if (e.dataTransfer?.types.includes(ROW_DRAG_TYPE)) return; // row reorder
    e.preventDefault();
    const text = (e.dataTransfer?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
    if (!text) return;
    if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true });
    const doc = el.ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null;
    };
    const point = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (point && el.contains(point.startContainer)) {
      const off = textOffsetIn(el, point.startContainer, point.startOffset);
      setCellSelection(el, off, off);
    }
    insertTextInCell(el, text);
    writeCellFromElement(view, el);
  });
}

/** Bring a cell's DOM up to date with its source; the focused cell keeps its DOM. */
function syncCellContent(view: EditorView, el: HTMLElement, cell: ParsedTableCell): void {
  const raw = cell.text;
  if (el.dataset.raw === raw) return;
  el.dataset.raw = raw;
  if (el.dataset.editing !== "1") {
    renderCellContent(el, raw);
    return;
  }
  if (el.dataset.composing === "1") return;
  const want = cellRawToDisplay(raw);
  if (readCellText(el).trim() === want) return;
  // Changed from outside the cell (undo, Cmd+B via keymap, search & replace…).
  setCellText(el, want);
  const head = view.state.selection.main.head;
  const off =
    head >= cell.contentFrom && head <= cell.contentTo
      ? rawOffsetToDisplay(raw, head - cell.contentFrom)
      : want.length;
  setCellSelection(el, off, off);
}

function tableShapeMatches(dom: HTMLElement, table: ParsedTable): boolean {
  const ths = dom.querySelectorAll("thead th");
  const trs = dom.querySelectorAll("tbody tr");
  if (ths.length !== table.colCount || trs.length !== table.bodyRows.length) return false;
  for (const tr of trs) {
    if (tr.querySelectorAll("td").length !== table.colCount) return false;
  }
  return true;
}

const widgetViews = new WeakMap<HTMLElement, EditorView>();

export class TableBlockWidget extends WidgetType {
  constructor(
    readonly table: ParsedTable,
    readonly rawSource: string,
  ) {
    super();
  }

  eq(other: TableBlockWidget): boolean {
    return (
      this.rawSource === other.rawSource &&
      this.table.from === other.table.from &&
      this.table.to === other.table.to
    );
  }

  /** Same shape → update in place, so a focused cell keeps focus and caret. */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (!tableShapeMatches(dom, this.table)) return false;
    const rows = navRowsOf(this.table);
    for (const cellEl of dom.querySelectorAll<HTMLElement>("th[data-row], td[data-row]")) {
      const r = Number(cellEl.dataset.row);
      const c = Number(cellEl.dataset.col);
      const cell = rows[r]?.cells[c];
      if (!cell) return false;
      const align = this.table.alignments[c] ?? "left";
      if (cellEl.dataset.align !== align) {
        cellEl.dataset.align = align;
        cellEl.style.textAlign = align;
      }
      const content = cellEl.querySelector<HTMLElement>(".k-table-cell-content");
      if (content) syncCellContent(view, content, cell);
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "k-table-wrapper";
    widgetViews.set(wrapper, view);

    const tableEl = document.createElement("table");
    tableEl.className = "k-table";
    tableEl.setAttribute("data-testid", "table-widget");

    const storedWidths =
      tableColumnWidthsMap.get(this.table.firstLineKey) ?? [];

    const modLinkTarget = (event: MouseEvent): HTMLElement | null => {
      if (!event.metaKey && !event.ctrlKey) return null;
      return (event.target as HTMLElement | null)?.closest<HTMLElement>(".k-link[data-href]") ?? null;
    };
    const handleCellClick = (event: MouseEvent) => {
      const linkSpan = modLinkTarget(event);
      if (!linkSpan) return;
      event.preventDefault();
      event.stopPropagation();
      navigateMarkdownLink(linkSpan.dataset.href ?? "", view);
    };

    const handleCellMouseDown = (event: MouseEvent, content: HTMLElement) => {
      const targetEl = event.target as HTMLElement | null;
      if (
        targetEl?.closest(".k-table-col-resizer") ||
        targetEl?.closest(".k-table-row-handle")
      ) {
        return;
      }
      if (modLinkTarget(event)) {
        // Cmd+click follows the link (on click) instead of editing the cell.
        event.preventDefault();
        return;
      }
      if (targetEl && content.contains(targetEl)) return; // native caret placement
      // Padding around the text: edit the cell with the caret at its end.
      event.preventDefault();
      content.focus({ preventScroll: true });
      const len = cellTextLength(content);
      setCellSelection(content, len, len);
    };

    // Header
    const thead = document.createElement("thead");
    const headTr = document.createElement("tr");
    headTr.className = "k-table-header-row";

    this.table.headerRow.cells.forEach((cell, colIdx) => {
      const th = document.createElement("th");
      const align = this.table.alignments[colIdx] ?? "left";
      th.style.textAlign = align;
      th.dataset.align = align;
      th.dataset.row = "0";
      th.dataset.col = String(colIdx);
      if (storedWidths[colIdx]) {
        th.style.width = `${storedWidths[colIdx]}px`;
      }

      const contentSpan = document.createElement("span");
      setupCellContent(view, contentSpan, cell.text);
      th.appendChild(contentSpan);

      const resizer = document.createElement("span");
      resizer.className = "k-table-col-resizer";
      resizer.dataset.resizeCol = String(colIdx);
      resizer.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = th.getBoundingClientRect().width || 120;
        const widthKey = this.table.firstLineKey;

        const onMouseMove = (moveEvent: MouseEvent) => {
          const nextWidth = Math.max(
            40,
            startWidth + (moveEvent.clientX - startX),
          );
          setTableColumnWidth(widthKey, colIdx, nextWidth);
          th.style.width = `${nextWidth}px`;
        };
        const onMouseUp = () => {
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);
        };
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      });
      th.appendChild(resizer);

      th.addEventListener("mousedown", (e) => {
        handleCellMouseDown(e, contentSpan);
      });
      th.addEventListener("click", handleCellClick);

      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    tableEl.appendChild(thead);

    // Body
    const tbody = document.createElement("tbody");
    let draggedBodyRowIdx: number | null = null;

    this.table.bodyRows.forEach((row, bodyRowIdx) => {
      const tr = document.createElement("tr");
      tr.className = "k-table-body-row";
      tr.dataset.bodyRow = String(bodyRowIdx);

      tr.addEventListener("dragover", (e) => {
        e.preventDefault();
      });
      tr.addEventListener("drop", (e) => {
        e.preventDefault();
        const rawFromIdx =
          draggedBodyRowIdx ??
          Number(e.dataTransfer?.getData(ROW_DRAG_TYPE) || -1);
        draggedBodyRowIdx = null;
        if (
          !Number.isNaN(rawFromIdx) &&
          rawFromIdx >= 0 &&
          rawFromIdx !== bodyRowIdx
        ) {
          let tableFrom: number;
          try {
            tableFrom = view.posAtDOM(wrapper);
          } catch {
            return;
          }
          reorderTableBodyRow(view, tableFrom, rawFromIdx, bodyRowIdx);
        }
      });

      row.cells.forEach((cell, colIdx) => {
        const td = document.createElement("td");
        const align = this.table.alignments[colIdx] ?? "left";
        td.style.textAlign = align;
        td.dataset.align = align;
        td.dataset.row = String(bodyRowIdx + 1);
        td.dataset.col = String(colIdx);
        if (storedWidths[colIdx]) {
          td.style.width = `${storedWidths[colIdx]}px`;
        }

        if (colIdx === 0) {
          const handle = document.createElement("button");
          handle.type = "button";
          handle.className = "k-table-row-handle";
          handle.draggable = true;
          handle.dataset.dragRow = String(bodyRowIdx);
          handle.setAttribute("aria-label", `Drag row ${bodyRowIdx + 1}`);
          const svgNs = "http://www.w3.org/2000/svg";
          const svg = document.createElementNS(svgNs, "svg");
          svg.setAttribute("class", "k-icon");
          svg.setAttribute("width", "12");
          svg.setAttribute("height", "12");
          svg.setAttribute("viewBox", "0 0 12 12");
          svg.setAttribute("aria-hidden", "true");
          const path = document.createElementNS(svgNs, "path");
          path.setAttribute("d", "M2 4h8M2 8h8");
          svg.appendChild(path);
          handle.appendChild(svg);

          handle.addEventListener("dragstart", (e) => {
            draggedBodyRowIdx = bodyRowIdx;
            e.dataTransfer?.setData(ROW_DRAG_TYPE, String(bodyRowIdx));
            e.dataTransfer?.setData("text/plain", String(bodyRowIdx));
          });
          handle.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          td.appendChild(handle);
        }

        const contentSpan = document.createElement("span");
        setupCellContent(view, contentSpan, cell.text);
        td.appendChild(contentSpan);

        td.addEventListener("mousedown", (e) => {
          handleCellMouseDown(e, contentSpan);
        });
        td.addEventListener("click", handleCellClick);

        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    tableEl.appendChild(tbody);
    wrapper.appendChild(tableEl);
    return wrapper;
  }

  destroy(dom: HTMLElement): void {
    const view = widgetViews.get(dom);
    if (view && focusedCellEl && dom.contains(focusedCellEl)) {
      focusedCellEl = null;
      refocusAfterDestroy(view);
    }
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export interface CachedTableEntry {
  from: number;
  to: number;
  /** The delimiter row: a cursor there means the table is being typed as source. */
  delimiterFrom: number;
  delimiterTo: number;
  widgetDecoration: Range<Decoration>;
}

export interface TableFieldState {
  tables: CachedTableEntry[];
  activeTableMask: boolean[];
  decorations: DecorationSet;
}

function scanTablesFromSyntaxTree(state: EditorState): CachedTableEntry[] {
  const tree = syntaxTree(state);
  const tables: CachedTableEntry[] = [];

  tree.iterate({
    from: 0,
    to: state.doc.length,
    enter: (nodeRef) => {
      if (nodeRef.name !== "Table") return;
      const { from, to } = nodeRef;
      if (from >= to) return false;

      const parsed = parseTableInRange(state, from, to);
      if (!parsed) return false;

      const rawSource = state.sliceDoc(parsed.from, parsed.to);
      const widgetDecoration = Decoration.replace({
        block: true,
        widget: new TableBlockWidget(parsed, rawSource),
      }).range(parsed.from, parsed.to);

      tables.push({
        from: parsed.from,
        to: parsed.to,
        delimiterFrom: parsed.delimiterRow.from,
        delimiterTo: parsed.delimiterRow.to,
        widgetDecoration,
      });
      return false;
    },
  });

  return tables;
}

function updateTableMaskAndDecorations(
  tables: CachedTableEntry[],
  selection: EditorSelection,
  prevFieldState?: TableFieldState,
): TableFieldState {
  // #59: tables always render as an editable grid, except while the cursor
  // is on the delimiter row (the table is still being typed as source).
  const head = selection.main.head;
  const mask = tables.map((t) => head >= t.delimiterFrom && head <= t.delimiterTo);

  if (
    prevFieldState &&
    prevFieldState.tables === tables &&
    prevFieldState.activeTableMask.length === mask.length &&
    mask.every((val, idx) => val === prevFieldState.activeTableMask[idx])
  ) {
    return prevFieldState;
  }

  const ranges: Array<Range<Decoration>> = [];
  for (let i = 0; i < tables.length; i++) {
    if (!mask[i]) {
      ranges.push(tables[i].widgetDecoration);
    }
  }

  return {
    tables,
    activeTableMask: mask,
    decorations: Decoration.set(ranges, true),
  };
}

export function buildTablePreviewDecorations(
  state: EditorState,
): DecorationSet {
  const tables = scanTablesFromSyntaxTree(state);
  return updateTableMaskAndDecorations(tables, state.selection).decorations;
}

interface ActiveTableRange {
  from: number;
  to: number;
  /** The table's source was changed while the cursor was inside it. */
  edited: boolean;
}

function tableRangeAtCursor(state: EditorState): { from: number; to: number } | null {
  const table = findTableAtPos(state, state.selection.main.head);
  return table ? { from: table.from, to: table.to } : null;
}

/**
 * BUG-6: re-align a table's source when the cursor leaves it after editing.
 *
 * - Only tables edited while active are formatted, so merely clicking into a
 *   table never changes an untouched file.
 * - The format is one transaction (one undo step) dispatched right after the
 *   update that moved the cursor out; it is postponed while an IME
 *   composition is in progress and runs on the first update after it ends.
 */
export const tableAutoFormatPlugin = ViewPlugin.fromClass(
  class {
    active: ActiveTableRange | null;
    pendingPos: number | null = null;
    scheduled = false;
    destroyed = false;

    constructor(view: EditorView) {
      const range = tableRangeAtCursor(view.state);
      this.active = range ? { ...range, edited: false } : null;
    }

    update(update: ViewUpdate): void {
      let prev = this.active;
      if (update.docChanged) {
        if (prev) {
          prev = {
            from: mapPosClamped(update.changes, prev.from, -1),
            to: mapPosClamped(update.changes, prev.to, 1),
            edited: prev.edited || update.changes.touchesRange(prev.from, prev.to) !== false,
          };
        }
        if (this.pendingPos !== null) {
          this.pendingPos = mapPosClamped(update.changes, this.pendingPos, -1);
        }
      }

      if (update.docChanged || update.selectionSet) {
        const cur = tableRangeAtCursor(update.state);
        if (prev && (!cur || cur.from !== prev.from)) {
          if (prev.edited) {
            this.pendingPos = prev.from;
          }
          prev = null;
        }
        this.active = cur
          ? { ...cur, edited: prev ? prev.edited : false }
          : null;
      } else {
        this.active = prev;
      }

      if (this.pendingPos !== null && !update.view.composing) {
        this.schedule(update.view);
      }
    }

    schedule(view: EditorView): void {
      if (this.scheduled) return;
      this.scheduled = true;
      // Dispatching inside update() is not allowed; run right after it.
      queueMicrotask(() => {
        this.scheduled = false;
        this.flush(view);
      });
    }

    flush(view: EditorView): void {
      if (this.destroyed || this.pendingPos === null) return;
      if (view.composing) return; // retried on the next update
      const pos = this.pendingPos;
      this.pendingPos = null;
      const { state } = view;
      if (pos > state.doc.length) return;
      const table = findTableAtPos(state, pos);
      if (!table) return;
      if (isSelectionTouchingRange(state.selection, table.from, table.to)) {
        // The cursor came back before we ran; keep tracking it as edited.
        this.active = { from: table.from, to: table.to, edited: true };
        return;
      }
      const formatted = formatParsedTable(table);
      if (formatted === state.sliceDoc(table.from, table.to)) return;
      view.dispatch({
        changes: { from: table.from, to: table.to, insert: formatted },
        userEvent: "input.table.format",
      });
    }

    destroy(): void {
      this.destroyed = true;
    }
  },
);

/**
 * #59: keyboard focus follows CM's selection into the grid. When the main
 * selection lands in a rendered cell (Tab, Enter, undo, Cmd+Opt+T, arrow keys
 * from the line above…) while the editor has focus, that cell is focused.
 * Selection changes made by a cell itself (tableCellSync) are skipped. The
 * cell holding the selection also gets `k-table-cell-active` (search hits).
 */
export const tableCellFocusPlugin = ViewPlugin.fromClass(
  class {
    activeTd: HTMLElement | null = null;
    scheduled = false;
    wantFocus = false;
    destroyed = false;

    constructor(readonly view: EditorView) {
      this.schedule(view.hasFocus);
    }

    update(update: ViewUpdate): void {
      if (!update.selectionSet && !update.docChanged && !update.focusChanged && !update.viewportChanged) {
        return;
      }
      const fromCell = update.transactions.some((tr) => tr.annotation(tableCellSync));
      const want =
        !fromCell &&
        (update.selectionSet || update.docChanged || (update.focusChanged && update.view.hasFocus));
      this.schedule(want);
    }

    schedule(wantFocus: boolean): void {
      this.wantFocus ||= wantFocus;
      if (this.scheduled) return;
      this.scheduled = true;
      // Runs after the DOM update of the current transaction.
      queueMicrotask(() => {
        this.scheduled = false;
        const want = this.wantFocus;
        this.wantFocus = false;
        if (!this.destroyed) this.apply(want);
      });
    }

    apply(wantFocus: boolean): void {
      const { view } = this;
      const active = getActiveTableCell(view.state);
      const el = active ? findCellElement(view, active.table.from, active.row, active.col) : null;
      const td = el?.closest<HTMLElement>("th, td") ?? null;
      if (td !== this.activeTd) {
        this.activeTd?.classList.remove("k-table-cell-active");
        td?.classList.add("k-table-cell-active");
        this.activeTd = td;
      }
      if (!wantFocus) return;
      const focused = view.dom.ownerDocument.activeElement;
      if (el && focused === el) return;
      const inCell =
        focused instanceof HTMLElement &&
        focused.classList.contains("k-table-cell-content") &&
        view.contentDOM.contains(focused);
      if (!view.hasFocus && !inCell) return;
      if (el) focusFromSelection(view);
      // The selection left the grid (setCursor, search, a command): typing
      // must follow it, so the editor takes focus back from the cell.
      else if (inCell) view.focus();
    }

    destroy(): void {
      this.destroyed = true;
      this.activeTd?.classList.remove("k-table-cell-active");
    }
  },
);

export const tablePreviewStateField = StateField.define<TableFieldState>({
  create(state) {
    const tables = scanTablesFromSyntaxTree(state);
    return updateTableMaskAndDecorations(tables, state.selection);
  },
  update(fieldState, tr) {
    if (
      tr.docChanged ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.reconfigured
    ) {
      const tables = scanTablesFromSyntaxTree(tr.state);
      return updateTableMaskAndDecorations(tables, tr.state.selection);
    }
    if (tr.selection) {
      return updateTableMaskAndDecorations(
        fieldState.tables,
        tr.state.selection,
        fieldState,
      );
    }
    return fieldState;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (s) => s.decorations),
    // Lives and dies with the table preview (source mode unloads both).
    tableAutoFormatPlugin,
    tableCellFocusPlugin,
  ],
});
