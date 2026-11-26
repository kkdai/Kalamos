import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { enterImageOnArrow, imagePreviewExtension } from "./images";
import {
  collectLivePreviewSpecs,
  expandedSpanField,
  expandSpanBeforeCursor,
  isSelectionInsideSpan,
  livePreviewExtension,
} from "./live-preview";
import { mathMarkdownExtension } from "./math";
import { ensureFullSyntaxTree } from "./test-utils";

/** #54: inline spans render with the cursor right after them; source only inside. */

function stateOf(
  doc: string,
  selection: EditorSelection | number,
): EditorState {
  const state = EditorState.create({
    doc,
    selection:
      typeof selection === "number"
        ? EditorSelection.cursor(selection)
        : selection,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({
        base: markdownLanguage,
        addKeymap: false,
        extensions: [
          mathMarkdownExtension,
          cjkEmphasisExtension,
          frontMatterExtension,
          footnoteExtension,
        ],
      }),
      livePreviewExtension,
      imagePreviewExtension,
    ],
  });
  return ensureFullSyntaxTree(state);
}

const markClasses = (doc: string, cursor: EditorSelection | number) =>
  collectLivePreviewSpecs(stateOf(doc, cursor))
    .filter((s) => s.className === "k-mark" || s.className === "k-mark-hidden")
    .map((s) => s.className);

describe("#54 isSelectionInsideSpan", () => {
  it("counts a cursor strictly inside, not on the outer edges", () => {
    const sel = (pos: number) =>
      EditorSelection.create([EditorSelection.cursor(pos)]);
    expect(isSelectionInsideSpan(sel(0), 0, 8)).toBe(false);
    expect(isSelectionInsideSpan(sel(8), 0, 8)).toBe(false);
    expect(isSelectionInsideSpan(sel(1), 0, 8)).toBe(true);
    expect(isSelectionInsideSpan(sel(7), 0, 8)).toBe(true);
  });

  it("counts a selection overlapping the span, not one that only touches it", () => {
    const range = (a: number, b: number) =>
      EditorSelection.create([EditorSelection.range(a, b)]);
    expect(isSelectionInsideSpan(range(6, 10), 0, 8)).toBe(true);
    expect(isSelectionInsideSpan(range(8, 10), 0, 8)).toBe(false);
    expect(isSelectionInsideSpan(range(0, 8), 0, 8)).toBe(true);
  });
});

describe("#54 inline span decorations", () => {
  const cases = [
    ["*test*", 6],
    ["**bold**", 8],
    ["`code`", 6],
    ["~~del~~", 7],
    ["[link](https://x.y)", 19],
  ] as const;

  it("right after the closing mark: hidden; right before the opening mark: hidden", () => {
    for (const [doc, end] of cases) {
      expect(markClasses(doc, end).every((c) => c === "k-mark-hidden")).toBe(
        true,
      );
      expect(markClasses(doc, 0).every((c) => c === "k-mark-hidden")).toBe(
        true,
      );
      expect(
        markClasses(`${doc} x`, end).every((c) => c === "k-mark-hidden"),
      ).toBe(true);
    }
  });

  it("inside the span (including the inner edges and on the marks): shown", () => {
    for (const [doc, end] of cases) {
      for (const pos of [1, end - 1]) {
        expect(markClasses(doc, pos).every((c) => c === "k-mark")).toBe(true);
      }
    }
    // Inside a link's URL.
    expect(
      markClasses("[link](https://x.y)", 10).every((c) => c === "k-mark"),
    ).toBe(true);
  });

  it("nested spans: only the span holding the cursor shows its marks", () => {
    const doc = "**a *b* c**";
    // Cursor right after `*b*` (inside the strong span).
    const specs = collectLivePreviewSpecs(stateOf(doc, 7));
    const em = specs.filter((s) => s.from === 4 || s.from === 6);
    expect(em.map((s) => s.className)).toEqual([
      "k-mark-hidden",
      "k-mark-hidden",
    ]);
    expect(specs.find((s) => s.from === 0)?.className).toBe("k-mark");
  });

  it("CJK: `中文**粗體**` renders with the cursor right after `**`", () => {
    expect(markClasses("中文**粗體**", 8)).toEqual([
      "k-mark-hidden",
      "k-mark-hidden",
    ]);
  });

  it("block markers keep the #49 rule (cursor on the marker reveals it)", () => {
    expect(collectLivePreviewSpecs(stateOf("## h", 2))).toContainEqual({
      from: 0,
      to: 3,
      className: "k-mark",
    });
    expect(collectLivePreviewSpecs(stateOf("## h", 4))).toContainEqual({
      from: 0,
      to: 3,
      className: "k-mark-hidden",
    });
  });
});

describe("#54 Backspace and arrows", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  function mount(doc: string, cursor: number): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({ parent, state: stateOf(doc, cursor) });
    return view;
  }

  it("Backspace right after a rendered span reveals it without deleting", () => {
    const v = mount("x **bold**", 10);
    expect(expandSpanBeforeCursor(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("x **bold**");
    expect(v.state.field(expandedSpanField)).toEqual({ from: 2, to: 10 });
    expect(markClasses("x **bold**", 10)).toEqual([
      "k-mark-hidden",
      "k-mark-hidden",
    ]);
    expect(
      collectLivePreviewSpecs(v.state)
        .filter((s) => s.className.startsWith("k-mark"))
        .map((s) => s.className),
    ).toEqual(["k-mark", "k-mark"]);
    // Second Backspace: not handled here (normal deletion runs).
    expect(expandSpanBeforeCursor(v)).toBe(false);
    // Moving the cursor collapses it again.
    v.dispatch({ selection: { anchor: 0 } });
    expect(v.state.field(expandedSpanField)).toBeNull();
  });

  it("Backspace elsewhere is left alone", () => {
    expect(expandSpanBeforeCursor(mount("plain text", 5))).toBe(false);
    view!.destroy();
    expect(expandSpanBeforeCursor(mount("**bold** x", 10))).toBe(false);
  });

  it("arrow keys step into a rendered image instead of jumping over it", () => {
    const doc = "a ![i](p.png) b";
    // The transaction filter (part of imagePreviewExtension) adjusts the move.
    const headAfter = (from: number, to: number, userEvent: string) =>
      stateOf(doc, from).update({ selection: { anchor: to }, userEvent })
        .newSelection.main.head;
    expect(headAfter(13, 2, "select")).toBe(12); // ArrowLeft from after the image
    expect(headAfter(2, 13, "select")).toBe(3); // ArrowRight from before it
    // Pointer clicks and ordinary one-step moves are untouched.
    expect(headAfter(13, 2, "select.pointer")).toBe(2);
    expect(headAfter(13, 12, "select")).toBe(12);
    expect(headAfter(15, 14, "select")).toBe(14);
    // The pure check on an unfiltered transaction.
    const plain = ensureFullSyntaxTree(
      EditorState.create({
        doc,
        selection: EditorSelection.cursor(13),
        extensions: [markdown({ base: markdownLanguage })],
      }),
    );
    expect(
      enterImageOnArrow(
        plain.update({ selection: { anchor: 2 }, userEvent: "select" }),
      ),
    ).toBe(12);
  });
});
