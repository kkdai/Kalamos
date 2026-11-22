import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
} from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";

const continueMarkupNoBlank = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

const LIST_MARKER_COL_RE = /^(\s*)((?:[-+*]|\d+[.)])\s+)/;
const EMPTY_LIST_LINE_RE = /^(\s*)(?:[-+*]|\d+[.)])(?:\s+\[[ xX]\])?\s*$/;

type ListLineKind = "plain" | "bullet" | "ordered" | "task";

interface ParsedListLine {
  kind: ListLineKind;
  indent: string;
  content: string;
  checked: boolean;
}

export function parseListLine(lineText: string): ParsedListLine {
  const taskMatch = /^(\s*)(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s*(.*)$/.exec(
    lineText,
  );
  if (taskMatch) {
    return {
      kind: "task",
      indent: taskMatch[1],
      checked: taskMatch[2].toLowerCase() === "x",
      content: taskMatch[3],
    };
  }

  const orderedMatch = /^(\s*)\d+[.)]\s+(.*)$/.exec(lineText);
  if (orderedMatch) {
    return {
      kind: "ordered",
      indent: orderedMatch[1],
      checked: false,
      content: orderedMatch[2],
    };
  }

  const bulletMatch = /^(\s*)[-+*]\s+(.*)$/.exec(lineText);
  if (bulletMatch) {
    return {
      kind: "bullet",
      indent: bulletMatch[1],
      checked: false,
      content: bulletMatch[2],
    };
  }

  const plainMatch = /^(\s*)(.*)$/.exec(lineText);
  return {
    kind: "plain",
    indent: plainMatch ? plainMatch[1] : "",
    checked: false,
    content: plainMatch ? plainMatch[2] : lineText,
  };
}

/** A line holding only blockquote markers (`>`, `> >`, `> `…). */
const EMPTY_QUOTE_LINE_RE = /^(?:[ \t]{0,3}>[ \t]?)+[ \t]*$/;
/** Marker prefix of a list item line: indent, marker, spaces, optional task box. */
const LIST_ITEM_PREFIX_RE = /^([ \t]*)((?:[-+*]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?)(?:[ \t]+|$)/;

function isBlank(text: string): boolean {
  return text.trim() === "";
}

/** Is `pos` inside code (where list / quote syntax is plain text)? */
function isInCode(state: EditorState, pos: number): boolean {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "CodeText") return true;
  }
  return false;
}

/**
 * Leave the list / quote: the empty marker line becomes the blank line that
 * separates the block from what follows, and the cursor goes to a fresh line
 * after it (so the new paragraph is not a lazy continuation of the block,
 * nor glued to a following paragraph when there is one).
 */
function endBlockAtLine(view: EditorView, lineNumber: number): void {
  const { state } = view;
  const line = state.doc.line(lineNumber);
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: state.lineBreak },
    selection: EditorSelection.cursor(line.from + state.lineBreak.length),
    scrollIntoView: true,
    userEvent: "input",
  });
}

/**
 * Enter in lists and blockquotes (Typora behaviour):
 * - non-empty item / quote line: continue the markup (CodeMirror);
 * - empty nested list item: move it out one level;
 * - empty top-level item or empty `>` line: end the list / quote, leaving a
 *   blank line; a nested empty `> >` line drops one quote level.
 */
export function handleListEnter(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.length === 1 && state.selection.main.empty) {
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    if (!isInCode(state, line.from)) {
      if (EMPTY_QUOTE_LINE_RE.test(line.text)) {
        const depth = (line.text.match(/>/g) ?? []).length;
        if (depth > 1) {
          const outer = "> ".repeat(depth - 1);
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: outer },
            selection: EditorSelection.cursor(line.from + outer.length),
            userEvent: "input",
          });
        } else {
          endBlockAtLine(view, line.number);
        }
        return true;
      }
      if (EMPTY_LIST_LINE_RE.test(line.text)) {
        const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
        if (indent.length > 0 && outdentListItem(view)) return true;
        endBlockAtLine(view, line.number);
        return true;
      }
    }
  }

  return continueMarkupNoBlank({
    state,
    dispatch: (tr) => view.dispatch(tr),
  });
}

