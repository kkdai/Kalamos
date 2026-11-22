/**
 * ED-06 / ED-07 live preview: blockquotes, horizontal rules, YAML front
 * matter, footnotes (hover tooltip + click to jump) and `[TOC]`.
 *
 * Same rules as live-preview.ts: the document text is never rewritten,
 * line / inline decorations are built for the visible ranges only, nothing is
 * recomputed during IME composition, and the source is revealed while the
 * cursor is inside a construct. Block widgets (`[TOC]`) come from a
 * StateField because CodeMirror only accepts block decorations from fields.
 */
import "./blocks.css";

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import {
  type FootnoteIndex,
  footnoteDefinitionText,
  footnoteIdOf,
  footnoteIndexOfState,
} from "./footnotes";
import { collectDocumentHeadings, jumpToHeadingSlug } from "./lists";
import { isSelectionTouchingRange } from "./live-preview";
import { mapPosClamped } from "./positions";

/** Re-run block decorations after an IME composition ended. */
export const blocksRefreshEffect = StateEffect.define<null>();

function lineSpanText(state: EditorState, from: number, to: number): string {
  const start = state.doc.lineAt(Math.min(from, state.doc.length)).from;
  const end = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  return state.sliceDoc(start, end);
}

function changeTouches(tr: Transaction, re: RegExp): boolean {
  let hit = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (hit) return;
    if (
      re.test(lineSpanText(tr.startState, fromA, toA)) ||
      re.test(lineSpanText(tr.state, fromB, toB))
    ) {
      hit = true;
    }
  });
  return hit;
}

function isCompose(tr: Transaction): boolean {
  return tr.isUserEvent("input.type.compose");
}

// ---------------------------------------------------------------------------
// Footnote index (numbering by first reference, definitions)
// ---------------------------------------------------------------------------

interface FootnoteFieldValue {
  index: FootnoteIndex;
  parsedTo: number;
  dirty: boolean;
}

function computeFootnotes(state: EditorState): FootnoteFieldValue {
  const tree = syntaxTree(state);
  return {
    index: footnoteIndexOfState(state, tree),
    parsedTo: tree.length,
    dirty: false,
  };
}

function mapFootnoteIndex(
  index: FootnoteIndex,
  tr: Transaction,
): FootnoteIndex {
  const definitions = new Map(index.definitions);
  for (const [id, d] of definitions) {
    definitions.set(id, {
      id,
      from: mapPosClamped(tr.changes, d.from, -1),
      to: mapPosClamped(tr.changes, d.to, 1),
      contentFrom: mapPosClamped(tr.changes, d.contentFrom, 1),
    });
  }
  return { ...index, definitions };
}

const FOOTNOTE_TEXT_RE = /\[\^/;

export const footnoteIndexField = StateField.define<FootnoteFieldValue>({
  create: computeFootnotes,
  update(value, tr) {
    if (isCompose(tr)) {
      return {
        index: mapFootnoteIndex(value.index, tr),
        // Mapped, not copied: a copied position can fall outside the next
        // (shorter) document and make mapPos throw (#56).
        parsedTo: mapPosClamped(tr.changes, value.parsedTo, 1),
        dirty: value.dirty || changeTouches(tr, FOOTNOTE_TEXT_RE),
      };
    }
    const grown =
      syntaxTree(tr.state).length >
      mapPosClamped(tr.changes, value.parsedTo, 1);
    if (
      value.dirty ||
      grown ||
      tr.reconfigured ||
      (tr.docChanged && changeTouches(tr, FOOTNOTE_TEXT_RE))
    ) {
      return computeFootnotes(tr.state);
    }
    if (!tr.docChanged) return value;
    return {
      index: mapFootnoteIndex(value.index, tr),
      parsedTo: mapPosClamped(tr.changes, value.parsedTo, 1),
      dirty: false,
    };
  },
});

function footnoteIndex(state: EditorState): FootnoteIndex | null {
  return state.field(footnoteIndexField, false)?.index ?? null;
}

function jumpToFootnoteDefinition(view: EditorView, id: string): boolean {
  const def = footnoteIndex(view.state)?.definitions.get(id);
  if (!def) return false;
  view.dispatch({
    selection: { anchor: Math.min(def.contentFrom, view.state.doc.length) },
    effects: EditorView.scrollIntoView(def.from, { y: "center" }),
  });
  view.focus();
  return true;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

export class HorizontalRuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "k-hr";
    el.setAttribute("aria-hidden", "true");
    el.dataset.testid = "hr";
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class FootnoteRefWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly number: number,
  ) {
    super();
  }

  eq(other: FootnoteRefWidget): boolean {
    return other.id === this.id && other.number === this.number;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("sup");
    el.className = "k-footnote-ref";
    el.textContent = String(this.number);
    el.dataset.footnoteId = this.id;
    el.dataset.testid = "footnote-ref";
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      jumpToFootnoteDefinition(view, this.id);
    });
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export interface TocEntry {
  level: number;
  text: string;
  slug: string;
}

