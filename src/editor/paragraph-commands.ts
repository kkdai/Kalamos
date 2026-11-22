import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * #74 段落 menu commands that had no shortcut before: heading level,
 * blockquote, code / math block. Table rows are left alone (a heading or a
 * quote marker would break the table).
 */

const HEADING_RE = /^(\s{0,3})(#{1,6})(?:[ \t]+|$)/;
const QUOTE_RE = /^(\s{0,3})>[ \t]?/;

function isTableRow(text: string): boolean {
  return /^\s*\|/.test(text);
}

function selectedLines(view: EditorView) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  const lines = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
  return lines;
}

/** Sets the heading level of the selected lines (0 = plain paragraph); the same level again toggles it off. */
export function setHeadingLevel(view: EditorView, level: number): boolean {
  const lines = selectedLines(view);
  if (lines.some((l) => isTableRow(l.text))) return false;
  const target = Math.max(0, Math.min(6, Math.floor(level)));
  const allAtTarget =
    target > 0 &&
    lines.every((l) => {
      const m = HEADING_RE.exec(l.text);
      return m !== null && m[2].length === target;
    });
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const line of lines) {
    const m = HEADING_RE.exec(line.text);
    const content = m
      ? line.text.slice(m[0].length)
      : line.text.replace(/^\s{0,3}/, "");
    const prefix = allAtTarget || target === 0 ? "" : `${"#".repeat(target)} `;
    const insert = `${prefix}${content}`;
    if (insert !== line.text)
      changes.push({ from: line.from, to: line.to, insert });
  }
  if (changes.length === 0) return true;
  const changeSet = view.state.changes(changes);
  const lastLine = lines[lines.length - 1];
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(lastLine.to, 1)),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/** Adds `> ` to the selected lines, or removes it when every line is already quoted. */
export function toggleBlockquote(view: EditorView): boolean {
  const lines = selectedLines(view);
  if (lines.some((l) => isTableRow(l.text))) return false;
  const quotes = lines.map((line) => QUOTE_RE.exec(line.text));
  const allQuoted = quotes.every((match) => match !== null);
  const changes = lines.map((line, index) => {
    const m = quotes[index];
    if (allQuoted && m) {
      return { from: line.from, to: line.from + m[0].length, insert: m[1] };
    }
    return { from: line.from, insert: "> " };
  });
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.cursor(
      changeSet.mapPos(lines[lines.length - 1].to, 1),
    ),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

function insertFencedBlock(
  view: EditorView,
  open: string,
  close: string,
): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  if (isTableRow(startLine.text)) return false;
  const selected =
    from === to ? "" : state.sliceDoc(startLine.from, endLine.to);
  const body = selected || (startLine.text.trim() === "" ? "" : null);
  if (body !== null) {
    // Wrap the selected lines (or fill the empty line) with the fence.
    const insert = `${open}\n${body}\n${close}`;
    view.dispatch({
      changes: { from: startLine.from, to: endLine.to, insert },
      selection: EditorSelection.cursor(
        startLine.from + open.length + 1 + body.length,
      ),
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  }
  // Cursor on a non-empty line: open a new block below it.
  const insert = `\n${open}\n\n${close}`;
  view.dispatch({
    changes: { from: endLine.to, insert },
    selection: EditorSelection.cursor(endLine.to + 1 + open.length + 1),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

export function insertCodeBlock(view: EditorView): boolean {
  return insertFencedBlock(view, "```", "```");
}

export function insertMathBlock(view: EditorView): boolean {
  return insertFencedBlock(view, "$$", "$$");
}