/**
 * Backspace right after a list item's marker (`- |text`, `1. |text`,
 * `- [ ] |text`) turns the item into a plain paragraph (Typora behaviour):
 * the marker goes, the indentation stays (a nested item becomes a paragraph
 * of its parent item) and blank lines are added around it where needed so
 * it is not read as a lazy continuation of the neighbouring lines.
 * Everything else falls back to CodeMirror's `deleteMarkupBackward`.
 */
export function handleListBackspace(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.length === 1 && state.selection.main.empty) {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const m = LIST_ITEM_PREFIX_RE.exec(line.text);
    if (m && head === line.from + m[0].length && head > line.from && !isInCode(state, line.from)) {
      const indent = m[1];
      const content = line.text.slice(m[0].length);
      const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
      const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
      const br = state.lineBreak;
      const blankBefore = !isBlank(content) && prev !== null && !isBlank(prev.text) ? br : "";
      const blankAfter = !isBlank(content) && next !== null && !isBlank(next.text) ? br : "";
      const changes = [{ from: line.from, to: head, insert: blankBefore + indent }];
      if (blankAfter) changes.push({ from: line.to, to: line.to, insert: blankAfter });
      view.dispatch({
        changes,
        selection: EditorSelection.cursor(line.from + blankBefore.length + indent.length),
        scrollIntoView: true,
        userEvent: "delete.backward",
      });
      return true;
    }
  }
  return deleteMarkupBackward({
    state: view.state,
    dispatch: (tr) => view.dispatch(tr),
  });
}

export function indentListItem(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);

  const changes: Array<{ from: number; to: number; insert: string }> = [];

  for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo++) {
    const line = state.doc.line(lineNo);
    const match = LIST_MARKER_COL_RE.exec(line.text);
    if (!match) continue;

    const currentIndent = match[1].length;
    const ownMarkerWidth = match[2].length;
    let targetIndent = currentIndent + ownMarkerWidth;

    for (let prevNo = lineNo - 1; prevNo >= 1; prevNo--) {
      const prevLine = state.doc.line(prevNo);
      if (!prevLine.text.trim()) break;
      const prevMatch = LIST_MARKER_COL_RE.exec(prevLine.text);
      if (!prevMatch) continue;

      const prevIndent = prevMatch[1].length;
      const prevContentCol = prevIndent + prevMatch[2].length;
      if (prevIndent === currentIndent) {
        targetIndent = prevContentCol;
        break;
      }
      if (prevIndent < currentIndent) {
        targetIndent =
          prevContentCol > currentIndent
            ? prevContentCol
            : currentIndent + ownMarkerWidth;
        break;
      }
    }

    const spacesToAdd = Math.max(1, targetIndent - currentIndent);
    changes.push({
      from: line.from,
      to: line.from,
      insert: " ".repeat(spacesToAdd),
    });
  }

  if (changes.length === 0) return false;

  view.dispatch(
    state.update({
      changes,
      scrollIntoView: true,
      userEvent: "indent",
    }),
  );
  return true;
}

export function outdentListItem(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);

  let anyListLine = false;
  const changes: Array<{ from: number; to: number; insert: string }> = [];

  for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo++) {
    const line = state.doc.line(lineNo);
    const match = LIST_MARKER_COL_RE.exec(line.text);
    if (!match) continue;
    anyListLine = true;

    const currentIndent = match[1].length;
    if (currentIndent === 0) continue;

    let targetIndent = 0;
    for (let prevNo = lineNo - 1; prevNo >= 1; prevNo--) {
      const prevLine = state.doc.line(prevNo);
      if (!prevLine.text.trim()) break;
      const prevMatch = LIST_MARKER_COL_RE.exec(prevLine.text);
      if (!prevMatch) continue;
      const prevIndent = prevMatch[1].length;
      if (prevIndent < currentIndent) {
        targetIndent = prevIndent;
        break;
      }
    }

    const removeCount = currentIndent - targetIndent;
    if (removeCount > 0) {
      changes.push({
        from: line.from,
        to: line.from + removeCount,
        insert: "",
      });
    }
  }

  if (!anyListLine) return false;
  if (changes.length > 0) {
    view.dispatch(
      state.update({
        changes,
        scrollIntoView: true,
        userEvent: "delete.dedent",
      }),
    );
  }
  return true;
}