interface TocNode extends TocEntry {
  children: TocNode[];
}

/** Nest headings by level (a skipped level nests under the nearest shallower heading). */
export function nestTocEntries(entries: readonly TocEntry[]): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const entry of entries) {
    const node: TocNode = { ...entry, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= entry.level)
      stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

export class TocWidget extends WidgetType {
  readonly key: string;

  constructor(readonly entries: readonly TocEntry[]) {
    super();
    this.key = entries
      .map((e) => `${e.level}\u0000${e.slug}\u0000${e.text}`)
      .join("\u0001");
  }

  eq(other: TocWidget): boolean {
    return other.key === this.key;
  }

  toDOM(view: EditorView): HTMLElement {
    const nav = document.createElement("nav");
    nav.className = "k-toc";
    nav.dataset.testid = "toc";
    nav.setAttribute("aria-label", "目錄");
    if (this.entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "k-toc-empty";
      empty.textContent = "目錄（尚無標題）";
      nav.appendChild(empty);
      return nav;
    }
    const build = (nodes: TocNode[]): HTMLUListElement => {
      const ul = document.createElement("ul");
      for (const node of nodes) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.className = `k-toc-link k-toc-h${node.level}`;
        a.textContent = node.text;
        a.href = `#${node.slug}`;
        a.dataset.slug = node.slug;
        a.addEventListener("mousedown", (event) => {
          event.preventDefault();
          jumpToHeadingSlug(view, node.slug);
          view.focus();
        });
        a.addEventListener("click", (event) => event.preventDefault());
        li.appendChild(a);
        if (node.children.length > 0) li.appendChild(build(node.children));
        ul.appendChild(li);
      }
      return ul;
    };
    nav.appendChild(build(nestTocEntries(this.entries)));
    return nav;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Inline / line decorations (viewport only)
// ---------------------------------------------------------------------------

export interface BlockDecorationSpec {
  kind: "line" | "mark" | "hr" | "footnote";
  from: number;
  to: number;
  className?: string;
  footnoteId?: string;
  footnoteNumber?: number;
}

function quoteDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.name === "Blockquote") depth++;
  }
  return depth;
}

