import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  blocksExtension,
  collectBlockSpecs,
  footnoteIndexField,
} from "./blocks";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { handleListBackspace, handleListEnter } from "./lists";
import { collectLivePreviewSpecs } from "./live-preview";
import { mathMarkdownExtension } from "./math";
import { ensureFullSyntaxTree } from "./test-utils";

/** #49: block markers render like Typora; Enter / Backspace leave lists and quotes. */

function stateOf(doc: string, cursor: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
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
      blocksExtension,
    ],
  });
  return ensureFullSyntaxTree(state);
}

function markerSpec(doc: string, cursor: number, from: number) {
  return collectLivePreviewSpecs(stateOf(doc, cursor)).filter(
    (s) => s.from === from,
  );
}

describe("#49 block marker decorations", () => {
  it("a bullet shows as soon as `- ` is typed and while typing; `-` only with the cursor on it", () => {
    // Just typed `- `: cursor after the space.
    expect(markerSpec("- ", 2, 0)).toEqual([
      { from: 0, to: 1, className: "k-list-marker", widgetType: "bullet" },
    ]);
    // Typing the item text.
    expect(markerSpec("- item", 6, 0)[0].widgetType).toBe("bullet");
    // Cursor on the marker (before or right after `-`) reveals it.
    expect(markerSpec("- item", 0, 0)).toEqual([
      { from: 0, to: 1, className: "k-mark k-list-marker" },
    ]);
    expect(markerSpec("- item", 1, 0)[0].className).toBe(
      "k-mark k-list-marker",
    );
  });

  it("ordered lists keep a styled number; task items show a checkbox until the cursor is on the marker", () => {
    expect(markerSpec("1. item", 7, 0)).toEqual([
      { from: 0, to: 2, className: "k-list-marker" },
    ]);
    expect(markerSpec("1. item", 1, 0)[0].className).toBe(
      "k-mark k-list-marker",
    );

    const task = collectLivePreviewSpecs(stateOf("- [ ] task", 10));
    expect(task).toContainEqual({ from: 0, to: 2, className: "k-mark-hidden" });
    expect(task).toContainEqual({
      from: 2,
      to: 5,
      className: "k-task-checkbox",
      widgetType: "task",
      checked: false,
    });
    const onBox = collectLivePreviewSpecs(stateOf("- [ ] task", 4));
    expect(onBox).toContainEqual({
      from: 0,
      to: 1,
      className: "k-mark k-list-marker",
    });
    expect(onBox).toContainEqual({ from: 2, to: 5, className: "k-mark" });
  });

  it("`##` is hidden while editing the heading text, shown with the cursor in the marks", () => {
    const doc = "## heading";
    const inText = collectLivePreviewSpecs(stateOf(doc, 7));
    expect(inText).toContainEqual({
      from: 0,
      to: 3,
      className: "k-mark-hidden",
    });
    expect(inText).toContainEqual({ from: 3, to: 10, className: "k-h2" });
    // Right after typing `## ` the marks are already hidden.
    expect(collectLivePreviewSpecs(stateOf("## ", 3))).toContainEqual({
      from: 0,
      to: 3,
      className: "k-mark-hidden",
    });
    expect(collectLivePreviewSpecs(stateOf(doc, 1))).toContainEqual({
      from: 0,
      to: 3,
      className: "k-mark",
    });
    // Closing marks reveal when the cursor is on them.
    const closed = "## title ##";
    expect(collectLivePreviewSpecs(stateOf(closed, 4))).toContainEqual({
      from: 8,
      to: 11,
      className: "k-mark-hidden",
    });
    expect(collectLivePreviewSpecs(stateOf(closed, 10))).toContainEqual({
      from: 8,
      to: 11,
      className: "k-mark",
    });
  });

  it("`>` is hidden while typing the quote, shown with the cursor on it", () => {
    const doc = "> quote";
    const spec = (cursor: number) => {
      const s = stateOf(doc, cursor);
      return collectBlockSpecs(
        s,
        [{ from: 0, to: doc.length }],
        s.field(footnoteIndexField).index,
      ).find((x) => x.kind === "mark" && x.from === 0);
    };
    expect(spec(7)?.className).toBe("k-mark-hidden");
    expect(spec(2)?.className).toBe("k-mark-hidden"); // just typed `> `
    expect(spec(1)?.className).toBe("k-mark");
    expect(spec(0)?.className).toBe("k-mark");
  });
});

describe("#49 Enter / Backspace", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  function mount(doc: string, cursor = doc.length): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({ parent, state: stateOf(doc, cursor) });
    return view;
  }
  const text = () => view!.state.doc.toString();
  const head = () => view!.state.selection.main.head;

  it("an empty top-level item ends the list with a blank line", () => {
    for (const [doc, expected] of [
      ["- item one\n- item two\n- ", "- item one\n- item two\n\n"],
      ["1. one\n2. two\n3. ", "1. one\n2. two\n\n"],
      ["- [ ] t1\n- [ ] ", "- [ ] t1\n\n"],
    ] as const) {
      mount(doc);
      expect(handleListEnter(view!)).toBe(true);
      expect(text()).toBe(expected);
      expect(head()).toBe(expected.length);
      view!.destroy();
    }
  });

  it("text typed after ending a list in the middle stays a separate paragraph", () => {
    mount("- a\n- \n\nnext", 6);
    expect(handleListEnter(view!)).toBe(true);
    view!.dispatch(view!.state.replaceSelection("after"));
    expect(text()).toBe("- a\n\nafter\n\nnext");
  });

  it("an empty nested item moves out one level first", () => {
    mount("- a\n  - b\n  - ");
    expect(handleListEnter(view!)).toBe(true);
    expect(text()).toBe("- a\n  - b\n- ");
    expect(handleListEnter(view!)).toBe(true);
    expect(text()).toBe("- a\n  - b\n\n");
  });

  it("an empty `>` line ends the quote; `> >` drops one level", () => {
    mount("> quote\n> ");
    expect(handleListEnter(view!)).toBe(true);
    expect(text()).toBe("> quote\n\n");
    view!.destroy();

    mount("> a\n> > b\n> > ");
    expect(handleListEnter(view!)).toBe(true);
    expect(text()).toBe("> a\n> > b\n> ");
    expect(handleListEnter(view!)).toBe(true);
    expect(text()).toBe("> a\n> > b\n\n");
  });

  it("non-empty items still continue the list", () => {
    mount("- item");
    expect(handleListEnter(view!)).toBe(true);
    expect(text()).toBe("- item\n- ");
  });

  it("Backspace right after the marker turns the item into a paragraph", () => {
    for (const [doc, cursor, expected, expectedHead] of [
      ["- item", 2, "item", 0],
      ["1. one", 3, "one", 0],
      ["- [ ] task", 6, "task", 0],
      ["- a\n- b\n- c", 6, "- a\n\nb\n\n- c", 5],
      ["- a\n  - b", 8, "- a\n\n  b", 7],
      ["- a\n- ", 6, "- a\n", 4],
    ] as const) {
      mount(doc, cursor);
      expect(handleListBackspace(view!)).toBe(true);
      expect(text()).toBe(expected);
      expect(head()).toBe(expectedHead);
      view!.destroy();
    }
  });

  it("Backspace elsewhere and inside code keeps the normal behaviour", () => {
    mount("- item", 4);
    expect(handleListBackspace(view!)).toBe(false);
    expect(text()).toBe("- item");
    view!.destroy();

    mount("```\n- x\n```", 6);
    expect(handleListBackspace(view!)).toBe(false);
    expect(text()).toBe("```\n- x\n```");
  });
});