function switchLinesToListKind(
  view: EditorView,
  targetKind: "ordered" | "bullet" | "task",
): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);

  const parsedLines: Array<{
    line: ReturnType<typeof state.doc.line>;
    parsed: ParsedListLine;
  }> = [];
  for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo++) {
    const line = state.doc.line(lineNo);
    parsedLines.push({ line, parsed: parseListLine(line.text) });
  }

  const allAlreadyTarget = parsedLines.every(
    ({ parsed }) => parsed.kind === targetKind,
  );

  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let orderedCounter = 1;
  if (targetKind === "ordered" && !allAlreadyTarget && startLine.number > 1) {
    const prevText = state.doc.line(startLine.number - 1).text;
    const prevOrd = /^(\s*)(\d+)[.)]\s+/.exec(prevText);
    if (prevOrd && prevOrd[1] === parsedLines[0].parsed.indent) {
      orderedCounter = Number(prevOrd[2]) + 1;
    }
  }

  let lastCursorPos = state.selection.main.head;

  for (const { line, parsed } of parsedLines) {
    let replacement: string;
    if (allAlreadyTarget) {
      replacement = `${parsed.indent}${parsed.content}`;
    } else if (targetKind === "ordered") {
      replacement = `${parsed.indent}${orderedCounter++}. ${parsed.content}`;
    } else if (targetKind === "bullet") {
      replacement = `${parsed.indent}- ${parsed.content}`;
    } else {
      replacement = `${parsed.indent}- [ ] ${parsed.content}`;
    }
    changes.push({ from: line.from, to: line.to, insert: replacement });
    lastCursorPos = line.from + replacement.length;
  }

  view.dispatch({
    changes,
    selection: EditorSelection.cursor(lastCursorPos),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

export function toggleOrderedList(view: EditorView): boolean {
  return switchLinesToListKind(view, "ordered");
}

export function toggleBulletList(view: EditorView): boolean {
  return switchLinesToListKind(view, "bullet");
}

export function toggleTaskList(view: EditorView): boolean {
  return switchLinesToListKind(view, "task");
}

export function toggleTaskMarkerAt(
  view: EditorView,
  from: number,
  to: number,
): boolean {
  const { state } = view;
  if (from < 0 || to > state.doc.length || to - from !== 3) return false;
  const current = state.sliceDoc(from, to);
  if (!/^\[[ xX]\]$/.test(current)) return false;

  const replacement = /^\[[xX]\]$/.test(current) ? "[ ]" : "[x]";
  view.dispatch({
    changes: { from, to, insert: replacement },
    userEvent: "input.toggleTask",
  });
  return true;
}

function locateTaskMarkerRangeFromDom(
  view: EditorView,
  domNode: HTMLElement,
): { from: number; to: number } | null {
  let domPos: number;
  try {
    domPos = view.posAtDOM(domNode);
  } catch {
    return null;
  }

  const { state } = view;
  if (
    domPos >= 0 &&
    domPos + 3 <= state.doc.length &&
    /^\[[ xX]\]$/.test(state.sliceDoc(domPos, domPos + 3))
  ) {
    return { from: domPos, to: domPos + 3 };
  }
  if (
    domPos >= 3 &&
    domPos <= state.doc.length &&
    /^\[[ xX]\]$/.test(state.sliceDoc(domPos - 3, domPos))
  ) {
    return { from: domPos - 3, to: domPos };
  }

  const line = state.doc.lineAt(Math.max(0, Math.min(domPos, state.doc.length)));
  const match = /^(\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/.exec(line.text);
  if (!match) return null;
  const from = line.from + match[1].length;
  const to = from + 3;
  if (/^\[[ xX]\]$/.test(state.sliceDoc(from, to))) {
    return { from, to };
  }
  return null;
}

export class BulletMarkerWidget extends WidgetType {
  constructor(readonly bulletChar = "•") {
    super();
  }

  eq(other: BulletMarkerWidget): boolean {
    return this.bulletChar === other.bulletChar;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "k-list-marker k-bullet-marker";
    span.textContent = this.bulletChar;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

export class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return this.checked === other.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "k-task-checkbox";
    input.checked = this.checked;
    input.dataset.checked = this.checked ? "true" : "false";
    input.setAttribute(
      "aria-label",
      this.checked ? "Completed task" : "Incomplete task",
    );
    input.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    input.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const range = locateTaskMarkerRangeFromDom(view, input);
      if (range) {
        toggleTaskMarkerAt(view, range.from, range.to);
      }
    });
    return input;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export interface HeadingEntry {
  level: number;
  text: string;
  slug: string;
  from: number;
  to: number;
  contentFrom: number;
  lineNumber: number;
  endLineNumber: number;
}

export function slugifyHeadingText(rawText: string): string {
  return rawText
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const HEADING_NODE_LEVELS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

const STRIPPED_HEADING_MARK_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
]);

function extractHeadingCleanText(
  state: EditorState,
  headingNode: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>,
  isSetext: boolean,
): { text: string; contentFrom: number } {
  const excludedRanges: Array<{ from: number; to: number }> = [];
  let contentFrom = headingNode.from;
  let contentTo = headingNode.to;

  const headerMarks = headingNode.getChildren("HeaderMark");
  if (isSetext) {
    if (headerMarks.length > 0) {
      const underlineMark = headerMarks[headerMarks.length - 1];
      const underlineLine = state.doc.lineAt(underlineMark.from);
      contentTo = Math.max(
        headingNode.from,
        underlineLine.from > 0 ? underlineLine.from - 1 : underlineLine.from,
      );
    }
  } else if (headerMarks.length > 0) {
    const openMark = headerMarks[0];
    contentFrom = openMark.to;
    while (
      contentFrom < headingNode.to &&
      (state.sliceDoc(contentFrom, contentFrom + 1) === " " ||
        state.sliceDoc(contentFrom, contentFrom + 1) === "\t")
    ) {
      contentFrom++;
    }
    if (headerMarks.length > 1) {
      const closeMark = headerMarks[headerMarks.length - 1];
      if (closeMark.from >= contentFrom) {
        contentTo = closeMark.from;
      }
    }
  }

  headingNode.toTree().iterate({
    enter: (child) => {
      const absFrom = headingNode.from + child.from;
      const absTo = headingNode.from + child.to;
      if (absTo <= contentFrom || absFrom >= contentTo) return;
      if (STRIPPED_HEADING_MARK_NODES.has(child.name)) {
        excludedRanges.push({
          from: Math.max(contentFrom, absFrom),
          to: Math.min(contentTo, absTo),
        });
      }
    },
  });

  excludedRanges.sort((a, b) => a.from - b.from);
  let text = "";
  let cursor = contentFrom;
  for (const ex of excludedRanges) {
    if (ex.from > cursor) {
      text += state.sliceDoc(cursor, ex.from);
    }
    cursor = Math.max(cursor, ex.to);
  }
  if (cursor < contentTo) {
    text += state.sliceDoc(cursor, contentTo);
  }

  return { text: text.trim(), contentFrom };
}

export function collectDocumentHeadings(state: EditorState): HeadingEntry[] {
  const tree =
    ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state);
  const headings: HeadingEntry[] = [];
  const slugCounts = new Map<string, number>();

  tree.iterate({
    from: 0,
    to: state.doc.length,
    enter: (nodeRef) => {
      const level = HEADING_NODE_LEVELS[nodeRef.name];
      if (level === undefined) return;

      const isSetext = nodeRef.name.startsWith("SetextHeading");
      const { text, contentFrom } = extractHeadingCleanText(
        state,
        nodeRef.node,
        isSetext,
      );
      const baseSlug = slugifyHeadingText(text);
      const seen = slugCounts.get(baseSlug) ?? 0;
      slugCounts.set(baseSlug, seen + 1);
      const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;

      const startLine = state.doc.lineAt(nodeRef.from);
      const endLine = state.doc.lineAt(nodeRef.to);

      headings.push({
        level,
        text,
        slug,
        from: nodeRef.from,
        to: nodeRef.to,
        contentFrom,
        lineNumber: startLine.number,
        endLineNumber: endLine.number,
      });
      return false;
    },
  });

  return headings;
}

function normalizeTargetSlug(rawFragment: string): string {
  const clean = rawFragment.startsWith("#")
    ? rawFragment.slice(1)
    : rawFragment;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  return decoded.trim().toLowerCase();
}

export function jumpToHeadingSlug(
  view: EditorView,
  rawSlug: string,
): boolean {
  const target = normalizeTargetSlug(rawSlug);
  if (!target) return false;

  const headings = collectDocumentHeadings(view.state);
  const match =
    headings.find((h) => h.slug === target) ??
    headings.find((h) => h.slug === slugifyHeadingText(target));
  if (!match) return false;

  view.dispatch({
    selection: EditorSelection.cursor(match.contentFrom),
    effects: EditorView.scrollIntoView(match.from, { y: "start" }),
  });
  return true;
}

let lastCopiedBookmark: string | null = null;

export function getLastCopiedBookmark(): string | null {
  return lastCopiedBookmark;
}

export function copyHeadingBookmark(view: EditorView): string | null {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const headings = collectDocumentHeadings(view.state);
  const heading = headings.find(
    (h) => line.number >= h.lineNumber && line.number <= h.endLineNumber,
  );
  if (!heading) return null;

  const bookmark = `[${heading.text}](#${heading.slug})`;
  lastCopiedBookmark = bookmark;
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    void navigator.clipboard.writeText(bookmark).catch(() => null);
  }
  return bookmark;
}