/** Decoration specs for blockquotes, rules, front matter and footnotes. */
export function collectBlockSpecs(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  footnotes: FootnoteIndex | null,
): BlockDecorationSpec[] {
  const tree = syntaxTree(state);
  const specs: BlockDecorationSpec[] = [];
  const selection = state.selection;
  const quoteLines = new Map<number, number>();
  const seen = new Set<string>();
  const lineTouched = (pos: number): boolean => {
    const line = state.doc.lineAt(pos);
    return isSelectionTouchingRange(selection, line.from, line.to);
  };

  for (const range of ranges) {
    if (range.from > range.to) continue;
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        const key = `${ref.name}:${ref.from}:${ref.to}`;
        if (seen.has(key)) return false;
        switch (ref.name) {
          case "FencedCode":
          case "CodeBlock":
          case "HTMLBlock":
          case "Table":
            return false;
          case "Blockquote": {
            seen.add(key);
            const depth = quoteDepth(ref.node);
            const first = state.doc.lineAt(ref.from).number;
            const last = state.doc.lineAt(ref.to).number;
            for (let n = first; n <= last; n++) {
              const line = state.doc.line(n);
              if (line.to < range.from || line.from > range.to) continue;
              quoteLines.set(
                line.from,
                Math.max(quoteLines.get(line.from) ?? 0, depth),
              );
            }
            return undefined;
          }
          case "QuoteMark": {
            seen.add(key);
            // #49: `>` shows only while the cursor is on the marker itself.
            const touched = isSelectionTouchingRange(
              selection,
              ref.from,
              ref.to,
            );
            let to = ref.to;
            if (!touched && state.sliceDoc(to, to + 1) === " ") to++;
            specs.push({
              kind: "mark",
              from: ref.from,
              to,
              className: touched ? "k-mark" : "k-mark-hidden",
            });
            return false;
          }
          case "HorizontalRule": {
            seen.add(key);
            if (lineTouched(ref.from)) {
              specs.push({
                kind: "mark",
                from: ref.from,
                to: ref.to,
                className: "k-mark",
              });
            } else {
              specs.push({ kind: "hr", from: ref.from, to: ref.to });
            }
            return false;
          }
          case "FrontMatter": {
            seen.add(key);
            const first = state.doc.lineAt(ref.from).number;
            const last = state.doc.lineAt(ref.to).number;
            for (let n = first; n <= last; n++) {
              const line = state.doc.line(n);
              if (line.to < range.from || line.from > range.to) continue;
              let cls = "k-frontmatter-line";
              if (n === first) cls += " k-frontmatter-first";
              if (n === last) cls += " k-frontmatter-last";
              specs.push({
                kind: "line",
                from: line.from,
                to: line.from,
                className: cls,
              });
            }
            for (const mark of ref.node.getChildren("FrontMatterMark")) {
              specs.push({
                kind: "mark",
                from: mark.from,
                to: mark.to,
                className: "k-frontmatter-fence",
              });
            }
            return false;
          }
          case "FootnoteDefinition": {
            seen.add(key);
            const mark = ref.node.getChild("FootnoteMark");
            const first = state.doc.lineAt(ref.from).number;
            const last = state.doc.lineAt(ref.to).number;
            for (let n = first; n <= last; n++) {
              const line = state.doc.line(n);
              if (line.to < range.from || line.from > range.to) continue;
              specs.push({
                kind: "line",
                from: line.from,
                to: line.from,
                className: "k-footnote-def-line",
              });
            }
            if (mark) {
              const id = footnoteIdOf(state.sliceDoc(mark.from, mark.to));
              const number = footnotes?.numbers.get(id);
              specs.push({
                kind: "mark",
                from: mark.from,
                to: mark.to,
                className: number
                  ? "k-footnote-def-mark"
                  : "k-footnote-def-mark k-footnote-unused",
              });
            }
            return undefined;
          }
          case "FootnoteReference": {
            seen.add(key);
            const id = footnoteIdOf(state.sliceDoc(ref.from, ref.to));
            const number = footnotes?.numbers.get(id);
            if (!number) return false; // undefined footnote: stays literal
            if (isSelectionTouchingRange(selection, ref.from, ref.to)) {
              specs.push({
                kind: "mark",
                from: ref.from,
                to: ref.to,
                className: "k-footnote-ref-src",
              });
            } else {
              specs.push({
                kind: "footnote",
                from: ref.from,
                to: ref.to,
                footnoteId: id,
                footnoteNumber: number,
              });
            }
            return false;
          }
          default:
            return undefined;
        }
      },
    });
  }

  for (const [from, depth] of quoteLines) {
    specs.push({
      kind: "line",
      from,
      to: from,
      className: `k-quote-line k-quote-depth-${Math.min(depth, 6)}`,
    });
  }
  return specs;
}

const hrWidget = new HorizontalRuleWidget();

export function buildBlockDecorations(view: EditorView): DecorationSet {
  const ranges =
    view.visibleRanges.length > 0 ? view.visibleRanges : [view.viewport];
  const specs = collectBlockSpecs(
    view.state,
    ranges,
    footnoteIndex(view.state),
  );
  const out: Array<Range<Decoration>> = specs.map((spec) => {
    switch (spec.kind) {
      case "line":
        return Decoration.line({ class: spec.className ?? "" }).range(
          spec.from,
        );
      case "hr":
        return Decoration.replace({ widget: hrWidget }).range(
          spec.from,
          spec.to,
        );
      case "footnote":
        return Decoration.replace({
          widget: new FootnoteRefWidget(
            spec.footnoteId ?? "",
            spec.footnoteNumber ?? 0,
          ),
        }).range(spec.from, spec.to);
      default:
        return Decoration.mark({ class: spec.className ?? "" }).range(
          spec.from,
          spec.to,
        );
    }
  });
  return Decoration.set(out, true);
}

export const blockPreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    isComposing = false;

    constructor(view: EditorView) {
      this.decorations = buildBlockDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (this.isComposing || update.view.composing) {
        if (update.docChanged)
          this.decorations = this.decorations.map(update.changes);
        return;
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.field(footnoteIndexField, false) !==
          update.state.field(footnoteIndexField, false) ||
        update.transactions.some((tr) => tr.reconfigured)
      ) {
        this.decorations = buildBlockDecorations(update.view);
      }
    }
  },
  {
    decorations: (instance) => instance.decorations,
    eventHandlers: {
      compositionstart() {
        this.isComposing = true;
      },
      compositionend(_event, view) {
        this.isComposing = false;
        queueMicrotask(() => {
          if (this.isComposing || view.composing) return;
          try {
            view.dispatch({ effects: blocksRefreshEffect.of(null) });
          } catch {
            // view destroyed
          }
        });
      },
    },
  },
);

// ---------------------------------------------------------------------------
// [TOC]
// ---------------------------------------------------------------------------

const TOC_RE = /^\s*\[toc\]\s*$/i;

