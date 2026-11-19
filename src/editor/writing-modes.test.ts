import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { getSettings, resetMockState, setSettings, DEFAULT_SETTINGS } from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { mathMarkdownExtension } from "./math";
import {
  blockAt,
  currentBlocks,
  dimmedLineStarts,
  FOCUS_DIM_CLASS,
  focusModeExtension,
  focusModePlugin,
  typewriterModeExtension,
  wantsTypewriterScroll,
} from "./writing-modes";

const md = () =>
  markdown({
    base: markdownLanguage,
    addKeymap: false,
    extensions: [mathMarkdownExtension, cjkEmphasisExtension, frontMatterExtension, footnoteExtension],
  });

function stateOf(doc: string, selection: EditorSelection | number = 0, extra: unknown[] = []): EditorState {
  const state = EditorState.create({
    doc,
    selection: typeof selection === "number" ? EditorSelection.cursor(selection) : selection,
    extensions: [EditorState.allowMultipleSelections.of(true), md(), ...(extra as [])],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** Text of the current block for the cursor at the first occurrence of `marker`. */
function blockText(doc: string, marker: string): string {
  const state = stateOf(doc, doc.indexOf(marker));
  const span = blockAt(state, doc.indexOf(marker));
  return state.sliceDoc(span.from, span.to);
}

const DOC = [
  "# Heading", // 0
  "para one line A", // 1
  "para one line B", // 2
  "",
  "- item one",
  "  continued",
  "- item two",
  "  - nested",
  "",
  "```js",
  "let code = 1;",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| c | d |",
  "",
  "> quote A",
  "> quote B",
  "",
  "last",
].join("\n");

describe("WM-01 current block detection", () => {
  it("finds the paragraph, heading, list item, fenced code, table and blockquote", () => {
    expect(blockText(DOC, "Heading")).toBe("# Heading");
    expect(blockText(DOC, "line B")).toBe("para one line A\npara one line B");
    expect(blockText(DOC, "continued")).toBe("- item one\n  continued");
    expect(blockText(DOC, "item two")).toBe("- item two");
    expect(blockText(DOC, "nested")).toBe("  - nested");
    expect(blockText(DOC, "let code")).toBe("```js\nlet code = 1;\n```");
    expect(blockText(DOC, "| c")).toBe("| a | b |\n|---|---|\n| c | d |");
    expect(blockText(DOC, "quote B")).toBe("> quote A\n> quote B");
  });

  it("treats a blank line as its own block and handles the cursor at a block end", () => {
    const blank = DOC.indexOf("\n\n- item") + 1;
    const state = stateOf(DOC, blank);
    expect(blockAt(state, blank)).toEqual({ from: blank, to: blank });
    const end = DOC.indexOf("line B") + "line B".length;
    expect(state.sliceDoc(blockAt(state, end).from, blockAt(state, end).to)).toBe(
      "para one line A\npara one line B",
    );
  });

  it("keeps every block touched by a selection undimmed", () => {
    const from = DOC.indexOf("line B");
    const to = DOC.indexOf("item one");
    const state = stateOf(DOC, EditorSelection.single(from, to));
    const spans = currentBlocks(state);
    const lines = (pos: number) => state.doc.lineAt(pos).number;
    const undimmed = new Set<number>();
    for (const s of spans) for (let n = lines(s.from); n <= lines(s.to); n++) undimmed.add(n);
    expect([...undimmed].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("dims only lines inside the given (visible) ranges", () => {
    const state = stateOf(DOC, DOC.indexOf("Heading"));
    const all = dimmedLineStarts(state, [{ from: 0, to: state.doc.length }]);
    expect(all).not.toContain(0);
    expect(all.length).toBe(state.doc.lines - 1);
    const visible = { from: state.doc.line(10).from, to: state.doc.line(12).to };
    expect(dimmedLineStarts(state, [visible])).toEqual([
      state.doc.line(10).from,
      state.doc.line(11).from,
      state.doc.line(12).from,
    ]);
  });
});

describe("WM-01 focus mode plugin", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("dims non-current lines and follows the cursor, but not while composing", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({ parent, state: stateOf("one\n\ntwo\n\nthree", 0, [focusModeExtension]) });
    const dimmed = () =>
      Array.from(view!.contentDOM.querySelectorAll(".cm-line")).map((l) => l.classList.contains(FOCUS_DIM_CLASS));
    expect(view.dom.classList.contains("k-focus-mode")).toBe(true);
    expect(dimmed()).toEqual([false, true, true, true, true]);

    view.dispatch({ selection: { anchor: 6 } });
    expect(dimmed()).toEqual([true, true, false, true, true]);

    const plugin = view.plugin(focusModePlugin)!;
    const before = plugin.decorations;
    plugin.isComposing = true;
    view.dispatch({ selection: { anchor: 11 } });
    view.dispatch({ changes: { from: 11, insert: "中" }, userEvent: "input.type.compose" });
    expect(plugin.current).toEqual([{ from: 5, to: 8 }]);
    expect(plugin.decorations).not.toBe(before);
    plugin.isComposing = false;
    view.dispatch({ selection: { anchor: 12 } });
    expect(dimmed()).toEqual([true, true, true, true, false]);
  });
});

describe("WM-02 typewriter mode", () => {
  // scrollIntoView's effect type is private; recognise it by its value's class.
  const scrollTargetClass = (EditorView.scrollIntoView(0).value as object).constructor;
  const isScroll = (e: { value: unknown }) =>
    typeof e.value === "object" && e.value !== null && e.value.constructor === scrollTargetClass;
  const centered = (tr: Transaction) => tr.effects.some(isScroll);

  it("re-centres on keyboard moves and typing, not on pointer selections or IME", () => {
    const state = stateOf("a\nb\nc", 0, [typewriterModeExtension]);
    expect(centered(state.update({ selection: { anchor: 2 }, scrollIntoView: true, userEvent: "select" }))).toBe(true);
    expect(
      centered(state.update({ changes: { from: 0, insert: "x" }, scrollIntoView: true, userEvent: "input.type" })),
    ).toBe(true);
    expect(
      centered(state.update({ selection: { anchor: 2 }, scrollIntoView: true, userEvent: "select.pointer" })),
    ).toBe(false);
    expect(
      centered(
        state.update({ changes: { from: 0, insert: "中" }, scrollIntoView: true, userEvent: "input.type.compose" }),
      ),
    ).toBe(false);
    // Programmatic changes that don't ask for scrolling are left alone.
    expect(centered(state.update({ selection: { anchor: 4 } }))).toBe(false);
  });

  it("the effect targets the new cursor head and centres it", () => {
    const state = stateOf("a\nb\nc", 0, [typewriterModeExtension]);
    const tr = state.update({ selection: { anchor: 4 }, scrollIntoView: true, userEvent: "select" });
    expect(wantsTypewriterScroll(tr)).toBe(true);
    const effect = tr.effects.find(isScroll);
    const target = effect?.value as { range: { head: number }; y: string };
    expect(target.range.head).toBe(4);
    expect(target.y).toBe("center");
  });
});

describe("WM-01 / WM-02 app wiring", () => {
  let app: KalamosApp | null = null;
  afterEach(() => {
    app?.destroy();
    app = null;
  });

  it("F8 / F9 toggle, show a status message, persist and restore on launch", async () => {
    resetMockState();
    document.body.innerHTML = `<div id="app"><main id="editor-container"></main><div id="status"></div></div>`;
    app = createKalamosApp(document);
    await app.init();
    expect(DEFAULT_SETTINGS.focusMode).toBe(false);
    expect(DEFAULT_SETTINGS.typewriterMode).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", bubbles: true }));
    expect(app.editor.isFocusMode()).toBe(true);
    expect(app.getStatusText()).toBe("Ataraxia 專注模式：開");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F9", bubbles: true }));
    expect(app.editor.isTypewriterMode()).toBe(true);
    expect(app.getStatusText()).toBe("Stichos 打字機模式：開");
    await Promise.resolve();
    expect(await getSettings()).toMatchObject({ focusMode: true, typewriterMode: true });

    // Both work in source mode too.
    app.editor.setSourceMode(true);
    expect(app.editor.view.dom.classList.contains("k-focus-mode")).toBe(true);
    expect(app.editor.view.dom.classList.contains("k-typewriter-mode")).toBe(true);

    // Relaunch: modes off locally, init() restores them from settings.
    app.editor.setFocusMode(false);
    app.editor.setTypewriterMode(false);
    await app.init();
    expect(app.editor.isFocusMode()).toBe(true);
    expect(app.editor.isTypewriterMode()).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", bubbles: true }));
    expect(app.getStatusText()).toBe("Ataraxia 專注模式：關");
    await setSettings({ ...(await getSettings()) });
    expect((await getSettings()).focusMode).toBe(false);
  });
});