export interface RelativeMarkdownTarget {
  pathPart: string;
  slugPart: string | null;
}

function unwrapAngleBracketsAndDecodePath(rawPath: string): string {
  let clean = rawPath.trim();
  if (clean.startsWith("<") && clean.endsWith(">")) {
    clean = clean.slice(1, -1).trim();
  }
  const queryIndex = clean.indexOf("?");
  if (queryIndex >= 0) {
    clean = clean.slice(0, queryIndex);
  }
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

export function parseRelativeMarkdownLink(
  rawUrl: string,
): RelativeMarkdownTarget | null {
  let trimmed = rawUrl.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed || trimmed.startsWith("#")) return null;
  // Reject any URL with an explicit scheme (e.g. http:, https:, mailto:, javascript:, file:)
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null;

  const hashIndex = trimmed.indexOf("#");
  const beforeHash =
    hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const slugPart =
    hashIndex >= 0 && hashIndex + 1 < trimmed.length
      ? trimmed.slice(hashIndex + 1)
      : null;

  const pathPart = unwrapAngleBracketsAndDecodePath(beforeHash);
  if (!/\.(?:md|markdown)$/i.test(pathPart)) {
    return null;
  }
  return { pathPart, slugPart };
}

export function resolveRelativeMarkdownPath(
  currentFilePath: string,
  relativeLinkPath: string,
): string {
  const normalizedCurrent = currentFilePath.replace(/\\/g, "/");
  let cleanedRel = relativeLinkPath.trim();
  if (cleanedRel.startsWith("<") && cleanedRel.endsWith(">")) {
    cleanedRel = cleanedRel.slice(1, -1).trim();
  }
  const hashIdx = cleanedRel.indexOf("#");
  if (hashIdx >= 0) {
    cleanedRel = cleanedRel.slice(0, hashIdx);
  }
  const decodedRel = unwrapAngleBracketsAndDecodePath(cleanedRel).replace(
    /\\/g,
    "/",
  );

  if (decodedRel.startsWith("/")) {
    return decodedRel;
  }

  const lastSlash = normalizedCurrent.lastIndexOf("/");
  const baseDir =
    lastSlash >= 0 ? normalizedCurrent.slice(0, lastSlash) : "";
  const drive = /^[A-Za-z]:\//.exec(normalizedCurrent);
  const root = drive ? drive[0] : normalizedCurrent.startsWith("/") ? "/" : "";
  const segments = baseDir
    .slice(root.length)
    .split("/")
    .filter((s) => s.length > 0);

  for (const part of decodedRel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  return `${root}${segments.join("/")}`;
}
