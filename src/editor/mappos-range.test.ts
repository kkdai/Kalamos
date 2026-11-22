import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMockState } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import { blocksExtension, footnoteIndexField } from "./blocks";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { mathMarkdownExtension } from "./math";

/**
 * #56: `RangeError: Position 55 is out of range for changeset of length 53`
 * after IME composition in a table cell. A StateField kept a position from
 * before a composition transaction that shortened the document (it copied the
 * value instead of mapping it), then mapped that stale position through a
 * later, shorter changeset.
 */

const TABLE_DOC = [
  "| 名稱 | 數量 |",
  "| --- | --- |",
  "| 蘋果 | 十二 |",
  "",
  "結尾段落[^1]",
  "",
  "[^1]: 註腳",
].join("\n");

function fullyParsed(doc: string, cursor = doc.length): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      markdown({
        base: markdownLanguage,
        addKeymap: false,
        extensions: [
          mathMarkdownExtension,
          frontMatterExtension,
          footnoteExtension,
        ],
      }),
      blocksExtension,
    ],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({}).state;
}

/** A composition transaction that replaces `from..to` (shrinking the document). */
function composeReplace(
  state: EditorState,
  from: number,
  to: number,
  insert: string,
): EditorState {
  return state.update({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.type.compose",
  }).state;
}

describe("#56 positions kept across IME composition stay in range", () => {
  it("footnote index: compose that shortens the doc, then a cursor move, then an edit", () => {
    let state = fullyParsed(TABLE_DOC);
    const cell = TABLE_DOC.indexOf("十二");
    // The IME replaces the cell text and the table is re-aligned (shorter doc).
    state = composeReplace(state, cell, cell + 2, "一");
    state = composeReplace(state, 0, TABLE_DOC.indexOf("\n"), "|名稱|數量|");
    expect(state.doc.length).toBeLessThan(TABLE_DOC.length);
    // setCursor to the end (selection-only transaction), then normal typing.
    expect(() => {
      state = state.update({ selection: { anchor: state.doc.length } }).state;
      state = state.update({
        changes: { from: state.doc.length, insert: "x" },
        userEvent: "input.type",
      }).state;
    }).not.toThrow();
    expect(state.field(footnoteIndexField).index.numbers.get("1")).toBe(1);
  });

  it("footnote index stays correct after compose + non-compose edits", () => {
    let state = fullyParsed(TABLE_DOC);
    state = composeReplace(state, 0, 5, "");
    state = state.update({
      changes: { from: 0, insert: "前" },
      userEvent: "input.type",
    }).state;
    const def = state.field(footnoteIndexField).index.definitions.get("1");
    expect(def).toBeDefined();
    expect(state.sliceDoc(def!.from, def!.from + 4)).toBe("[^1]");
  });
});

describe("#56 every StateField in the real editor survives compose → shrink → move → edit", () => {
  let app: KalamosApp | null = null;

  beforeEach(() => {
    resetMockState();
    document.body.innerHTML = `<main id="editor-container"></main><div id="status"></div>`;
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  it("table + footnote + TOC + math + diagram + image document", async () => {
    app = createKalamosApp(document);
    await app.init();
    const doc = [
      "[TOC]",
      "",
      "# 標題",
      "",
      TABLE_DOC,
      "",
      "$$",
      "x^2",
      "$$",
      "",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "![圖](img/a.png)",
      "",
      "最後一行",
    ].join("\n");
    app.editor.setContent(doc);
    const view = app.editor.view;
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({});
    // Turn on everything that keeps positions.
    app.editor.setFocusMode(true);
    app.editor.setTypewriterMode(true);

    const run = () => {
      const cell = view.state.doc.toString().indexOf("十二");
      view.dispatch({ selection: { anchor: cell + 2 } });
      for (const step of [
        { from: cell, to: cell + 2, insert: "一" },
        { from: cell, to: cell + 1, insert: "一百" },
      ]) {
        view.dispatch({
          changes: step,
          selection: { anchor: step.from + step.insert.length },
          userEvent: "input.type.compose",
        });
      }
      // Re-align shrinks the document a lot while still composing.
      const end = view.state.doc.length;
      view.dispatch({
        changes: { from: Math.max(0, end - 20), to: end },
        userEvent: "input.type.compose",
      });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "尾" },
        userEvent: "input.type",
      });
      view.dispatch({
        changes: { from: 0, to: 6 },
        userEvent: "delete.backward",
      });
    };
    expect(run).not.toThrow();
  });
});