/** Is this paragraph text a `[TOC]` marker (case-insensitive)? */
export function isTocText(text: string): boolean {
  return TOC_RE.test(text);
}

/** Top-level paragraphs consisting only of `[TOC]` (case-insensitive). */
export function findTocParagraphs(
  state: EditorState,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const top = syntaxTree(state).topNode;
  for (let node = top.firstChild; node; node = node.nextSibling) {
    if (node.name !== "Paragraph" || node.to - node.from > 16) continue;
    if (TOC_RE.test(state.sliceDoc(node.from, node.to)))
      out.push({ from: node.from, to: node.to });
  }
  return out;
}

export function tocEntriesOf(state: EditorState): TocEntry[] {
  return collectDocumentHeadings(state).map((h) => ({
    level: h.level,
    text: h.text,
    slug: h.slug,
  }));
}

interface TocFieldValue {
  tocs: Array<{ from: number; to: number }>;
  entries: TocEntry[];
  decorations: DecorationSet;
  dirty: boolean;
}

function tocDecorations(
  state: EditorState,
  tocs: readonly { from: number; to: number }[],
  entries: readonly TocEntry[],
): DecorationSet {
  const out: Array<Range<Decoration>> = [];
  for (const toc of tocs) {
    const widget = new TocWidget(entries);
    if (isSelectionTouchingRange(state.selection, toc.from, toc.to)) {
      out.push(
        Decoration.widget({ widget, block: true, side: 1 }).range(toc.to),
      );
    } else {
      out.push(
        Decoration.replace({ widget, block: true }).range(toc.from, toc.to),
      );
    }
  }
  return Decoration.set(out, true);
}

function computeToc(
  state: EditorState,
  previous?: TocFieldValue,
): TocFieldValue {
  const tocs = findTocParagraphs(state);
  let entries = tocs.length > 0 ? tocEntriesOf(state) : [];
  if (previous && sameEntries(previous.entries, entries))
    entries = previous.entries;
  return {
    tocs,
    entries,
    decorations: tocDecorations(state, tocs, entries),
    dirty: false,
  };
}

function sameEntries(a: readonly TocEntry[], b: readonly TocEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (e, i) =>
        e.level === b[i].level && e.slug === b[i].slug && e.text === b[i].text,
    )
  );
}

export const tocField = StateField.define<TocFieldValue>({
  create: (state) => computeToc(state),
  update(value, tr) {
    if (isCompose(tr)) {
      return {
        tocs: value.tocs.map((t) => ({
          from: mapPosClamped(tr.changes, t.from, -1),
          to: mapPosClamped(tr.changes, t.to, 1),
        })),
        entries: value.entries,
        decorations: value.decorations.map(tr.changes),
        dirty: value.dirty || tr.docChanged,
      };
    }
    const refresh = tr.effects.some((e) => e.is(blocksRefreshEffect));
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (
      tr.docChanged ||
      treeChanged ||
      tr.reconfigured ||
      value.dirty ||
      refresh
    ) {
      return computeToc(tr.state, value);
    }
    if (tr.selection && value.tocs.length > 0) {
      return {
        ...value,
        decorations: tocDecorations(tr.state, value.tocs, value.entries),
      };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

// ---------------------------------------------------------------------------
// Footnote hover tooltip
// ---------------------------------------------------------------------------

export function footnoteAt(
  state: EditorState,
  pos: number,
): { id: string; from: number; to: number; text: string } | null {
  const index = footnoteIndex(state);
  if (!index) return null;
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (
      let n: SyntaxNode | null = tree.resolveInner(pos, side);
      n;
      n = n.parent
    ) {
      if (n.name !== "FootnoteReference") continue;
      const id = footnoteIdOf(state.sliceDoc(n.from, n.to));
      const def = index.definitions.get(id);
      if (!def || !index.numbers.has(id)) return null;
      const text = footnoteDefinitionText(def, (f, t) => state.sliceDoc(f, t));
      return { id, from: n.from, to: n.to, text };
    }
  }
  return null;
}

export const footnoteTooltip = hoverTooltip(
  (view, pos): Tooltip | null => {
    const hit = footnoteAt(view.state, pos);
    if (!hit) return null;
    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "k-footnote-tooltip";
        dom.dataset.testid = "footnote-tooltip";
        const number = footnoteIndex(view.state)?.numbers.get(hit.id);
        const label = document.createElement("span");
        label.className = "k-footnote-tooltip-label";
        label.textContent = number ? `${number}. ` : "";
        dom.append(label, document.createTextNode(hit.text || "（空白註腳）"));
        return { dom };
      },
    };
  },
  { hoverTime: 200 },
);

export const blocksExtension: Extension = [
  footnoteIndexField,
  blockPreviewPlugin,
  tocField,
  footnoteTooltip,
];
