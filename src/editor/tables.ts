import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type Range,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import {
  isSelectionTouchingRange,
  navigateMarkdownLink,
} from "./live-preview";

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
    isDelimiter: false,
  };

  const delimiterRow: ParsedTableRow = {
    lineNumber: lines[1].lineNumber,
    from: lines[1].from,
    to: lines[1].to,
    rawLineText: lines[1].text,
    cells: delimCells,
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

export function formatParsedTable(table: ParsedTable): string {
  return formatMarkdownTable(
    table.headerRow.cells.map((c) => c.text),
    table.delimiterStyles,
    table.bodyRows.map((r) => r.cells.map((c) => c.text)),
  );
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
  const headerCells = table.headerRow.cells.map((c) => c.text);
  const bodyRows = table.bodyRows.map((r) => r.cells.map((c) => c.text));
  const totalNavRows = 1 + bodyRows.length;

  let nextNavRowIdx = navRowIdx;
  let nextColIdx = colIdx + 1;
  if (nextColIdx >= table.colCount) {
    nextColIdx = 0;
    nextNavRowIdx = navRowIdx + 1;
    if (nextNavRowIdx >= totalNavRows) {
      bodyRows.push(Array.from({ length: table.colCount }, () => ""));
    }
  }

  return dispatchFormattedTableAndSelectCell(
    view,
    table,
    headerCells,
    table.delimiterStyles,
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
  const headerCells = table.headerRow.cells.map((c) => c.text);
  const bodyRows = table.bodyRows.map((r) => r.cells.map((c) => c.text));

  let prevNavRowIdx = navRowIdx;
  let prevColIdx = colIdx - 1;
  if (prevColIdx < 0) {
    if (navRowIdx > 0) {
      prevNavRowIdx = navRowIdx - 1;
      prevColIdx = table.colCount - 1;
    } else {
      prevNavRowIdx = 0;
      prevColIdx = 0;
    }
  }

  return dispatchFormattedTableAndSelectCell(
    view,
    table,
    headerCells,
    table.delimiterStyles,
    bodyRows,
    prevNavRowIdx,
    prevColIdx,
  );
}

export function handleTableEnter(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const table = findTableAtPos(state, pos);
  if (!table) return false;

  const { navRowIdx } = locateCursorCellInTable(table, pos);
  const headerCells = table.headerRow.cells.map((c) => c.text);
  const bodyRows = table.bodyRows.map((r) => r.cells.map((c) => c.text));

  const insertBodyIndex = Math.max(0, navRowIdx);
  bodyRows.splice(
    insertBodyIndex,
    0,
    Array.from({ length: table.colCount }, () => ""),
  );

  return dispatchFormattedTableAndSelectCell(
    view,
    table,
    headerCells,
    table.delimiterStyles,
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

  const headerCells = table.headerRow.cells.map((c) => c.text);
  const bodyRows = table.bodyRows.map((r) => r.cells.map((c) => c.text));
  const [moved] = bodyRows.splice(fromBodyRowIndex, 1);
  bodyRows.splice(toBodyRowIndex, 0, moved);

  const formatted = formatMarkdownTable(
    headerCells,
    table.delimiterStyles,
    bodyRows,
  );

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

export function renderCellInlineMarkdownToFragment(
  rawCellText: string,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const text = unescapeTableCellText(rawCellText);
  if (!text) return fragment;

  const tree = markdownLanguage.parser.parse(text);
  renderLezerChildrenToDom(tree.topNode, text, 0, text.length, fragment);
  return fragment;
}

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

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "k-table-wrapper";

    const tableEl = document.createElement("table");
    tableEl.className = "k-table";
    tableEl.setAttribute("data-testid", "table-widget");

    const storedWidths =
      tableColumnWidthsMap.get(this.table.firstLineKey) ?? [];

    const handleCellClick = (event: MouseEvent, cell: ParsedTableCell) => {
      const targetEl = event.target as HTMLElement | null;
      if (
        targetEl?.closest(".k-table-col-resizer") ||
        targetEl?.closest(".k-table-row-handle")
      ) {
        return;
      }
      const linkSpan = targetEl?.closest<HTMLElement>(".k-link[data-href]");
      if (linkSpan && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        const href = linkSpan.dataset.href ?? "";
        navigateMarkdownLink(href, view);
        return;
      }
      event.preventDefault();
      view.dispatch({
        selection: EditorSelection.range(cell.contentFrom, cell.contentTo),
        scrollIntoView: true,
      });
      view.focus();
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
      contentSpan.className = "k-table-cell-content";
      contentSpan.appendChild(renderCellInlineMarkdownToFragment(cell.text));
      th.appendChild(contentSpan);

      const resizer = document.createElement("span");
      resizer.className = "k-table-col-resizer";
      resizer.dataset.resizeCol = String(colIdx);
      resizer.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = th.getBoundingClientRect().width || 120;

        const onMouseMove = (moveEvent: MouseEvent) => {
          const nextWidth = Math.max(
            40,
            startWidth + (moveEvent.clientX - startX),
          );
          setTableColumnWidth(this.table.firstLineKey, colIdx, nextWidth);
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

      th.addEventListener("click", (e) => {
        handleCellClick(e, cell);
      });

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
          Number(e.dataTransfer?.getData("text/plain") ?? -1);
        draggedBodyRowIdx = null;
        if (
          !Number.isNaN(rawFromIdx) &&
          rawFromIdx >= 0 &&
          rawFromIdx !== bodyRowIdx
        ) {
          reorderTableBodyRow(view, this.table.from, rawFromIdx, bodyRowIdx);
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
            e.dataTransfer?.setData("text/plain", String(bodyRowIdx));
          });
          handle.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          td.appendChild(handle);
        }

        const contentSpan = document.createElement("span");
        contentSpan.className = "k-table-cell-content";
        contentSpan.appendChild(renderCellInlineMarkdownToFragment(cell.text));
        td.appendChild(contentSpan);

        td.addEventListener("click", (e) => {
          handleCellClick(e, cell);
        });

        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    tableEl.appendChild(tbody);
    wrapper.appendChild(tableEl);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export interface CachedTableEntry {
  from: number;
  to: number;
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
  const mask = tables.map((t) =>
    isSelectionTouchingRange(selection, t.from, t.to),
  );

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
  provide: (f) => EditorView.decorations.from(f, (s) => s.decorations),
});
