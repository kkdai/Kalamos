import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { toggleStrikethrough } from "./keymaps";
import {
  insertCodeBlock,
  insertMathBlock,
  setHeadingLevel,
  toggleBlockquote,
} from "./paragraph-commands";

const views: EditorView[] = [];

function viewOf(doc: string, anchor: number, head = anchor): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

describe("#74 段落 commands", () => {
  it("sets, changes and toggles off a heading level", () => {
    const view = viewOf("Title\nbody", 2);
    expect(setHeadingLevel(view, 2)).toBe(true);
    expect(view.state.doc.toString()).toBe("## Title\nbody");
    setHeadingLevel(view, 4);
    expect(view.state.doc.toString()).toBe("#### Title\nbody");
    setHeadingLevel(view, 4);
    expect(view.state.doc.toString()).toBe("Title\nbody");
  });

  it("level 0 turns headings back into paragraphs across the selection", () => {
    const doc = "# One\n### Two\nthree";
    const view = viewOf(doc, 0, doc.length);
    setHeadingLevel(view, 0);
    expect(view.state.doc.toString()).toBe("One\nTwo\nthree");
  });

  it("leaves table rows alone", () => {
    const view = viewOf("| a | b |\n| - | - |", 3);
    expect(setHeadingLevel(view, 1)).toBe(false);
    expect(toggleBlockquote(view)).toBe(false);
    expect(insertCodeBlock(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("| a | b |\n| - | - |");
  });

  it("toggles a blockquote on every selected line", () => {
    const view = viewOf("a\nb", 0, 3);
    toggleBlockquote(view);
    expect(view.state.doc.toString()).toBe("> a\n> b");
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    toggleBlockquote(view);
    expect(view.state.doc.toString()).toBe("a\nb");
  });

  it("wraps the selection in a code fence and opens a math block below a line", () => {
    const view = viewOf("let x = 1;", 0, 10);
    insertCodeBlock(view);
    expect(view.state.doc.toString()).toBe("```\nlet x = 1;\n```");

    const math = viewOf("text", 2);
    insertMathBlock(math);
    expect(math.state.doc.toString()).toBe("text\n$$\n\n$$");
    expect(math.state.selection.main.head).toBe("text\n$$\n".length);
  });

  it("fills an empty line with an empty block and puts the cursor inside", () => {
    const view = viewOf("", 0);
    insertCodeBlock(view);
    expect(view.state.doc.toString()).toBe("```\n\n```");
    expect(view.state.selection.main.head).toBe(4);
  });
});

describe("#74 格式 > 刪除線", () => {
  it("wraps and unwraps the selection with ~~", () => {
    const view = viewOf("gone", 0, 4);
    toggleStrikethrough(view);
    expect(view.state.doc.toString()).toBe("~~gone~~");
    toggleStrikethrough(view);
    expect(view.state.doc.toString()).toBe("gone");
  });
});
