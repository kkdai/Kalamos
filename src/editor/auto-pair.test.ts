import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSettings, resetMockState } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import {
  AUTO_PAIR_BRACKETS_MESSAGE,
  AUTO_PAIR_MARKDOWN_MESSAGE,
  autoPairBracketsExtension,
  autoPairMarkdownExtension,
} from "./auto-pair";

function mount(doc: string, cursor: number, extensions: Extension[], anchor = cursor): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, cursor),
      extensions: [markdown({ base: markdownLanguage }), ...extensions],
    }),
    parent,
  });
}

/** Types `text` one character at a time through the input handlers, like real typing. */
function type(view: EditorView, text: string): void {
  for (const ch of Array.from(text)) {
    const { from, to } = view.state.selection.main;
    const insert = () =>
      view.state.update({
        changes: { from, to, insert: ch },
        selection: { anchor: from + ch.length },
        userEvent: "input.type",
      });
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((h) => h(view, from, to, ch, insert));
    if (!handled) view.dispatch(insert());
  }
}

function backspace(view: EditorView): void {
  const event = new KeyboardEvent("keydown", { key: "Backspace", keyCode: 8 });
  if (!runScopeHandlers(view, event, "editor")) {
    const { head } = view.state.selection.main;
    if (head > 0) view.dispatch({ changes: { from: head - 1, to: head }, selection: { anchor: head - 1 } });
  }
}

function docWithCursor(view: EditorView): string {
  const s = view.state;
  const { from, to } = s.selection.main;
  const doc = s.doc.toString();
  return from === to ? `${doc.slice(0, from)}|${doc.slice(from)}` : `${doc.slice(0, from)}[${doc.slice(from, to)}]${doc.slice(to)}`;
}

describe("ED-09 bracket / quote pairing", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("pairs ( [ { \" ' and the full-width pairs", () => {
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
      ['"', '"'],
      ["'", "'"],
      ["「", "」"],
      ["『", "』"],
      ["（", "）"],
      ["【", "】"],
      ["《", "》"],
      ["“", "”"],
      ["‘", "’"],
    ]) {
      view = mount("", 0, [autoPairBracketsExtension]);
      type(view, open);
      expect(docWithCursor(view), open).toBe(`${open}|${close}`);
      view.destroy();
    }
    view = null;
  });

  it("typing the closer skips the auto-inserted one; text in between is kept", () => {
    view = mount("", 0, [autoPairBracketsExtension]);
    type(view, "「你好」");
    expect(docWithCursor(view)).toBe("「你好」|");
    type(view, "(a)");
    expect(docWithCursor(view)).toBe("「你好」(a)|");
  });

  it("Backspace inside an empty pair deletes both", () => {
    view = mount("文字 ", 3, [autoPairBracketsExtension]);
    type(view, "（");
    expect(docWithCursor(view)).toBe("文字 （|）");
    backspace(view);
    expect(docWithCursor(view)).toBe("文字 |");
  });

  it("an apostrophe after a letter is not paired (don't)", () => {
    view = mount("don", 3, [autoPairBracketsExtension]);
    type(view, "'t");
    expect(docWithCursor(view)).toBe("don't|");
  });

  it("does not pair in front of a word; wraps a selection", () => {
    view = mount("word", 0, [autoPairBracketsExtension]);
    type(view, "(");
    expect(docWithCursor(view)).toBe("(|word");
    view.destroy();
    view = mount("選取", 2, [autoPairBracketsExtension], 0);
    type(view, "「");
    expect(view.state.doc.toString()).toBe("「選取」");
  });

  it("without the extension (setting off) nothing is auto-inserted", () => {
    view = mount("", 0, []);
    type(view, "(「\"'[{");
    expect(view.state.doc.toString()).toBe("(「\"'[{");
  });

  it("* _ ` ~ are not paired by the bracket setting", () => {
    view = mount("a ", 2, [autoPairBracketsExtension]);
    type(view, "*_`~");
    expect(view.state.doc.toString()).toBe("a *_`~");
  });
});

