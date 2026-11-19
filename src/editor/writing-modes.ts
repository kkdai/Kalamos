/**
 * WM-01 Ataraxia (focus mode) and WM-02 Stichos (typewriter mode).
 *
 * Ataraxia dims everything except the current block: the top-level block
 * holding the main cursor (paragraph, heading, table, code block, blockquote…;
 * inside a list, the innermost list item). With a selection, every block the
 * selection touches stays undimmed. Lines are dimmed with line decorations
 * (visible ranges only); block widgets (tables, [TOC], diagrams…) replace
 * their lines, so their DOM gets the same class in a measure/write pass.
 *
 * Stichos keeps the cursor line vertically centred: keyboard / typing
 * transactions get a `scrollIntoView(…, { y: "center" })` effect. Pointer
 * selections and IME composition are left alone (recentred on compositionend).
 */
import "./writing-modes.css";

import { syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

export const FOCUS_DIM_CLASS = "k-focus-dim";

export interface LineSpan {
  /** Line start of the first line. */
  from: number;
  /** Line end of the last line. */
  to: number;
}

const LIST_NAMES = new Set(["BulletList", "OrderedList"]);

function lineSpan(state: EditorState, from: number, to: number): LineSpan {
  return {
    from: state.doc.lineAt(from).from,
    to: state.doc.lineAt(Math.min(to, state.doc.length)).to,
  };
}

/** Top-level block (child of Document) containing `pos`, or null on a blank line. */
function topLevelAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side);
    while (node && node.parent && node.parent.name !== "Document") node = node.parent;
    if (node && node.name !== "Document" && node.from <= pos && pos <= node.to) return node;
  }
  return null;
}

/** Innermost ListItem inside `list` containing `pos`. */
function listItemAt(list: SyntaxNode, pos: number): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  let node: SyntaxNode | null = list;
  while (node) {
    let next: SyntaxNode | null = null;
    for (let c: SyntaxNode | null = node.firstChild; c; c = c.nextSibling) {
      if (c.from <= pos && pos <= c.to && (c.name === "ListItem" || LIST_NAMES.has(c.name))) {
        next = c;
        if (c.name === "ListItem") found = c;
        break;
      }
    }
    node = next;
  }
  return found;
}

/** The block the cursor at `pos` belongs to, as whole lines. */
export function blockAt(state: EditorState, pos: number): LineSpan {
  const top = topLevelAt(state, pos);
  if (!top) return lineSpan(state, pos, pos);
  if (LIST_NAMES.has(top.name)) {
    const item = listItemAt(top, pos);
    if (item) {
      // The item's own lines: a nested list below the cursor is a separate block.
      let end = item.to;
      for (let c = item.firstChild; c; c = c.nextSibling) {
        if (LIST_NAMES.has(c.name) && c.from > pos) {
          end = Math.max(item.from, state.doc.lineAt(c.from).from - 1);
          break;
        }
      }
      return lineSpan(state, item.from, end);
    }
  }
  return lineSpan(state, top.from, top.to);
}

/** Line spans that stay undimmed: the current block(s) of every selection range. */
export function currentBlocks(state: EditorState): LineSpan[] {
  const spans: LineSpan[] = [];
  const tree = syntaxTree(state);
  for (const range of state.selection.ranges) {
    if (range.empty) {
      spans.push(blockAt(state, range.head));
      continue;
    }
    spans.push(blockAt(state, range.from), blockAt(state, range.to));
    spans.push(lineSpan(state, range.from, range.to));
    for (let n = tree.topNode.firstChild; n; n = n.nextSibling) {
      if (n.to < range.from) continue;
      if (n.from > range.to) break;
      spans.push(lineSpan(state, n.from, n.to));
    }
  }
  return mergeSpans(spans);
}

function mergeSpans(spans: LineSpan[]): LineSpan[] {
  const sorted = spans.slice().sort((a, b) => a.from - b.from);
  const out: LineSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

export function isInSpans(spans: readonly LineSpan[], pos: number): boolean {
  for (const s of spans) {
    if (pos < s.from) return false;
    if (pos <= s.to) return true;
  }
  return false;
}

/** Line starts (within `ranges`) that should be dimmed. */
export function dimmedLineStarts(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  current: readonly LineSpan[] = currentBlocks(state),
): number[] {
  const out: number[] = [];
  let last = -1;
  for (const r of ranges) {
    let pos = state.doc.lineAt(r.from).from;
    while (pos <= r.to && pos <= state.doc.length) {
      const line = state.doc.lineAt(pos);
      if (line.from > last && !isInSpans(current, line.from)) out.push(line.from);
      last = Math.max(last, line.from);
      if (line.to >= state.doc.length) break;
      pos = line.to + 1;
    }
  }
  return out;
}

const dimLine = Decoration.line({ class: FOCUS_DIM_CLASS });

export const focusModePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    current: LineSpan[] = [];
    isComposing = false;

    constructor(readonly view: EditorView) {
      this.rebuild();
    }

    rebuild(): void {
      const { view } = this;
      this.current = currentBlocks(view.state);
      const ranges = view.visibleRanges.length > 0 ? view.visibleRanges : [view.viewport];
      const decos: Array<Range<Decoration>> = dimmedLineStarts(view.state, ranges, this.current).map(
        (from) => dimLine.range(from),
      );
      this.decorations = Decoration.set(decos);
      this.scheduleWidgetPass();
    }

    /** Block widgets hide line decorations: give their DOM the class directly. */
    scheduleWidgetPass(): void {
      const { view } = this;
      view.requestMeasure({
        key: this,
        read: () => {
          const updates: Array<[Element, boolean]> = [];
          for (const el of Array.from(view.contentDOM.children)) {
            if (el.classList.contains("cm-line") || el.classList.contains("cm-widgetBuffer")) continue;
            let pos: number;
            try {
              pos = view.posAtDOM(el);
            } catch {
              continue;
            }
            updates.push([el, !isInSpans(this.current, view.state.doc.lineAt(pos).from)]);
          }
          return updates;
        },
        write: (updates) => {
          for (const [el, dim] of updates) el.classList.toggle(FOCUS_DIM_CLASS, dim);
        },
      });
    }

    update(update: ViewUpdate): void {
      if (this.isComposing || update.view.composing) {
        if (update.docChanged) this.decorations = this.decorations.map(update.changes);
        return;
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.rebuild();
      } else if (update.geometryChanged) {
        this.scheduleWidgetPass();
      }
    }

    destroy(): void {
      for (const el of Array.from(this.view.contentDOM.querySelectorAll(`.${FOCUS_DIM_CLASS}`))) {
        el.classList.remove(FOCUS_DIM_CLASS);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      compositionstart() {
        this.isComposing = true;
      },
      compositionend() {
        this.isComposing = false;
        queueMicrotask(() => {
          if (!this.isComposing && !this.view.composing) {
            this.rebuild();
            try {
              this.view.dispatch({});
            } catch {
              // view destroyed
            }
          }
        });
      },
    },
  },
);

export const focusModeExtension: Extension = [
  focusModePlugin,
  EditorView.editorAttributes.of({ class: "k-focus-mode" }),
];

// ---------------------------------------------------------------------------
// Stichos
// ---------------------------------------------------------------------------

/** Should this transaction re-centre the cursor line? */
export function wantsTypewriterScroll(tr: Transaction): boolean {
  if (!tr.docChanged && !tr.selection) return false;
  if (tr.isUserEvent("select.pointer") || tr.isUserEvent("input.type.compose")) return false;
  // Keyboard commands and typing ask CodeMirror to scroll the cursor into view.
  return tr.scrollIntoView;
}

const typewriterExtender = EditorState.transactionExtender.of((tr) => {
  if (!wantsTypewriterScroll(tr)) return null;
  return { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: "center" }) };
});

const typewriterCompositionEnd = EditorView.domEventHandlers({
  compositionend(_event, view) {
    queueMicrotask(() => {
      if (view.composing) return;
      try {
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }),
        });
      } catch {
        // view destroyed
      }
    });
    return false;
  },
});

export const typewriterModeExtension: Extension = [
  typewriterExtender,
  typewriterCompositionEnd,
  EditorView.editorAttributes.of({ class: "k-typewriter-mode" }),
];

export const FOCUS_MODE_MESSAGE = (on: boolean): string => `Ataraxia 專注模式：${on ? "開" : "關"}`;
export const TYPEWRITER_MODE_MESSAGE = (on: boolean): string =>
  `Stichos 打字機模式：${on ? "開" : "關"}`;