describe("ED-09 Markdown symbol pairing (optional)", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("pairs * _ ` ~ after a space; ** makes bold; typing the closers skips them", () => {
    view = mount("文字 ", 3, [autoPairMarkdownExtension]);
    type(view, "*");
    expect(docWithCursor(view)).toBe("文字 *|*");
    type(view, "*");
    expect(docWithCursor(view)).toBe("文字 **|**");
    type(view, "粗體**");
    expect(docWithCursor(view)).toBe("文字 **粗體**|");

    for (const sym of ["_", "`", "~"]) {
      view.destroy();
      view = mount("a ", 2, [autoPairMarkdownExtension]);
      type(view, sym);
      expect(docWithCursor(view), sym).toBe(`a ${sym}|${sym}`);
    }
  });

  it("Backspace inside an empty pair deletes both", () => {
    view = mount("a ", 2, [autoPairMarkdownExtension]);
    type(view, "~");
    backspace(view);
    expect(docWithCursor(view)).toBe("a |");
  });

  it("no pairing for list markers, intraword symbols or inside code", () => {
    view = mount("", 0, [autoPairMarkdownExtension]);
    type(view, "* 項目");
    expect(view.state.doc.toString()).toBe("* 項目");
    view.destroy();
    view = mount("snake", 5, [autoPairMarkdownExtension]);
    type(view, "_case");
    expect(view.state.doc.toString()).toBe("snake_case");
    view.destroy();
    view = mount("x `code ` y", 8, [autoPairMarkdownExtension]);
    type(view, "*");
    expect(view.state.doc.toString()).toBe("x `code *` y");
  });

  it("wraps a selection", () => {
    view = mount("強調這裡", 4, [autoPairMarkdownExtension], 2);
    type(view, "*");
    expect(docWithCursor(view)).toBe("強調*[這裡]*");
  });

  it("with only the bracket setting on, markdown symbols stay single", () => {
    view = mount("a ", 2, [autoPairBracketsExtension]);
    type(view, "**");
    expect(view.state.doc.toString()).toBe("a **");
  });
});

describe("ED-09 settings in the app", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    document.body.innerHTML = `<main id="editor-container"></main><div id="status"></div>`;
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  it("defaults: brackets on, markdown off; toggles are live, persisted and announced", async () => {
    app = createKalamosApp(document);
    await app.init();
    const editor = app.editor;
    expect(editor.isAutoPairBrackets()).toBe(true);
    expect(editor.isAutoPairMarkdown()).toBe(false);

    editor.setContent("");
    editor.setCursor(0);
    type(editor.view, "(");
    expect(editor.getContent()).toBe("()");

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "π", code: "KeyP", metaKey: true, altKey: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(editor.isAutoPairBrackets()).toBe(false);
    expect(app.getStatusText()).toBe(AUTO_PAIR_BRACKETS_MESSAGE(false));
    expect(app.getStatusText()).toBe("自動配對括號：關");
    expect((await getSettings()).autoPairBrackets).toBe(false);
    editor.setContent("");
    editor.setCursor(0);
    type(editor.view, "(");
    expect(editor.getContent()).toBe("(");

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "∏", code: "KeyP", metaKey: true, altKey: true, shiftKey: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(editor.isAutoPairMarkdown()).toBe(true);
    expect(app.getStatusText()).toBe(AUTO_PAIR_MARKDOWN_MESSAGE(true));
    expect(app.getStatusText()).toBe("自動配對 Markdown 符號：開");
    expect((await getSettings()).autoPairMarkdown).toBe(true);

    // Restored on the next start.
    app.destroy();
    app = createKalamosApp(document);
    await app.init();
    expect(app.editor.isAutoPairBrackets()).toBe(false);
    expect(app.editor.isAutoPairMarkdown()).toBe(true);
  });
});
